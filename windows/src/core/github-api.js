// GitHub REST API를 읽는 얇은 클라이언트(GitHubAPI.swift와 같은 동작).
// 토큰은 메모리에만 두고 로그나 오류 문구에 넣지 않는다.
'use strict';

class GitHubError extends Error {
  /** @param {'unauthorized'|'http'|'network'|'rateLimited'} kind */
  constructor(kind, message = '', status = 0, resetAt = null) {
    super(message);
    this.name = 'GitHubError';
    this.kind = kind;
    this.status = status;
    /** rateLimited일 때 다시 쓸 수 있는 시각(ISO). 모르면 null. */
    this.resetAt = resetAt;
  }
}

/**
 * GitHub API 한도 초과인지 가린다(GitHubAPI.swift의 RateLimit.detect와 같은 규칙).
 * 1차 한도(403/429 + 남은 횟수 0)와 2차 한도(문구에 'rate limit')를 모두 본다.
 * @returns {{resetAt: string|null}|null} 한도 초과면 다시 쓸 수 있는 시각, 아니면 null
 */
function detectRateLimit({ status, remaining, reset, retryAfter, message = '', now = Date.now() }) {
  if (status !== 403 && status !== 429) return null;
  const limited = status === 429 || remaining === '0' || /rate limit/i.test(message);
  if (!limited) return null;
  if (retryAfter != null && Number.isFinite(Number(retryAfter))) return { resetAt: new Date(now + Number(retryAfter) * 1000).toISOString() };
  if (reset != null && Number.isFinite(Number(reset))) return { resetAt: new Date(Number(reset) * 1000).toISOString() };
  return { resetAt: null };
}

/**
 * 조건부 요청(ETag)에 쓰는 응답 보관소(GitHubAPI.swift의 ResponseCache와 같은 규칙). 메모리에만 둔다.
 *
 * GitBell은 몇 분마다 같은 주소(저장소 목록, PR 목록, 활동, 10분 단위로 맞춘 since 주소)를 다시 읽는다.
 * 바뀐 것이 없으면 GitHub이 본문 없이 304를 돌려주고, 이 응답은 API 한도에 세지 않는다.
 * 계정(토큰)이 바뀌면 다른 사람의 응답을 쓰지 않도록 모두 비우고, 예전 토큰으로 받은 응답은 넣지 않는다.
 * limit: 저장소마다 PR 목록·활동·댓글과 바뀐 PR의 리뷰 몇 개를 보관한다. 수십 개 저장소를 보는 경우에도 들어가는 수다.
 * byteLimit: 본문 크기 합의 상한. PR 목록은 한 번에 100KB를 넘기도 해서, 개수만으로는 메모리를 묶지 못한다.
 */
function createResponseCache({ limit = 200, byteLimit = 8 * 1024 * 1024 } = {}) {
  /** 주소 → {etag, text}. Map은 넣은 순서를 지켜, 맨 앞이 가장 오래 안 쓴 것이다. */
  const entries = new Map();
  let currentToken = null;
  let totalBytes = 0;
  /** 마지막 응답이 알려 준 남은 API 한도(x-ratelimit-remaining). 304도 알려 준다. */
  let remaining = null;
  const forget = (key) => {
    const old = entries.get(key);
    if (old) totalBytes -= old.text.length;
    entries.delete(key);
  };
  return {
    use(token) {
      if (token === currentToken) return;
      currentToken = token;
      entries.clear();
      totalBytes = 0;
    },
    get(key, token = currentToken) {
      const entry = token === currentToken ? entries.get(key) : null;
      if (!entry) return null;
      entries.delete(key);
      entries.set(key, entry);
      return entry;
    },
    /** 지금 토큰과 다른 토큰으로 받은 응답(토큰이 바뀌기 전에 시작한 확인)은 넣지 않는다. */
    set(key, entry, token = currentToken) {
      if (token !== currentToken) return;
      forget(key);
      entries.set(key, entry);
      totalBytes += entry.text.length;
      while (entries.size > limit || (totalBytes > byteLimit && entries.size > 1)) forget(entries.keys().next().value);
    },
    get size() { return entries.size; },
    noteRemaining(value) { if (Number.isFinite(value)) remaining = value; },
    get remaining() { return remaining; },
  };
}

