// 트레이 아이콘을 누르면 열리는 패널.
//
// 위:   제목 · 검색 · 모두 읽음 · 새로고침 · 설정
//       (검색창)  종류 칩(전체·PR·리뷰·커밋)  내 PR · 안 읽음만
//       저장소 고르기 · 정렬 고르기  N개
// 가운데: 묶음(날짜·저장소·안 읽음)별 활동 목록
// 아래: 마지막 확인 시각 · GitHub 열기
//
// 앱 상태는 주 프로세스가 갖고 있고, 이 화면은 받은 view를 그리기만 한다.
// 검색창·토큰 입력칸은 다시 그리지 않고 옮겨 붙여, 입력 중(한글 조합 포함)에 글자가 끊기지 않게 한다.
'use strict';

const bridge = window.gitbell;
let view = null;
let strings = {};
/** 영어에서 개수가 1일 때 쓰는 단수형 키(앱 본체의 l10n.SINGULAR를 받는다). */
let singular = {};
let locale = 'en-US';
/** 'darwin' | 'win32' | 'linux'. macOS는 Ctrl 대신 ⌘를 쓴다. */
let platform = 'win32';
let menuBuilder = null;
/** 메뉴를 연 버튼(또는 항목). 메뉴를 닫으면 초점을 여기로 돌려준다. */
let menuOpener = null;

const t = (key) => (Object.hasOwn(strings, key) ? strings[key] : key);
const format = (key, ...args) => {
  let index = 0;
  let chosen = key;
  if (!Object.hasOwn(strings, key) && singular[key]) {
    const count = args[(key.match(/%lld|%@/g) || []).indexOf('%lld')];
    if (Number(count) === 1) chosen = singular[key];
  }
  return t(chosen).replace(/%lld|%@/g, () => String(args[index++]));
};
/** 단축키 표기를 OS에 맞춘다('Ctrl+F' → macOS에서는 '⌘F'). */
const keys = (text) => (platform === 'darwin' ? text.replace(/Ctrl\+/g, '⌘') : text);
const esc = (value) => String(value == null ? '' : value)
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const attr = (value) => esc(JSON.stringify(value));
const $ = (selector) => document.querySelector(selector);

/** 'now', '3분 전'처럼 짧은 상대 시간. */
/** '3분 전' 포매터. 목록의 줄마다 불려서 언어마다 한 번만 만든다(만들기가 줄마다 그리는 것보다 비싸다). */
let relativeFormatter = null;
function relativeFormat() {
  if (!relativeFormatter || relativeFormatter.locale !== locale) {
    relativeFormatter = { locale, format: new Intl.RelativeTimeFormat(locale, { style: 'short' }) };
  }
  return relativeFormatter.format;
}

/**
 * '3분 전' 같은 시각. 단위를 넘지 않게 버림으로 센다(95분은 '1시간 전', 59분은 '59분 전').
 * 7일이 넘으면 주, 5주가 넘으면 달, 12달이 넘으면 해로 센다.
 * 시계가 어긋나 미래 시각이 오면 '방금'으로 본다.
 */
function relative(iso) {
  const seconds = (Date.now() - Date.parse(iso)) / 1000;
  if (!(seconds >= 60)) return t('now');
  const rtf = relativeFormat();
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return rtf.format(-hours, 'hour');
  const days = Math.floor(hours / 24);
  if (days < 7) return rtf.format(-days, 'day');
  if (days < 35) return rtf.format(-Math.floor(days / 7), 'week');
  if (days < 365) return rtf.format(-Math.floor(days / 30), 'month');
  return rtf.format(-Math.floor(days / 365), 'year');
}

/** 긴 저장소 이름은 가운데를 줄인다. */
function shortened(text, limit = 22) {
  if (text.length <= limit) return text;
  const half = Math.floor((limit - 1) / 2);
  return `${text.slice(0, half)}…${text.slice(text.length - (limit - 1 - half))}`;
}

/** data-action을 가진 버튼. 누르면 주 프로세스의 같은 이름 동작을 부른다. */
function actionAttrs(name, ...args) {
  return `data-action="${esc(name)}" data-args="${attr(args)}"`;
}

function iconButton(symbol, title, attrs, { active = false, spinning = false } = {}) {
  return `<button class="icon-button${active ? ' active' : ''}${spinning ? ' spinning' : ''}" type="button" title="${esc(title)}" aria-label="${esc(title)}" ${attrs}>${icon(symbol)}</button>`;
}

// MARK: - 위쪽

function renderHeader() {
  // 숫자만 읽히면 무슨 수인지 몰라, 화면 읽기에는 '안 읽음 3개'로 읽힌다.
  const unread = view.unreadCount > 0
    ? `<span class="count-badge" aria-hidden="true">${view.unreadCount}</span><span class="sr-only">${esc(format('%lld unread', view.unreadCount))}</span>` : '';
  $('#header').innerHTML = `
    <span class="brand">${icon('bell', 'brand-icon')}<strong>GitBell</strong>${unread}</span>
    <span class="spacer"></span>
    ${view.showsOnboarding ? '' : iconButton('search', keys(t('Search (Ctrl+F)')), 'data-ui="toggleSearch"', { active: view.showingSearch })}
    ${view.visibleUnreadCount > 0 ? iconButton('checkCircle', t('Mark everything shown as read'), actionAttrs('markRead')) : ''}
    ${iconButton('refresh', keys(t('Refresh (Ctrl+R)')), actionAttrs('refresh'), { spinning: view.isRefreshing })}
    ${iconButton('settings', keys(t('Settings (Ctrl+,)')), actionAttrs('setShowingSettings', true))}`;
}

function renderSearch() {
  const box = $('#searchBox');
  const input = $('#searchInput');
  box.hidden = !view.showingSearch || view.showsOnboarding;
  if (input.value !== view.query.search && document.activeElement !== input) input.value = view.query.search;
  $('#searchClear').hidden = input.value === '';
}

