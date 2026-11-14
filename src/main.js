// GitBell 진입점(Electron 주 프로세스). macOS 메뉴 막대, Windows 작업 표시줄 트레이, Linux 트레이에 사는 앱이다.
// 트레이 아이콘을 누르면 아이콘 옆에 패널(renderer/index.html)이 열리고, 다른 곳을 누르면 닫힌다.
// 설치·제거는 각 OS의 설치 파일(dmg, NSIS, AppImage·deb)이 맡는다.
//
// 확인·스크린숏용:
//   --demo   가상 자료로 띄운다(GitHub에 요청하지 않고 아무것도 저장하지 않는다)
//   --show   시작하자마자 패널을 연다
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  app, BrowserWindow, Tray, Menu, Notification, nativeImage, nativeTheme, ipcMain, shell, clipboard, safeStorage,
  screen, systemPreferences, powerMonitor, net,
} = require('electron');

const { AppModel, URLS } = require('./app-model');
const { createL10n, prefersKorean } = require('./l10n');
const { createFileStore, createMemoryStore } = require('./file-store');
const { createTokenStore } = require('./token-store');
const { createGitHubAPI, createResponseCache } = require('./core/github-api');
const { panelPosition, MARGIN } = require('./window-position');
const { demoState } = require('./demo-data');
const { repoName } = require('./core/models');
const { linuxAutostart } = require('./autostart');

const BUNDLE_ID = 'io.github.kgyujin.gitbell';
const PANEL_WIDTH = 420;
const NOTIFICATION_LIMIT = 5;
const LATEST_RELEASE_API = 'https://api.github.com/repos/kgyujin/gitbell/releases/latest';
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const isMac = process.platform === 'darwin';
/** 시스템의 알림 설정 화면. Linux는 데스크톱 환경마다 달라 열지 않는다. */
const NOTIFICATION_SETTINGS = {
  win32: 'ms-settings:notifications',
  darwin: 'x-apple.systempreferences:com.apple.Notifications-Settings.extension',
}[process.platform] || null;

const has = (flag) => process.argv.includes(flag);
const isDemo = has('--demo');

if (process.platform === 'win32') app.setAppUserModelId(BUNDLE_ID);
if (process.env.GITBELL_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.GITBELL_DATA_DIR));
} else if (isDemo) {
  // 데모는 실제 데이터 폴더를 건드리지 않고, 실행 중인 실제 GitBell과 중복 실행 잠금도 나누지 않도록 임시 폴더를 쓴다.
  app.setPath('userData', path.join(app.getPath('temp'), 'GitBell-demo'));
}

/** 로그인할 때 GitBell을 켜는 설정. 설치한 앱은 실행 파일만, 개발 중에는 electron에 앱 폴더를 넘긴다. */
const loginItem = (openAtLogin) => (app.isPackaged
  ? { openAtLogin }
  // Windows는 args를 따옴표 없이 이어 붙여 레지스트리에 넣으므로, 사용자 폴더에 빈칸이 있어도 되게 직접 감싼다.
  : { openAtLogin, path: process.execPath, args: [`"${app.getAppPath()}"`] });

/** Linux는 Electron이 로그인 시 실행을 지원하지 않아 ~/.config/autostart에 .desktop 파일을 둔다. */
const autostart = process.platform === 'linux' ? linuxAutostart({
  dir: path.join(app.getPath('appData'), 'autostart'),
  // AppImage는 실행할 때마다 다른 곳에 풀리므로 AppImage 파일 자체를 실행한다.
  command: process.env.APPIMAGE || (app.isPackaged ? process.execPath : `${process.execPath} "${app.getAppPath()}"`),
}) : null;

function getLaunchAtLogin() {
  if (autostart) return autostart.isEnabled();
  return app.getLoginItemSettings(loginItem()).openAtLogin;
}

function setLaunchAtLogin(on) {
  if (isDemo) return;
  if (autostart) autostart.setEnabled(on);
  else app.setLoginItemSettings(loginItem(on));
}

// 이미 실행 중이면 그쪽이 second-instance로 받아 패널을 연다.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => showPanel());
  // 패널은 닫지 않고 숨기므로 창이 없다고 끝나지 않게 한다.
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => { quitting = true; });
  // 메뉴 막대 앱이라 Dock에 아이콘을 두지 않는다(설치한 앱은 Info.plist의 LSUIElement로도 숨긴다).
  if (isMac && app.dock) app.dock.hide();
  app.whenReady().then(start);
}

