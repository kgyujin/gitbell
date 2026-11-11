// 메뉴 막대 아이콘을 누르면 열리는 패널.
//
// 위:   제목 · 검색 · 모두 읽음 · 새로고침 · 설정
//       (검색창: 돋보기를 누르면 열린다)
//       종류 칩(전체·PR·리뷰·커밋)                 내 PR · 안 읽음
//       저장소 고르기 · 정렬 고르기                       N개
//       (문제가 있으면 경고 띠)
// 가운데: 묶음(날짜·저장소·안 읽음)별 활동 목록
// 아래: 되돌리기 띠 · 새 버전 띠 · 마지막 확인 시각 · GitHub 열기

import GitBellCore
import SwiftUI

struct PanelView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            if model.showingSettings {
                SettingsView()
            } else {
                HeaderView()
                if showsOnboarding {
                    // 토큰이 만료돼 연결 안내로 돌아왔으면 왜 그런지(문제 띠)를 함께 보인다(Windows판과 같다).
                    ProblemBanner()
                    OnboardingView()
                } else {
                    if model.showingSearch { SearchField() }
                    FilterBar()
                    ProblemBanner()
                    Divider()
                    ActivityList()
                    Divider()
                    UndoBanner()
                    if model.availableUpdate != nil { UpdateBanner() }
                    FooterView()
                }
            }
        }
        .frame(width: 420)
        .panelBackground()
        .background(PanelWindowObserver { model.panelVisibilityChanged($0) })
        // 패널을 열 때마다 알림 권한을 다시 읽는다(시스템 설정에서 바꾼 값이 바로 보이게).
        .onAppear { model.refreshNotificationAuthorization() }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { _ in
            model.refreshNotificationAuthorization()
        }
    }

    private var showsOnboarding: Bool { model.showsOnboarding }
}

// MARK: - 위쪽

private struct HeaderView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "bell.fill")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
            Text("GitBell").font(.system(size: 14, weight: .bold))
            if model.unreadCount > 0 {
                Text("\(model.unreadCount)")
                    .font(.system(size: 11, weight: .bold))
                    .monospacedDigit()
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(Capsule().fill(Color.accentColor))
                    .foregroundStyle(.white)
                    // 숫자만 읽히면 무슨 수인지 몰라 '안 읽음 3개'로 읽힌다.
                    .accessibilityLabel(L10n.format("%lld unread", model.unreadCount))
            }
            Spacer()
            // 연결 전에는 찾을 것이 없어 검색 버튼을 숨긴다.
            if !model.showsOnboarding {
                IconButton(symbol: "magnifyingglass", help: "Search (⌘F)", isActive: model.showingSearch, shortcut: "f") {
                    model.showingSearch.toggle()
                    if !model.showingSearch { model.query.search = "" }
                }
            }
            if model.visibleUnreadCount > 0 {
                IconButton(symbol: "checkmark.circle", help: "Mark everything shown as read") { model.markRead() }
            }
            IconButton(symbol: "arrow.clockwise", help: "Refresh (⌘R)", spinning: model.isRefreshing, shortcut: "r") {
                Task { await model.refreshNow() }
            }
            IconButton(symbol: "gearshape", help: "Settings (⌘,)", shortcut: ",") { model.showingSettings = true }
        }
        .padding(.horizontal, 14)
        .padding(.top, 12)
        .padding(.bottom, 8)
    }
}

private struct SearchField: View {
    @EnvironmentObject private var model: AppModel
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary).accessibilityHidden(true)
            TextField("Search title, repository, person, #number", text: $model.query.search)
                .textFieldStyle(.plain)
                .focused($focused)
                // 자리표시 글은 이름이 아니라서 VoiceOver용 이름을 따로 준다.
                .accessibilityLabel(Text("Search activity"))
            if !model.query.search.isEmpty {
                Button { model.query.search = "" } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help(L10n.string("Clear search"))
                .accessibilityLabel(Text("Clear search"))
            }
        }
        .font(.system(size: 12))
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.06)))
        .padding(.horizontal, 14)
        .padding(.bottom, 8)
        .onAppear { focused = true }
    }
}

