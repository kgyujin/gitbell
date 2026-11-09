// ActivityQueryTests.swift, PreferencesTests.swift, ReleaseReviewTests.swift를 옮긴 검증.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeEvent, notificationGroupOf, EventKind, NotificationGroup } = require('../../src/core/models');
const Query = require('../../src/core/activity-query');
const Prefs = require('../../src/core/preferences');
const WatchState = require('../../src/core/watch-state');
const EventBuilder = require('../../src/core/event-builder');

const base = Date.parse('2026-11-09T12:00:00Z');
const utcStartOfDay = (iso) => `${iso.slice(0, 10)}T00:00:00.000Z`;

function event(id, repo, kind, hoursAgo, { unread = false, actor = 'amy', title = '', number = null, branch = null } = {}) {
  return makeEvent({ id, repo, kind, time: new Date(base - hoursAgo * 3600 * 1000).toISOString(), actor, number, branch,
    title, url: `https://github.com/${repo}`, isUnread: unread });
}

const events = () => [
  event('1', 'acme/web', 'prMerged', 1, { unread: true, title: 'Add login page', number: 12 }),
  event('2', 'acme/api', 'comment', 2, { actor: 'bob', title: 'Looks good', number: 7 }),
  event('3', 'acme/web', 'push', 3, { unread: true, title: 'fix typo', branch: 'feat/search' }),
  event('4', 'acme/api', 'reviewApproved', 30, { title: 'LGTM', number: 8 }),
  event('5', 'you/dotfiles', 'prOpened', 50, { title: 'zsh tweaks', number: 1 }),
];
const ids = (list) => list.map((e) => e.id);
const q = (fields) => Query.createQuery(fields);

test('Query: 필터는 AND로 묶인다', () => {
  assert.deepEqual(ids(Query.filter(q({ category: 'reviews' }), events())), ['2', '4']);
  assert.deepEqual(ids(Query.filter(q({ repo: 'acme/web' }), events())), ['1', '3']);
  assert.deepEqual(ids(Query.filter(q({ repo: 'acme/web', unreadOnly: true }), events())), ['1', '3']);
  assert.deepEqual(ids(Query.filter(q({ category: 'commits', repo: 'acme/web' }), events())), ['3']);
  assert.deepEqual(Query.filter(q({ category: 'pullRequests', repo: 'acme/api' }), events()), []);
});

test('Query: 검색은 낱말마다 여러 필드에서 찾는다', () => {
  assert.deepEqual(ids(Query.filter(q({ search: 'LOGIN' }), events())), ['1'], '대소문자 무시');
  assert.deepEqual(ids(Query.filter(q({ search: 'bob' }), events())), ['2'], '사람 이름');
  assert.deepEqual(ids(Query.filter(q({ search: 'feat/search' }), events())), ['3'], '브랜치');
  assert.deepEqual(ids(Query.filter(q({ search: '#8' }), events())), ['4'], 'PR 번호');
  assert.deepEqual(ids(Query.filter(q({ search: 'web merged' }), events())), ['1'], '낱말마다 AND');
  assert.equal(Query.filter(q({ search: '   ' }), events()).length, 5, '공백만은 필터 아님');
});

test('Query: isFiltering', () => {
  assert.equal(Query.isFiltering(q()), false);
  assert.equal(Query.isFiltering(q({ sort: 'byRepository' })), false, '정렬은 필터가 아니다');
  assert.equal(Query.isFiltering(q({ unreadOnly: true })), true);
  assert.equal(Query.isFiltering(q({ search: 'x' })), true);
});

test('Query: 최신순은 날짜별로 묶는다', () => {
  const sections = Query.sections(q({ sort: 'newest' }), events(), { startOfDay: utcStartOfDay });
  assert.deepEqual(sections.map((s) => ids(s.events)), [['1', '2', '3'], ['4'], ['5']]);
  assert.deepEqual(sections[0].key, { type: 'day', date: '2026-11-09T00:00:00.000Z' });
});

