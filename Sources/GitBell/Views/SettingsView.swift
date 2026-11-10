// 패널 안의 설정 화면과, 처음 연결할 때 보이는 안내 화면.
//
// 설정은 네 묶음이다: 계정 / 알림(전체·소리·종류별·권한·테스트) / 목록(내 활동·봇·숫자·숨긴 저장소) / 일반(간격·자동 실행)
// 스위치와 간격 칩은 직접 그린다. 시스템 컨트롤보다 촘촘하게 놓을 수 있고 스냅숏에도 그려진다.

import GitBellCore
import SwiftUI

/// 토큰 만들기 페이지. 필요한 권한(repo, notifications, read:org)을 미리 골라 둔다.
let tokenCreationURL = URL(string: "https://github.com/settings/tokens/new?scopes=repo,notifications,read:org&description=GitBell")!
let projectURL = URL(string: "https://github.com/kgyujin/gitbell")!

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                IconButton(symbol: "chevron.left", help: "Back") { model.showingSettings = false }
                Text("Settings").font(.system(size: 14, weight: .bold))
                Spacer()
            }
            .padding(.horizontal, 10)
            .padding(.top, 10)
            .padding(.bottom, 6)

            Divider()

            if SnapshotMode.isOn {
                sections
            } else {
                ScrollView { sections }.frame(height: 560)
            }

            Divider()
            AboutFooter()
        }
    }

    private var sections: some View {
        VStack(alignment: .leading, spacing: 18) {
            SettingsSection(title: L10n.string("Account")) { AccountSection() }
            SettingsSection(title: L10n.string("Notifications")) { NotificationSection() }
            SettingsSection(title: L10n.string("List")) { ListSection() }
            SettingsSection(title: L10n.string("General")) { GeneralSection() }
        }
        .font(.system(size: 12))
        .padding(14)
    }
}

// MARK: - 묶음

private struct NotificationSection: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SwitchRow(symbol: "bell.badge", title: L10n.string("Notify me"), isOn: $model.notificationPrefs.isEnabled)
            RowDivider()
            SwitchRow(symbol: "speaker.wave.2", title: L10n.string("Play sound"), isOn: $model.notificationPrefs.playsSound)
                .disabledLook(!model.notificationPrefs.isEnabled)
            RowDivider()
            SwitchRow(symbol: "person.crop.circle.badge.checkmark", title: L10n.string("Notify only for my pull requests"),
                      subtitle: L10n.string("Reviews, comments, merges and pushes on PRs you opened. The list isn't affected."),
                      isOn: $model.notificationPrefs.onlyMyPullRequests)
                .disabledLook(!model.notificationPrefs.isEnabled)
            RowDivider()
            VStack(alignment: .leading, spacing: 0) {
                Text("Notify about")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .padding(.top, 8)
                    .padding(.bottom, 2)
                ForEach(NotificationGroup.allCases, id: \.self) { group in
                    SwitchRow(symbol: group.symbol, tint: group.tint, title: L10n.groupLabel(group),
                              subtitle: L10n.groupDetail(group),
                              isOn: Binding(get: { model.notificationPrefs.groups.contains(group) },
                                            set: { model.setGroup(group, enabled: $0) }),
                              compact: true)
                }
            }
            .disabledLook(!model.notificationPrefs.isEnabled)
            RowDivider()
            PermissionRow()
        }
    }
}

private struct PermissionRow: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        HStack(spacing: 8) {
            switch model.notificationAuthorization {
            case .allowed, .unknown:
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                Text("macOS notifications are allowed").foregroundStyle(.secondary)
            case .denied:
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                Text("Notifications are turned off in macOS")
                Spacer()
                LinkButton(title: L10n.string("Open System Settings")) { model.openNotificationSettings() }
            case .notAsked:
                Image(systemName: "questionmark.circle.fill").foregroundStyle(.secondary)
                Text("GitBell hasn't asked for permission yet")
                Spacer()
                LinkButton(title: L10n.string("Allow")) { model.requestNotificationPermission() }
            }
            if model.notificationAuthorization == .allowed || model.notificationAuthorization == .unknown {
                Spacer()
                PillButton(symbol: "paperplane", title: L10n.string("Send test")) { model.sendTestNotification() }
            }
        }
        .font(.system(size: 11))
        .padding(.vertical, 8)
        // 시스템 설정에서 알림을 켜고 돌아오면 2초 안에 이 줄이 바뀐다.
        .onAppear { model.refreshNotificationAuthorization() }
        .onReceive(Timer.publish(every: 2, on: .main, in: .common).autoconnect()) { _ in
            model.refreshNotificationAuthorization()
        }
    }
}

private struct ListSection: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SwitchRow(symbol: "person", title: L10n.string("Include my own activity"), isOn: $model.includeOwnActivity)
            RowDivider()
            SwitchRow(symbol: "cpu", title: L10n.string("Hide bot activity"), subtitle: L10n.string("Accounts ending in [bot], like CI or review bots"),
                      isOn: $model.display.hidesBots)
            RowDivider()
            SwitchRow(symbol: "number", title: L10n.string("Show unread count in menu bar"), isOn: $model.showsCountInMenuBar)
            RowDivider()
            HiddenRepositories()
        }
    }
}

