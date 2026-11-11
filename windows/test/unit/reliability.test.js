// 확인(poller)의 안정성(PollerReliabilityTests.swift와 같은 경우):
// 실패한 저장소를 다음에 그때부터 다시 읽기, since 묶기, 한도에 걸리면 push 읽기 멈추기.
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Poller = require('../../src/core/poller');
const WatchState = require('../../src/core/watch-state');
const { GitHubError } = require('../../src/core/github-api');

/** 요청한 경로를 적어 두는 가짜 GitHub. 경로 앞부분으로 응답(값) 또는 오류(Error)를 고른다. */
function recordingGitHub(routes) {
  const table = [...routes];
  const paths = [];
  return {
    paths,
    replace(prefix, reply) {
      const index = table.findIndex(([key]) => key === prefix);
      if (index >= 0) table.splice(index, 1);
      table.unshift([prefix, reply]);
    },
    async get(path) {
      paths.push(path);
      const route = table.find(([prefix]) => path.startsWith(prefix));
      if (!route) throw new GitHubError('http', path, 404);
      if (route[1] instanceof Error) throw route[1];
      return JSON.parse(JSON.stringify(route[1]));
    },
  };
}

const repoRoutes = (repo) => [[`repos/${repo}/pulls/comments`, []], [`repos/${repo}/pulls`, []],
  [`repos/${repo}/issues/comments`, []], [`repos/${repo}/activity`, []]];

const github = (pushedAt) => recordingGitHub([
  ['user/repos', [{ full_name: 'o/a', pushed_at: pushedAt, archived: false }, { full_name: 'o/b', pushed_at: pushedAt, archived: false }]],
  ['notifications', []],
  ...repoRoutes('o/a'), ...repoRoutes('o/b'),
]);

function state(lastChecked, extra = {}) {
  return { ...WatchState.createState(), me: 'me', lastChecked, ...extra };
}

test('확인: 읽지 못한 저장소는 다음에 그때부터 다시 읽는다', async () => {
  const api = github('2026-11-09T11:00:00Z');
  api.replace('repos/o/b/activity', new GitHubError('network', 'offline'));
  const first = await Poller.refresh(api, state('2026-11-09T11:58:00Z'), { now: '2026-11-09T12:00:00Z', includeOwn: false });
  assert.deepEqual(first.failedRepos, ['o/b']);
  // 11:58 - 10분 = 11:48 → 10분 단위로 11:40
  assert.deepEqual(first.state.retrySince, { 'o/b': '2026-11-09T11:40:00Z' });

  api.replace('repos/o/b/activity', []);
  const second = await Poller.refresh(api, first.state, { now: '2026-11-09T12:30:00Z', includeOwn: false });
  assert.ok(api.paths.some((p) => p.startsWith('repos/o/b/issues/comments?since=2026-11-09T11:40:00Z')));
  assert.ok(api.paths.some((p) => p.startsWith('repos/o/a/issues/comments?since=2026-11-09T11:50:00Z')));
  assert.deepEqual(second.state.retrySince, {}, '읽고 나면 기억을 지운다');
});

test('확인: 지워졌거나 권한이 없어진 저장소(404)는 다시 읽으려 기억하지 않는다', async () => {
  const api = github('2026-11-09T11:00:00Z');
  api.replace('repos/o/b/activity', new GitHubError('http', 'Not Found', 404));
  const result = await Poller.refresh(api, state('2026-11-09T11:58:00Z'), { now: '2026-11-09T12:00:00Z', includeOwn: false });
  assert.deepEqual(result.failedRepos, ['o/b']);
  assert.deepEqual(result.state.retrySince, {});
});

test('확인: 목록에서 빠져도 지난번에 실패한 저장소는 다시 읽는다', async () => {
  const api = github('2026-10-01T00:00:00Z');
  const result = await Poller.refresh(api, state('2026-11-09T11:58:00Z', { retrySince: { 'o/b': '2026-11-09T11:00:00Z' } }),
    { now: '2026-11-09T12:00:00Z', includeOwn: false });
  assert.deepEqual(result.state.checkedRepos, ['o/b']);
});

test('확인: since는 하루보다 앞으로 가지 않고 10분 단위로 맞춘다', () => {
  const config = WatchState.DEFAULT_CONFIG;
  const now = '2026-11-20T12:07:00Z';
  const iso = (ms) => new Date(ms).toISOString().replace('.000', '');
  assert.equal(iso(Poller.sinceTime('2026-11-20T12:05:30Z', now, config)), '2026-11-20T11:50:00Z');
  assert.equal(iso(Poller.sinceTime('2026-11-10T00:00:00Z', now, config)), '2026-11-19T12:00:00Z', '오래 꺼 두었어도 하루까지만');
  assert.equal(iso(Poller.sinceTime(null, now, config)), '2026-11-19T12:00:00Z', '처음 실행은 하루 전부터');
});

test('확인: 커밋 제목을 읽다 한도에 걸리면 남은 push는 다음으로 미룬다', async () => {
  const pushes = Array.from({ length: 8 }, (_, index) => ({ id: index + 1, activity_type: 'push', ref: 'refs/heads/main',
    before: `b${index}`, after: `a${index}`, actor: { login: 'amy' }, timestamp: '2026-11-09T11:59:00Z' }));
  const limited = new GitHubError('rateLimited', 'rate limit', 403, null);
  const api = recordingGitHub([
    ['user/repos', [{ full_name: 'o/a', pushed_at: '2026-11-09T11:59:00Z', archived: false }]],
    ['notifications', []],
    ['repos/o/a/activity', pushes],
    ['repos/o/a/compare', limited],
    ['repos/o/a/commits', limited],
    ...repoRoutes('o/a'),
  ]);
  const result = await Poller.refresh(api, state('2026-11-09T11:58:00Z'), { now: '2026-11-09T12:00:00Z', includeOwn: false });
  const pushCalls = api.paths.filter((p) => p.includes('/compare/') || p.includes('/commits/'));
  assert.equal(pushCalls.length, WatchState.DEFAULT_CONFIG.maxConcurrentRepos, '한도에 걸린 묶음까지만, 마지막 커밋으로 다시 읽지 않는다');
  assert.ok(result.state.history.every((event) => !event.detailResolved), '다음 확인 때 다시 읽는다');
});
