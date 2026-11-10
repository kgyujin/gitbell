// 트레이 아이콘을 누르면 열리는 패널. macOS판 PanelView·SettingsView·EventRow와 같은 구성이다.
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
let menuBuilder = null;
let copiedUpdate = false;

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
const esc = (value) => String(value == null ? '' : value)
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const attr = (value) => esc(JSON.stringify(value));
const $ = (selector) => document.querySelector(selector);

/** 'now', '3분 전'처럼 짧은 상대 시간. */
function relative(iso) {
  const seconds = (Date.parse(iso) - Date.now()) / 1000;
  if (seconds > -60) return t('now');
  const rtf = new Intl.RelativeTimeFormat(locale, { style: 'short' });
  const minutes = seconds / 60;
  if (minutes > -60) return rtf.format(Math.round(minutes), 'minute');
  const hours = minutes / 60;
  if (hours > -24) return rtf.format(Math.round(hours), 'hour');
  return rtf.format(Math.round(hours / 24), 'day');
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
  const unread = view.unreadCount > 0 ? `<span class="count-badge">${view.unreadCount}</span>` : '';
  $('#header').innerHTML = `
    <span class="brand">${icon('bell', 'brand-icon')}<strong>GitBell</strong>${unread}</span>
    <span class="spacer"></span>
    ${view.showsOnboarding ? '' : iconButton('search', t('Search (Ctrl+F)'), 'data-ui="toggleSearch"', { active: view.showingSearch })}
    ${view.visibleUnreadCount > 0 ? iconButton('checkCircle', t('Mark everything shown as read'), actionAttrs('markRead')) : ''}
    ${iconButton('refresh', t('Refresh (Ctrl+R)'), actionAttrs('refresh'), { spinning: view.isRefreshing })}
    ${iconButton('settings', t('Settings (Ctrl+,)'), actionAttrs('setShowingSettings', true))}`;
}

function renderSearch() {
  const box = $('#searchBox');
  const input = $('#searchInput');
  box.hidden = !view.showingSearch || view.showsOnboarding;
  if (input.value !== view.query.search && document.activeElement !== input) input.value = view.query.search;
  $('#searchClear').hidden = input.value === '';
}

function chip(title, selected, attrs, { symbol = '', small = false } = {}) {
  const dot = symbol ? `<span class="chip-dot${symbol === 'person' ? ' person' : ''}">${symbol === 'person' ? icon('person') : ''}</span>` : '';
  return `<button type="button" class="chip${selected ? ' selected' : ''}${small ? ' small' : ''}" aria-pressed="${selected}" ${attrs}>${dot}${esc(title)}</button>`;
}