private struct FilterBar: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // 종류 칩에도 목록·알림 설정과 같은 아이콘을 붙인다. 영어처럼 글자가 길어 한 줄에 안 들어가면
            // 아이콘만 빼고 글자를 지킨다(ViewThatFits).
            ViewThatFits(in: .horizontal) {
                chipRow(showsIcons: true)
                chipRow(showsIcons: false)
            }
            HStack(spacing: 6) {
                RepositoryPicker()
                SortPicker()
                Spacer()
                if model.query.isFiltering {
                    Button { model.resetFilters() } label: {
                        Text("Reset").foregroundStyle(.tint)
                    }
                    .buttonStyle(.plain)
                }
                Text(L10n.format("%lld items", model.visibleCount))
                    .foregroundStyle(.secondary)
            }
            .font(.system(size: 11))
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 10)
    }

    private func chipRow(showsIcons: Bool) -> some View {
        HStack(spacing: 6) {
            ForEach([nil] + EventCategory.allCases.map(Optional.some), id: \.self) { category in
                Chip(title: L10n.categoryLabel(category), symbol: showsIcons ? L10n.categorySymbol(category) : nil,
                     isSelected: model.query.category == category) {
                    model.query.category = category
                }
            }
            Spacer(minLength: 4)
            Chip(title: L10n.string("Mine"), symbol: "person.fill", isSelected: model.query.mineOnly, small: true) {
                model.query.mineOnly.toggle()
            }
            .help(L10n.string("Show only others' activity on pull requests you opened. Notifications aren't affected."))
            Chip(title: L10n.string("Unread"), symbol: "circle.fill", isSelected: model.query.unreadOnly, small: true) {
                model.query.unreadOnly.toggle()
            }
        }
    }
}

/// 저장소 고르기. 기록에 나온 저장소만, 최근 활동 순으로 보여 준다.
private struct RepositoryPicker: View {
    @EnvironmentObject private var model: AppModel
    @State private var open = false

    var body: some View {
        // 이름표·도움말에는 'owner/repo' 전체를 쓴다(다른 조직에 같은 이름의 저장소가 있을 수 있다).
        MenuChip(symbol: "folder", title: title, isActive: model.query.repo != nil,
                 accessibilityTitle: String(format: L10n.string("Repository: %@"), model.query.repo ?? title),
                 helpText: model.query.repo ?? title) { open.toggle() }
            .popover(isPresented: $open, arrowEdge: .bottom) {
                VStack(alignment: .leading, spacing: 0) {
                    OptionRow(title: L10n.string("All repositories"),
                              detail: "\(model.repositories.reduce(0) { $0 + $1.count })",
                              isSelected: model.query.repo == nil) {
                        model.query.repo = nil
                        open = false
                    }
                    Divider().padding(.vertical, 4)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(model.repositories) { summary in
                                OptionRow(title: summary.name, subtitle: summary.repo,
                                          detail: "\(summary.count)", unread: summary.unreadCount,
                                          isSelected: model.query.repo == summary.repo) {
                                    model.query.repo = summary.repo
                                    open = false
                                }
                                .contextMenu {
                                    Button { model.hideRepository(summary.repo) } label: {
                                        Label(L10n.string("Hide this repository"), systemImage: "eye.slash")
                                    }
                                }
                            }
                        }
                    }
                    .frame(maxHeight: 280)
                }
                .padding(6)
                .frame(width: 280)
            }
    }

    private var title: String {
        guard let repo = model.query.repo else { return L10n.string("All repositories") }
        return repo.split(separator: "/").last.map(String.init) ?? repo
    }
}

private struct SortPicker: View {
    @EnvironmentObject private var model: AppModel
    @State private var open = false