/** 커밋 비교(compare)와 커밋 한 개(commits/…)는 push마다 한 번만 읽고 본문(변경 내용 포함)이 커서 보관하지 않는다. */
function isReusable(path) {
  return !path.includes('/compare/') && !path.includes('/commits/');
}

/**
 * @param {{token: string, baseURL?: string, fetch?: typeof fetch, timeoutMs?: number,
 *          cache?: ReturnType<typeof createResponseCache>}} options
 *   cache: 확인 사이에 이어 쓰는 응답 보관소. 주면 조건부 요청(If-None-Match)을 보낸다.
 * @returns {{get: (path: string) => Promise<any>}}
 */
function createGitHubAPI({ token, baseURL = 'https://api.github.com/', fetch: fetchImpl = fetch, timeoutMs = 20000, cache = null }) {
  const base = baseURL.endsWith('/') ? baseURL : `${baseURL}/`;
  return {
    /** 마지막 응답이 알려 준 남은 API 한도. 모르면 null. */
    remaining() { return cache ? cache.remaining : null; },
    async get(path) {
      // 토큰이 바뀌었으면 보관소를 비운다(만드는 쪽이 따로 챙기지 않아도 다른 계정의 응답을 쓰지 않는다).
      if (cache) cache.use(token);
      const url = new URL(path, base);
      const key = url.href;
      const cached = cache && isReusable(path) ? cache.get(key, token) : null;
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'GitBell',
      };
      if (cached) headers['If-None-Match'] = cached.etag;
      let response;
      try {
        response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        throw new GitHubError('network', error && error.message ? error.message : String(error));
      }
      const headerValue = (name) => (response.headers && typeof response.headers.get === 'function' ? response.headers.get(name) : null);
      if (cache && headerValue('x-ratelimit-remaining') != null) cache.noteRemaining(Number(headerValue('x-ratelimit-remaining')));
      if (response.status === 401) throw new GitHubError('unauthorized', '', 401);
      // 바뀐 것이 없다: 보관한 본문을 그대로 쓴다(이 응답은 API 한도에 세지 않는다).
      if (response.status === 304 && cached) {
        // 본문이 없어도 끝까지 읽어야 연결을 다음 요청에 다시 쓴다(undici fetch).
        await response.text().catch(() => '');
        return JSON.parse(cached.text);
      }
      const text = await response.text();
      if (response.status < 200 || response.status >= 300) {
        let message = '';
        try {
          const body = JSON.parse(text);
          if (body && typeof body.message === 'string') message = body.message;
        } catch {
          // 본문이 JSON이 아니면 상태 코드만 알린다.
        }
        // 헤더가 없는 응답(테스트용 가짜 fetch 등)에서도 멈추지 않게 한다.
        const header = (name) => (response.headers && typeof response.headers.get === 'function' ? response.headers.get(name) : null);
        const limit = detectRateLimit({
          status: response.status,
          remaining: header('x-ratelimit-remaining'),
          reset: header('x-ratelimit-reset'),
          retryAfter: header('retry-after'),
          message,
        });
        if (limit) throw new GitHubError('rateLimited', message, response.status, limit.resetAt);
        throw new GitHubError('http', message, response.status);
      }
      const body = JSON.parse(text);
      // 테스트용 가짜 응답에는 headers가 없을 수 있어 막아 둔다.
      const etag = response.headers && typeof response.headers.get === 'function' ? response.headers.get('etag') : null;
      if (cache && etag && isReusable(path)) cache.set(key, { etag, text }, token);
      return body;
    },
  };
}

module.exports = { GitHubError, createGitHubAPI, createResponseCache, detectRateLimit };
