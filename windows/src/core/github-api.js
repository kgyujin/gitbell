// GitHub REST API를 읽는 얇은 클라이언트(GitHubAPI.swift와 같은 동작).
// 토큰은 메모리에만 두고 로그나 오류 문구에 넣지 않는다.
'use strict';

class GitHubError extends Error {
  /** @param {'unauthorized'|'http'|'network'} kind */
  constructor(kind, message = '', status = 0) {
    super(message);
    this.name = 'GitHubError';
    this.kind = kind;
    this.status = status;
  }
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
        throw new GitHubError('http', message, response.status);
      }
      return JSON.parse(text);
    },
  };
}

module.exports = { GitHubError, createGitHubAPI };
