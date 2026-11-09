// 메뉴 막대 아이콘을 누르면 열리는 패널.
// 위: 제목·버튼 / 필터 / 가운데: 날짜별 활동 목록(또는 연결 안내·설정) / 아래: 마지막 확인 시각

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
        HStack(spacing: 8) {
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

private struct FilterBar: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        HStack(spacing: 6) {
            ForEach(AppModel.Filter.allCases) { filter in
                FilterChip(title: L10n.filterLabel(filter), isSelected: model.filter == filter) {
                    model.filter = filter
                }
            }
            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 10)
    }
}

/// 직접 그린 필터 칩. 시스템 세그먼트 컨트롤보다 가볍고, 스냅숏에도 그려진다.
private struct FilterChip: View {
    let title: String
    let isSelected: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(title)
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
        let events = model.visibleEvents
        if events.isEmpty {
            EmptyStateView(isFirstLoad: model.state.lastChecked == nil)
        } else if SnapshotMode.isOn {
            // 이미지로 그릴 때는 화면 밖 항목을 그리지 않는 LazyVStack 대신 VStack을 쓴다.
            VStack(alignment: .leading, spacing: 0) { sections(events) }
                .padding(.bottom, 6)
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) { sections(events) }
                    .padding(.bottom, 6)
            }
            .frame(height: 480)
        }
    }

    @ViewBuilder
    private func sections(_ events: [ActivityEvent]) -> some View {
        ForEach(groupedByDay(events), id: \.day) { group in
            Section {
                ForEach(group.events) { event in
                    EventRow(event: event) { model.open(event) }
                }
            } header: {
                Text(L10n.dayTitle(group.day))
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 5)
                    .panelBackground()
            }
        }
    }

    private func groupedByDay(_ events: [ActivityEvent]) -> [(day: Date, events: [ActivityEvent])] {
        let calendar = Calendar.current
        var groups: [(day: Date, events: [ActivityEvent])] = []
        for event in events {
            let day = calendar.startOfDay(for: event.time)
            if groups.last?.day == day { groups[groups.count - 1].events.append(event) } else { groups.append((day, [event])) }
        }
        return groups
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

// MARK: - 공용

struct IconButton: View {
    let symbol: String
    let help: LocalizedStringKey
    var spinning = false
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 13, weight: .medium))
                .rotationEffect(.degrees(spinning ? 360 : 0))
                .animation(spinning ? .linear(duration: 1).repeatForever(autoreverses: false) : .default, value: spinning)
                .frame(width: 26, height: 26)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(hovering ? 0.08 : 0)))
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .help(help)
        .onHover { hovering = $0 }
    }
}
