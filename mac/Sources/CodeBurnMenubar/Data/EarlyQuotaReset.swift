import Foundation

/// User preference for early-quota-reset notifications. Absent key is true,
/// matching `UpdateNotificationPreference`: existing installs get the alert
/// without visiting Settings first.
enum EarlyQuotaResetPreference {
    static let defaultsKey = "codeburn.quota.earlyResetNotificationsEnabled"

    static func isEnabled(defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: defaultsKey) as? Bool ?? true
    }
}

/// One reading of a fixed-cycle quota window, in the snapshot store's units.
struct EarlyQuotaResetReading: Codable, Equatable, Sendable {
    /// Used share of the window, 0...100 — the `SubscriptionSnapshot` scale,
    /// not `QuotaSummary.Window.percent`'s 0...1 fraction.
    let percent: Double
    let resetsAt: Date
    let observedAt: Date

    /// A reading this build can reason about. Anything else is "no opinion".
    var isWellFormed: Bool {
        percent.isFinite && percent >= 0 && percent <= 100
            && resetsAt.timeIntervalSince1970.isFinite
            && observedAt.timeIntervalSince1970.isFinite
    }
}

/// A vendor reset a quota window before its scheduled time.
struct EarlyQuotaResetEvent: Codable, Equatable, Sendable {
    enum Signal: String, Codable, Sendable {
        /// The advertised reset time jumped to a new cycle before the old one ended.
        case resetMovedForward
        /// Usage fell to near-empty while the advertised reset time stood still.
        case usageDropped
    }

    let providerID: String
    let providerName: String
    let windowKey: String
    /// Lower-case noun phrase for copy, e.g. "weekly limit".
    let windowName: String
    let signal: Signal
    /// When the cycle that was cut short had been scheduled to reset.
    let scheduledResetAt: Date
    let detectedAt: Date
    let percentBefore: Double
    let percentAfter: Double

    /// How long before its schedule the reset landed, measured to the fetch
    /// that saw it. The true reset happened at or before `detectedAt`, so this
    /// can understate the lead by one refresh interval, never overstate it.
    var earlyBySeconds: TimeInterval { scheduledResetAt.timeIntervalSince(detectedAt) }

    /// Coalescing key: one event per provider window per cut-short cycle,
    /// whichever signal saw it first.
    var identity: String {
        "\(providerID)|\(windowKey)|\(Int(scheduledResetAt.timeIntervalSince1970.rounded()))"
    }

    var notificationTitle: String { "\(providerName) quota reset early" }

    var notificationBody: String {
        let remaining = Int((100 - percentAfter).rounded())
        return "\(providerName)'s \(windowName) reset "
            + "\(EarlyQuotaResetFormat.lead(seconds: earlyBySeconds)) early. "
            + "You're back to \(remaining)%."
    }

    /// The Capacity Dock band, e.g. "Weekly limit reset 18h early".
    var noticeText: String {
        "\(EarlyQuotaResetFormat.capitalizedFirst(windowName)) reset "
            + "\(EarlyQuotaResetFormat.lead(seconds: earlyBySeconds)) early"
    }

    var noticeHelpText: String {
        let remaining = Int((100 - percentAfter).rounded())
        return "\(providerName) reset this \(windowName) "
            + "\(EarlyQuotaResetFormat.lead(seconds: earlyBySeconds)) before its scheduled time. "
            + "\(remaining)% of it was available when CodeBurn noticed."
    }
}

/// Decides whether two consecutive readings of the same window are an early
/// reset. Pure: every clock value comes from the readings themselves.
///
/// The detector assumes a fixed-cycle window with a validated duration (Claude's
/// 5-hour and 7-day limits). A rolling window's reset time creeps forward on
/// every fetch, which is exactly what signal 1 must not read as a new cycle, so
/// callers must not pass rolling windows and a window without a duration gets
/// no opinion.
enum EarlyQuotaResetDetector {
    /// Anything within this of a boundary is clock or timestamp noise, not a
    /// reset: vendors jitter `resets_at` by seconds between fetches, and local
    /// and vendor clocks disagree by a little.
    static let skewTolerance: TimeInterval = 10 * 60

    /// A new cycle's reset time can sit up to this much earlier than a full
    /// window after our previous observation, because vendors round window
    /// starts. Wider than `skewTolerance` so rounding never hides a real reset.
    static let cycleAnchorTolerance: TimeInterval = 60 * 60

    /// Signal 2 threshold. Inside one cycle, reported usage only rises; it moves
    /// down by rounding noise of a point or two. A goodwill reset zeroes the
    /// window, so we require both a fall of at least 40 points and a landing at
    /// or under 10% — enough slack for a refresh interval of real use after the
    /// reset, and far outside rounding noise. A smaller drop that does not land
    /// near empty is not "you have your capacity back".
    static let minimumPercentDrop: Double = 40
    static let maximumPercentAfterDrop: Double = 10

