// 0.5.0 점검에서 고친 것들의 검증(Windows판 test/unit/polish.test.js와 같은 내용).
// - 영어 문구의 단수형("Pushed 1 commit", "1 item")
// - 화면 언어의 종류 이름으로 검색('머지', '승인')

import XCTest
@testable import GitBellCore

final class PolishTests: XCTestCase {
    func testSingularKeyOnlyForEnglishCountOfOne() {
        XCTAssertEqual(PluralKeys.key(for: "Pushed %lld commits", arguments: [1], isTranslated: false), "Pushed %lld commit")
        XCTAssertEqual(PluralKeys.key(for: "Pushed %lld commits", arguments: [2], isTranslated: false), "Pushed %lld commits")
        XCTAssertEqual(PluralKeys.key(for: "%lld items", arguments: [0], isTranslated: false), "%lld items", "0은 복수형")
        XCTAssertEqual(PluralKeys.key(for: "Checked %@ · %lld repositories", arguments: ["9:00 AM", 1], isTranslated: false),
                       "Checked %@ · %lld repository", "%@가 앞에 있어도 %lld 자리의 값으로 고른다")
        XCTAssertEqual(PluralKeys.key(for: "%lld items", arguments: [1], isTranslated: true), "%lld items",
                       "번역이 있으면(한국어) 원래 키")
        XCTAssertEqual(PluralKeys.key(for: "%lld min", arguments: [1], isTranslated: false), "%lld min", "표에 없는 키는 그대로")
    }

    func testSearchMatchesLocalizedKindNames() {
        func event(_ id: String, _ kind: EventKind) -> ActivityEvent {
            ActivityEvent(id: id, repo: "acme/web", kind: kind, time: Date(), actor: "amy", title: "t\(id)",
                          url: URL(string: "https://github.com/acme/web")!)
        }
        let events = [event("1", .prMerged), event("2", .reviewApproved), event("3", .comment)]
        func find(_ search: String, labels: [EventKind: String]) -> [String] {
            var query = ActivityQuery(search: search)
            query.kindLabels = labels
            return query.filter(events).map(\.id)
        }
        let korean: [EventKind: String] = [.prMerged: "머지됨", .reviewApproved: "승인", .comment: "댓글"]
        XCTAssertEqual(find("머지", labels: korean), ["1"])
        XCTAssertEqual(find("승인", labels: korean), ["2"])
        XCTAssertEqual(find("댓글", labels: korean), ["3"])
        XCTAssertEqual(find("approved", labels: korean), ["2"], "영문 키로도 여전히 찾는다")
        XCTAssertEqual(find("머지", labels: [:]), [], "이름표가 없으면 영문 키만 본다")
    }
}
