// GitBell Windows판 진입점(Electron 주 프로세스). 작업 표시줄 트레이에만 사는 앱이다.
// 트레이 아이콘을 누르면 아이콘 옆에 패널(renderer/index.html)이 열리고, 다른 곳을 누르면 닫힌다.
//
// 설치기(bin/gitbell.js)가 쓰는 명령:
//   --create-shortcut  시작 메뉴 바로가기를 만들고 끝낸다(알림에 앱 이름과 아이콘이 보이려면 필요하다)
//   --quit             실행 중인 GitBell을 끝낸다
//   --uninstall        실행 중인 GitBell을 끝내고, 로그인 시 실행·시작 메뉴 바로가기·설치된 앱 등록을 지운다
// Windows "설정 → 앱 → 설치된 앱"의 제거 버튼이 쓰는 명령(uninstall.js 참고):
//   --uninstall-app [--quiet]  확인 창을 띄우고(--quiet면 생략) 앱을 지운다
// 확인·스크린숏용:
//   --demo   가상 자료로 띄운다(GitHub에 요청하지 않고 아무것도 저장하지 않는다)
//   --show   시작하자마자 패널을 연다
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  app, BrowserWindow, Tray, Menu, Notification, nativeImage, nativeTheme, ipcMain, shell, clipboard, safeStorage,
  screen, systemPreferences, dialog, powerMonitor,
} = require('electron');

const { AppModel, URLS } = require('./app-model');
const { createL10n, prefersKorean } = require('./l10n');
const { createFileStore, createMemoryStore } = require('./file-store');
const { createTokenStore } = require('./token-store');
const { createGitHubAPI } = require('./core/github-api');
const { panelPosition, MARGIN } = require('./window-position');
const { demoState } = require('./demo-data');
const { repoName } = require('./core/models');
const Uninstall = require('./uninstall');

const BUNDLE_ID = Uninstall.BUNDLE_ID;
const PANEL_WIDTH = 420;
const NOTIFICATION_LIMIT = 5;
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const ICON_ICO = path.join(__dirname, '..', 'assets', 'icon.ico');

const has = (flag) => process.argv.includes(flag);
const isDemo = has('--demo');
const TASKS = ['--create-shortcut', '--quit', '--uninstall', '--uninstall-app'];
const task = TASKS.find(has);

if (process.platform === 'win32') app.setAppUserModelId(BUNDLE_ID);
if (process.env.GITBELL_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.GITBELL_DATA_DIR));
} else if (isDemo) {
  // 데모는 실제 데이터 폴더(%APPDATA%\GitBell, macOS에서는 macOS판과 같은 폴더)를 건드리지 않고,
  // 실행 중인 실제 GitBell과 중복 실행 잠금도 나누지 않도록 임시 폴더를 쓴다.
  app.setPath('userData', path.join(app.getPath('temp'), 'GitBell-demo'));
}

const shortcutPath = () => path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'GitBell.lnk');
// Windows는 args를 따옴표 없이 이어 붙여 레지스트리에 넣으므로, 사용자 폴더에 빈칸이 있어도 되게 직접 감싼다.
const loginItem = (openAtLogin) => ({ openAtLogin, path: process.execPath, args: [`"${app.getAppPath()}"`] });

function runTask() {
  if (task === '--create-shortcut' && process.platform === 'win32') {
    const link = shortcutPath();
    shell.writeShortcutLink(link, fs.existsSync(link) ? 'replace' : 'create', {
      target: process.execPath,
      args: `"${app.getAppPath()}"`,
      appUserModelId: BUNDLE_ID,
      icon: ICON_ICO,
      iconIndex: 0,
      description: 'GitHub activity in your tray',
    });
  }
  if (task === '--uninstall') {
    if (process.platform === 'win32') app.setLoginItemSettings(loginItem(false));
    fs.rmSync(shortcutPath(), { force: true });
    if (process.platform === 'win32') Uninstall.removeIntegration();
  }
}

