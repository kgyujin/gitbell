// 조건부 요청(ETag): 바뀐 것이 없으면 304를 받아 보관한 응답을 다시 쓴다.

import Foundation
import XCTest
@testable import GitBellCore

/// 가짜 GitHub. 요청마다 받은 If-None-Match를 적어 두고, 정해 둔 응답을 돌려준다.
final class StubProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var responses: [(status: Int, etag: String?, body: String)] = []
    nonisolated(unsafe) static var sentETags: [String?] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.sentETags.append(request.value(forHTTPHeaderField: "If-None-Match"))
        let next = Self.responses.removeFirst()
        var headers = ["Content-Type": "application/json"]
        if let etag = next.etag { headers["ETag"] = etag }
        let response = HTTPURLResponse(url: request.url!, statusCode: next.status, httpVersion: "HTTP/1.1",
                                       headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(next.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class ConditionalRequestTests: XCTestCase {
    private func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: configuration)
    }

    func testNotModifiedReusesStoredBody() async throws {
        StubProtocol.sentETags = []
        StubProtocol.responses = [(200, "\"v1\"", #"{"login":"me"}"#), (304, "\"v1\"", "")]
        let cache = ResponseCache()
        let api = URLSessionGitHubAPI(token: "tok", session: session(), cache: cache)

        let first = try await api.get("user", as: GHUser.self)
        let second = try await api.get("user", as: GHUser.self)

        XCTAssertEqual(first.login, "me")
        XCTAssertEqual(second.login, "me", "304면 보관한 본문을 쓴다")
        XCTAssertEqual(StubProtocol.sentETags, [nil, "\"v1\""], "두 번째에는 받은 ETag를 보낸다")
    }

    func testOneOffPathsAreNotStored() async throws {
        StubProtocol.sentETags = []
        StubProtocol.responses = [(200, "\"a\"", #"{"commit":{"message":"m"}}"#), (200, "\"a\"", #"{"commit":{"message":"m"}}"#)]
        let cache = ResponseCache()
        let api = URLSessionGitHubAPI(token: "tok", session: session(), cache: cache)
        let path = "repos/o/r/commits/abc"
        _ = try await api.get(path, as: GHCommit.self)
        _ = try await api.get(path, as: GHCommit.self)
        XCTAssertEqual(StubProtocol.sentETags, [nil, nil], "push마다 한 번 읽는 큰 응답은 보관하지 않는다")
        let count = await cache.count
        XCTAssertEqual(count, 0)
    }

    func testResponseFromOldTokenIsNotStored() async {
        let cache = ResponseCache()
        await cache.use(token: "new")
        await cache.store(.init(etag: "e", data: Data()), for: "user", token: "old")
        let count = await cache.count
        XCTAssertEqual(count, 0, "토큰이 바뀌기 전에 시작한 확인의 응답은 넣지 않는다")
    }

    func testByteLimitEvictsOldest() async {
        let cache = ResponseCache(limit: 10, byteLimit: 10)
        await cache.use(token: "a")
        await cache.store(.init(etag: "e", data: Data(count: 6)), for: "1", token: "a")
        await cache.store(.init(etag: "e", data: Data(count: 6)), for: "2", token: "a")
        let kept = await [cache.entry(for: "1", token: "a") != nil, cache.entry(for: "2", token: "a") != nil]
        XCTAssertEqual(kept, [false, true], "본문 크기 합이 넘치면 오래된 것부터 버린다")
    }

    func testCacheEvictsOldestAndClearsOnNewToken() async {
        let cache = ResponseCache(limit: 2)
        await cache.use(token: "a")
        let entry = ResponseCache.Entry(etag: "e", data: Data())
        await cache.store(entry, for: "1", token: "a")
        await cache.store(entry, for: "2", token: "a")
        _ = await cache.entry(for: "1", token: "a")  // 1을 최근에 썼다
        await cache.store(entry, for: "3", token: "a")
        let kept = await [cache.entry(for: "1", token: "a") != nil, cache.entry(for: "2", token: "a") != nil,
                          cache.entry(for: "3", token: "a") != nil]
        XCTAssertEqual(kept, [true, false, true], "가장 오래 안 쓴 것부터 버린다")

        await cache.use(token: "a")
        var count = await cache.count
        XCTAssertEqual(count, 2, "같은 토큰이면 그대로 둔다")
        await cache.use(token: "b")
        count = await cache.count
        XCTAssertEqual(count, 0, "다른 계정의 응답은 쓰지 않는다")
    }
}
