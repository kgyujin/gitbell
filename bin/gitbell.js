#!/usr/bin/env node
// GitBell 설치기. `npx gitbell` 또는 `npx github:kgyujin/gitbell`로 실행한다.
//
// 하는 일: 소스를 임시 폴더로 복사 → 이 Mac에서 Swift로 빌드 → ~/Applications/GitBell.app에 설치 → 실행.
// 내 Mac에서 빌드한 앱이라 "확인되지 않은 개발자" 경고가 뜨지 않는다.
// 필요한 것: macOS 13 이상, Xcode 명령줄 도구(xcode-select --install).
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(os.homedir(), 'Applications');
const APP_PATH = path.join(APP_DIR, 'GitBell.app');
const DATA_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'GitBell');
const BUNDLE_ID = 'io.github.kgyujin.gitbell';
const VERSION = require(path.join(PACKAGE_ROOT, 'package.json')).version;
// 안내에 쓰는 실행 명령. npm 패키지 이름과 같다.
const RUN = 'npx gitbell';

/** 설치기 문구 언어. 터미널 LANG이 영어여도 macOS 첫 번째 언어가 한국어면 한국어로 보인다. */
function detectKorean() {
  if (/^ko/i.test(process.env.GITBELL_LANG || '')) return true;
  if (/^en/i.test(process.env.GITBELL_LANG || '')) return false;
  const languages = spawnSync('defaults', ['read', '-g', 'AppleLanguages'], { encoding: 'utf8' }).stdout || '';
  const first = (languages.match(/"?([a-zA-Z-]+)"?/g) || []).map((s) => s.replace(/"/g, '')).find((s) => /^[a-z]{2}/.test(s));
  if (first) return first.startsWith('ko');
  return /^ko/i.test(process.env.LANG || '');
}
const isKorean = detectKorean();
const t = (en, ko) => (isKorean ? ko : en);

const color = (code) => (text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = color('1');
const dim = color('2');
const green = color('32');
const red = color('31');
const violet = color('35');

function step(text) {
  console.log(`${violet('●')} ${text}`);
}

function fail(text, hint) {
  console.error(`\n${red('✖')} ${text}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

/** macOS 13(Darwin 22) 이상인지 확인한다. */
function checkPlatform() {
  if (process.platform !== 'darwin') {
    fail(t('GitBell runs on macOS only.', 'GitBell은 macOS에서만 동작합니다.'));
  }
  const darwinMajor = Number(os.release().split('.')[0]);
  if (darwinMajor < 22) {
    fail(t('GitBell needs macOS 13 Ventura or later.', 'GitBell은 macOS 13 Ventura 이상이 필요합니다.'));
  }
}

/** Package.swift가 swift-tools-version 5.10을 쓰므로 Swift 5.10(Xcode 15.3) 이상이 필요하다. */
function checkSwift() {
  const result = run('xcrun', ['swift', '--version']);
  if (result.status !== 0) {
    fail(
      t('Swift is not installed.', 'Swift가 설치되어 있지 않습니다.'),
      t('Install the Xcode command line tools, then run this again:', 'Xcode 명령줄 도구를 설치한 뒤 다시 실행하세요:') +
        `\n  ${bold('xcode-select --install')}`,
    );
  }
  const match = `${result.stdout}${result.stderr}`.match(/Swift version (\d+)\.(\d+)/);
  if (match && (Number(match[1]) < 5 || (Number(match[1]) === 5 && Number(match[2]) < 10))) {
    fail(
      t(`Swift ${match[1]}.${match[2]} is too old. GitBell needs Swift 5.10 or later.`,
        `Swift ${match[1]}.${match[2]}는 너무 오래됐습니다. GitBell은 Swift 5.10 이상이 필요합니다.`),
      t('Update Xcode (15.3 or later) or the command line tools in Software Update, then run this again.',
        '소프트웨어 업데이트에서 Xcode(15.3 이상)나 명령줄 도구를 업데이트한 뒤 다시 실행하세요.'),
    );
  }
}

function quitRunningApp() {
  run('osascript', ['-e', 'quit app "GitBell"']);
  run('pkill', ['-x', 'GitBell']);
}

function install() {
  console.log(`\n${bold('GitBell')} ${dim('v' + VERSION)}  ${dim(t('GitHub activity in your menu bar', '메뉴 막대에서 보는 GitHub 활동'))}\n`);
  checkPlatform();
  checkSwift();

  // npx 캐시 폴더는 읽기 전용일 수 있어 임시 폴더에서 빌드한다.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbell-'));
  // Package.swift가 테스트 대상도 선언하므로 Tests 폴더가 없으면 빌드가 실패한다.
  for (const entry of ['Package.swift', 'package.json', 'Sources', 'Tests', 'Resources', 'scripts']) {
    fs.cpSync(path.join(PACKAGE_ROOT, entry), path.join(workDir, entry), { recursive: true });
  }

  step(t('Building on this Mac (about 1–2 minutes the first time)…', '이 Mac에서 빌드하는 중 (처음엔 1~2분)…'));
  const logPath = path.join(workDir, 'build.log');
  const build = run('bash', [path.join(workDir, 'scripts', 'build-app.sh'), path.join(workDir, 'dist')], {
    cwd: workDir,
  });
  fs.writeFileSync(logPath, `${build.stdout || ''}\n${build.stderr || ''}`);
  const builtApp = path.join(workDir, 'dist', 'GitBell.app');
  if (build.status !== 0 || !fs.existsSync(builtApp)) {
    const tail = `${build.stdout || ''}\n${build.stderr || ''}`.trim().split('\n').slice(-15).join('\n');
    fail(t('Build failed.', '빌드에 실패했습니다.'), `${dim(tail)}\n  ${t('Full log:', '전체 로그:')} ${logPath}`);
  }

  step(t(`Installing to ${APP_PATH}`, `${APP_PATH}에 설치하는 중`));
  quitRunningApp();
  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.rmSync(APP_PATH, { recursive: true, force: true });
  // ditto는 앱 묶음의 서명과 속성을 그대로 복사한다.
  const copy = run('ditto', [builtApp, APP_PATH]);
  if (copy.status !== 0) fail(t('Could not copy the app.', '앱을 복사하지 못했습니다.'), copy.stderr);
  fs.rmSync(workDir, { recursive: true, force: true });

  step(t('Launching GitBell', 'GitBell 실행'));
  run('open', [APP_PATH]);

  const ghReady = run('gh', ['auth', 'status']).status === 0;
  console.log(`\n${green('✔')} ${bold(t('Done! Look for the bell in your menu bar.', '설치 완료! 메뉴 막대의 종 아이콘을 누르세요.'))}`);
  if (ghReady) {
    console.log(dim(t('  Signed in through GitHub CLI. Nothing else to set up.', '  GitHub CLI 로그인을 그대로 씁니다. 따로 설정할 것이 없습니다.')));
  } else {
    console.log(dim(t('  Connect GitHub in the app: run `gh auth login`, or paste a personal access token.',
      '  앱에서 GitHub을 연결하세요: `gh auth login`을 실행하거나 개인 액세스 토큰을 붙여넣습니다.')));
  }
  console.log(dim(t(`  Uninstall anytime: ${RUN} uninstall`, `  지우려면: ${RUN} uninstall`)) + '\n');
}

function uninstall(purge) {
  quitRunningApp();
  fs.rmSync(APP_PATH, { recursive: true, force: true });
  step(t(`Removed ${APP_PATH}`, `${APP_PATH}을 지웠습니다`));
  console.log(dim(t('  If you turned on "Open at login", remove GitBell in System Settings → General → Login Items.',
    '  "로그인 시 자동 실행"을 켰다면 시스템 설정 → 일반 → 로그인 항목에서 GitBell을 지우세요.')));
  if (purge) {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    run('defaults', ['delete', BUNDLE_ID]);
    run('security', ['delete-generic-password', '-s', BUNDLE_ID, '-a', 'github-token']);
    step(t('Removed saved data, settings and the Keychain token', '저장된 기록, 설정, 키체인 토큰을 지웠습니다'));
  } else {
    console.log(dim(t('  Kept your settings. Add --purge to remove them too.', '  설정은 남겨 두었습니다. 함께 지우려면 --purge를 붙이세요.')));
  }
}

function help() {
  console.log(`
${bold('GitBell')} ${dim('v' + VERSION)}

${[
    [RUN, t('build and install (or update)', '빌드하고 설치(또는 업데이트)')],
    [`${RUN} uninstall`, t('remove the app', '앱 지우기')],
    [`${RUN} uninstall --purge`, t('remove the app, settings and token', '앱·설정·토큰 모두 지우기')],
  ].map(([command, text]) => `  ${bold(command.padEnd(46))}${text}`).join('\n')}
`);
}

function main(argv) {
  const [command = 'install', ...rest] = argv;
  switch (command) {
    case 'install':
    case 'update':
      return install();
    case 'uninstall':
      return uninstall(rest.includes('--purge'));
    case '-v':
    case '--version':
      return console.log(VERSION);
    case '-h':
    case '--help':
    case 'help':
      return help();
    default:
      help();
      process.exit(1);
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { main };
