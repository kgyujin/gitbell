// 댓글·커밋 본문에서 목록에 보일 한 줄을 뽑는다.
// 봇 댓글은 HTML 주석(<!-- -->)이나 태그(<details>)로 시작하고, 답글은 인용('>')으로 시작하는 일이 많다.

import Foundation

public enum TextPreview {
    private static let htmlComment = try! NSRegularExpression(pattern: "<!--.*?-->", options: [.dotMatchesLineSeparators])
    private static let htmlTag = try! NSRegularExpression(pattern: "</?[a-zA-Z][^>]*>")

    public static func firstLine(_ text: String?) -> String {
        guard var cleaned = text, !cleaned.isEmpty else { return "" }
        cleaned = replace(htmlComment, in: cleaned)
        cleaned = replace(htmlTag, in: cleaned)
        let lines = cleaned
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        let meaningful = lines.filter { !$0.hasPrefix(">") }
        guard let line = (meaningful.isEmpty ? lines : meaningful).first else { return "" }
        return line.drop(while: { $0 == "#" }).trimmingCharacters(in: .whitespaces)
    }

    private static func replace(_ regex: NSRegularExpression, in text: String) -> String {
        let range = NSRange(text.startIndex..., in: text)
        return regex.stringByReplacingMatches(in: text, range: range, withTemplate: " ")
    }
}
