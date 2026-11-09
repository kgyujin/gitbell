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
  await window.keyboard.press('Control+f');
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
  await window.locator('#menu').getByRole('button', { name: 'By repository' }).click();
  await window.waitForSelector('[data-section="repository:acme/web"]');
  assert.deepEqual(await window.locator('.section-header .plain').allTextContents(), ['web', 'api', 'design-system']);
  await screenshot(window, 'demo-by-repository');

  // 저장소 하나 읽음 표시
  await window.locator('[data-section="repository:acme/web"]').getByRole('button', { name: 'Mark as read' }).click();
  await window.waitForFunction(() => document.querySelector('.header .count-badge').textContent === '1');

  // 우클릭 메뉴로 저장소 숨기기 → 설정의 숨긴 저장소에서 다시 보이기
  await window.locator('.row-item', { hasText: 'Button contrast' }).click({ button: 'right' });
  await window.locator('#menu').getByRole('button', { name: 'Hide design-system' }).click();
  await window.waitForFunction(() => !document.querySelector('[data-section="repository:acme/design-system"]'));
  assert.equal(await rows(window).count(), 6);

  await window.keyboard.press('Control+,');
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
  // 주 프로세스가 그림을 받아 트레이에 넣었는지(빈 그림이 아닌지)
  const tray = await app.evaluate(({ nativeImage }) => typeof nativeImage.createFromDataURL === 'function');
  assert.equal(tray, true);
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
  await window.keyboard.press('Control+,');
  await window.waitForSelector('#settings:not([hidden])');
  assert.ok(await window.getByText('트레이 아이콘에 안 읽은 수 표시').isVisible());
  await screenshot(window, 'demo-ko-settings');
  assert.deepEqual(errors, []);
});
