// 한 번의 확인(새로고침): 움직인 저장소 고르기 → 저장소별로 읽기 → 항목 만들기 → 상태 갱신.
// ActivityPoller.swift와 같은 순서와 API 호출을 쓴다.
'use strict';

const { isPush } = require('./models');
const { firstLine } = require('./text-preview');
const EventBuilder = require('./event-builder');
const WatchState = require('./watch-state');

/** GitHub이 받는 꼴의 ISO 시각(밀리초 없음). */
function iso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * @param {{get: (path: string) => Promise<any>}} api
 * @param {object} current  지금 상태(바꾸지 않는다)
 * @param {{now: string, includeOwn: boolean, config?: object}} options
 * @returns {Promise<{state: object, newEvents: object[], failedRepos: string[]}>}
 */
async function refresh(api, current, { now, includeOwn, config = WatchState.DEFAULT_CONFIG }) {
  const state = WatchState.clone(WatchState.migrated(current));
  if (state.me === '') {
    state.me = (await api.get('user')).login;
  }
  const since = iso(state.lastChecked ? Date.parse(state.lastChecked) - config.overlap : Date.parse(now) - config.firstRunLookback);

  // 알림함은 저장소를 고르는 보조 자료다. 세분화 토큰(fine-grained)처럼 알림함을 읽을 수 없는 토큰이면
  // 실패해도 멈추지 않고 최근 push가 있는 저장소만으로 계속한다. 토큰 자체가 틀린 401만 그대로 올린다.
  const optional = (error) => {
    // 토큰이 틀렸거나(401) 한도에 걸린 것은 토큰 종류 문제가 아니라 그대로 알린다.
    if (error && (error.kind === 'unauthorized' || error.kind === 'rateLimited')) throw error;
    return null;
  };
  const [repos, notifications] = await Promise.all([
    api.get(`user/repos?sort=pushed&direction=desc&per_page=${config.discoveryPageSize}`
      + '&affiliation=owner,collaborator,organization_member'),
    api.get(`notifications?all=true&since=${since}&per_page=50`).catch(optional),
  ]);
  const selected = WatchState.selectRepos(repos, notifications || [], { since, now, config });

  const { events, failed, rateLimit } = await collect(api, selected, since, config);
  // 저장소를 읽다가 한도에 걸렸으면 이번 결과를 버린다. 마지막 확인 시각을 그대로 두어야
  // 한도가 풀린 뒤 이 구간을 다시 읽는다(앞으로 밀면 그 사이 활동이 빠진다).
  if (rateLimit) throw rateLimit;
  state.checkedRepos = selected;
  const newEvents = WatchState.apply(state, events, { now, includeOwn, config });

  // push의 커밋 제목은 기록에 새로 들어온 push에만 한 번 읽어 API 호출을 줄인다.
  for (const event of state.history.filter((e) => isPush(e.kind) && !e.detailResolved)) {
    const resolved = await resolvePush(api, event);
    WatchState.update(state, resolved);
    const index = newEvents.findIndex((e) => e.id === resolved.id);
    if (index >= 0) newEvents[index] = resolved;
  }
  return { state, newEvents, failedRepos: failed, notificationsUnavailable: notifications == null };
}

async function collect(api, repos, since, config) {
  const events = [];
  const failed = [];
  let rateLimit = null;
  // 한꺼번에 너무 많이 보내지 않도록 maxConcurrentRepos개씩 나눠 읽는다.
  for (let start = 0; start < repos.length; start += config.maxConcurrentRepos) {
    const chunk = repos.slice(start, start + config.maxConcurrentRepos);
    const results = await Promise.all(chunk.map(async (repo) => {
      try {
        return { repo, built: EventBuilder.build(await snapshot(api, repo, since), repo, since) };
      } catch (error) {
        return { repo, built: null, error };
      }
    }));
    for (const { repo, built, error } of results) {
      if (built) events.push(...built);
      else failed.push(repo);
      if (error && error.kind === 'rateLimited') rateLimit = error;
    }
    // 한도에 걸렸으면 남은 저장소는 읽지 않는다(더 보내도 실패한다).
    if (rateLimit) break;
  }
  events.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  return { events, failed: failed.sort(), rateLimit };
}

async function snapshot(api, repo, since) {
  const [pulls, reviewComments, issueComments, activity] = await Promise.all([
    api.get(`repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=30`),
    api.get(`repos/${repo}/pulls/comments?since=${since}&sort=created&direction=desc&per_page=100`),
    api.get(`repos/${repo}/issues/comments?since=${since}&sort=created&direction=desc&per_page=100`),
    api.get(`repos/${repo}/activity?per_page=50`),
  ]);
  const reviewsByPR = {};
  for (const pull of pulls) {
    if (pull.updated_at && Date.parse(pull.updated_at) >= Date.parse(since)) {
      reviewsByPR[pull.number] = await api.get(`repos/${repo}/pulls/${pull.number}/reviews?per_page=100`);
    }
  }
  return { pulls, reviewsByPR, reviewComments, issueComments, activity };
}

/** push에 커밋 수와 마지막 커밋 제목을 채운다. 실패해도 항목은 그대로 보인다. */
async function resolvePush(api, event) {
  const resolved = { ...event, detailResolved: true };
  if (!event.after) return resolved;
  if (event.before && event.before !== EventBuilder.ZERO_SHA) {
    try {
      const compare = await api.get(`repos/${event.repo}/compare/${event.before}...${event.after}`);
      const last = compare.commits[compare.commits.length - 1];
      if (last) {
        resolved.commitCount = compare.total_commits != null ? compare.total_commits : compare.commits.length;
        resolved.title = firstLine(last.commit.message);
        return resolved;
      }
    } catch {
      // 강제 push 뒤에는 before 커밋이 사라져 compare가 실패할 수 있다. 아래에서 마지막 커밋만 읽는다.
    }
  }
  try {
    const commit = await api.get(`repos/${event.repo}/commits/${event.after}`);
    resolved.title = firstLine(commit.commit.message);
  } catch (error) {
    // 한도·네트워크처럼 잠시 뒤 될 수 있는 실패는 '다 읽음'으로 두지 않아 다음 확인 때 다시 읽는다
    // (예전에는 어떤 실패든 다 읽음으로 표시해, 커밋 제목이 영영 비었다). 커밋이 사라진 경우(404 등)는 그대로 둔다.
    if (isTemporary(error)) resolved.detailResolved = false;
  }
  return resolved;
}

/** 잠시 뒤 다시 하면 될 수 있는 실패인지(한도·네트워크·서버 오류). */
function isTemporary(error) {
  if (!error) return false;
  if (error.kind === 'rateLimited' || error.kind === 'network') return true;
  return error.kind === 'http' && error.status >= 500;
}

module.exports = { refresh, collect, snapshot, resolvePush, isTemporary, iso };