    var body: some View {
        MenuChip(symbol: "arrow.up.arrow.down", title: L10n.sortLabel(model.query.sort),
                 isActive: model.query.sort != .newest,
                 accessibilityTitle: String(format: L10n.string("Sort: %@"), L10n.sortLabel(model.query.sort))) { open.toggle() }
            .popover(isPresented: $open, arrowEdge: .bottom) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(SortMode.allCases, id: \.self) { sort in
                        OptionRow(symbol: L10n.sortSymbol(sort), title: L10n.sortLabel(sort),
                                  isSelected: model.query.sort == sort) {
                            model.query.sort = sort
                            open = false
                        }
                    }
                }
                .padding(6)
                .frame(width: 200)
            }
    }
}

private struct ProblemBanner: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        if let message {
            // 글자 크기를 줄 전체에 주어, 경고 아이콘도 다른 띠(되돌리기·새 버전)의 아이콘과 같은 크기가 된다.
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange).accessibilityHidden(true)
                Text(message).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                // 토큰 문제는 설정에서 고친다. 안내만 하지 않고 바로 갈 수 있게 한다.
                if model.problem == .unauthorized {
                    LinkButton(title: L10n.string("Open Settings"), symbol: "gearshape") { model.showingSettings = true }
                        .fixedSize()
                }
            }
            .font(.system(size: 11))
            .padding(8)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.orange.opacity(0.1)))
            .padding(.horizontal, 14)
            .padding(.bottom, 8)
            .onAppear { Announcer.say(message) }
            .onChange(of: message) { Announcer.say($0) }
        }
    }

    private var message: String? {
        switch model.problem {
        case .unauthorized: return L10n.string("Your GitHub token is invalid or expired. Update it in Settings.")
        case let .network(detail): return L10n.string("Couldn't reach GitHub.") + " " + detail
        case let .partial(repos):
            return L10n.format("Couldn't read %lld repositories:", repos.count) + " "
                + repos.map { $0.split(separator: "/").last.map(String.init) ?? $0 }.joined(separator: ", ")
        case let .rateLimited(resetAt):
            if let resetAt {
                return String(format: L10n.string("GitHub's API limit was reached. GitBell will check again after %@."),
                              L10n.clock(resetAt))
            }
            return L10n.string("GitHub's API limit was reached. GitBell will check again later.")
        case .limited:
            return L10n.string("This token can't read your GitHub notifications, so only repositories with recent pushes are checked. Use GitHub CLI or a classic token.")
        case .noToken, .none: return nil
        }
    }
}

// MARK: - 목록

private struct ActivityList: View {
    @EnvironmentObject private var model: AppModel
    /// 목록 내용의 실제 높이(ContentHeightKey로 잰다).
    @State private var measuredHeight: CGFloat = 0

    var body: some View {
        let sections = model.sections
        if sections.isEmpty {
            if model.query.isFiltering {
                NoMatchView()
            } else {
                EmptyStateView(isFirstLoad: model.state.lastChecked == nil)
            }
        } else if SnapshotMode.isOn {
            // 이미지로 그릴 때는 화면 밖 항목을 그리지 않는 LazyVStack 대신 VStack을 쓴다.
            VStack(alignment: .leading, spacing: 0) { content(sections) }
                .padding(.bottom, 6)
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                        Color.clear.frame(height: 0).id(Self.topID)
                        content(sections)
                    }
                    .padding(.bottom, 6)
                    // 실제 내용 높이를 재서 목록 높이로 쓴다. 글자 수로 어림하면 한국어 제목처럼 일찍 줄바꿈되는 줄에서
                    // 빈칸이 남거나 마지막 줄이 잘렸다. 480pt보다 낮으면 모든 줄이 그려져 있어 잰 값이 정확하다.
                    .background(GeometryReader { geometry in
                        Color.clear.preference(key: ContentHeightKey.self, value: geometry.size.height)
                    })
                }
                .onPreferenceChange(ContentHeightKey.self) { measuredHeight = $0 }
                .frame(height: listHeight(sections))
                // 패널을 열 때마다 맨 위(가장 새 항목)부터 보인다. 메뉴 막대 패널은 닫아도 화면을 버리지 않아,
                // 그대로 두면 지난번 스크롤 위치에 머물러 그 사이 쌓인 새 항목을 보려면 다시 올려야 한다.
                .onChange(of: model.panelOpenCount) { _ in proxy.scrollTo(Self.topID, anchor: .top) }
            }
        }
    }

    private static let topID = "list-top"
}

