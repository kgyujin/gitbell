// 앱 쪽 검증: 앱 모델(AppModel), 문구, 토큰 보관, 패널 위치.
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
const { GitHubError, createGitHubAPI, createResponseCache } = require('../../src/core/github-api');
const { user } = require('./fixtures');

const ROOT = path.resolve(__dirname, '..', '..');

function harness({ token = { value: 'tok', source: 'saved' }, routes = {}, savedState = null, savedSettings = null, undoMs,
  latestVersion = '0.5.0', isOnline = () => true } = {}) {
  const requested = [];
  const patched = [];
  let patchFails = false;
  const saved = { state: savedState, settings: savedSettings };
  const opened = [];
  const copied = [];
  const notified = [];
  const dismissed = [];
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
      async patch(pathname) {
        if (patchFails) throw new GitHubError('http', 'Forbidden', 403);
        patched.push(pathname);
      },
      async get(pathname) {
        requested.push(pathname);
        const key = Object.keys(routes).find((prefix) => pathname.startsWith(prefix));
        if (!key) throw new GitHubError('http', 'Not Found', 404);
        const value = routes[key];
        if (value instanceof Error) throw value;
        // 실제 GitHub처럼 저장소의 pushed_at은 그 저장소 활동 중 가장 최근 push 시각을 따른다
        // (GitBell은 이 값으로 바뀐 저장소를 알아본다).
        if (key === 'user/repos') {
          return value.map((repo) => {
            const activity = routes[`repos/${repo.full_name}/activity`] || [];
            const latest = activity.map((item) => item.timestamp).filter(Boolean).sort().at(-1);
            return latest && (!repo.pushed_at || latest > repo.pushed_at) ? { ...repo, pushed_at: latest } : { ...repo };
          });
        }
        return JSON.parse(JSON.stringify(value));
      },
    }),
    notifier: {
      post: (events, sound) => notified.push({ events, sound }),
      postTest: () => notified.push('test'),
      postUpdate: (version, sound) => notified.push({ update: version, sound }),
      dismiss: (ids, includeSummaries) => dismissed.push({ ids, includeSummaries }),
    },
    system: {
      openURL: (url) => opened.push(url),
      copyText: (text) => copied.push(text),
      getLaunchAtLogin: () => false,
      setLaunchAtLogin: () => {},
    },
    l10n: createL10n({ korean: false }),
    version: '0.4.0',
    now: () => '2026-11-09T06:00:00Z',
    fetchLatestVersion: async () => (typeof latestVersion === 'function' ? latestVersion() : latestVersion),
    undoMs,
    isOnline,
  });
  return { model, saved, opened, copied, notified, dismissed, requested, patched, failPatches: (on) => { patchFails = on; } };
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
  assert.deepEqual(copied, ['https://github.com/acme/api/pull/342']);
  model.openUpdate();
  assert.equal(opened.at(-1), 'https://github.com/kgyujin/gitbell/releases/latest', '새 버전 띠는 내려받기 페이지를 연다');

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

test('AppModel: 새 버전은 시스템 알림으로 한 번만 알린다', async () => {
  let latest = '0.5.0';
  const { model, notified, saved } = harness({ latestVersion: () => latest });
  await model.checkForUpdate();
  assert.deepEqual(notified, [{ update: '0.5.0', sound: true }]);
  assert.equal(saved.settings.notifiedUpdate, '0.5.0', '알린 버전을 저장한다');

  await model.checkForUpdate();
  assert.equal(notified.length, 1, '같은 버전은 다시 알리지 않는다');

  // 앱을 다시 켜도(저장한 설정을 읽어도) 같은 버전은 다시 알리지 않는다.
  const again = harness({ latestVersion: '0.5.0', savedSettings: saved.settings });
  await again.model.checkForUpdate();
  assert.equal(again.notified.length, 0);

  latest = '0.6.0';
  await model.checkForUpdate();
  assert.deepEqual(notified.at(-1), { update: '0.6.0', sound: true }, '더 새 버전은 또 알린다');

  // 지금 버전과 같으면 알리지 않는다.
  const current = harness({ latestVersion: '0.4.0' });
  await current.model.checkForUpdate();
  assert.equal(current.notified.length, 0);
  assert.equal(current.model.viewModel().availableUpdate, null);
});

