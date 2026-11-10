// Windows판 앱 쪽 검증: 앱 모델(AppModel), 문구, 토큰 보관, 패널 위치, 버전.
// Electron 없이 가짜 저장소·토큰·알림·시스템을 넣어 확인한다.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppModel, normalizeSettings, URLS } = require('../../src/app-model');
const { createL10n, parseStrings, loadKoreanStrings, prefersKorean } = require('../../src/l10n');
const { createTokenStore, ghCandidates } = require('../../src/token-store');
const { createFileStore } = require('../../src/file-store');
const { panelPosition } = require('../../src/window-position');
const { demoState } = require('../../src/demo-data');
const { GitHubError, createGitHubAPI } = require('../../src/core/github-api');
const { user } = require('./fixtures');

const ROOT = path.resolve(__dirname, '..', '..');

function harness({ token = { value: 'tok', source: 'saved' }, routes = {}, savedState = null, savedSettings = null } = {}) {
  const saved = { state: savedState, settings: savedSettings };
  const opened = [];
  const copied = [];
  const notified = [];
  let tokenValue = token;
  const model = new AppModel({
    store: {
      loadState: () => saved.state,
      saveState: (state) => { saved.state = JSON.parse(JSON.stringify(state)); },
      loadSettings: () => saved.settings,
      saveSettings: (settings) => { saved.settings = JSON.parse(JSON.stringify(settings)); },
    },
    tokens: {
      resolve: async () => tokenValue,
      save: (value) => { tokenValue = { value, source: 'saved' }; return true; },
      remove: () => { tokenValue = null; },
    },
    createAPI: () => ({
      async get(pathname) {
        const key = Object.keys(routes).find((prefix) => pathname.startsWith(prefix));
        if (!key) throw new GitHubError('http', 'Not Found', 404);
        const value = routes[key];
        if (value instanceof Error) throw value;
        return JSON.parse(JSON.stringify(value));
      },
    }),
    notifier: { post: (events, sound) => notified.push({ events, sound }), postTest: () => notified.push('test') },
    system: {
      openURL: (url) => opened.push(url),
      copyText: (text) => copied.push(text),
      getLaunchAtLogin: () => false,
      setLaunchAtLogin: () => {},
    },
    l10n: createL10n({ korean: false }),
    version: '0.4.0',
    now: () => '2026-11-09T06:00:00Z',
    fetchLatestVersion: async () => '0.5.0',
  });
  return { model, saved, opened, copied, notified };
}

const pushRoutes = (activity) => ({
  'user/repos': [{ full_name: 'org/repo', pushed_at: '2026-11-09T05:30:00Z', archived: false }],
  user: { login: 'me' },
  notifications: [],
  'repos/org/repo/pulls': [],
  'repos/org/repo/issues/comments': [],
  'repos/org/repo/activity': activity,
});
const push = (id, actor, timestamp = '2026-11-09T05:55:00Z') =>
  ({ id, activity_type: 'push', ref: 'refs/heads/main', before: '', after: `sha${id}`, actor: user(actor), timestamp });

test('AppModel: 토큰이 없으면 연결 안내를 보인다', async () => {
  const { model } = harness({ token: null });
  await model.refresh();
  const view = model.viewModel();
  assert.equal(view.showsOnboarding, true);
  assert.equal(view.account.text, 'Not connected');
  assert.deepEqual(model.trayState(), { unread: 0, showsCount: true, hasProblem: true });
});

test('AppModel: 첫 확인은 조용히, 다음 확인의 새 활동은 알림·안 읽음', async () => {
  const routes = pushRoutes([push(1, 'amy')]);
  const { model, saved, notified } = harness({ routes });
  await model.refresh();
  assert.equal(model.state.history.length, 1);
  assert.equal(notified.length, 0, '첫 확인은 알리지 않는다');
  assert.equal(saved.state.history.length, 1, '상태를 저장한다');

  routes['repos/org/repo/activity'] = [push(1, 'amy'), push(2, 'bob', '2026-11-09T05:59:00Z')];
  await model.refresh();
  assert.equal(notified.length, 1);
  assert.deepEqual(notified[0].events.map((e) => e.actor), ['bob']);
  assert.equal(model.viewModel().unreadCount, 1);
  assert.deepEqual(model.trayState(), { unread: 1, showsCount: true, hasProblem: false });
});