/** symbol: 'dot'(안 읽음 점), 'person'(내 PR), 그 밖에는 icons.js의 아이콘 이름. */
function chip(title, selected, attrs, { symbol = '', small = false } = {}) {
  let dot = '';
  if (symbol === 'dot' || symbol === 'person') {
    dot = `<span class="chip-dot${symbol === 'person' ? ' person' : ''}">${symbol === 'person' ? icon('person') : ''}</span>`;
  } else if (symbol) {
    dot = icon(symbol, 'chip-icon');
  }
  return `<button type="button" class="chip${selected ? ' selected' : ''}${small ? ' small' : ''}" aria-pressed="${selected}" ${attrs}>${dot}${esc(title)}</button>`;
}

function renderFilters() {
  const q = view.query;
  // 종류 칩에도 목록·알림 설정과 같은 아이콘을 붙여 한눈에 알아보게 한다('전체'는 글자만).
  const categories = [[null, t('All'), ''], ['pullRequests', t('PRs'), 'pullRequest'], ['reviews', t('Reviews'), 'eye'],
    ['commits', t('Commits'), 'arrowUp']];
  return `
    <div class="filters">
      <div class="row">
        ${categories.map(([category, title, symbol]) => chip(title, q.category === category, actionAttrs('setQuery', { category }), { symbol })).join('')}
        <span class="spacer"></span>
        ${chip(t('Mine'), q.mineOnly, `${actionAttrs('setQuery', { mineOnly: !q.mineOnly })} title="${esc(t("Show only others' activity on pull requests you opened. Notifications aren't affected."))}"`, { symbol: 'person', small: true })}
        ${chip(t('Unread'), q.unreadOnly, actionAttrs('setQuery', { unreadOnly: !q.unreadOnly }), { symbol: 'dot', small: true })}
      </div>
      <div class="row small">
        <button type="button" class="menu-chip${q.repo ? ' active' : ''}" id="repoMenuButton" data-ui="repoMenu" aria-haspopup="menu" aria-expanded="${openMenuName() === 'repoMenu'}" aria-label="${esc(format('Repository: %@', q.repo || view.repositoryTitle))}" title="${esc(q.repo || view.repositoryTitle)}">
          ${icon('folder')}<span>${esc(shortened(view.repositoryTitle))}</span>${icon('chevronDown', 'chevron')}
        </button>
        <button type="button" class="menu-chip${q.sort !== 'newest' ? ' active' : ''}" id="sortMenuButton" data-ui="sortMenu" aria-haspopup="menu" aria-expanded="${openMenuName() === 'sortMenu'}" aria-label="${esc(format('Sort: %@', view.sortTitle))}">
          ${icon('sort')}<span>${esc(view.sortTitle)}</span>${icon('chevronDown', 'chevron')}
        </button>
        <span class="spacer"></span>
        ${view.isFiltering ? `<button type="button" class="link" ${actionAttrs('resetFilters')}>${esc(t('Reset'))}</button>` : ''}
        <span class="secondary" data-test="visible-count">${esc(format('%lld items', view.visibleCount))}</span>
      </div>
    </div>`;
}

function renderProblem() {
  if (!view.problemMessage) return '';
  const settings = view.problemOpensSettings
    ? `<button type="button" class="link problem-action with-icon" ${actionAttrs('setShowingSettings', true)}>${icon('settings')}${esc(t('Open Settings'))}</button>` : '';
  return `<div class="problem">${icon('warning', 'tint-orange')}<span>${esc(view.problemMessage)}</span>${settings}</div>`;
}

// MARK: - 목록

function renderList() {
  if (view.sections.length === 0) {
    if (view.isFiltering) {
      return `<div class="empty">${icon('filter', 'empty-icon')}<strong>${esc(t('Nothing matches these filters'))}</strong>
        <button type="button" class="pill" ${actionAttrs('resetFilters')}>${esc(t('Reset filters'))}</button></div>`;
    }
    return `<div class="empty">${icon(view.isFirstLoad ? 'hourglass' : 'checkCircle', 'empty-icon')}
      <strong>${esc(t(view.isFirstLoad ? 'Loading your GitHub activity…' : 'No activity yet'))}</strong>
      ${view.isFirstLoad ? '' : `<span class="secondary">${esc(t('New pull requests, reviews, merges and commits will show up here.'))}</span>`}</div>`;
  }
  return `<div class="list" id="list">${view.sections.map(renderSection).join('')}</div>`;
}

/** 묶음 머리줄 아이콘: 날짜는 달력, 안 읽음은 점 원, 읽음은 체크 원. 저장소는 폴더(아래에서 따로 그린다). */
const SECTION_ICON = { day: 'calendar', unread: 'circleDot', read: 'checkCircle' };

function renderSection(section) {
  let header;
  if (section.repo) {
    header = `<div class="section-header">${icon('folder', 'secondary')}
      <span class="section-title" role="heading" aria-level="3"><button type="button" class="plain" title="${esc(section.repo)}" ${actionAttrs('openLink', `repo:${section.repo}`)}>${esc(section.title)}</button></span>
      <span class="section-count">${section.count}</span><span class="spacer"></span>${sectionMarkRead(section)}</div>`;
  } else {
    header = `<div class="section-header">${icon(SECTION_ICON[section.type] || 'calendar', 'section-icon')}<span class="secondary" role="heading" aria-level="3">${esc(section.title)}</span><span class="section-count">${section.count}</span>
      <span class="spacer"></span>${sectionMarkRead(section)}</div>`;
  }
  return `<section data-section="${esc(section.id)}">${header}${section.events.map(renderRow).join('')}</section>`;
}

/** 저장소 묶음뿐 아니라 날짜·안 읽음 묶음도 한 번에 읽음으로 바꿀 수 있다(보이는 항목만, 되돌릴 수 있다). */
function sectionMarkRead(section) {
  if (section.unreadCount === 0) return '';
  return `<button type="button" class="link with-icon" ${actionAttrs('markSectionRead', section.id)}>${icon('checkCircle')}${esc(t('Mark as read'))}</button>`;
}

