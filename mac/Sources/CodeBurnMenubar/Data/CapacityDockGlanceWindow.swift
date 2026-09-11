import Foundation

/// Which usage horizon one Capacity Dock gauge reports. Several providers
/// publish both a short rolling window and a longer billing window — Claude's
/// 5-hour and weekly limits, Codex's primary and secondary rate windows — and
/// the resting rail has room for exactly one number. The kinds are deliberately
/// provider-agnostic: the dock's collapsed row is one control for every
/// provider, so the preference is "which horizon" rather than "which label".
enum CapacityDockGlanceWindowKind: String, CaseIterable, Sendable {
    /// The weekly (else monthly) billing horizon. The dock's original glance,
    /// and the default for every provider.
    case billing
    /// The provider's short rolling window: 5-hour, session, hourly, daily.
    case burst

    var other: Self {
        switch self {
        case .billing: .burst
        case .burst: .billing
        }
    }

    /// Generic name for the horizon, used where no concrete window label is at
    /// hand. Prefer the resolved window's own label when one exists.
    var displayName: String {
        switch self {
        case .billing: "weekly"
        case .burst: "5-hour"
        }
    }
}

/// Pure policy for the Capacity Dock glance: which of a provider's quota
/// windows its gauge reports, given the stored preference and the windows the
/// provider actually publishes, and what a click on the gauge switches to.
///
/// Kept out of the views so the fallbacks are testable: a stored preference can
/// outlive the window it named (a plan change, a provider that stops reporting
/// its 5-hour limit), and the gauge must never go blank because of it.
enum CapacityDockGlanceWindow {
    /// Labels that mark a billing horizon. Checked first, so Claude's
    /// "Weekly · Opus" is never mistaken for a short window.
    private static let billingNeedles = ["week", "month"]
    /// Labels that mark a short rolling window across the provider adapters:
    /// "5-hour", "Hourly", "Daily", "Current session".
    private static let burstNeedles = ["hour", "session", "daily", "today", "minute"]

    /// Every window the provider published, `primary` included once.
    static func candidates(_ quota: QuotaSummary?) -> [QuotaSummary.Window] {
        guard let quota else { return [] }
        var candidates = quota.details
        if let primary = quota.primary, !candidates.contains(primary) {
            candidates.append(primary)
        }
        return candidates
    }

    /// The window a kind names, or nil when the provider publishes nothing for
    /// that horizon.
    static func window(
        _ kind: CapacityDockGlanceWindowKind,
        quota: QuotaSummary?
    ) -> QuotaSummary.Window? {
        switch kind {
        // The billing horizon has one definition for the whole app; reuse it
        // rather than teaching the dock a second idea of "the headline".
        case .billing: quota?.headlineWindow
        case .burst: burstWindow(quota)
        }
    }

    /// The kind the gauge actually draws. The stored choice wins when the
    /// provider reports that horizon; otherwise the other one does, so a
    /// provider with a single window still shows a number instead of `--`.
    static func resolvedKind(
        preferred: CapacityDockGlanceWindowKind,
        quota: QuotaSummary?
    ) -> CapacityDockGlanceWindowKind {
        if window(preferred, quota: quota) != nil { return preferred }
        if window(preferred.other, quota: quota) != nil { return preferred.other }
        return preferred
    }

    static func resolvedWindow(
        preferred: CapacityDockGlanceWindowKind,
        quota: QuotaSummary?
    ) -> QuotaSummary.Window? {
        window(resolvedKind(preferred: preferred, quota: quota), quota: quota)
    }

    /// Whether this provider has two distinct horizons to switch between. A
    /// provider that reports one window — or whose short window *is* its
    /// billing window — offers nothing to switch, so the gauge keeps its
    /// existing click behaviour there.
    static func isSwitchable(quota: QuotaSummary?) -> Bool {
        guard let billing = window(.billing, quota: quota),
              let burst = window(.burst, quota: quota) else { return false }
        return billing != burst
    }

    /// What a click on the gauge selects. A provider with one usable horizon
    /// keeps the kind it is already drawing, so the click is a no-op rather
    /// than a stored change that redraws nothing.
    static func next(
        after preferred: CapacityDockGlanceWindowKind,
        quota: QuotaSummary?
    ) -> CapacityDockGlanceWindowKind {
        let resolved = resolvedKind(preferred: preferred, quota: quota)
        guard isSwitchable(quota: quota) else { return resolved }
        return resolved.other
    }

    private static func burstWindow(_ quota: QuotaSummary?) -> QuotaSummary.Window? {
        candidates(quota).first { window in
            guard !matches(window.label, billingNeedles) else { return false }
            return matches(window.label, burstNeedles)
        }
    }

    private static func matches(_ label: String, _ needles: [String]) -> Bool {
        needles.contains { label.range(of: $0, options: .caseInsensitive) != nil }
    }
}
