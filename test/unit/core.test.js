// GitBellCoreTests.swift를 옮긴 검증. GitHub에 실제로 요청하지 않는다.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { firstLine } = require('../../src/core/text-preview');
const EventBuilder = require('../../src/core/event-builder');
const WatchState = require('../../src/core/watch-state');
const Poller = require('../../src/core/poller');
const { repo, now, since, recent, old, user, sampleSnapshot, fakeGitHub } = require('./fixtures');

const id = (suffix) => `${repo}#${suffix}`;
const build = () => EventBuilder.build(sampleSnapshot(), repo, since);
const byID = (events) => new Map(events.map((e) => [e.id, e]));

test('TextPreview: 인용과 제목 기호를 건너뛴다', () => {
  assert.equal(firstLine('> > 인용\n\n실제 답글\n둘째'), '실제 답글');
  assert.equal(firstLine('## 코드 리뷰: PR #33'), '코드 리뷰: PR #33');
  assert.equal(firstLine('> 인용뿐'), '> 인용뿐');
  assert.equal(firstLine(null), '');
  assert.equal(firstLine('첫 줄\r\n둘째 줄'), '첫 줄', 'Windows 줄바꿈');
});

test('TextPreview: HTML 주석과 태그를 지운다', () => {
  assert.equal(firstLine('<!-- summary -->\n<details><summary>요약</summary>\n본문'), '요약');
  assert.equal(firstLine('<!-- a\nb -->\n실제 내용'), '실제 내용');
  assert.equal(firstLine('a < b 비교'), 'a < b 비교');
});

test('EventBuilder: id에 저장소가 들어가 저장소끼리 겹치지 않는다', () => {
  const events = build();
  assert.ok(events.every((e) => e.id.startsWith(`${repo}#`) && e.repo === repo));
  const other = new Set(EventBuilder.build(sampleSnapshot(), 'org/other', since).map((e) => e.id));
  assert.ok(events.every((e) => !other.has(e.id)));
});

test('EventBuilder: PR', () => {
  const events = byID(build());
  assert.equal(events.get(id('pr-open:33')).kind, 'prOpened');
  assert.equal(events.get(id('pr-open:32')), undefined, 'since 이전에 열린 PR');
  assert.equal(events.get(id('pr-merged:32')).actor, 'me', '머지한 사람은 pr_merge 활동에서 찾는다');
  assert.equal(events.get(id('pr-closed:32')), undefined, '머지된 PR은 닫힘으로 또 만들지 않는다');
  assert.equal(events.get(id('pr-closed:31')).kind, 'prClosed');
});

test('EventBuilder: 리뷰와 댓글', () => {
  const events = byID(build());
  assert.equal(events.get(id('review:1')).kind, 'reviewApproved');
  assert.equal(events.get(id('review:2')), undefined, '빈 COMMENTED 리뷰는 건너뛴다');
  assert.equal(events.get(id('review:3')).title, '전체 의견');
  assert.equal(events.get(id('review:4')), undefined, 'since 이전 리뷰');
  assert.equal(events.get(id('rc:10')), undefined, '리뷰 항목과 겹치는 인라인 댓글');
  assert.equal(events.get(id('rc:11')).title, '답글');
  assert.equal(events.get(id('rc:11')).number, 33);
  assert.equal(events.get(id('ic:20')).isIssue, false);
  assert.equal(events.get(id('ic:21')).isIssue, true);
  assert.equal(events.get(id('ic:21')).number, 7);
});

test('EventBuilder: push', () => {
  const events = byID(build());
  const push = events.get(id('act:100'));
  assert.equal(push.kind, 'push');
  assert.equal(push.branch, 'feat/a');
  assert.equal(push.url, 'https://github.com/org/repo/compare/b1...a1');
  assert.equal(push.detailResolved, false);
  assert.equal(events.get(id('act:101')).kind, 'forcePush');
  assert.equal(events.get(id('act:102')).kind, 'branchCreated');
  assert.equal(events.get(id('act:102')).url, 'https://github.com/org/repo/tree/feat/c');
  for (const skipped of ['act:103', 'act:104', 'act:105', 'act:106']) {
    assert.equal(events.get(id(skipped)), undefined, `${skipped}: pr_merge·브랜치 삭제·오래된 push·봇 push는 뺀다`);
  }
});

