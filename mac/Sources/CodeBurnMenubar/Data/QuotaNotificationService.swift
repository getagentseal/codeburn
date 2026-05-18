import Foundation
import UserNotifications

struct QuotaNotificationEvent: Equatable {
    let provider: String
    let windowLabel: String
    let percent: Int
    let threshold: Int
    let identifier: String
    let keysToMark: [String]

    var title: String {
        "\(provider) quota at \(percent)%"
    }

    var body: String {
        "\(windowLabel) usage has crossed \(threshold)%."
    }
}

enum QuotaNotificationDecider {
    static let keyPrefix = "codeburn.quotaNotification"
    // Keep ascending: event selection uses the highest crossed threshold and
    // marks all lower thresholds when a refresh jumps straight to a higher band.
    private static let thresholds = [80, 100]

    static func events(
        for summaries: [QuotaSummary],
        notifiedKeys: Set<String>,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [QuotaNotificationEvent] {
        events(
            for: summaries,
            isNotified: { notifiedKeys.contains($0) },
            now: now,
            calendar: calendar
        )
    }

    static func events(
        for summaries: [QuotaSummary],
        isNotified: (String) -> Bool,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [QuotaNotificationEvent] {
        summaries.flatMap {
            events(for: $0, isNotified: isNotified, now: now, calendar: calendar)
        }
    }

    private static func events(
        for summary: QuotaSummary,
        isNotified: (String) -> Bool,
        now: Date,
        calendar: Calendar
    ) -> [QuotaNotificationEvent] {
        guard shouldNotify(connection: summary.connection) else { return [] }

        return summary.details.compactMap { window in
            event(for: summary, window: window, isNotified: isNotified, now: now, calendar: calendar)
        }
    }

    private static func event(
        for summary: QuotaSummary,
        window: QuotaSummary.Window,
        isNotified: (String) -> Bool,
        now: Date,
        calendar: Calendar
    ) -> QuotaNotificationEvent? {
        guard window.percent.isFinite else { return nil }

        let percent = Int((max(0, window.percent) * 100).rounded())
        guard let threshold = thresholds.filter({ percent >= $0 }).max() else { return nil }

        // If a refresh jumps from below 80% directly to 100%+, send only the
        // 100% notification but mark lower thresholds too so they do not follow.
        let keysToMark = thresholds
            .filter { $0 <= threshold }
            .map { dedupeKey(provider: summary.providerFilter.cliArg, window: window, threshold: $0, now: now, calendar: calendar) }

        guard let highestKey = keysToMark.last, !isNotified(highestKey) else { return nil }

        return QuotaNotificationEvent(
            provider: summary.providerFilter.rawValue,
            windowLabel: window.label,
            percent: percent,
            threshold: threshold,
            identifier: highestKey,
            keysToMark: keysToMark
        )
    }

    private static func shouldNotify(connection: QuotaSummary.Connection) -> Bool {
        switch connection {
        case .connected: return true
        case .disconnected, .loading, .stale, .transientFailure, .terminalFailure: return false
        }
    }

    static func dedupeKey(
        provider: String,
        window: QuotaSummary.Window,
        threshold: Int,
        now: Date,
        calendar: Calendar = .current
    ) -> String {
        let resetToken = resetToken(for: window.resetsAt, now: now, calendar: calendar)
        return [
            keyPrefix,
            slug(provider),
            slug(window.label),
            String(threshold),
            resetToken,
        ].joined(separator: ".")
    }

    private static func resetToken(for resetsAt: Date?, now: Date, calendar: Calendar) -> String {
        if let resetsAt {
            return "r\(Int(resetsAt.timeIntervalSince1970.rounded()))"
        }
        return "d\(dayToken(for: now, calendar: calendar))"
    }

    private static func slug(_ raw: String) -> String {
        let lower = raw.lowercased()
        let scalars = lower.unicodeScalars.map { scalar -> Character in
            CharacterSet.alphanumerics.contains(scalar) ? Character(scalar) : "-"
        }
        return String(scalars).split(separator: "-").joined(separator: "-")
    }

    private static func dayToken(for date: Date, calendar: Calendar) -> String {
        let components = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", components.year ?? 0, components.month ?? 0, components.day ?? 0)
    }
}

enum QuotaNotificationPreferences {
    static let enabledKey = "CodeBurnQuotaNotificationsEnabled"

    @MainActor
    static var isEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: enabledKey) }
        set { UserDefaults.standard.set(newValue, forKey: enabledKey) }
    }

    @MainActor
    static func setEnabled(_ enabled: Bool) async -> Bool {
        guard enabled else {
            isEnabled = false
            return false
        }

        do {
            let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
            isEnabled = granted
            return granted
        } catch {
            isEnabled = false
            return false
        }
    }
}

