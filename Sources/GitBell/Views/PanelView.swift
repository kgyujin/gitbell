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
                    FooterView()
                }
            }
        }
        .frame(width: 420)
        .panelBackground()
    }

    private var showsOnboarding: Bool {
        model.problem == .noToken || (model.problem == .unauthorized && model.state.history.isEmpty)
    }
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
            if model.state.unreadCount > 0 {
                Text("\(model.state.unreadCount)")
                    .font(.system(size: 11, weight: .bold))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(Capsule().fill(Color.accentColor))
                    .foregroundStyle(.white)
            }
            Spacer()
            IconButton(symbol: "magnifyingglass", help: "Search", isActive: model.showingSearch) {
                model.showingSearch.toggle()
                if !model.showingSearch { model.query.search = "" }
            }
            if model.state.unreadCount > 0 {
                IconButton(symbol: "checkmark.circle", help: "Mark all as read") { model.markRead() }
            }
            IconButton(symbol: "arrow.clockwise", help: "Refresh", spinning: model.isRefreshing) {
                Task { await model.refresh() }
            }
            IconButton(symbol: "gearshape", help: "Settings") { model.showingSettings = true }
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
                .onExitCommand { model.query.search = ""; model.showingSearch = false }
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
                Spacer()
                Chip(title: L10n.string("Unread"), symbol: "circle.fill", isSelected: model.query.unreadOnly) {
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
                Text(String(format: L10n.string("%lld items"), model.visibleCount))
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
                    OptionRow(title: L10n.string("All repositories"), detail: "\(model.state.history.count)",
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
            return String(format: L10n.string("Couldn't read %lld repositories:"), repos.count) + " "
                + repos.map { $0.split(separator: "/").last.map(String.init) ?? $0 }.joined(separator: ", ")
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
            .frame(height: 480)
        }
    }

    @ViewBuilder
    private func content(_ sections: [ActivitySection]) -> some View {
        let groupedByRepo = model.query.sort == .byRepository
        ForEach(sections) { section in
            Section {
                ForEach(section.events) { event in
                    EventRow(event: event, showsRepository: !groupedByRepo) { model.open(event) }
                }
            } header: {
                SectionHeader(section: section)
            }
        }
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
                if section.unreadCount > 0 {
                    Button { model.markRead(repo: repo) } label: {
                        Text("Mark as read").foregroundStyle(.tint)
                    }
                    .buttonStyle(.plain)
                }
            } else {
                Text(verbatim: L10n.sectionTitle(section.key)).foregroundStyle(.secondary)
                Text("\(section.events.count)").foregroundStyle(.tertiary)
                Spacer()
            }
        }
        .font(.system(size: 11, weight: .semibold))
        .padding(.horizontal, 14)
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .panelBackground()
    }
}

private struct EmptyStateView: View {
    let isFirstLoad: Bool

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: isFirstLoad ? "hourglass" : "checkmark.circle")
                .font(.system(size: 28))
                .foregroundStyle(.secondary)
            Text(isFirstLoad ? "Loading your GitHub activity…" : "No activity in the last day")
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
                Text(String(format: L10n.string("Checked %@ · %lld repositories"),
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
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
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
        .onHover { hovering = $0 }
    }
}

/// 직접 그린 칩. 시스템 세그먼트 컨트롤보다 가볍고, 스냅숏에도 그려진다.
private struct Chip: View {
    let title: String
    var symbol: String?
    let isSelected: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                if let symbol {
                    Image(systemName: symbol).font(.system(size: 6))
                }
                Text(title)
            }
            .font(.system(size: 12, weight: isSelected ? .semibold : .regular))
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .foregroundStyle(isSelected ? Color.white : Color.primary)
            .background(Capsule().fill(isSelected ? Color.accentColor : Color.primary.opacity(hovering ? 0.1 : 0.06)))
        }
        .buttonStyle(.plain)
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
        .onHover { hovering = $0 }
    }
}
