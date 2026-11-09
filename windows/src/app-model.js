// 화면이 보는 앱 상태(macOS판 AppModel.swift에 해당). 주기적으로 GitHub을 확인하고, 상태를 저장하고, 알림을 보낸다.
// Electron에 기대지 않도록 저장·토큰·알림·시스템 기능은 밖에서 넣어 준다(테스트에서는 가짜를 넣는다).
'use strict';

const WatchState = require('./core/watch-state');
const Query = require('./core/activity-query');
const Prefs = require('./core/preferences');
const Poller = require('./core/poller');
const { categoryOf, repoName } = require('./core/models');
const { isBot } = require('./core/event-builder');

const REFRESH_CHOICES = [1, 2, 5, 10, 15];
const UPDATE_COMMAND = 'npx gitbell@latest';
const URLS = Object.freeze({
  notifications: 'https://github.com/notifications',
  tokenCreation: 'https://github.com/settings/tokens/new?scopes=repo,notifications,read:org&description=GitBell',
  project: 'https://github.com/kgyujin/gitbell',
});

function defaultSettings() {
  return {
    refreshMinutes: 2,
    includeOwnActivity: false,
    showsCountInTray: true,
    notificationPrefs: Prefs.notificationPreferences(),
    display: Prefs.displayPreferences(),
    query: { category: null, repo: null, unreadOnly: false, mineOnly: false, sort: Query.SortMode.newest },
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
  };
}

class AppModel {
  /**
   * @param {object} deps
   * @param {{loadState(): any, saveState(s): void, loadSettings(): any, saveSettings(s): void}} deps.store
   * @param {{resolve(): Promise<{value: string, source: 'saved'|'githubCLI'}|null>, save(t: string): boolean, remove(): void}} deps.tokens
   * @param {(token: string) => {get(path: string): Promise<any>}} deps.createAPI
   * @param {{post(events: object[], playsSound: boolean): void, postTest(playsSound: boolean): void}} deps.notifier
   * @param {{openURL(url: string): void, copyText(text: string): void, getLaunchAtLogin(): boolean,
   *          setLaunchAtLogin(on: boolean): void, openNotificationSettings(): void, quit(): void}} deps.system
   * @param {ReturnType<import('./l10n').createL10n>} deps.l10n
   * @param {string} deps.version
   * @param {() => Promise<string|null>} [deps.fetchLatestVersion]
   * @param {() => string} [deps.now]  ISO 시각
   */
  constructor(deps) {
    this.deps = { now: () => new Date().toISOString(), fetchLatestVersion: async () => null, ...deps };
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
    this.timer = null;
    this.checks = 0;
    this.demo = false;
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
    const tick = async () => {
      await this.refresh();
      this.checks += 1;
      // 새 버전 확인은 하루에 몇 번이면 충분하다(12시간마다, 첫 확인 때 한 번).
      if (this.checks === 1 || this.checks % Math.max(1, Math.floor(720 / this.settings.refreshMinutes)) === 0) {
        await this.checkForUpdate();
      }
      this.timer = setTimeout(tick, this.settings.refreshMinutes * 60 * 1000);
    };
    this.timer = setTimeout(tick, 0);
  }

  async refresh() {
    if (this.isRefreshing || this.demo) return;
    this.isRefreshing = true;
    this.emit();
    try {
      const token = await this.deps.tokens.resolve();
      if (!token) {
        this.tokenSource = null;
        this.problem = { type: 'noToken' };
        return;
      }
      this.tokenSource = token.source;
      const result = await Poller.refresh(this.deps.createAPI(token.value), this.state,
        { now: this.deps.now(), includeOwn: this.settings.includeOwnActivity });
      // 새로고침이 도는 동안 사용자가 바꾼 읽음 표시를 지킨다.
      this.state = WatchState.adoptingReadMarks(result.state, this.state);
      this.saveState();
      this.problem = result.failedRepos.length ? { type: 'partial', repos: result.failedRepos } : null;
      const toNotify = Prefs.eventsToNotify(result.newEvents, this.settings.notificationPrefs, this.settings.display, this.state.me);
      if (toNotify.length) this.deps.notifier.post(toNotify, this.settings.notificationPrefs.playsSound);
    } catch (error) {
      if (error && error.kind === 'unauthorized') this.problem = { type: 'unauthorized' };
      else if (error && error.kind === 'http') this.problem = { type: 'network', detail: `HTTP ${error.status} ${error.message}`.trim() };
      else this.problem = { type: 'network', detail: (error && error.message) || String(error) };
    } finally {
      this.isRefreshing = false;
      this.emit();
    }
  }

  // MARK: 목록

  visibleHistory() {
    return Prefs.visible(this.settings.display, this.state.history);
  }

  effectiveQuery() {
    return { ...this.settings.query, search: this.search, me: this.state.me };
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
    this.saveSettings();
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
    this.markRead(id);
  }

  /** id가 없으면 지금 화면에 보이는 항목만 읽음으로 바꾼다(필터·숨긴 저장소 반영). */
  markRead(id) {
    if (id == null) {
      for (const event of Query.filter(this.effectiveQuery(), this.visibleHistory())) {
        if (event.isUnread) WatchState.markRead(this.state, event.id);
      }
    } else {
      WatchState.markRead(this.state, id);
    }
    this.saveState();
    this.emit();
  }

  markRepoRead(repo) {
    WatchState.markRepoRead(this.state, repo);
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
    try {
      const latest = await this.deps.fetchLatestVersion();
      this.availableUpdate = latest && Prefs.isNewerVersion(latest, this.deps.version) ? latest : null;
      this.emit();
    } catch {
      // 다음 확인 때 다시 본다.
    }
  }

  copyUpdateCommand() {
    this.deps.system.copyText(UPDATE_COMMAND);
  }

  // MARK: 계정

  saveToken(token) {
    const trimmed = String(token || '').trim();
    if (!trimmed) return;
    this.tokenSaveFailed = !this.deps.tokens.save(trimmed);
    if (this.tokenSaveFailed) return this.emit();
    // 다른 계정일 수 있으니 기록을 비우고 첫 실행처럼 다시 채운다.
    this.state = WatchState.createState();
    this.saveState();
    this.emit();
    return this.refresh();
  }

  removeSavedToken() {
    this.deps.tokens.remove();
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
    const isConnected = this.tokenSource != null && !(this.problem && this.problem.type === 'unauthorized');
    const login = this.state.me ? ` · @${this.state.me}` : '';
    const accountText = {
      githubCLI: l10n.t('Connected with GitHub CLI') + login,
      saved: l10n.t('Connected with a personal access token') + login,
    }[this.tokenSource] || l10n.t('Not connected');

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
      account: { isConnected, text: accountText, canRemove: this.tokenSource === 'saved', needsToken: this.tokenSource == null },
      tokenSaveFailed: this.tokenSaveFailed,
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

module.exports = { AppModel, defaultSettings, normalizeSettings, REFRESH_CHOICES, UPDATE_COMMAND, URLS };
