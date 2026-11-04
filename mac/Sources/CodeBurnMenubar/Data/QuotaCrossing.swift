import Foundation

/// User preference for quota-crossing notifications. Absent key is true,
/// matching `UpdateNotificationPreference`: existing installs get the alert
/// without visiting Settings first.
enum QuotaCrossingPreference {
    static let defaultsKey = "codeburn.quota.crossingNotificationsEnabled"

    static func isEnabled(defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: defaultsKey) as? Bool ?? true
    }

    static let warningPercentKey = "codeburn.quota.crossingWarningPercent"
    static let defaultWarningPercent = 80
    static let warningPercentOptions = [70, 80, 90]

    static func warningPercent(defaults: UserDefaults = .standard) -> Int {
        defaults.object(forKey: warningPercentKey) as? Int ?? defaultWarningPercent
    }
}

/// One provider window as `AppStore.quotaWindows` reports it: the same list the
/// warning banner and the menu-bar flame are built from.
struct QuotaCrossingWindow: Equatable, Sendable {
    let providerName: String
    /// The adapter's own label ("5-hour", "Weekly · Opus"), never translated.
    let label: String
    /// Share of the window used, 0...100; nil when the provider did not report it.
    let percent: Double?
    let resetsAt: Date?
    /// When the provider sample behind this reading was fetched.
    var observedAt: Date? = nil
    /// When the recent-pace forecast says the window runs out.
    var runsOutAt: Date? = nil

    /// One cycle of one window. A window that carries no reset instant cannot
    /// tell one cycle from the next, so it notifies once and then stays quiet.
    /// The instant is bucketed to the minute because Claude's `resets_at`
    /// jitters by a second or two within one window, which would re-arm it.
    var cycleKey: String {
        let stamp = resetsAt.map { String(Int(($0.timeIntervalSince1970 / 60).rounded()) * 60) } ?? "-"
        return "\(providerName)|\(label)|\(stamp)"
    }
}

struct QuotaCrossingEvent: Equatable, Sendable {
    enum Level: String, Sendable {
        case warning
        case limit
        case runsOut
    }

    let providerName: String
    let windowLabel: String
    let level: Level
    /// Fired-set entry and notification identifier: one per level per cycle.
    let key: String
    var warningPercent = QuotaCrossingPreference.defaultWarningPercent
    var runsOutAt: Date? = nil
    var resetsAt: Date? = nil

    var notificationTitle: String {
        switch level {
        case .warning: L("%1$@ · %2$@ at %3$lld%%", providerName, windowLabel, warningPercent)
        case .limit: L("%1$@ · %2$@ limit reached", providerName, windowLabel)
        case .runsOut: L("%1$@ %2$@ runs out at %3$@", providerName, windowLabel, runsOutAt.map { QuotaPace.clockLabel($0) } ?? "")
        }
    }

    var notificationBody: String {
        guard level == .runsOut, let resetsAt else { return "" }
        return L("At this pace. Resets %@.", QuotaPace.clockLabel(resetsAt))
    }
}

/// Decides which windows crossed a notify-worthy threshold. Pure: the fired set
/// goes in and comes back out, so the caller owns persistence and nothing here
/// reads a clock or a default.
enum QuotaCrossingDetector {
    static let limitPercent: Double = 100

    static func evaluate(
        windows: [QuotaCrossingWindow],
        fired: Set<String>,
        warningPercent: Int = QuotaCrossingPreference.defaultWarningPercent
    ) -> (events: [QuotaCrossingEvent], fired: Set<String>) {
        var live = fired
        for window in windows {
            // A window now on a different cycle is re-armed; absence is not a
            // reset, so a provider between fetches keeps what it has fired.
            let prefix = "\(window.providerName)|\(window.label)|"
            let current = window.cycleKey + "|"
            live = live.filter { !$0.hasPrefix(prefix) || $0.hasPrefix(current) }
        }

        var events: [QuotaCrossingEvent] = []
        for window in windows {
            guard let percent = window.percent, percent.isFinite else { continue }
            if let runsOutAt = window.runsOutAt, let resetsAt = window.resetsAt,
               runsOutAt < resetsAt, percent < limitPercent {
                let key = "\(window.cycleKey)|\(QuotaCrossingEvent.Level.runsOut.rawValue)"
                if live.insert(key).inserted {
                    events.append(QuotaCrossingEvent(
                        providerName: window.providerName,
                        windowLabel: window.label,
                        level: .runsOut,
                        key: key,
                        runsOutAt: runsOutAt,
                        resetsAt: resetsAt
                    ))
                }
            }
            guard let level = level(for: percent, warningPercent: warningPercent) else { continue }
            let key = "\(window.cycleKey)|\(level.rawValue)"
            guard live.insert(key).inserted else { continue }
            // Once the window is full the 80% notice is water under the bridge:
            // marking it fired keeps a later reading from posting it after the
            // louder one.
            if level == .limit {
                live.insert("\(window.cycleKey)|\(QuotaCrossingEvent.Level.warning.rawValue)")
            }
            events.append(QuotaCrossingEvent(
                providerName: window.providerName,
                windowLabel: window.label,
                level: level,
                key: key,
                warningPercent: warningPercent
            ))
        }
        return (events, live)
    }

    private static func level(for percent: Double, warningPercent: Int) -> QuotaCrossingEvent.Level? {
        if percent >= limitPercent { return .limit }
        if percent >= Double(warningPercent) { return .warning }
        return nil
    }
}

/// Runs the detector over each quota refresh and posts through the same notifier
/// the update check uses. It adds no polling: the caller invokes it from the
/// existing refresh lifecycle. The fired set lives in `UserDefaults` so a
/// relaunch does not repeat a crossing already announced.
@MainActor
final class QuotaCrossingMonitor {
    static let defaultsKey = "codeburn.quota.crossingsFired"
    nonisolated static let notificationIdentifierPrefix = "QuotaCrossing."

    private let defaults: UserDefaults
    private let makeNotifier: () -> any UpdateNotifier
    private var notifier: (any UpdateNotifier)?

    init(
        defaults: UserDefaults = .standard,
        makeNotifier: @escaping () -> any UpdateNotifier = { SystemUpdateNotifier() }
    ) {
        self.defaults = defaults
        self.makeNotifier = makeNotifier
    }

    @discardableResult
    func record(windows: [QuotaCrossingWindow]) async -> [QuotaCrossingEvent] {
        let stored = Set(defaults.stringArray(forKey: Self.defaultsKey) ?? [])
        let (events, fired) = QuotaCrossingDetector.evaluate(
            windows: windows,
            fired: stored,
            warningPercent: QuotaCrossingPreference.warningPercent(defaults: defaults)
        )
        // Persisted before delivery: a crossing is one-shot even when the user
        // has notifications off or denied.
        defaults.set(Array(fired), forKey: Self.defaultsKey)

        guard !events.isEmpty, QuotaCrossingPreference.isEnabled(defaults: defaults) else { return [] }
        let notifier = notifier ?? makeNotifier()
        self.notifier = notifier
        // Authorization is requested here and nowhere else, so a user who never
        // crosses a threshold is never asked.
        guard await notifier.requestAuthorizationIfNeeded() else { return [] }
        for event in events {
            notifier.post(
                title: event.notificationTitle,
                body: event.notificationBody,
                identifier: Self.notificationIdentifierPrefix + event.key
            )
        }
        return events
    }
}
