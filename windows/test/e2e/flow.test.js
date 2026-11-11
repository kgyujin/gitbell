// 가짜 GitHub 서버로 실제 흐름을 확인한다:
// 연결 안내 → 토큰 저장(암호화) → 첫 확인(알림 없이 채움) → 새 활동(안 읽음) → 잘못된 토큰 → 토큰 지우기.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, isolatedEnv, screenshot, startFakeGitHub } = require('./helpers');

const TOKEN = 'ghp_e2eTestToken123';
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const user = (login) => ({ login });

/** 키링이 없는 Linux 테스트 환경에서만, Electron의 메모리 키로 암호화하게 한다(앱 코드는 바꾸지 않는다). */
async function useTestKeyOnLinux(app) {
  if (process.platform !== 'linux') return;
  await app.evaluate(({ safeStorage }) => {
    if (!safeStorage.isEncryptionAvailable()) safeStorage.setUsePlainTextEncryption(true);
  });
}

function routes({ withNewPush = false } = {}) {
  const pushTime = minutesAgo(30);
  const activity = [{ id: 1, activity_type: 'push', ref: 'refs/heads/main', before: 'aaa', after: 'bbb', actor: user('amy'), timestamp: pushTime }];
  if (withNewPush) {
    activity.push({ id: 2, activity_type: 'push', ref: 'refs/heads/feat/x', before: 'ccc', after: 'ddd', actor: user('bob'), timestamp: minutesAgo(0) });
  }
  return [
    ['user/repos', [{ full_name: 'acme/web', pushed_at: pushTime, archived: false }]],
    ['user', { login: 'me' }],
    ['notifications', []],
    ['repos/acme/web/pulls/comments', []],
    ['repos/acme/web/pulls?', [{ number: 7, title: 'Add search', html_url: 'https://github.com/acme/web/pull/7', user: user('amy'),
      head: { ref: 'feat/search', repo: { full_name: 'acme/web' } }, created_at: pushTime, updated_at: pushTime, merged_at: null, closed_at: null, merge_commit_sha: null }]],
    ['repos/acme/web/pulls/7/reviews', []],
    ['repos/acme/web/issues/comments', []],
    ['repos/acme/web/activity', activity],
    ['repos/acme/web/compare/aaa...bbb', { total_commits: 1, commits: [{ commit: { message: 'fix: first commit' } }] }],
    ['repos/acme/web/compare/ccc...ddd', { total_commits: 2, commits: [{ commit: { message: 'a' } }, { commit: { message: 'feat: brand new push' } }] }],
  ];
}

test('연결부터 새 활동까지', async (t) => {
  const github = await startFakeGitHub({ token: TOKEN, routes: routes() });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbell-data-'));
  const env = isolatedEnv({ GITBELL_DATA_DIR: dataDir, GITBELL_API_URL: github.url });
  const { app, window, errors } = await launch({ env });
  t.after(async () => {
    await app.close();
    github.server.close();
  });

  // 토큰이 없으면 연결 안내가 보인다.
  await window.waitForSelector('.onboarding');
  await screenshot(window, 'flow-onboarding');

  if (!(await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable()))) {
    // 키링이 없는 Linux에서는 암호화할 수 없어 저장을 거절해야 한다. Windows는 DPAPI라 늘 암호화할 수 있다.
    assert.notEqual(process.platform, 'win32', 'Windows에서는 safeStorage를 쓸 수 있어야 한다');
    await window.locator('#tokenInput').fill(TOKEN);
    await window.locator('#tokenSave').click();
    await window.waitForSelector('#tokenError:not([hidden])');
    assert.equal(fs.existsSync(path.join(dataDir, 'token.bin')), false, '평문으로 남기지 않는다');
    await useTestKeyOnLinux(app);
  }

  await window.locator('#tokenInput').fill(TOKEN);
  await window.locator('#tokenInput').press('Enter');
  await window.waitForSelector('.row-item');

  const saved = fs.readFileSync(path.join(dataDir, 'token.bin'));
  assert.equal(saved.includes(Buffer.from(TOKEN)), false, '토큰은 암호화해 저장한다');
  assert.ok(github.requests.some((r) => r.path === 'user' && r.authorization === `Bearer ${TOKEN}`));

  // 첫 확인은 알림·안 읽음 없이 채운다. push 제목은 compare로 채운다.
  assert.ok(await window.getByText('fix: first commit').isVisible());
  assert.ok(await window.getByText('Add search').isVisible());
  assert.equal(await window.locator('.header .count-badge').count(), 0);
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(state.me, 'me');
  assert.deepEqual(state.checkedRepos, ['acme/web']);

  // 새 push가 생기면 안 읽음으로 들어온다(Ctrl+R).
  github.server.routes = routes({ withNewPush: true });
  await window.keyboard.press('Control+r');
  await window.waitForSelector('.row-item.unread');
  assert.equal(await window.locator('.header .count-badge').textContent(), '1');
  assert.ok(await window.getByText('feat: brand new push').isVisible());
  assert.ok(await window.getByText('Pushed 2 commits').isVisible());
  await screenshot(window, 'flow-new-activity');

  // 설정: 저장한 토큰으로 연결됨
  await window.keyboard.press('Control+,');
  assert.ok(await window.getByText('Connected with a personal access token · @me').isVisible());
  assert.equal(await window.locator('.segment.selected').textContent(), '2 min', '기본 확인 간격');
  await window.getByRole('radio', { name: '5 min', exact: true }).click();
  await window.waitForFunction(() => document.querySelector('.segment.selected').textContent === '5 min');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).refreshMinutes, 5);

  // 저장한 토큰 지우기 → 다시 연결 안내
  await window.getByRole('button', { name: 'Remove saved token' }).click();
  await window.getByRole('button', { name: 'Back' }).click();
  await window.waitForSelector('.onboarding');
  assert.equal(fs.existsSync(path.join(dataDir, 'token.bin')), false);

  assert.deepEqual(errors, []);
});

test('잘못된 토큰이면 연결 안내와 함께 알린다', async (t) => {
  const github = await startFakeGitHub({ token: 'the-right-token', routes: routes() });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbell-data-'));
  const { app, window } = await launch({ env: isolatedEnv({ GITBELL_DATA_DIR: dataDir, GITBELL_API_URL: github.url }) });
  t.after(async () => {
    await app.close();
    github.server.close();
  });
  await window.waitForSelector('.onboarding');
  await useTestKeyOnLinux(app);
  await window.locator('#tokenInput').fill('wrong-token');
  await window.locator('#tokenSave').click();
  await window.waitForSelector('.problem');
  assert.match(await window.locator('.problem').textContent(), /invalid or expired/);
  assert.ok(await window.locator('.onboarding').isVisible(), '기록이 없으면 연결 안내를 계속 보인다');
});
