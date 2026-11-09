// macOS 알림. 알림을 누르면 해당 GitHub 페이지가 열리고 그 항목은 읽음이 된다.
// 한 번에 새 항목이 많으면(5개 초과) 요약 알림 하나로 묶는다. 어떤 항목을 알릴지는 AppModel이 고른다.

import AppKit
import GitBellCore
import UserNotifications

final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()
    private let individualLimit = 5

    /// 앱 번들 없이(`swift run`) 실행하면 알림 센터를 쓸 수 없어 건너뛴다.
    private var isAvailable: Bool { Bundle.main.bundleIdentifier != nil && !SnapshotMode.isOn }

    func setUp() {
        guard isAvailable else { return }
        UNUserNotificationCenter.current().delegate = self
        requestAuthorization {}
    }

    func requestAuthorization(_ completion: @escaping @Sendable () -> Void) {
        guard isAvailable else { return completion() }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in completion() }
    }

    func post(_ events: [ActivityEvent], playsSound: Bool) {
        guard isAvailable, !events.isEmpty else { return }
        if events.count > individualLimit {
            let content = UNMutableNotificationContent()
            content.title = "GitBell"
            content.subtitle = String(format: L10n.string("%lld new activities"), events.count)
            content.body = Array(Set(events.map(\.repoName))).sorted().joined(separator: ", ")
            content.userInfo = ["url": "https://github.com/notifications"]
            add(content, id: "summary-\(UUID())", playsSound: playsSound)
            return
        }
        for event in events {
            let content = UNMutableNotificationContent()
            content.title = event.repoName
            content.subtitle = L10n.headline(event)
            content.body = L10n.title(event)
            content.userInfo = ["url": event.url.absoluteString, "id": event.id]
            content.threadIdentifier = event.repo
            add(content, id: event.id, playsSound: playsSound)
        }
    }

    /// 설정 화면의 '테스트 알림 보내기'.
    func postTest(playsSound: Bool) {
        guard isAvailable else { return }
        let content = UNMutableNotificationContent()
        content.title = "GitBell"
        content.subtitle = L10n.string("Test notification")
        content.body = L10n.string("Notifications are working. Click to open GitHub.")
        content.userInfo = ["url": "https://github.com/notifications"]
        add(content, id: "test-\(UUID())", playsSound: playsSound)
    }

    private func add(_ content: UNMutableNotificationContent, id: String, playsSound: Bool) {
        content.sound = playsSound ? .default : nil
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        if let link = info["url"] as? String, let url = URL(string: link) {
            NSWorkspace.shared.open(url)
        }
        if let id = info["id"] as? String {
            Task { @MainActor in AppModel.shared.markRead(id) }
        }
        completionHandler()
    }
}
