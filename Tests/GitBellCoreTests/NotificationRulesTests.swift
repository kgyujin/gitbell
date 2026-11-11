// 알림 규칙: 내 활동, 포크 브랜치, 머지 대기열, 마크다운 미리보기, 기록 상한에서 안 읽은 항목 지키기.

import Foundation
import XCTest
@testable import GitBellCore

final class NotificationRulesTests: XCTestCase {
    private func event(_ id: String, kind: EventKind = .comment, actor: String = "amy", minutesAgo: Double = 1,
                       prAuthor: String? = nil) -> ActivityEvent {
        var event = ActivityEvent(id: id, repo: "o/r", kind: kind, time: Date().addingTimeInterval(-minutesAgo * 60),
                                  actor: actor, title: id, url: URL(string: "https://github.com/o/r")!)
        event.prAuthor = prAuthor
        return event
    }

    private func laterState() -> WatchState {
        var state = WatchState()
        state.me = "me"
        state.lastChecked = Date().addingTimeInterval(-60)
        return state
    }

    func testClosedOwnPullRequestWithUnknownCloserIsNotNotified() {
        var state = laterState()
        let closed = event("closed", kind: .prClosed, actor: "", prAuthor: "me")
        let notified = state.apply([closed], now: Date(), includeOwn: false)
        XCTAssertTrue(notified.isEmpty, "내 PR이 닫힌 것은 대개 내가 닫은 것이라 알리지 않는다")
    }

    func testMergedByUnknownOnMyPullRequestStillNotifies() {
        var state = laterState()
        let merged = event("merged", kind: .prMerged, actor: "", prAuthor: "me")
        XCTAssertEqual(state.apply([merged], now: Date(), includeOwn: false).map(\.id), ["merged"],
                       "머지는 다른 사람이 하는 일이 많아 알린다")
    }

    func testTrimDropsReadItemsBeforeUnread() {
        var state = laterState()
        var config = WatchConfig()
        config.historyLimit = 2
        var old = event("old-unread", minutesAgo: 30)
        old.isUnread = true
        var read = event("read", minutesAgo: 10)
        read.isUnread = false
        state.history = [read, old]
        _ = state.apply([event("new", minutesAgo: 1)], now: Date(), includeOwn: false, config: config)
        XCTAssertEqual(Set(state.history.map(\.id)), ["new", "old-unread"], "읽은 항목부터 버린다")
    }

    func testForkBranchWithSameNameIsNotLinkedToPullRequest() throws {
        let json = #"""
        [{"number":1,"title":"fork PR","html_url":"https://github.com/o/r/pull/1","user":{"login":"amy"},
          "head":{"ref":"main","repo":{"full_name":"amy/r"}},"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"}]
        """#
        let pulls = try GitHubJSON.decoder().decode([GHPull].self, from: Data(json.utf8))
        let push = #"""
        [{"id":5,"activity_type":"push","ref":"refs/heads/main","before":"a","after":"b","actor":{"login":"bob"},
          "timestamp":"2026-11-10T00:00:00Z"}]
        """#
        let activity = try GitHubJSON.decoder().decode([GHActivity].self, from: Data(push.utf8))
        let events = EventBuilder.build(RepoSnapshot(pulls: pulls, reviewComments: [], issueComments: [], activity: activity),
                                        repo: "o/r", since: ISO8601DateFormatter().date(from: "2026-11-09T00:00:00Z")!)
        XCTAssertNil(events.first { $0.kind == .push }?.prAuthor, "포크의 main은 원래 저장소의 main이 아니다")
    }

    func testMarkdownIsStrippedFromPreview() {
        XCTAssertEqual(TextPreview.firstLine("**LGTM** see [docs](https://x.y)"), "LGTM see docs")
        XCTAssertEqual(TextPreview.firstLine("```suggestion\nlet x = 1\n```\nTry this"), "Try this")
        XCTAssertEqual(TextPreview.firstLine("![image](https://github.com/user-attachments/a.png)"), "",
                       "이미지만 있으면 빈 줄(화면은 종류 이름으로 대신한다)")
        XCTAssertEqual(TextPreview.firstLine("Use `npm ci` here"), "Use npm ci here")
    }

    func testClockJumpDoesNotNotifyTwice() {
        var state = laterState()
        let comment = event("o/r#ic:1")
        XCTAssertEqual(state.apply([comment], now: Date(), includeOwn: false).count, 1)
        _ = state.apply([], now: Date().addingTimeInterval(10 * 24 * 3600), includeOwn: false)   // 시계가 10일 앞으로
        XCTAssertEqual(state.apply([comment], now: Date(), includeOwn: false).count, 0)
        XCTAssertEqual(state.history.filter { $0.id == "o/r#ic:1" }.count, 1, "기록에도 한 번만")
    }

    func testRenamedRepositoryDoesNotRenotify() {
        var state = laterState()
        _ = state.apply([event("o/old#ic:7")], now: Date(), includeOwn: false)
        XCTAssertTrue(state.apply([event("o/new#ic:7")], now: Date(), includeOwn: false).isEmpty)
    }

    func testItemsTrimmedImmediatelyAreNotNotified() {
        var state = laterState()
        var config = WatchConfig()
        config.historyLimit = 2
        let many = (1...3).map { event("o/r#ic:\($0)", minutesAgo: Double($0)) }
        let notified = state.apply(many, now: Date(), includeOwn: false, config: config)
        XCTAssertEqual(Set(notified.map(\.id)), Set(state.history.map(\.id)))
    }

    func testFailingPushDetailStopsAfterAttempts() async {
        struct Failing: GitHubAPI {
            func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
                throw GitHubError.http(status: 502, message: "Bad Gateway")
            }
        }
        var push = ActivityEvent(id: "o/r#act:1", repo: "o/r", kind: .push, time: Date(), actor: "amy", title: "",
                                 url: URL(string: "https://github.com/o/r")!, before: "a", after: "b", detailResolved: false)
        let poller = ActivityPoller(api: Failing())
        for _ in 0..<3 { push = await poller.resolvePushDetail(push).event }
        XCTAssertTrue(push.detailResolved)
        XCTAssertEqual(push.detailAttempts, 3)
    }
}
