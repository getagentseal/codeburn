import Foundation

/// Per-provider live-quota snapshot consumed by the AgentTab progress bar
/// and the hover-detail popover. Today only Claude has a real quota source
/// (Anthropic /api/oauth/usage); future providers (Cursor, Copilot, etc.)
/// will plug in by producing the same struct from their own auth path.
struct QuotaSummary: Equatable {
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

    struct Window: Equatable {
        let label: String
        let percent: Double           // 0..1
        let resetsAt: Date?
    }

    /// Color band thresholds matching CodexBar's convention.
    static func severity(for percent: Double) -> Severity {
        if percent >= 0.9 { return .critical }
        if percent >= 0.7 { return .warning }
        return .normal
    }

    enum Severity {
        case normal, warning, critical
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
