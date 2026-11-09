// 0.4.0 배포 전 검토에서 고친 것들의 검증.
// - '내 PR' 판단(prAuthor), 내 PR 필터·알림
// - 새로고침 중 바꾼 읽음 표시 보존
// - 예전 설정 JSON을 읽어도 설정을 잃지 않음

import XCTest
@testable import GitBellCore

final class ReleaseReviewTests: XCTestCase {
    private let since = ISO8601DateFormatter().date(from: "2026-11-09T05:00:00Z")!
    private let recent = "2026-11-09T05:30:00Z"

    private func decode<T: Decodable>(_ json: String) -> T {
        try! GitHubJSON.decoder().decode(T.self, from: Data(json.utf8))
    }

    private func snapshot() -> RepoSnapshot {
        RepoSnapshot(
            pulls: decode("""
            [{"number":5,"title":"내 PR","html_url":"https://github.com/o/r/pull/5","user":{"login":"me"},
              "head":{"ref":"feat/mine"},"created_at":"2026-11-08T00:00:00Z","updated_at":"\(recent)",
              "merged_at":null,"closed_at":null,"merge_commit_sha":null},
             {"number":6,"title":"남의 PR","html_url":"https://github.com/o/r/pull/6","user":{"login":"amy"},
              "head":{"ref":"feat/amy"},"created_at":"\(recent)","updated_at":"\(recent)",
              "merged_at":null,"closed_at":null,"merge_commit_sha":null}]
            """),
            reviewsByPR: [5: decode("""
            [{"id":1,"state":"APPROVED","body":"","user":{"login":"bob"},"submitted_at":"\(recent)","html_url":"https://r/1"}]
            """)],
            issueComments: decode("""
            [{"id":2,"issue_url":"https://api/issues/5","html_url":"https://github.com/o/r/pull/5#c","user":{"login":"amy"},
              "body":"좋아요","created_at":"\(recent)"},
             {"id":3,"issue_url":"https://api/issues/9","html_url":"https://github.com/o/r/issues/9#c","user":{"login":"amy"},
              "body":"이슈 댓글","created_at":"\(recent)"}]
            """),
            activity: decode("""
            [{"id":10,"activity_type":"push","ref":"refs/heads/feat/mine","before":"a","after":"b","actor":{"login":"bob"},"timestamp":"\(recent)"},
             {"id":11,"activity_type":"push","ref":"refs/heads/feat/amy","before":"c","after":"d","actor":{"login":"amy"},"timestamp":"\(recent)"}]
            """))
    }

    private lazy var events = EventBuilder.build(snapshot(), repo: "o/r", since: since)
    private func event(_ suffix: String) -> ActivityEvent { events.first { $0.id == "o/r#\(suffix)" }! }

    func testPullRequestAuthorIsAttached() {
        XCTAssertEqual(event("review:1").prAuthor, "me", "리뷰 → PR 번호로 찾는다")
        XCTAssertEqual(event("ic:2").prAuthor, "me", "PR 댓글 → PR 번호로 찾는다")
        XCTAssertNil(event("ic:3").prAuthor, "이슈 댓글은 PR이 아니다")
        XCTAssertEqual(event("act:10").prAuthor, "me", "push → 브랜치로 찾는다")
        XCTAssertEqual(event("act:11").prAuthor, "amy")
        XCTAssertEqual(event("pr-open:6").prAuthor, "amy")
    }

    func testMineOnlyKeepsOthersActivityOnMyPullRequests() {
        var query = ActivityQuery(mineOnly: true)
        query.me = "me"
        XCTAssertEqual(Set(query.filter(events).map(\.id)), ["o/r#review:1", "o/r#ic:2", "o/r#act:10"])
        XCTAssertTrue(query.isFiltering)
        XCTAssertTrue(ActivityQuery(mineOnly: true).filter(events).isEmpty, "내 이름을 모르면 아무것도 고르지 않는다")
    }

    func testNotifyOnlyMyPullRequests() {
        var prefs = NotificationPreferences()
        prefs.onlyMyPullRequests = true
        let notified = eventsToNotify(events, notifications: prefs, display: DisplayPreferences(), me: "me")
        XCTAssertEqual(Set(notified.map(\.id)), ["o/r#review:1", "o/r#ic:2", "o/r#act:10"])
    }

    func testOldPreferencesJSONKeepsSavedValues() throws {
        // 0.3.x에 저장된 형태: onlyMyPullRequests 키가 없다.
        let old = #"{"isEnabled":true,"playsSound":false,"groups":["reviews"]}"#
        let prefs = try JSONDecoder().decode(NotificationPreferences.self, from: Data(old.utf8))
        XCTAssertFalse(prefs.playsSound)
        XCTAssertEqual(prefs.groups, [.reviews])
        XCTAssertFalse(prefs.onlyMyPullRequests)
    }

    func testOldHistoryWithoutPrAuthorStillDecodes() throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        var json = try JSONSerialization.jsonObject(with: encoder.encode(event("review:1"))) as! [String: Any]
        json.removeValue(forKey: "prAuthor")
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let restored = try decoder.decode(ActivityEvent.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertNil(restored.prAuthor)
    }

    func testSeenItemsGetPrAuthorFilledIn() {
        var state = WatchState()
        state.lastChecked = since
        var old = event("review:1")
        old.prAuthor = nil
        _ = state.apply([old], now: Date(), includeOwn: true)
        XCTAssertNil(state.history.first?.prAuthor)
        let notified = state.apply([event("review:1")], now: Date(), includeOwn: true)
        XCTAssertTrue(notified.isEmpty, "이미 본 항목은 다시 알리지 않는다")
        XCTAssertEqual(state.history.first?.prAuthor, "me", "작성자 정보만 채운다")
    }

    func testReadMarksMadeDuringRefreshSurvive() {
        var current = WatchState()
        current.history = events.map { var e = $0; e.isUnread = true; return e }
        var refreshed = current                    // 새로고침이 시작될 때의 상태로 만든 결과
        refreshed.history.append(ActivityEvent(id: "new", repo: "o/r", kind: .push, time: Date(), actor: "x",
                                               title: "", url: URL(string: "https://github.com")!, isUnread: true))
        current.markRead("o/r#review:1")           // 새로고침이 도는 동안 사용자가 읽음 표시
        current.markRead("o/r#ic:2")

        let merged = refreshed.adoptingReadMarks(from: current)
        XCTAssertFalse(merged.history.first { $0.id == "o/r#review:1" }!.isUnread)
        XCTAssertFalse(merged.history.first { $0.id == "o/r#ic:2" }!.isUnread)
        XCTAssertTrue(merged.history.first { $0.id == "new" }!.isUnread, "새로 들어온 항목은 그대로 안 읽음")
    }
}