/** 제거할지 묻는다. 설정·기록·토큰도 지울지 고를 수 있다(기본은 남긴다). */
async function confirmUninstall(texts) {
  const { response, checkboxChecked } = await dialog.showMessageBox({
    type: 'question',
    title: texts.t('Uninstall GitBell'),
    message: texts.t('Uninstall GitBell from this PC?'),
    checkboxLabel: texts.t('Also delete settings, history and the saved token'),
    buttons: [texts.t('Uninstall'), texts.t('Cancel')],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    icon: nativeImage.createFromPath(ICON),
  });
  return { ok: response === 0, purge: checkboxChecked };
}

/**
 * 앱을 지운다: 로그인 시 실행·바로가기·설치된 앱 등록을 지우고, 이 프로세스가 끝난 뒤 앱 폴더(와 고르면 설정 폴더)를 지운다.
 * 설치기가 설치한 자리에서 돌 때만 폴더를 지운다(개발 중인 소스 폴더는 건드리지 않는다).
 */
function uninstallApp({ purge }) {
  if (process.platform !== 'win32') return;
  app.setLoginItemSettings(loginItem(false));
  Uninstall.removeIntegration();
  const dirs = [];
  if (Uninstall.isStandardInstall(app.getAppPath())) dirs.push(Uninstall.installPaths().installDir);
  if (purge) dirs.push(app.getPath('userData'));
  Uninstall.scheduleRemoval(dirs);
}

/** 설정 → 앱에서 "제거"를 눌렀을 때(별도 프로세스). 실행 중인 GitBell은 확인한 뒤에 끝낸다. */
async function runUninstallApp() {
  const texts = createL10n({ korean: prefersKorean(app.getPreferredSystemLanguages()) });
  const { ok, purge } = has('--quiet') ? { ok: true, purge: false } : await confirmUninstall(texts);
  if (!ok) return;
  spawnSync(process.execPath, [app.getAppPath(), '--quit'], { timeout: 30000, windowsHide: true });
  uninstallApp({ purge });
}

// 이미 실행 중이면 그쪽이 second-instance로 명령을 받는다(--quit·--uninstall이면 끝나고, 아니면 패널을 연다).
const gotLock = app.requestSingleInstanceLock();
if (task) {
  app.whenReady().then(async () => {
    if (task === '--uninstall-app') await runUninstallApp();
    else runTask();
    app.exit(0);
  });
} else if (!gotLock) {
  app.exit(0);
} else {
  app.on('second-instance', (_event, argv) => {
    if (argv.includes('--quit') || argv.includes('--uninstall')) app.quit();
    else if (!TASKS.some((flag) => argv.includes(flag))) showPanel();
  });
  // 패널은 닫지 않고 숨기므로 창이 없다고 끝나지 않게 한다.
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => { quitting = true; });
  app.whenReady().then(start);
}

let model;
let l10n;
let panel;
let tray;
let lastHiddenAt = 0;
let quitting = false;
let lastTrayKey = '';
const liveNotifications = new Set();

function start() {
  l10n = createL10n({ korean: prefersKorean(app.getPreferredSystemLanguages()) });
  const dataDir = app.getPath('userData');
  model = new AppModel({
    store: isDemo ? createMemoryStore() : createFileStore(dataDir),
    tokens: createTokenStore({ file: path.join(dataDir, 'token.bin'), safeStorage }),
    createAPI: (token) => createGitHubAPI({ token, baseURL: process.env.GITBELL_API_URL || undefined }),
    notifier: { post: postNotifications, postTest: postTestNotification },
    system: {
      openURL: openHTTPS,
      copyText: (text) => clipboard.writeText(text),
      getLaunchAtLogin: () => process.platform === 'win32' && app.getLoginItemSettings(loginItem()).openAtLogin,
      setLaunchAtLogin: (on) => {
        if (process.platform === 'win32' && !isDemo) app.setLoginItemSettings(loginItem(on));
      },
    },
    l10n,
    version: require('../package.json').version,
    fetchLatestVersion,
  });
  if (isDemo) model.loadDemo(demoState());

  // 기본 메뉴의 Ctrl+W(창 닫기) 같은 단축키가 패널에 걸리지 않게 메뉴를 없앤다.
  Menu.setApplicationMenu(null);
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
  powerMonitor.on('resume', () => setTimeout(() => model.refresh(), 5000));
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

function sendView() {
  if (panel && !panel.webContents.isLoading()) panel.webContents.send('view', model.viewModel());
}

// MARK: 트레이

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('GitBell');
  tray.on('click', togglePanel);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: l10n.t('Open GitBell'), click: showPanel },
    { label: l10n.t('Refresh'), click: () => model.refresh() },
    { type: 'separator' },
    // 설치기가 설치한 앱에서만 보인다(개발 중에는 지울 폴더가 없다).
    ...(process.platform === 'win32' && Uninstall.isStandardInstall(app.getAppPath())
      ? [{ label: l10n.t('Uninstall GitBell…'), click: uninstallFromTray }] : []),
    { label: l10n.t('Quit GitBell'), click: () => app.quit() },
  ]));
}