test('AppModel: 알림 설정과 숨긴 저장소를 지킨다', async () => {
  const routes = pushRoutes([push(1, 'amy')]);
  const { model, notified } = harness({ routes });
  await model.refresh();
  model.setGroup('commits', false);
  routes['repos/org/repo/activity'] = [push(1, 'amy'), push(2, 'bob')];
  await model.refresh();
  assert.equal(notified.length, 0, '커밋 알림을 껐다');
  assert.equal(model.unreadCount, 1, '목록에는 들어온다');
  model.hideRepository('org/repo');
  assert.equal(model.unreadCount, 0, '숨긴 저장소는 세지 않는다');
});

test('AppModel: 오류를 문제 문구로 바꾼다', async () => {
  const unauthorized = harness({ routes: { user: new GitHubError('unauthorized') } });
  await unauthorized.model.refresh();
  assert.equal(unauthorized.model.viewModel().problemMessage, 'Your GitHub token is invalid or expired. Update it in Settings.');
  assert.equal(unauthorized.model.viewModel().showsOnboarding, true, '기록이 없으면 연결 안내');

  const http = harness({ routes: { user: new GitHubError('http', 'API rate limit exceeded', 403) } });
  await http.model.refresh();
  assert.equal(http.model.viewModel().problemMessage, "Couldn't reach GitHub. HTTP 403 API rate limit exceeded");

  const partial = harness({ routes: { ...pushRoutes([]), 'user/repos': [
    { full_name: 'org/repo', pushed_at: '2026-11-09T05:30:00Z' }, { full_name: 'org/broken', pushed_at: '2026-11-09T05:30:00Z' }] } });
  await partial.model.refresh();
  assert.equal(partial.model.viewModel().problemMessage, "Couldn't read 1 repository: broken");
  assert.equal(partial.model.trayState().hasProblem, false, '일부 실패는 아이콘을 바꾸지 않는다');
});

test('AppModel: 데모 상태로 목록·필터·읽음 표시', () => {
  const { model, opened, copied } = harness();
  model.loadDemo(demoState(Date.parse('2026-11-09T12:00:00Z')));
  let view = model.viewModel();
  assert.equal(view.visibleCount, 9);
  assert.equal(view.unreadCount, 3);

  model.setQuery({ category: 'commits' });
  assert.deepEqual(model.viewModel().sections.flatMap((s) => s.events.map((e) => e.id)), ['3', '7']);
  model.markRead();
  assert.equal(model.unreadCount, 2, "'모두 읽음'은 보이는 항목에만");
  model.resetFilters();
  assert.equal(model.viewModel().isFiltering, false);

  model.setQuery({ sort: 'byRepository', search: 'web' });
  view = model.viewModel();
  assert.deepEqual(view.sections.map((s) => s.repo), ['acme/web']);
  assert.equal(view.sections[0].events[0].showsRepository, false, '저장소별로 묶으면 줄마다 저장소를 쓰지 않는다');
  model.resetFilters();
  assert.equal(model.viewModel().query.sort, 'byRepository', '초기화해도 정렬은 그대로');

  model.open('2');
  assert.deepEqual(opened, ['https://github.com/acme/api/pull/342']);
  assert.equal(model.findEvent('2').isUnread, false, '열면 읽음');
  model.markUnread('2');
  assert.equal(model.findEvent('2').isUnread, true);
  model.copyLink('2');
  model.copyUpdateCommand();
  assert.deepEqual(copied, ['https://github.com/acme/api/pull/342', 'npx gitbell@latest']);

  const bot = model.viewModel().sections.flatMap((s) => s.events).find((e) => e.id === '9');
  assert.equal(bot.actor, 'review-helper');
  assert.equal(bot.isBot, true);
  model.setDisplay({ hidesBots: true });
  assert.equal(model.viewModel().visibleCount, 8);
});

