// 화면 문구. 키는 영어 원문이고, 한국어는 Resources/ko.lproj/Localizable.strings에 있다.
// macOS 언어 설정을 따른다(한국어가 아니면 영어).

import Foundation
import GitBellCore
import SwiftUI

enum L10n {
    static func string(_ key: String) -> String {
        NSLocalizedString(key, comment: "")
    }

    /// 종류 이름. 목록에서 색 글씨로 보인다.
    static func kindLabel(_ event: ActivityEvent) -> String {
        switch event.kind {
        case .prOpened: return string("Opened")
        case .prMerged: return string("Merged")
        case .prClosed: return string("Closed")
        case .reviewApproved: return string("Approved")
        case .reviewChangesRequested: return string("Changes requested")
        case .reviewCommented: return string("Reviewed")
        case .comment: return string("Commented")
        case .push:
            if let count = event.commitCount, count > 0 {
                return String(format: string("Pushed %lld commits"), count)
            }
            return string("Pushed")
        case .forcePush: return string("Force-pushed")
        case .branchCreated: return string("New branch")
        }
    }

    /// '#33', '이슈 #12', '⎇ feat/x'처럼 무엇에 일어났는지.
    static func target(_ event: ActivityEvent) -> String {
        if let branch = event.branch, event.kind.isPush { return "⎇ \(branch)" }
        guard let number = event.number else { return "" }
        return event.isIssue ? String(format: string("Issue #%lld"), number) : "#\(number)"
    }

    /// 알림 부제목: '머지됨 · #33 · octocat'
    static func headline(_ event: ActivityEvent) -> String {
        [kindLabel(event), target(event), displayName(event.actor)].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// 봇 계정의 '[bot]' 꼬리를 뗀다. 봇인지는 화면에서 작은 표시로 따로 보여 준다.
    static func displayName(_ login: String) -> String {
        login.hasSuffix("[bot]") ? String(login.dropLast(5)) : login
    }

    /// 본문 한 줄. 비어 있으면 종류 이름으로 대신한다.
    static func title(_ event: ActivityEvent) -> String {
        event.title.isEmpty ? kindLabel(event) : event.title
    }

    static func filterLabel(_ filter: AppModel.Filter) -> String {
        switch filter {
        case .all: return string("All")
        case .pullRequests: return string("PRs")
        case .reviews: return string("Reviews")
        case .commits: return string("Commits")
        }
    }

    static func relative(_ date: Date) -> String {
        if Date().timeIntervalSince(date) < 60 { return string("now") }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    static func dayTitle(_ date: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return string("Today") }
        if calendar.isDateInYesterday(date) { return string("Yesterday") }
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("MMMMdEEE")
        return formatter.string(from: date)
    }

    static func clock(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }
}

extension EventKind {
    var symbol: String {
        switch self {
        case .prOpened: return "arrow.triangle.pull"
        case .prMerged: return "arrow.triangle.merge"
        case .prClosed: return "xmark"
        case .reviewApproved: return "checkmark"
        case .reviewChangesRequested: return "exclamationmark"
        case .reviewCommented: return "eye"
        case .comment: return "text.bubble"
        case .push: return "arrow.up"
        case .forcePush: return "exclamationmark.arrow.circlepath"
        case .branchCreated: return "arrow.branch"
        }
    }

    var tint: Color {
        switch self {
        case .prOpened, .reviewApproved: return .green
        case .prMerged: return .purple
        case .prClosed: return .red
        case .reviewChangesRequested, .forcePush: return .orange
        case .reviewCommented, .comment: return .blue
        case .push: return .teal
        case .branchCreated: return .gray
        }
    }
}