private struct HiddenRepositories: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: "eye.slash").foregroundStyle(.secondary).frame(width: 16)
                Text("Hidden repositories")
                Spacer()
                Text("\(model.display.hiddenRepositories.count)").foregroundStyle(.secondary)
            }
            if model.display.hiddenRepositories.isEmpty {
                Text("Right-click an item to hide its repository.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .padding(.leading, 24)
            } else {
                ForEach(model.display.hiddenRepositories.sorted(), id: \.self) { repo in
                    HStack {
                        Text(verbatim: repo).font(.system(size: 11)).lineLimit(1).truncationMode(.middle)
                        Spacer()
                        LinkButton(title: L10n.string("Show")) { model.showRepository(repo) }
                    }
                    .padding(.leading, 24)
                }
            }
        }
        .padding(.vertical, 8)
    }
}

private struct GeneralSection: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "arrow.clockwise").foregroundStyle(.secondary).frame(width: 16)
                Text("Check every")
                Spacer()
                HStack(spacing: 4) {
                    ForEach([1, 2, 5, 10, 15], id: \.self) { minutes in
                        SegmentChip(title: String(format: L10n.string("%lld min"), minutes),
                                    isSelected: model.refreshMinutes == minutes) { model.refreshMinutes = minutes }
                    }
                }
            }
            .padding(.vertical, 8)
            RowDivider()
            SwitchRow(symbol: "power", title: L10n.string("Open at login"), isOn: Binding(
                get: { model.launchAtLogin }, set: { model.launchAtLogin = $0 }))
            if model.launchAtLoginNeedsAttention {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    Text("Allow GitBell in System Settings → General → Login Items.")
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 4)
                    LinkButton(title: L10n.string("Open Login Items")) { model.openLoginItemsSettings() }
                }
                .font(.system(size: 11))
                .padding(.leading, 24)
                .padding(.bottom, 8)
            }
        }
        .onAppear { model.refreshLaunchAtLoginStatus() }
    }
}

private struct AccountSection: View {
    @EnvironmentObject private var model: AppModel
    @State private var token = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: statusSymbol).foregroundStyle(statusColor).frame(width: 16)
                Text(statusText)
                Spacer()
                if model.tokenSource == .keychain {
                    LinkButton(title: L10n.string("Remove saved token")) { model.removeSavedToken() }
                }
            }
            if model.tokenSource != .keychain && model.tokenSource != .githubCLI {
                TokenField(token: $token) { model.saveToken(token); token = "" }
            }
        }
        .padding(.vertical, 8)
    }

    private var isConnected: Bool { model.tokenSource != nil && model.problem != .unauthorized }
    private var statusSymbol: String { isConnected ? "checkmark.circle.fill" : "xmark.circle.fill" }
    private var statusColor: Color { isConnected ? .green : .red }

    private var statusText: String {
        let login = model.state.me.isEmpty ? "" : " · @\(model.state.me)"
        switch model.tokenSource {
        case .githubCLI: return L10n.string("Connected with GitHub CLI") + login
        case .keychain: return L10n.string("Connected with a personal access token") + login
        case .none: return L10n.string("Not connected")
        }
    }
}

private struct AboutFooter: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        HStack(spacing: 8) {
            Text(verbatim: "GitBell \(appVersion)").foregroundStyle(.secondary)
            if let update = model.availableUpdate {
                Text(String(format: L10n.string("%@ available"), update))
                    .font(.system(size: 10, weight: .semibold))
                    .padding(.horizontal, 6).padding(.vertical, 1)
                    .background(Capsule().fill(Color.accentColor.opacity(0.15)))
                    .foregroundStyle(.tint)
            }
            LinkButton(title: L10n.string("GitHub")) { NSWorkspace.shared.open(projectURL) }
            Spacer()
            PillButton(symbol: "power", title: L10n.string("Quit GitBell")) { NSApp.terminate(nil) }
        }
        .font(.system(size: 11))
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
    }
}

// MARK: - 처음 연결 안내

struct OnboardingView: View {
    @EnvironmentObject private var model: AppModel
    @State private var token = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Connect your GitHub account").font(.system(size: 15, weight: .bold))
                Text("GitBell reads your repositories and notifications to show pull requests, reviews, merges and commits.")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Step(number: 1, title: L10n.string("Already use GitHub CLI?")) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Run this in Terminal, then check again.").foregroundStyle(.secondary)
                    HStack {
                        Text(verbatim: "gh auth login")
                            .font(.system(size: 12, design: .monospaced))
                            .padding(.horizontal, 8).padding(.vertical, 4)
                            .background(RoundedRectangle(cornerRadius: 5).fill(Color.primary.opacity(0.06)))
                            .textSelection(.enabled)
                        Spacer()
                        PillButton(symbol: "arrow.clockwise", title: L10n.string("Check again")) { Task { await model.refresh() } }
                    }
                }
            }

            Step(number: 2, title: L10n.string("Or paste a personal access token")) {
                TokenField(token: $token) { model.saveToken(token); token = "" }
            }

            Text("Your token is stored only in the macOS Keychain on this Mac.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
        }
        .font(.system(size: 12))
        .padding(16)
    }
}

