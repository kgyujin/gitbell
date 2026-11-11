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
    /// 저장소(그리고 한 저장소 안의 PR 리뷰·push 커밋 제목)를 동시에 읽는 수. 너무 높으면 GitHub 2차 한도에 걸린다.
    public var maxConcurrentRepos = 4
    /// since를 이 단위(10분)로 내려 맞춘다. 1~2분마다 확인해도 'since=' 주소가 한동안 같아져서
    /// 조건부 요청(ETag)으로 304를 받을 수 있다(304는 API 한도에 세지 않는다). 더 읽는 앞부분은 본 항목으로 걸러진다.
    public var sinceGranularity: TimeInterval = 10 * 60
    /// 바뀐 신호(새 push, 알림함 소식)가 없는 저장소를 다시 읽는 간격. 신호가 있으면 바로 읽는다.
    /// 알림함에 오지 않는 활동(구독하지 않은 저장소의 댓글 등)은 이 간격 안에 잡힌다.
    public var quietRecheck: TimeInterval = 15 * 60
    /// API 한도가 이만큼 남지 않으면 미뤄도 되는 일(조용한 저장소 다시 읽기, push 커밋 제목)을 하지 않는다.
    public var lowBudget = 300

    public init() {}
}

public struct WatchState: Codable, Sendable {
    /// 2: 0.4.0에서 prAuthor가 생겨, 예전 기록을 다시 채우도록 올렸다.
    public static let currentVersion = 2

    public var version = WatchState.currentVersion
    public var me = ""
    public var lastChecked: Date?
    public var seen: [String: Date] = [:]
    public var history: [ActivityEvent] = []
    public var checkedRepos: [String] = []
    /// 지난 확인 때 읽지 못한 저장소와, 다음에 거기서부터 다시 읽을 시각.
    /// 일부 저장소가 실패해도 lastChecked는 앞으로 가므로, 이 값이 없으면 그 저장소의 그 사이 활동이 빠진다.
    /// 예전 버전이 저장한 상태에는 없는 값이라 Optional로 둔다(없으면 비어 있는 것으로 본다).
    public var retrySince: [String: Date]?
    /// 저장소마다 마지막으로 다 읽은 시각. 다음에 거기서부터 읽고, 바뀐 신호가 없으면 quietRecheck가 지날 때까지 읽지 않는다.
    /// 예전 버전이 저장한 상태에는 없는 값이라 Optional로 둔다.
    public var lastRead: [String: Date]?

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
    ///   includeOwn이어도 읽음으로 넣고 알리지 않는다(내가 한 일을 나에게 알릴 까닭이 없다).
    /// - 기록이 historyLimit를 넘으면 읽은 것부터, 오래된 것부터 버린다(안 읽은 항목이 조용히 사라지지 않게).
    public mutating func apply(_ events: [ActivityEvent], now: Date, includeOwn: Bool,
                               config: WatchConfig = WatchConfig()) -> [ActivityEvent] {
        let isFirstRun = lastChecked == nil
        var toNotify: [ActivityEvent] = []
        // 이미 기록에 있거나, 이름이 바뀐 저장소에서 같은 GitHub 항목(댓글·리뷰·활동 id)을 본 적 있으면 다시 넣지 않는다.
        let inHistory = Set(history.map(\.id))
        let seenGlobal = Set(seen.keys.compactMap(Self.globalKey))
        for var event in events {
            let alreadySeen = seen[event.id] != nil || inHistory.contains(event.id)
                || Self.globalKey(event.id).map(seenGlobal.contains) == true
            guard !alreadySeen else {
                // 이미 본 항목이라도 예전 기록에 없던 PR 작성자 정보는 채운다.
                if let author = event.prAuthor,
                   let index = history.firstIndex(where: { $0.id == event.id && $0.prAuthor == nil }) {
                    history[index].prAuthor = author
                }
                continue
            }
            seen[event.id] = event.time
            let isOwn = Self.isOwn(event, me: me)
            if !includeOwn, isOwn { continue }
            event.isUnread = !isFirstRun && !isOwn
            history.append(event)
            if event.isUnread { toNotify.append(event) }
        }
        // 시계가 잠깐 앞으로 뛰어도(며칠 뒤) 본 항목을 지우지 않게, 지난 확인 시각과 지금 중 이른 쪽을 기준으로 지운다.
        let reference = lastChecked.map { min($0, now) } ?? now
        let cutoff = reference.addingTimeInterval(-config.seenRetention)
        seen = seen.filter { $0.value >= cutoff }
        history.sort { $0.time > $1.time }
        trim(to: config.historyLimit)
        lastChecked = now
        // 기록 상한으로 바로 빠진 항목은 알리지 않는다(눌러도 목록에서 찾을 수 없는 알림이 되지 않게).
        let kept = Set(history.map(\.id))
        return toNotify.filter { kept.contains($0.id) }
    }

