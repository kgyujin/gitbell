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
 * @param {{token: string, baseURL?: string, fetch?: typeof fetch, timeoutMs?: number}} options
 * @returns {{get: (path: string) => Promise<any>}}
 */
function createGitHubAPI({ token, baseURL = 'https://api.github.com/', fetch: fetchImpl = fetch, timeoutMs = 20000 }) {
  const base = baseURL.endsWith('/') ? baseURL : `${baseURL}/`;
  return {
    async get(path) {
      const url = new URL(path, base);
      let response;
      try {
        response = await fetchImpl(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'GitBell',
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new GitHubError('network', error && error.message ? error.message : String(error));
      }
      if (response.status === 401) throw new GitHubError('unauthorized', '', 401);
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
      return JSON.parse(text);
    },
  };
}

module.exports = { GitHubError, createGitHubAPI, detectRateLimit };