/// 목록 내용의 높이를 위로 넘기는 값.
private struct ContentHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

private extension ActivityList {
    /// 항목이 적을 때 아래가 텅 비지 않게 목록 높이를 내용에 맞춘다(180~480).
    /// 처음 그릴 때(아직 재기 전)만 줄 수로 어림한다.
    private func listHeight(_ sections: [ActivitySection]) -> CGFloat {
        let content = measuredHeight > 0
            ? measuredHeight
            : CGFloat(sections.reduce(0) { $0 + $1.events.count }) * 68 + CGFloat(sections.count) * 24 + 6
        return min(480, max(180, content))
    }

    @ViewBuilder
    private func content(_ sections: [ActivitySection]) -> some View {
        let groupedByRepo = model.query.sort == .byRepository
        ForEach(sections) { section in
            Section {
                ForEach(section.events) { event in
                    EventRow(event: event, showsRepository: !groupedByRepo, markRead: { model.markRead(event.id) }) {
                        model.open(event)
                    }
                        .contextMenu { EventMenu(event: event) }
                        .modifier(EventAccessibilityActions(event: event))
                }
            } header: {
                SectionHeader(section: section)
            }
        }
    }
}

/// 항목 우클릭 메뉴.
private struct EventMenu: View {
    @EnvironmentObject private var model: AppModel
    let event: ActivityEvent

    var body: some View {
        // 메뉴 항목의 아이콘은 macOS 버전에 따라 보이지 않을 수 있다(그때는 글자만 보인다).
        item(L10n.string("Open in browser"), "arrow.up.right.square") { model.open(event) }
        item(L10n.string("Copy link"), "link") { model.copyLink(event) }
        Divider()
        if event.isUnread {
            item(L10n.string("Mark as read"), "checkmark.circle") { model.markRead(event.id) }
        } else {
            item(L10n.string("Mark as unread"), "circle.inset.filled") { model.markUnread(event.id) }
        }
        item(String(format: L10n.string("Show only %@"), event.repoName), "folder") { model.query.repo = event.repo }
        Divider()
        item(String(format: L10n.string("Hide %@"), event.repoName), "eye.slash") { model.hideRepository(event.repo) }
    }

    private func item(_ title: String, _ symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Label(title, systemImage: symbol) }
    }
}

/// 우클릭 메뉴와 같은 동작을 VoiceOver 동작으로도 둔다(마우스·우클릭 없이 쓸 수 있게).
/// 읽음 표시는 안 읽은 줄에만, 안 읽음 표시는 읽은 줄에만 붙인다.
private struct EventAccessibilityActions: ViewModifier {
    @EnvironmentObject private var model: AppModel
    let event: ActivityEvent

    func body(content: Content) -> some View {
        let base = content
            .accessibilityAction(named: Text("Copy link")) { model.copyLink(event) }
            .accessibilityAction(named: Text(String(format: L10n.string("Show only %@"), event.repoName))) {
                model.query.repo = event.repo
            }
            .accessibilityAction(named: Text(String(format: L10n.string("Hide %@"), event.repoName))) {
                model.hideRepository(event.repo)
            }
        if event.isUnread {
            base.accessibilityAction(named: Text("Mark as read")) { model.markRead(event.id) }
        } else {
            base.accessibilityAction(named: Text("Mark as unread")) { model.markUnread(event.id) }
        }
    }
}

/// 새 버전이 있을 때 목록 아래에 뜨는 안내. 누르면 업데이트 명령을 복사한다.
private struct UpdateBanner: View {
    @EnvironmentObject private var model: AppModel

