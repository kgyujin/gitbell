// GitBellCore 검증. GitHub에 실제로 요청하지 않고, 실제 응답 모양의 JSON으로 확인한다.

import XCTest
@testable import GitBellCore

private let repo = "org/repo"
private let now = date("2026-11-09T06:00:00Z")
private let since = date("2026-11-09T05:00:00Z")
private let recent = "2026-11-09T05:30:00Z"
private let old = "2026-11-09T03:00:00Z"

private func date(_ text: String) -> Date { ISO8601DateFormatter().date(from: text)! }

private func decode<T: Decodable>(_ json: String, as type: T.Type = T.self) -> T {
    try! GitHubJSON.decoder().decode(T.self, from: Data(json.utf8))
}

private func user(_ login: String) -> String { #"{"login":"\#(login)","avatar_url":"https://a/\#(login)"}"# }

private func sampleSnapshot() -> RepoSnapshot {
    RepoSnapshot(
        pulls: decode("""
        [
          {"number":33,"title":"새 PR","html_url":"https://github.com/org/repo/pull/33","user":\(user("amy")),
           "created_at":"\(recent)","updated_at":"\(recent)","merged_at":null,"closed_at":null,"merge_commit_sha":null},
          {"number":32,"title":"머지된 PR","html_url":"https://github.com/org/repo/pull/32","user":\(user("bob")),
           "created_at":"\(old)","updated_at":"\(recent)","merged_at":"\(recent)","closed_at":"\(recent)","merge_commit_sha":"m32"},
          {"number":31,"title":"닫힌 PR","html_url":"https://github.com/org/repo/pull/31","user":\(user("bob")),
           "created_at":"\(old)","updated_at":"\(recent)","merged_at":null,"closed_at":"\(recent)","merge_commit_sha":"x"}
        ]
        """),
        reviewsByPR: [33: decode("""
        [
          {"id":1,"state":"APPROVED","body":"","user":\(user("bob")),"submitted_at":"\(recent)","html_url":"https://r/1"},
          {"id":2,"state":"COMMENTED","body":"","user":\(user("amy")),"submitted_at":"\(recent)","html_url":"https://r/2"},
          {"id":3,"state":"COMMENTED","body":"전체 의견","user":\(user("cat")),"submitted_at":"\(recent)","html_url":"https://r/3"},
          {"id":4,"state":"CHANGES_REQUESTED","body":"x","user":\(user("cat")),"submitted_at":"\(old)","html_url":"https://r/4"}
        ]
        """)],
        reviewComments: decode("""
        [
          {"id":10,"pull_request_review_id":3,"pull_request_url":"https://api/pulls/33","user":\(user("cat")),
           "body":"인라인","created_at":"\(recent)","html_url":"https://c/10"},
          {"id":11,"pull_request_review_id":2,"pull_request_url":"https://api/pulls/33","user":\(user("amy")),
           "body":"답글\\n둘째 줄","created_at":"\(recent)","html_url":"https://c/11"}
        ]
        """),
        issueComments: decode("""
        [
          {"id":20,"issue_url":"https://api/issues/33","html_url":"https://github.com/org/repo/pull/33#c",
           "user":\(user("dan")),"body":"PR 댓글","created_at":"\(recent)"},
          {"id":21,"issue_url":"https://api/issues/7","html_url":"https://github.com/org/repo/issues/7#c",
           "user":\(user("dan")),"body":"이슈 댓글","created_at":"\(recent)"}
        ]
        """),
        activity: decode("""
        [
          {"id":100,"activity_type":"push","ref":"refs/heads/feat/a","before":"b1","after":"a1","actor":\(user("amy")),"timestamp":"\(recent)"},
          {"id":101,"activity_type":"force_push","ref":"refs/heads/feat/b","before":"b2","after":"a2","actor":\(user("eve")),"timestamp":"\(recent)"},
          {"id":102,"activity_type":"branch_creation","ref":"refs/heads/feat/c","before":"\(EventBuilder.zeroSHA)","after":"a3","actor":\(user("eve")),"timestamp":"\(recent)"},
          {"id":103,"activity_type":"pr_merge","ref":"refs/heads/main","before":"p","after":"m32","actor":\(user("me")),"timestamp":"\(recent)"},
          {"id":104,"activity_type":"branch_deletion","ref":"refs/heads/feat/d","before":"d","after":"\(EventBuilder.zeroSHA)","actor":\(user("me")),"timestamp":"\(recent)"},
          {"id":105,"activity_type":"push","ref":"refs/heads/feat/old","before":"o","after":"o2","actor":\(user("amy")),"timestamp":"\(old)"},
          {"id":106,"activity_type":"force_push","ref":"refs/heads/gh-pages","before":"g","after":"g2","actor":\(user("github-actions[bot]")),"timestamp":"\(recent)"}
        ]
        """)
    )
}

final class TextPreviewTests: XCTestCase {
    func testSkipsQuotesAndHeadingMarks() {
        XCTAssertEqual(TextPreview.firstLine("> > 인용\n\n실제 답글\n둘째"), "실제 답글")
        XCTAssertEqual(TextPreview.firstLine("## 코드 리뷰: PR #33"), "코드 리뷰: PR #33")
        XCTAssertEqual(TextPreview.firstLine("> 인용뿐"), "> 인용뿐")
        XCTAssertEqual(TextPreview.firstLine(nil), "")
    }

    func testStripsHTMLCommentsAndTags() {
        XCTAssertEqual(TextPreview.firstLine("<!-- summary -->\n<details><summary>요약</summary>\n본문"), "요약")
        XCTAssertEqual(TextPreview.firstLine("<!-- a\nb -->\n실제 내용"), "실제 내용")
        XCTAssertEqual(TextPreview.firstLine("a < b 비교"), "a < b 비교")
    }
}

final class EventBuilderTests: XCTestCase {
    private var byID: [String: ActivityEvent] = [:]
    private var events: [ActivityEvent] = []

    override func setUp() {
        events = EventBuilder.build(sampleSnapshot(), repo: repo, since: since)
        byID = Dictionary(uniqueKeysWithValues: events.map { ($0.id, $0) })
    }

    private func id(_ suffix: String) -> String { "\(repo)#\(suffix)" }

    func testIDsCarryRepoAndDoNotCollideAcrossRepos() {
        XCTAssertTrue(events.allSatisfy { $0.id.hasPrefix("\(repo)#") && $0.repo == repo })
        let other = EventBuilder.build(sampleSnapshot(), repo: "org/other", since: since)
        XCTAssertTrue(Set(events.map(\.id)).isDisjoint(with: other.map(\.id)))
    }

    func testPullRequests() {
        XCTAssertEqual(byID[id("pr-open:33")]?.kind, .prOpened)
        XCTAssertNil(byID[id("pr-open:32")], "since 이전에 열린 PR")
        XCTAssertEqual(byID[id("pr-merged:32")]?.actor, "me", "머지한 사람은 pr_merge 활동에서 찾는다")
        XCTAssertNil(byID[id("pr-closed:32")], "머지된 PR은 닫힘으로 또 만들지 않는다")
        XCTAssertEqual(byID[id("pr-closed:31")]?.kind, .prClosed)
    }

    func testReviewsAndComments() {
        XCTAssertEqual(byID[id("review:1")]?.kind, .reviewApproved)
        XCTAssertNil(byID[id("review:2")], "빈 COMMENTED 리뷰는 건너뛴다")
        XCTAssertEqual(byID[id("review:3")]?.title, "전체 의견")
        XCTAssertNil(byID[id("review:4")], "since 이전 리뷰")
        XCTAssertNil(byID[id("rc:10")], "리뷰 항목과 겹치는 인라인 댓글")
        XCTAssertEqual(byID[id("rc:11")]?.title, "답글")
        XCTAssertEqual(byID[id("rc:11")]?.number, 33)
        XCTAssertEqual(byID[id("ic:20")]?.isIssue, false)
        XCTAssertEqual(byID[id("ic:21")]?.isIssue, true)
        XCTAssertEqual(byID[id("ic:21")]?.number, 7)
    }

    func testPushes() {
        let push = byID[id("act:100")]
        XCTAssertEqual(push?.kind, .push)
        XCTAssertEqual(push?.branch, "feat/a")
        XCTAssertEqual(push?.url.absoluteString, "https://github.com/org/repo/compare/b1...a1")
        XCTAssertEqual(push?.detailResolved, false)
        XCTAssertEqual(byID[id("act:101")]?.kind, .forcePush)
        XCTAssertEqual(byID[id("act:102")]?.kind, .branchCreated)
        for skipped in ["act:103", "act:104", "act:105", "act:106"] {
            XCTAssertNil(byID[id(skipped)], "\(skipped): pr_merge·브랜치 삭제·오래된 push·봇 push는 뺀다")
        }
    }

    func testSortedOldestFirst() {
        XCTAssertEqual(events.map(\.time), events.map(\.time).sorted())
    }
}

final class WatchStateTests: XCTestCase {
    private let events = EventBuilder.build(sampleSnapshot(), repo: repo, since: since)

    private func laterState() -> WatchState {
        var state = WatchState()
        state.me = "me"
        state.lastChecked = date("2026-11-09T05:00:00Z")
        return state
    }

    func testFirstRunFillsHistoryWithoutNotifying() {
        var state = WatchState()
        state.me = "me"
        let toNotify = state.apply(events, now: now, includeOwn: false)
        XCTAssertTrue(toNotify.isEmpty)
        XCTAssertEqual(state.history.count, events.count - 1, "내 머지 1건은 빠진다")
        XCTAssertEqual(state.unreadCount, 0)
        XCTAssertEqual(state.lastChecked, now)
    }

    func testLaterRunNotifiesOthersOnlyOnce() {
        var state = laterState()
        let notified = Set(state.apply(events, now: now, includeOwn: false).map(\.id))
        XCTAssertTrue(notified.contains("\(repo)#pr-open:33"))
        XCTAssertFalse(notified.contains("\(repo)#pr-merged:32"), "내 활동은 알리지 않는다")
        XCTAssertNotNil(state.seen["\(repo)#pr-merged:32"], "다시 판단하지 않게 본 항목에는 남긴다")
        XCTAssertEqual(state.unreadCount, notified.count)

        let again = state.apply(events, now: now.addingTimeInterval(120), includeOwn: false)
        XCTAssertTrue(again.isEmpty, "같은 항목은 다시 알리지 않는다")
    }

    func testIncludeOwnActivity() {
        var state = laterState()
        let notified = state.apply(events, now: now, includeOwn: true).map(\.id)
        XCTAssertTrue(notified.contains("\(repo)#pr-merged:32"))
    }

    func testSeenExpiresAndHistoryIsCapped() {
        var state = laterState()
        state.seen = ["old": date("2026-11-01T00:00:00Z")]
        var config = WatchConfig()
        config.historyLimit = 3
        _ = state.apply(events, now: now, includeOwn: true, config: config)
        XCTAssertNil(state.seen["old"])
        XCTAssertEqual(state.history.count, 3)
        XCTAssertEqual(state.history.map(\.time), state.history.map(\.time).sorted(by: >), "최신순")
    }

    func testMarkRead() {
        var state = laterState()
        _ = state.apply(events, now: now, includeOwn: false)
        let first = state.history[0].id
        state.markRead(first)
        XCTAssertFalse(state.history[0].isUnread)
        XCTAssertGreaterThan(state.unreadCount, 0)
        state.markRead()
        XCTAssertEqual(state.unreadCount, 0)
    }

    func testOldVersionRestartsQuietly() {
        var old = laterState()
        old.version = 0
        old.history = events
        let migrated = old.migrated()
        XCTAssertEqual(migrated.me, "me")
        XCTAssertNil(migrated.lastChecked)
        XCTAssertTrue(migrated.history.isEmpty)
    }

    func testStateRoundTripsThroughJSON() throws {
        var state = laterState()
        _ = state.apply(events, now: now, includeOwn: false)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let restored = try decoder.decode(WatchState.self, from: encoder.encode(state))
        XCTAssertEqual(restored.history, state.history)
        XCTAssertEqual(restored.unreadCount, state.unreadCount)
    }
}

final class RepoSelectorTests: XCTestCase {
    func testRecentPushOrNewNotification() {
        let repos: [GHRepo] = decode("""
        [
          {"full_name":"a/pushed","pushed_at":"2026-11-08T00:00:00Z","archived":false},
          {"full_name":"a/quiet","pushed_at":"2026-10-01T00:00:00Z","archived":false},
          {"full_name":"a/archived","pushed_at":"\(recent)","archived":true},
          {"full_name":"a/never","pushed_at":null,"archived":false}
        ]
        """)
        let notifications: [GHNotification] = decode("""
        [
          {"repository":{"full_name":"b/commented"},"updated_at":"\(recent)"},
          {"repository":{"full_name":"b/stale"},"updated_at":"\(old)"},
          {"repository":{"full_name":"a/pushed"},"updated_at":"\(recent)"}
        ]
        """)
        XCTAssertEqual(RepoSelector.select(repos: repos, notifications: notifications, since: since, now: now),
                       ["a/pushed", "b/commented"])
    }
}

/// 경로 앞부분으로 미리 정한 JSON을 돌려주는 가짜 GitHub. 모르는 경로는 404로 실패한다.
private struct FakeGitHub: GitHubAPI {
    var routes: [(prefix: String, json: String)]

    func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
        guard let route = routes.first(where: { path.hasPrefix($0.prefix) }) else {
            throw GitHubError.http(status: 404, message: path)
        }
        return try GitHubJSON.decoder().decode(T.self, from: Data(route.json.utf8))
    }
}