function renderRow(event) {
  const [symbol, tint] = KIND_STYLE[event.kind] || ['bell', 'gray'];
  const avatar = event.avatar && /^https:\/\/avatars\.githubusercontent\.com\//.test(event.avatar)
    ? `<img class="avatar" alt="" src="${esc(event.avatar)}${event.avatar.includes('?') ? '&' : '?'}s=40">`
    : '<span class="avatar placeholder"></span>';
  const actor = event.actor ? `<span class="tertiary">·</span>${avatar}<span class="actor">${esc(event.actor)}</span>
    ${event.isBot ? `<span class="bot">${esc(t('bot'))}</span>` : ''}` : '';
  // 화면 읽기에는 제목부터, 무슨 일·누가·어디서 순서로 읽힌다('·' 같은 꾸밈 글자는 읽히지 않는다). 시각은 설명으로 붙인다.
  const label = [event.title, [event.kindLabel, event.actor].filter(Boolean).join(', '),
    [event.showsRepository ? event.repoName : '', event.target].filter(Boolean).join(' '),
    event.isUnread ? t('Unread') : ''].filter(Boolean).join('. ');
  const timeId = `time-${event.id}`;
  return `
    <div class="row-wrap">
    <button type="button" class="row-item${event.isUnread ? ' unread' : ''}" data-event="${esc(event.id)}" aria-label="${esc(label)}" aria-describedby="${esc(timeId)}" ${actionAttrs('open', event.id)}>
      <span class="kind-badge tint-${tint}">${icon(symbol)}</span>
      <span class="row-text">
        <span class="context">
          ${event.showsRepository ? `<span class="repo">${esc(event.repoName)}</span>` : ''}
          ${event.target ? `<span class="target">${esc(event.target)}</span>` : ''}
          <span class="spacer"></span>
          <span class="time" id="${esc(timeId)}" data-time="${esc(event.time)}">${esc(relative(event.time))}</span>
        </span>
        <span class="title" dir="auto" title="${esc(event.title)}">${esc(event.title)}</span>
        <span class="meta"><span class="kind tint-${tint}">${esc(event.kindLabel)}</span>${actor}
          <span class="spacer"></span>${event.isUnread ? `<span class="unread-dot" role="img" aria-label="${esc(t('Unread'))}"></span>` : ''}</span>
      </span>
    </button>
    ${event.isUnread ? `<button type="button" class="row-read" title="${esc(t('Mark as read'))}" aria-label="${esc(t('Mark as read'))}" ${actionAttrs('markRead', event.id)}>${icon('checkCircle')}</button>` : ''}
    </div>`;
}

/** 여러 항목을 읽음으로 바꾼 직후 잠시 보이는 '되돌리기'(Ctrl+Z). */
function renderUndo() {
  if (!view.readUndo) return '';
  return `<div class="undo-bar">${icon('checkCircle', 'secondary')}<span>${esc(view.readUndo.text)}</span>
    <span class="spacer"></span><button type="button" class="link with-icon" ${actionAttrs('undoMarkRead')}>${icon('undo')}${esc(t('Undo'))}</button></div>`;
}

function renderUpdate() {
  if (!view.availableUpdate) return '';
  return `<button type="button" class="update" ${actionAttrs('openUpdate')}>
    ${icon('download', 'accent')}<span>${esc(format('GitBell %@ is available', view.availableUpdate))}</span>
    <span class="spacer"></span><span class="accent with-icon">${esc(t('Download'))}${icon('external')}</span></button>`;
}

function renderFooter() {
  return `<footer class="footer"><span class="with-icon">${icon('clock')}${esc(view.checkedText)}</span><span class="spacer"></span>
    <button type="button" class="link with-icon" ${actionAttrs('openLink', 'notifications')}>${esc(t('Open GitHub'))}${icon('external')}</button></footer>`;
}

// MARK: - 처음 연결 안내

function renderOnboarding() {
  return `
    <div class="onboarding">
      <div><h2>${esc(t('Connect your GitHub account'))}</h2>
        <p class="secondary">${esc(t('GitBell reads your repositories and notifications to show pull requests, reviews, merges and commits.'))}</p></div>
      <div class="step"><span class="step-number">1</span><div>
        <strong>${esc(t('Already use GitHub CLI?'))}</strong>
        <p class="secondary">${esc(t('Run this in a terminal, then check again.'))}</p>
        <div class="row"><code>gh auth login</code><span class="spacer"></span>
          <button type="button" class="pill" ${actionAttrs('refresh')}>${icon('refresh')}${esc(t('Check again'))}</button></div>
      </div></div>
      <div class="step"><span class="step-number">2</span><div>
        <strong>${esc(t('Or paste a personal access token'))}</strong>
        <div data-slot="token"></div>
      </div></div>
      <p class="secondary small with-icon">${icon('lock')}${esc(t('Your token is encrypted by your operating system and stored only on this computer.'))}</p>
    </div>`;
}

/** 토큰 입력칸. 한 번만 만들고 안내 화면·설정 화면 중 보이는 곳에 옮겨 붙인다. */
const tokenField = (() => {
  const element = document.createElement('div');
  element.className = 'token-field';
  element.innerHTML = `
    <div class="row"><input id="tokenInput" type="password" placeholder="ghp_…" spellcheck="false" autocomplete="off" aria-label="Personal access token">
      <button type="button" class="button" id="tokenSave" disabled></button></div>
    <p class="error" id="tokenError" hidden></p>
    <button type="button" class="link small with-icon" data-action="openLink" data-args='["tokenCreation"]' id="tokenLink"></button>`;
  const input = element.querySelector('#tokenInput');
  const save = element.querySelector('#tokenSave');
  const submit = () => {
    if (!input.value.trim()) return;
    bridge.action('saveToken', input.value);
    input.value = '';
    save.disabled = true;
  };
  input.addEventListener('input', () => { save.disabled = input.value.trim() === ''; });
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(); });
  save.addEventListener('click', submit);
  return element;
})();

function placeTokenField() {
  const slot = document.querySelector('[data-slot="token"]');
  if (slot) {
    slot.replaceWith(tokenField);
    tokenField.querySelector('#tokenSave').textContent = t('Save');
    tokenField.querySelector('#tokenInput').setAttribute('aria-label', t('Personal access token'));
    tokenField.querySelector('#tokenLink').innerHTML = esc(t('Create a token on GitHub (repo, notifications, read:org)')) + icon('external');
    const error = tokenField.querySelector('#tokenError');
    error.hidden = !view.tokenSaveFailed;
    error.textContent = t("Couldn't save the token. Try again.");
  } else {
    tokenField.remove();
  }
}

// MARK: - 설정

