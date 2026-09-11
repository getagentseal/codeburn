import Foundation
import CoreGraphics

/// What the optional second menu-bar row shows. Every case is a figure the app
/// already computes for the popover — the second row only re-renders it, so no
/// case can introduce a new fetch or a new refresh cadence.
enum MenubarSecondRowMetric: String, CaseIterable, Identifiable, Sendable {
    /// Quota remaining plus reset countdown for the primary connected provider.
    case quotaRemaining
    /// Today's all-provider cost.
    case todayCost
    /// Today's all-provider input + output tokens.
    case todayTokens
    /// Sessions the CLI reported as live in its liveness window.
    case activeSessions

    var id: String { rawValue }

    /// Settings picker label.
    var settingsLabel: String {
        switch self {
        case .quotaRemaining: "Quota remaining"
        case .todayCost: "Today's cost"
        case .todayTokens: "Today's tokens"
        case .activeSessions: "Active sessions"
        }
    }
}

/// The persisted row configuration. The first row is never configurable here:
/// it stays the existing Metric/Period/Scope badge, so an off setting leaves
/// the historical single-row title untouched.
struct MenubarRowSettings: Equatable, Sendable {
    var isSecondRowEnabled: Bool
    var secondRowMetric: MenubarSecondRowMetric

    static let `default` = MenubarRowSettings(
        isSecondRowEnabled: false,
        secondRowMetric: .quotaRemaining
    )

    init(
        isSecondRowEnabled: Bool = false,
        secondRowMetric: MenubarSecondRowMetric = .quotaRemaining
    ) {
        self.isSecondRowEnabled = isSecondRowEnabled
        self.secondRowMetric = secondRowMetric
    }
}

/// UserDefaults storage for the row settings, in the same shape as the other
/// menubar preferences (`CodeBurnMenubarPeriod`, `CodeBurnMenubarScope`,
/// `CodeBurnDisplayMetric`): a string-keyed value in the app's own domain, read
/// through a small loader so an unknown stored value degrades to the default
/// rather than failing.
enum MenubarRowPreferences {
    static let secondRowEnabledKey = "CodeBurnMenubarSecondRowEnabled"
    static let secondRowMetricKey = "CodeBurnMenubarSecondRowMetric"

    static func load(defaults: UserDefaults = .standard) -> MenubarRowSettings {
        MenubarRowSettings(
            isSecondRowEnabled: defaults.bool(forKey: secondRowEnabledKey),
            secondRowMetric: defaults.string(forKey: secondRowMetricKey)
                .flatMap(MenubarSecondRowMetric.init(rawValue:))
                ?? MenubarRowSettings.default.secondRowMetric
        )
    }

    static func setSecondRowEnabled(_ enabled: Bool, defaults: UserDefaults = .standard) {
        defaults.set(enabled, forKey: secondRowEnabledKey)
    }

    static func setSecondRowMetric(
        _ metric: MenubarSecondRowMetric,
        defaults: UserDefaults = .standard
    ) {
        defaults.set(metric.rawValue, forKey: secondRowMetricKey)
    }
}

/// One connected provider's headline quota window, reduced to plain values so
/// the row selection and formatting stay testable without an AppStore.
struct MenubarQuotaCandidate: Equatable, Sendable {
    let label: String
    /// Fraction of the window consumed, 0...1.
    let percentUsed: Double
    let resetsAt: Date?
}

enum MenubarQuotaRowSelection {
    /// The "primary" connected provider for the second row: the one nearest its
    /// limit, which is the same provider the menu-bar flame already tints for.
    /// Ties break on label so the row does not flip between equal providers
    /// from one refresh to the next.
    static func primary(from candidates: [MenubarQuotaCandidate]) -> MenubarQuotaCandidate? {
        candidates
            .sorted { lhs, rhs in
                if lhs.percentUsed != rhs.percentUsed { return lhs.percentUsed > rhs.percentUsed }
                return lhs.label < rhs.label
            }
            .first
    }
}

