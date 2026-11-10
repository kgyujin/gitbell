// 화면이 보는 앱 상태. 주기적으로 GitHub을 확인하고, 상태를 디스크에 저장하고, 알림을 보낸다.
// 상태 파일: ~/Library/Application Support/GitBell/state.json (지워도 처음부터 다시 채울 뿐이다)
// 설정: UserDefaults(io.github.kgyujin.gitbell). 스냅숏 모드에서는 설정을 쓰지 않는다.

import AppKit
import Foundation
import GitBellCore
import ServiceManagement
import UserNotifications

@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    enum Problem: Equatable {
        case noToken
        case unauthorized
        case network(String)
        case partial([String])
        /// 알림함을 읽을 수 없는 토큰이라 최근 push가 있는 저장소만 확인한다.
        case limited
        /// GitHub API 한도에 걸렸다. 다시 쓸 수 있는 시각(알 수 있을 때).
        case rateLimited(Date?)

        /// 목록을 아예 못 채우는 문제인지(메뉴 막대 아이콘을 바꾼다).
        var isBlocking: Bool {
            switch self {
            case .noToken, .unauthorized: return true
            case .network, .partial, .limited, .rateLimited: return false
            }
        }
    }

    enum NotificationAuthorization {
        case unknown, allowed, denied, notAsked
    }

    @Published private(set) var state = WatchState()
    @Published private(set) var isRefreshing = false
    @Published private(set) var problem: Problem?
    @Published private(set) var tokenSource: TokenSource?
    @Published private(set) var notificationAuthorization: NotificationAuthorization = .unknown
    /// npm에 이 앱보다 새 버전이 있으면 그 버전.
    @Published private(set) var availableUpdate: String?
    /// 키체인에 토큰을 저장하지 못했는지. 토큰 입력칸 아래에 알린다.
    @Published private(set) var tokenSaveFailed = false

    /// 목록 필터·검색·정렬. 검색어를 뺀 나머지는 다음에 열 때도 그대로 쓰도록 저장한다.
    @Published var query = ActivityQuery() { didSet { saveQuery() } }
    @Published var showingSettings = false
    @Published var showingSearch = false

    @Published var refreshMinutes: Int {
        didSet { save(refreshMinutes, Keys.refreshMinutes); restartLoop() }
    }
    @Published var includeOwnActivity: Bool {
        didSet { save(includeOwnActivity, Keys.includeOwn) }
    }
    @Published var notificationPrefs: NotificationPreferences {
        didSet { saveJSON(notificationPrefs, Keys.notificationPrefs) }
    }
    @Published var display: DisplayPreferences {
        didSet { saveJSON(display, Keys.display) }
    }
    @Published var showsCountInMenuBar: Bool {
        didSet { save(showsCountInMenuBar, Keys.showsCount) }
    }

    private let defaults = UserDefaults.standard
    private var loopTask: Task<Void, Never>?
    /// 확인 중에 다시 확인해 달라는 요청이 왔는지(토큰 저장 직후 등).
    private var refreshAgain = false
    /// 계정(토큰)의 세대. 확인 도중 토큰이 바뀌면 그 결과를 버린다.
    private var accountGeneration = 0

    private enum Keys {
        static let refreshMinutes = "refreshMinutes"
        static let includeOwn = "includeOwnActivity"
        static let legacyNotifications = "notificationsEnabled"
        static let notificationPrefs = "notificationPreferences"
        static let display = "displayPreferences"
        static let showsCount = "showsCountInMenuBar"
        static let category = "filterCategory"
        static let repo = "filterRepository"
        static let unreadOnly = "filterUnreadOnly"
        static let mineOnly = "filterMineOnly"
        static let sort = "sortMode"
    }

    private init() {
        let storedMinutes = defaults.integer(forKey: Keys.refreshMinutes)
        refreshMinutes = storedMinutes > 0 ? storedMinutes : 2
        includeOwnActivity = defaults.bool(forKey: Keys.includeOwn)
        showsCountInMenuBar = defaults.object(forKey: Keys.showsCount) as? Bool ?? true
        display = Self.loadJSON(DisplayPreferences.self, Keys.display) ?? DisplayPreferences()
        var prefs = Self.loadJSON(NotificationPreferences.self, Keys.notificationPrefs) ?? NotificationPreferences()
        // 0.2.0까지의 켜기·끄기 하나짜리 설정을 이어받는다.
        if defaults.object(forKey: Keys.notificationPrefs) == nil,
           let legacy = defaults.object(forKey: Keys.legacyNotifications) as? Bool {
            prefs.isEnabled = legacy
        }
        notificationPrefs = prefs
        query = ActivityQuery(
            category: defaults.string(forKey: Keys.category).flatMap(EventCategory.init(rawValue:)),
            repo: defaults.string(forKey: Keys.repo),
            unreadOnly: defaults.bool(forKey: Keys.unreadOnly),
            mineOnly: defaults.bool(forKey: Keys.mineOnly),
            sort: defaults.string(forKey: Keys.sort).flatMap(SortMode.init(rawValue:)) ?? .newest)
    }

    // MARK: 스냅숏용 (GitHub에 요청하지 않는다)

    func loadDemo() {
        state = DemoData.state()
        tokenSource = .githubCLI
        notificationAuthorization = .allowed
        display = DisplayPreferences()
        notificationPrefs = NotificationPreferences()
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

    func simulateUpdate(_ version: String) { availableUpdate = version }

    // MARK: 확인 주기

    func start() {
        state = Self.loadState()
        // 잠자기에서 깨면 다음 주기를 기다리지 않고 바로 확인한다(네트워크가 붙을 시간을 조금 준다).
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil,
                                                          queue: .main) { _ in
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 5 * 1_000_000_000)
                await AppModel.shared.refresh()
            }
        }
        restartLoop()
        refreshNotificationAuthorization()
        Task { await checkForUpdate() }
    }

    private func restartLoop() {
        guard !SnapshotMode.isOn else { return }
        loopTask?.cancel()
        let minutes = refreshMinutes
        loopTask = Task { [weak self] in
            var checks = 0
            while !Task.isCancelled {
                await self?.refresh()
                checks += 1
                // 새 버전 확인은 하루에 몇 번이면 충분하다(12시간마다).
                if checks % max(1, 720 / minutes) == 0 { await self?.checkForUpdate() }
                try? await Task.sleep(nanoseconds: UInt64(minutes) * 60 * 1_000_000_000)
            }
        }
    }

    func refresh() async {
        guard !isRefreshing else {
            // 토큰을 바꾼 직후처럼 꼭 다시 확인해야 할 때는 지금 확인이 끝난 뒤 한 번 더 한다.
            // (예전에는 그냥 건너뛰어, 새 토큰이 다음 주기(최대 15분)까지 확인되지 않았다.)
            refreshAgain = true
            return
        }
        isRefreshing = true
        defer { isRefreshing = false }
        repeat {
            refreshAgain = false
            await refreshOnce()
        } while refreshAgain
    }

    private func refreshOnce() async {
        let account = accountGeneration
        // 사용자가 시스템 설정에서 알림을 켜고 끌 수 있어 확인할 때마다 권한도 다시 읽는다.
        refreshNotificationAuthorization()

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
            // 확인하는 동안 토큰이 바뀌었으면 예전 계정의 결과라 버린다(바로 다시 확인한다).
            guard account == accountGeneration else { return }
            // 새로고침이 도는 동안 사용자가 바꾼 읽음 표시를 지킨다.
            state = result.state.adoptingReadMarks(from: state)
            saveState()
            if !result.failedRepos.isEmpty {
                problem = .partial(result.failedRepos)
            } else {
                problem = result.notificationsUnavailable ? .limited : nil
            }
            let toNotify = eventsToNotify(result.newEvents, notifications: notificationPrefs, display: display,
                                          me: state.me)
            Notifier.shared.post(toNotify, playsSound: notificationPrefs.playsSound)
        } catch where account != accountGeneration {
            // 예전 계정으로 한 확인의 오류는 보이지 않는다.
        } catch GitHubError.unauthorized {
            problem = .unauthorized
        } catch let GitHubError.rateLimited(resetAt) {
            problem = .rateLimited(resetAt)
        } catch let GitHubError.http(status, message) {
            problem = .network("HTTP \(status) \(message)")
        } catch let GitHubError.network(message) {
            problem = .network(message)
        } catch {
            problem = .network(error.localizedDescription)
        }
    }

    /// 계정을 아직 연결하지 않아 연결 안내를 보여야 하는지.
    var showsOnboarding: Bool {
        problem == .noToken || (problem == .unauthorized && state.history.isEmpty)
    }

    // MARK: 목록

    /// 숨긴 저장소·봇을 뺀 항목.
    private var visibleHistory: [ActivityEvent] { display.visible(state.history) }

    var unreadCount: Int { state.unreadCount(visibleTo: display) }

    /// 저장한 필터에 내 로그인 이름을 붙인 것('내 PR' 판단에 필요).
    private var effectiveQuery: ActivityQuery {
        var current = query
        current.me = state.me
        current.kindLabels = Self.kindLabels
        return current
    }

    var sections: [ActivitySection] { effectiveQuery.sections(visibleHistory) }

    var repositories: [RepositorySummary] { RepositorySummary.from(visibleHistory) }

    var visibleCount: Int { effectiveQuery.filter(visibleHistory).count }

    /// 지금 보이는(필터를 거친) 항목 중 안 읽은 수. '모두 읽음' 버튼에 쓴다.
    var visibleUnreadCount: Int { effectiveQuery.filter(visibleHistory).filter(\.isUnread).count }

    /// 검색어와 필터를 지운다. 정렬 방식은 사용자가 고른 대로 둔다.
    func resetFilters() {
        query = ActivityQuery(sort: query.sort)
        showingSearch = false
    }

    func open(_ event: ActivityEvent) {
        Self.openHTTPS(event.url)
        markRead(event.id)
    }

    func markRead(_ id: String? = nil) {
        if id == nil {
            // '모두 읽음'은 지금 화면에 보이는 항목에만 적용한다(필터·숨긴 저장소 반영).
            for event in effectiveQuery.filter(visibleHistory) where event.isUnread { state.markRead(event.id) }
        } else {
            state.markRead(id)
        }
        saveState()
    }

    func markRead(repo: String) {
        state.markRead(repo: repo)
        saveState()
    }

    func markUnread(_ id: String) {
        state.markUnread(id)
        saveState()
    }

    /// 검색용 화면 언어 종류 이름. 언어는 실행 중에 바뀌지 않아 한 번만 만든다.
    private static let kindLabels: [EventKind: String] = Dictionary(uniqueKeysWithValues: EventKind.allCases.map { kind in
        (kind, L10n.kindLabel(ActivityEvent(id: "", repo: "", kind: kind, time: Date(), actor: "", title: "",
                                            url: URL(string: "https://github.com")!)))
    })

    /// GitHub 자료에서 온 주소는 https만 연다(Windows판과 같은 규칙).
    nonisolated static func openHTTPS(_ url: URL) {
        guard url.scheme?.lowercased() == "https" else { return }
        NSWorkspace.shared.open(url)
    }

    func copyLink(_ event: ActivityEvent) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(event.url.absoluteString, forType: .string)
    }

    func hideRepository(_ repo: String) {
        display.hiddenRepositories.insert(repo)
        if query.repo == repo { query.repo = nil }
    }

    func showRepository(_ repo: String) {
        display.hiddenRepositories.remove(repo)
    }

    // MARK: 알림

    func refreshNotificationAuthorization() {
        guard Bundle.main.bundleIdentifier != nil, !SnapshotMode.isOn else { return }
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let status: NotificationAuthorization
            switch settings.authorizationStatus {
            case .authorized, .provisional: status = .allowed
            case .denied: status = .denied
            case .notDetermined: status = .notAsked
            default: status = .unknown
            }
            Task { @MainActor in self.notificationAuthorization = status }
        }
    }

    func requestNotificationPermission() {
        Notifier.shared.requestAuthorization { [weak self] in
            Task { @MainActor in self?.refreshNotificationAuthorization() }
        }
    }

    func openNotificationSettings() {
        let id = Bundle.main.bundleIdentifier ?? "io.github.kgyujin.gitbell"
        let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(id)")!
        NSWorkspace.shared.open(url)
    }

    func sendTestNotification() {
        Notifier.shared.postTest(playsSound: notificationPrefs.playsSound)
    }

    func setGroup(_ group: NotificationGroup, enabled: Bool) {
        if enabled { notificationPrefs.groups.insert(group) } else { notificationPrefs.groups.remove(group) }
    }

    // MARK: 새 버전

    func checkForUpdate() async {
        guard !SnapshotMode.isOn,
              let current = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
              let url = URL(string: "https://registry.npmjs.org/gitbell/latest") else { return }
        var request = URLRequest(url: url, timeoutInterval: 10)
        request.setValue("GitBell", forHTTPHeaderField: "User-Agent")
        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let latest = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["version"] as? String
        else { return }
        availableUpdate = SemanticVersion.isNewer(latest, than: current) ? latest : nil
    }

    func copyUpdateCommand() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString("npx gitbell@latest", forType: .string)
    }

    // MARK: 계정

    func saveToken(_ token: String) {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        // 키체인 저장이 실패하면 기록을 지우지 않고 화면에 알린다.
        tokenSaveFailed = !TokenStore.save(trimmed)
        guard !tokenSaveFailed else { return }
        // 다른 계정일 수 있으니 기록을 비우고 첫 실행처럼 다시 채운다.
        accountGeneration += 1
        state = WatchState()
        saveState()
        Task { await refresh() }
    }

    func removeSavedToken() {
        TokenStore.deleteKeychain()
        accountGeneration += 1
        state = WatchState()
        saveState()
        Task { await refresh() }
    }

    // MARK: 로그인 시 실행

    /// 자동 실행을 켰는데 macOS가 아직 허용하지 않았거나 켜지 못했는지. 설정 화면에서 안내한다.
    @Published private(set) var launchAtLoginNeedsAttention = false

    var launchAtLogin: Bool {
        get { SMAppService.mainApp.status == .enabled }
        set {
            objectWillChange.send()
            // 예전에는 실패를 버려서, 스위치가 꺼진 채 아무 안내도 없었다.
            do {
                if newValue { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            } catch {
                // 아래에서 상태로 판단한다.
            }
            launchAtLoginNeedsAttention = newValue && SMAppService.mainApp.status != .enabled
        }
    }

    /// 사용자가 시스템 설정에서 직접 허용해야 하는 상태인지(설정을 열 때마다 다시 본다).
    func refreshLaunchAtLoginStatus() {
        if SMAppService.mainApp.status == .requiresApproval { launchAtLoginNeedsAttention = true }
        if SMAppService.mainApp.status == .enabled { launchAtLoginNeedsAttention = false }
    }

    func openLoginItemsSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }

    // MARK: 저장

    private func saveQuery() {
        guard !SnapshotMode.isOn else { return }
        defaults.set(query.category?.rawValue, forKey: Keys.category)
        defaults.set(query.repo, forKey: Keys.repo)
        defaults.set(query.unreadOnly, forKey: Keys.unreadOnly)
        defaults.set(query.mineOnly, forKey: Keys.mineOnly)
        defaults.set(query.sort.rawValue, forKey: Keys.sort)
    }

    /// 스냅숏은 같은 앱 설정을 쓰므로, 그림용으로 바꾼 값이 사용자 설정에 남지 않게 한다.
    private func save(_ value: Any, _ key: String) {
        guard !SnapshotMode.isOn else { return }
        defaults.set(value, forKey: key)
    }

    private func saveJSON<T: Encodable>(_ value: T, _ key: String) {
        guard !SnapshotMode.isOn, let data = try? JSONEncoder().encode(value) else { return }
        defaults.set(data, forKey: key)
    }

    private static func loadJSON<T: Decodable>(_ type: T.Type, _ key: String) -> T? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

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
        guard !SnapshotMode.isOn else { return }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(state) else { return }
        let url = Self.stateURL
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
    }
}