    private var copied: Bool { model.updateCommandCopied }

    var body: some View {
        Button {
            model.copyUpdateCommand()
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "arrow.down.circle.fill").foregroundStyle(.tint).accessibilityHidden(true)
                Text(String(format: L10n.string("GitBell %@ is available"), model.availableUpdate ?? ""))
                Spacer()
                IconText(copied ? L10n.string("Copied — paste it in Terminal") : L10n.string("Copy update command"),
                         symbol: copied ? "checkmark" : "doc.on.doc")
                    .fontWeight(.medium)
                    .foregroundStyle(.tint)
            }
            .font(.system(size: 11))
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .background(Color.accentColor.opacity(0.08))
        }
        .buttonStyle(.plain)
        .help(AppModel.updateCommand)
        .onChange(of: copied) { if $0 { Announcer.say(L10n.string("Copied — paste it in Terminal")) } }
    }
}

private struct SectionHeader: View {
    @EnvironmentObject private var model: AppModel
    let section: ActivitySection

    var body: some View {
        HStack(spacing: 6) {
            // 아이콘 칸 폭을 정해 두어, 아이콘 모양(달력·폴더·원)이 달라도 제목이 같은 자리에서 시작한다.
            Image(systemName: sectionSymbol).foregroundStyle(.secondary).frame(width: 14).accessibilityHidden(true)
            if case let .repository(repo) = section.key {
                Button {
                    NSWorkspace.shared.open(URL(string: "https://github.com/\(repo)")!)
                } label: {
                    Text(verbatim: L10n.sectionTitle(section.key)).foregroundStyle(.primary)
                        .lineLimit(1).truncationMode(.middle)
                }
                .buttonStyle(.plain)
                .help(repo)
                .accessibilityAddTraits(.isHeader)
            } else {
                Text(verbatim: L10n.sectionTitle(section.key)).foregroundStyle(.secondary)
                    .lineLimit(1)
                    .accessibilityAddTraits(.isHeader)
            }
            // 개수도 읽는 정보라 흐린 색(tertiary, 대비 약 2:1) 대신 secondary로 둔다.
            Text("\(section.events.count)").fontWeight(.regular).monospacedDigit().foregroundStyle(.secondary)
            Spacer()
            markReadButton
        }
        .font(.system(size: 11, weight: .semibold))
        .padding(.horizontal, 14)
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .panelBackground()
    }
}

extension SectionHeader {
    /// 묶음 머리줄 아이콘: 날짜는 달력, 저장소는 폴더, 안 읽음은 점 원, 읽음은 체크 원.
    var sectionSymbol: String {
        switch section.key {
        case .day: return "calendar"
        case .repository: return "folder.fill"
        case .unread: return "circle.inset.filled"
        case .read: return "checkmark.circle"
        }
    }

    /// 저장소 묶음뿐 아니라 날짜·안 읽음 묶음도 한 번에 읽음으로 바꿀 수 있다(보이는 항목만, 되돌릴 수 있다).
    @ViewBuilder var markReadButton: some View {
        if section.unreadCount > 0 {
            Button { model.markRead(events: section.events) } label: {
                IconText(L10n.string("Mark as read"), symbol: "checkmark.circle").fontWeight(.medium).foregroundStyle(.tint)
            }
            .buttonStyle(.plain)
            // 긴 저장소 이름 옆에서도 두 줄로 감기지 않게 한다(제목이 줄임표로 줄어든다).
            .fixedSize()
        }
    }
}