/** 아이콘 · 제목(· 설명) · 스위치 한 줄. 줄 어디를 눌러도 켜고 끈다. args는 누를 때 action에 넘길 값이다. */
function switchRow({ symbol, tint = 'secondary', title, subtitle = '', on, action, args, compact = false, disabled = false }) {
  return `<button type="button" role="switch" aria-checked="${on}" class="switch-row${compact ? ' compact' : ''}${disabled ? ' disabled' : ''}"
      ${disabled ? 'disabled' : ''} ${actionAttrs(action, ...args)}>
    ${symbol ? icon(symbol, `row-icon tint-${tint}`) : ''}
    <span class="row-label"><span>${esc(title)}</span>${subtitle ? `<span class="subtitle">${esc(subtitle)}</span>` : ''}</span>
    <span class="switch${on ? ' on' : ''}"><span class="knob"></span></span></button>`;
}

function settingsSection(title, body) {
  return `<div class="settings-section"><h3>${esc(title)}</h3><div class="card">${body}</div></div>`;
}

function renderSettings() {
  const s = view.settings;
  const n = s.notificationPrefs;
  const off = !n.isEnabled;
  const account = `
    <div class="setting-line">${icon(view.account.isConnected ? 'checkCircle' : 'x', `row-icon ${view.account.isConnected ? 'tint-green' : 'tint-red'}`)}
      <span>${esc(view.account.text)}</span><span class="spacer"></span>
      ${view.account.canRemove ? `<button type="button" class="link" ${actionAttrs('removeSavedToken')}>${esc(t('Remove saved token'))}</button>` : ''}</div>
    ${view.account.hint ? `<p class="secondary small account-hint">${esc(view.account.hint)}</p>` : ''}
    ${view.account.needsToken ? '<div data-slot="token"></div>' : ''}`;

  const pref = (symbol, title, key, subtitle = '', disabled = off) => switchRow({
    symbol, title, subtitle, on: n[key], action: 'setNotificationPrefs', args: [{ [key]: !n[key] }], disabled,
  });
  const notifications = [
    pref('bell', t('Notify me'), 'isEnabled', '', false),
    '<div class="divider"></div>',
    pref('speaker', t('Play sound'), 'playsSound'),
    '<div class="divider"></div>',
    pref('userCheck', t('Notify only for my pull requests'), 'onlyMyPullRequests',
      t("Reviews, comments, merges and pushes on PRs you opened. The list isn't affected.")),
  ];
  notifications.push(`<div class="divider"></div><div class="${off ? 'disabled-look' : ''}"><p class="caption">${esc(t('Notify about'))}</p>
    ${s.groups.map((group) => {
      const [symbol, tint] = GROUP_STYLE[group.id];
      return switchRow({ symbol, tint, title: group.label, subtitle: group.detail, on: group.enabled, action: 'setGroup', args: [group.id, !group.enabled], compact: true, disabled: off });
    }).join('')}</div>`);
  notifications.push(`<div class="divider"></div><div class="setting-block small">
    <div class="setting-line">${icon('checkCircle', 'row-icon tint-green')}<span class="secondary">${esc(t('Banner style follows your system settings'))}</span></div>
    <div class="row indent">${platform === 'linux' ? '' : `<button type="button" class="link with-icon" ${actionAttrs('openNotificationSettings')}>${esc(t('Open system settings'))}${icon('external')}</button>`}
      <span class="spacer"></span>
      <button type="button" class="pill" ${actionAttrs('sendTestNotification')}>${icon('send')}${esc(t('Send test'))}</button></div></div>`);

  const hidden = s.hiddenRepositories.map((repo) => `<div class="hidden-repo"><span>${esc(repo)}</span><span class="spacer"></span>
        <button type="button" class="link" ${actionAttrs('showRepository', repo)}>${esc(t('Show'))}</button></div>`).join('');
  // 다른 설정 줄(switchRow)과 같은 모양: 아이콘 · 제목과 10px 설명 · 오른쪽 값(두 줄 가운데에 맞춘다).
  const hiddenHint = s.hiddenRepositories.length ? ''
    : `<span class="subtitle">${esc(t('Right-click an item to hide its repository.'))}</span>`;
  const list = [
    switchRow({ symbol: 'person', title: t('Include my own activity'), on: s.includeOwnActivity, action: 'setIncludeOwnActivity', args: [!s.includeOwnActivity] }),
    '<div class="divider"></div>',
    switchRow({ symbol: 'cpu', title: t('Hide bot activity'), subtitle: t('Accounts ending in [bot], like CI or review bots'), on: s.hidesBots, action: 'setDisplay', args: [{ hidesBots: !s.hidesBots }] }),
    '<div class="divider"></div>',
    switchRow({ symbol: 'hash', title: t('Show unread count on the tray icon'), on: s.showsCountInTray, action: 'setShowsCountInTray', args: [!s.showsCountInTray] }),
    '<div class="divider"></div>',
    `<div class="setting-block"><div class="setting-line">${icon('eyeOff', 'row-icon secondary')}<span class="row-label"><span>${esc(t('Hidden repositories'))}</span>${hiddenHint}</span>
      <span class="secondary">${s.hiddenRepositories.length}</span></div>${hidden}</div>`,
  ];

  const general = [
    `<div class="setting-line">${icon('refresh', 'row-icon secondary')}<span class="nowrap">${esc(t('Check every'))}</span><span class="spacer"></span>
      <span class="segments" role="radiogroup" aria-label="${esc(t('Check every'))}">
      ${s.refreshChoices.map((minutes) => `<button type="button" role="radio" class="segment${s.refreshMinutes === minutes ? ' selected' : ''}" aria-checked="${s.refreshMinutes === minutes}" ${actionAttrs('setRefreshMinutes', minutes)}>${esc(format('%lld min', minutes))}</button>`).join('')}</span></div>`,
    '<div class="divider"></div>',
    switchRow({ symbol: 'power', title: t('Open at login'), on: s.launchAtLogin, action: 'setLaunchAtLogin', args: [!s.launchAtLogin] }),
  ];

  $('#settings').innerHTML = `
    <div class="settings-header">${iconButton('chevronLeft', t('Back'), actionAttrs('setShowingSettings', false))}<strong>${esc(t('Settings'))}</strong></div>
    <div class="settings-scroll" id="settingsScroll">
      ${settingsSection(t('Account'), account)}
      ${settingsSection(t('Notifications'), notifications.join(''))}
      ${settingsSection(t('List'), list.join(''))}
      ${settingsSection(t('General'), general.join(''))}
    </div>
    <footer class="footer"><span class="secondary">GitBell ${esc(view.version)}</span>
      ${view.availableUpdate ? `<span class="tag">${esc(format('%@ available', view.availableUpdate))}</span>` : ''}
      <button type="button" class="link with-icon" ${actionAttrs('openLink', 'project')}>${esc(t('GitHub'))}${icon('external')}</button>
      <span class="spacer"></span>
      <button type="button" class="pill" ${actionAttrs('quit')}>${icon('power')}${esc(t('Quit GitBell'))}</button></footer>`;
}