test('AppModel: 알림을 꺼 두면 새 버전은 띠로만 알린다', async () => {
  const { model, notified, saved } = harness({
    savedSettings: { notificationPrefs: { isEnabled: false } },
  });
  await model.checkForUpdate();
  assert.equal(notified.length, 0);
  assert.equal(model.viewModel().availableUpdate, '0.5.0');
  assert.equal(saved.settings.notifiedUpdate ?? null, null, '알리지 않았으니 알린 것으로 기록하지 않는다');
  // 알림을 다시 켜면 다음 확인 때 그 버전을 알린다.
  model.setNotificationPrefs({ isEnabled: true });
  await model.checkForUpdate();
  assert.deepEqual(notified, [{ update: '0.5.0', sound: true }]);
  assert.equal(normalizeSettings({ notifiedUpdate: 3 }).notifiedUpdate, null, '망가진 값은 버린다');
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

test('문구: 한국어 문구 파일을 읽는다', () => {
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
  // 'GitHub'은 고유명사라 번역하지 않는다. 한글이 든 것은 주석 속 예시다.
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

test('AppModel: 토큰이 만료되면 설정에서 바로 새 토큰을 넣을 수 있다', async () => {
  for (const [source, text, hint] of [
    ['saved', 'The saved token is invalid or expired.', 'Paste a new token below.'],
    ['githubCLI', 'The GitHub CLI login has expired.', 'Run gh auth login again, or paste a new token below.'],
  ]) {
    const routes = pushRoutes([push(1, 'amy')]);
    const { model } = harness({ token: { value: 'tok', source }, routes });
    await model.refresh();
    const connected = model.viewModel();
    assert.equal(connected.account.isConnected, true);
    assert.equal(connected.account.hint, '');
    assert.equal(connected.account.needsToken, false, '연결된 동안에는 입력칸이 없다');
    assert.equal(connected.problemOpensSettings, false);

    routes['user/repos'] = new GitHubError('unauthorized');
    await model.refresh();
    const view = model.viewModel();
    assert.equal(view.showsOnboarding, false, '기록이 있으면 목록을 그대로 보인다');
    assert.equal(view.account.isConnected, false);
    assert.equal(view.account.text, text, source);
    assert.equal(view.account.hint, hint, source);
    assert.equal(view.account.needsToken, true, '만료되면 새 토큰 입력칸을 보인다');
    assert.equal(view.problemOpensSettings, true, '문제 안내에서 설정으로 바로 간다');
  }
});

test('AppModel: 읽음으로 바꾼 항목의 알림을 알림 센터에서 지운다', async () => {
  const routes = pushRoutes([push(1, 'amy')]);
  const { model, dismissed } = harness({ routes });
  await model.refresh();
  routes['repos/org/repo/activity'] = [push(1, 'amy'), push(2, 'bob'), push(3, 'cid')];
  await model.refresh();
  assert.equal(model.unreadCount, 2);
  const [first, second] = model.state.history.filter((event) => event.isUnread).map((event) => event.id);

  model.markRead(first);
  assert.deepEqual(dismissed, [{ ids: [first], includeSummaries: false }], '아직 안 읽은 항목이 있으면 요약 알림은 남긴다');
  model.markRead(first);
  assert.equal(dismissed.length, 1, '이미 읽은 항목은 다시 지우지 않는다');
  model.markRepoRead('org/repo');
  assert.deepEqual(dismissed[1], { ids: [second], includeSummaries: true }, '모두 읽으면 요약 알림도 지운다');
});

test('AppModel: 묶음 하나를 읽음으로 바꾸고 되돌린다', async () => {
  const routes = pushRoutes([push(1, 'amy')]);
  const { model } = harness({ routes });
  await model.refresh();
  routes['repos/org/repo/activity'] = [push(1, 'amy'), push(2, 'bob'), push(3, 'cid')];
  await model.refresh();
  assert.equal(model.unreadCount, 2);
  assert.equal(model.viewModel().readUndo, null);

  const today = model.viewModel().sections[0];
  model.markSectionRead(today.id);
  assert.equal(model.unreadCount, 0);
  assert.equal(model.viewModel().readUndo.text, 'Marked 2 items as read');

  model.undoMarkRead();
  assert.equal(model.unreadCount, 2, '되돌리면 다시 안 읽음');
  assert.equal(model.viewModel().readUndo, null);

  model.markRead(model.state.history.find((event) => event.isUnread).id);
  assert.equal(model.viewModel().readUndo, null, '한 항목만 읽음으로 바꾸면 되돌리기를 띄우지 않는다');
});

test('AppModel: 되돌리기는 잠시 뒤 사라진다', async () => {
  const routes = pushRoutes([push(1, 'amy')]);
  const { model } = harness({ routes, undoMs: 20 });
  await model.refresh();
  routes['repos/org/repo/activity'] = [push(1, 'amy'), push(2, 'bob')];
  await model.refresh();
  model.markRead();
  assert.notEqual(model.viewModel().readUndo, null);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(model.viewModel().readUndo, null);
});

test('GitHub API: 바뀐 것이 없으면(304) 보관한 응답을 다시 쓴다', async () => {
  const sent = [];
  const replies = [
    { status: 200, etag: '"v1"', body: '{"login":"me"}' },
    { status: 304, etag: '"v1"', body: '' },
  ];
  const fetch = async (_url, { headers }) => {
    sent.push(headers['If-None-Match'] || null);
    const reply = replies.shift();
    return { status: reply.status, text: async () => reply.body, headers: new Map([['etag', reply.etag]]) };
  };
  const cache = createResponseCache();
  const api = createGitHubAPI({ token: 'tok', fetch, cache });
  assert.deepEqual(await api.get('user'), { login: 'me' });
  assert.deepEqual(await api.get('user'), { login: 'me' }, '304면 보관한 본문을 쓴다');
  assert.deepEqual(sent, [null, '"v1"'], '두 번째에는 받은 ETag를 보낸다');

  // push마다 한 번 읽는 큰 응답(커밋 한 개)은 보관하지 않는다.
  replies.push({ status: 200, etag: '"c"', body: '{}' }, { status: 200, etag: '"c"', body: '{}' });
  await api.get('repos/o/r/commits/abc');
  await api.get('repos/o/r/commits/abc');
  assert.deepEqual(sent.slice(2), [null, null]);

  // 다른 계정(토큰)이면 앞 계정의 응답을 쓰지 않는다.
  assert.equal(cache.size, 1);
  replies.push({ status: 200, etag: '"o"', body: '{"login":"other"}' });
  await createGitHubAPI({ token: 'other', fetch, cache }).get('user');
  assert.equal(sent.at(-1), null, '다른 계정으로는 앞 계정의 ETag를 보내지 않는다');
  // 토큰이 바뀌기 전에 시작한 확인의 응답은 넣지 않는다.
  cache.set('late', { etag: 'e', text: '{}' }, 'tok');
  assert.equal(cache.get('late', 'other'), null);
});

test('GitHub API 응답 보관소: 가득 차면 가장 오래 안 쓴 것부터 버린다', () => {
  const cache = createResponseCache({ limit: 2 });
  cache.use('a');
  cache.set('1', { etag: 'e', text: '1' });
  cache.set('2', { etag: 'e', text: '2' });
  cache.get('1');
  cache.set('3', { etag: 'e', text: '3' });
  assert.deepEqual([cache.get('1') != null, cache.get('2') != null, cache.get('3') != null], [true, false, true]);

  const small = createResponseCache({ byteLimit: 10 });
  small.use('a');
  small.set('1', { etag: 'e', text: '123456' });
  small.set('2', { etag: 'e', text: '123456' });
  assert.deepEqual([small.get('1') != null, small.get('2') != null], [false, true], '본문 크기 합이 넘치면 오래된 것부터 버린다');
});

test('AppModel: 찾은 토큰을 기억해 확인할 때마다 다시 찾지 않는다', async () => {
  const { model } = harness({ routes: pushRoutes([]) });
  let lookups = 0;
  const resolve = model.deps.tokens.resolve;
  model.deps.tokens.resolve = async () => { lookups += 1; return resolve(); };
  await model.refresh();
  await model.refresh();
  assert.equal(lookups, 1, '키체인·gh를 매번 읽지 않는다');
  // 토큰을 바꾸면 다시 찾는다.
  await model.saveToken('new-token');
  assert.equal(lookups, 2);
});

test('AppModel: 기억한 토큰이 401이면 새로 찾아 한 번 더 확인한다', async () => {
  const routes = pushRoutes([]);
  const { model } = harness({ routes });
  await model.refresh();
  // gh auth login으로 토큰이 바뀐 상황: 예전 토큰은 401, 새로 찾으면 정상.
  let attempts = 0;
  const createAPI = model.deps.createAPI;
  model.deps.createAPI = (token) => {
    attempts += 1;
    return attempts === 1 ? { get: async () => { throw new GitHubError('unauthorized', '', 401); } } : createAPI(token);
  };
  await model.refresh();
  assert.equal(attempts, 2, '새 토큰으로 바로 다시 확인한다');
  assert.equal(model.problem, null, '잠깐의 401로 오류를 보이지 않는다');
});

test('AppModel: 한도가 풀리기 전에는 GitHub에 보내지 않는다', async () => {
  const { model } = harness({ routes: pushRoutes([]) });
  model.problem = { type: 'rateLimited', resetAt: '2026-11-09T07:00:00Z' };
  let calls = 0;
  model.deps.createAPI = () => ({ get: async () => { calls += 1; return []; } });
  await model.refresh();
  assert.equal(calls, 0);
});

test('AppModel: 토큰을 바꾸면 앞 계정의 한도 초과가 새 계정의 확인을 막지 않는다', async () => {
  const { model } = harness({ routes: pushRoutes([]) });
  model.problem = { type: 'rateLimited', resetAt: '2026-11-09T07:00:00Z' };
  let calls = 0;
  const createAPI = model.deps.createAPI;
  model.deps.createAPI = (token) => { calls += 1; return createAPI(token); };
  await model.saveToken('other-account');
  assert.equal(calls, 1, '새 계정으로 바로 확인한다');
  assert.equal(model.problem, null);
});

test('AppModel: 검색어를 칠 때는 설정 파일을 다시 쓰지 않는다', () => {
  const { model, saved } = harness();
  model.setQuery({ unreadOnly: true });
  const before = JSON.stringify(saved.settings);
  saved.settings = null;
  model.setQuery({ search: 'abc' });
  assert.equal(saved.settings, null, '검색어만 바뀌면 저장하지 않는다');
  assert.ok(before.includes('"unreadOnly":true'));
});

// MARK: 오프라인

test('AppModel: 오프라인이면 요청하지 않고, 다시 연결되면 바로 확인한다', async () => {
  let online = false;
  const { model, requested } = harness({ routes: pushRoutes([push(1, 'amy')]), isOnline: () => online });
  await model.refresh();
  assert.deepEqual(requested, [], '연결이 없으면 GitHub에 보내지 않는다');
  assert.equal(model.problem.type, 'network');
  assert.equal(model.viewModel().problemMessage, "Couldn't reach GitHub. You appear to be offline.");

  model.timer = setTimeout(() => {}, 60000);
  let restarted = 0;
  model.restartLoop = () => { restarted += 1; clearTimeout(model.timer); };
  online = true;
  model.networkOnline();
  assert.equal(restarted, 1, '연결 문제로 멈춰 있었으면 주기를 새로 시작한다(바로 확인)');

  await model.refresh();
  assert.ok(requested.length > 0);
  assert.equal(model.problem, null);
  model.timer = setTimeout(() => {}, 60000);
  model.networkOnline();
  clearTimeout(model.timer);
  assert.equal(restarted, 1, '문제가 없으면 다시 시작하지 않는다(확인이 겹치지 않게)');
});

// MARK: GitHub 읽음 동기화

test('AppModel: GitHub에서 읽은 PR의 활동은 읽음이 되고, GitBell에서 읽으면 GitHub 알림도 읽음이 된다', async () => {
  const comment = (id, number, createdAt) => ({ id, issue_url: `https://api.github.com/repos/org/repo/issues/${number}`,
    html_url: `https://github.com/org/repo/pull/${number}#c${id}`, user: user('amy'), body: `댓글 ${id}`, created_at: createdAt });
  const notification = (id, number, extra) => ({ id, repository: { full_name: 'org/repo' }, updated_at: '2026-11-09T05:55:00Z',
    subject: { type: 'PullRequest', url: `https://api.github.com/repos/org/repo/pulls/${number}` }, unread: true, last_read_at: null, ...extra });
  const routes = { ...pushRoutes([]), 'repos/org/repo/issues/comments': [], notifications: [] };
  const { model, patched, dismissed, notified, failPatches } = harness({ routes });
  await model.refresh();

  routes['repos/org/repo/issues/comments'] = [comment(1, 5, '2026-11-09T05:50:00Z'), comment(2, 6, '2026-11-09T05:55:00Z')];
  // #5는 GitHub에서 이미 읽었다(댓글보다 뒤에 읽음).
  routes.notifications = [
    notification('500', 5, { unread: false, last_read_at: '2026-11-09T05:58:00Z' }),
    notification('600', 6),
  ];
  await model.refresh();
  const unread = () => model.state.history.filter((e) => e.isUnread).map((e) => e.id);
  assert.deepEqual(unread(), ['org/repo#ic:2'], 'GitHub에서 읽은 #5의 댓글은 읽음');
  assert.deepEqual(notified[0].events.map((e) => e.id), ['org/repo#ic:2'], 'GitHub에서 이미 읽은 활동은 알리지 않는다');

  failPatches(true);
  model.markRead('org/repo#ic:2');
  await model.pendingSync;
  assert.equal(model.state.threads['org/repo#6'].unread, true, 'GitHub에 쓰지 못하면 GitHub 쪽은 안 읽음 그대로');

  model.markUnread('org/repo#ic:2');
  failPatches(false);
  model.markRead('org/repo#ic:2');
  await model.pendingSync;
  assert.deepEqual(patched, ['notifications/threads/600'], 'GitBell에서 읽으면 GitHub 알림 스레드도 읽음으로');
  assert.equal(model.state.threads['org/repo#6'].unread, false);
  assert.ok(dismissed.some((d) => d.ids.includes('org/repo#ic:2')));

  // 다음 확인에서 GitHub이 돌려준 읽은 시각은 이미 반영한 것이라, 다시 안 읽음으로 바꾼 항목을 덮어쓰지 않는다.
  model.markUnread('org/repo#ic:2');
  routes.notifications = [notification('600', 6, { unread: false, last_read_at: model.state.threads['org/repo#6'].lastReadAt })];
  await model.refresh();
  assert.deepEqual(unread(), ['org/repo#ic:2']);
});
