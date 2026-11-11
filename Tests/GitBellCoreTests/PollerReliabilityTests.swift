// 확인(poller)의 안정성: 실패한 저장소를 다음에 그때부터 다시 읽기, since 묶기, 한도에 걸리면 push 읽기 멈추기.

import Foundation
import XCTest
@testable import GitBellCore

/// 요청한 경로를 적어 두는 가짜 GitHub. 경로 앞부분으로 응답이나 오류를 고른다.
private final class RecordingGitHub: GitHubAPI, @unchecked Sendable {
    enum Reply { case json(String), failure(GitHubError) }
    // 여러 요청이 동시에 들어오므로 자물쇠로 지킨다.
    private let lock = NSLock()
    private var routes: [(prefix: String, reply: Reply)]
    private var recorded: [String] = []

    init(routes: [(String, Reply)]) {
        self.routes = routes.map { (prefix: $0.0, reply: $0.1) }
    }

    var paths: [String] { lock.withLock { recorded } }

    func replace(_ prefix: String, with reply: Reply) {
        lock.withLock {
            routes.removeAll { $0.prefix == prefix }
            routes.insert((prefix: prefix, reply: reply), at: 0)
        }
    }

    func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
        let route = lock.withLock { () -> (prefix: String, reply: Reply)? in
            recorded.append(path)
            return routes.first(where: { path.hasPrefix($0.prefix) })
        }
        guard let route else { throw GitHubError.http(status: 404, message: path) }
        switch route.reply {
        case let .json(json): return try GitHubJSON.decoder().decode(T.self, from: Data(json.utf8))
        case let .failure(error): throw error
        }
    }
}

final class PollerReliabilityTests: XCTestCase {
    private func date(_ iso: String) -> Date { ISO8601DateFormatter().date(from: iso)! }

    private func repoRoutes(_ repo: String) -> [(String, RecordingGitHub.Reply)] {
        [("repos/\(repo)/pulls/comments", .json("[]")), ("repos/\(repo)/pulls", .json("[]")),
         ("repos/\(repo)/issues/comments", .json("[]")), ("repos/\(repo)/activity", .json("[]"))]
    }

