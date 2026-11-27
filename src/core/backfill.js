// 활동 차트의 지난 날짜를 GitHub에서 한 번 불러와 채운다.
//
// 날짜별 합계(daily)는 0.6.2부터 쌓기 시작해서, 그 전 날짜는 비어 있다. 처음 한 번 내 저장소들의
// PR(열림·머지·닫힘)·리뷰·댓글·기본 브랜치 커밋을 GraphQL로 읽어 날짜별로 센다(REST 한도를 쓰지 않는다).
// 평소 세는 규칙과 맞춘다: 내 활동은 includeOwn이 아니면 빼고, 봇은 따로 센다(봇 커밋은 세지 않는다).
// 다만 평소의 커밋은 push 단위인데 여기서는 기본 브랜치 커밋 단위로 센다(지난 push 기록은 읽을 수 없다).
'use strict';

const { addToDaily, localDate } = require('./activity-stats');

/** 불러올 저장소 수와 저장소마다 읽을 쪽 수의 상한(한도를 지키고 몇 분 안에 끝나게). */
const LIMITS = Object.freeze({ repos: 40, pullPages: 10, issuePages: 5, commitPages: 10 });

const PULLS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 30, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        updatedAt createdAt mergedAt closedAt merged
        author { __typename login }
        mergedBy { __typename login }
        reviews(first: 50) { nodes { submittedAt state body author { __typename login } } }
        comments(first: 50) { nodes { createdAt author { __typename login } } }
      }
    }
  }
}`;

const ISSUES_QUERY = `query($owner: String!, $name: String!, $after: String, $since: DateTime!) {
  repository(owner: $owner, name: $name) {
    issues(first: 30, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}, filterBy: {since: $since}) {
      pageInfo { hasNextPage endCursor }
      nodes { comments(first: 50) { nodes { createdAt author { __typename login } } } }
    }
  }
}`;

const COMMITS_QUERY = `query($owner: String!, $name: String!, $after: String, $since: GitTimestamp!, $until: GitTimestamp!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { target { ... on Commit {
      history(first: 100, after: $after, since: $since, until: $until) {
        pageInfo { hasNextPage endCursor }
        nodes { committedDate author { name user { login } } }
      }
    } } }
  }
}`;

/** GraphQL 작성자를 REST 로그인 꼴로(봇은 '[bot]'을 붙인다). 모르면 ''. */
function login(author) {
  if (!author || !author.login) return '';
  return author.__typename === 'Bot' ? `${author.login}[bot]` : author.login;
}

/**
 * 지난 날짜의 활동을 GitHub에서 읽어 날짜별 합계로 돌려준다. [start, cutoff) 안의 활동만 센다.
 * @param {{get(path: string): Promise<any>, graphql(query: string, variables?: object): Promise<any>}} api
 * @param {{me: string, start: string, cutoff: string, includeOwn?: boolean, limits?: object}} options  start·cutoff는 ISO 시각
 * @returns {Promise<{daily: object, repos: string[], failedRepos: string[]}>}
 */
async function backfillDaily(api, { me, start, cutoff, includeOwn = false, limits = LIMITS }) {
  const from = Date.parse(start);
  const until = Date.parse(cutoff);
  const daily = {};
  const inRange = (iso) => {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) && ms >= from && ms < until;
  };
  const count = (repo, kind, time, actor) => {
    if (!time || !inRange(time)) return;
    if (!includeOwn && me && actor === me) return;
    addToDaily(daily, { repo, kind, time, actor });
  };

  const repos = (await api.get('user/repos?sort=pushed&direction=desc&per_page=100&affiliation=owner,collaborator,organization_member'))
    .filter((repo) => repo.archived !== true && repo.pushed_at && Date.parse(repo.pushed_at) >= from)
    .slice(0, limits.repos)
    .map((repo) => repo.full_name);

  const failedRepos = [];
  for (const repo of repos) {
    const [owner, name] = repo.split('/');
    try {
      await eachPage(limits.pullPages, (after) => api.graphql(PULLS_QUERY, { owner, name, after }), (data) => {
        const connection = data && data.repository && data.repository.pullRequests;
        if (!connection) return null;
        for (const pull of connection.nodes.filter(Boolean)) {
          const author = login(pull.author);
          count(repo, 'prOpened', pull.createdAt, author);
          if (pull.merged && pull.mergedAt) count(repo, 'prMerged', pull.mergedAt, login(pull.mergedBy));
          // 닫힘은 닫은 사람을 알 수 없어, 평소처럼 내 PR이 닫힌 것은 내 활동으로 본다.
          else if (pull.closedAt) count(repo, 'prClosed', pull.closedAt, author);
          for (const review of (pull.reviews && pull.reviews.nodes) || []) {
            if (!review) continue;
            const kind = { APPROVED: 'reviewApproved', CHANGES_REQUESTED: 'reviewChangesRequested' }[review.state]
              || (review.state === 'COMMENTED' && (review.body || '').trim() ? 'reviewCommented' : null);
            if (kind) count(repo, kind, review.submittedAt, login(review.author));
          }
          for (const comment of (pull.comments && pull.comments.nodes) || []) {
            if (comment) count(repo, 'comment', comment.createdAt, login(comment.author));
          }
        }
        // 최근에 바뀐 PR부터 읽으므로, 기간보다 오래전에 바뀐 PR이 나오면 그만 읽는다.
        const last = connection.nodes.filter(Boolean).at(-1);
        return last && Date.parse(last.updatedAt) < from ? null : connection.pageInfo;
      });
      await eachPage(limits.issuePages, (after) => api.graphql(ISSUES_QUERY, { owner, name, after, since: start }), (data) => {
        const connection = data && data.repository && data.repository.issues;
        if (!connection) return null;
        for (const issue of connection.nodes.filter(Boolean)) {
          for (const comment of (issue.comments && issue.comments.nodes) || []) {
            if (comment) count(repo, 'comment', comment.createdAt, login(comment.author));
          }
        }
        return connection.pageInfo;
      });
      await eachPage(limits.commitPages, (after) => api.graphql(COMMITS_QUERY, { owner, name, after, since: start, until: cutoff }), (data) => {
        const target = data && data.repository && data.repository.defaultBranchRef && data.repository.defaultBranchRef.target;
        const connection = target && target.history;
        if (!connection) return null;
        for (const commit of connection.nodes.filter(Boolean)) {
          const author = commit.author || {};
          const name = (author.user && author.user.login) || '';
          // 평소처럼 봇의 push(배포 등)는 세지 않는다.
          if (name.endsWith('[bot]') || (author.name || '').endsWith('[bot]')) continue;
          count(repo, 'push', commit.committedDate, name);
        }
        return connection.pageInfo;
      });
    } catch (error) {
      // 한도에 걸렸거나 토큰이 틀렸으면 나머지도 실패한다. 멈추고 다음에 다시 한다.
      if (error && (error.kind === 'rateLimited' || error.kind === 'unauthorized')) throw error;
      failedRepos.push(repo);
    }
  }
  return { daily, repos, failedRepos };
}

/** 다음 쪽이 있는 동안 최대 pages쪽을 읽는다. read가 null을 돌려주면 멈춘다. */
async function eachPage(pages, fetchPage, read) {
  let after = null;
  for (let page = 0; page < pages; page += 1) {
    const info = read(await fetchPage(after));
    if (!info || !info.hasNextPage || !info.endCursor) return;
    after = info.endCursor;
  }
}

/**
 * 불러온 합계를 상태에 넣는다. GitBell이 직접 세기 시작한 날(cutoff의 날짜)보다 앞 날짜만 바꾸고,
 * 그날부터는 평소에 센 것을 그대로 둔다(같은 활동을 두 번 세지 않게).
 */
function mergeBackfill(state, { daily, start, cutoff }, now) {
  const first = localDate(Date.parse(start));
  const last = localDate(Date.parse(cutoff));
  const target = state.daily || (state.daily = {});
  for (const date of Object.keys(target)) {
    if (date >= first && date < last) delete target[date];
  }
  for (const [date, repos] of Object.entries(daily)) {
    if (date >= first && date < last) target[date] = repos;
  }
  state.backfill = { doneAt: now };
}

module.exports = { backfillDaily, mergeBackfill, LIMITS, PULLS_QUERY, ISSUES_QUERY, COMMITS_QUERY };
