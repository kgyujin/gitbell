// 영어 문구의 단수형 고르기. "Pushed 1 commits" 대신 "Pushed 1 commit"을 쓰게 한다.
// 한국어는 단수·복수 구분이 없어 원래 키의 번역을 그대로 쓴다. Windows판 l10n.js의 SINGULAR와 같은 표다.

import Foundation

public enum PluralKeys {
    public static let singular: [String: String] = [
        "Pushed %lld commits": "Pushed %lld commit",
        "%lld items": "%lld item",
        "Checked %@ · %lld repositories": "Checked %@ · %lld repository",
        "Couldn't read %lld repositories:": "Couldn't read %lld repository:",
        "%lld new activities": "%lld new activity",
        "Marked %lld items as read": "Marked %lld item as read",
    ]

    /// 쓸 키를 고른다. 번역이 있으면(한국어) 원래 키, 영어에서 %lld 자리 값이 1이면 단수형 키.
    public static func key(for key: String, arguments: [Any], isTranslated: Bool) -> String {
        guard !isTranslated, let one = singular[key],
              let index = placeholders(in: key).firstIndex(of: "%lld"), index < arguments.count,
              let count = arguments[index] as? Int, count == 1 else { return key }
        return one
    }

    /// 키 안의 자리표시자(%lld, %@)를 나온 차례대로.
    static func placeholders(in key: String) -> [String] {
        var found: [String] = []
        var rest = Substring(key)
        while let range = rest.range(of: "%") {
            let after = rest[range.upperBound...]
            if after.hasPrefix("lld") { found.append("%lld") } else if after.hasPrefix("@") { found.append("%@") }
            rest = after
        }
        return found
    }
}
