// 읽음 처리 편의 기능의 검증(Windows판 test/unit/reading.test.js와 같은 내용).
// - 항목을 열면 같은 PR·이슈의 다른 안 읽은 항목도 읽음
// - 여러 항목을 한 번에 읽음으로 바꾸고 되돌리기

import XCTest
@testable import GitBellCore

final class ReadingTests: XCTestCase {
    private func event(_ id: String, repo: String = "acme/web", number: Int? = nil,
                       kind: EventKind = .comment) -> ActivityEvent {
        ActivityEvent(id: id, repo: repo, kind: kind, time: Date(timeIntervalSince1970: 1_000), actor: "amy",
                      number: number, title: id, url: URL(string: "https://github.com/\(repo)")!, isUnread: true)
    }

    private func unread(_ state: WatchState) -> [String] { state.history.filter(\.isUnread).map(\.id).sorted() }

    func testOpeningMarksTheWholeThreadRead() {
        var state = WatchState()
        state.history = [event("review", number: 7, kind: .reviewApproved), event("comment", number: 7),
                         event("other-pr", number: 8), event("same-number-other-repo", repo: "acme/api", number: 7),
                         event("push", kind: .push)]
        state.markThreadRead("comment")
        XCTAssertEqual(unread(state), ["other-pr", "push", "same-number-other-repo"])
    }

    func testOpeningAnItemWithoutNumberMarksOnlyIt() {
        var state = WatchState()
        state.history = [event("push-1", kind: .push), event("push-2", kind: .push)]
        state.markThreadRead("push-1")
        XCTAssertEqual(unread(state), ["push-2"])
    }

    func testBulkReadCanBeUndone() {
        var state = WatchState()
        state.history = [event("a"), event("b"), event("c")]
        state.markRead(ids: ["a", "b"])
        XCTAssertEqual(unread(state), ["c"])
        state.markUnread(ids: ["a", "b"])
        XCTAssertEqual(unread(state), ["a", "b", "c"])
    }

    func testUndoMessageUsesSingularInEnglish() {
        XCTAssertEqual(PluralKeys.key(for: "Marked %lld items as read", arguments: [1], isTranslated: false),
                       "Marked %lld item as read")
        XCTAssertEqual(PluralKeys.key(for: "Marked %lld items as read", arguments: [2], isTranslated: false),
                       "Marked %lld items as read")
    }
}
