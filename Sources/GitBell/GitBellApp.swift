// 앱 진입점. Dock 아이콘 없이 메뉴 막대에만 사는 앱이다(Info.plist의 LSUIElement).
// 메뉴 막대 아이콘을 누르면 창 형태의 패널(PanelView)이 열린다.

import AppKit
import SwiftUI

@main
struct GitBellApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel.shared

    var body: some Scene {
        MenuBarExtra {
            PanelView()
                .environmentObject(model)
        } label: {
            MenuBarLabel(unread: model.unreadCount, showsCount: model.showsCountInMenuBar,
                         hasProblem: model.problem?.isBlocking == true)
        }
        .menuBarExtraStyle(.window)
    }
}

struct MenuBarLabel: View {
    let unread: Int
    let showsCount: Bool
    let hasProblem: Bool

    var body: some View {
        if hasProblem {
            Image(systemName: "bell.slash")
        } else if unread > 0 && !showsCount {
            Image(systemName: "bell.badge.fill")
        } else if unread > 0 {
            HStack(spacing: 2) {
                Image(systemName: "bell.badge.fill")
                Text("\(unread)")
            }
        } else {
            Image(systemName: "bell")
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // `swift run`으로 띄울 때도 Dock에 나타나지 않게 한다.
        NSApp.setActivationPolicy(.accessory)
        // --snapshot이면 패널을 PNG로 그리고 바로 끝낸다(Snapshot.swift).
        MainActor.assumeIsolated { SnapshotRenderer.runIfRequested() }
        Notifier.shared.setUp()
        Task { @MainActor in AppModel.shared.start() }
        installEscapeKey()
    }

    /// Esc를 단계별로 처리한다(Windows판과 같은 순서): 검색 닫기 → 설정에서 뒤로 → 패널 닫기.
    /// 검색창에 커서가 없을 때도 동작하도록 패널 창의 키 입력을 직접 본다.
    private func installEscapeKey() {
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            guard event.keyCode == 53, event.modifierFlags.intersection([.command, .option, .control, .shift]).isEmpty,
                  let window = event.window else { return event }
            // 화면 상태는 메인 액터에서만 바꾼다. 이벤트 자체는 밖으로 넘기지 않는다.
            let closesWindow = MainActor.assumeIsolated { () -> Bool in
                let model = AppModel.shared
                if model.showingSearch {
                    model.query.search = ""
                    model.showingSearch = false
                    return false
                }
                if model.showingSettings {
                    model.showingSettings = false
                    return false
                }
                return true
            }
            if closesWindow { window.close() }
            return nil
        }
    }
}
