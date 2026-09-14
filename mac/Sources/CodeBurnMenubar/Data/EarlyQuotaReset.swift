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

    var notificationTitle: String {
        switch signal {
        case .resetMovedForward: L("%@ quota reset early", providerName)
        case .usageDropped: L("%@ quota cleared early", providerName)
        }
    }

    var notificationBody: String {
        let lead = EarlyQuotaResetFormat.lead(seconds: earlyBySeconds)
        let back = L("You're back to %lld%%.", Int((100 - percentAfter).rounded()))
        switch signal {
        case .resetMovedForward:
            return L(
                "%1$@'s %2$@ reset %3$@ early. %4$@",
                providerName, EarlyQuotaResetFormat.limitName(windowName), lead, back
            )
        // The reset time did not move: the vendor emptied the counter inside the
        // cycle, which still ends when it always would have. Saying "reset early"
        // here would promise a whole new window that is not coming.
        case .usageDropped:
            return L(
                "%1$@ cleared your %2$@ %3$@ before its reset. %4$@",
                providerName, EarlyQuotaResetFormat.usageName(windowName), lead, back
            )
        }
    }

    /// The Capacity Dock band, e.g. "Weekly limit reset 18h early".
    var noticeText: String {
        let lead = EarlyQuotaResetFormat.lead(seconds: earlyBySeconds)
        switch signal {
        case .resetMovedForward:
            return L(
                "%1$@ reset %2$@ early",
                EarlyQuotaResetFormat.capitalizedFirst(EarlyQuotaResetFormat.limitName(windowName)),
                lead
            )
        case .usageDropped:
            let usage = EarlyQuotaResetFormat.usageName(windowName)
            return L("%1$@ cleared, %2$@ before reset", EarlyQuotaResetFormat.capitalizedFirst(usage), lead)
        }
    }

    var noticeHelpText: String {
        let lead = EarlyQuotaResetFormat.lead(seconds: earlyBySeconds)
        let available = L(
            "%lld%% of it was available when CodeBurn noticed.",
            Int((100 - percentAfter).rounded())
        )
        switch signal {
        case .resetMovedForward:
            return L(
                "%1$@ reset this %2$@ %3$@ before its scheduled time. %4$@",
                providerName, EarlyQuotaResetFormat.limitName(windowName), lead, available
            )
        case .usageDropped:
            return L(
                "%1$@ cleared this %2$@ %3$@ before the window's scheduled reset, which has not moved. %4$@",
                providerName, EarlyQuotaResetFormat.usageName(windowName), lead, available
            )
        }
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
            let noun = EarlyQuotaResetFormat.windowNoun(windowName)
            let lead = EarlyQuotaResetFormat.approximateLead(seconds: typicalEarlyBySeconds)
            if earlyResets == 1 && observedResets == 1 {
                return L("Last %1$@ reset came ~%2$@ early", noun, lead)
            }
            if earlyResets == observedResets {
                return L("Last %1$lld %2$@ resets came ~%3$@ early", earlyResets, noun, lead)
            }
            return L(
                "%1$lld of the last %2$lld %3$@ resets came ~%4$@ early",
                earlyResets, observedResets, noun, lead
            )
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

    /// "2d 3h", "18h", "40m" — rounded to the unit it prints, so a lead of
    /// 1h57m reads "2h" rather than truncating to "1h".
    static func lead(seconds: TimeInterval) -> String {
        let seconds = max(0, seconds)
        guard seconds >= 3600 else { return L("%lldm", max(Int((seconds / 60).rounded()), 1)) }
        let hours = Int((seconds / 3600).rounded())
        guard hours >= 24 else { return L("%lldh", hours) }
        let rest = hours % 24
        return rest == 0 ? L("%lldd", hours / 24) : L("%1$lldd %2$lldh", hours / 24, rest)
    }

    /// "18h", "2d" — rounded, for a pattern that is only ever approximate.
    static func approximateLead(seconds: TimeInterval) -> String {
        let hours = Int((max(0, seconds) / 3600).rounded())
        if hours >= 48 { return L("%lldd", Int((seconds / 86400).rounded())) }
        return L("%lldh", max(hours, 1))
    }

    /// The three grammatical forms the copy needs from a window label.
    ///
    /// `EarlyQuotaResetEvent.windowName` is persisted with the event, so it
    /// stays the English name `claudeWindowName(forKey:)` produced and the
    /// translation happens here, at render. Keyed on that English name rather
    /// than by stripping `" limit"` off the end, which is a rule only English
    /// obeys. A label outside the known set — a provider wired up later —
    /// keeps the old suffix behaviour and reads through untranslated.

    /// "weekly limit" -> "weekly limit": the cap itself.
    static func limitName(_ name: String) -> String {
        switch name {
        case "5-hour limit": L("5-hour limit")
        case "weekly limit": L("weekly limit")
        case "Opus weekly limit": L("Opus weekly limit")
        case "Sonnet weekly limit": L("Sonnet weekly limit")
        default: name
        }
    }

    /// "weekly limit" -> "weekly": the bare noun, for copy that supplies its own.
    static func windowNoun(_ name: String) -> String {
        switch name {
        case "5-hour limit": L("5-hour")
        case "weekly limit": L("weekly")
        case "Opus weekly limit": L("Opus weekly")
        case "Sonnet weekly limit": L("Sonnet weekly")
        default: name.hasSuffix(" limit") ? String(name.dropLast(" limit".count)) : name
        }
    }

    /// "weekly limit" -> "weekly usage": what the vendor cleared, not the cap.
    static func usageName(_ name: String) -> String {
        switch name {
        case "5-hour limit": L("5-hour usage")
        case "weekly limit": L("weekly usage")
        case "Opus weekly limit": L("Opus weekly usage")
        case "Sonnet weekly limit": L("Sonnet weekly usage")
        default: L("%@ usage", windowNoun(name))
        }
    }

    static func capitalizedFirst(_ text: String) -> String {
        guard let first = text.first else { return text }
        return first.uppercased() + text.dropFirst()
    }
}
