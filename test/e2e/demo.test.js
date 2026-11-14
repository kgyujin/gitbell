// 가상 자료(--demo)로 패널을 띄워 필터·검색·정렬·우클릭 메뉴·설정·트레이 아이콘을 확인한다.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { launch, isolatedEnv, screenshot } = require('./helpers');

const rows = (window) => window.locator('.row-item');
const itemsLabel = (window) => window.locator('[data-test="visible-count"]').textContent();

test('데모 패널: 목록·필터·검색·정렬·우클릭·설정', async (t) => {
  const { app, window, errors } = await launch({ args: ['--demo'] });
  t.after(() => app.close());

  await window.waitForSelector('.row-item');
  assert.equal(await rows(window).count(), 9);
  assert.equal(await window.locator('.header .count-badge').textContent(), '3', '안 읽은 수');
  assert.equal(await itemsLabel(window), '9 items');
  await screenshot(window, 'demo-light');

  // 종류 필터
  await window.getByRole('button', { name: 'PRs', exact: true }).click();
  await window.waitForFunction(() => document.querySelectorAll('.row-item').length === 3);
  assert.equal(await itemsLabel(window), '3 items');
  await window.getByRole('button', { name: 'Reset', exact: true }).click();
  await window.waitForFunction(() => document.querySelectorAll('.row-item').length === 9);

  // 안 읽음만 · 내 PR
  await window.getByRole('button', { name: 'Unread', exact: true }).click();
  await window.waitForFunction(() => document.querySelectorAll('.row-item').length === 3);
  await window.getByRole('button', { name: 'Unread', exact: true }).click();
  await window.getByRole('button', { name: 'Mine', exact: true }).click();
  await window.waitForFunction(() => document.querySelectorAll('.row-item').length === 2);
  await window.getByRole('button', { name: 'Mine', exact: true }).click();

  // 검색(Ctrl+F)은 한 글자씩 쳐도 입력칸을 다시 그리지 않는다.
  await window.keyboard.press('ControlOrMeta+f');
  const search = window.locator('#searchInput');
  await search.waitFor({ state: 'visible' });
  await search.pressSequentially('contrast', { delay: 20 });
  await window.waitForFunction(() => document.querySelectorAll('.row-item').length === 2);
  assert.equal(await search.inputValue(), 'contrast');
  assert.equal(await window.evaluate(() => document.activeElement.id), 'searchInput', '입력 중에 초점을 잃지 않는다');
  await window.keyboard.press('Escape');
  await window.waitForFunction(() => document.querySelectorAll('.row-item').length === 9);
  assert.equal(await search.isVisible(), false);

  // 정렬: 저장소별
  await window.locator('[data-ui="sortMenu"]').click();
  await window.locator('#menu').getByRole('menuitemradio', { name: 'By repository' }).click();
  await window.waitForSelector('[data-section="repository:acme/web"]');
  assert.deepEqual(await window.locator('.section-header .plain').allTextContents(), ['web', 'api', 'design-system']);
  await screenshot(window, 'demo-by-repository');

  // 저장소 하나 읽음 표시
  await window.locator('[data-section="repository:acme/web"] .section-header').getByRole('button', { name: 'Mark as read' }).click();
  await window.waitForFunction(() => document.querySelector('.header .count-badge').textContent === '1');

  // 우클릭 메뉴로 저장소 숨기기 → 설정의 숨긴 저장소에서 다시 보이기
  await window.locator('.row-item', { hasText: 'Button contrast' }).click({ button: 'right' });
  await window.locator('#menu').getByRole('menuitem', { name: 'Hide design-system' }).click();
  await window.waitForFunction(() => !document.querySelector('[data-section="repository:acme/design-system"]'));
  assert.equal(await rows(window).count(), 6);

  await window.keyboard.press('ControlOrMeta+,');
  await window.waitForSelector('#settings:not([hidden])');
  await screenshot(window, 'demo-settings');
  assert.ok(await window.locator('.hidden-repo', { hasText: 'acme/design-system' }).isVisible());
  await window.locator('.hidden-repo').getByRole('button', { name: 'Show' }).click();
  await window.waitForFunction(() => !document.querySelector('.hidden-repo'));

  // 알림 스위치를 끄면 종류별 스위치는 누를 수 없다.
  await window.getByRole('switch', { name: /Notify me/ }).click();
  await window.waitForFunction(() => document.querySelector('[role="switch"][aria-checked="false"]'));
  assert.equal(await window.getByRole('switch', { name: /New pull requests/ }).isDisabled(), true);

  await window.getByRole('button', { name: 'Back' }).click();
  await window.waitForSelector('#main:not([hidden])');
  assert.equal(await rows(window).count(), 9);

  assert.deepEqual(errors, []);
});