let model;
let l10n;
let panel;
let tray;
let lastHiddenAt = 0;
let quitting = false;
let lastTrayKey = '';
let lastTrayToolTip = '';
/** 확인 사이에 이어 쓰는 GitHub 응답(조건부 요청용). 토큰이 바뀌면 스스로 비운다. */
const responseCache = createResponseCache();
/** 패널이 숨어 있는 동안 화면 자료가 바뀌었는지. 열 때 한 번만 보낸다(sendView). */
let viewStale = false;
/** 붙잡아 두는 알림 객체의 최대 수(showNotification). */
const MAX_LIVE_NOTIFICATIONS = 100;
const liveNotifications = new Set();
/** 항목 id → 그 항목의 알림. 읽음으로 바꾸면 알림 센터에서도 지운다. */
const notificationsById = new Map();
/** 여러 항목을 묶은 요약 알림. */
const summaryNotifications = new Set();

function start() {
  // 날짜·시각은 시스템 지역 형식을 따른다(언어가 화면 언어와 같을 때, 예: en-GB면 24시간제).
  l10n = createL10n({ korean: prefersKorean(app.getPreferredSystemLanguages()), systemLocale: app.getLocale() });
  const dataDir = app.getPath('userData');
  model = new AppModel({
    store: isDemo ? createMemoryStore() : createFileStore(dataDir),
    tokens: createTokenStore({ file: path.join(dataDir, 'token.bin'), safeStorage }),
    createAPI: (token) => createGitHubAPI({ token, baseURL: process.env.GITBELL_API_URL || undefined, cache: responseCache }),
    notifier: {
      post: postNotifications, postTest: postTestNotification, postUpdate: postUpdateNotification,
      dismiss: dismissNotifications,
    },
    system: {
      openURL: openHTTPS,
      copyText: (text) => clipboard.writeText(text),
      getLaunchAtLogin,
      setLaunchAtLogin,
    },
    l10n,
    version: require('../package.json').version,
    fetchLatestVersion,
    isOnline: () => net.isOnline(),
  });
  if (isDemo) model.loadDemo(demoState());

  // 기본 메뉴의 Ctrl+W(창 닫기) 같은 단축키가 패널에 걸리지 않게 메뉴를 없앤다.
  // macOS는 메뉴가 없으면 토큰 칸에서 ⌘V(붙여넣기)·⌘C·⌘A도 듣지 않아 편집 메뉴만 둔다(메뉴 막대 앱이라 보이지 않는다).
  Menu.setApplicationMenu(isMac ? Menu.buildFromTemplate([{ role: 'editMenu' }]) : null);
  createPanel();
  createTray();
  model.onChange(() => {
    sendView();
    updateTray();
  });
  nativeTheme.on('updated', () => {
    lastTrayKey = '';
    updateTray();
  });
  registerIPC();
  model.start();
  // 잠자기에서 깨면 다음 주기를 기다리지 않고 바로 확인한다(네트워크가 붙을 시간을 조금 준다).
  // 따로 확인하지 않고 주기를 새로 시작해, 깨자마자 두 번 연달아 확인하지 않게 한다.
  powerMonitor.on('resume', () => setTimeout(() => model.restartLoop(), 5000));
}

// MARK: 패널

function createPanel() {
  panel = new BrowserWindow({
    width: PANEL_WIDTH,
    height: 560,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: 'GitBell',
    icon: ICON,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#202020' : '#f3f3f3',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // 글을 쓰는 곳이 토큰·검색칸뿐이라 맞춤법 검사기를 띄우지 않는다(메모리와 사전 내려받기를 아낀다).
      spellcheck: false,
    },
  });
  panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  panel.webContents.on('will-navigate', (event) => event.preventDefault());
  panel.on('blur', () => {
    if (!panel.webContents.isDevToolsOpened()) hidePanel();
  });
  // Alt+F4 등으로 닫아도 창을 없애지 않고 숨긴다. 끝낼 때(before-quit)만 실제로 닫는다.
  panel.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    hidePanel();
  });
  panel.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (has('--show')) panel.webContents.once('did-finish-load', () => showPanel());
}

