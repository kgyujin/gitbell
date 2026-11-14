// 한 번의 확인(새로고침): 움직인 저장소 고르기 → 저장소별로 읽기 → 항목 만들기 → 상태 갱신.
'use strict';

const { isPush } = require('./models');
const { firstLine } = require('./text-preview');
const EventBuilder = require('./event-builder');
const WatchState = require('./watch-state');

/** GitHub이 받는 꼴의 ISO 시각(밀리초 없음). */
function iso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** sinceGranularity 단위로 내려 맞춘다(같은 since 주소를 다시 써서 304를 받으려고). */
function rounded(ms, config) {
  const step = config.sinceGranularity;
  return step > 0 ? Math.floor(ms / step) * step : ms;
}

/**
 * 이번 확인에서 읽기 시작할 시각(ms). 지난 확인 시각보다 overlap만큼 앞이고, 하루(firstRunLookback)보다
 * 오래되지 않게 묶는다. 며칠 꺼 두었다 켜도 며칠치 댓글·리뷰를 한꺼번에 읽고 알리지 않게 하려는 것이다.
 */
function sinceTime(lastChecked, now, config) {
  const oldest = Date.parse(now) - config.firstRunLookback;
  const wanted = lastChecked ? Date.parse(lastChecked) - config.overlap : oldest;
  return rounded(Math.max(wanted, oldest), config);
}

/** 목록을 size개씩 나눠, 한 묶음씩 동시에 처리한다. stop이 true를 돌려주면 남은 묶음은 하지 않는다. */
async function inChunks(list, size, work, stop = () => false) {
  const results = [];
  for (let start = 0; start < list.length; start += size) {
    const chunk = await Promise.all(list.slice(start, start + size).map(work));
    results.push(...chunk);
    if (chunk.some(stop)) break;
  }
  return results;
}

/**
 * @param {{get: (path: string) => Promise<any>}} api
 * @param {object} current  지금 상태(바꾸지 않는다)
 * @param {{now: string, includeOwn: boolean, config?: object}} options
 * @returns {Promise<{state: object, newEvents: object[], failedRepos: string[]}>}
 */