final class ActivityPollerTests: XCTestCase {
    private func api(pushTime: String) -> FakeGitHub {
        FakeGitHub(routes: [
            ("user/repos", #"[{"full_name":"org/repo","pushed_at":"\#(pushTime)","archived":false},{"full_name":"org/broken","pushed_at":"\#(pushTime)","archived":false}]"#),
            ("user", #"{"login":"me"}"#),
            ("notifications", "[]"),
            ("repos/org/repo/pulls/comments", "[]"),
            ("repos/org/repo/pulls", "[]"),
            ("repos/org/repo/issues/comments", "[]"),
            ("repos/org/repo/activity", """
             [{"id":1,"activity_type":"push","ref":"refs/heads/main","before":"aaa","after":"bbb","actor":\(user("amy")),"timestamp":"\(pushTime)"}]
             """),
            ("repos/org/repo/compare/aaa...bbb", #"{"total_commits":2,"commits":[{"commit":{"message":"첫 커밋"}},{"commit":{"message":"fix: 마지막 커밋\n\n본문"}}]}"#),
        ])
    }

    func testFirstRunIsQuietThenNewPushIsNotifiedWithCommitTitle() async throws {
        let poller = ActivityPoller(api: api(pushTime: recent))
        let first = try await poller.refresh(WatchState(), now: now, includeOwn: false)
        XCTAssertTrue(first.newEvents.isEmpty, "첫 실행은 알리지 않는다")
        XCTAssertEqual(first.state.me, "me")
        XCTAssertEqual(first.state.checkedRepos, ["org/broken", "org/repo"])
        XCTAssertEqual(first.failedRepos, ["org/broken"], "읽지 못한 저장소는 따로 알리고 나머지는 계속한다")
        XCTAssertEqual(first.state.history.first?.commitCount, 2)
        XCTAssertEqual(first.state.history.first?.title, "fix: 마지막 커밋")

        let laterPush = "2026-11-09T06:01:00Z"
        let second = try await ActivityPoller(api: api(pushTime: laterPush))
            .refresh(first.state, now: date("2026-11-09T06:02:00Z"), includeOwn: false)
        // 같은 id(act:1)라 이미 본 항목으로 걸러진다.
        XCTAssertTrue(second.newEvents.isEmpty)
    }

    func testLaterRunNotifiesResolvedPush() async throws {
        var state = WatchState()
        state.me = "me"
        state.lastChecked = date("2026-11-09T05:25:00Z")
        let result = try await ActivityPoller(api: api(pushTime: recent)).refresh(state, now: now, includeOwn: false)
        XCTAssertEqual(result.newEvents.count, 1)
        XCTAssertEqual(result.newEvents.first?.title, "fix: 마지막 커밋", "알림에도 커밋 제목이 들어간다")
        XCTAssertEqual(result.state.unreadCount, 1)
    }
}
