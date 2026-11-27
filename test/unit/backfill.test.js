// 활동 차트의 지난 날짜를 GitHub에서 한 번 불러와 채우기.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { backfillDaily, mergeBackfill, PULLS_QUERY, ISSUES_QUERY, COMMITS_QUERY } = require('../../src/core/backfill');
const { localDate } = require('../../src/core/activity-stats');
const { GitHubError } = require('../../src/core/github-api');
const { AppModel } = require('../../src/app-model');
const { createL10n } = require('../../src/l10n');

// 이 컴퓨터 시간대의 날짜·시각.
const at = (month, day, hour = 12) => new Date(2026, month - 1, day, hour).toISOString();
const date = (month, day) => localDate(new Date(2026, month - 1, day).getTime());
const user = (login, type = 'User') => ({ __typename: type, login });

const PULLS = {
  pageInfo: { hasNextPage: true, endCursor: 'p2' },
  nodes: [
    { updatedAt: at(11, 20), createdAt: at(11, 18), mergedAt: at(11, 20), closedAt: at(11, 20), merged: true, author: user('amy'), mergedBy: user('bob'),
      reviews: { nodes: [
        { submittedAt: at(11, 19), state: 'APPROVED', body: '', author: user('cat') },
        { submittedAt: at(11, 19), state: 'COMMENTED', body: '', author: user('cat') },
        { submittedAt: at(11, 19), state: 'COMMENTED', body: 'nice', author: user('codex', 'Bot') },
        { submittedAt: at(11, 19), state: 'CHANGES_REQUESTED', body: 'x', author: user('me') },
      ] },
      comments: { nodes: [{ createdAt: at(11, 19), author: user('dan') }, { createdAt: at(11, 27), author: user('dan') }] } },
    { updatedAt: at(10, 1), createdAt: at(10, 1), mergedAt: null, closedAt: at(10, 1), merged: false, author: user('me'), mergedBy: null,
      reviews: { nodes: [] }, comments: { nodes: [] } },
    // 기간(9월 1일부터)보다 오래전에 바뀐 PR: 다음 쪽은 더 오래된 것이라 읽지 않는다.
    { updatedAt: at(8, 1), createdAt: at(8, 1), mergedAt: null, closedAt: null, merged: false, author: user('amy'), mergedBy: null,
      reviews: { nodes: [] }, comments: { nodes: [] } },
  ],
};

function fakeAPI({ failRepo = null, rateLimited = false } = {}) {
  const calls = [];
  return {
    calls,
    async get(path) {
      calls.push(path);
      assert.match(path, /^user\/repos\?/);
      return [
        { full_name: 'o/web', pushed_at: at(11, 25), archived: false },
        { full_name: 'o/old', pushed_at: at(1, 5), archived: false },
        { full_name: 'o/gone', pushed_at: at(11, 25), archived: true },
        { full_name: 'o/broken', pushed_at: at(11, 25), archived: false },
      ];
    },
    async graphql(query, variables) {
      calls.push(`${variables.name}:${query === PULLS_QUERY ? 'pulls' : query === ISSUES_QUERY ? 'issues' : 'commits'}:${variables.after || ''}`);
      if (rateLimited) throw new GitHubError('rateLimited', 'limit', 403);
      if (variables.name === failRepo) throw new GitHubError('http', 'boom', 502);
      if (query === PULLS_QUERY) {
        return { repository: { pullRequests: variables.after ? { pageInfo: { hasNextPage: false }, nodes: [] } : PULLS } };
      }
      if (query === ISSUES_QUERY) {
        return { repository: { issues: { pageInfo: { hasNextPage: false }, nodes: [{ comments: { nodes: [{ createdAt: at(11, 10), author: user('eve') }] } }] } } };
      }
      assert.equal(query, COMMITS_QUERY);
      return { repository: { defaultBranchRef: { target: { history: { pageInfo: { hasNextPage: false }, nodes: [
        { committedDate: at(11, 21), author: { name: 'Amy', user: { login: 'amy' } } },
        { committedDate: at(11, 21), author: { name: 'Amy', user: { login: 'amy' } } },
        { committedDate: at(11, 22), author: { name: 'me', user: { login: 'me' } } },
        { committedDate: at(11, 22), author: { name: 'github-actions[bot]', user: null } },
      ] } } } } };
    },
  };
}

