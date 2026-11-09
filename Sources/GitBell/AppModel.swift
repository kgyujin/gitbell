// 화면이 보는 앱 상태. 주기적으로 GitHub을 확인하고, 상태를 디스크에 저장하고, 알림을 보낸다.
// 상태 파일: ~/Library/Application Support/GitBell/state.json (지워도 처음부터 다시 채울 뿐이다)

import AppKit
import Foundation
import GitBellCore
import ServiceManagement

@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    enum Problem: Equatable {
        case noToken
        case unauthorized
        case network(String)
        case partial([String])

        /// 목록을 아예 못 채우는 문제인지(메뉴 막대 아이콘을 바꾼다).
        var isBlocking: Bool {
            switch self {
            case .noToken, .unauthorized: return true
            case .network, .partial: return false
            }
        }
    }

    @Published private(set) var state = WatchState()
    @Published private(set) var isRefreshing = false
    @Published private(set) var problem: Problem?
    @Published private(set) var tokenSource: TokenSource?
    /// 목록 필터·검색·정렬. 검색어를 뺀 나머지는 다음에 열 때도 그대로 쓰도록 저장한다.
    @Published var query = ActivityQuery() {
        didSet { saveQuery() }
    }
    @Published var showingSettings = false
    @Published var showingSearch = false

    @Published var refreshMinutes: Int {
        didSet { defaults.set(refreshMinutes, forKey: Keys.refreshMinutes); restartLoop() }
    }
    @Published var includeOwnActivity: Bool {
        didSet { defaults.set(includeOwnActivity, forKey: Keys.includeOwn) }
    }
    @Published var notificationsEnabled: Bool {
        didSet { defaults.set(notificationsEnabled, forKey: Keys.notifications) }
    }

    private let defaults = UserDefaults.standard
    private var loopTask: Task<Void, Never>?

    private enum Keys {
        static let refreshMinutes = "refreshMinutes"
        static let includeOwn = "includeOwnActivity"
        static let notifications = "notificationsEnabled"
        static let category = "filterCategory"
        static let repo = "filterRepository"
        static let unreadOnly = "filterUnreadOnly"
        static let sort = "sortMode"
    }

    private init() {
        let storedMinutes = defaults.integer(forKey: Keys.refreshMinutes)
        refreshMinutes = storedMinutes > 0 ? storedMinutes : 2
        includeOwnActivity = defaults.bool(forKey: Keys.includeOwn)
        notificationsEnabled = defaults.object(forKey: Keys.notifications) as? Bool ?? true
        query = ActivityQuery(
            category: defaults.string(forKey: Keys.category).flatMap(EventCategory.init(rawValue:)),
            repo: defaults.string(forKey: Keys.repo),
            unreadOnly: defaults.bool(forKey: Keys.unreadOnly),
            sort: defaults.string(forKey: Keys.sort).flatMap(SortMode.init(rawValue:)) ?? .newest)
    }

    private func saveQuery() {
        // 스냅숏은 같은 앱 설정을 쓰므로, 그림용으로 바꾼 필터가 사용자 설정에 남지 않게 한다.
        guard !SnapshotMode.isOn else { return }
        defaults.set(query.category?.rawValue, forKey: Keys.category)
        defaults.set(query.repo, forKey: Keys.repo)
        defaults.set(query.unreadOnly, forKey: Keys.unreadOnly)
        defaults.set(query.sort.rawValue, forKey: Keys.sort)
    }

    // MARK: 스냅숏용 (GitHub에 요청하지 않는다)

    func loadDemo() {
        state = DemoData.state()
        tokenSource = .githubCLI
    }

    func loadSavedStateOnly() {
        state = Self.loadState()
        tokenSource = .githubCLI
    }

    func simulateNoToken() {
        state = WatchState()
        tokenSource = nil
        problem = .noToken
    }

    // MARK: 확인 주기

    func start() {
        state = Self.loadState()
        restartLoop()
    }

    private func restartLoop() {
        loopTask?.cancel()
        let minutes = refreshMinutes
        loopTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(nanoseconds: UInt64(minutes) * 60 * 1_000_000_000)
            }
        }
    }

    func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }

        // gh 실행은 잠깐 막힐 수 있어 메인 스레드 밖에서 토큰을 찾는다.
        guard let token = await Task.detached(operation: { TokenStore.resolve() }).value else {
            tokenSource = nil
            problem = .noToken
            return
        }
        tokenSource = token.source
        let poller = ActivityPoller(api: URLSessionGitHubAPI(token: token.value))
        do {
            let result = try await poller.refresh(state, now: Date(), includeOwn: includeOwnActivity)
            state = result.state
            saveState()
            problem = result.failedRepos.isEmpty ? nil : .partial(result.failedRepos)
            if notificationsEnabled { Notifier.shared.post(result.newEvents) }
        } catch GitHubError.unauthorized {
            problem = .unauthorized
        } catch let GitHubError.http(status, message) {
            problem = .network("HTTP \(status) \(message)")
        } catch let GitHubError.network(message) {
            problem = .network(message)
        } catch {
            problem = .network(error.localizedDescription)
        }
    }

    // MARK: 항목

    var sections: [ActivitySection] { query.sections(state.history) }

    var repositories: [RepositorySummary] { RepositorySummary.from(state.history) }

    var visibleCount: Int { query.filter(state.history).count }

    /// 검색어와 필터를 지운다. 정렬 방식은 사용자가 고른 대로 둔다.
    func resetFilters() {
        query = ActivityQuery(sort: query.sort)
        showingSearch = false
    }

    func markRead(repo: String) {
        state.markRead(repo: repo)
        saveState()
    }

    func open(_ event: ActivityEvent) {
        NSWorkspace.shared.open(event.url)
        markRead(event.id)
    }

    func markRead(_ id: String? = nil) {
        state.markRead(id)
        saveState()
    }

    // MARK: 계정

    func saveToken(_ token: String) {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        TokenStore.save(trimmed)
        // 다른 계정일 수 있으니 기록을 비우고 첫 실행처럼 다시 채운다.
        state = WatchState()
        saveState()
        Task { await refresh() }
    }

    func removeSavedToken() {
        TokenStore.deleteKeychain()
        state = WatchState()
        saveState()
        Task { await refresh() }
    }

    // MARK: 로그인 시 실행

    var launchAtLogin: Bool {
        get { SMAppService.mainApp.status == .enabled }
        set {
            objectWillChange.send()
            if newValue { try? SMAppService.mainApp.register() } else { try? SMAppService.mainApp.unregister() }
        }
    }

    // MARK: 저장

    private static var stateURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("GitBell", isDirectory: true).appendingPathComponent("state.json")
    }

    private static func loadState() -> WatchState {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let data = try? Data(contentsOf: stateURL),
              let saved = try? decoder.decode(WatchState.self, from: data) else { return WatchState() }
        return saved.migrated()
    }

    private func saveState() {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(state) else { return }
        let url = Self.stateURL
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
    }
}
