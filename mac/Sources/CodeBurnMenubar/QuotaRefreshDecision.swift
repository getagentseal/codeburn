import Foundation

/// Scheduling decisions for the live quota refresh, kept out of the
/// AppKit-bound refresh loop so they are testable on their own.
enum QuotaRefreshDecision {
    /// The CLI payload half of a tick is gated on local session-file mtimes.
    /// Quota is server-side state (window resets, usage from other machines),
    /// so a tick whose payload was skipped as unchanged still owes the quota
    /// half a run; it self-throttles on SubscriptionRefreshCadence.
    static func needsQuotaOnlyTick(payloadRefreshDue: Bool, payloadSkippedUnchanged: Bool) -> Bool {
        payloadRefreshDue && payloadSkippedUnchanged
    }

    static func isDue(
        force: Bool,
        autoRefreshAllowed: Bool,
        lastAttemptAt: Date?,
        now: Date,
        threshold: TimeInterval
    ) -> Bool {
        if force { return true }
        guard autoRefreshAllowed else { return false }
        return now.timeIntervalSince(lastAttemptAt ?? .distantPast) >= threshold
    }

    /// True when a window's `resetsAt` fell between the previous tick and now.
    /// That boundary is the one moment the provider's numbers are certain to
    /// have moved, and it fires once per reset instant: the tick that sees it
    /// moves `lastCheckedAt` past the boundary.
    static func windowRolledOver(resetDates: [Date], lastCheckedAt: Date, now: Date) -> Bool {
        resetDates.contains { $0 > lastCheckedAt && $0 <= now }
    }
}
