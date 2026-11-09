// 상태와 설정을 JSON 파일로 저장한다. 위치: %APPDATA%\GitBell (Electron userData)
//   state.json    본 항목·최근 기록(지워도 처음부터 다시 채울 뿐이다)
//   settings.json 알림·목록·필터 설정
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 쓰다가 꺼져도 파일이 반쯤 남지 않게 임시 파일에 쓴 뒤 바꿔 넣는다. */
function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value));
  fs.renameSync(temp, file);
}

function createFileStore(dir) {
  const stateFile = path.join(dir, 'state.json');
  const settingsFile = path.join(dir, 'settings.json');
  return {
    loadState: () => readJSON(stateFile),
    saveState: (state) => writeJSON(stateFile, state),
    loadSettings: () => readJSON(settingsFile),
    saveSettings: (settings) => writeJSON(settingsFile, settings),
  };
}

/** --demo에서 쓰는, 아무것도 남기지 않는 저장소. */
function createMemoryStore() {
  return { loadState: () => null, saveState() {}, loadSettings: () => null, saveSettings() {} };
}

module.exports = { createFileStore, createMemoryStore, readJSON, writeJSON };