test('Query: 저장소별은 최근 활동이 있는 저장소가 위', () => {
  const sections = Query.sections(q({ sort: 'byRepository' }), events());
  assert.deepEqual(sections.map((s) => s.key.repo), ['acme/web', 'acme/api', 'you/dotfiles']);
  assert.deepEqual(ids(sections[0].events), ['1', '3']);
  assert.equal(sections[0].events.filter((e) => e.isUnread).length, 2);
  assert.deepEqual(ids(sections[1].events), ['2', '4']);
});

test('Query: 안 읽은 것 먼저, 빈 묶음은 뺀다', () => {
  const sections = Query.sections(q({ sort: 'unreadFirst' }), events());
  assert.deepEqual(sections.map((s) => s.key.type), ['unread', 'read']);
  assert.deepEqual(ids(sections[0].events), ['1', '3']);
  assert.deepEqual(ids(sections[1].events), ['2', '4', '5']);
  const onlyRead = Query.sections(q({ repo: 'acme/api', sort: 'unreadFirst' }), events());
  assert.deepEqual(onlyRead.map((s) => s.key.type), ['read'], '빈 묶음은 보이지 않는다');
});

test('Query: 기본 날짜 묶음은 이 컴퓨터의 자정 기준', () => {
  const [section] = Query.sections(q(), [events()[0]]);
  const start = new Date(section.key.date);
  assert.equal(start.getHours(), 0);
  assert.equal(start.getMinutes(), 0);
});

test('Query: 저장소 요약', () => {
  const summaries = Query.repositorySummaries(events());
  assert.deepEqual(summaries.map((s) => s.repo), ['acme/web', 'acme/api', 'you/dotfiles']);
  assert.equal(summaries[0].count, 2);
  assert.equal(summaries[0].unreadCount, 2);
  assert.equal(summaries[0].name, 'web');
});

test('WatchState: 한 저장소만 읽음 표시', () => {
  const state = WatchState.createState();
  state.history = events();
  WatchState.markRepoRead(state, 'acme/web');
  assert.equal(WatchState.unreadCount(state), 0);
  state.history[1].isUnread = true;
  WatchState.markRepoRead(state, 'acme/web');
  assert.equal(WatchState.unreadCount(state), 1, '다른 저장소는 그대로');
});

// MARK: 설정

function prefEvent(id, kind, { repo = 'acme/web', actor = 'amy', unread = true } = {}) {
  return makeEvent({ id, repo, kind, time: new Date().toISOString(), actor, title: id, url: `https://github.com/${repo}`, isUnread: unread });
}

test('Prefs: 모든 종류가 알림 묶음에 속한다', () => {
  assert.deepEqual(new Set(Object.values(EventKind).map(notificationGroupOf)), new Set(Object.values(NotificationGroup)));
  assert.equal(notificationGroupOf('prClosed'), 'merges');
  assert.equal(notificationGroupOf('branchCreated'), 'commits');
});

test('Prefs: 알림 묶음과 전체 스위치', () => {
  const prefs = Prefs.notificationPreferences();
  const push = prefEvent('push', 'push');
  const review = prefEvent('review', 'reviewApproved');
  assert.equal(Prefs.allows(prefs, push), true, '처음에는 모두 켜져 있다');
  prefs.groups = prefs.groups.filter((g) => g !== 'commits');
  assert.equal(Prefs.allows(prefs, push), false);
  assert.equal(Prefs.allows(prefs, review), true);
  prefs.isEnabled = false;
  assert.equal(Prefs.allows(prefs, review), false, '전체 끄기가 우선한다');
});

test('Prefs: 숨긴 저장소와 봇', () => {
  const display = Prefs.displayPreferences({ hiddenRepositories: ['acme/secret'], hidesBots: true });
  assert.equal(Prefs.shows(display, prefEvent('a', 'push', { repo: 'acme/secret' })), false);
  assert.equal(Prefs.shows(display, prefEvent('b', 'comment', { actor: 'codex[bot]' })), false);
  assert.equal(Prefs.shows(display, prefEvent('c', 'comment', { actor: 'botman' })), true, '이름에 bot이 들어가도 [bot]이 아니면 사람');
  assert.equal(Prefs.shows(Prefs.displayPreferences(), prefEvent('d', 'comment', { actor: 'codex[bot]' })), true, '기본은 봇도 보인다');
});