test('데모 패널: 트레이 아이콘을 그린다', async (t) => {
  const { app, window } = await launch({ args: ['--demo'] });
  t.after(() => app.close());
  await window.waitForSelector('.row-item');
  const images = await window.evaluate(() => [
    drawTrayIcons(document.querySelector('#trayCanvas'), { unread: 3, showsCount: true, hasProblem: false, dark: true }),
    drawTrayIcons(document.querySelector('#trayCanvas'), { unread: 0, showsCount: true, hasProblem: true, dark: false }),
  ]);
  for (const { x1, x2 } of images) {
    assert.match(x1, /^data:image\/png;base64,/);
    assert.match(x2, /^data:image\/png;base64,/);
  }
  assert.notEqual(images[0].x2, images[1].x2);
});

test('데모 패널: 창을 닫아도(Alt+F4) 없어지지 않고 숨는다', async (t) => {
  const { app, window } = await launch({ args: ['--demo'] });
  t.after(() => app.close());
  await window.waitForSelector('.row-item');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  const state = await app.evaluate(({ BrowserWindow }) => {
    const panel = BrowserWindow.getAllWindows()[0];
    return { exists: Boolean(panel) && !panel.isDestroyed(), visible: panel ? panel.isVisible() : null };
  });
  assert.deepEqual(state, { exists: true, visible: false });
});

test('데모 패널: 한국어와 어두운 테마', async (t) => {
  const { app, window, errors } = await launch({ args: ['--demo'], env: isolatedEnv({ GITBELL_LANG: 'ko' }) });
  t.after(() => app.close());
  await window.emulateMedia({ colorScheme: 'dark' });
  await window.waitForSelector('.row-item');
  await window.waitForFunction(() => matchMedia('(prefers-color-scheme: dark)').matches, null, { timeout: 5000 });
  assert.equal(await itemsLabel(window), '9개');
  assert.ok(await window.getByRole('button', { name: '전체', exact: true }).isVisible());
  assert.ok(await window.getByText('승인', { exact: true }).isVisible());
  assert.ok(await window.getByText('커밋 3개 push').isVisible());
  await screenshot(window, 'demo-ko-dark');
  await window.keyboard.press('ControlOrMeta+,');
  await window.waitForSelector('#settings:not([hidden])');
  assert.ok(await window.getByText('트레이 아이콘에 안 읽은 수 표시').isVisible());
  await screenshot(window, 'demo-ko-settings');
  assert.deepEqual(errors, []);
});

