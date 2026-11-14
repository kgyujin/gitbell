// GitHub 토큰을 찾는다. 순서: 1) 사용자가 앱에 넣어 저장한 토큰 2) GitHub CLI(gh) 로그인.
// 저장한 토큰은 Electron safeStorage로 암호화해 파일에 둔다. Windows에서는 DPAPI라 이 Windows 계정에서만 풀린다.
// 토큰 값은 화면·로그에 남기지 않는다.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

/** gh를 PATH에서 먼저 찾고, 없으면 설치 프로그램의 기본 위치에서 찾는다. */
function ghCandidates(env = process.env, platform = process.platform) {
  const candidates = ['gh'];
  if (platform === 'win32' && env.ProgramFiles) candidates.push(path.join(env.ProgramFiles, 'GitHub CLI', 'gh.exe'));
  if (platform === 'win32' && env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, 'Programs', 'GitHub CLI', 'gh.exe'));
  // Finder·로그인 항목으로 연 macOS 앱은 PATH에 Homebrew 폴더가 없다(Apple 실리콘, Intel 순).
  if (platform === 'darwin') candidates.push('/opt/homebrew/bin/gh', '/usr/local/bin/gh');
  return candidates;
}

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: 10000 }, (error, stdout) => {
      resolve(error ? null : String(stdout).trim());
    });
  });
}

async function readGitHubCLI(candidates = ghCandidates()) {
  for (const gh of candidates) {
    const token = await run(gh, ['auth', 'token']);
    if (token) return token;
  }
  return null;
}

/**
 * @param {{file: string, safeStorage: {isEncryptionAvailable(): boolean, encryptString(s: string): Buffer,
 *          decryptString(b: Buffer): string}, readCLI?: () => Promise<string|null>}} options
 */
function createTokenStore({ file, safeStorage, readCLI = readGitHubCLI }) {
  function readSaved() {
    try {
      return safeStorage.decryptString(fs.readFileSync(file)).trim() || null;
    } catch {
      return null;
    }
  }

  return {
    async resolve() {
      const saved = readSaved();
      if (saved) return { value: saved, source: 'saved' };
      const cli = await readCLI();
      if (cli) return { value: cli, source: 'githubCLI' };
      return null;
    },
    /** 암호화할 수 없으면 저장하지 않고 false를 돌려준다(토큰을 평문으로 남기지 않는다). */
    save(token) {
      if (!safeStorage.isEncryptionAvailable()) return false;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, safeStorage.encryptString(token));
        return true;
      } catch {
        return false;
      }
    },
    remove() {
      fs.rmSync(file, { force: true });
    },
  };
}

module.exports = { createTokenStore, readGitHubCLI, ghCandidates };