async function uninstallFromTray() {
  const { ok, purge } = await confirmUninstall(l10n);
  if (!ok) return;
  model.stop();
  uninstallApp({ purge });
  app.exit(0);
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
  tray.setToolTip(state.unread > 0 ? `GitBell · ${l10n.format('%lld unread', state.unread)}` : 'GitBell');
  const request = { ...state, dark: darkTaskbar() };
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
  if (!image.isEmpty()) tray.setImage(image);
}

// MARK: 알림

/** GitHub 자료에서 온 주소는 https만 연다. */
function openHTTPS(url) {
  if (/^https:\/\//i.test(url)) shell.openExternal(url);
}

function showNotification({ title, body, playsSound, url, id }) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body, silent: !playsSound, icon: ICON });
  // 알림 객체가 사라지면 누름 이벤트도 사라져서, 닫힐 때까지 붙잡아 둔다.
  liveNotifications.add(notification);
  notification.on('click', () => {
    if (url) openHTTPS(url);
    if (id) model.markRead(id);
  });
  notification.on('close', () => liveNotifications.delete(notification));
  notification.show();
}

/** 한 번에 새 항목이 많으면(5개 초과) 요약 알림 하나로 묶는다. */
function postNotifications(events, playsSound) {
  if (events.length > NOTIFICATION_LIMIT) {
    const repos = [...new Set(events.map((event) => repoName(event.repo)))].sort().join(', ');
    showNotification({ title: 'GitBell', body: `${l10n.format('%lld new activities', events.length)}\n${repos}`,
      playsSound, url: URLS.notifications });
    return;
  }
  for (const event of events) {
    showNotification({ title: repoName(event.repo), body: `${l10n.headline(event)}\n${l10n.title(event)}`,
      playsSound, url: event.url, id: event.id });
  }
}

function postTestNotification(playsSound) {
  showNotification({ title: 'GitBell', body: `${l10n.t('Test notification')}\n${l10n.t('Notifications are working. Click to open GitHub.')}`,
    playsSound, url: URLS.notifications });
}

async function fetchLatestVersion() {
  const response = await fetch('https://registry.npmjs.org/gitbell/latest', {
    headers: { 'User-Agent': 'GitBell' },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) return null;
  const body = await response.json();
  return typeof body.version === 'string' ? body.version : null;
}

// MARK: 화면과 주고받기

/** 화면이 부를 수 있는 동작. 이름으로만 부르고, 주소 같은 값은 앱이 정한다. */
function registerIPC() {
  const actions = {
    refresh: () => model.refresh(),
    setQuery: (patch) => model.setQuery(patch),
    resetFilters: () => model.resetFilters(),
    setShowingSearch: (on) => model.setShowingSearch(on),
    setShowingSettings: (on) => model.setShowingSettings(on),
    open: (id) => model.open(id),
    markRead: (id) => model.markRead(id),
    markRepoRead: (repo) => model.markRepoRead(repo),
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
    copyUpdateCommand: () => model.copyUpdateCommand(),
    saveToken: (token) => model.saveToken(token),
    removeSavedToken: () => model.removeSavedToken(),
    openNotificationSettings: () => shell.openExternal('ms-settings:notifications'),
    hidePanel: () => hidePanel(),
    quit: () => app.quit(),
  };
  const fromPanel = (event) => event.sender === panel.webContents;

  ipcMain.handle('init', (event) => {
    if (!fromPanel(event)) return null;
    const accent = process.platform === 'win32' ? systemPreferences.getAccentColor() : '';
    return {
      locale: l10n.locale,
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