async function refresh(api, current, { now, includeOwn, readAll = false, config = WatchState.DEFAULT_CONFIG }) {
  const state = WatchState.clone(WatchState.migrated(current));
  if (state.me === '') {
    state.me = (await api.get('user')).login;
  }
  const sinceMs = sinceTime(state.lastChecked, now, config);
  const since = iso(sinceMs);
  const retry = state.retrySince || {};
  // 지난번에 읽지 못한 저장소는 그때부터 다시 읽는다(하루보다 오래된 것은 읽지 않는다).
  const oldest = rounded(Date.parse(now) - config.firstRunLookback, config);
  // 저장소마다 마지막으로 읽은 때부터 읽는다(조용한 저장소는 매번 읽지 않으므로 전체 since보다 앞일 수 있다).
  const lastRead = state.lastRead || {};
  const sinceFor = (repo) => {
    if (retry[repo]) return iso(Math.max(oldest, Math.min(sinceMs, Date.parse(retry[repo]))));
    if (lastRead[repo]) return iso(Math.max(oldest, Math.min(sinceMs, rounded(Date.parse(lastRead[repo]) - config.overlap, config))));
    return since;
  };
  const budgetLow = () => api.remaining && api.remaining() != null && api.remaining() < config.lowBudget;

  // 알림함은 저장소를 고르는 보조 자료다. 세분화 토큰(fine-grained)처럼 알림함을 읽을 수 없는 토큰이면
  // 실패해도 멈추지 않고 최근 push가 있는 저장소만으로 계속한다. 토큰 자체가 틀린 401만 그대로 올린다.
  const optional = (error) => {
    // 토큰이 틀렸거나(401) 한도에 걸린 것은 토큰 종류 문제가 아니라 그대로 알린다.
    if (error && (error.kind === 'unauthorized' || error.kind === 'rateLimited')) throw error;
    // 잠깐의 네트워크·서버 오류도 '알림함을 못 읽는 토큰'이 아니다. 이번 확인을 통째로 실패로 두어
    // lastChecked를 그대로 둔다(알림함으로만 잡히는 조용한 저장소의 그 사이 댓글을 잃지 않게).
    if (isTemporary(error)) throw error;
    return null;
  };
  // 읽음 동기화를 위해 안 읽은 PR·이슈 활동 중 가장 오래된 것까지 알림함을 읽는다(그 스레드의 읽음 상태를 알아야 한다).
  const unreadThreadTimes = state.history.filter((e) => e.isUnread && WatchState.threadKey(e)).map((e) => Date.parse(e.time));
  const notificationsSince = Math.min(sinceMs, ...unreadThreadTimes);
  const [repos, notifications] = await Promise.all([
    api.get(`user/repos?sort=pushed&direction=desc&per_page=${config.discoveryPageSize}`
      + '&affiliation=owner,collaborator,organization_member'),
    // 알림함은 1시간 단위로 맞춘 since로 읽는다. 같은 주소가 1시간 동안 반복돼 304(한도 미사용)를 받는다.
    // 넓게 읽은 앞부분은 저장소별 마지막 읽은 시각과 견줘 거른다(planRepos).
    api.get(`notifications?all=true&since=${iso(Math.floor(notificationsSince / 3600000) * 3600000)}&per_page=50`).catch(optional),
  ]);
  const selected = WatchState.planRepos(repos, notifications, {
    lastRead, retry: Object.keys(retry), since, now, lowBudget: budgetLow(), readAll, config });

  const { events, failed, retryable, rateLimit } = await collect(api, selected, sinceFor, config);
  // 저장소를 읽다가 한도에 걸렸으면 이번 결과를 버린다. 마지막 확인 시각을 그대로 두어야
  // 한도가 풀린 뒤 이 구간을 다시 읽는다(앞으로 밀면 그 사이 활동이 빠진다).
  if (rateLimit) throw rateLimit;
  state.checkedRepos = selected;
  // 잠시 뒤 될 실패(네트워크·서버 오류)만 기억한다. 지워졌거나 권한이 없어진 저장소(404 등)는
  // 다시 읽어도 실패하므로 기억하지 않는다(기억하면 매번 읽고 '읽지 못함'을 계속 보인다).
  // 처음 실행에서 실패한 저장소는 기억하지 않는다. 기억하면 다음 확인에서 그 저장소의 하루치를
  // '처음 실행이 아닌' 새 항목으로 읽어, 설치하자마자 오래된 알림이 한꺼번에 왔다.
  const isFirstRun = state.lastChecked == null;
  state.retrySince = isFirstRun ? {} : Object.fromEntries(retryable.map((repo) => [repo, sinceFor(repo)]));
  const nextRead = Object.fromEntries(Object.entries(lastRead).filter(([, value]) => Date.parse(now) - Date.parse(value) < config.activeWindow));
  for (const repo of selected) if (!failed.includes(repo)) nextRead[repo] = now;
  state.lastRead = nextRead;
  const newEvents = WatchState.apply(state, events, { now, includeOwn, config });
  if (notifications) WatchState.rememberThreads(state, notifications);

  // push의 커밋 제목은 기록에 새로 들어온 push에만 한 번 읽어 API 호출을 줄인다.
  // 몇 개씩 동시에 읽고, 한도에 걸리면 남은 것은 다음 확인으로 미룬다(더 보내도 실패하고 2차 한도 위험만 커진다).
  // API 한도가 넉넉하지 않으면 커밋 제목은 다음으로 미룬다(목록에는 제목 없이 먼저 보인다).
  const pending = budgetLow() ? [] : state.history.filter((e) => isPush(e.kind) && !e.detailResolved);
  const details = await inChunks(pending, config.maxConcurrentRepos, (event) => resolvePushDetail(api, event),
    (detail) => detail.hitRateLimit);
  for (const { event: resolved } of details) {
    WatchState.update(state, resolved);
    const index = newEvents.findIndex((e) => e.id === resolved.id);
    if (index >= 0) newEvents[index] = resolved;
  }
  return { state, newEvents, failedRepos: failed, notificationsUnavailable: notifications == null };
}