function hidePanel() {
  if (!panel.isVisible()) return;
  panel.hide();
  lastHiddenAt = Date.now();
}

function showPanel() {
  positionPanel();
  if (viewStale && !panel.webContents.isLoading()) {
    viewStale = false;
    panel.webContents.send('view', model.viewModel());
  }
  panel.show();
  panel.focus();
  panel.webContents.send('shown', maxPanelHeight());
}

function togglePanel() {
  if (panel.isVisible()) return hidePanel();
  // 패널이 열린 채 트레이를 누르면 먼저 blur로 닫히고 곧바로 click이 온다. 그때는 다시 열지 않는다.
  if (Date.now() - lastHiddenAt < 300) return;
  showPanel();
}

function workAreaNearTray() {
  const bounds = tray ? tray.getBounds() : { x: 0, y: 0, width: 0, height: 0 };
  const point = bounds.width ? { x: bounds.x, y: bounds.y } : screen.getCursorScreenPoint();
  return { bounds, workArea: screen.getDisplayNearestPoint(point).workArea };
}

function positionPanel() {
  const { bounds, workArea } = workAreaNearTray();
  const [width, height] = panel.getSize();
  const { x, y } = panelPosition({ trayBounds: bounds, size: { width, height }, workArea });
  panel.setPosition(x, y);
}

function maxPanelHeight() {
  return workAreaNearTray().workArea.height - 2 * MARGIN;
}

/** 내용 높이에 맞춰 패널 높이를 바꾼다(화면보다 커지지 않게). */
function resizePanel(contentHeight) {
  const height = Math.max(120, Math.min(Math.ceil(contentHeight), maxPanelHeight()));
  const [, current] = panel.getContentSize();
  if (current === height) return;
  panel.setContentSize(PANEL_WIDTH, height);
  if (panel.isVisible()) positionPanel();
}

/**
 * 화면 자료를 패널에 보낸다. 패널이 숨어 있으면 보내지 않고 열 때(showPanel) 보낸다.
 * 패널은 대부분의 시간 숨어 있으므로 숨은 동안에는 보내지 않고, 열 때(showPanel) 한 번만 보낸다.
 */
function sendView() {
  if (!panel || panel.webContents.isLoading()) return;
  if (!panel.isVisible()) {
    viewStale = true;
    return;
  }
  viewStale = false;
  panel.webContents.send('view', model.viewModel());
}

// MARK: 트레이

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('GitBell');
  tray.on('click', togglePanel);
  const menu = Menu.buildFromTemplate([
    { label: l10n.t('Open GitBell'), click: () => showPanel() },
    { label: l10n.t('Refresh'), click: () => model.refresh({ readAll: true }) },
    { type: 'separator' },
    { label: l10n.t('Quit GitBell'), click: () => app.quit() },
  ]);
  // macOS는 메뉴를 붙여 두면 왼쪽 클릭도 메뉴를 열어서, 오른쪽 클릭일 때만 메뉴를 띄운다.
  if (isMac) tray.on('right-click', () => tray.popUpContextMenu(menu));
  else tray.setContextMenu(menu);
}

/** 작업 표시줄이 어두운지. 작업 표시줄은 앱 테마가 아니라 Windows 테마를 따른다. */
function darkTaskbar() {
  if (typeof nativeTheme.shouldUseDarkColorsForSystemIntegratedUI === 'boolean') {
    return nativeTheme.shouldUseDarkColorsForSystemIntegratedUI;
  }
  return nativeTheme.shouldUseDarkColors;
}

/** 아이콘 그림은 패널 화면이 canvas로 그려 돌려준다('tray-image'). */
function updateTray() {
  const state = model.trayState();
  // 화면 자료가 바뀔 때마다 불리므로, 설명 글과 그림은 달라졌을 때만 바꾼다.
  const toolTip = state.unread > 0 ? `GitBell · ${l10n.format('%lld unread', state.unread)}` : 'GitBell';
  if (toolTip !== lastTrayToolTip) {
    lastTrayToolTip = toolTip;
    tray.setToolTip(toolTip);
  }
  // macOS 메뉴 막대는 템플릿 그림과 옆 글자로 수를 보인다(배지 색은 메뉴 막대에서 어울리지 않는다).
  if (isMac) {
    const title = state.showsCount && state.unread > 0 && !state.hasProblem ? (state.unread > 99 ? '99+' : String(state.unread)) : '';
    if (tray.getTitle() !== title) tray.setTitle(title, { fontType: 'monospacedDigit' });
  }
  const request = { ...state, dark: darkTaskbar(), template: isMac };
  const key = JSON.stringify(request);
  if (key === lastTrayKey || panel.webContents.isLoading()) return;
  lastTrayKey = key;
  panel.webContents.send('draw-tray', request);
}

