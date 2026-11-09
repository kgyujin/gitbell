// 패널을 PNG로 그린다. README 스크린숏과 화면 확인에 쓴다. GitHub에는 요청하지 않는다.
//
//   GitBell.app/Contents/MacOS/GitBell --snapshot out.png [--demo] [--dark] [--by-repo | --unread-first]
//                                      [--settings] [--onboarding]
//   언어를 바꾸려면 뒤에 -AppleLanguages '(en)'을 붙인다.
//
// --demo는 가상 저장소(acme/…)와 가상 사람으로 채운다. 실제 저장소 이름이 이미지에 남지 않게 한다.

import AppKit
import GitBellCore
import SwiftUI

enum SnapshotMode {
    static let isOn = CommandLine.arguments.contains("--snapshot")
}

/// 스냅숏에서는 반투명 재질이 그려지지 않아 단색 배경을 쓴다.
extension View {
    func panelBackground() -> some View {
        Group {
            if SnapshotMode.isOn {
                background(Color(nsColor: .windowBackgroundColor))
            } else {
                background(.regularMaterial)
            }
        }
    }
}

@MainActor
enum SnapshotRenderer {
    static func runIfRequested() {
        let args = CommandLine.arguments
        guard let index = args.firstIndex(of: "--snapshot"), index + 1 < args.count else { return }
        let output = URL(fileURLWithPath: args[index + 1])
        let model = AppModel.shared
        if args.contains("--demo") { model.loadDemo() } else { model.loadSavedStateOnly() }
        model.query = ActivityQuery()
        if args.contains("--by-repo") { model.query.sort = .byRepository }
        if args.contains("--unread-first") { model.query.sort = .unreadFirst }
        if args.contains("--settings") { model.showingSettings = true }
        if args.contains("--update") { model.simulateUpdate("9.9.9") }
        if args.contains("--onboarding") { model.simulateNoToken() }

        let view = PanelView()
            .environmentObject(model)
            .environment(\.colorScheme, args.contains("--dark") ? .dark : .light)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        if let image = renderer.nsImage,
           let tiff = image.tiffRepresentation,
           let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
            try? png.write(to: output)
            print("wrote \(output.path)")
        } else {
            print("snapshot failed")
        }
        exit(0)
    }
}

enum DemoData {
    static func state(now: Date = Date()) -> WatchState {
        func ago(_ minutes: Double) -> Date { now.addingTimeInterval(-minutes * 60) }
        func url(_ path: String) -> URL { URL(string: "https://github.com/\(path)")! }
        var state = WatchState()
        state.me = "you"
        state.lastChecked = ago(1)
        state.checkedRepos = ["acme/web", "acme/api", "acme/design-system", "you/dotfiles"]
        state.history = [
            ActivityEvent(id: "1", repo: "acme/web", kind: .reviewApproved, time: ago(3), actor: "mina",
                          number: 128, title: "Looks great, ship it 🚀", url: url("acme/web/pull/128"), isUnread: true),
            ActivityEvent(id: "2", repo: "acme/api", kind: .prOpened, time: ago(12), actor: "jun",
                          number: 342, title: "Add rate limiting to public endpoints", url: url("acme/api/pull/342"),
                          isUnread: true),
            ActivityEvent(id: "3", repo: "acme/web", kind: .push, time: ago(25), actor: "sora", branch: "feat/search",
                          title: "feat: debounce search input", url: url("acme/web"), commitCount: 3, isUnread: true),
            ActivityEvent(id: "4", repo: "acme/design-system", kind: .reviewChangesRequested, time: ago(48),
                          actor: "lee", number: 57, title: "Button contrast fails WCAG AA in dark mode",
                          url: url("acme/design-system/pull/57")),
            ActivityEvent(id: "9", repo: "acme/design-system", kind: .comment, time: ago(70),
                          actor: "review-helper[bot]", number: 57, title: "Contrast check: 2 issues found",
                          url: url("acme/design-system/pull/57")),
            ActivityEvent(id: "5", repo: "acme/api", kind: .prMerged, time: ago(95), actor: "mina", number: 339,
                          title: "Migrate auth tokens to rotating keys", url: url("acme/api/pull/339")),
            ActivityEvent(id: "6", repo: "acme/web", kind: .comment, time: ago(130), actor: "jun", number: 127,
                          title: "Can we keep the old route as a redirect for a week?", url: url("acme/web/pull/127")),
            ActivityEvent(id: "7", repo: "acme/api", kind: .branchCreated, time: ago(60 * 20), actor: "sora",
                          branch: "fix/timeout", title: "fix: raise upstream timeout to 30s", url: url("acme/api")),
            ActivityEvent(id: "8", repo: "acme/design-system", kind: .prOpened, time: ago(60 * 22), actor: "lee",
                          number: 56, title: "New color tokens for charts", url: url("acme/design-system/pull/56")),
        ]
        return state
    }
}
