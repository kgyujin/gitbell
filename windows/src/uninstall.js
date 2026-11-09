// Windows "설정 → 앱 → 설치된 앱"에서 GitBell을 지울 수 있게 하는 것들.
// 설치기(bin/gitbell.js)와 앱(main.js)이 함께 쓴다. Electron에 기대지 않는다.
//
// - 설치할 때 HKCU의 Uninstall 키에 GitBell을 등록한다(관리자 권한이 필요 없다).
// - "제거"를 누르면 Windows가 UninstallString(= GitBell --uninstall-app)을 실행한다.
//   앱은 확인 창을 띄우고, 바로가기·로그인 항목·등록을 지운 뒤, 자기 폴더는 끝난 다음에 cmd가 지운다
//   (실행 중인 electron.exe는 자기 폴더를 지울 수 없다).
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const BUNDLE_ID = 'io.github.kgyujin.gitbell';
// 설치 위치·레지스트리 값은 늘 Windows 경로 규칙으로 만든다(다른 OS에서 테스트해도 같게).
const win = path.win32;
const UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\GitBell';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

/** 설치 위치. %LOCALAPPDATA%\Programs\GitBell 아래에 windows\(앱)와 Resources\(문구)가 있다. */
function installPaths(env = process.env) {
  const local = env.LOCALAPPDATA || win.join(os.homedir(), 'AppData', 'Local');
  const roaming = env.APPDATA || win.join(os.homedir(), 'AppData', 'Roaming');
  const installDir = win.join(local, 'Programs', 'GitBell');
  return {
    installDir,
    appDir: win.join(installDir, 'windows'),
    dataDir: win.join(roaming, 'GitBell'),
    shortcut: win.join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'GitBell.lnk'),
  };
}

/** 이 앱이 설치기가 설치한 자리에서 도는지. 개발 중인 소스 폴더를 지우지 않으려고 확인한다. */
function isStandardInstall(appPath, env = process.env) {
  return win.resolve(appPath).toLowerCase() === installPaths(env).appDir.toLowerCase();
}

function folderSizeKB(dir) {
  let bytes = 0;
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) bytes += fs.statSync(full).size;
    }
  };
  walk(dir);
  return Math.ceil(bytes / 1024);
}

/** 설치된 앱 목록에 보일 값. [이름, 형식, 값] */
function uninstallEntries({ exe, version, env = process.env, sizeKB = 0 }) {
  const { installDir, appDir } = installPaths(env);
  const command = `"${exe}" "${appDir}" --uninstall-app`;
  return [
    ['DisplayName', 'REG_SZ', 'GitBell'],
    ['DisplayVersion', 'REG_SZ', version],
    ['Publisher', 'REG_SZ', 'kgyujin'],
    ['DisplayIcon', 'REG_SZ', win.join(appDir, 'assets', 'icon.ico')],
    ['InstallLocation', 'REG_SZ', installDir],
    ['URLInfoAbout', 'REG_SZ', 'https://github.com/kgyujin/gitbell'],
    ['UninstallString', 'REG_SZ', command],
    ['QuietUninstallString', 'REG_SZ', `${command} --quiet`],
    ['NoModify', 'REG_DWORD', '1'],
    ['NoRepair', 'REG_DWORD', '1'],
    ['EstimatedSize', 'REG_DWORD', String(sizeKB)],
  ];
}

function reg(args) {
  return spawnSync('reg', args, { encoding: 'utf8', windowsHide: true });
}

/** 설치된 앱 목록에 등록한다. 실패하면 false(앱은 그대로 쓸 수 있다). */
function registerUninstall(options) {
  return uninstallEntries(options)
    .map(([name, type, data]) => reg(['add', UNINSTALL_KEY, '/v', name, '/t', type, '/d', data, '/f']).status === 0)
    .every(Boolean);
}

/** 바로가기·로그인 시 실행·설치된 앱 목록 등록을 지운다. 없으면 조용히 넘어간다. */
function removeIntegration(env = process.env) {
  fs.rmSync(installPaths(env).shortcut, { force: true });
  // Electron은 로그인 항목 이름으로 AppUserModelID를 쓴다.
  reg(['delete', RUN_KEY, '/v', BUNDLE_ID, '/f']);
  reg(['delete', UNINSTALL_KEY, '/f']);
}

/**
 * 앱이 끝난 뒤 폴더를 지우는 cmd 명령. 1초 간격으로 최대 30번 시도한다.
 * 숨은 창에서는 timeout이 동작하지 않아 ping으로 기다린다.
 */
function removalCommand(dirs) {
  const remove = dirs.map((dir) => `rd /s /q "${dir}" 2>nul`).join(' & ');
  const done = `${dirs.map((dir) => `if not exist "${dir}"`).join(' ')} exit /b 0`;
  return `/d /s /c "for /l %i in (1,1,30) do (ping -n 2 127.0.0.1 >nul & ${remove} & ${done})"`;
}

/** 이 프로세스가 끝난 뒤 폴더들을 지우도록 cmd를 띄워 둔다. */
function scheduleRemoval(dirs) {
  if (!dirs.length) return;
  spawn(process.env.ComSpec || 'cmd.exe', [removalCommand(dirs)], {
    cwd: os.tmpdir(),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    windowsVerbatimArguments: true,
  }).unref();
}

module.exports = {
  BUNDLE_ID,
  UNINSTALL_KEY,
  RUN_KEY,
  installPaths,
  isStandardInstall,
  folderSizeKB,
  uninstallEntries,
  registerUninstall,
  removeIntegration,
  removalCommand,
  scheduleRemoval,
};