/// 여러 항목을 읽음으로 바꾼 직후 잠시 보이는 '되돌리기'.
private struct UndoBanner: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        if let undo = model.readUndo {
            HStack(spacing: 6) {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.secondary).accessibilityHidden(true)
                Text(L10n.format("Marked %lld items as read", undo.ids.count))
                Spacer()
                Button { model.undoMarkRead() } label: {
                    IconText(L10n.string("Undo"), symbol: "arrow.uturn.backward").fontWeight(.medium).foregroundStyle(.tint)
                }
                .buttonStyle(.plain)
                // 검색창을 연 동안의 ⌘Z는 글자 되돌리기로 둔다.
                .keyboardShortcut(model.showingSearch ? nil : KeyboardShortcut("z", modifiers: .command))
            }
            .font(.system(size: 11))
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .background(Color.primary.opacity(0.05))
            .onAppear { Announcer.say(L10n.format("Marked %lld items as read", undo.ids.count)) }
            .onChange(of: undo.stamp) { _ in Announcer.say(L10n.format("Marked %lld items as read", undo.ids.count)) }
        }
    }
}

private struct EmptyStateView: View {
    let isFirstLoad: Bool

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: isFirstLoad ? "hourglass" : "checkmark.circle")
                .font(.system(size: 28))
                .foregroundStyle(.secondary)
            Text(isFirstLoad ? "Loading your GitHub activity…" : "No activity yet")
                .font(.system(size: 13, weight: .medium))
            if !isFirstLoad {
                Text("New pull requests, reviews, merges and commits will show up here.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity)
        .frame(height: 220)
    }
}

private struct NoMatchView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "line.3.horizontal.decrease.circle")
                .font(.system(size: 28))
                .foregroundStyle(.secondary)
            Text("Nothing matches these filters").font(.system(size: 13, weight: .medium))
            Button("Reset filters") { model.resetFilters() }
                .controlSize(.small)
        }
        .padding(24)
        .frame(maxWidth: .infinity)
        .frame(height: 220)
    }
}

// MARK: - 아래쪽

private struct FooterView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        // 간격 6: 위의 되돌리기·새 버전 띠와 글자 시작 자리를 맞춘다.
        HStack(spacing: 6) {
            Image(systemName: "clock").accessibilityHidden(true)
            if let checked = model.state.lastChecked {
                Text(L10n.format("Checked %@ · %lld repositories",
                            L10n.clock(checked), model.state.checkedRepos.count))
            } else {
                Text("Checking…")
            }
            Spacer()
            LinkButton(title: L10n.string("Open GitHub"), opensOutside: true) {
                NSWorkspace.shared.open(URL(string: "https://github.com/notifications")!)
            }
        }
        .font(.system(size: 11))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }
}

// MARK: - 공용 부품

/// VoiceOver에 바뀐 상태(되돌리기·문제·복사됨)를 읽어 준다. 띠가 새로 나타나기만 해서는 읽지 않는다.
/// 패널이 닫혀 있을 때는 읽지 않는다(메뉴 막대 패널은 닫혀도 화면이 남아, 다른 앱을 쓰는 중에 읽게 된다).
@MainActor
enum Announcer {
    static func say(_ text: String) {
        guard !text.isEmpty, !SnapshotMode.isOn, AppModel.shared.isPanelVisible else { return }
        NSAccessibility.post(element: NSApp as Any, notification: .announcementRequested, userInfo: [
            .announcement: text,
            .priority: NSAccessibilityPriorityLevel.medium.rawValue,
        ])
    }
}

/// 작은 아이콘 + 글자. Label보다 간격이 좁아 링크·띠 안의 짧은 단추에 맞다(Windows판 .with-icon과 같은 4pt 간격).
struct IconText: View {
    let title: String
    let symbol: String

    init(_ title: String, symbol: String) {
        self.title = title
        self.symbol = symbol
    }

    var body: some View {
        HStack(spacing: 4) {
            // 글자가 같은 뜻을 말하므로 VoiceOver는 아이콘을 따로 읽지 않는다.
            Image(systemName: symbol).imageScale(.small).accessibilityHidden(true)
            Text(verbatim: title)
        }
    }
}