    private func github(pushedAt: String) -> RecordingGitHub {
        RecordingGitHub(routes: [
            ("user/repos", .json(#"[{"full_name":"o/a","pushed_at":"\#(pushedAt)","archived":false},{"full_name":"o/b","pushed_at":"\#(pushedAt)","archived":false}]"#)),
            ("notifications", .json("[]")),
        ] + repoRoutes("o/a") + repoRoutes("o/b"))
    }

    func testFailedRepoIsReadAgainFromWhereItFailed() async throws {
        let api = github(pushedAt: "2026-11-09T11:00:00Z")
        api.replace("repos/o/b/activity", with: .failure(.network("offline")))
        var state = WatchState()
        state.me = "me"
        state.lastChecked = date("2026-11-09T11:58:00Z")
        let poller = ActivityPoller(api: api)

        let first = try await poller.refresh(state, now: date("2026-11-09T12:00:00Z"), includeOwn: false)
        XCTAssertEqual(first.failedRepos, ["o/b"])
        // 11:58 - 10분 = 11:48 → 10분 단위로 11:40
        XCTAssertEqual(first.state.retrySince, ["o/b": date("2026-11-09T11:40:00Z")], "실패한 저장소는 그때부터 다시 읽는다")

        // 30분 뒤: 다른 저장소는 11:50(12:00 - 10분)부터, 실패했던 저장소는 11:40부터 읽고, 성공하면 기억을 지운다.
        api.replace("repos/o/b/activity", with: .json("[]"))
        let second = try await poller.refresh(first.state, now: date("2026-11-09T12:30:00Z"), includeOwn: false)
        let paths = api.paths
        XCTAssertTrue(paths.contains { $0.hasPrefix("repos/o/b/issues/comments?since=2026-11-09T11:40:00Z") })
        XCTAssertTrue(paths.contains { $0.hasPrefix("repos/o/a/issues/comments?since=2026-11-09T11:50:00Z") })
        XCTAssertNil(second.state.retrySince)
    }

    func testMissingRepoIsNotRetried() async throws {
        // 지워졌거나 권한이 없어진 저장소(404)는 다시 읽어도 실패하므로 기억하지 않는다.
        let api = github(pushedAt: "2026-11-09T11:00:00Z")
        api.replace("repos/o/b/activity", with: .failure(.http(status: 404, message: "Not Found")))
        var state = WatchState()
        state.me = "me"
        state.lastChecked = date("2026-11-09T11:58:00Z")
        let result = try await ActivityPoller(api: api).refresh(state, now: date("2026-11-09T12:00:00Z"), includeOwn: false)
        XCTAssertEqual(result.failedRepos, ["o/b"])
        XCTAssertNil(result.state.retrySince)
    }

    func testFailedRepoIsCheckedEvenIfNotSelectedAgain() async throws {
        // 저장소 목록에서 빠져도(최근 push가 오래됨) 지난번에 실패했으면 다시 읽는다.
        let api = github(pushedAt: "2026-10-01T00:00:00Z")
        var state = WatchState()
        state.me = "me"
        state.lastChecked = date("2026-11-09T11:58:00Z")
        state.retrySince = ["o/b": date("2026-11-09T11:00:00Z")]
        let result = try await ActivityPoller(api: api).refresh(state, now: date("2026-11-09T12:00:00Z"), includeOwn: false)
        XCTAssertEqual(result.state.checkedRepos, ["o/b"])
    }

    func testSinceIsCappedAndRounded() {
        let config = WatchConfig()
        let now = date("2026-11-20T12:07:00Z")
        XCTAssertEqual(ActivityPoller.since(lastChecked: date("2026-11-20T12:05:30Z"), now: now, config: config),
                       date("2026-11-20T11:50:00Z"), "10분 앞으로 가서 10분 단위로 내린다")
        XCTAssertEqual(ActivityPoller.since(lastChecked: date("2026-11-10T00:00:00Z"), now: now, config: config),
                       date("2026-11-19T12:00:00Z"), "오래 꺼 두었어도 하루보다 앞은 읽지 않는다")
        XCTAssertEqual(ActivityPoller.since(lastChecked: nil, now: now, config: config),
                       date("2026-11-19T12:00:00Z"), "처음 실행은 하루 전부터")
    }

    func testPushTitlesStopAtRateLimit() async throws {
        let pushes = (1...8).map { index in
            #"{"id":\#(index),"activity_type":"push","ref":"refs/heads/main","before":"b\#(index)","after":"a\#(index)","actor":{"login":"amy"},"timestamp":"2026-11-09T11:59:00Z"}"#
        }
        let api = RecordingGitHub(routes: [
            ("user/repos", .json(#"[{"full_name":"o/a","pushed_at":"2026-11-09T11:59:00Z","archived":false}]"#)),
            ("notifications", .json("[]")),
            ("repos/o/a/activity", .json("[" + pushes.joined(separator: ",") + "]")),
            ("repos/o/a/compare", .failure(.rateLimited(resetAt: nil))),
            ("repos/o/a/commits", .failure(.rateLimited(resetAt: nil))),
        ] + repoRoutes("o/a"))
        var state = WatchState()
        state.me = "me"
        state.lastChecked = date("2026-11-09T11:58:00Z")
        let result = try await ActivityPoller(api: api).refresh(state, now: date("2026-11-09T12:00:00Z"), includeOwn: false)

        let paths = api.paths
        let pushCalls = paths.filter { $0.contains("/compare/") || $0.contains("/commits/") }
        XCTAssertEqual(pushCalls.count, WatchConfig().maxConcurrentRepos,
                       "한도에 걸린 묶음까지만 보내고, 마지막 커밋으로 다시 읽지 않는다")
        XCTAssertTrue(result.state.history.allSatisfy { !$0.detailResolved }, "다음 확인 때 다시 읽는다")
    }

    // MARK: 조용한 저장소는 덜 자주, 바뀐 저장소는 바로

    private func repo(_ name: String, pushedAt: String) -> GHRepo {
        try! GitHubJSON.decoder().decode(GHRepo.self, from: Data(#"{"full_name":"\#(name)","pushed_at":"\#(pushedAt)","archived":false}"#.utf8))
    }

    func testQuietRepoIsReadOnlyEveryQuietRecheck() {
        let now = date("2026-11-09T12:00:00Z")
        let repos = [repo("o/quiet", pushedAt: "2026-11-09T09:00:00Z"), repo("o/busy", pushedAt: "2026-11-09T11:59:00Z")]
        let lastRead = ["o/quiet": date("2026-11-09T11:55:00Z"), "o/busy": date("2026-11-09T11:55:00Z")]
        let plan = RepoSelector.plan(repos: repos, notifications: [], lastRead: lastRead, retry: [],
                                     since: date("2026-11-09T11:50:00Z"), now: now, lowBudget: false)
        XCTAssertEqual(plan, ["o/busy"], "새 push가 있는 저장소만 바로 읽는다")
        let later = RepoSelector.plan(repos: repos, notifications: [], lastRead: lastRead, retry: [],
                                      since: date("2026-11-09T12:00:00Z"), now: date("2026-11-09T12:10:00Z"), lowBudget: false)
        XCTAssertEqual(later, ["o/busy", "o/quiet"], "조용한 저장소도 15분이 지나면 다시 읽는다")
    }

    func testNotificationSignalsRepoAndLowBudgetSkipsQuietRepos() {
        let repos = [repo("o/quiet", pushedAt: "2026-11-09T09:00:00Z")]
        let lastRead = ["o/quiet": date("2026-11-09T11:00:00Z")]
        let notification = try! GitHubJSON.decoder().decode(GHNotification.self, from: Data(#"""
        {"updated_at":"2026-11-09T11:58:00Z","repository":{"full_name":"o/talk"}}
        """#.utf8))
        let plan = RepoSelector.plan(repos: repos, notifications: [notification], lastRead: lastRead, retry: [],
                                     since: date("2026-11-09T11:50:00Z"), now: date("2026-11-09T12:00:00Z"), lowBudget: true)
        XCTAssertEqual(plan, ["o/talk"], "알림함 소식이 온 저장소는 읽고, 한도가 넉넉하지 않으면 조용한 저장소는 미룬다")
        let noInbox = RepoSelector.plan(repos: repos, notifications: nil, lastRead: lastRead, retry: [],
                                        since: date("2026-11-09T11:50:00Z"), now: date("2026-11-09T12:00:00Z"), lowBudget: false)
        XCTAssertEqual(noInbox, ["o/quiet"], "알림함을 읽을 수 없으면 신호가 없어 매번 읽는다")
    }
}
