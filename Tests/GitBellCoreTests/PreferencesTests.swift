// 알림·표시 설정(Preferences) 검증.

import XCTest
@testable import GitBellCore

final class PreferencesTests: XCTestCase {
    private func event(_ id: String, kind: EventKind, repo: String = "acme/web", actor: String = "amy",
                       unread: Bool = true) -> ActivityEvent {
        ActivityEvent(id: id, repo: repo, kind: kind, time: Date(), actor: actor, title: id,
                      url: URL(string: "https://github.com/\(repo)")!, isUnread: unread)
    }

    func testEveryKindBelongsToAGroup() {
        XCTAssertEqual(Set(EventKind.allCases.map(\.notificationGroup)), Set(NotificationGroup.allCases))
        XCTAssertEqual(EventKind.prClosed.notificationGroup, .merges)
        XCTAssertEqual(EventKind.branchCreated.notificationGroup, .commits)
    }

    func testNotificationGroupsAndMasterSwitch() {
        var prefs = NotificationPreferences()
        let push = event("push", kind: .push)
        let review = event("review", kind: .reviewApproved)
        XCTAssertTrue(prefs.allows(push), "처음에는 모두 켜져 있다")

        prefs.groups.remove(.commits)
        XCTAssertFalse(prefs.allows(push))
        XCTAssertTrue(prefs.allows(review))

        prefs.isEnabled = false
        XCTAssertFalse(prefs.allows(review), "전체 끄기가 우선한다")
    }

    func testHiddenRepositoriesAndBots() {
        let display = DisplayPreferences(hiddenRepositories: ["acme/secret"], hidesBots: true)
        XCTAssertFalse(display.shows(event("a", kind: .push, repo: "acme/secret")))
        XCTAssertFalse(display.shows(event("b", kind: .comment, actor: "codex[bot]")))
        XCTAssertTrue(display.shows(event("c", kind: .comment, actor: "botman")), "이름에 bot이 들어가도 [bot]이 아니면 사람")
        XCTAssertTrue(DisplayPreferences().shows(event("d", kind: .comment, actor: "codex[bot]")), "기본은 봇도 보인다")
    }

    func testEventsToNotifyCombinesBoth() {
        var notifications = NotificationPreferences()
        notifications.groups = [.reviews, .comments]
        let display = DisplayPreferences(hiddenRepositories: ["acme/secret"], hidesBots: true)
        let events = [
            event("1", kind: .reviewApproved),
            event("2", kind: .push),
            event("3", kind: .comment, repo: "acme/secret"),
            event("4", kind: .comment, actor: "ci[bot]"),
            event("5", kind: .comment),
        ]
        XCTAssertEqual(eventsToNotify(events, notifications: notifications, display: display).map(\.id), ["1", "5"])
    }

    func testUnreadCountIgnoresHiddenAndMarkUnread() {
        var state = WatchState()
        state.history = [event("1", kind: .push), event("2", kind: .push, repo: "acme/secret"),
                         event("3", kind: .comment, unread: false)]
        let display = DisplayPreferences(hiddenRepositories: ["acme/secret"])
        XCTAssertEqual(state.unreadCount(visibleTo: display), 1)
        state.markUnread("3")
        XCTAssertEqual(state.unreadCount(visibleTo: display), 2)
    }

    func testPreferencesRoundTrip() throws {
        var prefs = NotificationPreferences()
        prefs.groups = [.merges]
        prefs.playsSound = false
        let restored = try JSONDecoder().decode(NotificationPreferences.self, from: JSONEncoder().encode(prefs))
        XCTAssertEqual(restored, prefs)
    }

    func testSemanticVersion() {
        XCTAssertTrue(SemanticVersion.isNewer("0.3.0", than: "0.2.0"))
        XCTAssertTrue(SemanticVersion.isNewer("0.10.0", than: "0.9.9"), "문자열이 아니라 숫자로 비교")
        XCTAssertTrue(SemanticVersion.isNewer("1.0", than: "0.9.9"))
        XCTAssertFalse(SemanticVersion.isNewer("0.2.0", than: "0.2.0"))
        XCTAssertFalse(SemanticVersion.isNewer("0.1.9", than: "0.2.0"))
        XCTAssertFalse(SemanticVersion.isNewer("0.0.0-stage", than: "0.2.0"))
    }
}
