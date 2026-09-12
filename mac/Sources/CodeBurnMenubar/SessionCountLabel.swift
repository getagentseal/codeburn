/// Shared session-count phrasing. Keep in lockstep with `src/session-count-label.ts`.
enum SessionCountLabel {
    static let help = "Older session logs may be unavailable."
    /// Combined-scope counts are a per-device numeric sum with no shared identity.
    /// Do not show that sum as unique or as a lower bound.
    static let combinedHelp = "Session identities are unavailable across devices."
    static let combinedText = "Session count unavailable"

    static func isExact(_ basis: String?) -> Bool {
        basis == "identity"
    }

    static func text(sessions: Int, basis: String?) -> String {
        if !isExact(basis) {
            if sessions <= 0 { return "Session count unavailable" }
            return sessions == 1 ? "At least 1 session" : "At least \(sessions) sessions"
        }
        return sessions == 1 ? "1 session" : "\(sessions) sessions"
    }

    static func compact(sessions: Int, basis: String?) -> String {
        if !isExact(basis) {
            if sessions <= 0 { return "Unavailable" }
            return "≥\(sessions) sess"
        }
        return "\(sessions) sess"
    }

    static func averageText(_ value: Double?, basis: String?, format: (Double) -> String) -> String {
        guard isExact(basis), let value, value.isFinite else { return "—" }
        return format(value)
    }

    static func helpText(combined: Bool, basis: String?) -> String {
        if combined { return combinedHelp }
        return isExact(basis) ? "" : help
    }
}
