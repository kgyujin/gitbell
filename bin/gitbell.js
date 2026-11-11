#!/usr/bin/env node
// GitBell 설치기. `npx gitbell` 또는 `npx github:kgyujin/gitbell`로 실행한다.
//
// macOS: 소스를 임시 폴더로 복사 → 이 Mac에서 Swift로 빌드 → ~/Applications/GitBell.app에 설치 → 실행.
//        내 Mac에서 빌드한 앱이라 "확인되지 않은 개발자" 경고가 뜨지 않는다.
//        필요한 것: macOS 13 이상, Xcode 명령줄 도구(xcode-select --install).
// Windows: windows/ 폴더의 Electron 앱을 %LOCALAPPDATA%\Programs\GitBell에 복사 → Electron 받기
//        → 시작 메뉴 바로가기 만들기 → 실행. 필요한 것: Windows 10 이상, Node.js 22.12 이상.
'use strict';

const { spawn, spawnSync } = require('node:child_process');
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

// Windows판 위치. 설정·기록은 Electron이 정하는 %APPDATA%\GitBell에 있다.
const WIN_INSTALL_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'GitBell');
const WIN_APP_DIR = path.join(WIN_INSTALL_DIR, 'windows');
const WIN_DATA_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'GitBell');
// windows/ 안에서 설치할 것. 개발용 node_modules·테스트는 빼고, 한국어 문구는 macOS판 파일을 함께 쓴다.
const WIN_APP_ENTRIES = ['package.json', 'package-lock.json', 'src', 'assets'];

/** 설치기 문구 언어. 터미널 LANG이 영어여도 macOS 첫 번째 언어가 한국어면 한국어로 보인다. */
function detectKorean() {
  if (/^ko/i.test(process.env.GITBELL_LANG || '')) return true;
  if (/^en/i.test(process.env.GITBELL_LANG || '')) return false;
  if (process.platform !== 'darwin') return /^ko/i.test(Intl.DateTimeFormat().resolvedOptions().locale);
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
  const darwinMajor = Number(os.release().split('.')[0]);
  if (darwinMajor < 22) {
    fail(t('GitBell needs macOS 13 Ventura or later.', 'GitBell은 macOS 13 Ventura 이상이 필요합니다.'));
  }
}

/** Package.swift가 swift-tools-version 5.10을 쓰므로 Swift 5.10(Xcode 15.3) 이상이 필요하다. */
/**
 * Swift·빌드가 실패한 출력에서 흔한 원인을 찾아 해결 방법을 돌려준다. 모르는 원인이면 null.
 * - Xcode 라이선스에 동의하지 않음 → sudo xcodebuild -license accept
 * - 명령줄 도구 경로가 깨짐(macOS 업데이트 뒤 흔함) → xcode-select --install
 * - 디스크 공간 부족
 */
function explainBuildProblem(output) {
  const text = String(output || '');
  if (/agreed to the Xcode (and Apple SDKs )?license|xcodebuild -license/i.test(text)) {
    return {
      problem: t('You need to accept the Xcode license first.', 'Xcode 라이선스에 먼저 동의해야 합니다.'),
      hint: `${t('Run this, then run the installer again:', '아래 명령을 실행한 뒤 설치를 다시 실행하세요:')}\n  ${bold('sudo xcodebuild -license accept')}`,
    };
  }
  if (/invalid active developer path|missing xcrun|xcrun: error: unable to find utility/i.test(text)) {
    return {
      problem: t('The Xcode command line tools are missing or broken (common after a macOS update).',
        'Xcode 명령줄 도구가 없거나 깨졌습니다(macOS 업데이트 뒤에 흔합니다).'),
      hint: `${t('Reinstall them, then run this again:', '다시 설치한 뒤 다시 실행하세요:')}\n  ${bold('xcode-select --install')}`,
    };
  }
  if (/No space left on device/i.test(text)) {
    return {
      problem: t('There is not enough disk space to build GitBell.', 'GitBell을 빌드할 디스크 공간이 부족합니다.'),
      hint: t('Free up about 1 GB, then run this again.', '1GB쯤 비운 뒤 다시 실행하세요.'),
    };
  }
  return null;
}

