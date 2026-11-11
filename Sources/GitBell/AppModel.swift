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
    /// 패널을 연 횟수. 바뀔 때마다 목록을 맨 위(가장 새 항목)로 올린다(PanelWindowObserver).
    @Published private(set) var panelOpenCount = 0
    /// 키체인에 토큰을 저장하지 못했는지. 토큰 입력칸 아래에 알린다.
    @Published private(set) var tokenSaveFailed = false

    /// 목록 필터·검색·정렬. 검색어를 뺀 나머지는 다음에 열 때도 그대로 쓰도록 저장한다.
    @Published var query = ActivityQuery() {
        // 검색어는 저장하지 않으므로, 글자를 칠 때마다 설정을 다시 쓰지 않는다.
        didSet { if query.savedPart != oldValue.savedPart { saveQuery() } }
    }
    @Published var showingSettings = false
    @Published var showingSearch = false

    @Published var refreshMinutes: Int {
        // 이미 고른 간격을 다시 눌러도 확인 주기를 새로 시작하지 않는다(돌고 있는 확인을 건드리지 않게).
        didSet { if refreshMinutes != oldValue { save(refreshMinutes, Keys.refreshMinutes); restartLoop() } }
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
    /// 확인 사이에 이어 쓰는 GitHub 응답(조건부 요청용). 토큰이 바뀌면 스스로 비운다.
    private let responseCache = ResponseCache()

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
        static let notifiedUpdate = "notifiedUpdateVersion"
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

    /// 기록이 있는 채로 토큰이 만료된 화면(문제 안내 + 설정의 새 토큰 입력칸).
    func simulateExpiredToken() { problem = .unauthorized }

    /// 스냅숏용: 문제 띠 종류(network·partial·rate·limited)를 보인다.
    func simulateProblem(_ kind: String) {
        switch kind {
        case "network": problem = .network("The Internet connection appears to be offline.")
        case "partial": problem = .partial(["acme/design-system", "acme/very-long-repository-name-for-layout"])
        case "rate": problem = .rateLimited(Date().addingTimeInterval(25 * 60))
        case "limited": problem = .limited
        default: break
        }
    }

    // MARK: 확인 주기

    func start() {
        clearLegacyDiskCache()
        state = Self.loadState()
        // 잠자기에서 깨면 다음 주기를 기다리지 않고 확인한다(네트워크가 붙을 시간을 조금 준다).
        // 따로 확인하지 않고 주기를 새로 시작해, 깨자마자 두 번 연달아 확인하지 않게 한다.
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil,
                                                          queue: .main) { _ in
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 5 * 1_000_000_000)
                AppModel.shared.restartLoop()
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
            while !Task.isCancelled {
                // 확인은 이 반복과 따로 돌린다. 간격을 바꿔 반복을 취소해도 돌고 있던 확인(네트워크 요청)은
                // 취소되지 않아, '취소됨' 오류가 뜨거나 그 사이 활동을 잃지 않는다.
                if let self { await Task { await self.refresh() }.value }
                // 새 버전은 1시간마다 확인한다(npm에 작은 요청 하나라 부담이 없다). 앱을 켤 때도 한 번 본다(start).
                // 마지막 확인 시각으로 재서, 잠자기에서 깨어 반복을 새로 시작해도 1시간 주기가 처음부터 다시 세지지 않는다.
                if let self, Date().timeIntervalSince(self.lastUpdateCheck) >= Double(Self.updateCheckMinutes) * 60 {
                    await self.checkForUpdate()
                }
                try? await Task.sleep(nanoseconds: UInt64(minutes) * 60 * 1_000_000_000)
            }
        }
    }

    /// 사용자가 직접 누른 새로고침(⌘R, 새로고침 단추, 다시 확인). 조용한 저장소도 기다리지 않고 모두 읽는다.
    func refreshNow() async {
        readAllNext = true
        await refresh()
    }

    /// 다음 확인에서 모든 저장소를 읽을지(refreshNow).
    private var readAllNext = false

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
        // API 한도에 걸렸으면 풀리는 시각까지는 보내지 않는다(보내도 실패하고 2차 한도 위험만 커진다).
        if case let .rateLimited(resetAt?) = problem, resetAt > Date() { return }
        // 사용자가 시스템 설정에서 알림을 켜고 끌 수 있어 확인할 때마다 권한도 다시 읽는다.
        refreshNotificationAuthorization()

        let usedCachedToken = cachedToken != nil
        guard let token = await currentToken() else {
            setTokenSource(nil)
            setProblem(.noToken)
            return
        }
        setTokenSource(token.source)
        let api = URLSessionGitHubAPI(token: token.value, cache: responseCache)
        let poller = ActivityPoller(api: api)
        do {
            // gh auth login으로 다른 계정에 로그인했으면(토큰이 바뀌었는데 401은 아님) 앞 계정의 기록을
            // 이어 쓰면 새 계정의 하루치가 모두 새 알림이 되고 내 활동도 거르지 못한다. 그래서 첫 실행처럼 다시 채운다.
            if let previous = lastTokenValue, previous != token.value, !state.me.isEmpty,
               let login = try? await api.get("user", as: GHUser.self).login, login != state.me {
                state = WatchState()
            }
            lastTokenValue = token.value
            let unreadBefore = Set(state.history.filter(\.isUnread).map(\.id))
            let readAll = readAllNext
            readAllNext = false
            let result = try await poller.refresh(state, now: Date(), includeOwn: includeOwnActivity, readAll: readAll)
            // 확인하는 동안 토큰이 바뀌었으면 예전 계정의 결과라 버린다(바로 다시 확인한다).
            guard account == accountGeneration else { return }
            // 새로고침이 도는 동안 사용자가 바꾼 읽음 표시를 지킨다.
            state = result.state.adoptingReadMarks(from: state)
            saveState()
            // 기록이 넘쳐 목록에서 빠진 안 읽은 항목의 알림은 알림 센터에서도 지운다(누를 곳이 없는 알림이 남지 않게).
            let dropped = unreadBefore.subtracting(state.history.map(\.id))
            if !dropped.isEmpty { Notifier.shared.removeDelivered(ids: Array(dropped), includeSummaries: false) }
            if !result.failedRepos.isEmpty {
                setProblem(.partial(result.failedRepos))
            } else {
                setProblem(result.notificationsUnavailable ? .limited : nil)
            }
            let toNotify = eventsToNotify(result.newEvents, notifications: notificationPrefs, display: display,
                                          me: state.me)
            Notifier.shared.post(toNotify, playsSound: notificationPrefs.playsSound)
        } catch where account != accountGeneration {
            // 예전 계정으로 한 확인의 오류는 보이지 않는다.
        } catch GitHubError.unauthorized {
            cachedToken = nil
            // 기억해 둔 토큰이 그사이 바뀌었을 수 있다(gh auth login을 다시 함). 새로 찾아 한 번 더 확인한다.
            if usedCachedToken { refreshAgain = true } else { setProblem(.unauthorized) }
        } catch let GitHubError.rateLimited(resetAt) {
            // GitHub의 한도 창은 1시간이다. 이 Mac 시계가 틀려 다시 쓸 시각이 아주 멀어 보여도 1시간 넘게 쉬지 않는다.
            setProblem(.rateLimited(resetAt.map { min($0, Date().addingTimeInterval(3600)) }))
        } catch let GitHubError.http(status, message) {
            setProblem(.network("HTTP \(status) \(message)"))
        } catch let GitHubError.network(message) {
            setProblem(.network(message))
        } catch {
            setProblem(.network(error.localizedDescription))
        }
    }

    /// 확인할 때마다 키체인을 읽고 gh를 실행하지 않도록 찾은 토큰을 잠시 기억한다.
    /// 토큰을 저장·삭제하거나 401을 받으면 지우고, 30분이 지나도 다시 찾는다(gh로 다른 계정에 로그인했을 수 있다).
    private var cachedToken: (token: ResolvedToken, foundAt: Date)?
    /// 지난 확인에 쓴 토큰. 바뀌면 같은 계정인지 확인한다(refreshOnce).
    private var lastTokenValue: String?
    private static let tokenReuseInterval: TimeInterval = 30 * 60

    private func currentToken() async -> ResolvedToken? {
        if let cachedToken, Date().timeIntervalSince(cachedToken.foundAt) < Self.tokenReuseInterval {
            return cachedToken.token
        }
        // gh 실행은 잠깐 막힐 수 있어 메인 스레드 밖에서 토큰을 찾는다.
        let found = await Task.detached(operation: { TokenStore.resolve() }).value
        cachedToken = found.map { ($0, Date()) }
        return found
    }

    // 같은 값을 넣어도 @Published는 바뀐 것으로 알려 메뉴 막대와 패널 전체를 다시 그린다.
    // 확인할 때마다 넣는 값이라 달라질 때만 넣는다.
    private func setProblem(_ newValue: Problem?) {
        if problem != newValue { problem = newValue }
    }

    private func setTokenSource(_ newValue: TokenSource?) {
        if tokenSource != newValue { tokenSource = newValue }
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
        markOpened(event.id)
    }

    /// 항목(또는 그 알림)을 열었을 때. 같은 PR·이슈의 다른 안 읽은 항목도 함께 읽음이 된다.
    func markOpened(_ id: String) {
        let before = unreadIDs
        state.markThreadRead(id)
        saveState()
        dismissRead(before)
    }

    /// id가 nil이면 지금 화면에 보이는 항목을 모두 읽음으로 바꾼다(필터·숨긴 저장소 반영, 되돌릴 수 있다).
    func markRead(_ id: String? = nil) {
        guard let id else { return markRead(events: effectiveQuery.filter(visibleHistory)) }
        let before = unreadIDs
        state.markRead(id)
        saveState()
        dismissRead(before)
    }

    /// 여러 항목(묶음 하나, 또는 보이는 전체)을 읽음으로 바꾸고 잠시 '되돌리기'를 보인다.
    func markRead(events: [ActivityEvent]) {
        let ids = events.filter(\.isUnread).map(\.id)
        guard !ids.isEmpty else { return }
        let before = unreadIDs
        state.markRead(ids: Set(ids))
        saveState()
        dismissRead(before)
        offerUndo(ids)
    }

    // MARK: 되돌리기

    /// 방금 여러 항목을 읽음으로 바꾼 기록. 잘못 눌렀을 때 되돌릴 수 있게 잠시 남긴다.
    struct ReadUndo: Equatable {
        let ids: [String]
        let stamp = UUID()
    }

    @Published private(set) var readUndo: ReadUndo?
    /// '되돌리기'를 보이는 시간.
    static let undoSeconds: Double = 8

    private func offerUndo(_ ids: [String]) {
        let undo = ReadUndo(ids: ids)
        readUndo = undo
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.undoSeconds))
            if self?.readUndo == undo { self?.readUndo = nil }
        }
    }

    func undoMarkRead() {
        guard let undo = readUndo else { return }
        state.markUnread(ids: Set(undo.ids))
        saveState()
        readUndo = nil
    }

    private var unreadIDs: Set<String> { Set(state.history.filter(\.isUnread).map(\.id)) }

    /// GitBell에서 읽은 항목의 알림을 알림 센터에서도 지운다(이미 본 알림이 쌓이지 않게).
    /// 보이는 안 읽은 항목이 하나도 없으면 여러 항목을 묶은 요약 알림까지 지운다.
    private func dismissRead(_ before: Set<String>) {
        let read = before.subtracting(unreadIDs)
        guard !read.isEmpty else { return }
        Notifier.shared.removeDelivered(ids: Array(read), includeSummaries: unreadCount == 0)
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
            // 같은 값을 넣어도 @Published는 바뀐 것으로 알려 패널 전체를 다시 그린다.
            // 설정 화면이 2초마다 이 값을 읽으므로 값이 달라질 때만 넣는다.
            Task { @MainActor in
                if self.notificationAuthorization != status { self.notificationAuthorization = status }
            }
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

    /// 마지막으로 새 버전을 확인한 시각(restartLoop가 1시간마다 확인하는 데 쓴다).
    private var lastUpdateCheck = Date.distantPast

    func checkForUpdate() async {
        lastUpdateCheck = Date()
        guard !SnapshotMode.isOn,
              let current = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
              let url = URL(string: "https://registry.npmjs.org/gitbell/latest") else { return }
        var request = URLRequest(url: url, timeoutInterval: 10)
        request.setValue("GitBell", forHTTPHeaderField: "User-Agent")
        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let latest = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["version"] as? String
        else { return }
        let newer = SemanticVersion.isNewer(latest, than: current) ? latest : nil
        if availableUpdate != newer { availableUpdate = newer }
        notifyUpdate()
    }

    /// 새 버전 확인 간격(분). 확인 주기(1·2·5·10·15분)로 나누어떨어져야 정확히 1시간마다 확인한다.
    static let updateCheckMinutes = 60
    /// 업데이트 명령. 띠의 도움말·복사, 알림 문구가 모두 이 명령을 가리킨다.
    static let updateCommand = "npx gitbell@latest"

    /// 새 버전을 패널 띠뿐 아니라 시스템 알림으로도 바로 알린다. 패널을 열지 않는 사용자도 알 수 있게 한다.
    /// 같은 버전은 한 번만 알린다(앱을 다시 켜도 다시 알리지 않는다). 알림을 꺼 둔 사용자에게는 띠만 보인다.
    private func notifyUpdate() {
        guard let version = availableUpdate, version != defaults.string(forKey: Keys.notifiedUpdate),
              notificationPrefs.isEnabled else { return }
        Notifier.shared.postUpdate(version: version, playsSound: notificationPrefs.playsSound)
        // 실제로 알린 뒤에만 '알림'으로 기록한다. 알림을 꺼 둔 동안 나온 버전은 다시 켜면 다음 확인 때 알린다.
        defaults.set(version, forKey: Keys.notifiedUpdate)
    }

    /// 0.5.2까지는 GitHub API 응답이 URLCache.shared(디스크)에 쌓였다. 비공개 저장소 본문이 남지 않게 한 번 지운다.
    private func clearLegacyDiskCache() {
        let key = "clearedLegacyAPIDiskCache"
        guard !SnapshotMode.isOn, !defaults.bool(forKey: key) else { return }
        URLCache.shared.removeAllCachedResponses()
        defaults.set(true, forKey: key)
    }

    /// 패널이 지금 화면에 떠 있는지. 설정 화면은 떠 있는 동안에만 알림 권한을 다시 읽는다.
    @Published private(set) var isPanelVisible = false
    /// 업데이트 명령을 복사했는지. 새 버전 띠에 '복사됨'을 보인다. 알림을 눌러 복사해도 켜지고, 패널을 닫으면 꺼진다.
    @Published private(set) var updateCommandCopied = false

    /// 메뉴 막대 패널이 열리거나 닫힐 때(PanelWindowObserver).
    func panelVisibilityChanged(_ visible: Bool) {
        isPanelVisible = visible
        if visible {
            panelOpenCount += 1
        } else if updateCommandCopied {
            updateCommandCopied = false
        }
    }

    func copyUpdateCommand() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(Self.updateCommand, forType: .string)
        updateCommandCopied = true
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
        cachedToken = nil
        lastTokenValue = nil
        // 앞 계정의 문제(한도 초과 등)가 새 계정의 첫 확인을 막지 않게 지운다.
        setProblem(nil)
        state = WatchState()
        saveState()
        Task { await refresh() }
    }

    func removeSavedToken() {
        TokenStore.deleteKeychain()
        accountGeneration += 1
        cachedToken = nil
        lastTokenValue = nil
        // 앞 계정의 문제(한도 초과 등)가 새 계정의 첫 확인을 막지 않게 지운다.
        setProblem(nil)
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