/// Everything the second row can read, captured as plain values. A nil field
/// means "no data" for that metric and makes the row degrade to one line; it
/// never renders as a zero.
struct MenubarRowSnapshot: Equatable, Sendable {
    var quota: MenubarQuotaCandidate?
    var todayCost: Double?
    var todayTotalTokens: Int?
    /// Nil when the payload carries no live-session block at all (a CLI that
    /// predates it), which is unknown rather than "nothing running".
    var activeSessionCount: Int?
    var currencySymbol: String
    var currencyRate: Double

    init(
        quota: MenubarQuotaCandidate? = nil,
        todayCost: Double? = nil,
        todayTotalTokens: Int? = nil,
        activeSessionCount: Int? = nil,
        currencySymbol: String = "$",
        currencyRate: Double = 1
    ) {
        self.quota = quota
        self.todayCost = todayCost
        self.todayTotalTokens = todayTotalTokens
        self.activeSessionCount = activeSessionCount
        self.currencySymbol = currencySymbol
        self.currencyRate = currencyRate
    }
}

/// Pure composition of the menu-bar rows. Returns one string when the second
/// row is off or its metric has no data, two when it has something to say.
enum MenubarRowFormatter {
    static func rows(
        firstRow: String,
        settings: MenubarRowSettings,
        snapshot: MenubarRowSnapshot,
        now: Date = Date()
    ) -> [String] {
        guard let second = secondRow(settings: settings, snapshot: snapshot, now: now) else {
            return [firstRow]
        }
        return [firstRow, second]
    }

    /// The second row's text, or nil when the setting is off or the chosen
    /// metric has no data yet.
    static func secondRow(
        settings: MenubarRowSettings,
        snapshot: MenubarRowSnapshot,
        now: Date = Date()
    ) -> String? {
        guard settings.isSecondRowEnabled else { return nil }
        switch settings.secondRowMetric {
        case .quotaRemaining:
            return quotaRow(snapshot.quota, now: now)
        case .todayCost:
            guard let cost = snapshot.todayCost, cost.isFinite else { return nil }
            let converted = cost * snapshot.currencyRate
            return String(format: "\(snapshot.currencySymbol)%.2f today", converted)
        case .todayTokens:
            guard let tokens = snapshot.todayTotalTokens else { return nil }
            return "\(compactTokens(Double(tokens))) tok today"
        case .activeSessions:
            guard let count = snapshot.activeSessionCount else { return nil }
            // Live sessions are identity-derived, so the exact phrasing applies.
            return SessionCountLabel.compact(sessions: count, basis: "identity")
        }
    }

    /// "Claude 42% left · 3h 12m". The countdown is dropped when the provider
    /// reports no reset instant; the whole row is dropped when there is no
    /// usable percentage.
    private static func quotaRow(_ quota: MenubarQuotaCandidate?, now: Date) -> String? {
        guard let quota, quota.percentUsed.isFinite else { return nil }
        let remaining = min(max(1 - quota.percentUsed, 0), 1)
        let percent = Int((remaining * 100).rounded())
        var row = quota.label.isEmpty ? "\(percent)% left" : "\(quota.label) \(percent)% left"
        if let countdown = resetCountdown(quota.resetsAt, now: now) {
            row += " · \(countdown)"
        }
        return row
    }

    /// Same shape as the popover's quota rows (`QuotaSummary.Window.resetsInLabel`),
    /// with an injectable clock so the row is testable.
    static func resetCountdown(_ resetsAt: Date?, now: Date) -> String? {
        guard let resetsAt else { return nil }
        let seconds = max(0, resetsAt.timeIntervalSince(now))
        if seconds < 60 { return "now" }
        let minutes = Int(seconds / 60)
        let hours = minutes / 60
        let days = hours / 24
        if days > 0 { return "\(days)d \(hours % 24)h" }
        if hours > 0 { return "\(hours)h \(minutes % 60)m" }
        return "\(minutes)m"
    }