function renderFilters() {
  const q = view.query;
  const categories = [[null, t('All')], ['pullRequests', t('PRs')], ['reviews', t('Reviews')], ['commits', t('Commits')]];
  return `
    <div class="filters">
      <div class="row">
        ${categories.map(([category, title]) => chip(title, q.category === category, actionAttrs('setQuery', { category }))).join('')}
        <span class="spacer"></span>
        ${chip(t('Mine'), q.mineOnly, `${actionAttrs('setQuery', { mineOnly: !q.mineOnly })} title="${esc(t("Show only others' activity on pull requests you opened. Notifications aren't affected."))}"`, { symbol: 'person', small: true })}
        ${chip(t('Unread'), q.unreadOnly, actionAttrs('setQuery', { unreadOnly: !q.unreadOnly }), { symbol: 'dot', small: true })}
      </div>
      <div class="row small">
        <button type="button" class="menu-chip${q.repo ? ' active' : ''}" data-ui="repoMenu" title="${esc(q.repo || view.repositoryTitle)}">
          ${icon('folder')}<span>${esc(shortened(view.repositoryTitle))}</span>${icon('chevronDown', 'chevron')}
        </button>
        <button type="button" class="menu-chip${q.sort !== 'newest' ? ' active' : ''}" data-ui="sortMenu">
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
  return `<div class="problem" role="status">${icon('warning', 'tint-orange')}<span>${esc(view.problemMessage)}</span></div>`;
}

// MARK: - 목록

function renderList() {
  if (view.sections.length === 0) {
    if (view.isFiltering) {
      return `<div class="empty">${icon('filter', 'empty-icon')}<strong>${esc(t('Nothing matches these filters'))}</strong>
        <button type="button" class="pill" ${actionAttrs('resetFilters')}>${esc(t('Reset filters'))}</button></div>`;
    }
    return `<div class="empty">${icon(view.isFirstLoad ? 'hourglass' : 'checkCircle', 'empty-icon')}
      <strong>${esc(t(view.isFirstLoad ? 'Loading your GitHub activity…' : 'No activity in the last day'))}</strong>
      ${view.isFirstLoad ? '' : `<span class="secondary">${esc(t('New pull requests, reviews, merges and commits will show up here.'))}</span>`}</div>`;
  }
  return `<div class="list" id="list">${view.sections.map(renderSection).join('')}</div>`;
}

function renderSection(section) {
  let header;
  if (section.repo) {
    header = `<div class="section-header">${icon('folder', 'secondary')}
      <button type="button" class="plain" title="${esc(section.repo)}" ${actionAttrs('openLink', `repo:${section.repo}`)}>${esc(section.title)}</button>
      <span class="tertiary">${section.count}</span><span class="spacer"></span>
      ${section.unreadCount > 0 ? `<button type="button" class="link" ${actionAttrs('markRepoRead', section.repo)}>${esc(t('Mark as read'))}</button>` : ''}</div>`;
  } else {
    header = `<div class="section-header"><span class="secondary">${esc(section.title)}</span><span class="tertiary">${section.count}</span></div>`;
  }
  return `<section data-section="${esc(section.id)}">${header}${section.events.map(renderRow).join('')}</section>`;
}

function renderRow(event) {
  const [symbol, tint] = KIND_STYLE[event.kind] || ['bell', 'gray'];
  const avatar = event.avatar && /^https:\/\/avatars\.githubusercontent\.com\//.test(event.avatar)
    ? `<img class="avatar" alt="" src="${esc(event.avatar)}${event.avatar.includes('?') ? '&' : '?'}s=40">`
    : '<span class="avatar placeholder"></span>';
  const actor = event.actor ? `<span class="tertiary">·</span>${avatar}<span class="actor">${esc(event.actor)}</span>
    ${event.isBot ? `<span class="bot">${esc(t('bot'))}</span>` : ''}` : '';
  return `
    <button type="button" class="row-item${event.isUnread ? ' unread' : ''}" data-event="${esc(event.id)}" title="${esc(event.title)}" ${actionAttrs('open', event.id)}>
      <span class="kind-badge tint-${tint}">${icon(symbol)}</span>
      <span class="row-text">
        <span class="context">
          ${event.showsRepository ? `<span class="repo">${esc(event.repoName)}</span>` : ''}
          ${event.target ? `<span class="target">${esc(event.target)}</span>` : ''}
          <span class="spacer"></span>
          <span class="time" data-time="${esc(event.time)}">${esc(relative(event.time))}</span>
        </span>
        <span class="title">${esc(event.title)}</span>
        <span class="meta"><span class="kind tint-${tint}">${esc(event.kindLabel)}</span>${actor}
          <span class="spacer"></span>${event.isUnread ? `<span class="unread-dot" role="img" aria-label="${esc(t('Unread'))}"></span>` : ''}</span>
      </span>
    </button>`;
}

function renderUpdate() {
  if (!view.availableUpdate) return '';
  return `<button type="button" class="update" data-ui="copyUpdate" title="npx gitbell@latest">
    ${icon('download', 'accent')}<strong>${esc(format('GitBell %@ is available', view.availableUpdate))}</strong>
    <span class="spacer"></span><span class="accent">${esc(copiedUpdate ? t('Copied — paste it in a terminal') : t('Copy update command'))}</span></button>`;
}

function renderFooter() {
  return `<footer class="footer"><span>${esc(view.checkedText)}</span><span class="spacer"></span>
    <button type="button" class="link" ${actionAttrs('openLink', 'notifications')}>${esc(t('Open GitHub'))}</button></footer>`;
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
      <p class="secondary small">${esc(t('Your token is encrypted for your Windows account and stored only on this PC.'))}</p>
    </div>`;
}