test('데모 패널: 고르기 메뉴를 키보드로 쓴다', async (t) => {
  const { app, window, errors } = await launch({ args: ['--demo'] });
  t.after(() => app.close());
  await window.waitForSelector('.row-item');
  const focused = () => window.evaluate(() => {
    const element = document.activeElement;
    return { text: element.textContent.trim(), ui: element.dataset.ui || null, checked: element.getAttribute('aria-checked') };
  });

  // 정렬 메뉴: Enter로 열면 골라진 항목에 초점이 가고, 화살표로 옮겨 Enter로 고른다.
  const sort = window.locator('[data-ui="sortMenu"]');
  await sort.focus();
  await window.keyboard.press('Enter');
  await window.waitForSelector('#menu:not([hidden])');
  assert.equal(await sort.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(await focused(), { text: 'Newest', ui: null, checked: 'true' });
  await window.keyboard.press('ArrowDown');
  assert.equal((await focused()).text, 'By repository');
  await window.keyboard.press('ArrowUp');
  await window.keyboard.press('ArrowUp');
  assert.equal((await focused()).text, 'Unread first', '위로 끝까지 가면 맨 아래로 돈다');
  await window.keyboard.press('ArrowUp');
  await window.keyboard.press('Enter');
  await window.waitForSelector('[data-section="repository:acme/web"]');
  assert.equal(await window.locator('#menu').isHidden(), true);
  assert.equal((await focused()).ui, 'sortMenu', '고르면 초점이 메뉴 버튼으로 돌아온다');
  assert.equal(await window.locator('[data-ui="sortMenu"]').getAttribute('aria-expanded'), 'false');

  // Esc로 닫으면 초점이 메뉴 버튼으로 돌아온다.
  await window.keyboard.press('Enter');
  await window.waitForSelector('#menu:not([hidden])');
  await window.keyboard.press('Escape');
  assert.equal(await window.locator('#menu').isHidden(), true);
  assert.equal((await focused()).ui, 'sortMenu');
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true,
    '메뉴만 닫히고 패널은 그대로');

  // 항목에서 Shift+F10을 누르면 그 항목의 메뉴가 열린다.
  await window.locator('.row-item').first().focus();
  await window.keyboard.press('Shift+F10');
  await window.waitForSelector('#menu:not([hidden])');
  assert.equal((await focused()).text, 'Open in browser');
  await window.keyboard.press('Escape');
  assert.equal(await window.evaluate(() => document.activeElement.classList.contains('row-item')), true);

  // 칩을 Enter로 눌러 목록을 다시 그려도 초점이 그 칩에 남는다(이어서 Tab·Enter를 쓸 수 있게).
  await window.getByRole('button', { name: 'Unread', exact: true }).focus();
  await window.keyboard.press('Enter');
  await window.waitForFunction(() => document.querySelectorAll('.row-item').length === 3);
  assert.equal(await window.evaluate(() => [document.activeElement.textContent.trim(), document.activeElement.getAttribute('aria-pressed')].join()),
    'Unread,true');
  assert.deepEqual(errors, []);
});

test('데모 패널: 열지 않고 읽음 표시·묶음 읽음·되돌리기', async (t) => {
  const { app, window, errors } = await launch({ args: ['--demo'] });
  t.after(() => app.close());
  await window.waitForSelector('.row-item');
  const badge = () => window.locator('.header .count-badge').textContent().catch(() => '0');

  // 안 읽은 줄에 마우스를 올리면 '읽음 표시' 단추가 나오고, 누르면 페이지를 열지 않고 읽음이 된다.
  const firstWrap = window.locator('.row-wrap').first();
  const readButton = firstWrap.locator('.row-read');
  assert.equal(await readButton.evaluate((el) => getComputedStyle(el).opacity), '0', '평소에는 숨긴다');
  await firstWrap.hover();
  assert.equal(await readButton.evaluate((el) => getComputedStyle(el).opacity), '1');
  await readButton.click();
  await window.waitForFunction(() => document.querySelector('.header .count-badge').textContent === '2');
  assert.equal(await window.locator('.undo-bar').count(), 0, '한 항목은 되돌리기를 띄우지 않는다');
  await screenshot(window, 'demo-row-read');

  // 날짜 묶음(오늘)에도 '읽음 표시'가 있고, 누르면 되돌리기가 잠시 보인다.
  const todayHeader = window.locator('section').first().locator('.section-header');
  assert.equal(await todayHeader.locator('.secondary').textContent(), 'Today');
  await todayHeader.getByRole('button', { name: 'Mark as read' }).click();
  await window.waitForSelector('.undo-bar');
  assert.equal(await window.locator('.header .count-badge').count(), 0, '안 읽은 것이 없다');
  assert.match(await window.locator('.undo-bar').textContent(), /Marked 2 items as read/);
  await screenshot(window, 'demo-undo');

  // Ctrl+Z로 되돌린다.
  await window.locator('.row-item').first().focus();
  await window.keyboard.press('ControlOrMeta+z');
  await window.waitForFunction(() => document.querySelector('.header .count-badge')?.textContent === '2');
  assert.equal(await window.locator('.undo-bar').count(), 0);

  // 단추로도 되돌린다.
  await window.getByRole('button', { name: 'Mark everything shown as read' }).click();
  await window.waitForSelector('.undo-bar');
  await window.locator('.undo-bar').getByRole('button', { name: 'Undo' }).click();
  await window.waitForFunction(() => document.querySelector('.header .count-badge')?.textContent === '2');
  assert.equal(await badge(), '2');
  assert.deepEqual(errors, []);
});

