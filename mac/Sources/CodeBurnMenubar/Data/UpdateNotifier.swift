import Foundation
import UserNotifications

/// User preference for proactive update notifications. Absent key is true, so
/// existing installs get the notification without visiting Settings first.
enum UpdateNotificationPreference {
    static let defaultsKey = "codeburn.update.notificationsEnabled"

    static func isEnabled(defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: defaultsKey) as? Bool ?? true
    }
}

/// The notification side of the update check, behind a protocol so tests never
/// reach `UNUserNotificationCenter.current()`, which aborts in a process that is
/// not an app bundle (`swift test`, `swift run`).
@MainActor
protocol UpdateNotifier: AnyObject {
    func requestAuthorizationIfNeeded() async -> Bool
    func post(title: String, body: String, identifier: String)
}

@MainActor
final class SystemUpdateNotifier: UpdateNotifier {
    func requestAuthorizationIfNeeded() async -> Bool {
        guard Bundle.main.bundleIdentifier != nil else { return false }
        let center = UNUserNotificationCenter.current()
        switch await center.notificationSettings().authorizationStatus {
        case .authorized, .provisional:
            return true
        case .notDetermined:
            do {
                return try await center.requestAuthorization(options: [.alert])
            } catch {
                NSLog("CodeBurn: notification authorization failed: \(error)")
                return false
            }
        default:
            return false
        }
    }

    func post(title: String, body: String, identifier: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request, withCompletionHandler: nil)
    }
}
