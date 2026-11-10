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

public protocol GitHubAPI: Sendable {
    func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T
}

public struct URLSessionGitHubAPI: GitHubAPI {
    private let token: String
    private let session: URLSession
    private let baseURL = URL(string: "https://api.github.com/")!

    public init(token: String, session: URLSession = .shared) {
        self.token = token
        self.session = session
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

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw GitHubError.network(error.localizedDescription)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 { throw GitHubError.unauthorized }
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
        return try GitHubJSON.decoder().decode(T.self, from: data)
    }
}