    /// 저장소 이름이 바뀌어도 같은 항목으로 알아볼 수 있는 GitHub 전역 id(댓글·리뷰·활동). PR 번호는 저장소마다 달라 넣지 않는다.
    static func globalKey(_ id: String) -> String? {
        guard let hash = id.firstIndex(of: "#") else { return nil }
        let suffix = String(id[id.index(after: hash)...])
        return ["ic:", "rc:", "review:", "act:"].contains(where: suffix.hasPrefix) ? suffix : nil
    }

    /// 내가 한 활동인지. PR 닫힘은 목록 API가 닫은 사람을 알려 주지 않는데, 내 PR이 닫힌 것은
    /// 대개 내가 닫은 것이라 내 활동으로 본다(머지는 다른 사람이 하는 일이 많아 그렇게 보지 않는다).
    public static func isOwn(_ event: ActivityEvent, me: String) -> Bool {
        guard !me.isEmpty else { return false }
        if event.actor == me { return true }
        return event.actor.isEmpty && event.kind == .prClosed && event.prAuthor == me
    }

    /// 기록을 limit개로 줄인다. 가장 오래된 읽은 항목부터 버리고, 그래도 넘치면 오래된 안 읽은 항목을 버린다.
    mutating func trim(to limit: Int) {
        guard history.count > limit else { return }
        var excess = history.count - limit
        var keep = Array(repeating: true, count: history.count)
        for index in history.indices.reversed() where excess > 0 && !history[index].isUnread {
            keep[index] = false
            excess -= 1
        }
        for index in history.indices.reversed() where excess > 0 && keep[index] {
            keep[index] = false
            excess -= 1
        }
        history = history.indices.filter { keep[$0] }.map { history[$0] }
    }

    /// id가 nil이면 모두 읽음으로 바꾼다.
    public mutating func markRead(_ id: String? = nil) {
        for index in history.indices where id == nil || history[index].id == id {
            history[index].isUnread = false
        }
    }

    /// 새로고침 결과에 지금 상태의 읽음 표시를 옮겨 온다.
    /// 새로고침이 도는 몇 초 동안 사용자가 읽음·안 읽음을 바꾸면, 결과가 그 표시를 덮어쓰지 않게 한다.
    public func adoptingReadMarks(from current: WatchState) -> WatchState {
        let marks = Dictionary(current.history.map { ($0.id, $0.isUnread) }, uniquingKeysWith: { first, _ in first })
        var merged = self
        for index in merged.history.indices {
            if let isUnread = marks[merged.history[index].id] { merged.history[index].isUnread = isUnread }
        }
        return merged
    }

    public mutating func update(_ event: ActivityEvent) {
        if let index = history.firstIndex(where: { $0.id == event.id }) { history[index] = event }
    }
}

public enum RepoSelector {
    /// 이번 확인에서 읽을 저장소를 고른다.
    /// - 바로 읽음: 마지막으로 읽은 뒤 push가 있었거나 알림함 소식이 온 저장소, 지난번에 실패한 저장소, 처음 보는 활동 저장소.
    /// - 조금 뒤 읽음: 최근 push가 있었지만(activeWindow) 신호가 없는 저장소는 quietRecheck마다 한 번.
    /// - 알림함을 읽을 수 없거나(세분화 토큰) API 한도가 넉넉하지 않으면 각각 조용한 저장소도 매번 읽거나, 아예 미룬다.
    public static func plan(repos: [GHRepo], notifications: [GHNotification]?, lastRead: [String: Date],
                            retry: Set<String>, since: Date, now: Date, lowBudget: Bool,
                            config: WatchConfig = WatchConfig()) -> [String] {
        let activeSince = now.addingTimeInterval(-config.activeWindow)
        var selected = retry
        for repo in repos where repo.archived != true {
            guard let pushed = repo.pushedAt, pushed >= activeSince else { continue }
            guard let read = lastRead[repo.fullName] else { selected.insert(repo.fullName); continue }
            let changed = pushed > read.addingTimeInterval(-config.overlap)
            let due = notifications == nil || now.timeIntervalSince(read) >= config.quietRecheck
            if changed || (due && !lowBudget) { selected.insert(repo.fullName) }
        }
        for thread in notifications ?? [] {
            let from = lastRead[thread.repository.fullName].map { $0.addingTimeInterval(-config.overlap) } ?? since
            if thread.updatedAt >= from { selected.insert(thread.repository.fullName) }
        }
        return selected.sorted()
    }

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
