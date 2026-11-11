// 앱 상태(본 항목, 최근 기록, 마지막 확인 시각)와 상태를 바꾸는 순수 함수(WatchState.swift와 같은 규칙).
// 상태는 JSON으로 저장하는 평범한 객체다. version이 다르면 기록을 비우고 첫 실행처럼 알림 없이 다시 채운다.
'use strict';

const { time } = require('./models');

const CURRENT_VERSION = 2;

/** 확인 주기와 범위. 저장소가 100개를 넘어도 API 한도(시간당 5,000회) 안에서 돌게 정했다. */
const DEFAULT_CONFIG = Object.freeze({
  /** 이 기간 안에 push가 있었던 저장소는 매번 자세히 읽는다. */
  activeWindow: 3 * 24 * 3600 * 1000,
  /** push 순으로 받을 저장소 수. */
  discoveryPageSize: 30,
  /** 이전 확인 시각보다 조금 앞부터 다시 읽어 경계에서 빠지는 항목을 막는다. */
  overlap: 10 * 60 * 1000,
  /** 처음 실행할 때 거슬러 읽는 기간. 이때는 알림을 보내지 않는다. */
  firstRunLookback: 24 * 3600 * 1000,
  /** 본 항목 id를 기억하는 기간. */
  seenRetention: 3 * 24 * 3600 * 1000,
  historyLimit: 150,
  /** 저장소(그리고 한 저장소 안의 PR 리뷰·push 커밋 제목)를 동시에 읽는 수. 너무 높으면 GitHub 2차 한도에 걸린다. */
  maxConcurrentRepos: 4,
  /**
   * since를 이 단위(10분)로 내려 맞춘다. 1~2분마다 확인해도 'since=' 주소가 한동안 같아져서
   * 조건부 요청(ETag)으로 304를 받을 수 있다(304는 API 한도에 세지 않는다). 더 읽는 앞부분은 본 항목으로 걸러진다.
   */
  sinceGranularity: 10 * 60 * 1000,
});

/**
 * retrySince: 지난 확인 때 읽지 못한 저장소와, 다음에 거기서부터 다시 읽을 시각(ISO).
 * 일부 저장소가 실패해도 lastChecked는 앞으로 가므로, 이 값이 없으면 그 저장소의 그 사이 활동이 빠진다.
 */
function createState() {
  return { version: CURRENT_VERSION, me: '', lastChecked: null, seen: {}, history: [], checkedRepos: [], retrySince: {} };
}

/** 형식이 다르거나 망가진 상태면 로그인 이름만 남기고 비운다. 시각이 망가진 값은 버린다(확인마다 오류로 멈추지 않게). */
function migrated(state) {
  if (state && state.version === CURRENT_VERSION && Array.isArray(state.history)) {
    const valid = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
    const merged = { ...createState(), ...state };
    if (merged.lastChecked != null && !valid(merged.lastChecked)) merged.lastChecked = null;
    merged.history = merged.history.filter((event) => event && valid(event.time));
    merged.retrySince = Object.fromEntries(Object.entries(merged.retrySince || {}).filter(([, value]) => valid(value)));
    return merged;
  }
  const fresh = createState();
  if (state && typeof state.me === 'string') fresh.me = state.me;
  return fresh;
}

function clone(state) {
  return JSON.parse(JSON.stringify(state));
}

const sortNewestFirst = (a, b) => time(b.time) - time(a.time);

/**
 * 새 항목을 기록에 넣고, 알림을 보낼 항목을 돌려준다. state를 직접 바꾼다.
 * - 처음 실행(lastChecked 없음)이면 읽음으로만 넣고 알리지 않는다.
 * - 내 활동은 includeOwn이 아니면 기록에도 넣지 않고 본 항목으로만 남긴다.
 */
function apply(state, events, { now, includeOwn, config = DEFAULT_CONFIG }) {
  const isFirstRun = state.lastChecked == null;
  const toNotify = [];
  // 이미 기록에 있거나, 이름이 바뀐 저장소에서 같은 GitHub 항목(댓글·리뷰·활동 id)을 본 적 있으면 다시 넣지 않는다.
  const inHistory = new Set(state.history.map((e) => e.id));
  const seenGlobal = new Set(Object.keys(state.seen).map(globalKey).filter(Boolean));
  for (const original of events) {
    const key = globalKey(original.id);
    if (state.seen[original.id] != null || inHistory.has(original.id) || (key && seenGlobal.has(key))) {
      // 이미 본 항목이라도 예전 기록에 없던 PR 작성자 정보는 채운다.
      if (original.prAuthor) {
        const existing = state.history.find((e) => e.id === original.id && e.prAuthor == null);
        if (existing) existing.prAuthor = original.prAuthor;
      }
      continue;
    }
    state.seen[original.id] = original.time;
    const own = isOwn(original, state.me);
    if (!includeOwn && own) continue;
    // includeOwn이어도 내 활동은 읽음으로 넣고 알리지 않는다(내가 한 일을 나에게 알릴 까닭이 없다).
    const event = { ...original, isUnread: !isFirstRun && !own };
    state.history.push(event);
    if (event.isUnread) toNotify.push(event);
  }
  // 시계가 잠깐 앞으로 뛰어도(며칠 뒤) 본 항목을 지우지 않게, 지난 확인 시각과 지금 중 이른 쪽을 기준으로 지운다.
  const reference = state.lastChecked ? Math.min(time(state.lastChecked), time(now)) : time(now);
  const cutoff = reference - config.seenRetention;
  for (const [id, seenAt] of Object.entries(state.seen)) {
    if (!(time(seenAt) >= cutoff)) delete state.seen[id];
  }
  state.history.sort(sortNewestFirst);
  trim(state, config.historyLimit);
  state.lastChecked = now;
  // 기록 상한으로 바로 빠진 항목은 알리지 않는다(눌러도 목록에서 찾을 수 없는 알림이 되지 않게).
  const kept = new Set(state.history.map((e) => e.id));
  return toNotify.filter((e) => kept.has(e.id));
}