test('데모 패널: 새 항목이 쌓여도 보던 자리를 지키고, 다시 열면 맨 위부터', async (t) => {
  const { app, window, errors } = await launch({ args: ['--demo'] });
  t.after(() => app.close());
  await window.waitForSelector('.row-item');
  // 목록이 스크롤될 만큼 길도록 창 높이를 줄인다.
  await window.evaluate(() => document.documentElement.style.setProperty('--max-height', '320px'));
  const scrollTop = () => window.evaluate(() => document.querySelector('#list').scrollTop);
  // 새 항목이 맨 위에 쌓인 것처럼 화면 자료를 바꿔 다시 그린다(panel.js의 view·render).
  const pushNewEvent = (n) => window.evaluate((n) => {
    const [first, ...rest] = view.sections;
    const event = { ...first.events[0], id: `new-${n}`, title: `New activity ${n}` };
    view = { ...view, sections: [{ ...first, events: [event, ...first.events] }, ...rest] };
    render();
  }, n);

  // 맨 위에 있으면 새 항목이 바로 보인다.
  assert.equal(await scrollTop(), 0);
  await pushNewEvent(1);
  assert.equal(await scrollTop(), 0);
  assert.equal(await window.locator('.row-item').first().getAttribute('data-event'), 'new-1');

  // 내려서 보던 중이면 보던 항목이 같은 자리에 머문다(새 항목에 밀려 내려가지 않는다).
  await window.evaluate(() => { document.querySelector('#list').scrollTop = 150; });
  const visibleRow = () => window.evaluate(() => {
    const list = document.querySelector('#list');
    const top = list.getBoundingClientRect().top;
    const row = [...list.querySelectorAll('.row-item')].find((item) => item.getBoundingClientRect().bottom > top);
    return { id: row.dataset.event, offset: Math.round(row.getBoundingClientRect().top - top) };
  });
  const before = await visibleRow();
  assert.ok(await scrollTop() > 0, '목록이 스크롤될 만큼 길다');
  await pushNewEvent(2);
  assert.deepEqual(await visibleRow(), before);

  // 패널을 숨겼다가 다시 열면 맨 위(가장 새 항목)부터 보인다.
  await app.evaluate(({ BrowserWindow }) => {
    const panel = BrowserWindow.getAllWindows()[0];
    panel.hide();
    panel.webContents.send('shown', 600, {});
  });
  await window.waitForFunction(() => document.querySelector('#list').scrollTop === 0);
  assert.deepEqual(errors, []);
});

