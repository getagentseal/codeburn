import Foundation

/// Countdown wording shared by the Capacity Dock, the popover quota rows and
/// the reset notices, plus Claude's fixed window lengths.
enum QuotaPacePresentation {
    /// Claude's rate-limit windows are fixed lengths (the same values the
    /// plan popover projects with), so they are validated durations.
    static let claudeFiveHourSeconds = 5 * 3600
    static let claudeSevenDaySeconds = 7 * 24 * 3600

    /// "2d 3h" / "3h 20m" / "45m" / "<1m", mirroring the window column's own
    /// countdown shape. Computed against the passed dates, never a hidden
    /// wall clock, so fixtures stay deterministic.
    static func countdownLabel(from now: Date, to date: Date) -> String {
        countdownLabel(seconds: date.timeIntervalSince(now))
    }

    /// Countdown label for an already-computed interval (clamped at zero).
    static func countdownLabel(seconds: TimeInterval) -> String {
        let value = max(0, seconds)
        if value < 60 { return L("<1m") }
        let minutes = Int(value / 60)
        let hours = minutes / 60
        let days = hours / 24
        // Same three keys the popover's reset countdown uses.
        if days > 0 { return L("%1$lldd %2$lldh", days, hours % 24) }
        if hours > 0 { return L("%1$lldh %2$lldm", hours, minutes % 60) }
        return L("%lldm", minutes)
    }
}
