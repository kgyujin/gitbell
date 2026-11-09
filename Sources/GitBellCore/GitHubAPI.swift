// GitHub REST API를 읽는 얇은 클라이언트. 토큰은 메모리에만 두고 로그나 오류 문구에 넣지 않는다.

import Foundation

public enum GitHubError: Error, Equatable, Sendable {
    case unauthorized
    case http(status: Int, message: String)
    case network(String)
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
            throw GitHubError.http(status: status, message: message)
        }
        return try GitHubJSON.decoder().decode(T.self, from: data)
    }
}