test('지난 활동: PR·리뷰·댓글·커밋을 날짜별로 세고, 내 활동·봇 커밋·기간 밖은 뺀다', async () => {
  const api = fakeAPI({ failRepo: 'broken' });
  const { daily, repos, failedRepos } = await backfillDaily(api, { me: 'me', start: at(9, 1, 0), cutoff: at(11, 27, 0) });
  assert.deepEqual(repos, ['o/web', 'o/broken'], '6개월 안에 push가 있고 보관하지 않은 저장소만');
  assert.deepEqual(failedRepos, ['o/broken'], '한 저장소가 실패해도 나머지는 계속한다');
  // [PR, 리뷰, 커밋, 봇 PR, 봇 리뷰, 봇 커밋]
  assert.deepEqual(daily[date(11, 18)], { 'o/web': [1, 0, 0, 0, 0, 0] }, 'PR 열림');
  assert.deepEqual(daily[date(11, 20)], { 'o/web': [1, 0, 0, 0, 0, 0] }, 'PR 머지');
  assert.deepEqual(daily[date(11, 19)], { 'o/web': [0, 2, 0, 0, 1, 0] }, '승인·댓글 / 빈 COMMENTED와 내 리뷰는 빼고 / 봇 리뷰는 따로');
  assert.deepEqual(daily[date(11, 10)], { 'o/web': [0, 1, 0, 0, 0, 0] }, '이슈 댓글');
  assert.deepEqual(daily[date(11, 21)], { 'o/web': [0, 0, 2, 0, 0, 0] }, '커밋');
  assert.equal(daily[date(11, 22)], undefined, '내 커밋과 봇 커밋은 세지 않는다');
  assert.equal(daily[date(11, 27)], undefined, 'GitBell이 세기 시작한 뒤(cutoff)의 활동은 세지 않는다');
  assert.equal(daily[date(10, 1)], undefined, '내 PR이 닫힌 것은 내 활동');
  assert.ok(!api.calls.includes('web:pulls:p2'), '기간보다 오래전에 바뀐 PR이 나오면 다음 쪽을 읽지 않는다');
});

test('지난 활동: 내 활동 표시를 켜면 내 활동도 센다', async () => {
  const { daily } = await backfillDaily(fakeAPI({ failRepo: 'broken' }), { me: 'me', start: at(9, 1, 0), cutoff: at(11, 27, 0), includeOwn: true });
  assert.deepEqual(daily[date(11, 22)], { 'o/web': [0, 0, 1, 0, 0, 0] });
  assert.deepEqual(daily[date(10, 1)], { 'o/web': [2, 0, 0, 0, 0, 0] }, '내 PR 열림 + 닫힘');
});

test('지난 활동: 한도에 걸리면 멈추고 오류를 올린다(다음에 다시 한다)', async () => {
  await assert.rejects(backfillDaily(fakeAPI({ rateLimited: true }), { me: 'me', start: at(9, 1, 0), cutoff: at(11, 27, 0) }), { kind: 'rateLimited' });
});