// MARK: - 고르기 메뉴(저장소·정렬·우클릭)

function optionRow({ title, subtitle = '', detail = '', unread = 0, selected = null, symbol = '', label = '', attrs = '' }) {
  // 고르는 메뉴(저장소·정렬)는 골라진 것을 화면 읽기 프로그램도 알 수 있게 한다.
  const role = selected == null ? 'role="menuitem"' : `role="menuitemradio" aria-checked="${selected}"`;
  const name = label ? `aria-label="${esc(label)}"` : '';
  return `<button type="button" class="option" tabindex="-1" ${role} ${name} ${attrs}>
    ${selected == null ? '' : `<span class="check">${selected ? icon('check') : ''}</span>`}
    ${symbol ? icon(symbol, 'secondary') : ''}
    <span class="option-text"><span class="${selected ? 'strong' : ''}">${esc(title)}</span>${subtitle ? `<span class="subtitle">${esc(subtitle)}</span>` : ''}</span>
    <span class="spacer"></span>
    ${unread > 0 ? `<span class="count-badge small">${unread}</span>` : ''}
    ${detail !== '' ? `<span class="secondary">${esc(detail)}</span>` : ''}</button>`;
}

const menus = {
  repoMenu: () => {
    const total = view.repositories.reduce((sum, repo) => sum + repo.count, 0);
    return optionRow({ title: t('All repositories'), detail: total, selected: view.query.repo == null, attrs: actionAttrs('setQuery', { repo: null }) })
      + '<div class="menu-divider"></div><div class="menu-scroll">'
      + view.repositories.map((repo) => optionRow({ title: repo.name, subtitle: repo.repo, detail: repo.count, unread: repo.unreadCount,
        selected: view.query.repo === repo.repo,
        // 숫자 두 개(안 읽음·전체)만 읽히면 뜻을 몰라 이름표에 풀어 쓴다.
        label: [repo.name, repo.repo, format('%lld items', repo.count), repo.unreadCount ? format('%lld unread', repo.unreadCount) : '']
          .filter(Boolean).join(', '),
        attrs: `${actionAttrs('setQuery', { repo: repo.repo })} data-repo-menu="${esc(repo.repo)}"` })).join('')
      + '</div>';
  },
  sortMenu: () => [['newest', 'clock', 'Newest'], ['byRepository', 'folder', 'By repository'], ['unreadFirst', 'circleDot', 'Unread first']]
    .map(([sort, symbol, title]) => optionRow({ title: t(title), symbol, selected: view.query.sort === sort, attrs: actionAttrs('setQuery', { sort }) }))
    .join(''),
  eventMenu: (id) => {
    const event = view.sections.flatMap((section) => section.events).find((e) => e.id === id);
    if (!event) return null;
    return [
      optionRow({ title: t('Open in browser'), symbol: 'external', attrs: actionAttrs('open', id) }),
      optionRow({ title: t('Copy link'), symbol: 'link', attrs: actionAttrs('copyLink', id) }),
      '<div class="menu-divider"></div>',
      event.isUnread ? optionRow({ title: t('Mark as read'), symbol: 'checkCircle', attrs: actionAttrs('markRead', id) })
        : optionRow({ title: t('Mark as unread'), symbol: 'circleDot', attrs: actionAttrs('markUnread', id) }),
      optionRow({ title: format('Show only %@', event.repoName), symbol: 'folder', attrs: actionAttrs('setQuery', { repo: event.repo }) }),
      '<div class="menu-divider"></div>',
      optionRow({ title: format('Hide %@', event.repoName), symbol: 'eyeOff', attrs: actionAttrs('hideRepository', event.repo) }),
    ].join('');
  },
  repoContextMenu: (repo) => optionRow({ title: t('Hide this repository'), symbol: 'eyeOff', attrs: actionAttrs('hideRepository', repo) }),
};

function openMenuName() {
  const menu = $('#menu');
  return menu && !menu.hidden ? menu.dataset.menu : null;
}

function openMenu(name, arg, anchor, opener = null) {
  menuOpener = opener;
  menuBuilder = () => menus[name](arg);
  const html = menuBuilder();
  if (html == null) return closeMenu();
  const menu = $('#menu');
  menu.innerHTML = html;
  menu.hidden = false;
  menu.dataset.menu = name;
  // 저장소·정렬 메뉴는 연 단추의 이름(예: '정렬: 최신순')으로 읽힌다.
  const labelledBy = { repoMenu: 'repoMenuButton', sortMenu: 'sortMenuButton' }[name];
  if (labelledBy) menu.setAttribute('aria-labelledby', labelledBy);
  else menu.removeAttribute('aria-labelledby');
  const width = name === 'repoMenu' ? 280 : name === 'sortMenu' ? 200 : 240;
  menu.style.width = `${width}px`;
  const maxLeft = document.documentElement.clientWidth - width - 8;
  const left = Math.max(8, Math.min(anchor.x, maxLeft));
  menu.style.left = `${left}px`;
  menu.style.top = '0px';
  const height = menu.offsetHeight;
  const below = anchor.y;
  const room = document.documentElement.clientHeight - 8;
  menu.style.top = `${Math.max(8, below + height > room ? room - height : below)}px`;
  if (opener && opener.hasAttribute('aria-haspopup')) opener.setAttribute('aria-expanded', 'true');
  // 키보드로도 바로 고를 수 있게 골라진 항목(없으면 첫 항목)에 초점을 둔다.
  const first = menu.querySelector('.option[aria-checked="true"]') || menu.querySelector('.option');
  if (first) first.focus();
}

