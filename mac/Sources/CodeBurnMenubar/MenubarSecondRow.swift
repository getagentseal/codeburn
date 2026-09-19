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
        case .quotaRemaining: L("Quota remaining")
        case .todayCost: L("Today's cost")
        case .todayTokens: L("Today's tokens")
        case .activeSessions: L("Active sessions")
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
    /// limit. Ties break on label so the row does not flip between equal
    /// providers from one refresh to the next.
    static func primary(from candidates: [MenubarQuotaCandidate]) -> MenubarQuotaCandidate? {
        candidates
            .sorted { lhs, rhs in
                if lhs.percentUsed != rhs.percentUsed { return lhs.percentUsed > rhs.percentUsed }
                return lhs.label < rhs.label
            }
            .first
    }

    /// One provider reduced to its row candidate, or nil when it has nothing the
    /// row may report.
    ///
    /// The window is the provider's *worst* one, not `headlineWindow`. The
    /// headline window is a billing horizon — weekly, else monthly, and only
    /// then the busiest window — which is the right number for the Capacity Dock
    /// rail but the wrong one here: it discards a Cursor API window sitting at
    /// 100% in favour of a monthly window at 9.5%, so the row names a provider
    /// that is nowhere near its limit. The worst window is also exactly what the
    /// menu-bar flame tints by (`AppStore.aggregateQuotaStatus` takes the max
    /// across every window a provider reports, per-model rows included), so the
    /// two surfaces now agree about which provider is in trouble.
    static func candidate(label: String, summary: QuotaSummary) -> MenubarQuotaCandidate? {
        guard feedsRow(summary.connection), let window = worstWindow(summary) else { return nil }
        return MenubarQuotaCandidate(
            label: label,
            percentUsed: window.percent,
            resetsAt: window.resetsAt
        )
    }

    /// Connection states whose last-known data still feeds the row. A provider
    /// backing off (`transientFailure`) keeps its data in the Capacity Dock,
    /// dimmed, so dropping it here made the row — and with it the status item's
    /// width — flicker away for the length of a backoff. Only states with
    /// nothing to show are excluded.
    static func feedsRow(_ connection: QuotaSummary.Connection) -> Bool {
        switch connection {
        case .connected, .stale, .transientFailure: true
        case .disconnected, .loading, .terminalFailure: false
        }
    }

    /// The window nearest exhaustion across everything the provider reports,
    /// `primary` included. Ties break on label so the countdown does not swap
    /// between two equally used windows from one refresh to the next.
    static func worstWindow(_ summary: QuotaSummary) -> QuotaSummary.Window? {
        var windows = summary.details
        if let primary = summary.primary, !windows.contains(primary) {
            windows.append(primary)
        }
        return windows
            .filter { $0.percent.isFinite }
            .sorted { lhs, rhs in
                if lhs.percent != rhs.percent { return lhs.percent > rhs.percent }
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
        let row: String?
        switch settings.secondRowMetric {
        case .quotaRemaining:
            row = quotaRow(snapshot.quota, now: now)
        case .todayCost:
            guard let cost = snapshot.todayCost, cost.isFinite else { return nil }
            let converted = cost * snapshot.currencyRate
            row = L("%@ today", String(format: "\(snapshot.currencySymbol)%.2f", converted))
        case .todayTokens:
            guard let tokens = snapshot.todayTotalTokens else { return nil }
            row = L("%@ tok today", compactTokens(Double(tokens)))
        case .activeSessions:
            guard let count = snapshot.activeSessionCount else { return nil }
            // Live sessions are identity-derived, so the exact phrasing applies.
            row = SessionCountLabel.compact(sessions: count, basis: "identity")
        }
        // Last line of defence: whatever a metric produces, the row never gets
        // to set the status item's width on its own.
        return row.map { clampToRowBudget($0) }
    }

    /// "Claude 42% left · 3h 12m". The countdown is dropped when the provider
    /// reports no reset instant; the whole row is dropped when there is no
    /// usable percentage.
    ///
    /// The percentage and the countdown are bounded by their own shapes; the
    /// provider label is not ("GitHub Copilot"), so it is the part that gives
    /// way when the row would exceed `secondRowCharacterBudget`. Shortening the
    /// name keeps both figures — the two things the row exists to say — rather
    /// than clipping the countdown off the end.
    private static func quotaRow(_ quota: MenubarQuotaCandidate?, now: Date) -> String? {
        guard let quota, quota.percentUsed.isFinite else { return nil }
        let remaining = min(max(1 - quota.percentUsed, 0), 1)
        let percent = Int((remaining * 100).rounded())
        var figures = L("%lld%% left", percent)
        if let countdown = resetCountdown(quota.resetsAt, now: now) {
            figures += " · \(countdown)"
        }
        guard !quota.label.isEmpty else { return figures }
        let label = abbreviate(localizedWindowLabel(quota.label), to: secondRowCharacterBudget - displayCells(figures) - 1)
        return label.isEmpty ? figures : "\(label) \(figures)"
    }

    /// How wide the second row may get, in display cells (`displayCells(_:)`).
    ///
    /// The status item is variable width, so the widest line wins; an unbounded
    /// second row ("GitHub Copilot 12% left · 6d 3h") made the item more than
    /// twice as wide as the figure above it. The single row bounds itself by
    /// abbreviating (`Period.menubarSuffix(compact:)`, `asCompactCurrencyWhole`),
    /// and at its widest — tokens, a period suffix and a device-shortfall marker
    /// — it runs to roughly 24 characters at 13pt. The second row renders at 9pt
    /// (`MenubarRowTypography.twoRowFontSize`), so the same character count there
    /// is about two thirds of that width: turning the row on cannot push the item
    /// past what the first row alone could already occupy.
    static let secondRowCharacterBudget = 24

    /// Display cells `text` occupies. A Han, kana or Hangul glyph is about twice
    /// as wide as a Latin one, so counting Characters lets a translated row
    /// overrun the very width the budget exists to hold: `6 小时 2 分` is 8
    /// Characters and 11 cells.
    ///
    /// ponytail: the East Asian Wide/Fullwidth blocks the catalog can actually
    /// contain, not the whole of UAX #11. Widen the ranges if a locale outside
    /// them ships.
    static func displayCells(_ text: String) -> Int {
        text.unicodeScalars.reduce(0) { total, scalar in
            switch scalar.value {
            case 0x1100...0x115F, 0x2E80...0xA4CF, 0xAC00...0xD7A3,
                 0xF900...0xFAFF, 0xFE30...0xFE6F, 0xFF00...0xFF60,
                 0xFFE0...0xFFE6, 0x20000...0x3FFFD:
                return total + 2
            default:
                return total + 1
            }
        }
    }

    /// Shortens `text` to `limit` display cells, marking the cut with an
    /// ellipsis. Returns "" when there is no room for even one character plus
    /// the mark, so the caller can drop the part entirely rather than render a
    /// bare "…". Identical to a character count for an all-Latin row.
    static func abbreviate(_ text: String, to limit: Int) -> String {
        guard displayCells(text) > limit else { return text }
        guard limit >= 2 else { return "" }
        var kept = ""
        var used = 0
        for character in text {
            let width = displayCells(String(character))
            if used + width > limit - 1 { break }
            kept.append(character)
            used += width
        }
        while kept.last == " " { kept.removeLast() }
        return kept.isEmpty ? "" : kept + "…"
    }

    /// Applies `secondRowCharacterBudget` to an already-composed row.
    static func clampToRowBudget(_ row: String) -> String {
        abbreviate(row, to: secondRowCharacterBudget)
    }

    /// What VoiceOver reads for the status item once the second row is on.
    ///
    /// The rendered title is one attributed string carrying a literal newline
    /// between the rows, and the row separator is a middle dot; read verbatim
    /// that is neither a sentence nor a pause. This spells the same information
    /// as one comma-separated phrase, from the title as composed, so the label
    /// cannot drift from what is on screen.
    static func accessibilityLabel(title: String) -> String {
        let parts = title
            // U+FFFC is the inline flame attachment's placeholder character.
            .replacingOccurrences(of: "\u{FFFC}", with: " ")
            .split(whereSeparator: \.isNewline)
            .flatMap { $0.split(separator: "·") }
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        return (["CodeBurn"] + parts).joined(separator: ", ")
    }

    /// Same shape as the popover's quota rows (`QuotaSummary.Window.resetsInLabel`),
    /// with an injectable clock so the row is testable.
    static func resetCountdown(_ resetsAt: Date?, now: Date) -> String? {
        guard let resetsAt else { return nil }
        let seconds = max(0, resetsAt.timeIntervalSince(now))
        if seconds < 60 { return L("now") }
        let minutes = Int(seconds / 60)
        let hours = minutes / 60
        let days = hours / 24
        // d/h/m are unit abbreviations; zh-Hans uses 天/小时/分.
        if days > 0 { return L("%1$lldd %2$lldh", days, hours % 24) }
        if hours > 0 { return L("%1$lldh %2$lldm", hours, minutes % 60) }
        return L("%lldm", minutes)
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
