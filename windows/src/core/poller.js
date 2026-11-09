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

  const [repos, notifications] = await Promise.all([
    api.get(`user/repos?sort=pushed&direction=desc&per_page=${config.discoveryPageSize}`
      + '&affiliation=owner,collaborator,organization_member'),
    api.get(`notifications?all=true&since=${since}&per_page=50`),
  ]);
  const selected = WatchState.selectRepos(repos, notifications, { since, now, config });

  const { events, failed } = await collect(api, selected, since, config);
  state.checkedRepos = selected;
  const newEvents = WatchState.apply(state, events, { now, includeOwn, config });

  // push의 커밋 제목은 기록에 새로 들어온 push에만 한 번 읽어 API 호출을 줄인다.
  for (const event of state.history.filter((e) => isPush(e.kind) && !e.detailResolved)) {
    const resolved = await resolvePush(api, event);
    WatchState.update(state, resolved);
    const index = newEvents.findIndex((e) => e.id === resolved.id);
    if (index >= 0) newEvents[index] = resolved;
  }
  return { state, newEvents, failedRepos: failed };
}

async function collect(api, repos, since, config) {
  const events = [];
  const failed = [];
  // 한꺼번에 너무 많이 보내지 않도록 maxConcurrentRepos개씩 나눠 읽는다.
  for (let start = 0; start < repos.length; start += config.maxConcurrentRepos) {
    const chunk = repos.slice(start, start + config.maxConcurrentRepos);
    const results = await Promise.all(chunk.map(async (repo) => {
      try {
        return { repo, built: EventBuilder.build(await snapshot(api, repo, since), repo, since) };
      } catch {
        return { repo, built: null };
      }
    }));
    for (const { repo, built } of results) {
      if (built) events.push(...built);
      else failed.push(repo);
    }
  }
  events.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  return { events, failed: failed.sort() };
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
  } catch {
    // 제목 없이 보인다.
  }
  return resolved;
}

module.exports = { refresh, collect, snapshot, resolvePush, iso };
