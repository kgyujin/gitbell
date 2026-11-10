// 목록 필터·검색·정렬(ActivityQuery.swift와 같은 규칙).
//
// 필터는 모두 AND로 묶인다: 종류 × 저장소 × 안 읽음만 × 내 PR × 검색어.
// 정렬은 묶는 방식까지 정한다: 최신순(날짜별), 저장소별, 안 읽은 것 먼저.
'use strict';

const { categoryOf, repoName, time } = require('./models');

const SortMode = Object.freeze({ newest: 'newest', byRepository: 'byRepository', unreadFirst: 'unreadFirst' });

function createQuery(fields = {}) {
  return { category: null, repo: null, unreadOnly: false, mineOnly: false, search: '', sort: SortMode.newest, me: '', ...fields };
}

function trimmedSearch(query) {
  return (query.search || '').trim();
}

/** 기본값과 다른 필터가 걸려 있는지(정렬은 필터가 아니라 세지 않는다). */
function isFiltering(query) {
  return query.category != null || query.repo != null || query.unreadOnly || query.mineOnly || trimmedSearch(query) !== '';
}

/** 내가 올린 PR에서 다른 사람이 한 활동인지. */
function isOnMyPullRequest(event, me) {
  return me !== '' && event.prAuthor === me && event.actor !== me;
}

/**
 * 검색 대상: 본문, 저장소(전체 이름), 사람, 브랜치, '#번호', 종류 이름(영문 키와 화면 언어 이름).
 * kindLabels는 { prMerged: '머지됨', ... }처럼 화면에 보이는 종류 이름이다. 없으면 영문 키만 쓴다.
 */
function searchText(event, kindLabels = {}) {
  return [event.title, event.repo, event.actor, event.branch || '', event.number != null ? `#${event.number}` : '',
    event.kind, kindLabels[event.kind] || '']
    .join(' ')
    .toLowerCase();
}

function filter(query, events) {
  const terms = trimmedSearch(query).toLowerCase().split(' ').filter(Boolean);
  return events.filter((event) => {
    if (query.category != null && categoryOf(event.kind) !== query.category) return false;
    if (query.repo != null && event.repo !== query.repo) return false;
    if (query.unreadOnly && !event.isUnread) return false;
    if (query.mineOnly && !isOnMyPullRequest(event, query.me || '')) return false;
    if (terms.length) {
      // 낱말마다 어딘가에 들어 있으면 된다. "web merge"처럼 저장소와 내용을 섞어 찾을 수 있다.
      const haystack = searchText(event, query.kindLabels);
      if (!terms.every((term) => haystack.includes(term))) return false;
    }
    return true;
  });
}

function localStartOfDay(iso) {
  const date = new Date(iso);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).toISOString();
}

/**
 * 필터를 거친 항목을 정렬 방식에 맞게 묶는다. 묶음 안은 항상 최신이 위다.
 * 묶음 key: { type: 'day', date } | { type: 'repository', repo } | { type: 'unread' } | { type: 'read' }
 * @param {{startOfDay?: (iso: string) => string}} options  날짜 묶음 기준(기본: 이 컴퓨터의 시간대)
 */
function sections(query, events, { startOfDay = localStartOfDay } = {}) {
  const items = filter(query, events).sort((a, b) => time(b.time) - time(a.time));
  switch (query.sort) {
    case SortMode.byRepository:
      // items가 최신순이라 처음 나온 순서가 곧 '최근 활동이 있는 저장소 순'이다.
      return group(items, (event) => ({ type: 'repository', repo: event.repo }));
    case SortMode.unreadFirst:
      return [
        { key: { type: 'unread' }, events: items.filter((e) => e.isUnread) },
        { key: { type: 'read' }, events: items.filter((e) => !e.isUnread) },
      ].filter((section) => section.events.length > 0);
    default:
      return group(items, (event) => ({ type: 'day', date: startOfDay(event.time) }));
  }
}

function sectionID(key) {
  return `${key.type}:${key.date || key.repo || ''}`;
}

function group(items, keyOf) {
  const result = [];
  const indexByID = new Map();
  for (const event of items) {
    const key = keyOf(event);
    const id = sectionID(key);
    if (indexByID.has(id)) {
      result[indexByID.get(id)].events.push(event);
    } else {
      indexByID.set(id, result.length);
      result.push({ key, events: [event] });
    }
  }
  return result;
}

/** 저장소 고르기 메뉴에 보일 항목. 기록에 나온 저장소만, 최근 활동 순. */
function repositorySummaries(events) {
  const byRepo = new Map();
  for (const event of events) {
    const summary = byRepo.get(event.repo) || { repo: event.repo, name: repoName(event.repo), count: 0, unreadCount: 0, latest: event.time };
    summary.count += 1;
    if (event.isUnread) summary.unreadCount += 1;
    if (time(event.time) > time(summary.latest)) summary.latest = event.time;
    byRepo.set(event.repo, summary);
  }
  return [...byRepo.values()].sort((a, b) => time(b.latest) - time(a.latest));
}

module.exports = {
  SortMode,
  createQuery,
  isFiltering,
  isOnMyPullRequest,
  filter,
  sections,
  sectionID,
  repositorySummaries,
};
