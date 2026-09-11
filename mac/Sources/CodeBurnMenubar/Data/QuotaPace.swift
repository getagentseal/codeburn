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

extension QuotaPace {
    /// The one-line "am I going to make it?" answer for surfaces with no room
    /// for the Plan tab's deficit/reserve caption: the Capacity Dock's window
    /// columns and the agent-tab hover card (#1215). Same projection as #726 —
    /// `evaluate` stays the only math here — reduced to a verdict.
    struct Verdict: Equatable {
        let text: String
        /// Drives the warning tint; the text alone already says which way it went.
        let willOverflow: Bool
    }

    static func verdict(
        usedPercent: Double,
        resetsAt: Date?,
        windowSeconds: Int,
        now: Date = Date()
    ) -> Verdict? {
        guard let result = evaluate(
            usedPercent: usedPercent,
            resetsAt: resetsAt,
            windowSeconds: windowSeconds,
            now: now
        ) else { return nil }
        guard result.willOverflow else {
            return Verdict(text: "Lasts until reset", willOverflow: false)
        }
        // An overflowing window without an ETA is one `evaluate` suppressed for
        // being too short to extrapolate (<= 6h). Say it won't last rather than
        // invent a minute-precision deadline off a single burst.
        guard let hitsLimitAt = result.hitsLimitAt else {
            return Verdict(text: "Won't last until reset", willOverflow: true)
        }
        let countdown = countdownLabel(seconds: hitsLimitAt.timeIntervalSince(now))
        return Verdict(text: "Runs out in \(countdown)", willOverflow: true)
    }

    /// "2d 3h" / "4h 12m" / "8m" / "now" — the same shape as the reset
    /// countdown both surfaces already print beside the bar.
    static func countdownLabel(seconds: TimeInterval) -> String {
        let seconds = max(0, seconds)
        if seconds < 60 { return "now" }
        let minutes = Int(seconds / 60)
        let hours = minutes / 60
        let days = hours / 24
        if days > 0 { return "\(days)d \(hours % 24)h" }
        if hours > 0 { return "\(hours)h \(minutes % 60)m" }
        return "\(minutes)m"
    }

    /// Window length implied by a normalized provider label ("Weekly",
    /// "5-hour", "Weekly · Opus", "Monthly usage limit"). The adapters derive
    /// those labels from the exact API durations, so the round trip is lossless
    /// except for calendar months, which are measured back from the reset date
    /// in UTC the way the Codex spend window is (a local calendar would make
    /// pace timezone-dependent). An unrecognized label returns nil, which keeps
    /// the verdict silent rather than guessing a window.
    static func inferredWindowSeconds(label: String, resetsAt: Date?) -> Int? {
        for component in label.components(separatedBy: "·") {
            if let seconds = windowSeconds(forComponent: component, resetsAt: resetsAt) {
                return seconds
            }
        }
        return nil
    }

    private static func windowSeconds(forComponent component: String, resetsAt: Date?) -> Int? {
        let token = component.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        // Only the leading word carries the duration: the credit window's label
        // is "Monthly usage limit", not "Monthly".
        guard let head = token.components(separatedBy: " ").first, !head.isEmpty else { return nil }
        switch head {
        case "minutely":        return 60
        case "hourly", "hour":  return 3600
        case "daily":           return 86_400
        case "weekly":          return 604_800
        case "monthly":         return calendarMonthSeconds(endingAt: resetsAt, months: 1)
        default:                break
        }
        // "5-hour", "3-day", "2-week", "90-min", and the spelled-out form some
        // providers send ("Five-hour").
        let parts = head.components(separatedBy: "-")
        guard parts.count == 2, let count = wholeNumber(parts[0]), count > 0 else { return nil }
        switch parts[1] {
        case "min", "mins", "minute", "minutes": return count * 60
        case "hour", "hours":                    return count * 3600
        case "day", "days":                      return count * 86_400
        case "week", "weeks":                    return count * 604_800
        case "month", "months":                  return calendarMonthSeconds(endingAt: resetsAt, months: count)
        default:                                 return nil
        }
    }

    private static let spelledNumbers = [
        "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
        "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12
    ]

    private static func wholeNumber(_ text: String) -> Int? {
        Int(text) ?? spelledNumbers[text]
    }

    /// Mirrors `CodexSubscriptionService.monthlyWindowSeconds`: the window is
    /// the month preceding the reset, measured in UTC.
    private static func calendarMonthSeconds(endingAt resetsAt: Date?, months: Int) -> Int? {
        guard let resetsAt, months > 0 else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0) ?? .gmt
        guard let start = calendar.date(byAdding: .month, value: -months, to: resetsAt) else { return nil }
        let seconds = Int(resetsAt.timeIntervalSince(start))
        return seconds > 0 ? seconds : nil
    }
}