/** 메뉴를 닫는다. returnFocus면 메뉴를 연 버튼으로 초점을 돌려준다(Esc로 닫을 때). */
function closeMenu({ returnFocus = false } = {}) {
  const wasOpen = !$('#menu').hidden;
  menuBuilder = null;
  $('#menu').hidden = true;
  const opener = findAgain(menuOpener);
  menuOpener = null;
  if (opener) {
    if (opener.hasAttribute('aria-expanded')) opener.setAttribute('aria-expanded', 'false');
    if (returnFocus && wasOpen) opener.focus();
  }
}

/** 화면을 다시 그리면 버튼이 새로 만들어지므로, 같은 버튼을 이름표(data-ui·data-event)로 다시 찾는다. */
function findAgain(element) {
  if (!element || element.isConnected) return element;
  if (element.dataset.ui) return document.querySelector(`[data-ui="${CSS.escape(element.dataset.ui)}"]`);
  if (element.dataset.event) return document.querySelector(`[data-event="${CSS.escape(element.dataset.event)}"]`);
  return null;
}

/** 열린 메뉴 안에서 위·아래 화살표, Home·End로 항목을 옮겨 다닌다. */
function moveMenuFocus(key) {
  const options = [...$('#menu').querySelectorAll('.option')];
  if (options.length === 0) return;
  const index = options.indexOf(document.activeElement);
  let next;
  if (key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % options.length;
  else if (key === 'ArrowUp') next = index <= 0 ? options.length - 1 : index - 1;
  else if (key === 'Home') next = 0;
  else next = options.length - 1;
  options[next].focus();
}

// MARK: - 그리기

/**
 * 다시 그리기 전에 키보드 초점이 있던 버튼을 기억할 이름표.
 * 화면을 innerHTML로 통째로 다시 그려, 그대로 두면 칩을 Enter로 누를 때마다 초점이 사라졌다.
 * data-ui·data-event는 그대로 찾고, 나머지는 같은 동작(data-action) 버튼 중 몇 번째인지로 찾는다.
 */
/**
 * 다시 그리기 전, 키보드 초점이 어디 있었는지 기억한다.
 * 화면은 다시 그릴 때마다 새 버튼으로 바뀌어 초점이 사라지므로, 같은 버튼(또는 그 자리를 대신할 곳)을 찾아 돌려준다.
 */
function focusKey() {
  const element = document.activeElement;
  if (!element || element === document.body || element.closest('#menu')) return null;
  const area = element.closest('#settings') ? 'settings' : element.closest('.list') ? 'list' : 'main';
  const rows = [...document.querySelectorAll('.list .row-item')];
  const key = { area, section: element.closest('section')?.dataset.section ?? null,
    rowIndex: rows.indexOf(element.closest('.row-wrap')?.querySelector('.row-item') ?? null) };
  if (element.id) {
    key.selector = `#${CSS.escape(element.id)}`;
  } else if (element.dataset.ui) {
    key.selector = `[data-ui="${CSS.escape(element.dataset.ui)}"]`;
  } else if (element.classList.contains('row-read') || element.dataset.event) {
    // 줄의 '읽음 표시' 단추는 누르면 사라지므로 그 줄로 초점을 옮긴다.
    const row = element.dataset.event ? element : element.parentElement.querySelector('[data-event]');
    if (row) key.selector = `[data-event="${CSS.escape(row.dataset.event)}"]`;
  } else if (element.dataset.action) {
    key.action = element.dataset.action;
    key.index = [...document.querySelectorAll(`[data-action="${CSS.escape(key.action)}"]`)].filter(isShown).indexOf(element);
  }
  return key;
}

/** 화면에 보이는(숨은 화면·[hidden] 안이 아닌) 요소인지. 숨은 버튼에는 초점을 줄 수 없다. */
function isShown(element) {
  return element.isConnected && !element.closest('[hidden]') && element.getClientRects().length > 0;
}

function restoreFocus(key) {
  // 초점 받은 요소가 방금 숨었으면(설정 화면으로 바뀜 등) 브라우저가 아직 그 요소를 activeElement로 둘 수 있어 함께 본다.
  const active = document.activeElement;
  if (!key || (active && active !== document.body && isShown(active))) return;
  const shown = (selector) => [...document.querySelectorAll(selector)].filter(isShown);
  let element = null;
  if (key.selector) element = shown(key.selector)[0];
  else if (key.action) element = shown(`[data-action="${CSS.escape(key.action)}"]`)[key.index];
  // 그 버튼이 사라졌으면(읽음 표시 뒤 '모두 읽음', 설정 열기·닫기, 저장소 숨기기 등) 가까운 자리로 옮긴다.
  if (!element) element = fallbackFocus(key, shown);
  // 스크롤은 listAnchor가 맞춰 두었으니 초점을 옮기며 목록을 움직이지 않는다.
  if (element) element.focus({ preventScroll: true });
}

function fallbackFocus(key, shown) {
  // 설정을 열었으면 '뒤로', 닫았으면 위쪽의 '설정' 단추로.
  if (view.showingSettings) return shown('#settings .settings-header button')[0];
  // 검색칸을 닫았으면 검색 단추로.
  if (key.selector === '#searchInput') return shown('[data-ui="toggleSearch"]')[0];
  if (key.area === 'settings') return shown('#header [data-action="setShowingSettings"]')[0];
  const rows = shown('.list .row-item');
  if (key.area === 'list' && rows.length) {
    const inSection = key.section ? shown(`section[data-section="${CSS.escape(key.section)}"] .row-item`)[0] : null;
    return inSection || rows[Math.min(Math.max(key.rowIndex, 0), rows.length - 1)];
  }
  return rows[0] || shown('#header button')[0];
}

/**
 * 다시 그리기 전 목록의 스크롤 위치를 기억한다.
 * 픽셀값만 기억하면 위에 새 항목이 쌓일 때 보던 항목이 아래로 밀린다.
 * 맨 위였으면 맨 위를(새 항목이 바로 보인다), 아니면 맨 위에 보이던 항목과 그 위치를 기억한다.
 */
function listAnchor() {
  const list = $('#list');
  if (!list || list.scrollTop <= 2) return null;
  const top = list.getBoundingClientRect().top;
  const row = [...list.querySelectorAll('.row-item')].find((item) => item.getBoundingClientRect().bottom > top);
  return { scrollTop: list.scrollTop, id: row?.dataset.event, offset: row ? row.getBoundingClientRect().top - top : 0 };
}

function restoreListAnchor(anchor) {
  const list = $('#list');
  if (!list || !anchor) return;
  list.scrollTop = anchor.scrollTop;
  const row = anchor.id && list.querySelector(`.row-item[data-event="${CSS.escape(anchor.id)}"]`);
  if (row) list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top - anchor.offset;
}

/** 종류 칩 줄이 패널 폭을 넘치면 아이콘을 빼고 글자만 남긴다. 한국어는 아이콘까지 들어간다. */
function fitFilterChips() {
  const row = document.querySelector('.filters > .row');
  if (!row) return;
  row.classList.remove('compact');
  if (row.scrollWidth > row.clientWidth) row.classList.add('compact');
}

/** 화면 읽기 프로그램에 마지막으로 알린 상태. 같은 내용을 다시 그릴 때마다 되풀이해 알리지 않는다. */
let announced = { problem: null, undo: null, search: '' };
let searchAnnounceTimer = null;

/**
 * 되돌리기·문제·복사처럼 새로 생긴 상태를 #announcer(늘 그 자리에 있는 알림 자리)로 알린다.
 * 띠 자체에 role=status를 두면 다시 그릴 때마다 새로 생긴 알림 자리라 읽지 않거나 되풀이해 읽는다.
 */
function announceChanges() {
  const messages = [];
  if (view.problemMessage && view.problemMessage !== announced.problem) messages.push(view.problemMessage);
  // 같은 문구라도 새로 생긴 되돌리기(stamp가 다름)면 다시 알린다.
  const undo = view.readUndo ? view.readUndo.stamp : null;
  if (undo != null && undo !== announced.undo) messages.push(view.readUndo.text);
  const search = view.query.search || '';
  if (search !== announced.search) {
    // 검색 결과 수는 글자를 다 친 뒤 한 번만 알린다.
    clearTimeout(searchAnnounceTimer);
    if (search.trim()) {
      searchAnnounceTimer = setTimeout(() => { $('#announcer').textContent = format('%lld items', view.visibleCount); }, 700);
    }
  }
  announced = { problem: view.problemMessage, undo, search };
  if (messages.length) $('#announcer').textContent = messages.join(' ');
}

function render() {
  if (!view) return;
  const focused = focusKey();
  const anchor = listAnchor();
  const settingsScroll = $('#settingsScroll');
  const settingsTop = settingsScroll ? settingsScroll.scrollTop : 0;

  $('#main').hidden = view.showingSettings;
  $('#settings').hidden = !view.showingSettings;
  if (view.showingSettings) {
    renderSettings();
    $('#settingsScroll').scrollTop = settingsTop;
  } else {
    renderHeader();
    renderSearch();
    $('#body').innerHTML = view.showsOnboarding
      ? renderProblem() + renderOnboarding()
      : renderFilters() + renderProblem() + renderList() + renderUndo() + renderUpdate() + renderFooter();
    restoreListAnchor(anchor);
    fitFilterChips();
  }
  placeTokenField();
  restoreFocus(focused);
  announceChanges();
  if (menuBuilder && !$('#menu').hidden) {
    const html = menuBuilder();
    if (html == null) closeMenu();
    else {
      // 새 자료가 와서 메뉴를 다시 그려도 키보드 초점이 있던 항목을 지킨다.
      const menu = $('#menu');
      const focused = [...menu.querySelectorAll('.option')].indexOf(document.activeElement);
      menu.innerHTML = html;
      if (focused >= 0) menu.querySelectorAll('.option')[focused]?.focus();
    }
  }
  requestAnimationFrame(reportSize);
}

function reportSize() {
  bridge.resize(document.body.getBoundingClientRect().height);
}

function setMaxHeight(height) {
  if (height > 0) document.documentElement.style.setProperty('--max-height', `${height}px`);
}

/**
 * 패널을 열어 둔 동안에도 '3분 전' 같은 시간이 바뀌게 한다. 숨은 패널은 고치지 않고 열 때 맞춘다(onShown).
 * force: 패널을 막 열었을 때. 그 순간에는 document.hidden이 아직 true일 수 있다.
 */
function refreshTimes(force = false) {
  // 숨은 패널의 시각은 고치지 않는다. 열 때 다시 맞춘다(onShown).
  if (!force && document.hidden) return;
  for (const element of document.querySelectorAll('[data-time]')) element.textContent = relative(element.dataset.time);
}

// MARK: - 입력

function toggleSearch(force) {
  const on = force == null ? !view.showingSearch : force;
  bridge.action('setShowingSearch', on);
  if (on) {
    // 검색칸은 주 프로세스가 보낸 화면 자료로 다시 그리기 전까지 숨어 있어 초점을 받지 못한다.
    // Ctrl+F 뒤 바로 친 글자를 잃지 않게 칸을 먼저 보이고 바로 초점을 준다.
    $('#searchBox').hidden = false;
    $('#searchInput').focus();
  } else {
    $('#searchInput').value = '';
  }
}

/**
 * 마우스를 누른 버튼과 그 이름표(data-action·data-args 또는 data-ui).
 * 누르고 떼는 사이에 화면 자료가 와서 다시 그려지면(앞 동작의 결과, 확인 결과 등) 누른 버튼이 새 버튼으로 바뀐다.
 * 그러면 브라우저는 클릭을 보내지 않아 누른 것이 사라진다. 그때는 뗀 자리의 버튼이 같은 동작이면 그 버튼을 누른 것으로 본다.
 */
let pressed = null;
const actionKey = (element) => (element
  ? `${element.dataset.ui || ''}|${element.dataset.action || ''}|${element.dataset.args || ''}|${element.dataset.event || ''}` : null);

document.addEventListener('pointerdown', (event) => {
  // 마우스로 조작하는 중에는 초점을 옮겨도 고리를 그리지 않는다(.pointer-nav). 키를 누르면 다시 보인다.
  document.documentElement.classList.add('pointer-nav');
  if (event.button !== 0) { pressed = null; return; }
  const element = event.target.closest('[data-action], [data-ui]');
  pressed = element ? { element, key: actionKey(element) } : null;
});

document.addEventListener('pointerup', (event) => {
  const before = pressed;
  pressed = null;
  if (!before || before.element.isConnected) return;
  const under = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-action], [data-ui]');
  if (under && actionKey(under) === before.key) activate(under, event);
});

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action], [data-ui]');
  if (!target) {
    if (!event.target.closest('#menu')) closeMenu();
    return;
  }
  activate(target, event);
});