struct IconButton: View {
    let symbol: String
    let help: LocalizedStringKey
    var spinning = false
    var isActive = false
    /// ⌘와 함께 누르는 단축키.
    var shortcut: KeyEquivalent?
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        let button = Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 13, weight: .medium))
                .rotationEffect(.degrees(spinning ? 360 : 0))
                .animation(spinning ? .linear(duration: 1).repeatForever(autoreverses: false) : .default, value: spinning)
                .frame(width: 26, height: 26)
                .foregroundStyle(isActive ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                .background(RoundedRectangle(cornerRadius: 6)
                    .fill(isActive ? Color.accentColor.opacity(0.15) : Color.primary.opacity(hovering ? 0.08 : 0)))
        }
        .buttonStyle(.plain)
        .help(help)
        // 아이콘만 있는 버튼이라 VoiceOver가 아이콘 이름 대신 도움말 문구를 읽게 한다.
        .accessibilityLabel(Text(help))
        .onHover { hovering = $0 }
        if let shortcut {
            button.keyboardShortcut(shortcut, modifiers: .command)
        } else {
            button
        }
    }
}

/// 직접 그린 칩. 시스템 세그먼트 컨트롤보다 가볍고, 스냅숏에도 그려진다.
private struct Chip: View {
    let title: String
    var symbol: String?
    let isSelected: Bool
    /// 오른쪽의 켜기·끄기 칩은 조금 작게 그린다.
    var small = false
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                if let symbol {
                    // '안 읽음'의 점은 작게, 그 밖의 아이콘('내 PR'·종류 칩)은 알아볼 수 있는 크기로 그린다.
                    // 글자가 같은 뜻을 말하므로 VoiceOver는 아이콘을 읽지 않는다.
                    Image(systemName: symbol).font(.system(size: symbol == "circle.fill" ? 6 : 10, weight: .semibold))
                        .accessibilityHidden(true)
                }
                // 골라지면 굵게 그리지만, 폭은 늘 굵은 글자 기준으로 잡아 옆 칩이 밀리지 않게 한다.
                Text(title)
                    .fontWeight(isSelected ? .semibold : .regular)
                    .background(Text(title).fontWeight(.semibold).hidden())
                    .lineLimit(1)
                    .fixedSize()
            }
            .font(.system(size: small ? 11 : 12))
            .padding(.horizontal, small ? 8 : 10)
            .padding(.vertical, 4)
            .foregroundStyle(isSelected ? Color.white : Color.primary)
            .background(Capsule().fill(isSelected ? Color.accentColor : Color.primary.opacity(hovering ? 0.1 : 0.06)))
        }
        .buttonStyle(.plain)
        // 색으로만 보이는 '골라짐'을 VoiceOver도 읽게 한다.
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .onHover { hovering = $0 }
    }
}

/// 누르면 고르기 목록(팝오버)이 열리는 칩.
private struct MenuChip: View {
    let symbol: String
    let title: String
    let isActive: Bool
    /// VoiceOver가 읽을 이름(예: '저장소: web'). 없으면 보이는 글자를 읽는다.
    var accessibilityTitle: String?
    /// 마우스를 올리면 보이는 글. 없으면 보이는 글자와 같다.
    var helpText: String?
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: symbol).accessibilityHidden(true)
                Text(verbatim: shortened(title)).lineLimit(1)
                Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold)).accessibilityHidden(true)
            }
            .fixedSize()
            .font(.system(size: 11, weight: .medium))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .foregroundStyle(isActive ? AnyShapeStyle(.tint) : AnyShapeStyle(.primary))
            // 기본값이 아닌 값을 골랐으면 칸을 옅게 채워, 위쪽 단추·종류 칩의 '켜짐'과 같은 뜻으로 보이게 한다.
            .background(RoundedRectangle(cornerRadius: 6)
                .strokeBorder(isActive ? Color.accentColor.opacity(0.6) : Color.primary.opacity(0.15))
                .background(RoundedRectangle(cornerRadius: 6)
                    .fill(isActive ? Color.accentColor.opacity(0.12) : Color.primary.opacity(hovering ? 0.06 : 0))))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(helpText ?? title)
        // '저장소: web'처럼 무엇을 고르는 단추인지 함께 읽힌다.
        .accessibilityLabel(accessibilityTitle ?? title)
    }

    /// 칩이 글자 길이만큼만 차지하게 하고, 긴 저장소 이름은 가운데를 줄인다.
    private func shortened(_ text: String, limit: Int = 22) -> String {
        guard text.count > limit else { return text }
        let half = (limit - 1) / 2
        return String(text.prefix(half)) + "…" + String(text.suffix(limit - 1 - half))
    }
}