    struct Context: Equatable, Sendable {
        let providerID: String
        let providerName: String
        let windowKey: String
        let windowName: String
        /// Validated cycle length. Nil means unknown, and unknown means silent.
        let windowSeconds: Int?
        /// Plan label at the previous successful fetch, and now. A different plan
        /// changes capacity legitimately, so it is never an early reset.
        let previousPlanLabel: String?
        let currentPlanLabel: String?
        /// False when the provider is coming back from a disconnect, a terminal
        /// failure or a fresh bootstrap: the previous reading predates the gap and
        /// anything could have happened since.
        let baselineIsTrusted: Bool
    }

    static func detect(
        previous: EarlyQuotaResetReading?,
        current: EarlyQuotaResetReading?,
        context: Context
    ) -> EarlyQuotaResetEvent? {
        // First observation or a window that just appeared: no baseline.
        // A window that disappeared: nothing to announce.
        guard let previous, let current else { return nil }
        guard previous.isWellFormed, current.isWellFormed else { return nil }
        guard context.baselineIsTrusted else { return nil }
        guard context.previousPlanLabel == context.currentPlanLabel else { return nil }
        guard let seconds = context.windowSeconds, seconds > 0 else { return nil }
        let window = TimeInterval(seconds)

        let now = current.observedAt
        // Clock went backwards between fetches.
        guard now >= previous.observedAt else { return nil }
        // Same discipline as `QuotaPace`: a reset in the past, or further out
        // than one full window, is clock or data skew. Say nothing.
        let currentRemaining = current.resetsAt.timeIntervalSince(now)
        guard currentRemaining > 0, currentRemaining <= window + skewTolerance else { return nil }
        let lead = previous.resetsAt.timeIntervalSince(now)
        guard lead <= window + skewTolerance else { return nil }
        // The stored reset has passed, or is about to: a scheduled reset. This is
        // the common case and must stay silent.
        guard lead >= skewTolerance else { return nil }

        let jump = current.resetsAt.timeIntervalSince(previous.resetsAt)

        // Signal 1: a new cycle began while the old one still had time left.
        if jump >= skewTolerance {
            // A new fixed cycle starts no earlier than our last look at the old
            // one, so it cannot reset sooner than a window after that look. A
            // reset time that merely creeps forward is not a new cycle.
            let anchoredToNewCycle = current.resetsAt
                >= previous.observedAt.addingTimeInterval(window - cycleAnchorTolerance)
            guard anchoredToNewCycle else { return nil }
            // A reset that gives nothing back is not free capacity.
            guard current.percent < previous.percent else { return nil }
            return event(.resetMovedForward, previous: previous, current: current, context: context)
        }

        // Signal 2: the reset time held still but usage emptied. A backwards
        // move of the reset time is neither signal.
        guard abs(jump) < skewTolerance else { return nil }
        guard previous.percent - current.percent >= minimumPercentDrop,
              current.percent <= maximumPercentAfterDrop else { return nil }
        return event(.usageDropped, previous: previous, current: current, context: context)
    }

    private static func event(
        _ signal: EarlyQuotaResetEvent.Signal,
        previous: EarlyQuotaResetReading,
        current: EarlyQuotaResetReading,
        context: Context
    ) -> EarlyQuotaResetEvent {
        EarlyQuotaResetEvent(
            providerID: context.providerID,
            providerName: context.providerName,
            windowKey: context.windowKey,
            windowName: context.windowName,
            signal: signal,
            scheduledResetAt: previous.resetsAt,
            detectedAt: current.observedAt,
            percentBefore: previous.percent,
            percentAfter: current.percent
        )
    }
}

/// How long the Capacity Dock keeps an early-reset band on screen.
enum EarlyQuotaResetNotice {
    static let visibleSeconds: TimeInterval = 12 * 3600

    static func isVisible(_ event: EarlyQuotaResetEvent, now: Date) -> Bool {
        let age = now.timeIntervalSince(event.detectedAt)
        // A detection stamped in the future is skew, not a fresh event.
        guard age.isFinite, age >= -EarlyQuotaResetDetector.skewTolerance else { return false }
        return age <= visibleSeconds
    }
}

/// A user's own record of early resets for one window, derived from the
/// 30 days of snapshots already on disk. Local only.
enum EarlyQuotaResetHistory {
    /// Leads shorter than this are not claimed as a pattern: window starts are
    /// rounded by vendors, so a sub-hour gap is not evidence of anything.
    static let minimumLeadSeconds: TimeInterval = 60 * 60

    struct Summary: Equatable, Sendable {
        let windowKey: String
        let windowName: String
        /// Consecutive cycle transitions the store can see for this window.
        let observedResets: Int
        let earlyResets: Int
        /// Median lead across the early resets.
        let typicalEarlyBySeconds: TimeInterval