test('EventBuilder: 오래된 것부터 정렬된다', () => {
  const times = build().map((e) => Date.parse(e.time));
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

function laterState() {
  const state = WatchState.createState();
  state.me = 'me';
  state.lastChecked = '2026-11-09T05:00:00Z';
  return state;
}

test('WatchState: 첫 실행은 알리지 않고 기록만 채운다', () => {
  const events = build();
  const state = WatchState.createState();
  state.me = 'me';
  const toNotify = WatchState.apply(state, events, { now, includeOwn: false });
  assert.deepEqual(toNotify, []);
  assert.equal(state.history.length, events.length - 1, '내 머지 1건은 빠진다');
  assert.equal(WatchState.unreadCount(state), 0);
  assert.equal(state.lastChecked, now);
});

test('WatchState: 다음 실행부터 다른 사람 활동을 한 번만 알린다', () => {
  const events = build();
  const state = laterState();
  const notified = new Set(WatchState.apply(state, events, { now, includeOwn: false }).map((e) => e.id));
  assert.ok(notified.has(id('pr-open:33')));
  assert.ok(!notified.has(id('pr-merged:32')), '내 활동은 알리지 않는다');
  assert.ok(state.seen[id('pr-merged:32')], '다시 판단하지 않게 본 항목에는 남긴다');
  assert.equal(WatchState.unreadCount(state), notified.size);

  const again = WatchState.apply(state, events, { now: '2026-11-09T06:02:00Z', includeOwn: false });
  assert.deepEqual(again, [], '같은 항목은 다시 알리지 않는다');
});

test('WatchState: 내 활동 포함 — 목록에는 읽음으로 넣고 알리지 않는다', () => {
  const state = laterState();
  const notified = WatchState.apply(state, build(), { now, includeOwn: true }).map((e) => e.id);
  const merged = state.history.find((e) => e.id === id('pr-merged:32'));
  assert.ok(merged, '내 활동도 목록에는 보인다');
  assert.equal(merged.isUnread, false, '내가 한 일은 안 읽음이 아니다');
  assert.ok(!notified.includes(id('pr-merged:32')), '내가 한 일을 나에게 알리지 않는다');
});

test('WatchState: 본 항목은 만료되고 기록은 상한을 넘지 않는다', () => {
  const state = laterState();
  state.seen = { old: '2026-11-01T00:00:00Z' };
  const config = { ...WatchState.DEFAULT_CONFIG, historyLimit: 3 };
  WatchState.apply(state, build(), { now, includeOwn: true, config });
  assert.equal(state.seen.old, undefined);
  assert.equal(state.history.length, 3);
  const times = state.history.map((e) => Date.parse(e.time));
  assert.deepEqual(times, [...times].sort((a, b) => b - a), '최신순');
});

test('WatchState: 읽음 표시', () => {
  const state = laterState();
  WatchState.apply(state, build(), { now, includeOwn: false });
  WatchState.markRead(state, state.history[0].id);
  assert.equal(state.history[0].isUnread, false);
  assert.ok(WatchState.unreadCount(state) > 0);
  WatchState.markRead(state);
  assert.equal(WatchState.unreadCount(state), 0);
});

test('WatchState: 예전 형식은 조용히 다시 시작한다', () => {
  const stale = laterState();
  stale.version = 0;
  stale.history = build();
  const migrated = WatchState.migrated(stale);
  assert.equal(migrated.me, 'me');
  assert.equal(migrated.lastChecked, null);
  assert.deepEqual(migrated.history, []);
  assert.deepEqual(WatchState.migrated(null), WatchState.createState(), '망가진 파일');
});

test('WatchState: JSON으로 저장했다 읽어도 같다', () => {
  const state = laterState();
  WatchState.apply(state, build(), { now, includeOwn: false });
  const restored = WatchState.migrated(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(restored.history, state.history);
  assert.equal(WatchState.unreadCount(restored), WatchState.unreadCount(state));
});

test('RepoSelector: 최근 push나 새 알림이 있는 저장소만 고른다', () => {
  const repos = [
    { full_name: 'a/pushed', pushed_at: '2026-11-08T00:00:00Z', archived: false },
    { full_name: 'a/quiet', pushed_at: '2026-10-01T00:00:00Z', archived: false },
    { full_name: 'a/archived', pushed_at: recent, archived: true },
    { full_name: 'a/never', pushed_at: null, archived: false },
  ];
  const notifications = [
    { repository: { full_name: 'b/commented' }, updated_at: recent },
    { repository: { full_name: 'b/stale' }, updated_at: old },
    { repository: { full_name: 'a/pushed' }, updated_at: recent },
  ];
  assert.deepEqual(WatchState.selectRepos(repos, notifications, { since, now }), ['a/pushed', 'b/commented']);
});

function api(pushTime) {
  return fakeGitHub([
    ['user/repos', [{ full_name: 'org/repo', pushed_at: pushTime, archived: false },
      { full_name: 'org/broken', pushed_at: pushTime, archived: false }]],
    ['user', { login: 'me' }],
    ['notifications', []],
    ['repos/org/repo/pulls/comments', []],
    ['repos/org/repo/pulls', []],
    ['repos/org/repo/issues/comments', []],
    ['repos/org/repo/activity', [{ id: 1, activity_type: 'push', ref: 'refs/heads/main', before: 'aaa', after: 'bbb',
      actor: user('amy'), timestamp: pushTime }]],
    ['repos/org/repo/compare/aaa...bbb', { total_commits: 2,
      commits: [{ commit: { message: '첫 커밋' } }, { commit: { message: 'fix: 마지막 커밋\n\n본문' } }] }],
  ]);
}

test('Poller: 첫 실행은 조용하고, 같은 push는 다시 알리지 않는다', async () => {
  const first = await Poller.refresh(api(recent), WatchState.createState(), { now, includeOwn: false });
  assert.deepEqual(first.newEvents, [], '첫 실행은 알리지 않는다');
  assert.equal(first.state.me, 'me');
  assert.deepEqual(first.state.checkedRepos, ['org/broken', 'org/repo']);
  assert.deepEqual(first.failedRepos, ['org/broken'], '읽지 못한 저장소는 따로 알리고 나머지는 계속한다');
  assert.equal(first.state.history[0].commitCount, 2);
  assert.equal(first.state.history[0].title, 'fix: 마지막 커밋');

  const second = await Poller.refresh(api('2026-11-09T06:01:00Z'), first.state,
    { now: '2026-11-09T06:02:00Z', includeOwn: false });
  assert.deepEqual(second.newEvents, [], '같은 id(act:1)라 이미 본 항목으로 걸러진다');
});

test('Poller: 다음 실행은 커밋 제목을 채운 push를 알린다', async () => {
  const state = WatchState.createState();
  state.me = 'me';
  state.lastChecked = '2026-11-09T05:25:00Z';
  const result = await Poller.refresh(api(recent), state, { now, includeOwn: false });
  assert.equal(result.newEvents.length, 1);
  assert.equal(result.newEvents[0].title, 'fix: 마지막 커밋', '알림에도 커밋 제목이 들어간다');
  assert.equal(WatchState.unreadCount(result.state), 1);
  assert.equal(state.history.length, 0, '넘긴 상태는 바꾸지 않는다');
});

test('Poller: since는 밀리초 없는 ISO 시각으로 보낸다', async () => {
  const fake = api(recent);
  await Poller.refresh(fake, laterState(), { now, includeOwn: false });
  // 댓글은 10분 단위, 알림함은 1시간 단위로 맞춘 since를 쓴다(같은 주소가 반복돼 304를 받도록).
  assert.ok(fake.calls.some((call) => call.includes('issues/comments?since=2026-11-09T04:50:00Z')), fake.calls.join('\n'));
  assert.ok(fake.calls.includes('notifications?all=true&since=2026-11-09T04:00:00Z&per_page=50'), fake.calls.join('\n'));
});

test('Poller: compare가 실패하면 마지막 커밋 제목만 읽는다', async () => {
  const fake = fakeGitHub([['repos/o/r/commits/bbb', { commit: { message: '강제 push 뒤 커밋' } }]]);
  const resolved = await Poller.resolvePush(fake, { id: 'x', repo: 'o/r', kind: 'forcePush', before: 'gone', after: 'bbb', title: '', detailResolved: false });
  assert.equal(resolved.title, '강제 push 뒤 커밋');
  assert.equal(resolved.detailResolved, true);
});
