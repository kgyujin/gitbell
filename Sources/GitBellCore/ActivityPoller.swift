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
    /// 알림함을 읽지 못해 최근 push가 있는 저장소만 확인했는지(세분화 토큰 등).
    public var notificationsUnavailable = false
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
        let since = Self.since(lastChecked: state.lastChecked, now: now, config: config)
        let retry = state.retrySince ?? [:]
        // 지난번에 읽지 못한 저장소는 그때부터 다시 읽는다(하루보다 오래된 것은 읽지 않는다).
        let oldest = Self.rounded(now.addingTimeInterval(-config.firstRunLookback), config: config)
        // 저장소마다 마지막으로 읽은 때부터 읽는다(조용한 저장소는 매번 읽지 않으므로 전체 since보다 앞일 수 있다).
        let lastRead = state.lastRead ?? [:]
        let overlap = config.overlap
        let roundedConfig = config
        let sinceFor: @Sendable (String) -> Date = { repo in
            if let pending = retry[repo] { return max(oldest, min(since, pending)) }
            if let read = lastRead[repo] {
                return max(oldest, min(since, Self.rounded(read.addingTimeInterval(-overlap), config: roundedConfig)))
            }
            return since
        }

        async let repos = api.get(
            "user/repos?sort=pushed&direction=desc&per_page=\(config.discoveryPageSize)"
                + "&affiliation=owner,collaborator,organization_member",
            as: [GHRepo].self)
        // 알림함은 저장소를 고르는 보조 자료다. 세분화 토큰(fine-grained)처럼 알림함을 읽을 수 없는 토큰이면
        // 실패해도 멈추지 않고 최근 push가 있는 저장소만으로 계속한다. 토큰 자체가 틀린 401만 그대로 올린다.
        let notifications: [GHNotification]?
        do {
            // 알림함은 1시간 단위로 맞춘 since로 읽는다. 같은 주소가 1시간 동안 반복돼 304(한도 미사용)를 받는다.
            // 넓게 읽은 앞부분은 저장소별 마지막 읽은 시각과 견줘 거른다(RepoSelector.plan).
            notifications = try await api.get(
                "notifications?all=true&since=\(Self.iso(Self.hourly(since)))&per_page=50", as: [GHNotification].self)
        } catch GitHubError.unauthorized {
            throw GitHubError.unauthorized
        } catch let GitHubError.rateLimited(resetAt) {
            // 한도 초과는 토큰 종류 문제가 아니라 잠시 기다릴 일이라 그대로 알린다.
            throw GitHubError.rateLimited(resetAt: resetAt)
        } catch let error as GitHubError where Self.isTemporary(error) {
            // 잠깐의 네트워크·서버 오류는 '알림함을 못 읽는 토큰'이 아니다. 이번 확인을 통째로 실패로 두어
            // lastChecked를 그대로 둔다(알림함으로만 잡히는 조용한 저장소의 그 사이 댓글을 잃지 않게).
            throw error
        } catch {
            notifications = nil
        }
        let lowBudget = (await api.remainingRequests()).map { $0 < config.lowBudget } ?? false
        let selected = RepoSelector.plan(repos: try await repos, notifications: notifications, lastRead: lastRead,
                                         retry: Set(retry.keys), since: since, now: now, lowBudget: lowBudget,
                                         config: config)

        let (events, failed, retryable, rateLimit) = await collect(selected, sinceFor: sinceFor)
        // 저장소를 읽다가 한도에 걸렸으면 이번 결과를 버린다. 마지막 확인 시각을 그대로 두어야
        // 한도가 풀린 뒤 이 구간을 다시 읽는다(앞으로 밀면 그 사이 활동이 빠진다).
        if let resetAt = rateLimit { throw GitHubError.rateLimited(resetAt: resetAt) }
        state.checkedRepos = selected
        // 잠시 뒤 될 실패(네트워크·서버 오류)만 기억한다. 지워졌거나 권한이 없어진 저장소(404 등)는
        // 다시 읽어도 실패하므로 기억하지 않는다(기억하면 매번 읽고 '읽지 못함'을 계속 보인다).
        // 처음 실행에서 실패한 저장소는 기억하지 않는다. 기억하면 다음 확인에서 그 저장소의 하루치를
        // '처음 실행이 아닌' 새 항목으로 읽어, 설치하자마자 오래된 알림이 한꺼번에 왔다.
        let isFirstRun = state.lastChecked == nil
        let nextRetry = isFirstRun ? [:] : Dictionary(uniqueKeysWithValues: retryable.map { ($0, sinceFor($0)) })
        state.retrySince = nextRetry.isEmpty ? nil : nextRetry
        var nextRead = lastRead.filter { now.timeIntervalSince($0.value) < config.activeWindow }
        for repo in selected where !failed.contains(repo) { nextRead[repo] = now }
        state.lastRead = nextRead.isEmpty ? nil : nextRead
        var newEvents = state.apply(events, now: now, includeOwn: includeOwn, config: config)

        // push의 커밋 제목은 기록에 새로 들어온 push에만 한 번 읽어 API 호출을 줄인다.
        // 몇 개씩 동시에 읽고, 한도에 걸리면 남은 것은 다음 확인으로 미룬다(더 보내도 실패하고 2차 한도 위험만 커진다).
        // API 한도가 넉넉하지 않으면 커밋 제목은 다음으로 미룬다(목록에는 제목 없이 먼저 보인다).
        let budgetLow = (await api.remainingRequests()).map { $0 < config.lowBudget } ?? false
        let pending = budgetLow ? [] : state.history.filter { $0.kind.isPush && !$0.detailResolved }
        for start in stride(from: 0, to: pending.count, by: config.maxConcurrentRepos) {
            let chunk = pending[start..<min(start + config.maxConcurrentRepos, pending.count)]
            let results = await withTaskGroup(of: PushDetail.self) { group in
                for event in chunk { group.addTask { await resolvePushDetail(event) } }
                return await group.reduce(into: [PushDetail]()) { $0.append($1) }
            }
            for result in results {
                state.update(result.event)
                if let index = newEvents.firstIndex(where: { $0.id == result.event.id }) {
                    newEvents[index] = result.event
                }
            }
            if results.contains(where: \.hitRateLimit) { break }
        }
        return RefreshResult(state: state, newEvents: newEvents, failedRepos: failed,
                             notificationsUnavailable: notifications == nil)
    }

    /// 이번 확인에서 읽기 시작할 시각. 지난 확인 시각보다 overlap만큼 앞이고, 하루(firstRunLookback)보다
    /// 오래되지 않게 묶는다. 며칠 꺼 두었다 켜도 며칠치 댓글·리뷰를 한꺼번에 읽고 알리지 않게 하려는 것이다.
    static func since(lastChecked: Date?, now: Date, config: WatchConfig) -> Date {
        let oldest = now.addingTimeInterval(-config.firstRunLookback)
        let wanted = lastChecked.map { $0.addingTimeInterval(-config.overlap) } ?? oldest
        return rounded(max(wanted, oldest), config: config)
    }

    /// 1시간 단위로 내려 맞춘다(알림함 since용).
    static func hourly(_ date: Date) -> Date {
        Date(timeIntervalSince1970: (date.timeIntervalSince1970 / 3600).rounded(.down) * 3600)
    }

    /// sinceGranularity 단위로 내려 맞춘다(같은 since 주소를 다시 써서 304를 받으려고).
    static func rounded(_ date: Date, config: WatchConfig) -> Date {
        let step = config.sinceGranularity
        guard step > 0 else { return date }
        return Date(timeIntervalSince1970: (date.timeIntervalSince1970 / step).rounded(.down) * step)
    }

    /// 저장소들을 읽는다. 실패한 저장소 이름과, 한도에 걸렸다면 그 다시 쓸 수 있는 시각도 돌려준다.
    /// sinceFor: 저장소마다 읽기 시작할 시각(지난번에 실패한 저장소는 더 앞부터 읽는다).
    /// 돌려주는 값: 항목, 실패한 저장소, 그중 잠시 뒤 다시 읽을 만한 저장소, 한도에 걸렸으면 다시 쓸 수 있는 시각.
    func collect(_ repos: [String], sinceFor: @escaping @Sendable (String) -> Date) async
        -> ([ActivityEvent], [String], [String], Date??) {
        var events: [ActivityEvent] = []
        var failed: [String] = []
        var retryable: [String] = []
        var rateLimit: Date?? = nil
        // 한꺼번에 너무 많이 보내지 않도록 maxConcurrentRepos개씩 나눠 읽는다.
        for start in stride(from: 0, to: repos.count, by: config.maxConcurrentRepos) {
            let chunk = repos[start..<min(start + config.maxConcurrentRepos, repos.count)]
            await withTaskGroup(of: (String, Result<[ActivityEvent], Error>).self) { group in
                for repo in chunk {
                    group.addTask {
                        let since = sinceFor(repo)
                        do {
                            let snapshot = try await snapshot(repo: repo, since: since)
                            return (repo, .success(EventBuilder.build(snapshot, repo: repo, since: since)))
                        } catch {
                            return (repo, .failure(error))
                        }
                    }
                }
                for await (repo, result) in group {
                    switch result {
                    case let .success(built): events.append(contentsOf: built)
                    case let .failure(GitHubError.rateLimited(resetAt)): rateLimit = .some(resetAt); failed.append(repo)
                    case let .failure(error as GitHubError) where Self.isTemporary(error):
                        failed.append(repo)
                        retryable.append(repo)
                    case .failure: failed.append(repo)
                    }
                }
            }
            // 한도에 걸렸으면 남은 저장소는 읽지 않는다(더 보내도 실패한다).
            if rateLimit != nil { break }
        }
        return (events.sorted { $0.time < $1.time }, failed.sorted(), retryable.sorted(), rateLimit)
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
        // 바뀐 PR의 리뷰를 몇 개씩 동시에 읽는다(한 PR씩 차례로 읽으면 처음 실행 때 저장소마다 수십 번을 기다린다).
        let updated = snapshot.pulls.filter { ($0.updatedAt ?? .distantPast) >= since }.map(\.number)
        for start in stride(from: 0, to: updated.count, by: config.maxConcurrentRepos) {
            let chunk = updated[start..<min(start + config.maxConcurrentRepos, updated.count)]
            try await withThrowingTaskGroup(of: (Int, [GHReview]).self) { group in
                for number in chunk {
                    group.addTask {
                        (number, try await api.get("repos/\(repo)/pulls/\(number)/reviews?per_page=100",
                                                   as: [GHReview].self))
                    }
                }
                for try await (number, reviews) in group { snapshot.reviewsByPR[number] = reviews }
            }
        }
        return snapshot
    }

    /// push 하나의 커밋 정보를 읽은 결과. hitRateLimit이면 남은 push는 이번에 읽지 않는다.
    struct PushDetail: Sendable {
        var event: ActivityEvent
        var hitRateLimit = false
    }

    /// push에 커밋 수와 마지막 커밋 제목을 채운다. 실패해도 항목은 그대로 보인다.
    func resolvePush(_ event: ActivityEvent) async -> ActivityEvent {
        await resolvePushDetail(event).event
    }

    func resolvePushDetail(_ event: ActivityEvent) async -> PushDetail {
        var resolved = event
        resolved.detailResolved = true
        guard let after = event.after, !after.isEmpty else { return PushDetail(event: resolved) }
        // 한도·네트워크처럼 잠시 뒤 될 수 있는 실패는 '다 읽음'으로 두지 않아 다음 확인 때 다시 읽는다.
        func postponed(_ error: GitHubError) -> PushDetail {
            var isRateLimit = false
            if case .rateLimited = error { isRateLimit = true }
            // 몇 번 미뤄도 안 되면 그만 읽는다(제목 없이 보인다). 한도 초과는 횟수에 세지 않는다(풀리면 다시 읽는다).
            let attempts = (event.detailAttempts ?? 0) + (isRateLimit ? 0 : 1)
            resolved.detailAttempts = attempts
            resolved.detailResolved = attempts >= Self.maxDetailAttempts
            return PushDetail(event: resolved, hitRateLimit: isRateLimit)
        }
        if let before = event.before, !before.isEmpty, before != EventBuilder.zeroSHA {
            do {
                let compare = try await api.get("repos/\(event.repo)/compare/\(before)...\(after)", as: GHCompare.self)
                if let last = compare.commits.last {
                    resolved.commitCount = compare.totalCommits ?? compare.commits.count
                    resolved.title = TextPreview.firstLine(last.commit.message)
                    return PushDetail(event: resolved)
                }
            } catch let error as GitHubError where Self.isTemporary(error) {
                // 잠시 뒤 될 실패면 마지막 커밋도 지금은 읽지 않는다(같은 이유로 실패하고 한도만 쓴다).
                return postponed(error)
            } catch {
                // 강제 push 뒤에는 before 커밋이 사라져 compare가 실패할 수 있다. 아래에서 마지막 커밋만 읽는다.
            }
        }
        do {
            let commit = try await api.get("repos/\(event.repo)/commits/\(after)", as: GHCommit.self)
            resolved.title = TextPreview.firstLine(commit.commit.message)
        } catch let error as GitHubError where Self.isTemporary(error) {
            return postponed(error)
        } catch {
            // 커밋이 사라진 경우(404 등)는 다시 읽어도 안 되므로 그대로 둔다.
        }
        return PushDetail(event: resolved)
    }

    /// push 커밋 제목을 잠시 뒤 될 실패로 미루는 최대 횟수.
    static let maxDetailAttempts = 3

    static func isTemporary(_ error: GitHubError) -> Bool {
        switch error {
        case .rateLimited, .network: return true
        case let .http(status, _): return status >= 500
        case .unauthorized: return false
        }
    }

    static func iso(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
    }
}
