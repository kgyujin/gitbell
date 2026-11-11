// 화면 배치 검사: 언어(영어·한국어) × 테마(밝은·어두운) × 여러 상태에서 깨진 배치가 없는지 숫자로 본다.
//
// 눈으로 스크린샷을 보는 것만으로는 몇 px 어긋남이나 긴 언어에서만 생기는 넘침을 놓친다.
// 그래서 다음 두 가지를 모든 상태에서 잰다.
//   1. 넘침: 보이는 요소가 패널 폭(가로) 밖으로 나가지 않는다. 가로 스크롤도 생기지 않는다.
//   2. 아이콘·글자 높이: 아이콘과 글자를 나란히 둔 곳(.with-icon, 칩, 메뉴, 띠)에서 둘의 세로 가운데가 맞는다.
//   3. 줄바꿈: 한 줄이어야 하는 단추·칩·링크('1분', '읽음 표시' 등)가 두 줄로 감기지 않는다.
// 새 화면이나 문구를 더하면 STATES에 상태를 더한다.
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { launch, isolatedEnv } = require('./helpers');

/** 세로 가운데 차이를 몇 px까지 봐줄지. 글꼴의 위아래 여백이 달라 1px 안팎은 눈에 보이지 않는다. */
const CENTER_TOLERANCE = 2;

/** 화면 자료를 바꿔 여러 상태를 만든다(panel.js의 전역 view·render를 쓴다). */
const STATES = {
  list: () => {},
  banners: () => {
    view = { ...view, availableUpdate: '9.9.9', readUndo: { text: 'Marked 2 items as read' },
      problemMessage: 'Your GitHub token is invalid or expired. Update it in Settings.', problemOpensSettings: true };
    render();
  },
  longText: () => {
    const [first, ...rest] = view.sections;
    const sample = first.events[2];
    const long = { ...sample, id: 'long', repoName: 'very-long-repository-name-for-layout-testing',
      branch: 'feature/an-extremely-long-branch-name-that-keeps-going',
      title: 'A very long commit title that should wrap or truncate nicely without breaking the layout of the row',
      actor: 'someone-with-a-really-long-login-name' };
    view = { ...view, unreadCount: 128, repositoryTitle: 'very-long-repository-name-for-layout-testing',
      sections: [{ ...first, type: 'repository', repo: 'acme/very-long-repository-name-for-layout-testing-and-more',
        title: 'very-long-repository-name-for-layout-testing-and-more', events: [long, ...first.events] }, ...rest] };
    render();
  },
  empty: () => { view = { ...view, sections: [], isFiltering: false, isFirstLoad: false }; render(); },
  noMatch: () => { view = { ...view, sections: [], isFiltering: true }; render(); },
  onboarding: () => { view = { ...view, showsOnboarding: true }; render(); },
  settings: () => { view = { ...view, showingSettings: true }; render(); },
  // 아주 긴 숨긴 저장소 이름이 설정 화면 전체를 옆으로 밀면 안 된다.
  settingsLongNames: () => {
    view = { ...view, showingSettings: true, settings: { ...view.settings,
      hiddenRepositories: ['some-organization-with-long-name/an-extremely-long-repository-name-that-overflows'] } };
    render();
  },
  // 화면이 작으면(높이 360px) 목록·빈 화면이 줄고, 아래 띠와 바닥 줄은 패널 안에 남아야 한다.
  smallEmpty: () => {
    document.documentElement.style.setProperty('--max-height', '360px');
    view = { ...view, sections: [], isFiltering: false, isFirstLoad: false, availableUpdate: '9.9.9', readUndo: { text: 'Marked 2 items as read' } };
    render();
  },
  smallOnboarding: () => {
    document.documentElement.style.setProperty('--max-height', '360px');
    view = { ...view, showsOnboarding: true };
    render();
  },
  repoMenu: () => document.querySelector('[data-ui="repoMenu"]').click(),
  sortMenu: () => document.querySelector('[data-ui="sortMenu"]').click(),
};

