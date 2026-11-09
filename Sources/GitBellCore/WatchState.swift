// 앱 상태(본 항목, 최근 기록, 마지막 확인 시각)와 상태를 바꾸는 순수 함수.
// 디스크에는 JSON으로 저장한다. version이 다르면 기록을 비우고 첫 실행처럼 알림 없이 다시 채운다.

import Foundation

/// 확인 주기와 범위에 관한 값. 저장소가 100개를 넘어도 API 한도(시간당 5,000회) 안에서 돌게 정했다.
public struct WatchConfig: Sendable {
    /// 이 기간 안에 push가 있었던 저장소는 매번 자세히 읽는다.
    public var activeWindow: TimeInterval = 3 * 24 * 3600
    /// push 순으로 받을 저장소 수. activeWindow 안의 저장소를 덮을 만큼.
    public var discoveryPageSize = 30
    /// 이전 확인 시각보다 조금 앞부터 다시 읽는다. API 반영 지연으로 경계에서 빠지는 항목을 막는다.
    public var overlap: TimeInterval = 10 * 60
    /// 처음 실행할 때 거슬러 읽는 기간. 이때는 알림을 보내지 않는다.
    public var firstRunLookback: TimeInterval = 24 * 3600
    /// 본 항목 id를 기억하는 기간. overlap보다 충분히 길어야 한다.
    public var seenRetention: TimeInterval = 3 * 24 * 3600
    public var historyLimit = 150
    /// 저장소를 동시에 읽는 수. 너무 높으면 GitHub 2차 한도에 걸린다.
    public var maxConcurrentRepos = 4

    public init() {}
}

public struct WatchState: Codable, Sendable {
    public static let currentVersion = 1

    public var version = WatchState.currentVersion
    public var me = ""
    public var lastChecked: Date?
    public var seen: [String: Date] = [:]
    public var history: [ActivityEvent] = []
    public var checkedRepos: [String] = []

    public init() {}

    public var unreadCount: Int { history.filter(\.isUnread).count }

    /// 형식이 다르면 로그인 이름만 남기고 비운다.
    public func migrated() -> WatchState {
        if version == WatchState.currentVersion { return self }
        var fresh = WatchState()
        fresh.me = me
        return fresh
    }

    /// 새 항목을 기록에 넣고, 알림을 보낼 항목을 돌려준다.
    /// - 처음 실행(lastChecked 없음)이면 읽음으로만 넣고 알리지 않는다.
    /// - 내 활동은 includeOwn이 아니면 기록에도 넣지 않고 본 항목으로만 남긴다.
    public mutating func apply(_ events: [ActivityEvent], now: Date, includeOwn: Bool,
                               config: WatchConfig = WatchConfig()) -> [ActivityEvent] {
        let isFirstRun = lastChecked == nil
        var toNotify: [ActivityEvent] = []
        for var event in events where seen[event.id] == nil {
            seen[event.id] = event.time
            if !includeOwn, !me.isEmpty, event.actor == me { continue }
            event.isUnread = !isFirstRun
            history.append(event)
            if !isFirstRun { toNotify.append(event) }
        }
        let cutoff = now.addingTimeInterval(-config.seenRetention)
        seen = seen.filter { $0.value >= cutoff }
        history.sort { $0.time > $1.time }
        if history.count > config.historyLimit { history.removeLast(history.count - config.historyLimit) }
        lastChecked = now
        return toNotify
    }

    /// id가 nil이면 모두 읽음으로 바꾼다.
    public mutating func markRead(_ id: String? = nil) {
        for index in history.indices where id == nil || history[index].id == id {
            history[index].isUnread = false
        }
    }

    public mutating func update(_ event: ActivityEvent) {
        if let index = history.firstIndex(where: { $0.id == event.id }) { history[index] = event }
    }
}

public enum RepoSelector {
    /// 자세히 읽을 저장소를 고른다. 최근 push가 있었거나 알림함에 since 이후 소식이 온 저장소.
    /// 알림함은 push 없이 댓글·리뷰만 달린 저장소를 잡는다.
    public static func select(repos: [GHRepo], notifications: [GHNotification], since: Date, now: Date,
                              config: WatchConfig = WatchConfig()) -> [String] {
        let activeSince = now.addingTimeInterval(-config.activeWindow)
        var selected = Set(repos.filter { repo in
            repo.archived != true && (repo.pushedAt.map { $0 >= activeSince } ?? false)
        }.map(\.fullName))
        for thread in notifications where thread.updatedAt >= since {
            selected.insert(thread.repository.fullName)
        }
        return selected.sorted()
    }
}
