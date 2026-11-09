// 패널 안의 설정 화면과, 처음 연결할 때 보이는 안내 화면.
// 계정 연결은 두 가지다: GitHub CLI(gh) 로그인을 그대로 쓰거나, 개인 액세스 토큰을 넣어 키체인에 저장한다.

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

            VStack(alignment: .leading, spacing: 16) {
                SettingsSection(title: "Account") { AccountSection() }

                SettingsSection(title: "General") {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Text("Check every")
                            Spacer()
                            Picker("", selection: $model.refreshMinutes) {
                                ForEach([1, 2, 5, 10, 15], id: \.self) { minutes in
                                    Text(String(format: L10n.string("%lld min"), minutes)).tag(minutes)
                                }
                            }
                            .labelsHidden()
                            .frame(width: 90)
                        }
                        Toggle("Show notifications", isOn: $model.notificationsEnabled)
                        Toggle("Include my own activity", isOn: $model.includeOwnActivity)
                        Toggle("Open at login", isOn: Binding(
                            get: { model.launchAtLogin },
                            set: { model.launchAtLogin = $0 }))
                    }
                    .toggleStyle(.switch)
                    .controlSize(.small)
                }
            }
            .font(.system(size: 12))
            .padding(14)

            Divider()

            HStack {
                Text(verbatim: "GitBell \(appVersion)").foregroundStyle(.secondary)
                Link("GitHub", destination: projectURL)
                Spacer()
                Button("Quit GitBell") { NSApp.terminate(nil) }
                    .controlSize(.small)
            }
            .font(.system(size: 11))
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
        }
    }

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
    }
}

private struct SettingsSection<Content: View>: View {
    let title: LocalizedStringKey
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            content
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.04)))
        }
    }
}

private struct AccountSection: View {
    @EnvironmentObject private var model: AppModel
    @State private var token = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: statusSymbol).foregroundStyle(statusColor)
                Text(statusText)
            }
            if model.tokenSource == .keychain {
                Button("Remove saved token") { model.removeSavedToken() }
                    .controlSize(.small)
            } else {
                TokenField(token: $token) { model.saveToken(token); token = "" }
            }
        }
    }

    private var statusSymbol: String {
        model.tokenSource == nil || model.problem == .unauthorized ? "xmark.circle.fill" : "checkmark.circle.fill"
    }

    private var statusColor: Color {
        model.tokenSource == nil || model.problem == .unauthorized ? .red : .green
    }

    private var statusText: String {
        let login = model.state.me.isEmpty ? "" : " (@\(model.state.me))"
        switch model.tokenSource {
        case .githubCLI: return L10n.string("Connected with GitHub CLI") + login
        case .keychain: return L10n.string("Connected with a personal access token") + login
        case .none: return L10n.string("Not connected")
        }
    }
}

private struct TokenField: View {
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
            Button {
                NSWorkspace.shared.open(tokenCreationURL)
            } label: {
                Text("Create a token on GitHub (repo, notifications, read:org)").foregroundStyle(.tint)
            }
            .buttonStyle(.plain)
            .font(.system(size: 11))
        }
    }
}

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

            Step(number: 1, title: "Already use GitHub CLI?") {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Run this in Terminal, then check again.").foregroundStyle(.secondary)
                    HStack {
                        Text(verbatim: "gh auth login")
                            .font(.system(size: 12, design: .monospaced))
                            .padding(.horizontal, 8).padding(.vertical, 4)
                            .background(RoundedRectangle(cornerRadius: 5).fill(Color.primary.opacity(0.06)))
                            .textSelection(.enabled)
                        Spacer()
                        Button("Check again") { Task { await model.refresh() } }
                            .controlSize(.small)
                    }
                }
            }

            Step(number: 2, title: "Or paste a personal access token") {
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

private struct Step<Content: View>: View {
    let number: Int
    let title: LocalizedStringKey
    @ViewBuilder let content: Content

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Text("\(number)")
                .font(.system(size: 11, weight: .bold))
                .frame(width: 20, height: 20)
                .background(Circle().fill(Color.accentColor.opacity(0.15)))
                .foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.system(size: 12, weight: .semibold))
                content
            }
        }
    }
}
