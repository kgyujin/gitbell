// 화면이 보는 앱 상태. 주기적으로 GitHub을 확인하고, 상태를 저장하고, 알림을 보낸다.
// Electron에 기대지 않도록 저장·토큰·알림·시스템 기능은 밖에서 넣어 준다(테스트에서는 가짜를 넣는다).
'use strict';

const WatchState = require('./core/watch-state');
const Query = require('./core/activity-query');
const Prefs = require('./core/preferences');
const Poller = require('./core/poller');
const { categoryOf, repoName, EventKind } = require('./core/models');

/** 활동 종류 전체(검색용 화면 이름을 만들 때 쓴다). */
const KINDS = Object.values(EventKind);
const { isBot } = require('./core/event-builder');

const REFRESH_CHOICES = [1, 2, 5, 10, 15];
/** 여러 항목을 읽음으로 바꾼 뒤 '되돌리기'를 보이는 시간. */
const UNDO_MS = 8000;
/** 새 버전 확인 간격(분). 확인 주기(1·2·5·10·15분)로 나누어떨어져야 정확히 1시간마다 확인한다. */
const UPDATE_CHECK_MINUTES = 60;
/** 찾은 토큰을 다시 찾지 않고 쓰는 시간(currentToken). */
const TOKEN_REUSE_MS = 30 * 60 * 1000;
const URLS = Object.freeze({
  notifications: 'https://github.com/notifications',
  tokenCreation: 'https://github.com/settings/tokens/new?scopes=repo,notifications,read:org&description=GitBell',
  project: 'https://github.com/kgyujin/gitbell',
  releases: 'https://github.com/kgyujin/gitbell/releases/latest',
});

function defaultSettings() {
  return {
    refreshMinutes: 2,
    includeOwnActivity: false,
    showsCountInTray: true,
    notificationPrefs: Prefs.notificationPreferences(),
    display: Prefs.displayPreferences(),
    query: { category: null, repo: null, unreadOnly: false, mineOnly: false, sort: Query.SortMode.newest },
    /** 시스템 알림으로 이미 알린 새 버전. 같은 버전은 한 번만 알린다. */
    notifiedUpdate: null,
  };
}

/** 저장된 설정을 읽되, 없거나 모양이 다른 값은 기본값으로 채운다. */
function normalizeSettings(saved) {
  const value = saved && typeof saved === 'object' ? saved : {};
  const defaults = defaultSettings();
  const query = value.query && typeof value.query === 'object' ? value.query : {};
  const oneOf = (candidate, allowed, fallback) => (allowed.includes(candidate) ? candidate : fallback);
  return {
    refreshMinutes: oneOf(value.refreshMinutes, REFRESH_CHOICES, defaults.refreshMinutes),
    includeOwnActivity: value.includeOwnActivity === true,
    showsCountInTray: value.showsCountInTray !== false,
    notificationPrefs: Prefs.notificationPreferences(value.notificationPrefs),
    display: Prefs.displayPreferences(value.display),
    query: {
      category: oneOf(query.category, ['pullRequests', 'reviews', 'commits'], null),
      repo: typeof query.repo === 'string' ? query.repo : null,
      unreadOnly: query.unreadOnly === true,
      mineOnly: query.mineOnly === true,
      sort: oneOf(query.sort, Object.values(Query.SortMode), Query.SortMode.newest),
    },
    notifiedUpdate: typeof value.notifiedUpdate === 'string' ? value.notifiedUpdate : null,
  };
}

