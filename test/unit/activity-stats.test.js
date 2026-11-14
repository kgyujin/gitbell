// 활동 차트 집계: 날짜별·종류별 수, 활동이 많은 저장소.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { activityStats, localDate } = require('../../src/core/activity-stats');

// 이 컴퓨터 시간대의 날짜·시각으로 만든다(날짜는 자정 기준으로 나뉜다).
const at = (day, hour) => new Date(2026, 10, day, hour).toISOString();
const event = (repo, kind, time) => ({ repo, kind, time });

test('활동 차트: 최근 7일을 날짜·종류별로 세고, 기간 밖은 뺀다', () => {
  const stats = activityStats([
    event('o/web', 'prOpened', at(14, 9)),
    event('o/web', 'reviewApproved', at(14, 0)),
    event('o/api', 'comment', at(13, 23)),
    event('o/api', 'push', at(8, 12)),
    event('o/web', 'forcePush', at(7, 12)),
  ], { now: at(14, 18), days: 7 });
  assert.deepEqual(stats.days.map((day) => day.date), [8, 9, 10, 11, 12, 13, 14].map((day) => localDate(new Date(2026, 10, day).getTime())));
  assert.deepEqual(stats.days.at(-1).counts, { pullRequests: 1, reviews: 1, commits: 0 }, '자정 직후 활동도 그날로');
  assert.deepEqual(stats.days.at(-2).counts, { pullRequests: 0, reviews: 1, commits: 0 });
  assert.equal(stats.days[0].total, 1);
  assert.deepEqual(stats.totals, { pullRequests: 1, reviews: 2, commits: 1 }, '7일보다 오래된 force push는 세지 않는다');
  assert.equal(stats.total, 4);
  assert.equal(stats.max, 2);
  assert.deepEqual(stats.repos, [{ repo: 'o/api', count: 2 }, { repo: 'o/web', count: 2 }], '수가 같으면 이름순');
});

test('활동 차트: 활동이 없어도 날짜 칸은 모두 있고, 저장소는 상위 몇 개만', () => {
  const empty = activityStats([], { now: at(14, 18), days: 7 });
  assert.equal(empty.days.length, 7);
  assert.equal(empty.total, 0);
  assert.equal(empty.max, 0);
  const many = activityStats(['a', 'b', 'c', 'd', 'e', 'f'].map((name) => event(`o/${name}`, 'push', at(14, 10))), { now: at(14, 18), topRepos: 5 });
  assert.equal(many.repos.length, 5);
});
