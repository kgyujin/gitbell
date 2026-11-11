// GitHub REST API를 읽는 얇은 클라이언트. 토큰은 메모리에만 두고 로그나 오류 문구에 넣지 않는다.

import Foundation

public enum GitHubError: Error, Equatable, Sendable {
    case unauthorized
    case http(status: Int, message: String)
    case network(String)
    /// API 한도에 걸렸다. resetAt은 다시 쓸 수 있는 시각(알 수 있을 때).
    case rateLimited(resetAt: Date?)
}

/// GitHub API 한도 초과인지 가린다. 1차 한도(403/429 + 남은 횟수 0)와 2차 한도(문구에 'rate limit')를 모두 본다.
public enum RateLimit {
    /// 한도 초과면 다시 쓸 수 있는 시각(모르면 nil)을 담은 값을, 아니면 nil을 돌려준다.
    public static func detect(status: Int, remaining: String?, reset: String?, retryAfter: String?, message: String,
                              now: Date = Date()) -> Date?? {
        guard status == 403 || status == 429 else { return nil }
        let limited = status == 429 || remaining == "0" || message.lowercased().contains("rate limit")
        guard limited else { return nil }
        if let seconds = retryAfter.flatMap(Double.init) { return .some(now.addingTimeInterval(seconds)) }
        if let epoch = reset.flatMap(Double.init) { return .some(Date(timeIntervalSince1970: epoch)) }
        return .some(nil)
    }
}

/// 조건부 요청(ETag)에 쓰는 응답 보관소. 메모리에만 둔다.
///
/// GitBell은 몇 분마다 같은 주소(저장소 목록, PR 목록, 활동, 10분 단위로 맞춘 since 주소)를 다시 읽는다.
/// 바뀐 것이 없으면 GitHub이 본문 없이 304를 돌려주고, 이 응답은 API 한도에 세지 않는다.
/// 그래서 확인이 빨라지고 한도에 덜 걸린다.
/// 계정(토큰)이 바뀌면 다른 사람의 응답을 쓰지 않도록 모두 비우고, 예전 토큰으로 받은 응답은 넣지 않는다.
public actor ResponseCache {
    public struct Entry: Sendable, Equatable {
        public let etag: String
        public let data: Data
    }

    private var entries: [String: Entry] = [:]
    /// 오래 안 쓴 것부터. 가득 차면 맨 앞부터 버린다.
    private var order: [String] = []
    private var totalBytes = 0
    private var token: String?
    /// 저장소마다 PR 목록·활동·댓글과 바뀐 PR의 리뷰 몇 개를 보관한다. 수십 개 저장소를 보는 경우에도 들어가는 수다.
    private let limit: Int
    /// 본문 크기 합의 상한. PR 목록은 한 번에 100KB를 넘기도 해서, 개수만으로는 메모리를 묶지 못한다.
    private let byteLimit: Int

    public init(limit: Int = 200, byteLimit: Int = 8 * 1024 * 1024) {
        self.limit = limit
        self.byteLimit = byteLimit
    }

    /// 이 토큰으로 쓸 준비를 한다. 앞서 쓴 토큰과 다르면 보관한 응답을 모두 버린다.
    public func use(token: String) {
        guard token != self.token else { return }
        self.token = token
        entries = [:]
        order = []
        totalBytes = 0
    }

    public func entry(for key: String, token: String) -> Entry? {
        guard token == self.token, let entry = entries[key] else { return nil }
        touch(key)
        return entry
    }

    /// 지금 토큰과 다른 토큰으로 받은 응답(토큰이 바뀌기 전에 시작한 확인)은 넣지 않는다.
    public func store(_ entry: Entry, for key: String, token: String) {
        guard token == self.token else { return }
        if let old = entries[key] { totalBytes -= old.data.count }
        entries[key] = entry
        totalBytes += entry.data.count
        touch(key)
        while order.count > limit || (totalBytes > byteLimit && order.count > 1) {
            let oldest = order.removeFirst()
            totalBytes -= entries.removeValue(forKey: oldest)?.data.count ?? 0
        }
    }

    public var count: Int { entries.count }

    private func touch(_ key: String) {
        order.removeAll { $0 == key }
        order.append(key)
    }

    /// 커밋 비교(compare)와 커밋 한 개(commits/…)는 push마다 한 번만 읽고 본문(변경 내용 포함)이 커서 보관하지 않는다.
    public static func isReusable(_ path: String) -> Bool {
        !path.contains("/compare/") && !path.contains("/commits/")
    }
}