test('AppModel: 정해 둔 주소만 연다', () => {
  const { model, opened } = harness();
  model.loadDemo(demoState());
  model.openLink('notifications');
  model.openLink('repo:acme/web');
  model.openLink('repo:evil/unknown');
  model.openLink('https://evil.example');
  assert.deepEqual(opened, [URLS.notifications, 'https://github.com/acme/web']);
});

test('AppModel: 설정은 저장되고 다시 읽힌다', () => {
  const first = harness();
  first.model.setQuery({ category: 'reviews', unreadOnly: true, search: '검색어는 저장 안 함' });
  first.model.setRefreshMinutes(10);
  first.model.setRefreshMinutes(7);
  first.model.setNotificationPrefs({ playsSound: false });
  first.model.setShowsCountInTray(false);
  const second = harness({ savedSettings: first.saved.settings });
  const settings = second.model.settings;
  assert.equal(settings.query.category, 'reviews');
  assert.equal(settings.query.unreadOnly, true);
  assert.equal(second.model.search, '');
  assert.equal(settings.refreshMinutes, 10, '고를 수 없는 간격(7분)은 무시');
  assert.equal(settings.notificationPrefs.playsSound, false);
  assert.equal(settings.showsCountInTray, false);
  assert.deepEqual(normalizeSettings('garbage'), normalizeSettings({}), '망가진 파일은 기본값');
});

test('AppModel: 새 버전 알림과 토큰 바꾸기', async () => {
  const { model } = harness({ token: null });
  await model.checkForUpdate();
  assert.equal(model.viewModel().availableUpdate, '0.5.0');
  model.state.history = demoState().history;
  await model.saveToken('  new-token  ');
  assert.equal(model.tokenSource, 'saved');
  assert.equal(model.state.history.length, 0, '계정이 바뀔 수 있어 기록을 비운다');
});

// MARK: 문구

test('문구: macOS판과 Windows판 문구 파일을 읽는다', () => {
  const strings = loadKoreanStrings();
  assert.equal(strings.get('Mark as read'), '읽음 표시');
  assert.equal(strings.get('Search (Ctrl+F)'), '검색 (Ctrl+F)');
  assert.deepEqual([...parseStrings('/* c */\n"a \\"b\\"" = "값\\n둘";\n')], [['a "b"', '값\n둘']]);
});