/** 토큰 입력칸. 한 번만 만들고 안내 화면·설정 화면 중 보이는 곳에 옮겨 붙인다. */
const tokenField = (() => {
  const element = document.createElement('div');
  element.className = 'token-field';
  element.innerHTML = `
    <div class="row"><input id="tokenInput" type="password" placeholder="ghp_…" spellcheck="false" autocomplete="off">
      <button type="button" class="button" id="tokenSave" disabled></button></div>
    <p class="error" id="tokenError" hidden></p>
    <button type="button" class="link small" data-action="openLink" data-args='["tokenCreation"]' id="tokenLink"></button>`;
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
    tokenField.querySelector('#tokenLink').textContent = t('Create a token on GitHub (repo, notifications, read:org)');
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
    <div class="setting-line">${icon('checkCircle', 'row-icon tint-green')}<span class="secondary">${esc(t('Banner style follows Windows settings'))}</span></div>
    <div class="row indent"><button type="button" class="link" ${actionAttrs('openNotificationSettings')}>${esc(t('Open Windows settings'))}</button>
      <span class="spacer"></span>
      <button type="button" class="pill" ${actionAttrs('sendTestNotification')}>${icon('send')}${esc(t('Send test'))}</button></div></div>`);

  const hidden = s.hiddenRepositories.length
    ? s.hiddenRepositories.map((repo) => `<div class="hidden-repo"><span>${esc(repo)}</span><span class="spacer"></span>
        <button type="button" class="link" ${actionAttrs('showRepository', repo)}>${esc(t('Show'))}</button></div>`).join('')
    : `<p class="secondary small indent">${esc(t('Right-click an item to hide its repository.'))}</p>`;
  const list = [
    switchRow({ symbol: 'person', title: t('Include my own activity'), on: s.includeOwnActivity, action: 'setIncludeOwnActivity', args: [!s.includeOwnActivity] }),
    '<div class="divider"></div>',
    switchRow({ symbol: 'cpu', title: t('Hide bot activity'), subtitle: t('Accounts ending in [bot], like CI or review bots'), on: s.hidesBots, action: 'setDisplay', args: [{ hidesBots: !s.hidesBots }] }),
    '<div class="divider"></div>',
    switchRow({ symbol: 'hash', title: t('Show unread count on the tray icon'), on: s.showsCountInTray, action: 'setShowsCountInTray', args: [!s.showsCountInTray] }),
    '<div class="divider"></div>',
    `<div class="setting-block"><div class="setting-line">${icon('eyeOff', 'row-icon secondary')}<span>${esc(t('Hidden repositories'))}</span>
      <span class="spacer"></span><span class="secondary">${s.hiddenRepositories.length}</span></div>${hidden}</div>`,
  ];

  const general = [
    `<div class="setting-line">${icon('refresh', 'row-icon secondary')}<span>${esc(t('Check every'))}</span><span class="spacer"></span>
      ${s.refreshChoices.map((minutes) => `<button type="button" class="segment${s.refreshMinutes === minutes ? ' selected' : ''}" ${actionAttrs('setRefreshMinutes', minutes)}>${esc(format('%lld min', minutes))}</button>`).join('')}</div>`,
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
      <button type="button" class="link" ${actionAttrs('openLink', 'project')}>${esc(t('GitHub'))}</button>
      <span class="spacer"></span>
      <button type="button" class="pill" ${actionAttrs('quit')}>${icon('power')}${esc(t('Quit GitBell'))}</button></footer>`;
}

// MARK: - 고르기 메뉴(저장소·정렬·우클릭)

function optionRow({ title, subtitle = '', detail = '', unread = 0, selected = false, symbol = '', attrs = '' }) {
  return `<button type="button" class="option" ${attrs}>
    <span class="check">${selected ? icon('check') : ''}</span>
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
        selected: view.query.repo === repo.repo, attrs: `${actionAttrs('setQuery', { repo: repo.repo })} data-repo-menu="${esc(repo.repo)}"` })).join('')
      + '</div>';
  },
  sortMenu: () => [['newest', 'clock', 'Newest'], ['byRepository', 'folder', 'By repository'], ['unreadFirst', 'circleDot', 'Unread first']]
    .map(([sort, symbol, title]) => optionRow({ title: t(title), symbol, selected: view.query.sort === sort, attrs: actionAttrs('setQuery', { sort }) }))
    .join(''),
  eventMenu: (id) => {
    const event = view.sections.flatMap((section) => section.events).find((e) => e.id === id);
    if (!event) return null;
    return [
      optionRow({ title: t('Open in browser'), attrs: actionAttrs('open', id) }),
      optionRow({ title: t('Copy link'), attrs: actionAttrs('copyLink', id) }),
      '<div class="menu-divider"></div>',
      event.isUnread ? optionRow({ title: t('Mark as read'), attrs: actionAttrs('markRead', id) })
        : optionRow({ title: t('Mark as unread'), attrs: actionAttrs('markUnread', id) }),
      optionRow({ title: format('Show only %@', event.repoName), attrs: actionAttrs('setQuery', { repo: event.repo }) }),
      '<div class="menu-divider"></div>',
      optionRow({ title: format('Hide %@', event.repoName), attrs: actionAttrs('hideRepository', event.repo) }),
    ].join('');
  },
  repoContextMenu: (repo) => optionRow({ title: t('Hide this repository'), attrs: actionAttrs('hideRepository', repo) }),
};

function openMenu(name, arg, anchor) {
  menuBuilder = () => menus[name](arg);
  const html = menuBuilder();
  if (html == null) return closeMenu();
  const menu = $('#menu');
  menu.innerHTML = html;
  menu.hidden = false;
  menu.dataset.menu = name;
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
}

function closeMenu() {
  menuBuilder = null;
  $('#menu').hidden = true;
}

// MARK: - 그리기

function render() {
  if (!view) return;
  const list = $('#list');
  const scrollTop = list ? list.scrollTop : 0;
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
      : renderFilters() + renderProblem() + renderList() + renderUpdate() + renderFooter();
    const newList = $('#list');
    if (newList) newList.scrollTop = scrollTop;
  }
  placeTokenField();
  if (menuBuilder && !$('#menu').hidden) {
    const html = menuBuilder();
    if (html == null) closeMenu();
    else $('#menu').innerHTML = html;
  }
  requestAnimationFrame(reportSize);
}

function reportSize() {
  bridge.resize(document.body.getBoundingClientRect().height);
}

function setMaxHeight(height) {
  if (height > 0) document.documentElement.style.setProperty('--max-height', `${height}px`);
}

/** 패널을 열어 둔 동안에도 '3분 전' 같은 시간이 바뀌게 한다. */
function refreshTimes() {
  for (const element of document.querySelectorAll('[data-time]')) element.textContent = relative(element.dataset.time);
}

// MARK: - 입력

function toggleSearch(force) {
  const on = force == null ? !view.showingSearch : force;
  bridge.action('setShowingSearch', on);
  if (on) setTimeout(() => $('#searchInput').focus(), 0);
  else $('#searchInput').value = '';
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action], [data-ui]');
  const insideMenu = event.target.closest('#menu');
  if (!target) {
    if (!insideMenu) closeMenu();
    return;
  }
  if (target.dataset.ui) {
    const ui = target.dataset.ui;
    if (ui === 'toggleSearch') toggleSearch();
    if (ui === 'copyUpdate') {
      bridge.action('copyUpdateCommand');
      copiedUpdate = true;
      render();
    }
    if (ui === 'repoMenu' || ui === 'sortMenu') {
      if (!$('#menu').hidden && $('#menu').dataset.menu === ui) return closeMenu();
      const rect = target.getBoundingClientRect();
      openMenu(ui, null, { x: rect.left, y: rect.bottom + 4 });
    }
    return;
  }
  const args = JSON.parse(target.dataset.args || '[]');
  if (insideMenu) closeMenu();
  bridge.action(target.dataset.action, ...args);
});

document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  const row = event.target.closest('[data-event]');
  const repo = event.target.closest('[data-repo-menu]');
  if (row) openMenu('eventMenu', row.dataset.event, { x: event.clientX, y: event.clientY });
  else if (repo) openMenu('repoContextMenu', repo.dataset.repoMenu, { x: event.clientX, y: event.clientY });
});

document.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  if (event.ctrlKey && !event.altKey && !event.shiftKey) {
    if (key === 'f' && !view.showingSettings && !view.showsOnboarding) { event.preventDefault(); toggleSearch(); }
    if (key === 'r') { event.preventDefault(); bridge.action('refresh'); }
    if (key === ',') { event.preventDefault(); bridge.action('setShowingSettings', true); }
    return;
  }
  if (event.key === 'Escape') {
    if (!$('#menu').hidden) closeMenu();
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
  document.documentElement.lang = locale.slice(0, 2);
  if (init.accent) document.documentElement.style.setProperty('--accent', init.accent);
  setMaxHeight(init.maxHeight);
  $('#searchIcon').innerHTML = icon('search');
  $('#searchClear').innerHTML = icon('x');
  $('#searchInput').placeholder = t('Search title, repository, person, #number');
  view = init.view;
  render();
  bridge.onView((next) => {
    view = next;
    render();
  });
  bridge.onDrawTray((request) => bridge.sendTrayImage(drawTrayIcons($('#trayCanvas'), request)));
  bridge.onShown((maxHeight) => {
    setMaxHeight(maxHeight);
    copiedUpdate = false;
    refreshTimes();
    if (view.showingSearch) $('#searchInput').focus();
  });
  setInterval(refreshTimes, 30000);
  new ResizeObserver(reportSize).observe(document.body);
}

start();
