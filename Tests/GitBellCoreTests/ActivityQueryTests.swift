// 목록 필터·검색·정렬(ActivityQuery) 검증.

import XCTest
@testable import GitBellCore

final class ActivityQueryTests: XCTestCase {
    private let base = ISO8601DateFormatter().date(from: "2026-11-09T12:00:00Z")!
    private var calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()

    private func event(_ id: String, repo: String, kind: EventKind, hoursAgo: Double, unread: Bool = false,
                       actor: String = "amy", title: String = "", number: Int? = nil,
                       branch: String? = nil) -> ActivityEvent {
        ActivityEvent(id: id, repo: repo, kind: kind, time: base.addingTimeInterval(-hoursAgo * 3600),
                      actor: actor, number: number, branch: branch, title: title,
                      url: URL(string: "https://github.com/\(repo)")!, isUnread: unread)
    }

    private lazy var events: [ActivityEvent] = [
        event("1", repo: "acme/web", kind: .prMerged, hoursAgo: 1, unread: true, title: "Add login page", number: 12),
        event("2", repo: "acme/api", kind: .comment, hoursAgo: 2, actor: "bob", title: "Looks good", number: 7),
        event("3", repo: "acme/web", kind: .push, hoursAgo: 3, unread: true, title: "fix typo", branch: "feat/search"),
        event("4", repo: "acme/api", kind: .reviewApproved, hoursAgo: 30, title: "LGTM", number: 8),
        event("5", repo: "you/dotfiles", kind: .prOpened, hoursAgo: 50, title: "zsh tweaks", number: 1),
    ]

    func testFiltersCombineWithAnd() {
        XCTAssertEqual(ActivityQuery(category: .reviews).filter(events).map(\.id), ["2", "4"])
        XCTAssertEqual(ActivityQuery(repo: "acme/web").filter(events).map(\.id), ["1", "3"])
        XCTAssertEqual(ActivityQuery(repo: "acme/web", unreadOnly: true).filter(events).map(\.id), ["1", "3"])
        XCTAssertEqual(ActivityQuery(category: .commits, repo: "acme/web").filter(events).map(\.id), ["3"])
        XCTAssertEqual(ActivityQuery(category: .pullRequests, repo: "acme/api").filter(events), [])
    }

    func testSearchMatchesEveryWordAcrossFields() {
        XCTAssertEqual(ActivityQuery(search: "LOGIN").filter(events).map(\.id), ["1"], "대소문자 무시")
        XCTAssertEqual(ActivityQuery(search: "bob").filter(events).map(\.id), ["2"], "사람 이름")
        XCTAssertEqual(ActivityQuery(search: "feat/search").filter(events).map(\.id), ["3"], "브랜치")
        XCTAssertEqual(ActivityQuery(search: "#8").filter(events).map(\.id), ["4"], "PR 번호")
        XCTAssertEqual(ActivityQuery(search: "web merged").filter(events).map(\.id), ["1"], "낱말마다 AND")
        XCTAssertEqual(ActivityQuery(search: "   ").filter(events).count, events.count, "공백만은 필터 아님")
    }

    func testIsFiltering() {
        XCTAssertFalse(ActivityQuery().isFiltering)
        XCTAssertFalse(ActivityQuery(sort: .byRepository).isFiltering, "정렬은 필터가 아니다")
        XCTAssertTrue(ActivityQuery(unreadOnly: true).isFiltering)
        XCTAssertTrue(ActivityQuery(search: "x").isFiltering)
    }

    func testNewestGroupsByDay() {
        let sections = ActivityQuery(sort: .newest).sections(events, calendar: calendar)
        XCTAssertEqual(sections.map { $0.events.map(\.id) }, [["1", "2", "3"], ["4"], ["5"]])
        XCTAssertEqual(sections.first?.key, .day(calendar.startOfDay(for: base)))
    }

    func testByRepositoryOrdersRepositoriesByLatestActivity() {
        let sections = ActivityQuery(sort: .byRepository).sections(events, calendar: calendar)
        XCTAssertEqual(sections.map(\.key), [.repository("acme/web"), .repository("acme/api"), .repository("you/dotfiles")])
        XCTAssertEqual(sections[0].events.map(\.id), ["1", "3"])
        XCTAssertEqual(sections[0].unreadCount, 2)
        XCTAssertEqual(sections[1].events.map(\.id), ["2", "4"])
    }

    func testUnreadFirstSplitsAndDropsEmptySections() {
        let sections = ActivityQuery(sort: .unreadFirst).sections(events, calendar: calendar)
        XCTAssertEqual(sections.map(\.key), [.unread, .read])
        XCTAssertEqual(sections[0].events.map(\.id), ["1", "3"])
        XCTAssertEqual(sections[1].events.map(\.id), ["2", "4", "5"])

        let onlyRead = ActivityQuery(repo: "acme/api", sort: .unreadFirst).sections(events, calendar: calendar)
        XCTAssertEqual(onlyRead.map(\.key), [.read], "빈 묶음은 보이지 않는다")
    }

    func testRepositorySummaries() {
        let summaries = RepositorySummary.from(events)
        XCTAssertEqual(summaries.map(\.repo), ["acme/web", "acme/api", "you/dotfiles"])
        XCTAssertEqual(summaries[0].count, 2)
        XCTAssertEqual(summaries[0].unreadCount, 2)
        XCTAssertEqual(summaries[0].name, "web")
    }

    func testMarkReadForOneRepository() {
        var state = WatchState()
        state.history = events
        state.markRead(repo: "acme/web")
        XCTAssertEqual(state.unreadCount, 0)
        state.history[1].isUnread = true
        state.markRead(repo: "acme/web")
        XCTAssertEqual(state.unreadCount, 1, "다른 저장소는 그대로")
    }
}