@MainActor
final class QuotaNotificationCoordinator {
    private static let retentionSeconds: TimeInterval = 45 * 24 * 60 * 60
    private static let pruneIntervalSeconds: TimeInterval = 24 * 60 * 60

    private let defaults: UserDefaults
    private let center: UNUserNotificationCenter
    private var pendingKeys: Set<String> = []
    private var lastPrunedAt: Date = .distantPast

    init(
        defaults: UserDefaults = .standard,
        center: UNUserNotificationCenter = .current()
    ) {
        self.defaults = defaults
        self.center = center
    }

    func evaluate(store: AppStore) {
        guard QuotaNotificationPreferences.isEnabled else { return }

        let now = Date()
        pruneExpiredKeysIfNeeded(now: now)
        let summaries = ProviderFilter.allCases.compactMap { store.quotaSummary(for: $0) }
        let events = QuotaNotificationDecider.events(
            for: summaries,
            isNotified: { [defaults, pendingKeys] key in
                pendingKeys.contains(key) || defaults.bool(forKey: key)
            },
            now: now
        )
        guard !events.isEmpty else { return }
        events.forEach { pendingKeys.formUnion($0.keysToMark) }

        Task { @MainActor in
            for event in events {
                await schedule(event)
            }
        }
    }

    private func schedule(_ event: QuotaNotificationEvent) async {
        defer {
            event.keysToMark.forEach { pendingKeys.remove($0) }
        }

        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            break
        case .notDetermined:
            QuotaNotificationPreferences.isEnabled = false
            return
        case .denied:
            QuotaNotificationPreferences.isEnabled = false
            return
        @unknown default:
            return
        }

        let content = UNMutableNotificationContent()
        content.title = event.title
        content.body = event.body
        content.sound = .default

        let request = UNNotificationRequest(identifier: event.identifier, content: content, trigger: nil)
        do {
            try await center.add(request)
            mark(event)
        } catch {
            NSLog("CodeBurn: failed to schedule quota notification: \(error)")
        }
    }

    private func mark(_ event: QuotaNotificationEvent) {
        event.keysToMark.forEach { defaults.set(true, forKey: $0) }
    }

    private func pruneExpiredKeysIfNeeded(now: Date) {
        guard now.timeIntervalSince(lastPrunedAt) >= Self.pruneIntervalSeconds else { return }
        lastPrunedAt = now
        pruneExpiredKeys(now: now)
    }

    private func pruneExpiredKeys(now: Date) {
        let cutoff = now.addingTimeInterval(-Self.retentionSeconds)
        let prefix = QuotaNotificationDecider.keyPrefix + "."
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(prefix) {
            guard let token = key.split(separator: ".").last else { continue }
            if let tokenDate = date(fromResetToken: String(token)), tokenDate < cutoff {
                defaults.removeObject(forKey: key)
            }
        }
    }

    private func date(fromResetToken token: String) -> Date? {
        if token.hasPrefix("r"), let seconds = TimeInterval(token.dropFirst()) {
            return Date(timeIntervalSince1970: seconds)
        }

        let rawDay = token.hasPrefix("d") ? String(token.dropFirst()) : token
        let parts = rawDay.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }
}