test('지난 활동 넣기: GitBell이 세기 시작한 날부터는 그대로 두고, 그 앞 날짜만 바꾼다', () => {
  const state = { daily: {
    [date(11, 20)]: { 'o/web': [1, 0, 0, 0, 0, 0] }, // 예전 목록 기록으로 채운 일부
    [date(11, 27)]: { 'o/web': [0, 5, 0, 0, 0, 0] }, // GitBell이 센 오늘
  } };
  mergeBackfill(state, { daily: { [date(11, 20)]: { 'o/web': [3, 1, 0, 0, 0, 0] }, [date(11, 19)]: { 'o/api': [0, 0, 2, 0, 0, 0] } },
    start: at(5, 31, 0), cutoff: at(11, 27, 9) }, at(11, 27, 10));
  assert.deepEqual(state.daily, {
    [date(11, 19)]: { 'o/api': [0, 0, 2, 0, 0, 0] },
    [date(11, 20)]: { 'o/web': [3, 1, 0, 0, 0, 0] },
    [date(11, 27)]: { 'o/web': [0, 5, 0, 0, 0, 0] },
  });
  assert.deepEqual(state.backfill, { doneAt: at(11, 27, 10) });
});

function makeModel(api, savedState) {
  let saved = savedState;
  const model = new AppModel({
    store: { loadState: () => saved, saveState: (s) => { saved = JSON.parse(JSON.stringify(s)); }, loadSettings: () => null, saveSettings() {} },
    tokens: { resolve: async () => ({ value: 't', source: 'saved' }), save: () => true, remove() {} },
    createAPI: () => api,
    notifier: { post() {}, postTest() {}, postUpdate() {} },
    system: { openURL() {}, copyText() {}, getLaunchAtLogin: () => false, setLaunchAtLogin() {} },
    l10n: createL10n({ korean: false }),
    version: '0.6.3',
    now: () => at(11, 27, 10),
  });
  return { model, saved: () => saved };
}

/** 확인(새로고침)에 쓰는 GitHub 응답 + 지난 활동 불러오기(fakeAPI). */
function appAPI(options) {
  const backfill = fakeAPI(options);
  let graphqlCalls = 0;
  return {
    get graphqlCalls() { return graphqlCalls; },
    async get(path) {
      if (path === 'user') return { login: 'me' };
      if (path.startsWith('user/repos?sort=pushed&direction=desc&per_page=100')) return backfill.get(path);
      if (path.startsWith('user/repos')) return [];
      if (path.startsWith('notifications')) return [];
      throw new GitHubError('http', path, 404);
    },
    async graphql(query, variables) {
      graphqlCalls += 1;
      return backfill.graphql(query, variables);
    },
  };
}

test('앱: 확인 뒤 지난 활동을 한 번만 불러와 차트에 보인다', async () => {
  const old = { version: 2, me: 'me', lastChecked: at(11, 27, 9), seen: {}, history: [], checkedRepos: [], retrySince: {}, lastRead: {}, threads: {},
    daily: { [date(11, 27)]: { 'o/web': [0, 5, 0, 0, 0, 0] } } };
  const api = appAPI();
  const { model, saved } = makeModel(api, old);
  assert.ok(model.state.dailyStartedAt, '0.6.2 상태는 지금부터 센 것으로 본다');
  await model.refresh();
  await model.backfilling;
  assert.ok(saved().backfill, '불러온 기록을 저장한다');
  model.setShowingChart(true);
  const chart = model.viewModel().chart;
  assert.ok(chart.heatmap.activeDays >= 5, `지난 날짜가 채워진다(활동한 날 ${chart.heatmap.activeDays})`);
  assert.equal(chart.days.at(-1).total, 5, '오늘은 GitBell이 센 그대로');

  const calls = api.graphqlCalls;
  await model.refresh();
  assert.equal(api.graphqlCalls, calls, '다시 불러오지 않는다');
});

test('앱: 불러오기가 실패하면 기록을 남기지 않고, 30분 뒤 다시 한다', async () => {
  const old = { version: 2, me: 'me', lastChecked: at(11, 27, 9), seen: {}, history: [], checkedRepos: [], retrySince: {}, lastRead: {}, threads: {}, daily: {} };
  const api = appAPI({ rateLimited: true });
  const { model } = makeModel(api, old);
  await model.refresh();
  await model.backfilling;
  assert.equal(model.state.backfill, null);
  const calls = api.graphqlCalls;
  await model.refresh();
  assert.equal(api.graphqlCalls, calls, '30분 안에는 다시 하지 않는다');
});
