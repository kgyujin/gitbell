// npx 설치기(bin/gitbell.js): OS·CPU에 맞는 Release 파일을 고른다.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const installer = require('../../bin/gitbell');

test('설치기: OS·CPU에 맞는 Release 파일을 고른다', () => {
  assert.equal(installer.assetName('0.6.1', 'darwin', 'arm64'), 'GitBell-0.6.1-mac-universal.dmg');
  assert.equal(installer.assetName('0.6.1', 'darwin', 'x64'), 'GitBell-0.6.1-mac-universal.dmg');
  assert.equal(installer.assetName('0.6.1', 'win32', 'x64'), 'GitBell-0.6.1-win-x64.exe');
  assert.equal(installer.assetName('0.6.1', 'win32', 'arm64'), 'GitBell-0.6.1-win-arm64.exe');
  assert.equal(installer.assetName('0.6.1', 'linux', 'x64'), 'GitBell-0.6.1-linux-x86_64.AppImage');
  assert.equal(installer.assetName('0.6.1', 'linux', 'arm64'), null, 'Linux arm64 설치 파일은 만들지 않는다');
  assert.equal(installer.assetURL('0.6.1', 'GitBell-0.6.1-win-x64.exe'),
    'https://github.com/kgyujin/gitbell/releases/download/v0.6.1/GitBell-0.6.1-win-x64.exe');
});

test('설치기: 받을 파일 이름이 electron-builder 설정과 맞는다', () => {
  const { build } = require('../../package.json');
  assert.equal(build.artifactName, 'GitBell-${version}-${os}-${arch}.${ext}');
  assert.deepEqual(build.mac.target[0].arch, ['universal']);
  assert.deepEqual(build.win.target[0].arch, ['x64', 'arm64']);
  assert.equal(build.nsis.buildUniversalInstaller, false, '두 CPU를 합친 큰 설치 파일은 만들지 않는다');
});

test('설치기: 0.5.x npx 설치본 자리를 안다(Windows)', () => {
  const paths = installer.windowsPaths({ LOCALAPPDATA: 'C:\\L', APPDATA: 'C:\\R' });
  assert.equal(paths.exe, path.join('C:\\L', 'Programs', 'GitBell', 'GitBell.exe'));
  assert.equal(paths.legacyApp, path.join('C:\\L', 'Programs', 'GitBell', 'windows'));
  assert.equal(paths.data, path.join('C:\\R', 'GitBell'));
});

test('설치기: 버전·도움말을 보이고, 모르는 명령은 실패한다', () => {
  const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, '../../bin/gitbell.js'), ...args],
    { encoding: 'utf8', env: { ...process.env, GITBELL_LANG: 'en' } });
  assert.equal(run('--version').stdout.trim(), require('../../package.json').version);
  assert.match(run('help').stdout, /npx gitbell uninstall --purge/);
  assert.equal(run('nope').status, 1);
});
