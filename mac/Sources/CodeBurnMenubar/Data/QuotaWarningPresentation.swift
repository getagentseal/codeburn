import Foundation

/// One provider as the popover's quota warning banner and the menu-bar flame
/// see it: the single window nearest its limit, carried with that window's own
/// label and reset so the banner can say which limit it means.
///
/// Both used to receive only a provider name and a bare percentage. That
/// percentage is the worst of several windows, so "Claude 70% of quota used"
/// sat beside a usage panel reading 5-hour 71% and weekly 34%, and looked wrong
/// whichever of the two the reader compared it with.
struct QuotaWarning: Equatable, Sendable {
    let name: String
    /// Share of the window used, 0...100 (not the 0...1 `QuotaSummary.Window` uses).
    let percent: Double
    /// The window's label as the adapter reports it ("5-hour", "Weekly · Opus").
    /// Provider data, so never translated; the Plan tab and the Capacity Dock
    /// print the same text. Nil when the adapter supplies none.
    let windowLabel: String?
    let resetsAt: Date?

    init(name: String, percent: Double, windowLabel: String? = nil, resetsAt: Date? = nil) {
        self.name = name
        self.percent = percent
        self.windowLabel = windowLabel
        self.resetsAt = resetsAt
    }

    /// One window a provider reports, before the worst one is picked.
    struct Candidate: Equatable, Sendable {
        let label: String
        /// 0...100; nil when the provider did not report this window.
        let percent: Double?
        let resetsAt: Date?
    }

    /// The provider's window nearest exhaustion, or nil when none is above zero.
    ///
    /// Ties keep the earlier window, which is what `max()` over the bare
    /// percentages did, so carrying the label cannot change the flame's
    /// severity. A non-finite reading is a broken sample, not a limit.
    static func worst(name: String, windows: [Candidate]) -> QuotaWarning? {
        var best: Candidate?
        var bestPercent = 0.0
        for window in windows {
            guard let percent = window.percent, percent.isFinite, percent > bestPercent else { continue }
            best = window
            bestPercent = percent
        }
        guard let best else { return nil }
        return QuotaWarning(
            name: name,
            percent: bestPercent,
            windowLabel: best.label,
            resetsAt: best.resetsAt
        )
    }
}

enum QuotaWarningPresentation {
    /// A provider joins the banner at this share of any one window.
    static let warningThreshold: Double = 70

    /// Severity for the flame and the banner (the worst provider's worst
    /// window), and the providers at or above `warningThreshold`, busiest first.
    static func aggregate(
        _ providers: [QuotaWarning]
    ) -> (severity: QuotaSummary.Severity, warnings: [QuotaWarning]) {
        let worst = providers.map(\.percent).max() ?? 0
        let severity = QuotaSummary.severity(for: worst / 100)
        let warnings = providers
            .sorted { $0.percent > $1.percent }
            .filter { $0.percent >= warningThreshold }
        return (severity, warnings)
    }

    /// The banner text, one line per warning provider:
    /// `Claude · 5-hour 71% · resets in 3h 12m`.
    ///
    /// Providers used to share one line joined by " · ". Each now carries its
    /// own " · "-separated window and reset, so a shared line would read as a
    /// run of fragments with no way to tell where the next provider starts.
    static func message(for warnings: [QuotaWarning], now: Date = Date()) -> String {
        warnings.map { line(for: $0, now: now) }.joined(separator: "\n")
    }

    static func line(for warning: QuotaWarning, now: Date = Date()) -> String {
        let percent = Int(warning.percent.rounded())
        let subject: String
        if let label = warning.windowLabel?.trimmingCharacters(in: .whitespacesAndNewlines),
           !label.isEmpty {
            subject = "\(warning.name) · \(label)"
        } else {
            subject = warning.name
        }
        // "Over limit" only once the window really is. Severity turns `.danger`
        // at 90%, and "over limit (93%)" is not true.
        var text = warning.percent >= 100
            ? L("%1$@ over limit (%2$lld%%)", subject, percent)
            : "\(subject) \(percent)%"
        if let countdown = resetCountdown(warning.resetsAt, now: now) {
            text += " · " + L("resets in %@", countdown)
        }
        return text
    }

    /// The Capacity Dock's own countdown (`QuotaPacePresentation.countdownLabel`),
    /// so the banner and the dock word a reset identically. Nil when there is
    /// no reset instant or it has already passed: a reading taken before a
    /// reset says nothing about when the next one is, and "resets in <1m" for
    /// a window that reset an hour ago would be false.
    static func resetCountdown(_ resetsAt: Date?, now: Date) -> String? {
        guard let resetsAt else { return nil }
        let remaining = resetsAt.timeIntervalSince(now)
        guard remaining.isFinite, remaining > 0 else { return nil }
        return QuotaPacePresentation.countdownLabel(seconds: remaining)
    }
}