test('Prefs: 알림 대상은 두 설정을 함께 따른다', () => {
  const notifications = { ...Prefs.notificationPreferences(), groups: ['reviews', 'comments'] };
  const display = Prefs.displayPreferences({ hiddenRepositories: ['acme/secret'], hidesBots: true });
  const list = [
    prefEvent('1', 'reviewApproved'),
    prefEvent('2', 'push'),
    prefEvent('3', 'comment', { repo: 'acme/secret' }),
    prefEvent('4', 'comment', { actor: 'ci[bot]' }),
    prefEvent('5', 'comment'),
  ];
  assert.deepEqual(ids(Prefs.eventsToNotify(list, notifications, display)), ['1', '5']);
});

test('Prefs: 안 읽은 수는 숨긴 것을 빼고 센다', () => {
  const state = WatchState.createState();
  state.history = [prefEvent('1', 'push'), prefEvent('2', 'push', { repo: 'acme/secret' }), prefEvent('3', 'comment', { unread: false })];
  const display = Prefs.displayPreferences({ hiddenRepositories: ['acme/secret'] });
  assert.equal(Prefs.visibleUnreadCount(state, display), 1);
  WatchState.markUnread(state, '3');
  assert.equal(Prefs.visibleUnreadCount(state, display), 2);
});

test('Prefs: 저장했다 읽어도 같고, 모르는 값은 기본값으로 채운다', () => {
  const prefs = { ...Prefs.notificationPreferences(), groups: ['merges'], playsSound: false };
  assert.deepEqual(Prefs.notificationPreferences(JSON.parse(JSON.stringify(prefs))), prefs);
  const old = Prefs.notificationPreferences({ isEnabled: true, playsSound: false, groups: ['reviews', 'unknown'] });
  assert.equal(old.playsSound, false);
  assert.deepEqual(old.groups, ['reviews']);
  assert.equal(old.onlyMyPullRequests, false);
  assert.deepEqual(Prefs.notificationPreferences('garbage'), Prefs.notificationPreferences());
});

test('Prefs: 버전 비교', () => {
  assert.equal(Prefs.isNewerVersion('0.3.0', '0.2.0'), true);
  assert.equal(Prefs.isNewerVersion('0.10.0', '0.9.9'), true, '문자열이 아니라 숫자로 비교');
  assert.equal(Prefs.isNewerVersion('1.0', '0.9.9'), true);
  assert.equal(Prefs.isNewerVersion('0.2.0', '0.2.0'), false);
  assert.equal(Prefs.isNewerVersion('0.1.9', '0.2.0'), false);
  assert.equal(Prefs.isNewerVersion('0.0.0-stage', '0.2.0'), false);
});

// MARK: 0.4.0 배포 전 검토(ReleaseReviewTests.swift)

const reviewSince = '2026-11-09T05:00:00Z';
const reviewRecent = '2026-11-09T05:30:00Z';

function reviewEvents() {
  return EventBuilder.build({
    pulls: [
      { number: 5, title: '내 PR', html_url: 'https://github.com/o/r/pull/5', user: { login: 'me' }, head: { ref: 'feat/mine' },
        created_at: '2026-11-08T00:00:00Z', updated_at: reviewRecent, merged_at: null, closed_at: null, merge_commit_sha: null },
      { number: 6, title: '남의 PR', html_url: 'https://github.com/o/r/pull/6', user: { login: 'amy' }, head: { ref: 'feat/amy' },
        created_at: reviewRecent, updated_at: reviewRecent, merged_at: null, closed_at: null, merge_commit_sha: null },
    ],
    reviewsByPR: { 5: [{ id: 1, state: 'APPROVED', body: '', user: { login: 'bob' }, submitted_at: reviewRecent, html_url: 'https://r/1' }] },
    issueComments: [
      { id: 2, issue_url: 'https://api/issues/5', html_url: 'https://github.com/o/r/pull/5#c', user: { login: 'amy' }, body: '좋아요', created_at: reviewRecent },
      { id: 3, issue_url: 'https://api/issues/9', html_url: 'https://github.com/o/r/issues/9#c', user: { login: 'amy' }, body: '이슈 댓글', created_at: reviewRecent },
    ],
    activity: [
      { id: 10, activity_type: 'push', ref: 'refs/heads/feat/mine', before: 'a', after: 'b', actor: { login: 'bob' }, timestamp: reviewRecent },
      { id: 11, activity_type: 'push', ref: 'refs/heads/feat/amy', before: 'c', after: 'd', actor: { login: 'amy' }, timestamp: reviewRecent },
    ],
  }, 'o/r', reviewSince);
}
const find = (list, suffix) => list.find((e) => e.id === `o/r#${suffix}`);

