// 한 번의 확인(새로고침)을 맡는다: 움직인 저장소 고르기 → 저장소별로 읽기 → 항목 만들기 → 상태 갱신.
//
// 저장소가 많으면(100개 이상) 매번 전부 읽을 수 없어 '움직인 저장소'만 읽는다(RepoSelector 참고).
// 한 번에 API를 대략 (2 + 움직인 저장소 수 × 4~5)회 쓴다.

import Foundation

public struct RefreshResult: Sendable {
    public var state: WatchState
    /// 알림을 보낼 새 항목.
    public var newEvents: [ActivityEvent]
    /// 읽지 못한 저장소 이름. 나머지 저장소로는 정상 갱신한다.
    public var failedRepos: [String]
}

public struct ActivityPoller: Sendable {
    let api: GitHubAPI
    let config: WatchConfig

    public init(api: GitHubAPI, config: WatchConfig = WatchConfig()) {
        self.api = api
        self.config = config
    }

    public func refresh(_ current: WatchState, now: Date, includeOwn: Bool) async throws -> RefreshResult {
        var state = current.migrated()
        if state.me.isEmpty {
            state.me = try await api.get("user", as: GHUser.self).login
        }
        let since = state.lastChecked.map { $0.addingTimeInterval(-config.overlap) }
            ?? now.addingTimeInterval(-config.firstRunLookback)

        async let repos = api.get(
            "user/repos?sort=pushed&direction=desc&per_page=\(config.discoveryPageSize)"
                + "&affiliation=owner,collaborator,organization_member",
            as: [GHRepo].self)
        async let notifications = api.get(
            "notifications?all=true&since=\(Self.iso(since))&per_page=50", as: [GHNotification].self)
        let selected = RepoSelector.select(repos: try await repos, notifications: try await notifications,
                                           since: since, now: now, config: config)

        let (events, failed) = await collect(selected, since: since)
        state.checkedRepos = selected
        var newEvents = state.apply(events, now: now, includeOwn: includeOwn, config: config)

        // push의 커밋 제목은 기록에 새로 들어온 push에만 한 번 읽어 API 호출을 줄인다.
        for event in state.history where event.kind.isPush && !event.detailResolved {
            let resolved = await resolvePush(event)
            state.update(resolved)
            if let index = newEvents.firstIndex(where: { $0.id == resolved.id }) {
                newEvents[index] = resolved
            }
        }
        return RefreshResult(state: state, newEvents: newEvents, failedRepos: failed)
    }

    func collect(_ repos: [String], since: Date) async -> ([ActivityEvent], [String]) {
        var events: [ActivityEvent] = []
        var failed: [String] = []
        // 한꺼번에 너무 많이 보내지 않도록 maxConcurrentRepos개씩 나눠 읽는다.
        for start in stride(from: 0, to: repos.count, by: config.maxConcurrentRepos) {
            let chunk = repos[start..<min(start + config.maxConcurrentRepos, repos.count)]
            await withTaskGroup(of: (String, [ActivityEvent]?).self) { group in
                for repo in chunk {
                    group.addTask {
                        guard let snapshot = try? await snapshot(repo: repo, since: since) else { return (repo, nil) }
                        return (repo, EventBuilder.build(snapshot, repo: repo, since: since))
                    }
                }
                for await (repo, built) in group {
                    if let built { events.append(contentsOf: built) } else { failed.append(repo) }
                }
            }
        }
        return (events.sorted { $0.time < $1.time }, failed.sorted())
    }

    func snapshot(repo: String, since: Date) async throws -> RepoSnapshot {
        let sinceISO = Self.iso(since)
        async let pulls = api.get("repos/\(repo)/pulls?state=all&sort=updated&direction=desc&per_page=30",
                                  as: [GHPull].self)
        async let reviewComments = api.get(
            "repos/\(repo)/pulls/comments?since=\(sinceISO)&sort=created&direction=desc&per_page=100",
            as: [GHReviewComment].self)
        async let issueComments = api.get(
            "repos/\(repo)/issues/comments?since=\(sinceISO)&sort=created&direction=desc&per_page=100",
            as: [GHIssueComment].self)
        async let activity = api.get("repos/\(repo)/activity?per_page=50", as: [GHActivity].self)

        var snapshot = RepoSnapshot(pulls: try await pulls, reviewComments: try await reviewComments,
                                    issueComments: try await issueComments, activity: try await activity)
        for pull in snapshot.pulls where (pull.updatedAt ?? .distantPast) >= since {
            snapshot.reviewsByPR[pull.number] = try await api.get(
                "repos/\(repo)/pulls/\(pull.number)/reviews?per_page=100", as: [GHReview].self)
        }
        return snapshot
    }

    /// push에 커밋 수와 마지막 커밋 제목을 채운다. 실패해도 항목은 그대로 보인다.
    func resolvePush(_ event: ActivityEvent) async -> ActivityEvent {
        var resolved = event
        resolved.detailResolved = true
        guard let after = event.after, !after.isEmpty else { return resolved }
        if let before = event.before, !before.isEmpty, before != EventBuilder.zeroSHA,
           let compare = try? await api.get("repos/\(event.repo)/compare/\(before)...\(after)", as: GHCompare.self),
           let last = compare.commits.last {
            resolved.commitCount = compare.totalCommits ?? compare.commits.count
            resolved.title = TextPreview.firstLine(last.commit.message)
            return resolved
        }
        // 강제 push 뒤에는 before 커밋이 사라져 compare가 실패할 수 있어 마지막 커밋만 읽는다.
        if let commit = try? await api.get("repos/\(event.repo)/commits/\(after)", as: GHCommit.self) {
            resolved.title = TextPreview.firstLine(commit.commit.message)
        }
        return resolved
    }

    static func iso(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
    }
}
