// 활동 통계: 날짜별 합계 쌓기, 최근 7일 막대, 6개월 잔디, 활동이 많은 저장소.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Stats = require('../../src/core/activity-stats');
const WatchState = require('../../src/core/watch-state');

const { activityStats, heatmap, addToDaily, pruneDaily, dailyFromHistory, sanitizeDaily, localDate } = Stats;

// 이 컴퓨터 시간대의 날짜·시각으로 만든다(날짜는 자정 기준으로 나뉜다).
const at = (month, day, hour) => new Date(2026, month - 1, day, hour).toISOString();
const event = (repo, kind, time, actor = 'amy') => ({ repo, kind, time, actor });
const date = (month, day) => localDate(new Date(2026, month - 1, day).getTime());
const daily = (events) => dailyFromHistory(events);

test('날짜별 합계: 저장소·종류·봇을 나눠 더하고, 자정을 넘으면 다음 날로 센다', () => {
  const sums = daily([
    event('o/web', 'prOpened', at(11, 14, 9)),
    event('o/web', 'reviewApproved', at(11, 14, 0)),
    event('o/web', 'comment', at(11, 13, 23, 59)),
    event('o/web', 'push', at(11, 14, 10), 'ci[bot]'),
  ]);
  assert.deepEqual(sums[date(11, 14)], { 'o/web': [1, 1, 0, 0, 0, 1] }, '[PR, 리뷰, 커밋, 봇 PR, 봇 리뷰, 봇 커밋]');
  assert.deepEqual(sums[date(11, 13)], { 'o/web': [0, 1, 0, 0, 0, 0] });
});

test('날짜별 합계: 오래된 날짜는 지우고(6개월 + 이번 주), 망가진 값은 버린다', () => {
  const sums = {};
  addToDaily(sums, event('o/web', 'push', at(1, 2, 12)));
  addToDaily(sums, event('o/web', 'push', at(11, 20, 12)));
  pruneDaily(sums, at(11, 27, 12));
  assert.deepEqual(Object.keys(sums), [date(11, 20)]);
  assert.deepEqual(sanitizeDaily({ '2026-11-20': { 'o/web': [1, 0, 0, 0, 0, 0], 'o/bad': [1, 2] }, nope: {}, '2026-11-21': { 'o/x': [-1, 0, 0, 0, 0, 0] } }),
    { '2026-11-20': { 'o/web': [1, 0, 0, 0, 0, 0] } });
  assert.equal(sanitizeDaily('garbage'), null);
});

test('활동 차트: 최근 7일을 날짜·종류별로 세고, 기간 밖은 뺀다', () => {
  const sums = daily([
    event('o/web', 'prOpened', at(11, 14, 9)),
    event('o/web', 'reviewApproved', at(11, 14, 0)),
    event('o/api', 'comment', at(11, 13, 23)),
    event('o/api', 'push', at(11, 8, 12)),
    event('o/web', 'forcePush', at(11, 7, 12)),
  ]);
  const stats = activityStats(sums, { now: at(11, 14, 18), days: 7 });
  assert.deepEqual(stats.days.map((day) => day.date), [8, 9, 10, 11, 12, 13, 14].map((day) => date(11, day)));
  assert.deepEqual(stats.days.at(-1).counts, { pullRequests: 1, reviews: 1, commits: 0 }, '자정 직후 활동도 그날로');
  assert.deepEqual(stats.days.at(-2).counts, { pullRequests: 0, reviews: 1, commits: 0 });
  assert.equal(stats.days[0].total, 1);
  assert.deepEqual(stats.totals, { pullRequests: 1, reviews: 2, commits: 1 }, '7일보다 오래된 force push는 세지 않는다');
  assert.equal(stats.total, 4);
  assert.equal(stats.max, 2);
  assert.deepEqual(stats.repos, [{ repo: 'o/api', count: 2 }, { repo: 'o/web', count: 2 }], '수가 같으면 이름순');
});

test('활동 차트: 활동이 없어도 날짜 칸은 모두 있고, 저장소는 상위 몇 개만', () => {
  const empty = activityStats({}, { now: at(11, 14, 18), days: 7 });
  assert.equal(empty.days.length, 7);
  assert.equal(empty.total, 0);
  assert.equal(empty.max, 0);
  const many = activityStats(daily(['a', 'b', 'c', 'd', 'e', 'f'].map((name) => event(`o/${name}`, 'push', at(11, 14, 10)))),
    { now: at(11, 14, 18), topRepos: 5 });
  assert.equal(many.repos.length, 5);
});

