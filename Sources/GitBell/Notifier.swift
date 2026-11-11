// macOS 알림. 알림을 누르면 해당 GitHub 페이지가 열리고 그 항목은 읽음이 된다.
// 한 번에 새 항목이 많으면(5개 초과) 요약 알림 하나로 묶는다. 어떤 항목을 알릴지는 AppModel이 고른다.
// GitBell에서 읽음으로 바꾼 항목의 알림은 알림 센터에서도 지운다(removeDelivered).

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
            content.subtitle = L10n.format("%lld new activities", events.count)
            content.body = Array(Set(events.map(\.repoName))).sorted().joined(separator: ", ")
            content.userInfo = ["url": "https://github.com/notifications"]
            // 같은 이름으로 보내 새 요약이 예전 요약을 바꿔 쓴다(확인할 때마다 요약이 쌓이지 않게).
            add(content, id: Self.summaryID, playsSound: playsSound)
            return
        }
        // 한 번에 여러 개가 오면 소리는 첫 알림에서 한 번만 낸다.
        for (index, event) in events.enumerated() {
            let content = UNMutableNotificationContent()
            content.title = event.repoName
            content.subtitle = L10n.headline(event)
            content.body = L10n.title(event)
            content.userInfo = ["url": event.url.absoluteString, "id": event.id]
            content.threadIdentifier = event.repo
            add(content, id: event.id, playsSound: playsSound && index == 0)
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

    /// 새 버전 알림. 누르면 업데이트 명령을 복사한다(메뉴 막대 패널은 코드로 열 수 없어 바로 복사한다).
    func postUpdate(version: String, playsSound: Bool) {
        guard isAvailable else { return }
        let content = UNMutableNotificationContent()
        content.title = "GitBell"
        content.subtitle = String(format: L10n.string("GitBell %@ is available"), version)
        content.body = L10n.string("Click to copy the update command (npx gitbell@latest).")
        content.userInfo = ["action": Self.copyUpdateAction]
        add(content, id: "update-\(version)", playsSound: playsSound)
    }

    private static let copyUpdateAction = "copyUpdateCommand"
    /// 여러 항목을 묶은 요약 알림의 이름. 하나만 두고 새 요약이 바꿔 쓴다.
    static let summaryID = "summary"

    /// 읽은 항목의 알림을 알림 센터에서 지운다. includeSummaries면 요약 알림도 지운다.
    func removeDelivered(ids: [String], includeSummaries: Bool) {
        guard isAvailable else { return }
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: ids)
        guard includeSummaries else { return }
        center.getDeliveredNotifications { delivered in
            // 예전 버전은 요약마다 'summary-<UUID>'로 따로 보냈다. 그것까지 함께 지운다.
            let summaries = delivered.map(\.request.identifier).filter { $0.hasPrefix(Notifier.summaryID) }
            if !summaries.isEmpty { center.removeDeliveredNotifications(withIdentifiers: summaries) }
        }
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
        if info["action"] as? String == Self.copyUpdateAction {
            Task { @MainActor in AppModel.shared.copyUpdateCommand() }
        }
        if let link = info["url"] as? String, let url = URL(string: link) {
            AppModel.openHTTPS(url)
        }
        if let id = info["id"] as? String {
            Task { @MainActor in AppModel.shared.markOpened(id) }
        }
        completionHandler()
    }
}
