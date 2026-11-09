// 알림과 목록 표시에 관한 사용자 설정, 그리고 그 설정으로 항목을 거르는 순수 함수.
//
// - 알림: 전체 켜기·끄기, 소리, 종류 묶음별 켜기·끄기
// - 숨긴 저장소: 목록·안 읽은 수·알림에서 모두 뺀다(기록은 남겨 다시 보이게 할 수 있다)
// - 봇 활동 숨기기: 이름이 '[bot]'으로 끝나는 계정의 활동을 목록·알림에서 뺀다

import Foundation

/// 알림을 켜고 끄는 단위. 종류(EventKind)를 사람이 이해하기 쉬운 묶음으로 나눈다.
public enum NotificationGroup: String, CaseIterable, Codable, Sendable {
    case newPullRequests
    case merges
    case reviews
    case comments
    case commits
}

extension EventKind {
    public var notificationGroup: NotificationGroup {
        switch self {
        case .prOpened: return .newPullRequests
        case .prMerged, .prClosed: return .merges
        case .reviewApproved, .reviewChangesRequested, .reviewCommented: return .reviews
        case .comment: return .comments
        case .push, .forcePush, .branchCreated: return .commits
        }
    }
}

public struct NotificationPreferences: Codable, Equatable, Sendable {
    public var isEnabled = true
    public var playsSound = true
    /// 알림을 받을 묶음. 처음에는 모두 켠다.
    public var groups = Set(NotificationGroup.allCases)

    public init() {}

    public func allows(_ event: ActivityEvent) -> Bool {
        isEnabled && groups.contains(event.kind.notificationGroup)
    }
}

public struct DisplayPreferences: Codable, Equatable, Sendable {
    public var hiddenRepositories: Set<String> = []
    public var hidesBots = false

    public init(hiddenRepositories: Set<String> = [], hidesBots: Bool = false) {
        self.hiddenRepositories = hiddenRepositories
        self.hidesBots = hidesBots
    }

    /// 목록·안 읽은 수·알림에 넣을지.
    public func shows(_ event: ActivityEvent) -> Bool {
        if hiddenRepositories.contains(event.repo) { return false }
        if hidesBots, EventBuilder.isBot(event.actor) { return false }
        return true
    }

    public func visible(_ events: [ActivityEvent]) -> [ActivityEvent] {
        events.filter(shows)
    }
}

/// 새 항목 중 실제로 알림을 띄울 것만 고른다.
public func eventsToNotify(_ events: [ActivityEvent], notifications: NotificationPreferences,
                           display: DisplayPreferences) -> [ActivityEvent] {
    events.filter { display.shows($0) && notifications.allows($0) }
}

extension WatchState {
    /// 한 항목을 다시 안 읽음으로 바꾼다.
    public mutating func markUnread(_ id: String) {
        for index in history.indices where history[index].id == id {
            history[index].isUnread = true
        }
    }

    /// 화면에 보이는(숨기지 않은) 항목 중 안 읽은 수.
    public func unreadCount(visibleTo display: DisplayPreferences) -> Int {
        history.filter { $0.isUnread && display.shows($0) }.count
    }
}

/// '0.10.2'처럼 점으로 나뉜 버전을 비교한다. 숫자가 아닌 부분은 0으로 본다.
public enum SemanticVersion {
    public static func isNewer(_ candidate: String, than current: String) -> Bool {
        let lhs = parts(candidate)
        let rhs = parts(current)
        for index in 0..<max(lhs.count, rhs.count) {
            let a = index < lhs.count ? lhs[index] : 0
            let b = index < rhs.count ? rhs[index] : 0
            if a != b { return a > b }
        }
        return false
    }

    static func parts(_ version: String) -> [Int] {
        version.split(separator: "-").first.map { $0.split(separator: ".").map { Int($0) ?? 0 } } ?? []
    }
}
