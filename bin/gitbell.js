#!/usr/bin/env node
// GitBell 설치기. `npx gitbell`로 실행한다.
// GitHub Releases에서 이 패키지와 같은 버전의 설치 파일을 받아 설치하고 실행한다. 빌드 도구는 필요 없다.
//
// macOS:   .dmg를 받아 GitBell.app을 ~/Applications(이미 /Applications에 있으면 그곳)에 넣는다.
//          브라우저로 받은 파일이 아니라 격리 표시가 붙지 않아, 처음 열 때 경고가 뜨지 않는다.
// Windows: .exe(NSIS)를 받아 조용히 설치한다. 시작 메뉴와 설정 → 앱에 등록된다.
// Linux:   .AppImage를 ~/Applications에 두고 앱 메뉴에 등록한다.
// 0.5.x를 npx로 설치했다면(macOS SwiftUI 앱, Windows의 npx 설치본) 먼저 정리한다. 설정과 기록은 남긴다.
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const VERSION = require('../package.json').version;
const REPO = 'kgyujin/gitbell';
const BUNDLE_ID = 'io.github.kgyujin.gitbell';
const RUN = 'npx gitbell';

/** 설치기 문구 언어. 터미널 LANG이 영어여도 macOS 첫 번째 언어가 한국어면 한국어로 보인다. */
function detectKorean() {
  if (/^ko/i.test(process.env.GITBELL_LANG || '')) return true;
  if (/^en/i.test(process.env.GITBELL_LANG || '')) return false;
  if (process.platform === 'darwin') {
    const languages = spawnSync('defaults', ['read', '-g', 'AppleLanguages'], { encoding: 'utf8' }).stdout || '';
    const first = (languages.match(/[a-zA-Z]{2}[a-zA-Z-]*/g) || [])[0];
    if (first) return first.startsWith('ko');
  }
  return /^ko/i.test(process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale);
}
const isKorean = detectKorean();
const t = (en, ko) => (isKorean ? ko : en);

