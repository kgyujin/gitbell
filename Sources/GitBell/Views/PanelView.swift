// 메뉴 막대 아이콘을 누르면 열리는 패널.
//
// 위:   제목 · 검색 · 모두 읽음 · 새로고침 · 설정
//       (검색창: 돋보기를 누르면 열린다)
//       종류 칩(전체·PR·리뷰·커밋)                     안 읽음만
//       저장소 고르기 · 정렬 고르기                       N개
// 가운데: 묶음(날짜·저장소·안 읽음)별 활동 목록
// 아래: 마지막 확인 시각 · GitHub 열기

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
            Text("GitBell").font(.system(size: 14, weight: .bold))
            if model.unreadCount > 0 {
                Text("\(model.unreadCount)")
                    .font(.system(size: 11, weight: .bold))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(Capsule().fill(Color.accentColor))
                    .foregroundStyle(.white)
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
                Task { await model.refresh() }
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
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField("Search title, repository, person, #number", text: $model.query.search)
                .textFieldStyle(.plain)
                .focused($focused)
            if !model.query.search.isEmpty {
                Button { model.query.search = "" } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
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
            HStack(spacing: 6) {
                ForEach([nil] + EventCategory.allCases.map(Optional.some), id: \.self) { category in
                    Chip(title: L10n.categoryLabel(category), isSelected: model.query.category == category) {
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
}

/// 저장소 고르기. 기록에 나온 저장소만, 최근 활동 순으로 보여 준다.
private struct RepositoryPicker: View {
    @EnvironmentObject private var model: AppModel
    @State private var open = false

    var body: some View {
        MenuChip(symbol: "folder", title: title, isActive: model.query.repo != nil) { open.toggle() }
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
                                    Button(L10n.string("Hide this repository")) { model.hideRepository(summary.repo) }
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
                 isActive: model.query.sort != .newest) { open.toggle() }
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
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                Text(message).font(.system(size: 11)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                // 토큰 문제는 설정에서 고친다. 안내만 하지 않고 바로 갈 수 있게 한다.
                if model.problem == .unauthorized {
                    LinkButton(title: L10n.string("Open Settings")) { model.showingSettings = true }
                        .font(.system(size: 11, weight: .medium))
                        .fixedSize()
                }
            }
            .padding(8)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.orange.opacity(0.1)))
            .padding(.horizontal, 14)
            .padding(.bottom, 8)
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
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) { content(sections) }
                    .padding(.bottom, 6)
            }
            .frame(height: estimatedHeight(sections))
        }
    }

    /// 항목이 적을 때 아래가 텅 비지 않게 목록 높이를 내용에 맞춘다(최대 480).
    private func estimatedHeight(_ sections: [ActivitySection]) -> CGFloat {
        let rows = sections.flatMap(\.events).reduce(CGFloat(0)) { total, event in
            total + (L10n.title(event).count > 44 ? 84 : 66)
        }
        return min(480, max(180, rows + CGFloat(sections.count) * 24 + 6))
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
        Button(L10n.string("Open in browser")) { model.open(event) }
        Button(L10n.string("Copy link")) { model.copyLink(event) }
        Divider()
        if event.isUnread {
            Button(L10n.string("Mark as read")) { model.markRead(event.id) }
        } else {
            Button(L10n.string("Mark as unread")) { model.markUnread(event.id) }
        }
        Button(String(format: L10n.string("Show only %@"), event.repoName)) { model.query.repo = event.repo }
        Divider()
        Button(String(format: L10n.string("Hide %@"), event.repoName)) { model.hideRepository(event.repo) }
    }
}

/// 새 버전이 있을 때 목록 아래에 뜨는 안내. 누르면 업데이트 명령을 복사한다.
private struct UpdateBanner: View {
    @EnvironmentObject private var model: AppModel
    @State private var copied = false

    var body: some View {
        Button {
            model.copyUpdateCommand()
            copied = true
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "arrow.down.circle.fill").foregroundStyle(.tint)
                Text(String(format: L10n.string("GitBell %@ is available"), model.availableUpdate ?? ""))
                    .fontWeight(.medium)
                Spacer()
                Text(copied ? L10n.string("Copied — paste it in Terminal")
                            : L10n.string("Copy update command"))
                    .foregroundStyle(.tint)
            }
            .font(.system(size: 11))
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .background(Color.accentColor.opacity(0.08))
        }
        .buttonStyle(.plain)
        .help("npx gitbell@latest")
    }
}