test('내 PR: PR 작성자를 붙인다', () => {
  const list = reviewEvents();
  assert.equal(find(list, 'review:1').prAuthor, 'me', '리뷰 → PR 번호로 찾는다');
  assert.equal(find(list, 'ic:2').prAuthor, 'me', 'PR 댓글 → PR 번호로 찾는다');
  assert.equal(find(list, 'ic:3').prAuthor, null, '이슈 댓글은 PR이 아니다');
  assert.equal(find(list, 'act:10').prAuthor, 'me', 'push → 브랜치로 찾는다');
  assert.equal(find(list, 'act:11').prAuthor, 'amy');
  assert.equal(find(list, 'pr-open:6').prAuthor, 'amy');
});

test('내 PR: 필터는 내 PR에서 다른 사람이 한 활동만 남긴다', () => {
  const list = reviewEvents();
  const query = q({ mineOnly: true, me: 'me' });
  assert.deepEqual(new Set(ids(Query.filter(query, list))), new Set(['o/r#review:1', 'o/r#ic:2', 'o/r#act:10']));
  assert.equal(Query.isFiltering(query), true);
  assert.deepEqual(Query.filter(q({ mineOnly: true }), list), [], '내 이름을 모르면 아무것도 고르지 않는다');
});

test('내 PR: 알림도 내 PR 소식만', () => {
  const prefs = { ...Prefs.notificationPreferences(), onlyMyPullRequests: true };
  const notified = Prefs.eventsToNotify(reviewEvents(), prefs, Prefs.displayPreferences(), 'me');
  assert.deepEqual(new Set(ids(notified)), new Set(['o/r#review:1', 'o/r#ic:2', 'o/r#act:10']));
});

test('이미 본 항목에는 PR 작성자만 채운다', () => {
  const state = WatchState.createState();
  state.lastChecked = reviewSince;
  const old = { ...find(reviewEvents(), 'review:1'), prAuthor: null };
  WatchState.apply(state, [old], { now: new Date().toISOString(), includeOwn: true });
  assert.equal(state.history[0].prAuthor, null);
  const notified = WatchState.apply(state, [find(reviewEvents(), 'review:1')], { now: new Date().toISOString(), includeOwn: true });
  assert.deepEqual(notified, [], '이미 본 항목은 다시 알리지 않는다');
  assert.equal(state.history[0].prAuthor, 'me', '작성자 정보만 채운다');
});

test('새로고침 중 바꾼 읽음 표시를 지킨다', () => {
  const current = WatchState.createState();
  current.history = reviewEvents().map((e) => ({ ...e, isUnread: true }));
  const refreshed = WatchState.clone(current);
  refreshed.history.push(makeEvent({ id: 'new', repo: 'o/r', kind: 'push', time: new Date().toISOString(), actor: 'x',
    title: '', url: 'https://github.com', isUnread: true }));
  WatchState.markRead(current, 'o/r#review:1');
  WatchState.markRead(current, 'o/r#ic:2');

  const merged = WatchState.adoptingReadMarks(refreshed, current);
  assert.equal(merged.history.find((e) => e.id === 'o/r#review:1').isUnread, false);
  assert.equal(merged.history.find((e) => e.id === 'o/r#ic:2').isUnread, false);
  assert.equal(merged.history.find((e) => e.id === 'new').isUnread, true, '새로 들어온 항목은 그대로 안 읽음');
});