const color = (code) => (text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = color('1');
const dim = color('2');
const green = color('32');
const red = color('31');
const violet = color('35');

const step = (text) => console.log(`${violet('●')} ${text}`);

class InstallError extends Error {
  constructor(message, hint = '') {
    super(message);
    this.hint = hint;
  }
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 막 끝난 앱이 파일을 잡고 있을 수 있어 몇 번 다시 시도한다. */
function remove(target) {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
}

// MARK: - 받을 파일

/** 이 OS·CPU에 맞는 Release 파일 이름. 맞는 파일이 없으면 null. */
function assetName(version, platform = process.platform, arch = process.arch) {
  if (platform === 'darwin') return `GitBell-${version}-mac-universal.dmg`;
  if (platform === 'win32') return `GitBell-${version}-win-${arch === 'arm64' ? 'arm64' : 'x64'}.exe`;
  if (platform === 'linux' && arch === 'x64') return `GitBell-${version}-linux-x86_64.AppImage`;
  return null;
}

function assetURL(version, asset) {
  return `https://github.com/${REPO}/releases/download/v${version}/${asset}`;
}

/** curl로 받는다(macOS·Windows 10 이상·대부분의 Linux에 있고, 프록시 설정과 진행 표시를 그대로 쓴다). */
function download(version, dir) {
  const asset = assetName(version);
  if (!asset) {
    throw new InstallError(t(`There's no GitBell installer for ${process.platform} (${process.arch}).`,
      `${process.platform}(${process.arch})용 GitBell 설치 파일이 없습니다.`));
  }
  const file = path.join(dir, asset);
  step(t(`Downloading ${asset}`, `${asset} 받는 중`));
  const result = run('curl', ['-fL', '--retry', '3', '--progress-bar', '-o', file, assetURL(version, asset)],
    { stdio: ['ignore', 'inherit', 'inherit'] });
  if (result.error) throw new InstallError(t('curl is not available.', 'curl을 찾을 수 없습니다.'), String(result.error.message));
  if (result.status !== 0) {
    throw new InstallError(t(`Could not download ${asset}.`, `${asset}을 받지 못했습니다.`),
      t(`Check your connection, or download it from https://github.com/${REPO}/releases/tag/v${version}`,
        `인터넷 연결을 확인하거나 https://github.com/${REPO}/releases/tag/v${version} 에서 직접 받으세요.`));
  }
  return file;
}

function withTempDir(work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbell-'));
  try {
    return work(dir);
  } finally {
    try { remove(dir); } catch { /* 남은 임시 파일은 OS가 나중에 지운다. */ }
  }
}

// MARK: - macOS

const MAC = {
  system: '/Applications/GitBell.app',
  user: path.join(os.homedir(), 'Applications', 'GitBell.app'),
  data: path.join(os.homedir(), 'Library', 'Application Support', 'GitBell'),
};

/** 이미 /Applications에 설치돼 있으면 그곳을 바꾸고, 아니면 관리자 권한이 필요 없는 ~/Applications에 둔다. */
function macTarget() {
  return fs.existsSync(MAC.system) ? MAC.system : MAC.user;
}

function quitMacApp() {
  // 돌고 있지 않을 때 'quit app'을 부르면 macOS가 '앱 찾기' 창을 띄워 멈출 수 있어, 돌 때만 부른다.
  if (run('pgrep', ['-x', 'GitBell']).status !== 0) return;
  run('osascript', ['-e', 'quit app "GitBell"']);
  run('pkill', ['-x', 'GitBell']);
  sleep(1000);
}

function installMac(version) {
  const target = macTarget();
  withTempDir((dir) => {
    const dmg = download(version, dir);
    const mount = path.join(dir, 'mount');
    fs.mkdirSync(mount);
    const attach = run('hdiutil', ['attach', '-nobrowse', '-noautoopen', '-readonly', '-mountpoint', mount, dmg]);
    if (attach.status !== 0) throw new InstallError(t('Could not open the disk image.', '디스크 이미지를 열지 못했습니다.'), attach.stderr);
    try {
      step(t(`Installing to ${target}`, `${target}에 설치하는 중`));
      quitMacApp();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      remove(target);
      const copy = run('ditto', [path.join(mount, 'GitBell.app'), target]);
      if (copy.status !== 0) throw new InstallError(t(`Could not copy GitBell to ${target}.`, `${target}에 복사하지 못했습니다.`), copy.stderr);
    } finally {
      run('hdiutil', ['detach', '-quiet', '-force', mount]);
    }
  });
  step(t('Launching GitBell', 'GitBell 실행'));
  run('open', [target]);
  return t('Look for the bell in your menu bar.', '메뉴 막대의 종 아이콘을 누르세요.');
}

function uninstallMac(purge) {
  quitMacApp();
  for (const app of [MAC.user, MAC.system]) {
    if (!fs.existsSync(app)) continue;
    remove(app);
    step(t(`Removed ${app}`, `${app}을 지웠습니다`));
  }
  if (!purge) return;
  remove(MAC.data);
  // 0.5.x(SwiftUI 앱)가 남긴 설정·키체인 토큰·캐시
  run('defaults', ['delete', BUNDLE_ID]);
  run('security', ['delete-generic-password', '-s', BUNDLE_ID, '-a', 'github-token']);
  for (const dir of ['Caches', 'HTTPStorages']) remove(path.join(os.homedir(), 'Library', dir, BUNDLE_ID));
}

// MARK: - Windows

function windowsPaths(env = process.env) {
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const roaming = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const installDir = path.join(local, 'Programs', 'GitBell');
  return {
    installDir,
    exe: path.join(installDir, 'GitBell.exe'),
    uninstaller: path.join(installDir, 'Uninstall GitBell.exe'),
    data: path.join(roaming, 'GitBell'),
    // 0.5.x를 npx로 설치한 자리(Electron 앱 폴더)와 그때 만든 시작 메뉴 바로가기
    legacyApp: path.join(installDir, 'windows'),
    legacyShortcut: path.join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'GitBell.lnk'),
  };
}

const reg = (args) => run('reg', args);

/** 0.5.x npx 설치본을 정리한다(실행 중이면 끝내고, 로그인 항목·설치된 앱 등록·바로가기·폴더를 지운다). 설정은 남긴다. */
function removeLegacyWindows(paths) {
  if (!fs.existsSync(paths.legacyApp)) return false;
  step(t('Removing the previous version (0.5.x)', '이전 버전(0.5.x)을 정리하는 중'));
  try {
    const electron = path.join(paths.legacyApp, 'node_modules', 'electron');
    const exe = path.join(electron, 'dist', fs.readFileSync(path.join(electron, 'path.txt'), 'utf8').trim());
    run(exe, [paths.legacyApp, '--quit'], { timeout: 30000 });
  } catch {
    // 앱이 망가져 있어도 아래에서 지운다.
  }
  reg(['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', BUNDLE_ID, '/f']);
  reg(['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\GitBell', '/f']);
  fs.rmSync(paths.legacyShortcut, { force: true });
  remove(paths.installDir);
  return true;
}

function installWindows(version) {
  const paths = windowsPaths();
  removeLegacyWindows(paths);
  withTempDir((dir) => {
    const installer = download(version, dir);
    step(t('Installing', '설치하는 중'));
    // /S: 창 없이 설치, --force-run: 설치한 뒤 실행. 실행 중인 GitBell은 설치 파일이 끝내고 바꾼다.
    const result = run(installer, ['/S', '--force-run'], { timeout: 5 * 60 * 1000 });
    if (result.status !== 0) throw new InstallError(t('The installer failed.', '설치 파일이 실패했습니다.'), `exit ${result.status}`);
  });
  if (!fs.existsSync(paths.exe)) throw new InstallError(t(`GitBell was not found in ${paths.installDir}.`, `${paths.installDir}에서 GitBell을 찾지 못했습니다.`));
  return t('Click the bell in the system tray (next to the clock). If you don\'t see it, open the ^ overflow menu.',
    '작업 표시줄 시계 옆 트레이의 종 아이콘을 누르세요. 보이지 않으면 ^(숨겨진 아이콘)을 여세요.');
}

function uninstallWindows(purge) {
  const paths = windowsPaths();
  removeLegacyWindows(paths);
  if (fs.existsSync(paths.uninstaller)) {
    run(paths.uninstaller, ['/S'], { timeout: 5 * 60 * 1000 });
    // 제거 프로그램은 자신을 임시 폴더로 옮겨 이어서 지우므로, 앱이 사라질 때까지 기다린다.
    for (let i = 0; i < 60 && fs.existsSync(paths.exe); i += 1) sleep(500);
    step(t(`Removed ${paths.installDir}`, `${paths.installDir}을 지웠습니다`));
  }
  if (purge) remove(paths.data);
}

// MARK: - Linux

const LINUX = {
  appImage: path.join(os.homedir(), 'Applications', 'GitBell.AppImage'),
  desktop: path.join(os.homedir(), '.local', 'share', 'applications', 'gitbell.desktop'),
  icon: path.join(os.homedir(), '.local', 'share', 'icons', 'gitbell.png'),
  autostart: path.join(os.homedir(), '.config', 'autostart', 'gitbell.desktop'),
  data: path.join(os.homedir(), '.config', 'GitBell'),
};

function installLinux(version) {
  withTempDir((dir) => {
    const file = download(version, dir);
    step(t(`Installing to ${LINUX.appImage}`, `${LINUX.appImage}에 설치하는 중`));
    run('pkill', ['-x', 'gitbell']);
    fs.mkdirSync(path.dirname(LINUX.appImage), { recursive: true });
    fs.copyFileSync(file, LINUX.appImage);
    fs.chmodSync(LINUX.appImage, 0o755);
  });
  // 앱 메뉴에 보이게 등록한다.
  fs.mkdirSync(path.dirname(LINUX.icon), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'assets', 'icon.png'), LINUX.icon);
  fs.mkdirSync(path.dirname(LINUX.desktop), { recursive: true });
  fs.writeFileSync(LINUX.desktop, ['[Desktop Entry]', 'Type=Application', 'Name=GitBell',
    'Comment=GitHub activity in your system tray', `Exec="${LINUX.appImage}"`, `Icon=${LINUX.icon}`,
    'Categories=Development;', ''].join('\n'));
  step(t('Launching GitBell', 'GitBell 실행'));
  spawn(LINUX.appImage, [], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  return t('Click the bell in your system tray. AppImage needs FUSE (on Ubuntu: sudo apt install libfuse2).',
    '트레이의 종 아이콘을 누르세요. AppImage는 FUSE가 필요합니다(Ubuntu: sudo apt install libfuse2).');
}

function uninstallLinux(purge) {
  run('pkill', ['-x', 'gitbell']);
  for (const file of [LINUX.appImage, LINUX.desktop, LINUX.icon, LINUX.autostart]) fs.rmSync(file, { force: true });
  step(t(`Removed ${LINUX.appImage}`, `${LINUX.appImage}을 지웠습니다`));
  if (purge) remove(LINUX.data);
}

// MARK: - 명령

const INSTALLERS = { darwin: installMac, win32: installWindows, linux: installLinux };
const UNINSTALLERS = { darwin: uninstallMac, win32: uninstallWindows, linux: uninstallLinux };

/** 설치(또는 업데이트). version: 받을 Release 버전(기본은 이 패키지 버전). */
function install({ version = VERSION } = {}) {
  const installer = INSTALLERS[process.platform];
  if (!installer) throw new InstallError(t('GitBell runs on macOS, Windows and Linux.', 'GitBell은 macOS, Windows, Linux에서 동작합니다.'));
  console.log(`\n${bold('GitBell')} ${dim('v' + version)}  ${dim(t('GitHub activity in your menu bar or tray', '메뉴 막대·트레이에서 보는 GitHub 활동'))}\n`);
  const where = installer(version);
  console.log(`\n${green('✔')} ${bold(t('Done!', '설치 완료!'))} ${where}`);
  const ghReady = run('gh', ['auth', 'status']).status === 0;
  console.log(dim(ghReady
    ? t('  Signed in through GitHub CLI. Nothing else to set up.', '  GitHub CLI 로그인을 그대로 씁니다. 따로 설정할 것이 없습니다.')
    : t('  Connect GitHub in the app: run `gh auth login`, or paste a personal access token.',
      '  앱에서 GitHub을 연결하세요: `gh auth login`을 실행하거나 개인 액세스 토큰을 붙여넣습니다.')));
  console.log(dim(t(`  Update: ${RUN}@latest · Uninstall: ${RUN} uninstall`, `  업데이트: ${RUN}@latest · 지우기: ${RUN} uninstall`)) + '\n');
}

function uninstall({ purge = false } = {}) {
  const uninstaller = UNINSTALLERS[process.platform];
  if (!uninstaller) throw new InstallError(t('GitBell runs on macOS, Windows and Linux.', 'GitBell은 macOS, Windows, Linux에서 동작합니다.'));
  uninstaller(purge);
  console.log(purge
    ? `${green('✔')} ${t('Removed GitBell with its settings, history and saved token.', 'GitBell과 설정·기록·저장한 토큰을 지웠습니다.')}`
    : `${green('✔')} ${t('Removed GitBell. Settings were kept; add --purge to remove them too.',
      'GitBell을 지웠습니다. 설정은 남겼습니다. 함께 지우려면 --purge를 붙이세요.')}`);
}

function help() {
  console.log(`
${bold('GitBell')} ${dim('v' + VERSION)}

${[
    [RUN, t('install (or update)', '설치(또는 업데이트)')],
    // npx는 예전에 받은 버전을 다시 쓸 수 있어, 업데이트는 @latest를 붙여야 확실하다.
    [`${RUN}@latest`, t('update to the latest version', '최신 버전으로 업데이트')],
    [`${RUN} uninstall`, t('remove the app', '앱 지우기')],
    [`${RUN} uninstall --purge`, t('remove the app, settings and token', '앱·설정·토큰 모두 지우기')],
  ].map(([command, text]) => `  ${bold(command.padEnd(32))}${text}`).join('\n')}
`);
}

function main(argv) {
  const [command = 'install', ...rest] = argv;
  try {
    switch (command) {
      case 'install':
      case 'update':
        return install();
      case 'uninstall':
        return uninstall({ purge: rest.includes('--purge') });
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
        process.exitCode = 1;
    }
  } catch (error) {
    console.error(`\n${red('✖')} ${error.message}`);
    if (error.hint) console.error(`  ${error.hint}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { main, install, uninstall, assetName, assetURL, windowsPaths, LINUX, MAC };