public protocol GitHubAPI: Sendable {
    func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T
}

public struct URLSessionGitHubAPI: GitHubAPI {
    private let token: String
    private let session: URLSession
    private let cache: ResponseCache?
    private let baseURL = URL(string: "https://api.github.com/")!

    /// GitHub API용 세션. URLSession.shared는 읽기 정책과 상관없이 받은 응답을 디스크 캐시(Caches/…/Cache.db)에
    /// 남겨서, 비공개 저장소의 PR·댓글 본문이 디스크에 쌓이고 확인할 때마다 디스크에 썼다. 그래서 캐시가 없는 세션을 쓴다.
    public static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }()

    /// cache: 확인 사이에 이어 쓰는 응답 보관소. 주면 조건부 요청(If-None-Match)을 보낸다.
    /// session: 기본은 디스크 캐시가 없는 세션이다(URLSession.shared는 받은 응답을 모두 디스크에 남긴다).
    public init(token: String, session: URLSession = URLSessionGitHubAPI.session, cache: ResponseCache? = nil) {
        self.token = token
        self.session = session
        self.cache = cache
    }

    public func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
        guard let url = URL(string: path, relativeTo: baseURL) else {
            throw GitHubError.http(status: 0, message: "bad path")
        }
        var request = URLRequest(url: url, timeoutInterval: 20)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        request.setValue("GitBell", forHTTPHeaderField: "User-Agent")
        // URLSession의 자체 캐시는 쓰지 않고 ETag를 직접 다룬다. 자체 캐시는 GitHub의 max-age(60초) 동안
        // 요청 없이 예전 응답을 돌려줘, 1분 간격으로 확인할 때 새 활동이 한 번 늦게 보일 수 있다.
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let key = url.absoluteString
        let reusable = ResponseCache.isReusable(path)
        // 토큰이 바뀌었으면 보관소를 비운다. 이 API를 만드는 쪽이 따로 챙기지 않아도 다른 계정의 응답을 쓰지 않는다.
        await cache?.use(token: token)
        let cached = reusable ? await cache?.entry(for: key, token: token) : nil
        if let cached { request.setValue(cached.etag, forHTTPHeaderField: "If-None-Match") }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw GitHubError.network(error.localizedDescription)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 { throw GitHubError.unauthorized }
        // 바뀐 것이 없다: 보관한 본문을 그대로 쓴다(이 응답은 API 한도에 세지 않는다).
        if status == 304, let cached { return try GitHubJSON.decoder().decode(T.self, from: cached.data) }
        guard (200..<300).contains(status) else {
            let message = (try? JSONDecoder().decode([String: String].self, from: data))?["message"] ?? ""
            let http = response as? HTTPURLResponse
            if let resetAt = RateLimit.detect(status: status,
                                              remaining: http?.value(forHTTPHeaderField: "x-ratelimit-remaining"),
                                              reset: http?.value(forHTTPHeaderField: "x-ratelimit-reset"),
                                              retryAfter: http?.value(forHTTPHeaderField: "retry-after"),
                                              message: message) {
                throw GitHubError.rateLimited(resetAt: resetAt)
            }
            throw GitHubError.http(status: status, message: message)
        }
        let decoded = try GitHubJSON.decoder().decode(T.self, from: data)
        if reusable, let cache, let etag = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "ETag") {
            await cache.store(.init(etag: etag, data: data), for: key, token: token)
        }
        return decoded
    }
}
