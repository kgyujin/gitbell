// 알림 규칙(NotificationRulesTests.swift와 같은 경우): 내 활동, 포크 브랜치, 마크다운 미리보기,
// 기록 상한에서 안 읽은 항목 지키기, 처음 실행에서 실패한 저장소는 나중에 알리지 않기.
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const WatchState = require('../../src/core/watch-state');
const EventBuilder = require('../../src/core/event-builder');
const Poller = require('../../src/core/poller');
const { firstLine } = require('../../src/core/text-preview');
const { GitHubError } = require('../../src/core/github-api');

const now = '2026-11-10T12:00:00Z';
const minutesAgo = (minutes) => new Date(Date.parse(now) - minutes * 60000).toISOString();
const event = (id, extra = {}) => ({ id, repo: 'o/r', kind: 'comment', time: minutesAgo(1), actor: 'amy', title: id,
  url: 'https://github.com/o/r', ...extra });
const laterState = () => ({ ...WatchState.createState(), me: 'me', lastChecked: minutesAgo(2) });

test('알림: 내 PR이 닫힌 것(닫은 사람을 모름)은 알리지 않고, 머지는 알린다', () => {
  const state = laterState();
  const notified = WatchState.apply(state, [
    event('closed', { kind: 'prClosed', actor: '', prAuthor: 'me' }),
    event('merged', { kind: 'prMerged', actor: '', prAuthor: 'me' }),
  ], { now, includeOwn: false }).map((e) => e.id);
  assert.deepEqual(notified, ['merged']);
});

test('알림: 기록이 넘치면 읽은 항목부터 버린다', () => {
  const state = laterState();
  state.history = [event('read', { time: minutesAgo(10), isUnread: false }), event('old-unread', { time: minutesAgo(30), isUnread: true })];
  const config = { ...WatchState.DEFAULT_CONFIG, historyLimit: 2 };
  WatchState.apply(state, [event('new')], { now, includeOwn: false, config });
  assert.deepEqual(state.history.map((e) => e.id).sort(), ['new', 'old-unread']);
});

