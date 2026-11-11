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
            // 목록 화면의 위쪽 줄(HeaderView)과 여백을 같게 해, 화면을 바꿔도 제목이 제자리에 있게 한다.
            // '뒤로' 단추는 단추(26pt) 속 화살표가 14pt 여백에 오도록 왼쪽으로 당긴다.
            HStack(spacing: 4) {
                IconButton(symbol: "chevron.left", help: "Back") { model.showingSettings = false }
                    .padding(.leading, -6.5)
                Text("Settings").font(.system(size: 14, weight: .bold))
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.top, 12)
            .padding(.bottom, 8)

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
            // 다른 줄과 같은 선 아이콘(속이 찬 아이콘은 혼자 무거워 보였다).
            SwitchRow(symbol: "person.crop.circle", title: L10n.string("Notify only for my pull requests"),
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
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).frame(width: 16)
                Text("macOS notifications are allowed").foregroundStyle(.secondary)
            case .denied:
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange).frame(width: 16)
                Text("Notifications are turned off in macOS")
                Spacer()
                LinkButton(title: L10n.string("Open System Settings"), opensOutside: true) { model.openNotificationSettings() }
            case .notAsked:
                Image(systemName: "questionmark.circle.fill").foregroundStyle(.secondary).frame(width: 16)
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
        // 패널이 떠 있는 동안에만 돈다. 설정 화면에 둔 채 패널을 닫으면 화면이 남아 있어도 멈춘다(CPU를 깨우지 않는다).
        .task(id: model.isPanelVisible) {
            guard model.isPanelVisible else { return }
            while !Task.isCancelled {
                model.refreshNotificationAuthorization()
                try? await Task.sleep(nanoseconds: 2 * 1_000_000_000)
            }
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
            // 다른 설정 줄(SwitchRow)과 같은 모양: 아이콘 · 제목과 10pt 설명 · 오른쪽 값.
            HStack(spacing: 8) {
                Image(systemName: "eye.slash").foregroundStyle(.secondary).frame(width: 16).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Hidden repositories")
                    if model.display.hiddenRepositories.isEmpty {
                        Text("Right-click an item to hide its repository.")
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                Text("\(model.display.hiddenRepositories.count)").foregroundStyle(.secondary)
            }
            if !model.display.hiddenRepositories.isEmpty {
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
                Image(systemName: "arrow.clockwise").foregroundStyle(.secondary).frame(width: 16).accessibilityHidden(true)
                Text("Check every")
                Spacer()
                HStack(spacing: 4) {
                    ForEach([1, 2, 5, 10, 15], id: \.self) { minutes in
                        SegmentChip(title: String(format: L10n.string("%lld min"), minutes),
                                    isSelected: model.refreshMinutes == minutes) { model.refreshMinutes = minutes }
                    }
                }
                // VoiceOver가 '1분'만 읽지 않고 '확인 간격' 묶음 안의 고르기로 읽게 한다.
                .accessibilityElement(children: .contain)
                .accessibilityLabel(Text("Check every"))
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
                    LinkButton(title: L10n.string("Open Login Items"), opensOutside: true) { model.openLoginItemsSettings() }
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
            if isExpired {
                // 만료된 토큰을 여기서 바로 바꿀 수 있게 한다. 저장한 토큰이 GitHub CLI보다 먼저 쓰이므로
                // CLI 로그인이 만료됐을 때도 새 토큰을 붙여넣으면 바로 이어진다.
                Text(model.tokenSource == .githubCLI
                     ? L10n.string("Run gh auth login again, or paste a new token below.")
                     : L10n.string("Paste a new token below."))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 24)
            }
            if model.tokenSource == nil || isExpired {
                TokenField(token: $token) { model.saveToken(token); token = "" }
            }
        }
        .padding(.vertical, 8)
    }

    private var isExpired: Bool { model.tokenSource != nil && model.problem == .unauthorized }
    private var isConnected: Bool { model.tokenSource != nil && !isExpired }
    private var statusSymbol: String { isConnected ? "checkmark.circle.fill" : "xmark.circle.fill" }
    private var statusColor: Color { isConnected ? .green : .red }

    private var statusText: String {
        let login = model.state.me.isEmpty ? "" : " · @\(model.state.me)"
        if isExpired {
            return model.tokenSource == .githubCLI
                ? L10n.string("The GitHub CLI login has expired.")
                : L10n.string("The saved token is invalid or expired.")
        }
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
            LinkButton(title: L10n.string("GitHub"), opensOutside: true) { NSWorkspace.shared.open(projectURL) }
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
                        PillButton(symbol: "arrow.clockwise", title: L10n.string("Check again")) { Task { await model.refreshNow() } }
                    }
                }
            }

            Step(number: 2, title: L10n.string("Or paste a personal access token")) {
                TokenField(token: $token) { model.saveToken(token); token = "" }
            }

            Label("Your token is stored only in the macOS Keychain on this Mac.", systemImage: "lock.fill")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
        }
        .font(.system(size: 12))
        // 다른 화면과 같은 14pt 가로 여백.
        .padding(.horizontal, 14)
        .padding(.vertical, 16)
    }
}

