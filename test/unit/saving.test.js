// API 한도 절약: 바뀐 PR의 리뷰를 GraphQL 한 번으로 읽고, 안 되면 REST로 읽는다.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Poller = require('../../src/core/poller');
const { GitHubError, createGitHubAPI } = require('../../src/core/github-api');
const { DEFAULT_CONFIG } = require('../../src/core/watch-state');

const node = (id, state, login, typename = 'User') => ({
  databaseId: id, state, body: '', submittedAt: '2026-11-09T05:50:00Z', url: `https://github.com/o/r/pull/1#pullrequestreview-${id}`,
  author: { __typename: typename, login, avatarUrl: `https://avatars/${login}` },
});

test('리뷰: 바뀐 PR 여러 개를 GraphQL 한 번으로 읽고 REST 모양으로 바꾼다', async () => {
  const queries = [];
  const api = {
    get: async (path) => { throw new Error(`REST를 부르면 안 된다: ${path}`); },
    graphql: async (query, variables) => {
      queries.push({ query, variables });
      return { repository: { p1: { reviews: { nodes: [node(11, 'APPROVED', 'amy'), node(12, 'COMMENTED', 'helper', 'Bot')] } }, p2: null } };
    },
  };
  const reviews = await Poller.reviewsFor(api, 'o/r', [1, 2], DEFAULT_CONFIG);
  assert.equal(queries.length, 1, 'PR이 여러 개여도 한 번만 묻는다');
  assert.deepEqual(queries[0].variables, { owner: 'o', name: 'r' });
  assert.match(queries[0].query, /p1: pullRequest\(number: 1\)/);
  assert.match(queries[0].query, /p2: pullRequest\(number: 2\)/);
  assert.deepEqual(reviews[1][0], {
    id: 11, state: 'APPROVED', body: '', submitted_at: '2026-11-09T05:50:00Z',
    html_url: 'https://github.com/o/r/pull/1#pullrequestreview-11', user: { login: 'amy', avatar_url: 'https://avatars/amy' },
  });
  assert.equal(reviews[1][1].user.login, 'helper[bot]', 'GraphQL의 봇 로그인에 REST처럼 [bot]을 붙인다');
  assert.deepEqual(reviews[2], [], '읽지 못한 PR은 리뷰 없음');
  assert.deepEqual(await Poller.reviewsFor(api, 'o/r', [], DEFAULT_CONFIG), {}, '바뀐 PR이 없으면 묻지 않는다');
});

test('리뷰: GraphQL이 실패하면 PR마다 REST로 읽고, 토큰 오류(401)는 그대로 올린다', async () => {
  const rest = [];
  const api = {
    get: async (path) => { rest.push(path); return [{ id: 1 }]; },
    graphql: async () => { throw new GitHubError('rateLimited', '', 200); },
  };
  const reviews = await Poller.reviewsFor(api, 'o/r', [3, 4], DEFAULT_CONFIG);
  assert.deepEqual(rest.sort(), ['repos/o/r/pulls/3/reviews?per_page=100', 'repos/o/r/pulls/4/reviews?per_page=100']);
  assert.deepEqual(reviews, { 3: [{ id: 1 }], 4: [{ id: 1 }] });

  const expired = { get: api.get, graphql: async () => { throw new GitHubError('unauthorized', '', 401); } };
  await assert.rejects(Poller.reviewsFor(expired, 'o/r', [3], DEFAULT_CONFIG), { kind: 'unauthorized' });
});

test('GraphQL 클라이언트: POST로 보내고, 한도 초과·오류·일부 오류를 가린다', async () => {
  const sent = [];
  const reply = (status, body) => async (url, options) => {
    sent.push({ url: String(url), options });
    return { status, headers: new Map(), text: async () => JSON.stringify(body) };
  };
  const ok = createGitHubAPI({ token: 'tok', fetch: reply(200, { data: { viewer: { login: 'me' } } }) });
  assert.deepEqual(await ok.graphql('query { viewer { login } }'), { viewer: { login: 'me' } });
  assert.equal(sent[0].url, 'https://api.github.com/graphql');
  assert.equal(sent[0].options.method, 'POST');
  assert.equal(sent[0].options.headers.Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(sent[0].options.body), { query: 'query { viewer { login } }', variables: {} });

  const partial = createGitHubAPI({ token: 't', fetch: reply(200, { data: { repository: { p1: null } }, errors: [{ type: 'NOT_FOUND', message: 'x' }] }) });
  assert.deepEqual(await partial.graphql('q'), { repository: { p1: null } }, '일부만 못 읽었으면 읽은 것을 쓴다');
  await assert.rejects(createGitHubAPI({ token: 't', fetch: reply(200, { errors: [{ type: 'RATE_LIMITED', message: 'limit' }] }) }).graphql('q'),
    { kind: 'rateLimited' });
  await assert.rejects(createGitHubAPI({ token: 't', fetch: reply(200, { errors: [{ message: 'bad query' }] }) }).graphql('q'),
    { kind: 'http', message: 'bad query' });
  await assert.rejects(createGitHubAPI({ token: 't', fetch: reply(401, {}) }).graphql('q'), { kind: 'unauthorized' });
});