/**
 * 저장소들을 읽는다. sinceFor(repo): 저장소마다 읽기 시작할 시각(지난번에 실패한 저장소는 더 앞부터 읽는다).
 * 문자열 하나를 주면 모든 저장소에 같은 시각을 쓴다.
 */
async function collect(api, repos, sinceFor, config) {
  const sinceOf = typeof sinceFor === 'function' ? sinceFor : () => sinceFor;
  const events = [];
  const failed = [];
  /** 실패한 저장소 중 잠시 뒤 다시 읽을 만한 것(네트워크·서버 오류). */
  const retryable = [];
  let rateLimit = null;
  // 한꺼번에 너무 많이 보내지 않도록 maxConcurrentRepos개씩 나눠 읽고, 한도에 걸리면 남은 저장소는 읽지 않는다.
  const results = await inChunks(repos, config.maxConcurrentRepos, async (repo) => {
    const since = sinceOf(repo);
    try {
      return { repo, built: EventBuilder.build(await snapshot(api, repo, since, config), repo, since) };
    } catch (error) {
      return { repo, built: null, error };
    }
  }, (result) => result.error && result.error.kind === 'rateLimited');
  for (const { repo, built, error } of results) {
    if (built) events.push(...built);
    else failed.push(repo);
    if (error && error.kind === 'rateLimited') rateLimit = error;
    else if (isTemporary(error)) retryable.push(repo);
  }
  events.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  return { events, failed: failed.sort(), retryable: retryable.sort(), rateLimit };
}

async function snapshot(api, repo, since, config = WatchState.DEFAULT_CONFIG) {
  const [pulls, reviewComments, issueComments, activity] = await Promise.all([
    api.get(`repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=30`),
    api.get(`repos/${repo}/pulls/comments?since=${since}&sort=created&direction=desc&per_page=100`),
    api.get(`repos/${repo}/issues/comments?since=${since}&sort=created&direction=desc&per_page=100`),
    api.get(`repos/${repo}/activity?per_page=50`),
  ]);
  const updated = pulls.filter((pull) => pull.updated_at && Date.parse(pull.updated_at) >= Date.parse(since));
  const reviewsByPR = await reviewsFor(api, repo, updated.map((pull) => pull.number), config);
  return { pulls, reviewsByPR, reviewComments, issueComments, activity };
}

/**
 * 바뀐 PR들의 리뷰. GraphQL 질의 한 번으로 모두 읽고(PR마다 REST 한 번씩 부르지 않아 REST 한도를 아낀다),
 * GraphQL을 쓸 수 없거나 실패하면 예전처럼 PR마다 REST로 몇 개씩 동시에 읽는다.
 * 토큰이 틀린 것(401)은 REST로 다시 해도 같으므로 그대로 올린다.
 */
async function reviewsFor(api, repo, numbers, config) {
  if (numbers.length === 0) return {};
  if (typeof api.graphql === 'function') {
    try {
      return await reviewsByGraphQL(api, repo, numbers);
    } catch (error) {
      if (error && error.kind === 'unauthorized') throw error;
    }
  }
  const reviews = await inChunks(numbers, config.maxConcurrentRepos,
    async (number) => [number, await api.get(`repos/${repo}/pulls/${number}/reviews?per_page=100`)]);
  return Object.fromEntries(reviews);
}

const REVIEW_FIELDS = 'databaseId state body submittedAt url author { __typename login avatarUrl }';

async function reviewsByGraphQL(api, repo, numbers) {
  const [owner, name] = repo.split('/');
  const fields = numbers.map((number) => `p${Number(number)}: pullRequest(number: ${Number(number)}) { reviews(last: 100) { nodes { ${REVIEW_FIELDS} } } }`);
  const data = await api.graphql(`query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields.join(' ')} } }`,
    { owner, name });
  const repository = (data && data.repository) || {};
  const result = {};
  for (const number of numbers) {
    const pull = repository[`p${Number(number)}`];
    result[number] = pull && pull.reviews ? pull.reviews.nodes.filter(Boolean).map(restReview) : [];
  }
  return result;
}

