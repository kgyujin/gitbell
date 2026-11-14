// GitHub 알림과 읽음 상태를 양쪽으로 맞추는 규칙.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const WatchState = require('../../src/core/watch-state');

const thread = (id, number, { unread = true, lastReadAt = null, updatedAt = '2026-11-09T05:40:00Z', type = 'PullRequest', repo = 'o/r' } = {}) => ({
  id, unread, last_read_at: lastReadAt, updated_at: updatedAt, repository: { full_name: repo },
  subject: { type, url: `https://api.github.com/repos/${repo}/${type === 'Issue' ? 'issues' : 'pulls'}/${number}` },
});
const event = (id, number, time, isUnread = true) => ({ id, repo: 'o/r', number, time, isUnread, kind: 'comment' });

function stateWith(history) {
  const state = WatchState.createState();
  state.history = history;
  return state;
}

test('스레드 키: PR·이슈만 저장소 + 번호로 맞춘다', () => {
  assert.equal(WatchState.notificationKey(thread('1', 5)), 'o/r#5');
  assert.equal(WatchState.notificationKey(thread('1', 6, { type: 'Issue' })), 'o/r#6');
  assert.equal(WatchState.notificationKey({ ...thread('1', 7), subject: { type: 'Release', url: 'https://api.github.com/repos/o/r/releases/7' } }), null);
  assert.equal(WatchState.threadKey(event('a', 5, '2026-11-09T05:00:00Z')), 'o/r#5');
  assert.equal(WatchState.threadKey({ repo: 'o/r', number: null }), null, 'push는 스레드가 없다');
});

test('스레드 기억: 기록에 있는 PR·이슈의 것만 두고, 같은 스레드는 반영한 시각을 이어 간다', () => {
  const state = stateWith([event('a', 5, '2026-11-09T05:00:00Z')]);
  WatchState.rememberThreads(state, [thread('100', 5, { lastReadAt: '2026-11-09T04:00:00Z' }), thread('200', 9)]);
  assert.deepEqual(Object.keys(state.threads), ['o/r#5'], '기록에 없는 PR(#9)은 기억하지 않는다');
  assert.deepEqual(state.threads['o/r#5'], { id: '100', unread: true, lastReadAt: '2026-11-09T04:00:00Z', updatedAt: '2026-11-09T05:40:00Z', appliedReadAt: null });
  state.threads['o/r#5'].appliedReadAt = '2026-11-09T04:00:00Z';
  WatchState.rememberThreads(state, []);
  assert.equal(state.threads['o/r#5'].appliedReadAt, '2026-11-09T04:00:00Z', '이번에 받지 못한 스레드는 그대로 둔다');
  state.history = [];
  WatchState.rememberThreads(state, []);
  assert.deepEqual(state.threads, {}, '기록에서 빠진 PR의 스레드는 잊는다');
});

test('GitHub → GitBell: 읽은 시각까지의 활동만 읽음, 같은 시각은 한 번만 반영한다', () => {
  const state = stateWith([
    event('before', 5, '2026-11-09T05:00:00Z'),
    event('after', 5, '2026-11-09T05:30:00Z'),
    event('other', 6, '2026-11-09T05:00:00Z'),
  ]);
  WatchState.rememberThreads(state, [thread('100', 5, { unread: false, lastReadAt: '2026-11-09T05:10:00Z' })]);
  assert.deepEqual(WatchState.applyGitHubReads(state), ['before']);
  assert.deepEqual(state.history.map((e) => e.isUnread), [false, true, true], 'GitHub에서 본 뒤에 생긴 활동은 안 읽음 그대로');

  // GitBell에서 다시 '안 읽음'으로 바꿨다면, GitHub의 같은 읽음 시각으로 덮어쓰지 않는다.
  state.history[0].isUnread = true;
  WatchState.rememberThreads(state, [thread('100', 5, { unread: false, lastReadAt: '2026-11-09T05:10:00Z' })]);
  assert.deepEqual(WatchState.applyGitHubReads(state), []);
  assert.equal(state.history[0].isUnread, true);

  // GitHub에서 다시 읽으면(더 새 시각) 그때는 반영한다.
  WatchState.rememberThreads(state, [thread('100', 5, { unread: false, lastReadAt: '2026-11-09T05:45:00Z' })]);
  assert.deepEqual(WatchState.applyGitHubReads(state).sort(), ['after', 'before']);
});

