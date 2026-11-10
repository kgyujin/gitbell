// 목록 필터·검색·정렬. 화면과 떨어진 순수 로직이라 테스트로 확인한다.
//
// 필터는 모두 AND로 묶인다: 종류(PR·리뷰·커밋) × 저장소 × 안 읽음만 × 검색어.
// 정렬은 묶는 방식까지 정한다: 최신순(날짜별), 저장소별, 안 읽은 것 먼저.

import Foundation

public enum SortMode: String, CaseIterable, Sendable {
    /// 날짜별로 묶고 최신이 위.
    case newest
    /// 저장소별로 묶고, 최근 활동이 있는 저장소가 위.
    case byRepository
    /// 안 읽은 묶음과 읽은 묶음으로 나누고 각각 최신이 위.
    case unreadFirst
}

public struct ActivityQuery: Equatable, Sendable {
    public var category: EventCategory?
    public var repo: String?
    public var unreadOnly = false
    /// 내가 올린 PR에서 다른 사람이 한 활동만.
    public var mineOnly = false
    public var search = ""
    public var sort: SortMode = .newest
    /// 내 로그인 이름. mineOnly 판단에만 쓰며 저장하지 않는다.
    public var me = ""
    /// 화면 언어의 종류 이름(예: .prMerged → "머지됨"). 검색에 쓰며 저장하지 않는다.
    public var kindLabels: [EventKind: String] = [:]

    public init(category: EventCategory? = nil, repo: String? = nil, unreadOnly: Bool = false,
                mineOnly: Bool = false, search: String = "", sort: SortMode = .newest) {
        self.category = category
        self.repo = repo
        self.unreadOnly = unreadOnly
        self.mineOnly = mineOnly
        self.search = search
        self.sort = sort
    }

    /// 기본값과 다른 필터가 걸려 있는지(정렬은 필터가 아니라 세지 않는다).
    public var isFiltering: Bool {
        category != nil || repo != nil || unreadOnly || mineOnly || !trimmedSearch.isEmpty
    }

    var trimmedSearch: String { search.trimmingCharacters(in: .whitespacesAndNewlines) }

    public func filter(_ events: [ActivityEvent]) -> [ActivityEvent] {
        let terms = trimmedSearch.lowercased().split(separator: " ").map(String.init)
        return events.filter { event in
            if let category, event.kind.category != category { return false }
            if let repo, event.repo != repo { return false }
            if unreadOnly, !event.isUnread { return false }
            if mineOnly, !event.isOnMyPullRequest(me: me) { return false }
            if !terms.isEmpty {
                let haystack = Self.searchText(event, kindLabels: kindLabels)
                // 낱말마다 어딘가에 들어 있으면 된다. "web merge"처럼 저장소와 내용을 섞어 찾을 수 있다.
                if !terms.allSatisfy(haystack.contains) { return false }
            }
            return true
        }
    }

    /// 검색 대상: 본문, 저장소(전체 이름), 사람, 브랜치, '#번호', 종류 이름(영문 키와 화면 언어 이름).
    /// 화면 언어 이름이 있어야 '머지', '승인'처럼 한국어로도 찾을 수 있다.
    static func searchText(_ event: ActivityEvent, kindLabels: [EventKind: String] = [:]) -> String {
        [event.title, event.repo, event.actor, event.branch ?? "",
         event.number.map { "#\($0)" } ?? "", event.kind.rawValue, kindLabels[event.kind] ?? ""]
            .joined(separator: " ")
            .lowercased()
    }

    /// 필터를 거친 항목을 정렬 방식에 맞게 묶는다. 묶음 안은 항상 최신이 위다.
    public func sections(_ events: [ActivityEvent], calendar: Calendar = .current) -> [ActivitySection] {
        let items = filter(events).sorted { $0.time > $1.time }
        switch sort {
        case .newest:
            return group(items) { .day(calendar.startOfDay(for: $0.time)) }
        case .byRepository:
            // items가 최신순이라 처음 나온 순서가 곧 '최근 활동이 있는 저장소 순'이다.
            return group(items) { .repository($0.repo) }
        case .unreadFirst:
            let unread = items.filter(\.isUnread)
            let read = items.filter { !$0.isUnread }
            return [ActivitySection(key: .unread, events: unread), ActivitySection(key: .read, events: read)]
                .filter { !$0.events.isEmpty }
        }
    }

    private func group(_ items: [ActivityEvent], by key: (ActivityEvent) -> ActivitySection.Key) -> [ActivitySection] {
        var sections: [ActivitySection] = []
        var indexByKey: [ActivitySection.Key: Int] = [:]
        for event in items {
            let sectionKey = key(event)
            if let index = indexByKey[sectionKey] {
                sections[index].events.append(event)
            } else {
                indexByKey[sectionKey] = sections.count
                sections.append(ActivitySection(key: sectionKey, events: [event]))
            }
        }
        return sections
    }
}

public struct ActivitySection: Identifiable, Equatable, Sendable {
    public enum Key: Hashable, Sendable {
        case day(Date)
        case repository(String)
        case unread
        case read
    }

    public var key: Key
    public var events: [ActivityEvent]

    public var id: Key { key }
    public var unreadCount: Int { events.filter(\.isUnread).count }
}

/// 저장소 고르기 메뉴에 보일 항목. 기록에 나온 저장소만, 최근 활동 순.
public struct RepositorySummary: Identifiable, Equatable, Sendable {
    public var repo: String
    public var count: Int
    public var unreadCount: Int
    public var latest: Date

    public var id: String { repo }
    public var name: String { repo.split(separator: "/").last.map(String.init) ?? repo }

    public static func from(_ events: [ActivityEvent]) -> [RepositorySummary] {
        var byRepo: [String: RepositorySummary] = [:]
        for event in events {
            var summary = byRepo[event.repo] ?? RepositorySummary(repo: event.repo, count: 0, unreadCount: 0,
                                                                   latest: event.time)
            summary.count += 1
            if event.isUnread { summary.unreadCount += 1 }
            summary.latest = max(summary.latest, event.time)
            byRepo[event.repo] = summary
        }
        return byRepo.values.sorted { $0.latest > $1.latest }
    }
}

extension ActivityEvent {
    /// 내가 올린 PR에서 다른 사람이 한 활동인지.
    public func isOnMyPullRequest(me: String) -> Bool {
        !me.isEmpty && prAuthor == me && actor != me
    }
}

extension WatchState {
    /// 한 저장소(또는 전체)의 항목을 읽음으로 바꾼다.
    public mutating func markRead(repo: String) {
        for index in history.indices where history[index].repo == repo {
            history[index].isUnread = false
        }
    }
}