        /// Hover-card caption, e.g. "Last 3 weekly resets came ~18h early".
        var caption: String {
            let noun = windowName.hasSuffix(" limit")
                ? String(windowName.dropLast(" limit".count))
                : windowName
            let lead = EarlyQuotaResetFormat.approximateLead(seconds: typicalEarlyBySeconds)
            if earlyResets == 1 && observedResets == 1 {
                return "Last \(noun) reset came ~\(lead) early"
            }
            if earlyResets == observedResets {
                return "Last \(earlyResets) \(noun) resets came ~\(lead) early"
            }
            return "\(earlyResets) of the last \(observedResets) \(noun) resets came ~\(lead) early"
        }
    }

    /// The store keeps one entry per window cycle holding the cycle's highest
    /// reading, so the moment a new cycle was first seen is not recoverable from
    /// `capturedAt`. The reset times are: a fixed window that starts at moment t
    /// resets at t + window, so a cycle that followed an early reset ends sooner
    /// than a full window after the previous cycle's scheduled end. The lead is
    /// `previous.resetsAt + window - next.resetsAt`.
    ///
    /// Short windows (at or under `QuotaPace.etaSuppressionMaxSeconds`) get no
    /// summary, for the same reason they get no pace ETA: rounding of their start
    /// times is a large share of the window.
    static func summarize(
        snapshots: [SubscriptionSnapshot],
        windowKey: String,
        windowName: String,
        windowSeconds: Int?
    ) -> Summary? {
        guard let seconds = windowSeconds, seconds > 0 else { return nil }
        let window = TimeInterval(seconds)
        guard window > QuotaPace.etaSuppressionMaxSeconds else { return nil }

        let resets = snapshots
            .filter { $0.windowKey == windowKey }
            .map(\.resetsAt)
            .filter { $0.timeIntervalSince1970.isFinite }
            .sorted()
        // Jittered timestamps of one cycle collapse to that cycle's latest.
        var cycles: [Date] = []
        for reset in resets {
            if let last = cycles.last,
               reset.timeIntervalSince(last) < EarlyQuotaResetDetector.skewTolerance {
                cycles[cycles.count - 1] = reset
            } else {
                cycles.append(reset)
            }
        }
        guard cycles.count >= 2 else { return nil }

        var observed = 0
        var leads: [TimeInterval] = []
        for (earlier, later) in zip(cycles, cycles.dropFirst()) {
            let gap = later.timeIntervalSince(earlier)
            // A gap longer than a window means cycles went unobserved (app closed,
            // idle between short windows); that pair says nothing about timing.
            guard gap <= window + EarlyQuotaResetDetector.cycleAnchorTolerance else { continue }
            observed += 1
            let lead = window - gap
            if lead >= minimumLeadSeconds { leads.append(lead) }
        }
        guard !leads.isEmpty else { return nil }
        return Summary(
            windowKey: windowKey,
            windowName: windowName,
            observedResets: observed,
            earlyResets: leads.count,
            typicalEarlyBySeconds: median(leads)
        )
    }

    private static func median(_ values: [TimeInterval]) -> TimeInterval {
        let sorted = values.sorted()
        let mid = sorted.count / 2
        return sorted.count % 2 == 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
    }
}

/// Window names and lead formatting shared by the notification, the dock band
/// and the history caption.
enum EarlyQuotaResetFormat {
    /// Copy names for the Claude windows the snapshot store records.
    static func claudeWindowName(forKey key: String) -> String {
        switch key {
        case "five_hour": "5-hour limit"
        case "seven_day": "weekly limit"
        case "seven_day_opus": "Opus weekly limit"
        case "seven_day_sonnet": "Sonnet weekly limit"
        default: key
        }
    }

    /// "2d 3h", "18h", "40m" — precise enough for a single event.
    static func lead(seconds: TimeInterval) -> String {
        let minutes = Int(max(0, seconds) / 60)
        let hours = minutes / 60
        if hours >= 24 {
            let rest = hours % 24
            return rest == 0 ? "\(hours / 24)d" : "\(hours / 24)d \(rest)h"
        }
        if hours >= 1 { return "\(hours)h" }
        return "\(max(minutes, 1))m"
    }

    /// "18h", "2d" — rounded, for a pattern that is only ever approximate.
    static func approximateLead(seconds: TimeInterval) -> String {
        let hours = Int((max(0, seconds) / 3600).rounded())
        if hours >= 48 { return "\(Int((seconds / 86400).rounded()))d" }
        return "\(max(hours, 1))h"
    }

    static func capitalizedFirst(_ text: String) -> String {
        guard let first = text.first else { return text }
        return first.uppercased() + text.dropFirst()
    }
}
