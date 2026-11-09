// macOS 알림. 알림을 누르면 해당 GitHub 페이지가 열리고 그 항목은 읽음이 된다.
// 한 번에 새 항목이 많으면(5개 초과) 요약 알림 하나로 묶는다.

import AppKit
import GitBellCore
import UserNotifications

final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()
    private let individualLimit = 5

    /// 앱 번들 없이(`swift run`) 실행하면 알림 센터를 쓸 수 없어 건너뛴다.
    private var isAvailable: Bool { Bundle.main.bundleIdentifier != nil }

    func setUp() {
        guard isAvailable else { return }
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    func post(_ events: [ActivityEvent]) {
        guard isAvailable, !events.isEmpty else { return }
        let center = UNUserNotificationCenter.current()
        if events.count > individualLimit {
            let content = UNMutableNotificationContent()
            content.title = "GitBell"
            content.subtitle = String(format: L10n.string("%lld new activities"), events.count)
            content.body = Array(Set(events.map(\.repoName))).sorted().joined(separator: ", ")
            content.userInfo = ["url": "https://github.com/notifications"]
            content.sound = .default
            center.add(UNNotificationRequest(identifier: "summary-\(UUID())", content: content, trigger: nil))
            return
        }
        for event in events {
            let content = UNMutableNotificationContent()
            content.title = event.repoName
            content.subtitle = L10n.headline(event)
            content.body = L10n.title(event)
            content.userInfo = ["url": event.url.absoluteString, "id": event.id]
            content.threadIdentifier = event.repo
            content.sound = .default
            center.add(UNNotificationRequest(identifier: event.id, content: content, trigger: nil))
        }
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
