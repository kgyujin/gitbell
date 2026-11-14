// 활동 차트 화면: 가상 자료(--demo)로 열고 닫는다.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { launch, isolatedEnv, screenshot } = require('./helpers');

test('활동 차트: 날짜별 막대·범례·저장소 순위를 보이고 Esc로 목록에 돌아온다', async (t) => {
  const { app, window, errors } = await launch({ args: ['--demo'] });
  t.after(() => app.close());

  await window.waitForSelector('.row-item');
  await window.getByRole('button', { name: 'Activity chart', exact: true }).click();
  await window.waitForSelector('#chart:not([hidden]) .chart-svg');
  assert.equal(await window.locator('#main').isVisible(), false);
  assert.equal(await window.locator('.chart-col').count(), 7, '7일');
  assert.equal(await window.locator('.chart-col').last().locator('text').textContent(), 'Today');
  assert.ok(await window.locator('.chart-seg').count() > 0, '막대가 그려진다');
  assert.equal(await window.locator('.chart-key').count(), 3, '범례: PR · 리뷰 · 커밋');
  assert.ok(await window.locator('.chart-repo').count() > 0);
  assert.match(await window.locator('#chart').textContent(), /Based on \d+ recent activities GitBell keeps/);
  await screenshot(window, 'chart-light');

  await window.keyboard.press('Escape');
  await window.waitForSelector('#chart', { state: 'hidden' });
  assert.equal(await window.locator('#main').isVisible(), true);
  assert.deepEqual(errors, []);
});

test('활동 차트: 어두운 화면', async (t) => {
  const { app, window, errors } = await launch({ args: ['--demo', '--force-dark-mode'], env: isolatedEnv() });
  t.after(() => app.close());
  await window.emulateMedia({ colorScheme: 'dark' });
  await window.waitForSelector('.row-item');
  await window.getByRole('button', { name: 'Activity chart', exact: true }).click();
  await window.waitForSelector('#chart:not([hidden]) .chart-svg');
  await screenshot(window, 'chart-dark');
  assert.deepEqual(errors, []);
});