test('활동 차트: 숨긴 저장소와 (숨기기를 켰으면) 봇 활동은 세지 않는다', () => {
  const sums = daily([
    event('o/web', 'comment', at(11, 14, 9)),
    event('o/web', 'comment', at(11, 14, 10), 'review-helper[bot]'),
    event('o/secret', 'push', at(11, 14, 11)),
  ]);
  const shown = activityStats(sums, { now: at(11, 14, 18), display: { hiddenRepositories: ['o/secret'], hidesBots: true } });
  assert.equal(shown.total, 1);
  assert.deepEqual(shown.repos, [{ repo: 'o/web', count: 1 }]);
  assert.equal(activityStats(sums, { now: at(11, 14, 18) }).total, 3, '기본은 모두 센다');
});

test('활동 잔디: 일요일에 시작하는 26주, 마지막 열이 이번 주이고 오늘 뒤는 비운다', () => {
  // 2026-11-26은 목요일이다.
  const map = heatmap({}, { now: at(11, 26, 15), weeks: 26 });
  assert.equal(map.weeks.length, 26);
  assert.ok(map.weeks.every((week) => week.length === 7));
  assert.equal(new Date(2026, 10, 26).getDay(), 4);
  const last = map.weeks.at(-1);
  assert.deepEqual(last.map((day) => day.date), [22, 23, 24, 25, 26, 27, 28].map((day) => date(11, day)));
  assert.deepEqual(last.map((day) => day.future), [false, false, false, false, false, true, true]);
  assert.equal(map.weeks[0][0].date, date(5, 31), '이번 주 일요일(11/22)에서 25주 전 일요일');
  assert.equal(map.total, 0);
  assert.equal(map.busiest, null);
});

test('활동 잔디: 가장 많은 날을 4단계로 두고 나누며, 활동한 날과 가장 많았던 날을 센다', () => {
  const events = [];
  for (let i = 0; i < 8; i += 1) events.push(event('o/web', 'push', at(11, 20, 9)));
  for (let i = 0; i < 2; i += 1) events.push(event('o/web', 'comment', at(11, 24, 9)));
  events.push(event('o/web', 'prOpened', at(11, 25, 9)));
  const map = heatmap(daily(events), { now: at(11, 26, 15) });
  const cell = (month, day) => map.weeks.flat().find((item) => item.date === date(month, day));
  assert.equal(cell(11, 20).level, 4);
  assert.equal(cell(11, 24).level, 1, '2/8 → 1단계');
  assert.equal(cell(11, 25).level, 1, '1/8도 0이 아니면 1단계');
  assert.equal(cell(11, 23).level, 0);
  assert.deepEqual(cell(11, 24).counts, { pullRequests: 0, reviews: 2, commits: 0 });
  assert.equal(map.total, 11);
  assert.equal(map.activeDays, 3);
  assert.deepEqual(map.busiest, { date: date(11, 20), total: 8 });
});

test('상태: 새 항목은 날짜별 합계에 더해지고, 목록 기록이 줄어도 합계는 남는다', () => {
  const state = WatchState.createState();
  state.me = 'me';
  state.lastChecked = at(11, 26, 9);
  const events = Array.from({ length: 5 }, (_, i) => ({
    id: `o/web#act:${i}`, repo: 'o/web', kind: 'push', time: at(11, 26, 10), actor: 'amy', title: '', url: 'https://github.com/o/web',
  }));
  events.push({ id: 'o/web#act:mine', repo: 'o/web', kind: 'push', time: at(11, 26, 10), actor: 'me', title: '', url: 'https://github.com/o/web' });
  WatchState.apply(state, events, { now: at(11, 26, 11), includeOwn: false, config: { ...WatchState.DEFAULT_CONFIG, historyLimit: 2 } });
  assert.equal(state.history.length, 2, '목록 기록은 2개로 줄어도');
  assert.deepEqual(state.daily[date(11, 26)], { 'o/web': [0, 0, 5, 0, 0, 0] }, '합계는 5개(내 활동은 목록처럼 빼고)');
  WatchState.apply(state, events, { now: at(11, 26, 12), includeOwn: false });
  assert.deepEqual(state.daily[date(11, 26)]['o/web'], [0, 0, 5, 0, 0, 0], '이미 본 항목은 다시 세지 않는다');
});

test('상태: 날짜별 합계가 없던 예전 상태 파일은 남은 기록으로 채운다', () => {
  const old = WatchState.createState();
  delete old.daily;
  old.history = [{ id: 'a', repo: 'o/web', kind: 'comment', time: at(11, 25, 9), actor: 'amy', isUnread: false }];
  assert.deepEqual(WatchState.migrated(old).daily, { [date(11, 25)]: { 'o/web': [0, 1, 0, 0, 0, 0] } });
  const saved = { ...WatchState.createState(), daily: { [date(11, 1)]: { 'o/api': [1, 0, 0, 0, 0, 0] } } };
  assert.deepEqual(WatchState.migrated(saved).daily, saved.daily, '저장된 합계는 그대로');
});