private struct TokenField: View {
    @EnvironmentObject private var model: AppModel
    @Binding var token: String
    let onSave: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                SecureField("ghp_…", text: $token)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(onSave)
                Button("Save", action: onSave)
                    .disabled(token.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            if model.tokenSaveFailed {
                Text("Couldn't save the token. Try again.")
                    .font(.system(size: 11))
                    .foregroundStyle(.red)
            }
            LinkButton(title: L10n.string("Create a token on GitHub (repo, notifications, read:org)")) {
                NSWorkspace.shared.open(tokenCreationURL)
            }
            .font(.system(size: 11))
        }
    }
}

private struct Step<Content: View>: View {
    let number: Int
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Text("\(number)")
                .font(.system(size: 11, weight: .bold))
                .frame(width: 20, height: 20)
                .background(Circle().fill(Color.accentColor.opacity(0.15)))
                .foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 6) {
                Text(verbatim: title).font(.system(size: 12, weight: .semibold))
                content
            }
        }
    }
}

// MARK: - 부품

private struct SettingsSection<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: title)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
                .padding(.leading, 4)
            content
                .padding(.horizontal, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.05)))
        }
    }
}

private struct RowDivider: View {
    var body: some View { Divider().padding(.leading, 24) }
}

/// 아이콘 · 제목(· 설명) · 스위치 한 줄. 줄 어디를 눌러도 켜고 끈다.
private struct SwitchRow: View {
    var symbol: String?
    var tint: Color?
    let title: String
    var subtitle: String?
    @Binding var isOn: Bool
    var compact = false

    init(symbol: String? = nil, tint: Color? = nil, title: String, subtitle: String? = nil,
         isOn: Binding<Bool>, compact: Bool = false) {
        self.symbol = symbol
        self.tint = tint
        self.title = title
        self.subtitle = subtitle
        self._isOn = isOn
        self.compact = compact
    }


    var body: some View {
        HStack(spacing: 8) {
            if let symbol {
                Image(systemName: symbol)
                    .foregroundStyle(tint ?? .secondary)
                    .frame(width: 16)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: title)
                if let subtitle {
                    Text(verbatim: subtitle).font(.system(size: 10)).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            MiniSwitch(isOn: isOn)
        }
        .padding(.vertical, compact ? 5 : 8)
        .contentShape(Rectangle())
        .onTapGesture { isOn.toggle() }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityValue(isOn ? Text("On") : Text("Off"))
    }
}

private struct MiniSwitch: View {
    let isOn: Bool

    var body: some View {
        ZStack(alignment: isOn ? .trailing : .leading) {
            Capsule()
                .fill(isOn ? Color.accentColor : Color.primary.opacity(0.18))
                .frame(width: 30, height: 18)
            Circle()
                .fill(Color.white)
                .shadow(color: .black.opacity(0.2), radius: 1, y: 0.5)
                .frame(width: 14, height: 14)
                .padding(2)
        }
        .animation(.easeOut(duration: 0.15), value: isOn)
    }
}

private struct SegmentChip: View {
    let title: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(verbatim: title)
                .font(.system(size: 11, weight: isSelected ? .semibold : .regular))
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .foregroundStyle(isSelected ? Color.white : Color.primary)
                .background(RoundedRectangle(cornerRadius: 5)
                    .fill(isSelected ? Color.accentColor : Color.primary.opacity(0.07)))
        }
        .buttonStyle(.plain)
    }
}

struct LinkButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) { Text(verbatim: title).foregroundStyle(.tint) }
            .buttonStyle(.plain)
    }
}

struct PillButton: View {
    let symbol: String
    let title: String
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: symbol).font(.system(size: 10, weight: .semibold))
                Text(verbatim: title)
            }
            .font(.system(size: 11, weight: .medium))
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(Capsule().fill(Color.primary.opacity(hovering ? 0.12 : 0.07)))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

private extension View {
    /// 상위 스위치가 꺼져 있을 때 흐리게 보이고 누를 수 없게 한다.
    func disabledLook(_ disabled: Bool) -> some View {
        opacity(disabled ? 0.4 : 1).allowsHitTesting(!disabled)
    }
}


extension NotificationGroup {
    var symbol: String {
        switch self {
        case .newPullRequests: return EventKind.prOpened.symbol
        case .merges: return EventKind.prMerged.symbol
        case .reviews: return "eye"
        case .comments: return EventKind.comment.symbol
        case .commits: return EventKind.push.symbol
        }
    }

    var tint: Color {
        switch self {
        case .newPullRequests: return EventKind.prOpened.tint
        case .merges: return EventKind.prMerged.tint
        case .reviews: return EventKind.reviewApproved.tint
        case .comments: return EventKind.comment.tint
        case .commits: return EventKind.push.tint
        }
    }
}