private struct TokenField: View {
    @EnvironmentObject private var model: AppModel
    @Binding var token: String
    let onSave: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                // 자리표시 글(ghp_…)은 이름이 아니라서 VoiceOver용 이름을 따로 준다.
                SecureField("Personal access token", text: $token, prompt: Text(verbatim: "ghp_…"))
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
            LinkButton(title: L10n.string("Create a token on GitHub (repo, notifications, read:org)"), opensOutside: true) {
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
        // 번호 원을 제목 글자와 같은 줄 높이에 맞춘다(.top이면 원이 제목보다 3pt쯤 아래로 처졌다).
        HStack(alignment: .firstTextBaseline, spacing: 10) {
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
/// 단추로 만들어 키보드(전체 키보드 접근)로도 고르고 켜고 끌 수 있다. VoiceOver에는 켜짐·꺼짐 값으로 읽힌다.
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
        Button { isOn.toggle() } label: {
            HStack(spacing: 8) {
                if let symbol {
                    Image(systemName: symbol)
                        .foregroundStyle(tint ?? .secondary)
                        .frame(width: 16)
                        .accessibilityHidden(true)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: title)
                    if let subtitle {
                        Text(verbatim: subtitle).font(.system(size: 10)).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 8)
                MiniSwitch(isOn: isOn).accessibilityHidden(true)
            }
            .padding(.vertical, compact ? 5 : 8)
            .contentShape(Rectangle())
        }
        // 꺼진 상태의 흐림은 disabledLook이 맡는다. .plain은 쓸 수 없는 단추를 한 번 더 흐리게 그려 글자가 거의 안 보여서,
        // 모양을 바꾸지 않는 단추 모양을 쓴다.
        .buttonStyle(RowButtonStyle())
        .accessibilityElement(children: .combine)
        .accessibilityValue(isOn ? Text("On") : Text("Off"))
        .modifier(ToggleTrait())
    }
}

/// 눌러도 모양이 바뀌지 않는 단추 모양(줄 전체가 단추인 설정 줄).
private struct RowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { configuration.label }
}

/// macOS 14부터 있는 '켜고 끄는 단추' 특성. 그 전 버전에서는 일반 단추와 켜짐·꺼짐 값으로 읽힌다.
private struct ToggleTrait: ViewModifier {
    func body(content: Content) -> some View {
        if #available(macOS 14.0, *) {
            content.accessibilityAddTraits(.isToggle)
        } else {
            content
        }
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
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

struct LinkButton: View {
    let title: String
    /// 글자 앞에 붙는 아이콘(예: 설정 열기의 톱니).
    var symbol: String?
    /// 앱 밖(브라우저·시스템 설정)으로 나가는 링크면 글자 뒤에 '바깥으로' 아이콘을 붙인다.
    var opensOutside = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            // 간격 4: IconText·Windows판 .with-icon과 같은 아이콘·글자 간격.
            HStack(spacing: 4) {
                if let symbol { Image(systemName: symbol).imageScale(.small).accessibilityHidden(true) }
                Text(verbatim: title)
                if opensOutside { Image(systemName: "arrow.up.right.square").imageScale(.small).accessibilityHidden(true) }
            }
            // 눌러 무언가를 하는 강조색 글자(링크·되돌리기·읽음 표시 등)는 모두 medium으로 맞춘다.
            .fontWeight(.medium)
            .foregroundStyle(.tint)
        }
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
                Image(systemName: symbol).font(.system(size: 10, weight: .semibold)).accessibilityHidden(true)
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
    /// disabled로 막아야 키보드와 VoiceOver에도 '사용할 수 없음'으로 보인다(누름만 막으면 켜져 있는 것처럼 읽혔다).
    func disabledLook(_ disabled: Bool) -> some View {
        opacity(disabled ? 0.4 : 1).disabled(disabled)
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
