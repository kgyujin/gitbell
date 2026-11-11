// 댓글·커밋 본문에서 목록과 알림에 보일 한 줄을 뽑는다(마크다운 기호는 빼고 글만 남긴다).
// 봇 댓글은 HTML 주석(<!-- -->)이나 태그(<details>)로 시작하고, 답글은 인용('>')으로 시작하는 일이 많다.
// 리뷰 제안(```suggestion)·코드 블록은 줄 안의 코드라 건너뛰고, 이미지만 있는 댓글은 빈 줄로 본다
// (빈 줄이면 화면은 종류 이름으로 대신한다).

import Foundation

public enum TextPreview {
    private static let htmlComment = try! NSRegularExpression(pattern: "<!--.*?-->", options: [.dotMatchesLineSeparators])
    private static let htmlTag = try! NSRegularExpression(pattern: "</?[a-zA-Z][^>]*>")
    private static let image = try! NSRegularExpression(pattern: "!\\[[^\\]]*\\]\\([^)]*\\)")
    private static let link = try! NSRegularExpression(pattern: "\\[([^\\]]+)\\]\\([^)]*\\)")
    private static let emphasis = try! NSRegularExpression(pattern: "(\\*\\*|__|~~|`)")

    public static func firstLine(_ text: String?) -> String {
        guard var cleaned = text, !cleaned.isEmpty else { return "" }
        cleaned = replace(htmlComment, in: cleaned)
        cleaned = replace(htmlTag, in: cleaned)
        var inFence = false
        var outside: [String] = []
        for line in cleaned.components(separatedBy: .newlines) {
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                inFence.toggle()
                continue
            }
            if !inFence { outside.append(line) }
        }
        let lines = outside
            .map(inline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        let meaningful = lines.filter { !$0.hasPrefix(">") }
        guard let line = (meaningful.isEmpty ? lines : meaningful).first else { return "" }
        return line.drop(while: { $0 == "#" }).trimmingCharacters(in: .whitespaces)
    }

    /// 줄 안의 마크다운: 이미지는 빼고, 링크는 글자만 남기고, 굵게·기울임·코드 표시를 지운다.
    private static func inline(_ line: String) -> String {
        var text = replace(image, in: line)
        let range = NSRange(text.startIndex..., in: text)
        text = link.stringByReplacingMatches(in: text, range: range, withTemplate: "$1")
        let plain = NSRange(text.startIndex..., in: text)
        return emphasis.stringByReplacingMatches(in: text, range: plain, withTemplate: "")
    }

    private static func replace(_ regex: NSRegularExpression, in text: String) -> String {
        let range = NSRange(text.startIndex..., in: text)
        return regex.stringByReplacingMatches(in: text, range: range, withTemplate: " ")
    }
}