/** 버튼 하나를 누른 것으로 처리한다(click, 또는 다시 그려진 뒤의 pointerup). */
function activate(target, event) {
  const insideMenu = event.target.closest('#menu') || target.closest('#menu');
  if (target.dataset.ui) {
    const ui = target.dataset.ui;
    if (ui === 'toggleSearch') toggleSearch();
    if (ui === 'repoMenu' || ui === 'sortMenu') {
      if (!$('#menu').hidden && $('#menu').dataset.menu === ui) return closeMenu();
      const rect = target.getBoundingClientRect();
      openMenu(ui, null, { x: rect.left, y: rect.bottom + 4 }, target);
    }
    return;
  }
  const args = JSON.parse(target.dataset.args || '[]');
  if (insideMenu) closeMenu({ returnFocus: true });
  bridge.action(target.dataset.action, ...args);
}

/** 항목(또는 저장소 메뉴의 저장소)의 우클릭 메뉴를 연다. point가 없으면 그 항목 바로 아래에 연다. */
function openContextMenu(target, point = null) {
  const row = target.closest('[data-event]');
  const repo = target.closest('[data-repo-menu]');
  const source = row || repo;
  if (!source) return false;
  let anchor = point;
  if (!anchor) {
    const rect = source.getBoundingClientRect();
    anchor = { x: rect.left + 24, y: rect.bottom - 4 };
  }
  // 저장소 메뉴 안에서 연 메뉴는 원래 메뉴를 대신하므로 초점을 돌려줄 곳이 없다.
  if (row) openMenu('eventMenu', row.dataset.event, anchor, row);
  else openMenu('repoContextMenu', repo.dataset.repoMenu, anchor, null);
  return true;
}