test('문구: 화면과 주 프로세스가 쓰는 모든 키에 한국어가 있다', () => {
  const strings = loadKoreanStrings();
  const sources = ['src/renderer/panel.js', 'src/main.js', 'src/app-model.js', 'src/l10n.js']
    .map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n');
  const keys = new Set();
  for (const match of sources.matchAll(/\b(?:t|format)\(\s*(['"])((?:(?!\1)[^\\]|\\.)+)\1/g)) keys.add(match[2].replace(/\\(.)/g, '$1'));
  for (const match of sources.matchAll(/\b(?:t|format)\(\s*`([^`$]+)`/g)) keys.add(match[1]);
  // 객체로 고르는 문구(종류·정렬·묶음 이름)
  for (const match of fs.readFileSync(path.join(ROOT, 'src/l10n.js'), 'utf8').matchAll(/:\s*'([^']+)'/g)) keys.add(match[1]);
  for (const match of fs.readFileSync(path.join(ROOT, 'src/renderer/panel.js'), 'utf8').matchAll(/\['\w+', '\w+', '([^']+)'\]/g)) keys.add(match[1]);
  const ignore = new Set(['ko-KR', 'en-US', 'long', 'numeric', 'short', 'day', 'repository', 'unread', 'read', 'short']);
  // 'GitHub'은 고유명사라 macOS판에도 번역이 없다. 한글이 든 것은 주석 속 예시다.
  const missing = [...keys].filter((key) => !ignore.has(key) && key !== 'GitHub' && !/[가-힣]/.test(key)
    && !strings.has(key) && !/^[a-z]+$/.test(key));
  assert.deepEqual(missing, []);
  assert.ok(keys.size > 80, `찾은 키 ${keys.size}개`);
});

test('문구: 종류 이름·대상·알림 부제목', () => {
  const en = createL10n({ korean: false });
  const ko = createL10n({ korean: true });
  const event = { kind: 'push', branch: 'feat/x', commitCount: 3, actor: 'ci[bot]', title: '' };
  assert.equal(en.kindLabel(event), 'Pushed 3 commits');
  assert.equal(ko.kindLabel(event), '커밋 3개 push');
  assert.equal(en.headline(event), 'Pushed 3 commits · ⎇ feat/x · ci');
  assert.equal(ko.target({ kind: 'comment', number: 12, isIssue: true }), '이슈 #12');
  assert.equal(en.title(event), 'Pushed 3 commits', '본문이 없으면 종류 이름');
  assert.equal(ko.format('Checked %@ · %lld repositories', '9:00', 4), '9:00 확인 · 저장소 4개');
});

test('문구: 날짜 묶음 제목', () => {
  const now = new Date(2026, 10, 9, 15, 0).getTime();
  const l10n = createL10n({ korean: false, now: () => now });
  assert.equal(l10n.dayTitle(new Date(2026, 10, 9, 0, 0).toISOString()), 'Today');
  assert.equal(l10n.dayTitle(new Date(2026, 10, 8, 23, 0).toISOString()), 'Yesterday');
  assert.match(l10n.dayTitle(new Date(2026, 10, 5).toISOString()), /November 5/);
});

test('문구: 언어 고르기', () => {
  assert.equal(prefersKorean(['ko-KR', 'en-US'], ''), true);
  assert.equal(prefersKorean(['en-US', 'ko-KR'], ''), false, '첫 번째 언어를 따른다');
  assert.equal(prefersKorean(['en-US'], 'ko'), true, 'GITBELL_LANG이 먼저');
});

// MARK: 토큰·저장·위치

test('토큰: 암호화해 저장하고, 암호화할 수 없으면 저장하지 않는다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbell-token-'));
  const file = path.join(dir, 'token.bin');
  const fakeSafeStorage = (available) => ({
    isEncryptionAvailable: () => available,
    encryptString: (text) => Buffer.from(text).map((b) => b ^ 0x5a),
    decryptString: (buffer) => Buffer.from(buffer).map((b) => b ^ 0x5a).toString(),
  });
  const unavailable = createTokenStore({ file, safeStorage: fakeSafeStorage(false), readCLI: async () => null });
  assert.equal(unavailable.save('ghp_secret'), false);
  assert.equal(fs.existsSync(file), false);

  const store = createTokenStore({ file, safeStorage: fakeSafeStorage(true), readCLI: async () => 'cli-token' });
  assert.deepEqual(await store.resolve(), { value: 'cli-token', source: 'githubCLI' }, '저장한 토큰이 없으면 gh');
  assert.equal(store.save('ghp_secret'), true);
  assert.equal(fs.readFileSync(file).includes('ghp_secret'), false, '평문이 아니다');
  assert.deepEqual(await store.resolve(), { value: 'ghp_secret', source: 'saved' }, '저장한 토큰이 먼저');
  store.remove();
  assert.deepEqual(await store.resolve(), { value: 'cli-token', source: 'githubCLI' });
});

test('토큰: Windows에서는 gh를 PATH와 기본 설치 위치에서 찾는다', () => {
  const candidates = ghCandidates({ ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'win32');
  assert.equal(candidates[0], 'gh');
  assert.ok(candidates.some((c) => c.endsWith(path.join('GitHub CLI', 'gh.exe'))));
  assert.deepEqual(ghCandidates({}, 'linux'), ['gh']);
});

test('파일 저장: 상태와 설정을 JSON으로 남기고, 망가진 파일은 없는 것으로 본다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbell-store-'));
  const store = createFileStore(dir);
  assert.equal(store.loadState(), null);
  store.saveState({ version: 2, history: [] });
  assert.deepEqual(store.loadState(), { version: 2, history: [] });
  fs.writeFileSync(path.join(dir, 'settings.json'), '{broken');
  assert.equal(store.loadSettings(), null);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], '임시 파일이 남지 않는다');
});

test('GitHub API: 헤더·오류 처리', async () => {
  const calls = [];
  const fakeFetch = (status, body) => async (url, options) => {
    calls.push({ url: String(url), auth: options.headers.Authorization });
    return { status, text: async () => body };
  };
  const ok = createGitHubAPI({ token: 'abc', fetch: fakeFetch(200, '{"login":"me"}') });
  assert.deepEqual(await ok.get('user'), { login: 'me' });
  assert.deepEqual(calls[0], { url: 'https://api.github.com/user', auth: 'Bearer abc' });
  await assert.rejects(createGitHubAPI({ token: 'x', fetch: fakeFetch(401, '') }).get('user'), { kind: 'unauthorized' });
  await assert.rejects(createGitHubAPI({ token: 'x', fetch: fakeFetch(403, '{"message":"rate"}') }).get('user'),
    { kind: 'http', status: 403, message: 'rate' });
  await assert.rejects(createGitHubAPI({ token: 'x', fetch: async () => { throw new Error('offline'); } }).get('user'),
    { kind: 'network', message: 'offline' });
  const custom = createGitHubAPI({ token: 'x', baseURL: 'http://127.0.0.1:9', fetch: fakeFetch(200, '[]') });
  await custom.get('repos/a/b/activity?per_page=50');
  assert.equal(calls.at(-1).url, 'http://127.0.0.1:9/repos/a/b/activity?per_page=50');
});

test('패널 위치: 작업 표시줄 위치에 따라 트레이 옆에 둔다', () => {
  const size = { width: 420, height: 600 };
  const workArea = { x: 0, y: 0, width: 1920, height: 1032 };
  // 아래쪽 작업 표시줄(기본): 작업 표시줄 바로 위(여백 8), 화면 오른쪽 안으로
  assert.deepEqual(panelPosition({ trayBounds: { x: 1800, y: 1040, width: 24, height: 32 }, size, workArea }), { x: 1492, y: 424 });
  assert.deepEqual(panelPosition({ trayBounds: { x: 900, y: 1040, width: 24, height: 32 }, size, workArea }), { x: 702, y: 424 }, '가운데 아이콘');
  // 위쪽 작업 표시줄
  assert.deepEqual(panelPosition({ trayBounds: { x: 900, y: 0, width: 24, height: 32 }, size: { width: 420, height: 600 },
    workArea: { x: 0, y: 48, width: 1920, height: 1032 } }), { x: 702, y: 56 });
  // 왼쪽 작업 표시줄
  const left = panelPosition({ trayBounds: { x: 8, y: 900, width: 32, height: 24 }, size, workArea: { x: 48, y: 0, width: 1872, height: 1080 } });
  assert.equal(left.x, 56);
  assert.equal(left.y, 472);
  // 트레이 위치를 모르면 오른쪽 아래
  assert.deepEqual(panelPosition({ trayBounds: { x: 0, y: 0, width: 0, height: 0 }, size, workArea }), { x: 1492, y: 424 });
});

test('버전: Windows판과 npm 패키지 버전이 같다', () => {
  const root = require(path.join(ROOT, '..', 'package.json')).version;
  assert.equal(require(path.join(ROOT, 'package.json')).version, root);
});

// MARK: 리뷰에서 찾은 경합

const flush = async () => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

test('AppModel: 확인 중에 간격을 바꿔도 확인 반복이 둘로 늘지 않는다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolves = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { model } = harness();
  model.deps.tokens.resolve = async () => {
    resolves += 1;
    if (resolves === 1) await gate;
    return null;
  };
  model.start();
  t.mock.timers.tick(0);
  await flush();
  assert.equal(resolves, 1, '첫 확인이 토큰을 기다리는 중');
  model.setRefreshMinutes(5);
  t.mock.timers.tick(0);
  await flush();
  release();
  await flush();
  // 반복이 둘이면 같은 시각에 두 번씩 확인을 부른다(늦은 쪽은 '확인 중'이라 곧 끝나 토큰 조회로는 안 보인다).
  let ticks = 0;
  const refresh = model.refresh.bind(model);
  model.refresh = () => { ticks += 1; return refresh(); };
  for (let minute = 0; minute < 20; minute += 1) {
    t.mock.timers.tick(60 * 1000);
    await flush();
  }
  model.stop();
  assert.equal(ticks, 4, '20분 동안 5분 간격이면 4번');
});

test('AppModel: 확인 중에 토큰을 바꾸면 예전 계정 결과를 버리고 다시 확인한다', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const routes = pushRoutes([push(1, 'amy')]);
  const { model } = harness({ routes });
  const createAPI = model.deps.createAPI;
  const logins = [];
  model.deps.createAPI = (token) => {
    const api = createAPI(token);
    return { async get(p) {
      if (p === 'user') { logins.push(token); if (token === 'tok') await gate; return { login: token === 'tok' ? 'old' : 'new' }; }
      return api.get(p);
    } };
  };
  const first = model.refresh();
  await flush();
  const saving = model.saveToken('new-token');
  release();
  await Promise.all([first, saving]);
  await flush();
  assert.deepEqual(logins, ['tok', 'new-token'], '토큰을 바꾼 뒤 새 토큰으로 다시 확인');
  assert.equal(model.state.me, 'new', '예전 계정 결과가 남지 않는다');
});

test('파일 저장: 바꿔 넣기가 막히면(Windows 잠금) 직접 쓴다', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbell-lock-'));
  const store = createFileStore(dir);
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); });
  store.saveSettings({ refreshMinutes: 5 });
  assert.deepEqual(store.loadSettings(), { refreshMinutes: 5 });
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
});

// MARK: 설치된 앱 목록에서 제거

test('제거: 설치 위치와 설치된 앱 목록 항목', () => {
  const Uninstall = require('../../src/uninstall');
  const env = { LOCALAPPDATA: 'C:\\Users\\John Smith\\AppData\\Local', APPDATA: 'C:\\Users\\John Smith\\AppData\\Roaming' };
  const paths = Uninstall.installPaths(env);
  assert.equal(paths.installDir, 'C:\\Users\\John Smith\\AppData\\Local\\Programs\\GitBell');
  assert.equal(paths.appDir, `${paths.installDir}\\windows`);
  assert.equal(paths.shortcut, 'C:\\Users\\John Smith\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\GitBell.lnk');
  assert.equal(Uninstall.isStandardInstall(paths.appDir, env), true);
  assert.equal(Uninstall.isStandardInstall(paths.appDir.toUpperCase(), env), true, '대소문자는 가리지 않는다');
  assert.equal(Uninstall.isStandardInstall(ROOT, env), false, '개발 중인 소스 폴더는 지우지 않는다');

  const exe = path.win32.join(paths.appDir, 'node_modules', 'electron', 'dist', 'electron.exe');
  const entries = Object.fromEntries(Uninstall.uninstallEntries({ exe, version: '0.5.0', env, sizeKB: 123 }).map(([name, , data]) => [name, data]));
  assert.equal(entries.DisplayName, 'GitBell');
  assert.equal(entries.DisplayVersion, '0.5.0');
  assert.equal(entries.UninstallString, `"${exe}" "${paths.appDir}" --uninstall-app`, '빈칸이 있는 경로도 따옴표로 감싼다');
  assert.equal(entries.QuietUninstallString, `${entries.UninstallString} --quiet`);
  assert.equal(entries.EstimatedSize, '123');
});

test('제거: 앱이 끝난 뒤 폴더를 지우는 cmd 명령', () => {
  const { removalCommand } = require('../../src/uninstall');
  const command = removalCommand(['C:\\A B\\GitBell', 'C:\\Data\\GitBell']);
  assert.match(command, /^\/d \/s \/c "for \/l %i in \(1,1,30\) do \(/);
  assert.ok(command.includes('rd /s /q "C:\\A B\\GitBell" 2>nul & rd /s /q "C:\\Data\\GitBell" 2>nul'));
  assert.ok(command.includes('if not exist "C:\\A B\\GitBell" if not exist "C:\\Data\\GitBell" exit /b 0'));
  assert.ok(!command.includes('timeout'), '숨은 창에서는 timeout이 동작하지 않는다');
});

test('제거: 폴더 크기(KB)', () => {
  const { folderSizeKB } = require('../../src/uninstall');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbell-size-'));
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'a'), Buffer.alloc(1024));
  fs.writeFileSync(path.join(dir, 'sub', 'b'), Buffer.alloc(1500));
  assert.equal(folderSizeKB(dir), 3);
});