test('GitBell → GitHub: 그 PR의 활동을 모두 읽었고, GitHub에 더 새 소식이 없을 때만 고른다', () => {
  const state = stateWith([event('a', 5, '2026-11-09T05:30:00Z', false), event('b', 5, '2026-11-09T05:38:00Z', true)]);
  WatchState.rememberThreads(state, [thread('100', 5, { updatedAt: '2026-11-09T05:39:00Z' })]);
  assert.deepEqual(WatchState.threadsToMarkRead(state, ['o/r#5']), [], '아직 안 읽은 활동이 남았다');

  state.history[1].isUnread = false;
  assert.deepEqual(WatchState.threadsToMarkRead(state, ['o/r#5', 'o/r#5']), [{ key: 'o/r#5', id: '100' }]);

  state.threads['o/r#5'].updatedAt = '2026-11-09T05:50:00Z';
  assert.deepEqual(WatchState.threadsToMarkRead(state, ['o/r#5']), [], 'GitHub에 GitBell이 보이지 않은 더 새 소식이 있다');

  state.threads['o/r#5'].updatedAt = '2026-11-09T05:39:00Z';
  state.threads['o/r#5'].unread = false;
  assert.deepEqual(WatchState.threadsToMarkRead(state, ['o/r#5']), [], 'GitHub에서 이미 읽었다');
  assert.deepEqual(WatchState.threadsToMarkRead(state, ['o/r#9']), [], '모르는 스레드');

  state.threads['o/r#5'].unread = true;
  WatchState.markThreadReadOnGitHub(state, 'o/r#5', '2026-11-09T06:00:00Z');
  assert.deepEqual(state.threads['o/r#5'], { id: '100', unread: false, lastReadAt: '2026-11-09T06:00:00Z', updatedAt: '2026-11-09T05:39:00Z', appliedReadAt: '2026-11-09T06:00:00Z' });
});

test('상태 파일: 예전 상태에는 threads가 없어도 읽힌다', () => {
  const old = { ...WatchState.createState() };
  delete old.threads;
  assert.deepEqual(WatchState.migrated(old).threads, {});
});

test('GitHub → GitBell: 이미 반영한 읽은 시각도, 나중에 들어온 그 전 활동에는 적용한다', () => {
  const state = stateWith([event('first', 5, '2026-11-09T05:00:00Z')]);
  WatchState.rememberThreads(state, [thread('100', 5, { unread: false, lastReadAt: '2026-11-09T05:30:00Z' })]);
  assert.deepEqual(WatchState.applyGitHubReads(state), ['first']);

  // 조용한 저장소를 다시 읽거나 실패한 저장소를 다시 읽어, GitHub에서 읽기 전의 댓글이 뒤늦게 들어왔다.
  state.history.push(event('late', 5, '2026-11-09T05:20:00Z'), event('newer', 5, '2026-11-09T05:40:00Z'));
  state.history[0].isUnread = true; // 사용자가 GitBell에서 다시 안 읽음으로 바꾼 항목
  assert.deepEqual(WatchState.applyGitHubReads(state, ['late', 'newer']), ['late'], '새로 들어온 항목 중 읽은 시각 전의 것만');
  assert.equal(state.history[0].isUnread, true, '사용자가 다시 안 읽음으로 바꾼 항목은 그대로');
  assert.equal(state.history[2].isUnread, true, '읽은 뒤에 생긴 활동은 안 읽음');
});