class AppModel {
  /**
   * @param {object} deps
   * @param {{loadState(): any, saveState(s): void, loadSettings(): any, saveSettings(s): void}} deps.store
   * @param {{resolve(): Promise<{value: string, source: 'saved'|'githubCLI'}|null>, save(t: string): boolean, remove(): void}} deps.tokens
   * @param {(token: string) => {get(path: string): Promise<any>}} deps.createAPI
   * @param {{post(events: object[], playsSound: boolean): void, postTest(playsSound: boolean): void,
   *   postUpdate(version: string, playsSound: boolean): void,
   *   dismiss?(ids: string[], includeSummaries: boolean): void}} deps.notifier
   * @param {{openURL(url: string): void, copyText(text: string): void, getLaunchAtLogin(): boolean,
   *          setLaunchAtLogin(on: boolean): void, openNotificationSettings(): void, quit(): void}} deps.system
   * @param {ReturnType<import('./l10n').createL10n>} deps.l10n
   * @param {string} deps.version
   * @param {() => Promise<string|null>} [deps.fetchLatestVersion]
   * @param {() => string} [deps.now]  ISO 시각
   * @param {() => boolean} [deps.isOnline]  인터넷에 연결돼 있는지. false면 확인을 건너뛴다.
   */
  constructor(deps) {
    this.deps = { now: () => new Date().toISOString(), fetchLatestVersion: async () => null, isOnline: () => true, ...deps };
    this.l10n = deps.l10n;
    this.listeners = new Set();
    this.state = WatchState.migrated(this.deps.store.loadState());
    this.settings = normalizeSettings(this.deps.store.loadSettings());
    this.search = '';
    this.isRefreshing = false;
    this.problem = null;
    this.tokenSource = null;
    this.availableUpdate = null;
    this.showingSettings = false;
    this.showingSearch = false;
    this.tokenSaveFailed = false;
    /** 방금 여러 항목을 읽음으로 바꾼 기록(되돌리기용). */
    this.readUndo = null;
    this.timer = null;
    this.demo = false;
    /** 확인 반복의 세대. 간격을 바꾸면 올라가고, 예전 반복은 다음 확인을 잡지 않고 끝난다. */
    this.loopGeneration = 0;
    /** 계정(토큰)의 세대. 새로고침 도중 토큰이 바뀌면 그 결과를 버린다. */
    this.accountGeneration = 0;
    this.refreshAgain = false;
    /** 기억해 둔 토큰 {token, foundAt}(currentToken). */
    this.cachedToken = null;
    /** 지난 확인에 쓴 토큰. 바뀌면 같은 계정인지 확인한다(refreshOnce). */
    this.lastTokenValue = null;
    /** 마지막으로 새 버전을 확인한 시각(ms). */
    this.lastUpdateCheck = 0;
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit() {
    for (const listener of this.listeners) listener();
  }

  // MARK: 시작·확인 주기

  start() {
    this.restartLoop();
  }

  stop() {
    this.loopGeneration += 1;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** GitHub에 요청하지 않고 가상 자료만 보여 준다. 저장도 하지 않는다. */
  loadDemo(state) {
    this.demo = true;
    this.state = state;
    this.tokenSource = 'githubCLI';
    this.settings = defaultSettings();
    this.emit();
  }

  restartLoop() {
    this.stop();
    if (this.demo) return;
    const generation = this.loopGeneration;
    const tick = async () => {
      this.timer = null;
      await this.refresh();
      // 새 버전은 첫 확인 때와 그 뒤 1시간마다 확인한다(GitHub Releases에 작은 요청 하나라 부담이 없다).
      // 마지막 확인 시각으로 재서, 간격을 바꾸거나 잠자기에서 깨어 반복을 새로 시작해도 1시간 주기가 흐트러지지 않는다.
      if (Date.parse(this.deps.now()) - this.lastUpdateCheck >= UPDATE_CHECK_MINUTES * 60 * 1000) {
        await this.checkForUpdate();
      }
      // 확인하는 동안 간격이 바뀌어 새 반복이 시작됐으면 이 반복은 여기서 끝난다.
      if (generation === this.loopGeneration) this.timer = setTimeout(tick, this.settings.refreshMinutes * 60 * 1000);
    };
    this.timer = setTimeout(tick, 0);
  }

  /**
   * @param {{readAll?: boolean}} options readAll: 사용자가 직접 누른 새로고침(Ctrl+R, 새로고침 단추, 다시 확인).
   *   조용한 저장소도 기다리지 않고 모두 읽는다.
   */
  async refresh({ readAll = false } = {}) {
    if (readAll) this.readAllNext = true;
    if (this.demo) return;
    if (this.isRefreshing) {
      // 토큰을 바꾼 직후처럼 꼭 다시 확인해야 할 때는 지금 확인이 끝난 뒤 한 번 더 한다.
      this.refreshAgain = true;
      return;
    }
    this.isRefreshing = true;
    this.emit();
    try {
      do {
        this.refreshAgain = false;
        await this.refreshOnce();
      } while (this.refreshAgain);
    } finally {
      this.isRefreshing = false;
      this.emit();
    }
  }

  /**
   * 확인할 때마다 토큰 파일을 풀고 gh를 실행하지 않도록 찾은 토큰을 잠시 기억한다.
   * 토큰을 저장·삭제하거나 401을 받으면 지우고, 30분이 지나도 다시 찾는다(gh로 다른 계정에 로그인했을 수 있다).
   */
  async currentToken() {
    const now = Date.parse(this.deps.now());
    if (this.cachedToken && now - this.cachedToken.foundAt < TOKEN_REUSE_MS) return this.cachedToken.token;
    const token = await this.deps.tokens.resolve();
    this.cachedToken = token ? { token, foundAt: now } : null;
    return token;
  }

  async refreshOnce() {
    const account = this.accountGeneration;
    // API 한도에 걸렸으면 풀리는 시각까지는 보내지 않는다(보내도 실패하고 2차 한도 위험만 커진다).
    if (this.problem && this.problem.type === 'rateLimited' && this.problem.resetAt
      && Date.parse(this.problem.resetAt) > Date.parse(this.deps.now())) return;
    // 연결이 없으면 요청을 보내지 않는다(어차피 실패하고 배터리만 쓴다). 다시 연결되면 networkOnline이 바로 확인한다.
    if (!this.deps.isOnline()) {
      this.problem = { type: 'network', detail: this.deps.l10n.t('You appear to be offline.') };
      return;
    }
    const usedCachedToken = this.cachedToken != null;
    try {
      const token = await this.currentToken();
      if (!token) {
        this.tokenSource = null;
        this.problem = { type: 'noToken' };
        return;
      }
      this.tokenSource = token.source;
      const api = this.deps.createAPI(token.value);
      // gh auth login으로 다른 계정에 로그인했으면(토큰이 바뀌었는데 401은 아님) 앞 계정의 기록을 이어 쓰면
      // 새 계정의 하루치가 모두 새 알림이 되고 내 활동도 거르지 못한다. 그래서 첫 실행처럼 다시 채운다.
      if (this.lastTokenValue && this.lastTokenValue !== token.value && this.state.me) {
        const login = await api.get('user').then((user) => user.login, () => null);
        if (login && login !== this.state.me) this.state = WatchState.createState();
      }
      this.lastTokenValue = token.value;
      const unreadBefore = new Set(this.state.history.filter((e) => e.isUnread).map((e) => e.id));
      const readAll = this.readAllNext === true;
      this.readAllNext = false;
      const result = await Poller.refresh(api, this.state,
        { now: this.deps.now(), includeOwn: this.settings.includeOwnActivity, readAll });
      // 확인하는 동안 토큰이 바뀌었으면 예전 계정의 결과라 버린다(곧 다시 확인한다).
      if (account !== this.accountGeneration) return;
      // 새로고침이 도는 동안 사용자가 바꾼 읽음 표시를 지킨다.
      this.state = WatchState.adoptingReadMarks(result.state, this.state);
      this.saveState();
      // 기록이 넘쳐 목록에서 빠진 안 읽은 항목의 알림은 알림 센터에서도 지운다(누를 곳이 없는 알림이 남지 않게).
      const kept = new Set(this.state.history.map((e) => e.id));
      const dropped = [...unreadBefore].filter((id) => !kept.has(id));
      if (dropped.length && this.deps.notifier.dismiss) this.deps.notifier.dismiss(dropped, false);
      if (result.failedRepos.length) this.problem = { type: 'partial', repos: result.failedRepos };
      else this.problem = result.notificationsUnavailable ? { type: 'limited' } : null;
      const toNotify = Prefs.eventsToNotify(result.newEvents, this.settings.notificationPrefs, this.settings.display, this.state.me);
      if (toNotify.length) this.deps.notifier.post(toNotify, this.settings.notificationPrefs.playsSound);
    } catch (error) {
      if (account !== this.accountGeneration) return;
      if (error && error.kind === 'unauthorized') {
        this.cachedToken = null;
        // 기억해 둔 토큰이 그사이 바뀌었을 수 있다(gh auth login을 다시 함). 새로 찾아 한 번 더 확인한다.
        if (usedCachedToken) this.refreshAgain = true;
        else this.problem = { type: 'unauthorized' };
      }
      else if (error && error.kind === 'rateLimited') {
        // GitHub의 한도 창은 1시간이다. 이 PC 시계가 틀려 다시 쓸 시각이 아주 멀어 보여도 1시간 넘게 쉬지 않는다.
        const limit = Date.parse(this.deps.now()) + 3600 * 1000;
        const resetAt = error.resetAt ? new Date(Math.min(Date.parse(error.resetAt), limit)).toISOString() : null;
        this.problem = { type: 'rateLimited', resetAt };
      }
      else if (error && error.kind === 'http') this.problem = { type: 'network', detail: `HTTP ${error.status} ${error.message}`.trim() };
      else this.problem = { type: 'network', detail: this.networkDetail(error) };
    }
  }

  /**
   * 네트워크 오류를 화면 언어로 풀어 쓴다. Node fetch는 'fetch failed'처럼 영어로만 알려 줘서,
   * 흔한 경우(시간 초과·연결 없음)는 번역한 문구로 바꾼다.
   */
  networkDetail(error) {
    const message = (error && error.message) || String(error);
    const l10n = this.deps.l10n;
    if (/abort|timeout|timed out/i.test(message)) return l10n.t('The request timed out.');
    if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH/i.test(message)) {
      return l10n.t('You appear to be offline.');
    }
    return message;
  }

  /** 인터넷이 다시 연결됐을 때. 연결 문제로 멈춰 있었으면 다음 주기를 기다리지 않고 바로 확인한다. */
  networkOnline() {
    if (this.problem && this.problem.type === 'network' && this.timer) this.restartLoop();
  }

  // MARK: 목록

  visibleHistory() {
    return Prefs.visible(this.settings.display, this.state.history);
  }

  effectiveQuery() {
    return { ...this.settings.query, search: this.search, me: this.state.me, kindLabels: this.kindLabels() };
  }

  /** 검색에 쓰는 화면 언어 종류 이름('머지', '승인'으로도 찾게 한다). */
  kindLabels() {
    if (!this.cachedKindLabels) {
      this.cachedKindLabels = Object.fromEntries(KINDS.map((kind) => [kind, this.l10n.kindLabel({ kind })]));
    }
    return this.cachedKindLabels;
  }

  get unreadCount() {
    return Prefs.visibleUnreadCount(this.state, this.settings.display);
  }

  setQuery(patch) {
    const allowed = ['category', 'repo', 'unreadOnly', 'mineOnly', 'sort', 'search'];
    for (const [key, value] of Object.entries(patch || {})) {
      if (!allowed.includes(key)) continue;
      if (key === 'search') this.search = String(value || '');
      else this.settings.query[key] = value;
    }
    this.settings = normalizeSettings(this.settings);
    // 검색어는 저장하지 않으므로, 글자를 칠 때마다 설정 파일을 다시 쓰지 않는다.
    if (Object.keys(patch || {}).some((key) => key !== 'search')) this.saveSettings();
    this.emit();
  }

  /** 검색어와 필터를 지운다. 정렬 방식은 사용자가 고른 대로 둔다. */
  resetFilters() {
    this.search = '';
    this.showingSearch = false;
    this.settings.query = { ...defaultSettings().query, sort: this.settings.query.sort };
    this.saveSettings();
    this.emit();
  }

  setShowingSearch(on) {
    this.showingSearch = Boolean(on);
    if (!this.showingSearch) this.search = '';
    this.emit();
  }

  setShowingSettings(on) {
    this.showingSettings = Boolean(on);
    this.emit();
  }

  findEvent(id) {
    return this.state.history.find((event) => event.id === id);
  }

  open(id) {
    const event = this.findEvent(id);
    if (!event) return;
    this.deps.system.openURL(event.url);
    this.markOpened(id);
  }

  /** 항목(또는 그 알림)을 열었을 때. 같은 PR·이슈의 다른 안 읽은 항목도 함께 읽음이 된다. */
  markOpened(id) {
    const before = this.unreadIds();
    WatchState.markThreadRead(this.state, id);
    this.saveState();
    this.emit();
    this.dismissRead(before);
  }

  /** 지금 안 읽은 항목 id. 읽음으로 바꾼 뒤 알림 센터에서 지울 항목을 가리는 데 쓴다. */
  unreadIds() {
    return new Set(this.state.history.filter((event) => event.isUnread).map((event) => event.id));
  }

  /**
   * GitBell에서 읽은 항목의 알림을 알림 센터에서도 지운다(이미 본 알림이 쌓이지 않게).
   * 보이는 안 읽은 항목이 하나도 없으면 여러 항목을 묶은 요약 알림까지 지운다.
   */
  dismissRead(before) {
    const after = this.unreadIds();
    const ids = [...before].filter((id) => !after.has(id));
    if (ids.length && this.deps.notifier.dismiss) this.deps.notifier.dismiss(ids, this.unreadCount === 0);
  }

  /** id가 없으면 지금 화면에 보이는 항목을 모두 읽음으로 바꾼다(필터·숨긴 저장소 반영, 되돌릴 수 있다). */
  markRead(id) {
    if (id == null) return this.markEventsRead(this.visibleFiltered());
    const before = this.unreadIds();
    WatchState.markRead(this.state, id);
    this.saveState();
    this.emit();
    this.dismissRead(before);
  }

  /** 저장소 하나의 보이는 항목을 읽음으로 바꾼다. */
  markRepoRead(repo) {
    this.markEventsRead(this.visibleFiltered().filter((event) => event.repo === repo));
  }

  /** 화면의 묶음 하나(날짜·저장소·안 읽음)를 읽음으로 바꾼다. */
  markSectionRead(sectionId) {
    const section = Query.sections(this.effectiveQuery(), this.visibleHistory())
      .find((candidate) => Query.sectionID(candidate.key) === sectionId);
    if (section) this.markEventsRead(section.events);
  }

  visibleFiltered() {
    return Query.filter(this.effectiveQuery(), this.visibleHistory());
  }

  /** 여러 항목을 읽음으로 바꾸고 잠시 '되돌리기'를 보인다. */
  markEventsRead(events) {
    const ids = events.filter((event) => event.isUnread).map((event) => event.id);
    if (ids.length === 0) return;
    const before = this.unreadIds();
    WatchState.markReadIds(this.state, ids);
    this.saveState();
    this.offerUndo(ids);
    this.emit();
    this.dismissRead(before);
  }

  /** 잘못 눌렀을 때 되돌릴 수 있게 방금 읽음으로 바꾼 항목을 잠시(undoMs) 남긴다. */
  offerUndo(ids) {
    // stamp: 같은 개수를 다시 읽음으로 바꿔도 새 되돌리기로 알아보게(화면 읽기 알림) 매번 다른 값을 둔다.
    this.undoStamp = (this.undoStamp || 0) + 1;
    const undo = { ids, stamp: this.undoStamp };
    this.readUndo = undo;
    const timer = setTimeout(() => {
      if (this.readUndo !== undo) return;
      this.readUndo = null;
      this.emit();
    }, this.deps.undoMs ?? UNDO_MS);
    // 테스트나 앱 종료를 이 타이머가 붙잡지 않게 한다.
    if (timer.unref) timer.unref();
  }

  undoMarkRead() {
    if (!this.readUndo) return;
    WatchState.markUnreadIds(this.state, this.readUndo.ids);
    this.readUndo = null;
    this.saveState();
    this.emit();
  }

  markUnread(id) {
    WatchState.markUnread(this.state, id);
    this.saveState();
    this.emit();
  }

  copyLink(id) {
    const event = this.findEvent(id);
    if (event) this.deps.system.copyText(event.url);
  }

  hideRepository(repo) {
    const hidden = new Set(this.settings.display.hiddenRepositories).add(repo);
    this.settings.display = Prefs.displayPreferences({ ...this.settings.display, hiddenRepositories: [...hidden] });
    if (this.settings.query.repo === repo) this.settings.query.repo = null;
    this.saveSettings();
    this.emit();
  }

  showRepository(repo) {
    const hidden = this.settings.display.hiddenRepositories.filter((name) => name !== repo);
    this.settings.display = Prefs.displayPreferences({ ...this.settings.display, hiddenRepositories: hidden });
    this.saveSettings();
    this.emit();
  }

  /** 정해 둔 주소만 연다. 화면에서 임의 주소를 넘기지 못하게 한다. */
  openLink(target) {
    if (URLS[target]) return this.deps.system.openURL(URLS[target]);
    const repo = typeof target === 'string' && target.startsWith('repo:') ? target.slice(5) : null;
    if (repo && this.state.history.some((event) => event.repo === repo)) {
      this.deps.system.openURL(`https://github.com/${repo}`);
    }
  }

  // MARK: 설정

  setNotificationPrefs(patch) {
    this.settings.notificationPrefs = Prefs.notificationPreferences({ ...this.settings.notificationPrefs, ...patch });
    this.saveSettings();
    this.emit();
  }

  setGroup(group, enabled) {
    const groups = new Set(this.settings.notificationPrefs.groups);
    if (enabled) groups.add(group);
    else groups.delete(group);
    this.setNotificationPrefs({ groups: [...groups] });
  }

  setDisplay(patch) {
    this.settings.display = Prefs.displayPreferences({ ...this.settings.display, ...patch });
    this.saveSettings();
    this.emit();
  }

  setRefreshMinutes(minutes) {
    if (!REFRESH_CHOICES.includes(minutes) || minutes === this.settings.refreshMinutes) return;
    this.settings.refreshMinutes = minutes;
    this.saveSettings();
    this.emit();
    if (this.timer) this.restartLoop();
  }

  setIncludeOwnActivity(on) {
    this.settings.includeOwnActivity = Boolean(on);
    this.saveSettings();
    this.emit();
  }

  setShowsCountInTray(on) {
    this.settings.showsCountInTray = Boolean(on);
    this.saveSettings();
    this.emit();
  }

  setLaunchAtLogin(on) {
    this.deps.system.setLaunchAtLogin(Boolean(on));
    this.emit();
  }

  sendTestNotification() {
    this.deps.notifier.postTest(this.settings.notificationPrefs.playsSound);
  }

  // MARK: 새 버전

  async checkForUpdate() {
    this.lastUpdateCheck = Date.parse(this.deps.now());
    try {
      const latest = await this.deps.fetchLatestVersion();
      this.availableUpdate = latest && Prefs.isNewerVersion(latest, this.deps.version) ? latest : null;
      this.notifyUpdate();
      this.emit();
    } catch {
      // 다음 확인 때 다시 본다.
    }
  }

  /**
   * 새 버전을 패널 띠뿐 아니라 시스템 알림으로도 바로 알린다. 패널을 열지 않는 사용자도 알 수 있게 한다.
   * 같은 버전은 한 번만 알린다(앱을 다시 켜도 다시 알리지 않는다). 알림을 꺼 둔 사용자에게는 띠만 보인다.
   */
  notifyUpdate() {
    const version = this.availableUpdate;
    const prefs = this.settings.notificationPrefs;
    if (!version || version === this.settings.notifiedUpdate || !prefs.isEnabled) return;
    this.deps.notifier.postUpdate(version, prefs.playsSound);
    // 실제로 알린 뒤에만 '알림'으로 기록한다. 알림을 꺼 둔 동안 나온 버전은 다시 켜면 다음 확인 때 알린다.
    this.settings.notifiedUpdate = version;
    this.saveSettings();
  }

  /** 새 버전 내려받기 페이지를 연다. */
  openUpdate() {
    this.deps.system.openURL(URLS.releases);
  }

  // MARK: 계정

  saveToken(token) {
    const trimmed = String(token || '').trim();
    if (!trimmed) return;
    this.tokenSaveFailed = !this.deps.tokens.save(trimmed);
    if (this.tokenSaveFailed) return this.emit();
    // 다른 계정일 수 있으니 기록을 비우고 첫 실행처럼 다시 채운다.
    this.accountGeneration += 1;
    this.cachedToken = null;
    this.lastTokenValue = null;
    // 앞 계정의 문제(한도 초과 등)가 새 계정의 첫 확인을 막지 않게 지운다.
    this.problem = null;
    this.state = WatchState.createState();
    this.saveState();
    this.emit();
    return this.refresh();
  }

  removeSavedToken() {
    this.deps.tokens.remove();
    this.accountGeneration += 1;
    this.cachedToken = null;
    this.lastTokenValue = null;
    this.problem = null;
    this.state = WatchState.createState();
    this.saveState();
    this.emit();
    return this.refresh();
  }

  // MARK: 저장

  saveState() {
    if (!this.demo) this.deps.store.saveState(this.state);
  }

  saveSettings() {
    if (!this.demo) this.deps.store.saveSettings(this.settings);
  }

  // MARK: 화면에 넘길 값

  /** 트레이 아이콘에 필요한 값. */
  trayState() {
    return {
      unread: this.unreadCount,
      showsCount: this.settings.showsCountInTray,
      hasProblem: this.problem != null && (this.problem.type === 'noToken' || this.problem.type === 'unauthorized'),
    };
  }

  problemMessage() {
    const { t, format } = this.l10n;
    switch (this.problem && this.problem.type) {
      case 'unauthorized': return t('Your GitHub token is invalid or expired. Update it in Settings.');
      case 'network': return `${t("Couldn't reach GitHub.")} ${this.problem.detail}`;
      case 'partial': return `${format("Couldn't read %lld repositories:", this.problem.repos.length)} ${this.problem.repos.map(repoName).join(', ')}`;
      case 'rateLimited': return this.problem.resetAt
        ? format("GitHub's API limit was reached. GitBell will check again after %@.", this.l10n.clock(this.problem.resetAt))
        : t("GitHub's API limit was reached. GitBell will check again later.");
      case 'limited': return t("This token can't read your GitHub notifications, so only repositories with recent pushes are checked. Use GitHub CLI or a classic token.");
      default: return null;
    }
  }

  /** 화면(renderer)이 그대로 그리는 값. 문구는 여기서 만들고, 상대 시간만 화면이 만든다. */
  viewModel() {
    const { l10n } = this;
    const query = this.effectiveQuery();
    const visible = this.visibleHistory();
    const filtered = Query.filter(query, visible);
    const groupedByRepo = query.sort === Query.SortMode.byRepository;
    const isExpired = this.tokenSource != null && this.problem != null && this.problem.type === 'unauthorized';
    const isConnected = this.tokenSource != null && !isExpired;
    const login = this.state.me ? ` · @${this.state.me}` : '';
    const accountText = isExpired
      ? l10n.t(this.tokenSource === 'githubCLI' ? 'The GitHub CLI login has expired.' : 'The saved token is invalid or expired.')
      : {
        githubCLI: l10n.t('Connected with GitHub CLI') + login,
        saved: l10n.t('Connected with a personal access token') + login,
      }[this.tokenSource] || l10n.t('Not connected');
    // 만료된 토큰을 설정에서 바로 바꿀 수 있게 한다. 저장한 토큰이 GitHub CLI보다 먼저 쓰이므로
    // CLI 로그인이 만료됐을 때도 새 토큰을 붙여넣으면 바로 이어진다.
    const accountHint = !isExpired ? ''
      : l10n.t(this.tokenSource === 'githubCLI' ? 'Run gh auth login again, or paste a new token below.' : 'Paste a new token below.');

    return {
      version: this.deps.version,
      demo: this.demo,
      unreadCount: this.unreadCount,
      visibleCount: filtered.length,
      visibleUnreadCount: filtered.filter((event) => event.isUnread).length,
      isRefreshing: this.isRefreshing,
      isFirstLoad: this.state.lastChecked == null,
      problemMessage: this.problemMessage(),
      showsOnboarding: (this.problem && this.problem.type === 'noToken')
        || (this.problem && this.problem.type === 'unauthorized' && this.state.history.length === 0) || false,
      showingSettings: this.showingSettings,
      showingSearch: this.showingSearch,
      query: { ...this.settings.query, search: this.search },
      isFiltering: Query.isFiltering(query),
      repositoryTitle: query.repo ? repoName(query.repo) : l10n.t('All repositories'),
      sortTitle: l10n.sortLabel(query.sort),
      sections: Query.sections(query, visible).map((section) => ({
        id: Query.sectionID(section.key),
        title: l10n.sectionTitle(section.key),
        repo: section.key.repo || null,
        /** 'day' | 'repository' | 'unread' | 'read'. 묶음 머리줄 아이콘을 고른다. */
        type: section.key.type,
        count: section.events.length,
        unreadCount: section.events.filter((event) => event.isUnread).length,
        events: section.events.map((event) => ({
          id: event.id,
          repo: event.repo,
          repoName: repoName(event.repo),
          showsRepository: !groupedByRepo,
          kind: event.kind,
          category: categoryOf(event.kind),
          time: event.time,
          target: l10n.target(event),
          title: l10n.title(event),
          kindLabel: l10n.kindLabel(event),
          actor: event.actor ? l10n.displayName(event.actor) : '',
          isBot: isBot(event.actor),
          avatar: event.actorAvatarURL,
          isUnread: event.isUnread,
        })),
      })),
      repositories: Query.repositorySummaries(visible),
      checkedText: this.state.lastChecked
        ? l10n.format('Checked %@ · %lld repositories', l10n.clock(this.state.lastChecked), this.state.checkedRepos.length)
        : l10n.t('Checking…'),
      availableUpdate: this.availableUpdate,
      account: {
        isConnected, text: accountText, hint: accountHint,
        canRemove: this.tokenSource === 'saved', needsToken: this.tokenSource == null || isExpired,
      },
      /** 문제 안내 옆에 '설정 열기'를 붙일지(토큰 문제는 설정에서 고친다). */
      problemOpensSettings: isExpired,
      tokenSaveFailed: this.tokenSaveFailed,
      readUndo: this.readUndo ? { text: l10n.format('Marked %lld items as read', this.readUndo.ids.length), stamp: this.readUndo.stamp } : null,
      settings: {
        refreshMinutes: this.settings.refreshMinutes,
        refreshChoices: REFRESH_CHOICES,
        includeOwnActivity: this.settings.includeOwnActivity,
        showsCountInTray: this.settings.showsCountInTray,
        notificationPrefs: this.settings.notificationPrefs,
        hidesBots: this.settings.display.hidesBots,
        hiddenRepositories: this.settings.display.hiddenRepositories,
        launchAtLogin: this.deps.system.getLaunchAtLogin(),
        groups: Prefs.ALL_GROUPS.map((group) => ({
          id: group,
          label: l10n.groupLabel(group),
          detail: l10n.groupDetail(group),
          enabled: this.settings.notificationPrefs.groups.includes(group),
        })),
      },
    };
  }
}

module.exports = { AppModel, defaultSettings, normalizeSettings, REFRESH_CHOICES, URLS };