function setTrayImage(images) {
  if (!images || typeof images.x1 !== 'string' || typeof images.x2 !== 'string') return;
  const image = nativeImage.createEmpty();
  image.addRepresentation({ scaleFactor: 1, dataURL: images.x1 });
  image.addRepresentation({ scaleFactor: 2, dataURL: images.x2 });
  if (image.isEmpty()) return;
  if (isMac) image.setTemplateImage(true);
  tray.setImage(image);
}

// MARK: 알림

/** GitHub 자료에서 온 주소는 https만 연다. */
function openHTTPS(url) {
  if (/^https:\/\//i.test(url)) shell.openExternal(url);
}

/** onClick이 있으면 주소 대신 그것을 한다(요약 알림은 GitBell 패널을 연다). */
function showNotification({ title, body, playsSound, url, id, onClick, summary = false }) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body, silent: !playsSound, icon: ICON });
  // 알림 객체가 사라지면 누름 이벤트도 사라져서, 닫힐 때까지 붙잡아 둔다.
  liveNotifications.add(notification);
  // Windows는 알림 센터로 넘어간 알림의 'close'를 늦게 보내거나 보내지 않기도 해서, 오래 켜 두면 끝없이 쌓인다.
  // 오래된 것부터 놓아준다(알림 센터에서 지우지는 않는다. 누르면 아무 일도 하지 않을 뿐이다).
  if (liveNotifications.size > MAX_LIVE_NOTIFICATIONS) forgetNotification(liveNotifications.values().next().value);
  if (id) notificationsById.set(id, notification);
  if (summary) summaryNotifications.add(notification);
  notification.on('click', () => {
    if (onClick) onClick();
    else if (url) openHTTPS(url);
    // 알림을 눌러 페이지를 열었으니 같은 PR의 다른 안 읽은 항목도 읽음이 된다.
    if (id) model.markOpened(id);
  });
  notification.on('close', () => forgetNotification(notification));
  notification.show();
}

function forgetNotification(notification) {
  liveNotifications.delete(notification);
  summaryNotifications.delete(notification);
  for (const [id, value] of notificationsById) {
    if (value === notification) notificationsById.delete(id);
  }
}

/** GitBell에서 읽은 항목의 알림을 알림 센터에서 지운다. */
function dismissNotifications(ids, includeSummaries) {
  for (const id of ids) {
    const notification = notificationsById.get(id);
    if (notification) notification.close();
  }
  if (includeSummaries) for (const notification of [...summaryNotifications]) notification.close();
}

/** 한 번에 새 항목이 많으면(5개 초과) 요약 알림 하나로 묶는다. */
function postNotifications(events, playsSound) {
  if (events.length > NOTIFICATION_LIMIT) {
    const repos = [...new Set(events.map((event) => repoName(event.repo)))].sort().join(', ');
    // 요약은 하나만 둔다. 새 요약을 보내기 전에 예전 요약을 닫아, 확인할 때마다 요약이 쌓이지 않게 한다.
    for (const old of [...summaryNotifications]) old.close();
    // 많이 쌓였을 때는 GitHub 알림 페이지보다 GitBell 목록이 보기 쉬워 패널을 연다.
    showNotification({ title: 'GitBell', body: `${l10n.format('%lld new activities', events.length)}\n${repos}`,
      playsSound, onClick: () => showPanel(), summary: true });
    return;
  }
  // 한 번에 여러 개가 오면 소리는 첫 알림에서 한 번만 낸다.
  events.forEach((event, index) => {
    showNotification({ title: repoName(event.repo), body: `${l10n.headline(event)}\n${l10n.title(event)}`,
      playsSound: playsSound && index === 0, url: event.url, id: event.id });
  });
}

function postTestNotification(playsSound) {
  showNotification({ title: 'GitBell', body: `${l10n.t('Test notification')}\n${l10n.t('Notifications are working. Click to open GitHub.')}`,
    playsSound, url: URLS.notifications });
}