    /// Menu-bar token shorthand, matching `Double.asCompactTokens()`. Kept here
    /// so the formatter stays free of the main actor.
    static func compactTokens(_ n: Double) -> String {
        if n >= 1_000_000_000 { return String(format: "%.1fB", n / 1_000_000_000) }
        if n >= 1_000_000 { return String(format: "%.1fM", n / 1_000_000) }
        if n >= 1_000 { return String(format: "%.0fK", n / 1_000) }
        return String(format: "%.0f", n)
    }
}

/// Geometry for the two-line title. The menu bar is 22pt on every standard
/// display (`NSStatusBar.system.thickness`), so the two lines get 10pt each and
/// the remaining 2pt is the slack AppKit's button cell centres the block in.
///
/// The inline flame has to shrink too, and by more than the text does: a
/// paragraph style clamps *text* line height but not an attachment, so a flame
/// whose image is taller than the clamp drags line one — and the whole title —
/// past the menu bar. `twoRowAttachmentBounds` is what actually holds that line,
/// by scaling the image down to the clamp rather than trusting a point size to
/// produce an image of a particular height.
///
/// The height AppKit then reports is *not* identical across macOS releases: the
/// same composition measures 20pt on macOS 26 and 21pt on the CI runner,
/// because SF Symbol metrics and line rounding move between releases. So the
/// contract here is a fit, not an exact number — the pair has to fit the bar,
/// and has to still look like two clamped lines rather than a collapsed one.
/// AppKit's button cell centres whatever it measures inside the status item, so
/// nothing needs to know the exact figure to place the rows.
enum MenubarRowTypography {
    /// The historical single-row text size, for reference in tests.
    static let singleRowFontSize: CGFloat = 13
    static let twoRowFontSize: CGFloat = 9
    static let twoRowLineHeight: CGFloat = 10
    static let standardMenuBarThickness: CGFloat = 22
    static let twoRowBaselineOffset: CGFloat = 0
    /// Asks for a flame around the clamped line height; `twoRowAttachmentBounds`
    /// is what guarantees it, since the rendered image size for a point size is
    /// the system's business and has changed between releases.
    static let twoRowAttachmentPointSize: CGFloat = 8
    static let twoRowAttachmentVerticalOffset: CGFloat = -3

    static var twoRowTextHeight: CGFloat { twoRowLineHeight * 2 }

    /// The tallest the pair may lay out: any more and the menu bar clips a row.
    static let twoRowMaximumHeight: CGFloat = standardMenuBarThickness
    /// A floor, so a lost paragraph clamp or a dropped second line is caught as
    /// a regression instead of passing as "fits".
    static let twoRowMinimumHeight: CGFloat = 18

    /// The box the inline flame occupies on the first line. The image is scaled
    /// down to the clamped line height — never up — and seated by
    /// `twoRowAttachmentVerticalOffset`, so a release whose SF Symbols render
    /// taller than the one these numbers were measured on cannot push the title
    /// out of the menu bar.
    static func twoRowAttachmentBounds(imageSize: CGSize) -> CGRect {
        guard imageSize.width > 0, imageSize.height > 0 else { return .zero }
        let height = min(imageSize.height, twoRowLineHeight)
        let width = imageSize.width * (height / imageSize.height)
        return CGRect(x: 0, y: twoRowAttachmentVerticalOffset, width: width, height: height)
    }

    /// True when a measured two-row layout fits a menu bar of this thickness.
    static func fitsMenuBar(
        measuredHeight: CGFloat,
        thickness: CGFloat = standardMenuBarThickness
    ) -> Bool {
        thickness > 0 && measuredHeight > 0 && measuredHeight <= thickness
    }

    /// True when a measured height is a plausible two-row layout: tall enough to
    /// be two clamped lines, short enough for the standard bar.
    static func isExpectedTwoRowHeight(_ measuredHeight: CGFloat) -> Bool {
        measuredHeight >= twoRowMinimumHeight && measuredHeight <= twoRowMaximumHeight
    }
}
