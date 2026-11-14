// 0.5.0 점검에서 고친 것들의 검증.
// - 영어 문구의 단수형("Pushed 1 commit", "1 item")
// - 화면 언어의 종류 이름으로 검색('머지', '승인')
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeEvent } = require('../../src/core/models');
const Query = require('../../src/core/activity-query');
const { createL10n } = require('../../src/l10n');

const english = createL10n({ korean: false });
const korean = createL10n({ korean: true });

test('영어: 개수가 1이면 단수형을 쓴다', () => {
  assert.equal(english.format('Pushed %lld commits', 1), 'Pushed 1 commit');
  assert.equal(english.format('Pushed %lld commits', 2), 'Pushed 2 commits');
  assert.equal(english.format('%lld items', 1), '1 item');
  assert.equal(english.format('%lld items', 0), '0 items', '0은 복수형');
  assert.equal(english.format('Checked %@ · %lld repositories', '9:00 AM', 1), 'Checked 9:00 AM · 1 repository',
    '%@가 앞에 있어도 %lld 자리의 값으로 고른다');
  assert.equal(english.kindLabel({ kind: 'push', commitCount: 1 }), 'Pushed 1 commit');
});

test('한국어: 단수·복수 구분 없이 같은 번역을 쓴다', () => {
  assert.equal(korean.format('Pushed %lld commits', 1), '커밋 1개 push');
  assert.equal(korean.format('%lld items', 1), '1개');
});

function event(id, kind) {
  return makeEvent({ id, repo: 'acme/web', kind, time: '2026-11-09T12:00:00Z', actor: 'amy', title: `t${id}`,
    url: 'https://github.com/acme/web', isUnread: false });
}

test('검색: 화면 언어의 종류 이름으로도 찾는다', () => {
  const events = [event('1', 'prMerged'), event('2', 'reviewApproved'), event('3', 'comment')];
  const kindLabels = Object.fromEntries(['prMerged', 'reviewApproved', 'comment'].map((kind) => [kind, korean.kindLabel({ kind })]));
  const find = (search) => Query.filter(Query.createQuery({ search, kindLabels }), events).map((e) => e.id);
  assert.deepEqual(find('머지'), ['1']);
  assert.deepEqual(find('승인'), ['2']);
  assert.deepEqual(find('댓글'), ['3']);
  assert.deepEqual(find('approved'), ['2'], '영문 키로도 여전히 찾는다');
  assert.deepEqual(Query.filter(Query.createQuery({ search: '머지' }), events), [], '이름표가 없으면 영문 키만 본다');
});

// 세분화 토큰(fine-grained)은 알림함 API에 403을 돌려준다. 그래도 최근 push가 있는 저장소는 확인해야 한다.
const Poller = require('../../src/core/poller');
const WatchState = require('../../src/core/watch-state');
const { GitHubError } = require('../../src/core/github-api');
const { fakeGitHub, now, recent } = require('./fixtures');

function pushedRepoAPI(notifications) {
  const base = fakeGitHub([
    ['user/repos', [{ full_name: 'org/repo', pushed_at: recent, archived: false }]],
    ['user', { login: 'me' }],
    ['repos/org/repo/pulls/comments', []],
    ['repos/org/repo/pulls', []],
    ['repos/org/repo/issues/comments', []],
    ['repos/org/repo/activity', []],
  ]);
  return {
    async get(path) {
      if (path.startsWith('notifications')) return notifications();
      return base.get(path);
    },
  };
}

test('알림함을 읽을 수 없는 토큰이어도 최근 push가 있는 저장소는 확인한다', async () => {
  const api = pushedRepoAPI(() => { throw new GitHubError('http', 'Resource not accessible by personal access token', 403); });
  const result = await Poller.refresh(api, WatchState.createState(), { now, includeOwn: false });
  assert.equal(result.notificationsUnavailable, true);
  assert.deepEqual(result.state.checkedRepos, ['org/repo']);
  assert.ok(result.state.lastChecked);
});

test('알림함이 되면 표시하지 않고, 토큰이 틀리면(401) 그대로 오류다', async () => {
  const ok = await Poller.refresh(pushedRepoAPI(() => []), WatchState.createState(), { now, includeOwn: false });
  assert.equal(ok.notificationsUnavailable, false);
  await assert.rejects(
    Poller.refresh(pushedRepoAPI(() => { throw new GitHubError('unauthorized', '', 401); }), WatchState.createState(),
      { now, includeOwn: false }),
    (error) => error.kind === 'unauthorized');
});

const { detectRateLimit } = require('../../src/core/github-api');

test('한도 판별: 1차 한도(남은 횟수 0)와 2차 한도(문구), 그 밖의 403은 아니다', () => {
  const clock = 1_000_000_000;
  assert.deepEqual(detectRateLimit({ status: 403, remaining: '0', reset: '1000600', message: '', now: clock }),
    { resetAt: new Date(1000600 * 1000).toISOString() });
  assert.deepEqual(detectRateLimit({ status: 403, remaining: '4000', retryAfter: '60', message: 'You have exceeded a secondary rate limit', now: clock }),
    { resetAt: new Date(clock + 60000).toISOString() });
  assert.deepEqual(detectRateLimit({ status: 429, message: '' }), { resetAt: null }, '시각을 모르면 null');
  assert.equal(detectRateLimit({ status: 403, remaining: '4999', message: 'Resource not accessible by personal access token' }), null);
  assert.equal(detectRateLimit({ status: 404, remaining: '0', message: '' }), null);
});

test('저장소를 읽다가 한도에 걸리면 결과를 버리고 마지막 확인 시각을 그대로 둔다', async () => {
  const base = fakeGitHub([
    ['user/repos', [{ full_name: 'org/repo', pushed_at: recent, archived: false }]],
    ['user', { login: 'me' }],
    ['notifications', []],
  ]);
  const api = {
    async get(path) {
      if (path.startsWith('repos/org/repo')) throw new GitHubError('rateLimited', 'API rate limit exceeded', 403, null);
      return base.get(path);
    },
  };
  const state = WatchState.createState();
  state.me = 'me';
  state.lastChecked = '2026-11-09T05:00:00.000Z';
  await assert.rejects(Poller.refresh(api, state, { now, includeOwn: false }), (error) => error.kind === 'rateLimited');
  assert.equal(state.lastChecked, '2026-11-09T05:00:00.000Z', '호출한 쪽의 상태는 그대로다');
});

test('push 커밋 제목: 한도·네트워크 실패는 다음에 다시 읽고, 사라진 커밋(404)은 그만 읽는다', async () => {
  const pushEvent = makeEvent({ id: 'o/r#act:1', repo: 'o/r', kind: 'push', time: '2026-11-09T05:30:00Z', actor: 'amy',
    branch: 'main', title: '', url: 'https://github.com/o/r', before: '0'.repeat(40), after: 'bbb', detailResolved: false });
  const limited = { get: async () => { throw new GitHubError('rateLimited', '', 403, null); } };
  assert.equal((await Poller.resolvePush(limited, pushEvent)).detailResolved, false);
  const missing = { get: async () => { throw new GitHubError('http', 'Not Found', 404); } };
  assert.equal((await Poller.resolvePush(missing, pushEvent)).detailResolved, true);
});