/** 새 버전 알림. 누르면 내려받기 페이지(GitHub Releases)를 연다. */
function postUpdateNotification(version, playsSound) {
  showNotification({
    title: 'GitBell',
    body: `${l10n.format('GitBell %@ is available', version)}\n${l10n.t('Click to open the download page.')}`,
    playsSound,
    onClick: () => model.openUpdate(),
  });
}

/** GitHub Releases의 최신 버전('v0.6.0' → '0.6.0'). 토큰 없이 1시간에 한 번 묻는다(주소당 시간당 60회 한도 안). */
async function fetchLatestVersion() {
  const response = await fetch(LATEST_RELEASE_API, {
    headers: { 'User-Agent': 'GitBell', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) return null;
  const body = await response.json();
  return typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/, '') : null;
}

// MARK: 화면과 주고받기

/** 화면이 부를 수 있는 동작. 이름으로만 부르고, 주소 같은 값은 앱이 정한다. */
function registerIPC() {
  const actions = {
    // 사용자가 직접 누른 새로고침이라 조용한 저장소도 모두 읽는다.
    refresh: () => model.refresh({ readAll: true }),
    setQuery: (patch) => model.setQuery(patch),
    resetFilters: () => model.resetFilters(),
    setShowingSearch: (on) => model.setShowingSearch(on),
    setShowingSettings: (on) => model.setShowingSettings(on),
    setShowingChart: (on) => model.setShowingChart(on),
    open: (id) => model.open(id),
    markRead: (id) => model.markRead(id),
    markRepoRead: (repo) => model.markRepoRead(repo),
    markSectionRead: (sectionId) => model.markSectionRead(sectionId),
    undoMarkRead: () => model.undoMarkRead(),
    markUnread: (id) => model.markUnread(id),
    copyLink: (id) => model.copyLink(id),
    hideRepository: (repo) => model.hideRepository(repo),
    showRepository: (repo) => model.showRepository(repo),
    openLink: (target) => model.openLink(target),
    setNotificationPrefs: (patch) => model.setNotificationPrefs(patch),
    setGroup: (group, enabled) => model.setGroup(group, enabled),
    setDisplay: (patch) => model.setDisplay(patch),
    setRefreshMinutes: (minutes) => model.setRefreshMinutes(minutes),
    setIncludeOwnActivity: (on) => model.setIncludeOwnActivity(on),
    setShowsCountInTray: (on) => model.setShowsCountInTray(on),
    setLaunchAtLogin: (on) => model.setLaunchAtLogin(on),
    sendTestNotification: () => model.sendTestNotification(),
    openUpdate: () => model.openUpdate(),
    networkOnline: () => model.networkOnline(),
    saveToken: (token) => model.saveToken(token),
    removeSavedToken: () => model.removeSavedToken(),
    openNotificationSettings: () => { if (NOTIFICATION_SETTINGS) shell.openExternal(NOTIFICATION_SETTINGS); },
    hidePanel: () => hidePanel(),
    quit: () => app.quit(),
  };
  const fromPanel = (event) => event.sender === panel.webContents;

  ipcMain.handle('init', (event) => {
    if (!fromPanel(event)) return null;
    const accent = process.platform === 'win32' ? systemPreferences.getAccentColor() : '';
    return {
      locale: l10n.locale,
      platform: process.platform,
      strings: l10n.korean ? Object.fromEntries(require('./l10n').loadKoreanStrings()) : {},
      singular: require('./l10n').SINGULAR,
      accent: /^[0-9a-f]{6}/i.test(accent) ? `#${accent.slice(0, 6)}` : null,
      maxHeight: maxPanelHeight(),
      view: model.viewModel(),
    };
  });
  ipcMain.handle('action', async (event, name, ...args) => {
    if (!fromPanel(event) || !Object.hasOwn(actions, name)) return;
    await actions[name](...args);
  });
  ipcMain.on('resize', (event, height) => {
    if (fromPanel(event) && Number.isFinite(height)) resizePanel(height);
  });
  ipcMain.on('tray-image', (event, images) => {
    if (fromPanel(event)) setTrayImage(images);
  });
  panel.webContents.on('did-finish-load', () => {
    lastTrayKey = '';
    updateTray();
  });
}
