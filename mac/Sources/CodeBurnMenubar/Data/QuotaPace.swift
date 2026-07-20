import Foundation

/// Pure pace math for a quota window (#726 phase 1): whole-window linear
/// extrapolation plus the noise guards that keep it honest. Deliberately no
/// recent-burst weighting or smoothing — with only (used%, resetsAt, window
/// length) to go on, the average pace over the elapsed window is the only
/// rate we can defend.
enum QuotaPace {
    struct Result: Equatable {
        /// used% − expected%; positive means ahead of pace (in deficit).
        let deltaPercent: Double
        /// Linear projection of used% at the reset boundary.
        let projectedPercent: Double
        let willOverflow: Bool
        /// When the window hits 100% at the current pace. Nil when there is
        /// no overflow, or when the window is short enough that a linear ETA
        /// would cry wolf (one heavy burst on a 5h window reads as "runs out
        /// in 40min", then recovers). Deficit/reserve still shows there.
        let hitsLimitAt: Date?
    }

    /// Windows at or under this length get deficit/reserve only, no ETA.
    static let etaSuppressionMaxSeconds: TimeInterval = 6 * 3600
    /// Show nothing until this fraction of the window has elapsed: projecting
    /// a whole week off the first few minutes is noise, not signal.
    static let minimumElapsedFraction = 0.03

    static func evaluate(
        usedPercent: Double,
        resetsAt: Date?,
        windowSeconds: Int,
        now: Date = Date()
    ) -> Result? {
        guard let resetsAt, windowSeconds > 0 else { return nil }
        let duration = TimeInterval(windowSeconds)
        let remaining = resetsAt.timeIntervalSince(now)
        // Reset in the past, or further out than one full window: clock or
        // data skew. Say nothing rather than something wrong.
        guard remaining > 0, remaining <= duration else { return nil }
        let elapsed = duration - remaining
        let elapsedFraction = elapsed / duration
        guard elapsedFraction >= minimumElapsedFraction else { return nil }
        let used = min(max(usedPercent, 0), 100)
        // Exhausted window: the bar already says everything.
        guard used < 100 else { return nil }

        let delta = used - elapsedFraction * 100
        let projected = used / elapsedFraction
        var hitsLimitAt: Date?
        if projected > 100, duration > etaSuppressionMaxSeconds {
            let percentPerSecond = used / elapsed
            if percentPerSecond > 0 {
                hitsLimitAt = now.addingTimeInterval((100 - used) / percentPerSecond)
            }
        }
        return Result(
            deltaPercent: delta,
            projectedPercent: projected,
            willOverflow: projected > 100,
            hitsLimitAt: hitsLimitAt
        )
    }
}
