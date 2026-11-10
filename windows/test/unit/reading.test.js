// 읽음 처리 편의 기능의 검증(macOS판 Tests/GitBellCoreTests/ReadingTests.swift와 같은 내용).
// - 항목을 열면 같은 PR·이슈의 다른 안 읽은 항목도 읽음
// - 여러 항목을 한 번에 읽음으로 바꾸고 되돌리기
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeEvent } = require('../../src/core/models');
const WatchState = require('../../src/core/watch-state');
const { createL10n } = require('../../src/l10n');

function event(id, { repo = 'acme/web', number = null, kind = 'comment' } = {}) {
  return makeEvent({ id, repo, kind, number, time: '2026-11-09T12:00:00Z', actor: 'amy', title: id,
    url: `https://github.com/${repo}`, isUnread: true });
}

function state(events) {
  const created = WatchState.createState();
  created.history = events;
  return created;
}

const unread = (current) => current.history.filter((e) => e.isUnread).map((e) => e.id).sort();

test('항목을 열면 같은 PR·이슈의 다른 안 읽은 항목도 읽음이 된다', () => {
  const current = state([event('review', { number: 7, kind: 'reviewApproved' }), event('comment', { number: 7 }),
    event('other-pr', { number: 8 }), event('same-number-other-repo', { repo: 'acme/api', number: 7 }),
    event('push', { kind: 'push' })]);
  WatchState.markThreadRead(current, 'comment');
  assert.deepEqual(unread(current), ['other-pr', 'push', 'same-number-other-repo']);
});

test('번호가 없는 항목(push)은 그 항목만 읽음이 된다', () => {
  const current = state([event('push-1', { kind: 'push' }), event('push-2', { kind: 'push' })]);
  WatchState.markThreadRead(current, 'push-1');
  assert.deepEqual(unread(current), ['push-2']);
});

test('여러 항목을 읽음으로 바꾸고 되돌린다', () => {
  const current = state([event('a'), event('b'), event('c')]);
  WatchState.markReadIds(current, ['a', 'b']);
  assert.deepEqual(unread(current), ['c']);
  WatchState.markUnreadIds(current, ['a', 'b']);
  assert.deepEqual(unread(current), ['a', 'b', 'c']);
});

test('되돌리기 문구: 영어는 1개일 때 단수형', () => {
  const english = createL10n({ korean: false });
  assert.equal(english.format('Marked %lld items as read', 1), 'Marked 1 item as read');
  assert.equal(english.format('Marked %lld items as read', 3), 'Marked 3 items as read');
  assert.equal(createL10n({ korean: true }).format('Marked %lld items as read', 3), '3개를 읽음으로 표시했습니다');
});