private struct SectionHeader: View {
    @EnvironmentObject private var model: AppModel
    let section: ActivitySection

    var body: some View {
        HStack(spacing: 6) {
            if case let .repository(repo) = section.key {
                Image(systemName: "folder.fill").foregroundStyle(.secondary)
                Button {
                    NSWorkspace.shared.open(URL(string: "https://github.com/\(repo)")!)
                } label: {
                    Text(verbatim: L10n.sectionTitle(section.key)).foregroundStyle(.primary)
                }
                .buttonStyle(.plain)
                .help(repo)
                Text("\(section.events.count)").foregroundStyle(.tertiary)
                Spacer()
                markReadButton
            } else {
                Text(verbatim: L10n.sectionTitle(section.key)).foregroundStyle(.secondary)
                Text("\(section.events.count)").foregroundStyle(.tertiary)
                Spacer()
                markReadButton
            }
        }
        .font(.system(size: 11, weight: .semibold))
        .padding(.horizontal, 14)
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .panelBackground()
    }
}

extension SectionHeader {
    /// 저장소 묶음뿐 아니라 날짜·안 읽음 묶음도 한 번에 읽음으로 바꿀 수 있다(보이는 항목만, 되돌릴 수 있다).
    @ViewBuilder var markReadButton: some View {
        if section.unreadCount > 0 {
            Button { model.markRead(events: section.events) } label: {
                Text("Mark as read").foregroundStyle(.tint)
            }
            .buttonStyle(.plain)
        }
    }
}

/// 여러 항목을 읽음으로 바꾼 직후 잠시 보이는 '되돌리기'.
private struct UndoBanner: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        if let undo = model.readUndo {
            HStack(spacing: 6) {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.secondary)
                Text(L10n.format("Marked %lld items as read", undo.ids.count))
                Spacer()
                Button { model.undoMarkRead() } label: {
                    Text("Undo").fontWeight(.semibold).foregroundStyle(.tint)
                }
                .buttonStyle(.plain)
                // 검색창을 연 동안의 ⌘Z는 글자 되돌리기로 둔다.
                .keyboardShortcut(model.showingSearch ? nil : KeyboardShortcut("z", modifiers: .command))
            }
            .font(.system(size: 11))
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .background(Color.primary.opacity(0.05))
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
        HStack {
            if let checked = model.state.lastChecked {
                Text(L10n.format("Checked %@ · %lld repositories",
                            L10n.clock(checked), model.state.checkedRepos.count))
            } else {
                Text("Checking…")
            }
            Spacer()
            Button {
                NSWorkspace.shared.open(URL(string: "https://github.com/notifications")!)
            } label: {
                Text("Open GitHub").foregroundStyle(.tint)
            }
            .buttonStyle(.plain)
        }
        .font(.system(size: 11))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }
}

// MARK: - 공용 부품

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
                    // '안 읽음'의 점은 작게, '내 PR'의 사람 아이콘은 알아볼 수 있는 크기로 그린다.
                    Image(systemName: symbol).font(.system(size: symbol == "circle.fill" ? 6 : 10, weight: .semibold))
                }
                Text(title)
            }
            .font(.system(size: small ? 11 : 12, weight: isSelected ? .semibold : .regular))
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
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: symbol)
                Text(verbatim: shortened(title)).lineLimit(1)
                Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold))
            }
            .fixedSize()
            .font(.system(size: 11, weight: .medium))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .foregroundStyle(isActive ? AnyShapeStyle(.tint) : AnyShapeStyle(.primary))
            .background(RoundedRectangle(cornerRadius: 6)
                .strokeBorder(isActive ? Color.accentColor.opacity(0.6) : Color.primary.opacity(0.15))
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(hovering ? 0.06 : 0))))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(title)
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
                if let symbol {
                    Image(systemName: symbol).foregroundStyle(.secondary).frame(width: 16)
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
        .onHover { hovering = $0 }
    }
}