/** 패널 안에서 잰다: 넘친 요소와, 아이콘·글자 세로 가운데가 어긋난 곳을 돌려준다. */
function measure(tolerance) {
  const width = document.documentElement.clientWidth;
  const describe = (element) => `${element.tagName.toLowerCase()}.${[...element.classList].join('.')} "${(element.textContent || '').trim().slice(0, 30)}"`;
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  // 스크롤되는 목록 안에서 보이지 않는 부분은 넘침이 아니다. 잘라 보이는 조상이 있으면 그 안까지만 본다.
  const clippedRight = (element) => {
    let right = width;
    for (let node = element.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflowX !== 'visible') right = Math.min(right, node.getBoundingClientRect().right);
    }
    return right;
  };

  const overflow = [];
  if (document.documentElement.scrollWidth > width) overflow.push(`가로 스크롤 ${document.documentElement.scrollWidth} > ${width}`);
  // 세로: 패널 최대 높이 안에 바닥 줄이 들어와야 한다(화면이 작을 때 아래가 잘리지 않게).
  const maxHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--max-height')) || Infinity;
  for (const bottom of document.querySelectorAll('.footer, .update, .undo-bar')) {
    if (visible(bottom) && bottom.getBoundingClientRect().bottom > maxHeight + 0.5) {
      overflow.push(`${describe(bottom)} 아래로 잘림 ${Math.round(bottom.getBoundingClientRect().bottom)} > ${maxHeight}`);
    }
  }
  for (const element of document.body.querySelectorAll('*')) {
    if (!visible(element) || element.closest('#trayCanvas, .settings-scroll ::-webkit-scrollbar')) continue;
    const rect = element.getBoundingClientRect();
    if (rect.left < -0.5 || rect.right > Math.min(width, clippedRight(element)) + 0.5) {
      // 줄임표로 자르는 글자는 안쪽 내용이 넘쳐도 정상이다.
      if (getComputedStyle(element).textOverflow === 'ellipsis') continue;
      overflow.push(`${describe(element)} ${Math.round(rect.left)}..${Math.round(rect.right)}`);
    }
  }

  // 한 줄이어야 하는 것들. 높이가 글자 한 줄의 1.6배를 넘으면 감긴 것이다.
  for (const element of document.querySelectorAll('.segment, .chip, .menu-chip, .pill, .link.with-icon, .section-header .link, .count-badge')) {
    if (!visible(element)) continue;
    const style = getComputedStyle(element);
    const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.35;
    const content = element.getBoundingClientRect().height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
      - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth);
    if (content > line * 1.6) overflow.push(`${describe(element)} 두 줄로 감김(높이 ${content.toFixed(1)} > 한 줄 ${line.toFixed(1)})`);
  }

  const misaligned = [];
  const pairs = document.querySelectorAll('.with-icon, .chip, .menu-chip, .option, .pill, .undo-bar, .update, .footer, .section-header');
  for (const container of pairs) {
    if (!visible(container)) continue;
    const icon = [...container.children].find((child) => child.matches('svg.icon') && visible(child));
    if (!icon) continue;
    // 아이콘 바로 뒤(또는 앞)의 글자 한 줄을 찾는다.
    const range = document.createRange();
    const textNode = [...container.childNodes].find((node) => (node.nodeType === 3 && node.textContent.trim())
      || (node.nodeType === 1 && !node.matches('svg') && node.textContent.trim() && visible(node)));
    if (!textNode) continue;
    range.selectNodeContents(textNode);
    const lines = range.getClientRects();
    if (!lines.length) continue;
    const textRect = lines[0];
    const iconRect = icon.getBoundingClientRect();
    const difference = Math.abs((iconRect.top + iconRect.bottom) / 2 - (textRect.top + textRect.bottom) / 2);
    // 여러 줄로 감기는 글은 첫 줄 기준이 아니라 위쪽 맞춤이라 건너뛴다.
    if (lines.length > 1) continue;
    if (difference > tolerance) misaligned.push(`${describe(container)} 아이콘과 글자 가운데 차이 ${difference.toFixed(1)}px`);
  }
  return { overflow, misaligned };
}

for (const lang of ['en', 'ko']) {
  for (const scheme of ['light', 'dark']) {
    test(`배치: ${lang} · ${scheme} — 넘침과 아이콘·글자 높이`, async (t) => {
      const { app, window, errors } = await launch({ args: ['--demo'], env: isolatedEnv({ GITBELL_LANG: lang }) });
      t.after(() => app.close());
      await window.emulateMedia({ colorScheme: scheme });
      await window.waitForSelector('.row-item');
      const problems = [];
      for (const [name, apply] of Object.entries(STATES)) {
        await window.evaluate(`(${apply.toString()})()`);
        await window.waitForTimeout(50);
        const { overflow, misaligned } = await window.evaluate(measure, CENTER_TOLERANCE);
        for (const line of [...overflow, ...misaligned]) problems.push(`[${name}] ${line}`);
        // 다음 상태는 처음 화면에서 시작한다(메뉴를 닫고 화면 자료를 되돌린다).
        await window.evaluate(() => closeMenu());
        await window.evaluate(() => window.gitbell.init().then((init) => {
          document.documentElement.style.removeProperty('--max-height');
          view = init.view;
          render();
        }));
      }
      assert.deepEqual(problems, []);
      assert.deepEqual(errors, []);
    });
  }
}

test('배치 검사가 실제로 잡아낸다(일부러 깨뜨린 화면)', async (t) => {
  const { app, window } = await launch({ args: ['--demo'] });
  t.after(() => app.close());
  await window.waitForSelector('.row-item');
  const clean = await window.evaluate(measure, CENTER_TOLERANCE);
  assert.deepEqual(clean, { overflow: [], misaligned: [] });
  const checked = await window.evaluate(() => document.querySelectorAll('.with-icon svg.icon, .chip svg.icon, .menu-chip svg.icon').length);
  assert.ok(checked >= 5, `아이콘·글자 짝을 ${checked}곳 잰다`);
  await window.evaluate(() => {
    // 패널 밖으로 나가는 상자와, 아이콘을 6px 내린 링크를 만든다.
    // 패널은 CSP로 HTML 속 style 속성을 막아서, 스타일은 DOM으로 준다.
    const wide = document.createElement('span');
    Object.assign(wide.style, { display: 'inline-block', flex: 'none', width: '600px' });
    wide.textContent = 'wide';
    document.querySelector('.footer').append(wide);
    document.querySelector('.section-header .with-icon .icon').style.transform = 'translateY(6px)';
  });
  const broken = await window.evaluate(measure, CENTER_TOLERANCE);
  assert.equal(broken.overflow.length > 0, true, '넘침을 잡는다');
  // 칩 하나를 좁혀 글자를 두 줄로 감기게 하면 잡는다.
  await window.evaluate(() => Object.assign(document.querySelector('.chip').style, { width: '20px', whiteSpace: 'normal' }));
  const wrapped = await window.evaluate(measure, CENTER_TOLERANCE);
  assert.ok(wrapped.overflow.some((line) => line.includes('두 줄로 감김')), '줄바꿈을 잡는다');
  assert.equal(broken.misaligned.length > 0, true, '아이콘·글자 어긋남을 잡는다');
});