/// 팝오버 안의 한 줄. 고른 것에는 체크 표시가 붙는다.
private struct OptionRow: View {
    var symbol: String?
    let title: String
    var subtitle: String?
    var detail: String?
    var unread = 0
    let isSelected: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: "checkmark")
                    .font(.system(size: 10, weight: .bold))
                    .opacity(isSelected ? 1 : 0)
                    .foregroundStyle(.tint)
                    .accessibilityHidden(true)
                if let symbol {
                    Image(systemName: symbol).foregroundStyle(.secondary).frame(width: 16).accessibilityHidden(true)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: title).font(.system(size: 12, weight: isSelected ? .semibold : .regular))
                    if let subtitle {
                        Text(verbatim: subtitle).font(.system(size: 10)).foregroundStyle(.secondary)
                    }
                }
                .lineLimit(1)
                .truncationMode(.middle)
                Spacer(minLength: 8)
                if unread > 0 {
                    Text("\(unread)")
                        .font(.system(size: 10, weight: .bold))
                        .padding(.horizontal, 5)
                        .background(Capsule().fill(Color.accentColor))
                        .foregroundStyle(.white)
                }
                if let detail {
                    Text(verbatim: detail).font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .contentShape(Rectangle())
            .background(RoundedRectangle(cornerRadius: 5).fill(Color.primary.opacity(hovering ? 0.08 : 0)))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        // 숫자 두 개(안 읽음·전체)만 읽히면 뜻을 몰라 이름표에 풀어 쓴다.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
        .onHover { hovering = $0 }
    }

    private var accessibilityText: String {
        var parts = [title]
        if let subtitle { parts.append(subtitle) }
        if let detail, let count = Int(detail) { parts.append(L10n.format("%lld items", count)) }
        if unread > 0 { parts.append(L10n.format("%lld unread", unread)) }
        return parts.joined(separator: ", ")
    }
}

/// 메뉴 막대 패널이 열리고 닫힐 때를 알려 준다.
/// 패널 창은 닫혀도 없어지지 않고 숨기만 해서, 화면의 onAppear로는 다시 열린 것을 알 수 없다.
/// 창이 숨겨지거나(isVisible == false) 다시 보일 때만 알린다. 다른 창에 가려지거나 저장소 고르기
/// 팝오버를 닫을 때처럼 창이 계속 떠 있던 경우는 알리지 않는다.
private struct PanelWindowObserver: NSViewRepresentable {
    let onChange: (Bool) -> Void

    func makeNSView(context: Context) -> ObserverView {
        let view = ObserverView()
        view.onChange = onChange
        return view
    }

    func updateNSView(_ view: ObserverView, context: Context) {
        view.onChange = onChange
    }

    final class ObserverView: NSView {
        var onChange: ((Bool) -> Void)?
        private var observer: NSObjectProtocol?
        private var isShown: Bool?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let observer { NotificationCenter.default.removeObserver(observer) }
            observer = nil
            guard let window else { return }
            observer = NotificationCenter.default.addObserver(
                forName: NSWindow.didChangeOcclusionStateNotification, object: window, queue: .main
            ) { [weak self] _ in
                guard let self, let window = self.window, window.isVisible != self.isShown else { return }
                self.isShown = window.isVisible
                self.onChange?(window.isVisible)
            }
        }

        deinit {
            if let observer { NotificationCenter.default.removeObserver(observer) }
        }
    }
}