test('알림: 포크에서 같은 이름의 브랜치로 올린 PR은 원래 저장소 push와 잇지 않는다', () => {
  const events = EventBuilder.build({
    pulls: [{ number: 1, title: 'fork PR', html_url: 'https://github.com/o/r/pull/1', user: { login: 'amy' },
      head: { ref: 'main', repo: { full_name: 'amy/r' } }, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z' }],
    reviewsByPR: {}, reviewComments: [], issueComments: [],
    activity: [{ id: 5, activity_type: 'push', ref: 'refs/heads/main', before: 'a', after: 'b', actor: { login: 'bob' }, timestamp: '2026-11-10T00:00:00Z' }],
  }, 'o/r', '2026-11-09T00:00:00Z');
  assert.equal(events.find((e) => e.kind === 'push').prAuthor ?? null, null);
});

test('알림: 미리보기에서 마크다운 기호를 뺀다', () => {
  assert.equal(firstLine('**LGTM** see [docs](https://x.y)'), 'LGTM see docs');
  assert.equal(firstLine('```suggestion\nlet x = 1\n```\nTry this'), 'Try this');
  assert.equal(firstLine('![image](https://github.com/user-attachments/a.png)'), '');
  assert.equal(firstLine('Use `npm ci` here'), 'Use npm ci here');
});

test('알림: 처음 실행에서 읽지 못한 저장소는 다음 확인 때 하루치를 새 알림으로 보내지 않는다', async () => {
  const api = {
    async get(path) {
      if (path.startsWith('user/repos')) return [{ full_name: 'o/b', pushed_at: minutesAgo(5), archived: false }];
      if (path === 'user') return { login: 'me' };
      if (path.startsWith('notifications')) return [];
      throw new GitHubError('network', 'offline');
    },
  };
  const first = await Poller.refresh(api, WatchState.createState(), { now, includeOwn: false });
  assert.deepEqual(first.failedRepos, ['o/b']);
  assert.deepEqual(first.state.retrySince, {}, '처음 실행의 실패는 기억하지 않는다');
});

test('안정성: 알림함이 잠깐 실패하면(5xx) 이번 확인을 버려 마지막 확인 시각을 지킨다', async () => {
  const api = {
    async get(path) {
      if (path.startsWith('user/repos')) return [];
      if (path.startsWith('notifications')) throw new GitHubError('http', 'Bad Gateway', 502);
      return [];
    },
  };
  await assert.rejects(Poller.refresh(api, laterState(), { now, includeOwn: false }), { status: 502 });
});

test('안정성: 시계가 며칠 앞으로 뛰었다 돌아와도 같은 항목을 두 번 알리지 않는다', () => {
  const state = laterState();
  const comment = event('o/r#ic:1');
  assert.equal(WatchState.apply(state, [comment], { now, includeOwn: false }).length, 1);
  WatchState.apply(state, [], { now: '2026-11-20T12:00:00Z', includeOwn: false });   // 시계가 10일 앞으로
  assert.equal(WatchState.apply(state, [comment], { now, includeOwn: false }).length, 0);
  assert.equal(state.history.filter((e) => e.id === 'o/r#ic:1').length, 1, '기록에도 한 번만');
});

test('안정성: 저장소 이름이 바뀌어도 같은 댓글을 다시 알리지 않는다', () => {
  const state = laterState();
  WatchState.apply(state, [event('o/old#ic:7')], { now, includeOwn: false });
  assert.equal(WatchState.apply(state, [event('o/new#ic:7')], { now, includeOwn: false }).length, 0);
});

test('안정성: 기록 상한에 바로 걸려 빠진 항목은 알리지 않는다', () => {
  const state = laterState();
  const config = { ...WatchState.DEFAULT_CONFIG, historyLimit: 2 };
  const many = [1, 2, 3].map((n) => event(`o/r#ic:${n}`, { time: minutesAgo(n) }));
  const notified = WatchState.apply(state, many, { now, includeOwn: false, config });
  assert.deepEqual(notified.map((e) => e.id).sort(), state.history.map((e) => e.id).sort());
});

test('안정성: 계속 실패하는 push 커밋 제목은 몇 번 뒤 그만 읽는다', async () => {
  const api = { async get() { throw new GitHubError('http', 'Bad Gateway', 502); } };
  let push = { id: 'o/r#act:1', repo: 'o/r', kind: 'push', before: 'a', after: 'b', title: '', detailResolved: false };
  for (let attempt = 0; attempt < 3; attempt += 1) push = (await Poller.resolvePushDetail(api, push)).event;
  assert.equal(push.detailResolved, true);
  assert.equal(push.detailAttempts, 3);
});

test('안정성: 시각이 망가진 상태 파일도 확인을 멈추지 않는다', () => {
  const state = WatchState.migrated({ ...WatchState.createState(), lastChecked: 'garbage',
    history: [event('ok'), event('bad', { time: 'not-a-date' })], retrySince: { 'o/x': 'nope' } });
  assert.equal(state.lastChecked, null);
  assert.deepEqual(state.history.map((e) => e.id), ['ok']);
  assert.deepEqual(state.retrySince, {});
});

test('안정성: 브랜치 이름 안의 refs/heads/는 그대로 둔다', () => {
  const events = EventBuilder.build({ pulls: [], reviewsByPR: {}, reviewComments: [], issueComments: [],
    activity: [{ id: 9, activity_type: 'branch_creation', ref: 'refs/heads/feature/refs/heads/x', actor: { login: 'bob' }, timestamp: '2026-11-10T00:00:00Z' }],
  }, 'o/r', '2026-11-09T00:00:00Z');
  assert.equal(events[0].branch, 'feature/refs/heads/x');
});
