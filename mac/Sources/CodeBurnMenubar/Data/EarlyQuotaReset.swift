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
    /// Absolute usage in the provider's own units, when the adapter reports
    /// one. The ratio alone cannot tell the two ways usage percent falls: a
    /// vendor clearing the counter (a goodwill reset) and a vendor raising the
    /// limit (a spend-cap increase) both drop it. Optional so records written
    /// before the field existed still decode.
    var usedUnits: Double?

    init(percent: Double, resetsAt: Date, observedAt: Date, usedUnits: Double? = nil) {
        self.percent = percent
        self.resetsAt = resetsAt
        self.observedAt = observedAt
        self.usedUnits = usedUnits
    }

    /// A reading this build can reason about. Anything else is "no opinion".
    var isWellFormed: Bool {
        percent.isFinite && percent >= 0 && percent <= 100
            && resetsAt.timeIntervalSince1970.isFinite
            && observedAt.timeIntervalSince1970.isFinite
            && (usedUnits == nil || usedUnits!.isFinite)
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
}

/// Decides whether two consecutive readings of the same window are an early
/// reset. Pure: every clock value comes from the readings themselves.
///
/// The detector assumes a fixed-cycle window with a duration the ADAPTER has
/// validated as fixed (Claude's 5-hour and 7-day constants, Codex's
/// `limitWindowSeconds`). A rolling window's reset time creeps forward on every
/// fetch, and no pair of readings can tell a rolling re-anchor observed across
/// a gap from a genuine cut-short cycle: both move the reset forward by the
/// elapsed time and both can drop the percent. The exclusion of rolling
/// windows is therefore the `windowSeconds` contract itself — an adapter that
/// cannot vouch for a fixed cycle passes nil, and a window without a duration
/// gets no opinion.
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
            // A successor cycle began when the vendor cut the old one short —
            // after our last look at it, by definition of this pair — so its
            // reset sits at or after (last look + one window), minus rounding.
            // This is what rejects a same-cycle nudge (the vendor moving its
            // reset a few hours later inside the ONE cycle: the "successor"
            // that implies began before our last look). It cannot reject a
            // rolling window's re-anchor, whose implied start is always "now":
            // for that shape the anchor holds for any observation gap, and the
            // exclusion is the windowSeconds contract, not this test (see the
            // type doc).
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
        // A spend-cap increase is not a goodwill reset: the limit grew, the
        // ratio fell, and the absolute usage did not. When the provider
        // reports absolute units, require them to fall too; percent-only
        // providers (Claude) keep the ratio test.
        if let before = previous.usedUnits, let after = current.usedUnits {
            guard after < before else { return nil }
        }
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

/// Window names and lead formatting for the notification.
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

    /// Storage identity for a window that has no key of its own. Claude's
    /// windows keep the snapshot store's keys; Codex identifies its windows by
    /// a label slugified here. The label MUST be pre-localized English —
    /// adapters whose display label translates or carries state pass
    /// `QuotaSummary.Window.storageLabel` instead, and the caller prefers it —
    /// because a slug of a translated string both drops the stored baseline on
    /// a language switch and lets two translated siblings collide on one key.
    ///
    /// Callers must pass a label with something in it; a blank one is skipped
    /// before it reaches here.
    static func windowKey(forLabel label: String) -> String {
        var slug = ""
        var pendingSeparator = false
        for scalar in label.lowercased().unicodeScalars {
            if CharacterSet.alphanumerics.contains(scalar) {
                if pendingSeparator { slug.append("_") }
                slug.unicodeScalars.append(scalar)
                pendingSeparator = false
            } else if !slug.isEmpty {
                pendingSeparator = true
            }
        }
        return slug.isEmpty ? "window" : slug
    }

    /// Copy noun for a window named only by its display label. A label that
    /// already says what it caps ("Monthly usage limit") keeps its own noun; one
    /// that names only a period ("Weekly", "5-hour") gains "limit" so the
    /// notification reads as a sentence.
    ///
    /// English, like `claudeWindowName(forKey:)`, because this is the name that
    /// is persisted with the event: `limitName`, `usageName` and `windowNoun`
    /// translate it at render.
    static func windowName(forLabel label: String) -> String {
        let trimmed = label
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard !trimmed.isEmpty else { return trimmed }
        return trimmed.hasSuffix("limit") ? trimmed : "\(trimmed) limit"
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

    /// The three grammatical forms the copy needs from a window label.
    ///
    /// `EarlyQuotaResetEvent.windowName` is persisted with the event, so it
    /// stays the English name `claudeWindowName(forKey:)` produced and the
    /// translation happens here, at render. Keyed on that English name rather
    /// than by stripping `" limit"` off the end, which is a rule only English
    /// obeys. A label outside the known set — Codex's, composed by
    /// `windowName(forLabel:)` — keeps the suffix behaviour: the provider's noun
    /// reads through untranslated and only the word this file added to it is
    /// routed, the same shape `usageName` already used for its default.

    /// "weekly limit" -> "weekly limit": the cap itself.
    static func limitName(_ name: String) -> String {
        switch name {
        case "5-hour limit": L("5-hour limit")
        case "weekly limit": L("weekly limit")
        case "Opus weekly limit": L("Opus weekly limit")
        case "Sonnet weekly limit": L("Sonnet weekly limit")
        default: name.hasSuffix(" limit")
            ? L("%@ limit", String(name.dropLast(" limit".count)))
            : name
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
    /// A name outside the known set whose noun already says "usage" — Codex's
    /// "monthly usage limit" — is left alone rather than doubled into
    /// "monthly usage usage".
    static func usageName(_ name: String) -> String {
        switch name {
        case "5-hour limit": return L("5-hour usage")
        case "weekly limit": return L("weekly usage")
        case "Opus weekly limit": return L("Opus weekly usage")
        case "Sonnet weekly limit": return L("Sonnet weekly usage")
        default:
            let noun = windowNoun(name)
            return noun.hasSuffix("usage") ? noun : L("%@ usage", noun)
        }
    }
}