document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  // 키보드로 연 경우(Windows의 메뉴 키 등)는 마우스 위치가 (0, 0)이라 항목 아래에 연다.
  const fromKeyboard = event.clientX === 0 && event.clientY === 0;
  openContextMenu(event.target, fromKeyboard ? null : { x: event.clientX, y: event.clientY });
});

document.addEventListener('keydown', () => document.documentElement.classList.remove('pointer-nav'), true);

document.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  // Shift+F10·메뉴 키: 초점이 있는 항목의 우클릭 메뉴(키보드만 쓰는 사람용). 이미 열린 메뉴 안에서는 무시한다.
  if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
    if (!event.target.closest('#menu') && openContextMenu(event.target)) event.preventDefault();
    return;
  }
  if ((platform === 'darwin' ? event.metaKey : event.ctrlKey) && !event.altKey && !event.shiftKey) {
    if (key === 'f' && !view.showingSettings && !view.showsOnboarding) { event.preventDefault(); toggleSearch(); }
    if (key === 'r') { event.preventDefault(); bridge.action('refresh'); }
    if (key === ',') { event.preventDefault(); bridge.action('setShowingSettings', true); }
    // 검색창 안의 Ctrl+Z는 글자 되돌리기로 둔다.
    if (key === 'z' && view.readUndo && !event.target.closest('input')) { event.preventDefault(); bridge.action('undoMarkRead'); }
    return;
  }
  if (!$('#menu').hidden) {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      moveMenuFocus(event.key);
      return;
    }
    // Tab으로 메뉴 밖으로 나가면 메뉴를 닫는다(열린 채 초점만 빠져나가지 않게).
    if (event.key === 'Tab') closeMenu({ returnFocus: true });
  }
  if (event.key === 'Escape') {
    if (!$('#menu').hidden) closeMenu({ returnFocus: true });
    else if (view.showingSearch) toggleSearch(false);
    else if (view.showingSettings) bridge.action('setShowingSettings', false);
    else bridge.action('hidePanel');
  }
});

$('#searchInput').addEventListener('input', (event) => {
  $('#searchClear').hidden = event.target.value === '';
  bridge.action('setQuery', { search: event.target.value });
});
$('#searchClear').addEventListener('click', () => {
  $('#searchInput').value = '';
  $('#searchInput').focus();
  bridge.action('setQuery', { search: '' });
});

// MARK: - 시작

async function start() {
  const init = await bridge.init();
  strings = init.strings || {};
  singular = init.singular || {};
  locale = init.locale || 'en-US';
  platform = init.platform || platform;
  document.documentElement.lang = locale.slice(0, 2);
  if (init.accent) document.documentElement.style.setProperty('--accent', init.accent);
  setMaxHeight(init.maxHeight);
  $('#searchIcon').innerHTML = icon('search');
  $('#searchClear').innerHTML = icon('x');
  $('#searchInput').placeholder = t('Search title, repository, person, #number');
  // 자리표시 글은 이름이 아니라서 화면 읽기용 이름을 따로 준다.
  $('#searchInput').setAttribute('aria-label', t('Search activity'));
  $('#searchClear').setAttribute('aria-label', t('Clear search'));
  $('#searchClear').title = t('Clear search');
  view = init.view;
  render();
  bridge.onView((next) => {
    view = next;
    render();
  });
  bridge.onDrawTray((request) => bridge.sendTrayImage(drawTrayIcons($('#trayCanvas'), request)));
  bridge.onShown((maxHeight) => {
    setMaxHeight(maxHeight);
    // 패널을 열 때마다 목록 맨 위(가장 새 항목)부터 보인다. 패널은 닫아도 화면을 버리지 않아,
    // 그대로 두면 지난번 스크롤 위치에 머물러 그 사이 쌓인 새 항목을 보려면 다시 올려야 한다.
    const list = $('#list');
    if (list) list.scrollTop = 0;
    refreshTimes(true);
    if (view.showingSearch) $('#searchInput').focus();
  });
  setInterval(() => refreshTimes(), 30000);
  // 인터넷이 다시 연결되면 앱이 바로 확인한다(끊긴 동안에는 확인을 건너뛴다).
  window.addEventListener('online', () => bridge.action('networkOnline'));
  new ResizeObserver(reportSize).observe(document.body);
}

start();
