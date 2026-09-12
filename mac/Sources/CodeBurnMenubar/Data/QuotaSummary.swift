import Foundation

/// Per-provider live-quota snapshot consumed by the AgentTab progress bar and
/// Capacity Dock. Every CodeBurn-owned provider adapter normalizes into this
/// presentation type.
struct QuotaSummary: Equatable {
    /// Quota providers use a ten-minute freshness horizon for last-known
    /// snapshots. A projection from an older sample is misleading even when
    /// the credentials are still connected, so pace presentation must omit it.
    static let freshnessThreshold: TimeInterval = 10 * 60

    static func isFresh(fetchedAt: Date?, now: Date = Date()) -> Bool {
        guard let fetchedAt else { return false }
        let age = now.timeIntervalSince(fetchedAt)
        return age.isFinite && age >= 0 && age <= freshnessThreshold
    }

    enum Connection: Equatable {
        case connected
        case disconnected      // no credentials present
        case loading
        case stale             // had data once, current fetch is in flight
        case transientFailure  // backing off; show last-known data dimmed
        case terminalFailure(reason: String?)  // user must reconnect
    }

    let providerFilter: ProviderFilter
    let connection: Connection
    let primary: Window?              // weekly utilization, the headline bar
    let details: [Window]             // 5h, weekly, opus, sonnet — full hover card
    /// Display label for the user's plan (e.g. "Max 20x", "Pro Lite"). Shown
    /// in the top-right corner of the hover detail popover so users can
    /// confirm at a glance which subscription is feeding the bar.
    let planLabel: String?
    /// Optional footer rows that the popover renders below the window list.
    /// Used for provider-specific facts such as account identity, remaining
    /// credits, source attribution, and retry diagnostics.
    let footerLines: [String]

    struct Window: Equatable {
        let label: String
        let percent: Double           // 0..1
        let resetsAt: Date?
        /// Length of this window in seconds, carried only from metadata the
        /// provider service itself validates (Codex's `limitWindowSeconds`,
        /// Claude's fixed 5-hour/7-day windows). Nil means the duration is not
        /// known — pace presentation must omit the estimate rather than infer
        /// a length from the label or the reset date.
        let windowSeconds: Int?
        /// Timestamp of the provider sample that produced this window. Nil is
        /// preserved for legacy/unsupported summaries and is not fresh enough
        /// to support a pace projection.
        let fetchedAt: Date?

        init(
            label: String,
            percent: Double,
            resetsAt: Date?,
            windowSeconds: Int? = nil,
            fetchedAt: Date? = nil
        ) {
            self.label = label
            self.percent = percent
            self.resetsAt = resetsAt
            self.windowSeconds = windowSeconds
            self.fetchedAt = fetchedAt
        }

        /// A pace estimate is valid only while the underlying sample remains
        /// inside the established live-quota freshness horizon.
        func isFresh(at now: Date = Date()) -> Bool {
            QuotaSummary.isFresh(fetchedAt: fetchedAt, now: now)
        }
    }

    /// Color band thresholds for the inline chip bar and aggregate menubar
    /// flame tint. Four tiers so the icon can step from "you're approaching
    /// your limit" (yellow) through "you're about to hit the wall" (orange)
    /// to "you're over" (red) — matches what the user expects from a warning
    /// indicator in the menu bar.
    static func severity(for percent: Double) -> Severity {
        if percent >= 0.9 { return .danger }
        if percent >= 0.75 { return .critical }
        if percent >= 0.5 { return .warning }
        return .normal
    }

    enum Severity {
        case normal     // <50%   green
        case warning    // 50-75% yellow
        case critical   // 75-90% orange
        case danger     // >=90%  red
    }

    /// The glance value (percent + color) for Capacity Dock. Every provider is
    /// put on the same billing horizon: the weekly window if one exists, else the
    /// monthly window. Only when a provider exposes neither does it fall back to
    /// the window nearest exhaustion. Empty data stays nil rather than
    /// masquerading as 0%.
    var headlineWindow: Window? {
        var candidates = details
        if let primary, !candidates.contains(primary) {
            candidates.append(primary)
        }
        func firstMatching(_ needle: String) -> Window? {
            candidates.first { $0.label.range(of: needle, options: .caseInsensitive) != nil }
        }
        if let weekly = firstMatching("week") { return weekly }
        if let monthly = firstMatching("month") { return monthly }
        return candidates.max { lhs, rhs in lhs.percent < rhs.percent }
    }
}

/// The one user-initiated recovery action Capacity Dock may offer. Keeping the
/// decision pure lets the dock render the same affordance whether a provider
/// has no summary yet or has explicitly reported an expired connection.
enum CapacityDockConnectionAction: String, Equatable, Sendable {
    case connect = "Connect"
    case reconnect = "Reconnect"

    var title: String { rawValue }

    func title(for provider: CapacityDockProvider) -> String {
        if provider.catalogEntry.authMethods == [.apiTokenOrCloudCredentials] {
            return "Add API Key"
        }
        return title
    }

    static func resolve(quota: QuotaSummary?) -> Self? {
        guard let quota else { return .connect }
        switch quota.connection {
        case .disconnected: return .connect
        case .terminalFailure: return .reconnect
        case .connected, .loading, .stale, .transientFailure: return nil
        }
    }
}

extension QuotaSummary.Window {
    /// Human-readable countdown like "2h 11m" or "3d 14h" or "now".
    var resetsInLabel: String {
        guard let resetsAt else { return "" }
        let seconds = max(0, resetsAt.timeIntervalSinceNow)
        if seconds < 60 { return "now" }
        let minutes = Int(seconds / 60)
        let hours = minutes / 60
        let days = hours / 24
        if days > 0 { return "\(days)d \(hours % 24)h" }
        if hours > 0 { return "\(hours)h \(minutes % 60)m" }
        return "\(minutes)m"
    }

    var percentLabel: String {
        let pct = Int((percent * 100).rounded())
        return "\(pct)%"
    }
}
