import Foundation

/// Pure pace math for a quota window (#726 phase 1): whole-window linear
/// extrapolation plus the noise guards that keep it honest, and a run-out
/// forecast from the recent readings. The whole-window average gives no ETA:
/// a quiet morning hides a busy afternoon, so only the recent pace dates one.
enum QuotaPace {
    struct Result: Equatable {
        /// used% − expected%; positive means ahead of pace (in deficit).
        let deltaPercent: Double
        /// Linear projection of used% at the reset boundary.
        let projectedPercent: Double
        let willOverflow: Bool
    }

    /// One poll's reading of one window, `percent` in 0...100.
    struct Reading: Equatable, Sendable {
        let percent: Double
        let resetsAt: Date
        let observedAt: Date
    }

    enum Forecast: Equatable, Sendable {
        case runsOut(at: Date)
        case lastsUntilReset
    }

    /// Windows at or under this length get deficit/reserve only, no
    /// projection, and the short forecast lookback.
    static let etaSuppressionMaxSeconds: TimeInterval = 6 * 3600
    /// A reading whose reset sits further than this from the window's own is
    /// another cycle.
    static let sameCycleTolerance: TimeInterval = 120
    static let shortWindowLookback: TimeInterval = 3600
    static let longWindowLookback: TimeInterval = 6 * 3600
    static let minimumForecastSpan: TimeInterval = 10 * 60
    static let minimumForecastRise: Double = 2
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
        return Result(
            deltaPercent: delta,
            projectedPercent: projected,
            willOverflow: projected > 100
        )
    }

    /// When the window runs out at the pace of its recent readings. Nil when
    /// the readings are too few, too close together or too flat to date it,
    /// and when the window is already full.
    static func forecast(readings: [Reading], resetsAt: Date, now: Date = Date()) -> Forecast? {
        var cycle = readings
            .filter { abs($0.resetsAt.timeIntervalSince(resetsAt)) <= sameCycleTolerance && $0.observedAt <= now }
            .sorted { $0.observedAt < $1.observedAt }
        // No window length is passed in, so a reading taken more than the
        // short-window limit before its reset is what marks a long window.
        let isLongWindow = cycle.contains { $0.resetsAt.timeIntervalSince($0.observedAt) > etaSuppressionMaxSeconds }
        if let fall = cycle.indices.dropFirst().last(where: { cycle[$0].percent < cycle[$0 - 1].percent }) {
            cycle = Array(cycle[fall...])
        }
        let lookback = isLongWindow ? longWindowLookback : shortWindowLookback
        cycle = cycle.filter { $0.observedAt >= now.addingTimeInterval(-lookback) }
        guard let first = cycle.first, let last = cycle.last, last.percent < 100 else { return nil }
        let elapsed = last.observedAt.timeIntervalSince(first.observedAt)
        let rise = last.percent - first.percent
        guard cycle.count >= 2, elapsed >= minimumForecastSpan, rise >= minimumForecastRise else { return nil }
        let eta = last.observedAt.addingTimeInterval((100 - last.percent) * elapsed / rise)
        return eta >= resetsAt ? .lastsUntilReset : .runsOut(at: eta)
    }

    /// "15:40" when `date` falls today, "Tue 09:10" otherwise, in local time.
    static func clockLabel(_ date: Date, now: Date = Date()) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = Calendar.current.isDate(date, inSameDayAs: now) ? "HH:mm" : "EEE HH:mm"
        return formatter.string(from: date)
    }
}