/** 저장소 이름이 바뀌어도 같은 항목으로 알아볼 수 있는 GitHub 전역 id(댓글·리뷰·활동). PR 번호는 저장소마다 달라 넣지 않는다. */
function globalKey(id) {
  const hash = id.indexOf('#');
  if (hash < 0) return null;
  const suffix = id.slice(hash + 1);
  return /^(ic|rc|review|act):/.test(suffix) ? suffix : null;
}

/**
 * 내가 한 활동인지(WatchState.isOwn과 같은 규칙). PR 닫힘은 목록 API가 닫은 사람을 알려 주지 않는데,
 * 내 PR이 닫힌 것은 대개 내가 닫은 것이라 내 활동으로 본다(머지는 다른 사람이 하는 일이 많아 그렇게 보지 않는다).
 */
function isOwn(event, me) {
  if (!me) return false;
  if (event.actor === me) return true;
  return !event.actor && event.kind === 'prClosed' && event.prAuthor === me;
}

/** 기록을 limit개로 줄인다. 가장 오래된 읽은 항목부터 버리고, 그래도 넘치면 오래된 안 읽은 항목을 버린다. */
function trim(state, limit) {
  let excess = state.history.length - limit;
  if (excess <= 0) return;
  const keep = state.history.map(() => true);
  for (let index = state.history.length - 1; index >= 0 && excess > 0; index -= 1) {
    if (!state.history[index].isUnread) { keep[index] = false; excess -= 1; }
  }
  for (let index = state.history.length - 1; index >= 0 && excess > 0; index -= 1) {
    if (keep[index]) { keep[index] = false; excess -= 1; }
  }
  state.history = state.history.filter((_, index) => keep[index]);
}

/** id가 없으면 모두 읽음으로 바꾼다. */
function markRead(state, id) {
  for (const event of state.history) {
    if (id == null || event.id === id) event.isUnread = false;
  }
}

function markRepoRead(state, repo) {
  for (const event of state.history) {
    if (event.repo === repo) event.isUnread = false;
  }
}

function markUnread(state, id) {
  for (const event of state.history) {
    if (event.id === id) event.isUnread = true;
  }
}

/** 여러 항목을 한 번에 읽음으로 바꾼다(묶음의 '읽음 표시', '모두 읽음'). */
function markReadIds(state, ids) {
  const set = new Set(ids);
  for (const event of state.history) {
    if (set.has(event.id)) event.isUnread = false;
  }
}

/** '되돌리기': 방금 읽음으로 바꾼 항목을 다시 안 읽음으로. */
function markUnreadIds(state, ids) {
  const set = new Set(ids);
  for (const event of state.history) {
    if (set.has(event.id)) event.isUnread = true;
  }
}

/**
 * 항목을 열었을 때: 같은 PR·이슈(저장소 + 번호)의 안 읽은 항목도 함께 읽음으로 바꾼다.
 * 페이지를 열면 그 PR의 리뷰·댓글도 함께 보게 되기 때문이다. 번호가 없는 항목(push 등)은 그 항목만 바꾼다.
 * GitHub에서 PR과 이슈는 저장소 안에서 번호를 나눠 쓰므로 저장소 + 번호로 같은 대화를 가린다.
 */
function markThreadRead(state, id) {
  const opened = state.history.find((event) => event.id === id);
  if (!opened) return;
  if (opened.number == null) return markRead(state, id);
  for (const event of state.history) {
    if (event.repo === opened.repo && event.number === opened.number) event.isUnread = false;
  }
}

/**
 * 새로고침 결과(refreshed)에 지금 상태(current)의 읽음 표시를 옮겨 온 새 상태를 돌려준다.
 * 새로고침이 도는 몇 초 동안 사용자가 바꾼 읽음 표시를 결과가 덮어쓰지 않게 한다.
 */
function adoptingReadMarks(refreshed, current) {
  const marks = new Map();
  for (const event of current.history) {
    if (!marks.has(event.id)) marks.set(event.id, event.isUnread);
  }
  const merged = clone(refreshed);
  for (const event of merged.history) {
    if (marks.has(event.id)) event.isUnread = marks.get(event.id);
  }
  return merged;
}

function update(state, event) {
  const index = state.history.findIndex((e) => e.id === event.id);
  if (index >= 0) state.history[index] = event;
}

function unreadCount(state) {
  return state.history.filter((e) => e.isUnread).length;
}

/**
 * 자세히 읽을 저장소를 고른다. 최근 push가 있었거나 알림함에 since 이후 소식이 온 저장소.
 * 알림함은 push 없이 댓글·리뷰만 달린 저장소를 잡는다.
 */
function selectRepos(repos, notifications, { since, now, config = DEFAULT_CONFIG }) {
  const activeSince = time(now) - config.activeWindow;
  const selected = new Set(
    repos
      .filter((repo) => repo.archived !== true && repo.pushed_at != null && time(repo.pushed_at) >= activeSince)
      .map((repo) => repo.full_name),
  );
  for (const thread of notifications) {
    if (time(thread.updated_at) >= time(since)) selected.add(thread.repository.full_name);
  }
  return [...selected].sort();
}

module.exports = {
  CURRENT_VERSION,
  DEFAULT_CONFIG,
  createState,
  migrated,
  clone,
  apply,
  isOwn,
  markRead,
  markRepoRead,
  markUnread,
  markReadIds,
  markUnreadIds,
  markThreadRead,
  adoptingReadMarks,
  update,
  unreadCount,
  selectRepos,
};
