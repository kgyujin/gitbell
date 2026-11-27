// --demo로 띄울 때 쓰는 가상 저장소(acme/…)와 가상 사람. 실제 저장소 이름이 화면·스크린숏에 남지 않게 한다.
'use strict';

const { makeEvent } = require('./core/models');
const { createState } = require('./core/watch-state');
const { dailyFromHistory, localDate } = require('./core/activity-stats');

const DEMO_REPOS = ['acme/web', 'acme/api', 'acme/design-system'];

/**
 * 활동 잔디·막대가 비어 보이지 않게 지난 6개월의 날짜별 합계를 채운다. 매번 같은 그림이 나오게 난수 대신
 * 정해진 수열을 쓴다(스크린숏·테스트가 흔들리지 않게). 평일은 많고 주말은 적다. 오늘·어제는 기록(history)으로 센다.
 */
function demoDaily(now, history) {
  const daily = dailyFromHistory(history);
  let seed = 7;
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  for (let offset = 2; offset < 27 * 7; offset += 1) {
    const day = new Date(today);
    day.setDate(today.getDate() - offset);
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    const busy = next();
    if (busy < (weekend ? 0.7 : 0.15)) continue;
    const repos = {};
    for (const repo of DEMO_REPOS) {
      const scale = weekend ? 1 : 3;
      const counts = [Math.floor(next() * scale), Math.floor(next() * scale * 1.5), Math.floor(next() * scale * 2), 0, Math.floor(next() * 1.2), 0];
      if (counts.some(Boolean)) repos[repo] = counts;
    }
    daily[localDate(day.getTime())] = repos;
  }
  return daily;
}

function demoState(now = Date.now()) {
  const ago = (minutes) => new Date(now - minutes * 60 * 1000).toISOString();
  const url = (path) => `https://github.com/${path}`;
  const state = createState();
  state.me = 'you';
  state.lastChecked = ago(1);
  state.checkedRepos = ['acme/web', 'acme/api', 'acme/design-system', 'you/dotfiles'];
  state.history = [
    makeEvent({ id: '1', repo: 'acme/web', kind: 'reviewApproved', time: ago(3), actor: 'mina', number: 128,
      title: 'Looks great, ship it 🚀', url: url('acme/web/pull/128'), isUnread: true, prAuthor: 'you' }),
    makeEvent({ id: '2', repo: 'acme/api', kind: 'prOpened', time: ago(12), actor: 'jun', number: 342,
      title: 'Add rate limiting to public endpoints', url: url('acme/api/pull/342'), isUnread: true }),
    makeEvent({ id: '3', repo: 'acme/web', kind: 'push', time: ago(25), actor: 'sora', branch: 'feat/search',
      title: 'feat: debounce search input', url: url('acme/web'), commitCount: 3, isUnread: true }),
    makeEvent({ id: '4', repo: 'acme/design-system', kind: 'reviewChangesRequested', time: ago(48), actor: 'lee',
      number: 57, title: 'Button contrast fails WCAG AA in dark mode', url: url('acme/design-system/pull/57') }),
    makeEvent({ id: '9', repo: 'acme/design-system', kind: 'comment', time: ago(70), actor: 'review-helper[bot]',
      number: 57, title: 'Contrast check: 2 issues found', url: url('acme/design-system/pull/57') }),
    makeEvent({ id: '5', repo: 'acme/api', kind: 'prMerged', time: ago(95), actor: 'mina', number: 339,
      title: 'Migrate auth tokens to rotating keys', url: url('acme/api/pull/339') }),
    makeEvent({ id: '6', repo: 'acme/web', kind: 'comment', time: ago(130), actor: 'jun', number: 127,
      title: 'Can we keep the old route as a redirect for a week?', url: url('acme/web/pull/127'), prAuthor: 'you' }),
    makeEvent({ id: '7', repo: 'acme/api', kind: 'branchCreated', time: ago(60 * 20), actor: 'sora',
      branch: 'fix/timeout', title: 'fix: raise upstream timeout to 30s', url: url('acme/api') }),
    makeEvent({ id: '8', repo: 'acme/design-system', kind: 'prOpened', time: ago(60 * 22), actor: 'lee', number: 56,
      title: 'New color tokens for charts', url: url('acme/design-system/pull/56') }),
  ];
  state.daily = demoDaily(now, state.history);
  return state;
}

module.exports = { demoState };