function checkSwift() {
  const result = run('xcrun', ['swift', '--version']);
  if (result.status !== 0) {
    // '설치되지 않음'만 있는 게 아니다. 라이선스 미동의, 깨진 도구 경로도 여기서 실패한다.
    const known = explainBuildProblem(`${result.stdout || ''}\n${result.stderr || ''}\n${result.error || ''}`);
    if (known) fail(known.problem, known.hint);
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

/** 지우다 실패해도(권한, 이미 없음) 멈추지 않는다. 정리 단계에서만 쓴다. */
function removeQuietly(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // 정리하지 못한 임시 파일은 macOS가 나중에 지운다.
  }
}

function quitRunningApp() {
  // 돌고 있지 않을 때 'quit app'을 부르면 macOS가 '앱 찾기' 창을 띄워 설치가 멈출 수 있어, 돌 때만 부른다.
  if (run('pgrep', ['-x', 'GitBell']).status !== 0) return;
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

  // 설치·업데이트할 때마다 새 임시 폴더에서 처음부터 빌드한다(이어 쓰는 빌드 결과가 없다).
  step(t('Building on this Mac (about 1–2 minutes)…', '이 Mac에서 빌드하는 중 (1~2분 걸립니다)…'));
  const logPath = path.join(workDir, 'build.log');
  const build = run('bash', [path.join(workDir, 'scripts', 'build-app.sh'), path.join(workDir, 'dist')], {
    cwd: workDir,
  });
  fs.writeFileSync(logPath, `${build.stdout || ''}\n${build.stderr || ''}`);
  const builtApp = path.join(workDir, 'dist', 'GitBell.app');
  if (build.status !== 0 || !fs.existsSync(builtApp)) {
    const known = explainBuildProblem(`${build.stdout || ''}\n${build.stderr || ''}`);
    if (known) fail(known.problem, `${known.hint}\n  ${t('Full log:', '전체 로그:')} ${logPath}`);
    const tail = `${build.stdout || ''}\n${build.stderr || ''}`.trim().split('\n').slice(-15).join('\n');
    // 로그는 남기고 수백 MB짜리 빌드 결과(.build)는 지운다.
    removeQuietly(path.join(workDir, '.build'));
    fail(t('Build failed.', '빌드에 실패했습니다.'), `${dim(tail)}\n  ${t('Full log:', '전체 로그:')} ${logPath}`);
  }

  step(t(`Installing to ${APP_PATH}`, `${APP_PATH}에 설치하는 중`));
  quitRunningApp();
  // 새 앱을 옆에 먼저 복사한 뒤 바꿔 끼운다. 복사가 실패해도 쓰던 앱은 그대로 남는다.
  const staged = `${APP_PATH}.new`;
  try {
    fs.mkdirSync(APP_DIR, { recursive: true });
    fs.rmSync(staged, { recursive: true, force: true });
    // ditto는 앱 묶음의 서명과 속성을 그대로 복사한다.
    const copy = run('ditto', [builtApp, staged]);
    if (copy.status !== 0) fail(t('Could not copy the app.', '앱을 복사하지 못했습니다.'), copy.stderr);
    fs.rmSync(APP_PATH, { recursive: true, force: true });
    fs.renameSync(staged, APP_PATH);
  } catch (error) {
    // 예전에 sudo로 설치해 관리자 소유가 된 앱은 지울 수 없다. 어떻게 고치는지 알려 준다.
    if (error && (error.code === 'EACCES' || error.code === 'EPERM')) {
      fail(t(`No permission to replace ${APP_PATH}.`, `${APP_PATH}을 바꿀 권한이 없습니다.`),
        t('It may have been installed with sudo. Remove it once, then run this again:',
          'sudo로 설치했던 앱일 수 있습니다. 한 번 지운 뒤 다시 실행하세요:') + `\n  ${bold(`sudo rm -rf "${APP_PATH}"`)}`);
    }
    throw error;
  }
  // 임시 폴더를 못 지워도 설치는 끝난 것이라 멈추지 않는다.
  removeQuietly(workDir);

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
    // 0.5.2까지는 GitHub API 응답(비공개 저장소 본문 포함)이 이 캐시에 남았다. 함께 지운다.
    removeQuietly(path.join(os.homedir(), 'Library', 'Caches', BUNDLE_ID));
    removeQuietly(path.join(os.homedir(), 'Library', 'HTTPStorages', BUNDLE_ID));
    step(t('Removed saved data, settings and the Keychain token', '저장된 기록, 설정, 키체인 토큰을 지웠습니다'));
  } else {
    console.log(dim(t('  Kept your settings. Add --purge to remove them too.', '  설정은 남겨 두었습니다. 함께 지우려면 --purge를 붙이세요.')));
  }
}

// MARK: - Windows