/** GraphQL 리뷰를 REST 리뷰 모양으로 바꾼다. GraphQL은 봇 로그인에 '[bot]'을 붙이지 않아 REST처럼 붙인다. */
function restReview(node) {
  const author = node.author;
  const login = author ? (author.__typename === 'Bot' ? `${author.login}[bot]` : author.login) : null;
  return {
    id: node.databaseId,
    state: node.state,
    body: node.body || '',
    submitted_at: node.submittedAt,
    html_url: node.url,
    user: login ? { login, avatar_url: author.avatarUrl || null } : null,
  };
}

/** push에 커밋 수와 마지막 커밋 제목을 채운다. 실패해도 항목은 그대로 보인다. */
async function resolvePush(api, event) {
  return (await resolvePushDetail(api, event)).event;
}

/** resolvePush와 같고, 한도에 걸렸는지(hitRateLimit)도 알려 준다. 걸렸으면 남은 push는 이번에 읽지 않는다. */
async function resolvePushDetail(api, event) {
  const resolved = { ...event, detailResolved: true };
  if (!event.after) return { event: resolved, hitRateLimit: false };
  // 한도·네트워크처럼 잠시 뒤 될 수 있는 실패는 '다 읽음'으로 두지 않아 다음 확인 때 다시 읽는다.
  // 몇 번 미뤄도 안 되면 그만 읽는다(제목 없이 보인다). 한도 초과는 횟수에 세지 않는다(풀리면 다시 읽는다).
  const postponed = (error) => {
    const isRateLimit = error.kind === 'rateLimited';
    const attempts = (event.detailAttempts || 0) + (isRateLimit ? 0 : 1);
    return { event: { ...resolved, detailAttempts: attempts, detailResolved: attempts >= MAX_DETAIL_ATTEMPTS }, hitRateLimit: isRateLimit };
  };
  if (event.before && event.before !== EventBuilder.ZERO_SHA) {
    try {
      const compare = await api.get(`repos/${event.repo}/compare/${event.before}...${event.after}`);
      const last = compare.commits[compare.commits.length - 1];
      if (last) {
        resolved.commitCount = compare.total_commits != null ? compare.total_commits : compare.commits.length;
        resolved.title = firstLine(last.commit.message);
        return { event: resolved, hitRateLimit: false };
      }
    } catch (error) {
      // 잠시 뒤 될 실패면 마지막 커밋도 지금은 읽지 않는다(같은 이유로 실패하고 한도만 쓴다).
      if (isTemporary(error)) return postponed(error);
      // 강제 push 뒤에는 before 커밋이 사라져 compare가 실패할 수 있다. 아래에서 마지막 커밋만 읽는다.
    }
  }
  try {
    const commit = await api.get(`repos/${event.repo}/commits/${event.after}`);
    resolved.title = firstLine(commit.commit.message);
  } catch (error) {
    if (isTemporary(error)) return postponed(error);
    // 커밋이 사라진 경우(404 등)는 다시 읽어도 안 되므로 그대로 둔다.
  }
  return { event: resolved, hitRateLimit: false };
}

/** push 커밋 제목을 잠시 뒤 될 실패로 미루는 최대 횟수. */
const MAX_DETAIL_ATTEMPTS = 3;

/** 잠시 뒤 다시 하면 될 수 있는 실패인지(한도·네트워크·서버 오류). */
function isTemporary(error) {
  if (!error) return false;
  if (error.kind === 'rateLimited' || error.kind === 'network') return true;
  return error.kind === 'http' && error.status >= 500;
}

module.exports = { refresh, collect, snapshot, reviewsFor, restReview, resolvePush, resolvePushDetail, isTemporary, iso, sinceTime };
