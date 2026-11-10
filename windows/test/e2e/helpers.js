// E2E 공용: Electron 앱 띄우기, 가짜 GitHub 서버.
// Linux에서는 화면이 필요해 xvfb-run으로 돌린다(npm run test:e2e:linux). Windows·macOS는 그대로 돌린다.
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const APP_DIR = path.resolve(__dirname, '..', '..');
const RESULTS = path.join(APP_DIR, 'test-results');

/**
 * GitHub CLI 로그인이 테스트에 섞이지 않게, 빈 gh 설정 폴더와 토큰 없는 환경을 쓴다.
 * 앱 데이터 폴더도 실행마다 새로 만든다. 앞 테스트의 앱이 아직 끝나는 중이어도 중복 실행 잠금이 겹치지 않는다.
 */
function isolatedEnv(extra = {}) {
  const env = {
    ...process.env,
    GH_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'gitbell-gh-')),
    GITBELL_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'gitbell-data-')),
    GITBELL_LANG: 'en',
    ...extra,
  };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return env;
}

async function launch({ args = [], env = isolatedEnv() } = {}) {
  const app = await electron.launch({
    executablePath: require(path.join(APP_DIR, 'node_modules', 'electron')),
    args: [APP_DIR, '--show', ...args],
    env,
  });
  const window = await app.firstWindow();
  const errors = [];
  window.on('pageerror', (error) => errors.push(error.message));
  return { app, window, errors };
}

async function screenshot(window, name) {
  fs.mkdirSync(RESULTS, { recursive: true });
  await window.screenshot({ path: path.join(RESULTS, `${name}.png`) });
}

/**
 * 경로 앞부분으로 응답을 고르는 가짜 GitHub API. 토큰이 다르면 401.
 * routes는 바꿀 수 있어 테스트 중간에 새 활동을 넣을 수 있다.
 */
async function startFakeGitHub({ token, routes }) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const route = request.url.replace(/^\//, '');
    requests.push({ path: route, authorization: request.headers.authorization });
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      return response.end('{"message":"Bad credentials"}');
    }
    const match = server.routes.find(([prefix]) => route.startsWith(prefix));
    if (!match) {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      return response.end('{"message":"Not Found"}');
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(match[1]));
  });
  server.routes = routes;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, requests, url: `http://127.0.0.1:${server.address().port}/` };
}

module.exports = { APP_DIR, RESULTS, isolatedEnv, launch, screenshot, startFakeGitHub };