/** Windows 10 이상, Electron이 요구하는 Node.js 22.12 이상인지 확인한다. */
function checkWindows() {
  if (Number(os.release().split('.')[0]) < 10) {
    fail(t('GitBell needs Windows 10 or later.', 'GitBell은 Windows 10 이상이 필요합니다.'));
  }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) {
    fail(t(`Node.js ${process.versions.node} is too old. GitBell for Windows needs Node.js 22.12 or later.`,
      `Node.js ${process.versions.node}는 너무 오래됐습니다. Windows판 GitBell은 Node.js 22.12 이상이 필요합니다.`),
    t('Install the current LTS from https://nodejs.org, then run this again.', 'https://nodejs.org 에서 최신 LTS를 설치한 뒤 다시 실행하세요.'));
  }
}

/** 설치된 Electron 실행 파일. 없으면 null. */
function windowsElectron(appDir = WIN_APP_DIR) {
  const dir = path.join(appDir, 'node_modules', 'electron');
  try {
    const exe = path.join(dir, 'dist', fs.readFileSync(path.join(dir, 'path.txt'), 'utf8').trim());
    return fs.existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

/** 설치된 GitBell에 명령(--quit, --uninstall, --create-shortcut)을 보낸다. */
function runWindowsApp(flag) {
  const exe = windowsElectron();
  return exe ? run(exe, [WIN_APP_DIR, flag], { timeout: 30000, windowsHide: true }) : null;
}

/** 실패한 명령의 출력(실행조차 못 했으면 그 이유). */
function output(result) {
  return dim(`${result.stdout || ''}\n${result.stderr || ''}`.trim() || String(result.error || ''));
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 실행 중이던 앱이 막 끝나 파일이 잠겨 있을 수 있어 몇 번 다시 시도하고, 그래도 안 되면 안내하고 끝낸다. */
function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  } catch (error) {
    fail(t(`Could not remove ${dir}.`, `${dir}을 지우지 못했습니다.`),
      t('Quit GitBell (right-click the tray icon → Quit GitBell), then run this again.',
        'GitBell을 끝낸 뒤(트레이 아이콘 우클릭 → GitBell 종료) 다시 실행하세요.') + `\n  ${dim(error.message)}`);
  }
}

/**
 * 준비한 폴더를 설치 위치로 옮긴다. 막 받은 electron.exe를 백신이 검사하느라 잠깐 잡고 있으면
 * 옮기기가 실패할 수 있어 몇 번 다시 시도하고, 그래도 안 되면 복사한다.
 */
function moveIntoPlace(from, to) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return fs.renameSync(from, to);
    } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      sleep(500);
    }
  }
  fs.cpSync(from, to, { recursive: true });
  removeDir(from);
}

/** 설치된 앱 목록 등록·제거(앱과 같은 코드를 쓴다). */
function windowsUninstall() {
  return require(path.join(PACKAGE_ROOT, 'windows', 'src', 'uninstall.js'));
}

function installWindows() {
  console.log(`\n${bold('GitBell')} ${dim('v' + VERSION)}  ${dim(t('GitHub activity in your system tray', '작업 표시줄 트레이에서 보는 GitHub 활동'))}\n`);
  checkWindows();

  // 새 버전은 옆 폴더에서 다 준비한 뒤에만 바꿔 넣는다. 받기가 실패해도 쓰던 앱은 그대로 남는다.
  const staging = `${WIN_INSTALL_DIR}.new`;
  const stagingApp = path.join(staging, 'windows');
  removeDir(staging);
  for (const entry of WIN_APP_ENTRIES) {
    fs.cpSync(path.join(PACKAGE_ROOT, 'windows', entry), path.join(stagingApp, entry), { recursive: true });
  }
  const strings = path.join('Resources', 'ko.lproj');
  fs.cpSync(path.join(PACKAGE_ROOT, strings), path.join(staging, strings), { recursive: true });

  step(t('Downloading Electron (about 100 MB the first time)…', 'Electron을 받는 중 (처음엔 약 100MB)…'));
  const abort = (message, result) => {
    removeDir(staging);
    fail(message, output(result));
  };
  // Windows에서 npm은 npm.cmd라 셸로 실행한다. 인자는 고정값이다.
  const npm = run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: stagingApp, shell: true });
  if (npm.status !== 0) abort(t('Could not install Electron.', 'Electron을 설치하지 못했습니다.'), npm);
  const download = run(process.execPath, [path.join(stagingApp, 'node_modules', 'electron', 'install.js')], { cwd: stagingApp });
  if (download.status !== 0 || !windowsElectron(stagingApp)) abort(t('Could not download Electron.', 'Electron을 받지 못했습니다.'), download);

  step(t(`Installing to ${WIN_INSTALL_DIR}`, `${WIN_INSTALL_DIR}에 설치하는 중`));
  runWindowsApp('--quit');
  removeDir(WIN_INSTALL_DIR);
  moveIntoPlace(staging, WIN_INSTALL_DIR);
  const exe = windowsElectron();

  // 시작 메뉴 바로가기가 있어야 알림에 GitBell 이름과 아이콘이 보인다.
  runWindowsApp('--create-shortcut');
  // 설정 → 앱 → 설치된 앱에서 지울 수 있게 등록한다.
  const Uninstall = windowsUninstall();
  Uninstall.registerUninstall({ exe, version: VERSION, sizeKB: Uninstall.folderSizeKB(WIN_INSTALL_DIR) });

  step(t('Launching GitBell', 'GitBell 실행'));
  spawn(exe, [WIN_APP_DIR], { detached: true, stdio: 'ignore' }).unref();

  const ghReady = run('gh', ['auth', 'status'], { windowsHide: true }).status === 0;
  console.log(`\n${green('✔')} ${bold(t('Done! Click the bell in the system tray (next to the clock).', '설치 완료! 작업 표시줄 시계 옆 트레이의 종 아이콘을 누르세요.'))}`);
  console.log(dim(t('  If you don\'t see it, open the ^ overflow menu and drag the bell onto the taskbar.',
    '  보이지 않으면 ^(숨겨진 아이콘)을 열고 종 아이콘을 작업 표시줄로 끌어다 놓으세요.')));
  if (ghReady) {
    console.log(dim(t('  Signed in through GitHub CLI. Nothing else to set up.', '  GitHub CLI 로그인을 그대로 씁니다. 따로 설정할 것이 없습니다.')));
  } else {
    console.log(dim(t('  Connect GitHub in the app: run `gh auth login`, or paste a personal access token.',
      '  앱에서 GitHub을 연결하세요: `gh auth login`을 실행하거나 개인 액세스 토큰을 붙여넣습니다.')));
  }
  console.log(dim(t(`  Uninstall anytime: ${RUN} uninstall`, `  지우려면: ${RUN} uninstall`)) + '\n');
}

