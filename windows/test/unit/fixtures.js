// Swift 테스트(Tests/GitBellCoreTests)와 같은 모양의 GitHub 응답 자료.
'use strict';

const { ZERO_SHA } = require('../../src/core/event-builder');

const repo = 'org/repo';
const now = '2026-11-09T06:00:00Z';
const since = '2026-11-09T05:00:00Z';
const recent = '2026-11-09T05:30:00Z';
const old = '2026-11-09T03:00:00Z';

const user = (login) => ({ login, avatar_url: `https://a/${login}` });

function sampleSnapshot() {
  return {
    pulls: [
      { number: 33, title: '새 PR', html_url: 'https://github.com/org/repo/pull/33', user: user('amy'),
        created_at: recent, updated_at: recent, merged_at: null, closed_at: null, merge_commit_sha: null },
      { number: 32, title: '머지된 PR', html_url: 'https://github.com/org/repo/pull/32', user: user('bob'),
        created_at: old, updated_at: recent, merged_at: recent, closed_at: recent, merge_commit_sha: 'm32' },
      { number: 31, title: '닫힌 PR', html_url: 'https://github.com/org/repo/pull/31', user: user('bob'),
        created_at: old, updated_at: recent, merged_at: null, closed_at: recent, merge_commit_sha: 'x' },
    ],
    reviewsByPR: {
      33: [
        { id: 1, state: 'APPROVED', body: '', user: user('bob'), submitted_at: recent, html_url: 'https://r/1' },
        { id: 2, state: 'COMMENTED', body: '', user: user('amy'), submitted_at: recent, html_url: 'https://r/2' },
        { id: 3, state: 'COMMENTED', body: '전체 의견', user: user('cat'), submitted_at: recent, html_url: 'https://r/3' },
        { id: 4, state: 'CHANGES_REQUESTED', body: 'x', user: user('cat'), submitted_at: old, html_url: 'https://r/4' },
      ],
    },
    reviewComments: [
      { id: 10, pull_request_review_id: 3, pull_request_url: 'https://api/pulls/33', user: user('cat'),
        body: '인라인', created_at: recent, html_url: 'https://c/10' },
      { id: 11, pull_request_review_id: 2, pull_request_url: 'https://api/pulls/33', user: user('amy'),
        body: '답글\n둘째 줄', created_at: recent, html_url: 'https://c/11' },
    ],
    issueComments: [
      { id: 20, issue_url: 'https://api/issues/33', html_url: 'https://github.com/org/repo/pull/33#c',
        user: user('dan'), body: 'PR 댓글', created_at: recent },
      { id: 21, issue_url: 'https://api/issues/7', html_url: 'https://github.com/org/repo/issues/7#c',
        user: user('dan'), body: '이슈 댓글', created_at: recent },
    ],
    activity: [
      { id: 100, activity_type: 'push', ref: 'refs/heads/feat/a', before: 'b1', after: 'a1', actor: user('amy'), timestamp: recent },
      { id: 101, activity_type: 'force_push', ref: 'refs/heads/feat/b', before: 'b2', after: 'a2', actor: user('eve'), timestamp: recent },
      { id: 102, activity_type: 'branch_creation', ref: 'refs/heads/feat/c', before: ZERO_SHA, after: 'a3', actor: user('eve'), timestamp: recent },
      { id: 103, activity_type: 'pr_merge', ref: 'refs/heads/main', before: 'p', after: 'm32', actor: user('me'), timestamp: recent },
      { id: 104, activity_type: 'branch_deletion', ref: 'refs/heads/feat/d', before: 'd', after: ZERO_SHA, actor: user('me'), timestamp: recent },
      { id: 105, activity_type: 'push', ref: 'refs/heads/feat/old', before: 'o', after: 'o2', actor: user('amy'), timestamp: old },
      { id: 106, activity_type: 'force_push', ref: 'refs/heads/gh-pages', before: 'g', after: 'g2', actor: user('github-actions[bot]'), timestamp: recent },
    ],
  };
}

/** 경로 앞부분으로 미리 정한 응답을 돌려주는 가짜 GitHub. 모르는 경로는 404로 실패한다. */
function fakeGitHub(routes) {
  const { GitHubError } = require('../../src/core/github-api');
  const calls = [];
  return {
    calls,
    async get(path) {
      calls.push(path);
      const route = routes.find(([prefix]) => path.startsWith(prefix));
      if (!route) throw new GitHubError('http', path, 404);
      return JSON.parse(JSON.stringify(route[1]));
    },
  };
}

module.exports = { repo, now, since, recent, old, user, sampleSnapshot, fakeGitHub };