test('데모 패널: 숨은 동안에는 다시 그리지 않고, 열 때 바뀐 자료를 보인다', async (t) => {
  const { app, window, errors } = await launch({ args: ['--demo'] });
  t.after(() => app.close());
  await window.waitForSelector('.row-item');
  const unreadOnly = () => window.evaluate(() => view.query.unreadOnly);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  // 숨은 동안 필터가 바뀌어도(예: 다른 곳에서 바꾼 설정) 화면 자료를 보내지 않는다.
  await window.evaluate(() => window.gitbell.action('setQuery', { unreadOnly: true }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await unreadOnly(), false, '숨은 패널에는 보내지 않는다');
  // 다시 열면(두 번째 실행 = 트레이 아이콘을 누른 것과 같은 동작) 바뀐 자료가 바로 보인다.
  await app.evaluate(({ app }) => app.emit('second-instance', {}, ['GitBell.exe'], '.'));
  await window.waitForFunction(() => view.query.unreadOnly === true);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
  assert.deepEqual(errors, []);
});

test('데모 패널: Ctrl+F 뒤 바로 친 글자가 검색칸에 들어간다', async (t) => {
  const { app, window, errors } = await launch({ args: ['--demo'] });
  t.after(() => app.close());
  await window.waitForSelector('.row-item');
  // 예전에는 검색칸이 보이기 전에 초점을 주어 실패해서, 바로 친 글자가 사라졌다.
  await window.keyboard.press('ControlOrMeta+f');
  await window.keyboard.type('contrast');
  await window.waitForFunction(() => document.querySelector('#searchInput').value === 'contrast');
  await window.waitForFunction(() => document.querySelectorAll('.row-item').length === 2);
  assert.deepEqual(errors, []);
});

test('데모 패널: 트레이 배지가 99+여도 아이콘 밖으로 잘리지 않는다', async (t) => {
  const { app, window } = await launch({ args: ['--demo'] });
  t.after(() => app.close());
  await window.waitForSelector('.row-item');
  // 32px 아이콘의 맨 왼쪽 열은 비어 있어야 한다(배지가 넘치면 빨간 픽셀이 닿는다).
  const leftColumnAlpha = await window.evaluate(() => {
    const canvas = document.querySelector('#trayCanvas');
    drawTrayIcon(canvas, 32, { unread: 128, showsCount: true, hasProblem: false, dark: false });
    const pixels = canvas.getContext('2d').getImageData(0, 0, 1, 20).data;
    return Math.max(...pixels.filter((_, index) => index % 4 === 3));
  });
  assert.equal(leftColumnAlpha, 0);
});

test('데모 패널: 키보드 초점은 동작 뒤에도 사라지지 않는다', async (t) => {
  const { app, window, errors } = await launch({ args: ['--demo'] });
  t.after(() => app.close());
  await window.waitForSelector('.row-item');
  const focused = () => window.evaluate(() => {
    const element = document.activeElement;
    // 줄은 화면 읽기용 이름이 길어서 줄 id로 가린다.
    return element === document.body ? 'body' : (element.dataset.event || element.getAttribute('aria-label')
      || element.dataset.ui || element.id || element.textContent.trim().slice(0, 20));
  });
  const settle = () => window.waitForTimeout(150);

  // 설정을 열면 '뒤로'로, Esc로 닫으면 위쪽 '설정' 단추로 간다.
  await window.locator('.row-item').first().focus();
  await window.keyboard.press('ControlOrMeta+,'); await settle();
  assert.equal(await focused(), 'Back');
  await window.keyboard.press('Escape'); await settle();
  assert.match(await focused(), /^Settings/);

  // 검색칸을 Esc로 닫으면 검색 단추로 간다.
  await window.keyboard.press('ControlOrMeta+f'); await settle();
  await window.keyboard.press('Escape'); await settle();
  assert.match(await focused(), /^Search/);

  // 묶음 '읽음 표시'를 키보드로 누르면 단추가 사라져도 그 묶음의 첫 줄로 간다.
  await window.locator('.section-header').first().getByRole('button', { name: 'Mark as read' }).focus();
  await window.keyboard.press('Enter'); await settle();
  assert.equal(await focused(), await window.locator('.row-item').first().getAttribute('data-event'));

  // '되돌리기'를 누르면 띠가 사라져도 초점은 목록에 남는다.
  await window.locator('.undo-bar button').focus();
  await window.keyboard.press('Enter'); await settle();
  assert.notEqual(await focused(), 'body');
  assert.deepEqual(errors, []);
});

test('데모 패널: 누르고 떼는 사이에 화면이 다시 그려져도 클릭이 사라지지 않는다', async (t) => {
  const { app, window, errors } = await launch({ args: ['--demo'] });
  t.after(() => app.close());
  await window.waitForSelector('.row-item');
  const box = await window.getByRole('button', { name: 'Unread', exact: true }).boundingBox();
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await window.mouse.down();
  // 확인 결과가 도착한 것처럼 화면을 다시 그린다(누른 버튼이 새 버튼으로 바뀐다).
  await window.evaluate(() => render());
  await window.mouse.up();
  await window.waitForFunction(() => view.query.unreadOnly === true);
  assert.deepEqual(errors, []);
});