function uninstallWindows(purge) {
  // 실행 중인 앱을 끝내고 로그인 시 실행·시작 메뉴 바로가기를 지운다.
  runWindowsApp('--uninstall');
  // 앱이 망가져 스스로 지우지 못했을 때를 위해 설치기도 직접 지운다.
  windowsUninstall().removeIntegration();
  removeDir(WIN_INSTALL_DIR);
  removeDir(`${WIN_INSTALL_DIR}.new`);
  step(t(`Removed ${WIN_INSTALL_DIR}`, `${WIN_INSTALL_DIR}을 지웠습니다`));
  if (purge) {
    removeDir(WIN_DATA_DIR);
    step(t('Removed saved data, settings and the saved token', '저장된 기록, 설정, 저장한 토큰을 지웠습니다'));
  } else {
    console.log(dim(t('  Kept your settings. Add --purge to remove them too.', '  설정은 남겨 두었습니다. 함께 지우려면 --purge를 붙이세요.')));
  }
}

function help() {
  console.log(`
${bold('GitBell')} ${dim('v' + VERSION)}

${[
    [RUN, t('build and install (or update)', '빌드하고 설치(또는 업데이트)')],
    // npx는 예전에 받은 버전을 다시 쓸 수 있어, 업데이트는 @latest를 붙여야 확실하다.
    [`${RUN}@latest`, t('update to the latest version', '최신 버전으로 업데이트')],
    [`${RUN} uninstall`, t('remove the app', '앱 지우기')],
    [`${RUN} uninstall --purge`, t('remove the app, settings and token', '앱·설정·토큰 모두 지우기')],
  ].map(([command, text]) => `  ${bold(command.padEnd(32))}${text}`).join('\n')}
`);
}

function main(argv) {
  const [command = 'install', ...rest] = argv;
  const isWindows = process.platform === 'win32';
  if ((command === 'install' || command === 'update' || command === 'uninstall') && !isWindows && process.platform !== 'darwin') {
    fail(t('GitBell runs on macOS and Windows.', 'GitBell은 macOS와 Windows에서 동작합니다.'));
  }
  switch (command) {
    case 'install':
    case 'update':
      return isWindows ? installWindows() : install();
    case 'uninstall':
      return isWindows ? uninstallWindows(rest.includes('--purge')) : uninstall(rest.includes('--purge'));
    case '-v':
    case '--version':
      return console.log(VERSION);
    case '-h':
    case '--help':
    case 'help':
      return help();
    default:
      console.error(`\n${t('Unknown command:', '알 수 없는 명령:')} ${command}`);
      help();
      process.exit(1);
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { main, explainBuildProblem, WIN_INSTALL_DIR, WIN_APP_DIR, WIN_DATA_DIR, WIN_APP_ENTRIES };
