import Foundation

/// Codex (ChatGPT-mode) live quota snapshot returned by /backend-api/wham/usage.
/// Two windows are exposed: primary (typically the 5-hour rolling window) and
/// secondary (typically the weekly window). Window size is dynamic per
/// account — `limitWindowSeconds` tells us whether it's a 5-hour or 7-day
/// boundary so we can label correctly.
struct CodexUsage: Sendable, Equatable {
    enum PlanType: Sendable, Equatable {
        case guest, free, go, plus, pro, prolite, freeWorkspace, team
        case business, education, quorum, k12, enterprise, edu
        /// Captures any plan_type string OpenAI ships that we haven't enumerated
        /// yet, so the Settings/Plan UI can still show "Plan: <raw>" instead of
        /// a generic "Subscription" placeholder. Preserves forward compatibility
        /// without requiring a CodeBurn update for every new tier.
        case unknown(String)

        var displayName: String {
            switch self {
            case .guest: L("Guest")
            case .free: L("Free")
            case .go: L("Go")
            case .plus: L("Plus")
            case .pro: L("Pro")
            case .prolite: L("Pro Lite")
            case .freeWorkspace: L("Free Workspace")
            case .team: L("Team")
            case .business: L("Business")
            case .education: L("Education")
            case .quorum: L("Quorum")
            case .k12: L("K-12")
            case .enterprise: L("Enterprise")
            case .edu: L("Edu")
            case let .unknown(raw):
                raw.isEmpty
                    ? L("Subscription")
                    : raw.replacingOccurrences(of: "_", with: " ")
                         .replacingOccurrences(of: "-", with: " ")
                         .capitalized
            }
        }
    }

    struct Window: Sendable, Equatable {
        let usedPercent: Double          // 0.0 ... 100.0
        let resetsAt: Date?
        let limitWindowSeconds: Int

        /// Human label inferred from window size: 5h, 1d, 7d, etc.
        var windowLabel: String {
            switch limitWindowSeconds {
            case 0..<3600:                return "Hourly"
            case 3600..<7200:             return "Hour"
            case 18000..<19000:           return "5-hour"
            case 86400..<87000:           return "Daily"
            case 604800..<605000:         return "Weekly"
            default:
                let hours = limitWindowSeconds / 3600
                if hours < 24 { return "\(hours)-hour" }
                return "\(hours / 24)-day"
            }
        }
    }

    /// Additional per-model / per-feature quotas exposed by ChatGPT alongside
    /// the main rate_limit (e.g. "GPT-5.3-Codex-Spark"). Each entry has its
    /// own primary/secondary windows. Only ones with non-zero utilization are
    /// surfaced in the popover so users on plans that don't touch these
    /// features don't see clutter.
    struct AdditionalLimit: Sendable, Equatable {
        let name: String
        let primary: Window?
        let secondary: Window?
    }

    /// Account-level limit-reset credits: grants that restore a rate-limit
    /// window early, each with its own expiry. Only what the popover renders —
    /// the available count and the soonest expiry among available credits.
    struct ResetCredits: Sendable, Equatable {
        let availableCount: Int
        let nextExpiresAt: Date?
    }

    /// The monthly allowance an admin sets. Credit-metered workspaces report
    /// `rate_limit: null`, so this is their only limit.
    struct CreditLimit: Sendable, Equatable {
        let used: Double
        let limit: Double
        let usedPercent: Double        // 0.0 ... 100.0
        let resetsAt: Date?
        /// Calendar month the allowance resets on, for pace projection. Not the
        /// payload's `reset_after_seconds`, which is the time remaining.
        let windowSeconds: Int?
        /// Allowance already spent: a hard stop, not a near-limit warning.
        let reached: Bool

        /// `.halfUp` matches the desktop decoder's `Math.round`.
        var displayLabel: String {
            let formatter = NumberFormatter()
            formatter.numberStyle = .decimal
            formatter.maximumFractionDigits = 0
            formatter.roundingMode = .halfUp
            // `en_US`, not `en_US_POSIX`: the latter drops grouping entirely.
            formatter.locale = Locale(identifier: "en_US")
            func text(_ value: Double) -> String {
                formatter.string(from: NSNumber(value: value)) ?? "\(Int(value.rounded()))"
            }
            let base = L("Monthly usage limit · \(text(used)) / \(text(limit)) credits")
            return reached ? L("\(base) · limit reached") : base
        }

        var shortLabel: String {
            reached ? "Monthly usage limit · limit reached" : "Monthly usage limit"
        }
    }

    let plan: PlanType
    let primary: Window?
    let secondary: Window?
    let additionalLimits: [AdditionalLimit]
    let creditsBalance: Double?
    /// Account settles in credits, not dollars, which changes `creditsBalance`.
    let hasCredits: Bool
    /// Uncapped on purpose, as distinct from a limit we failed to read.
    let creditsUnlimited: Bool
    let creditLimit: CreditLimit?
    let resetCredits: ResetCredits?
    let fetchedAt: Date

    static func planType(from raw: String?) -> PlanType {
        guard let original = raw?.lowercased() else { return .unknown("") }
        let raw = normalizePlanType(original)
        switch raw {
        case "guest": return .guest
        case "free": return .free
        case "go": return .go
        case "plus": return .plus
        case "pro": return .pro
        case "prolite", "pro_lite", "pro-lite": return .prolite
        case "free_workspace": return .freeWorkspace
        case "team": return .team
        case "business": return .business
        case "education": return .education
        case "quorum": return .quorum
        case "k12": return .k12
        case "enterprise": return .enterprise
        case "edu": return .edu
        // Normalized, so an unknown composite reads "Some Future Tier".
        default: return .unknown(raw)
        }
    }

    /// Credit-based-pricing tiers arrive composite (`enterprise_cbp_usage_based`).
    private static func normalizePlanType(_ raw: String) -> String {
        var value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        for suffix in ["_usage_based", "-usage-based", "_usage-based", "-usage_based"]
        where value.hasSuffix(suffix) {
            value.removeLast(suffix.count)
        }
        for prefix in ["self_serve_", "self-serve-", "self_serve-", "self-serve_"]
        where value.hasPrefix(prefix) {
            value.removeFirst(prefix.count)
        }
        for suffix in ["_cbp", "-cbp"] where value.hasSuffix(suffix) {
            value.removeLast(suffix.count)
        }
        for infix in ["_cbp_", "-cbp-", "_cbp-", "-cbp_"] {
            value = value.replacingOccurrences(of: infix, with: "_")
        }
        return value
    }
}
