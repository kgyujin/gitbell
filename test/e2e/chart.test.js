// 활동 차트 화면: 가상 자료(--demo)로 열고 닫는다.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { launch, isolatedEnv, screenshot } = require('./helpers');

test('활동 차트: 날짜별 막대·잔디·말풍선·저장소 순위를 보이고 Esc로 목록에 돌아온다', async (t) => {
  const { app, window, errors } = await launch({ args: ['--demo'] });
  t.after(() => app.close());
  // 보안 정책(CSP) 위반은 페이지 오류가 아니라 콘솔 오류로만 남아 따로 모은다.
  const consoleErrors = [];
  window.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });

  await window.waitForSelector('.row-item');
  await window.getByRole('button', { name: 'Activity chart', exact: true }).click();
  await window.waitForSelector('#chart:not([hidden]) .chart-svg');
  assert.equal(await window.locator('#main').isVisible(), false);
  assert.equal(await window.locator('.chart-col').count(), 7, '7일');
  assert.equal(await window.locator('.chart-col').last().locator('text').textContent(), 'Today');
  assert.ok(await window.locator('.chart-seg').count() > 0, '막대가 그려진다');
  assert.equal(await window.locator('.chart-key').count(), 3, '범례: PR · 리뷰 · 커밋');
  assert.ok(await window.locator('.chart-repo').count() > 0);
  assert.match(await window.locator('#chart').textContent(), /GitBell counts the activity it checks, by day/);

  // 저장소 막대는 수에 비례한다(예전에는 보안 정책이 길이 지정을 막아 모두 끝까지 찼다).
  const counts = (await window.locator('.chart-count').allTextContents()).map(Number);
  const widths = await window.locator('.chart-fill').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
  assert.ok(widths[0] > widths.at(-1) || counts[0] === counts.at(-1), `막대 길이 ${widths} / 수 ${counts}`);
  assert.ok(Math.abs(widths.at(-1) / widths[0] - counts.at(-1) / counts[0]) < 0.05, '첫 막대 대비 길이가 수의 비율과 같다');

  // 6개월 잔디: 26주 × 7일(오늘 뒤는 비움), 범례 5단계.
  assert.equal(await window.locator('.heat-svg').count(), 1);
  const cells = await window.locator('.heat-cell').count();
  assert.ok(cells > 25 * 7 && cells <= 26 * 7, `칸 ${cells}개`);
  assert.equal(await window.locator('.heat-cell.today').count(), 1);
  assert.equal(await window.locator('.heat-swatch').count(), 5, '범례: 적음 → 많음 5단계');
  // 칸은 그날 가장 많은 종류의 색이다(말풍선의 수와 맞는지 하나 확인한다).
  const sample = await window.locator('.heat-cell.level-4').first().evaluate((el) => ({ kind: el.getAttribute('class'), counts: el.dataset.tipCounts }));
  const [prs, reviews, commits] = sample.counts.split(',').map(Number);
  const most = Math.max(prs, reviews, commits);
  const expected = prs === most ? 'pullRequests' : reviews === most ? 'reviews' : 'commits';
  assert.match(sample.kind, new RegExp(`kind-${expected}`));
  assert.match(await window.locator('#chart').textContent(), /Last 6 months/);

  // 마우스를 올리면 그날의 수가 말풍선으로 뜬다(막대·잔디 모두).
  await window.locator('.heat-cell.level-4').first().hover();
  await window.waitForSelector('#chartTip:not([hidden])');
  assert.match(await window.locator('#chartTip').innerText(), /\d+ activities[\s\S]*PRs[\s\S]*Reviews[\s\S]*Commits/);
  await window.locator('.chart-col').last().hover();
  assert.match(await window.locator('#chartTip').innerText(), /activit/);
  await screenshot(window, 'chart-light');
  // 키보드로도: 막대 칸에 초점을 두면 같은 말풍선이 뜬다.
  await window.mouse.move(0, 0);
  await window.locator('.chart-col').first().focus();
  await window.waitForSelector('#chartTip:not([hidden])');
  await window.keyboard.press('Tab');

  await window.keyboard.press('Escape');
  await window.waitForSelector('#chart', { state: 'hidden' });
  assert.equal(await window.locator('#main').isVisible(), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(consoleErrors, []);
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
