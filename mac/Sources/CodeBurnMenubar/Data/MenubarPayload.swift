import Foundation

// MARK: - Billing Mode

/// Billing mode determines how costs are displayed throughout the UI.
/// - `credits`: Show Augment credits only, never USD. All `$` symbols hidden.
/// - `tokenPlus`: Show USD with surcharge. `$` symbols visible.
/// - `legacy`: Old CLI output without billing block. Display raw `cost` as USD for backwards compat.
enum BillingMode: String, Codable, Sendable {
    case credits = "credits"
    case tokenPlus = "token_plus"
    case legacy // not emitted by CLI; synthesized when billing block absent
}

/// Top-level billing metadata from CLI v2 JSON.
struct BillingInfo: Codable, Sendable {
    let mode: BillingMode
    let creditsPerDollar: Double?
    let surchargeRate: Double?
}

/// Shape of `codeburn status --format menubar-json --period <period>`.
/// `current` is scoped to the requested period; the whole payload reflects that slice.
struct MenubarPayload: Codable, Sendable {
    let generated: String
    let billing: BillingInfo?
    let current: CurrentBlock
    let optimize: OptimizeBlock
    let history: HistoryBlock

    /// Resolved billing mode. Falls back to `.legacy` if `billing` block absent.
    var billingMode: BillingMode {
        billing?.mode ?? .legacy
    }
}

struct HistoryBlock: Codable, Sendable {
    let daily: [DailyHistoryEntry]
}

struct DailyModelBreakdown: Codable, Sendable {
    let name: String
    let cost: Double
    let calls: Int
    let inputTokens: Int
    let outputTokens: Int

    var totalTokens: Int { inputTokens + outputTokens }
}

struct DailyHistoryEntry: Codable, Sendable {
    let date: String
    let cost: Double
    let calls: Int
    let inputTokens: Int
    let outputTokens: Int
    let cacheReadTokens: Int
    let cacheWriteTokens: Int
    let topModels: [DailyModelBreakdown]

    /// Pricing-ratio prior: input + 5x output + cache_creation + 0.1x cache_read.
    /// Matches Anthropic's published per-token pricing on Sonnet/Opus closely enough to be a useful proxy.
    var effectiveTokens: Double {
        Double(inputTokens) + 5.0 * Double(outputTokens) + Double(cacheWriteTokens) + 0.1 * Double(cacheReadTokens)
    }
}

extension DailyHistoryEntry {
    /// Required for legacy payloads (no topModels emitted yet).
    enum CodingKeys: String, CodingKey {
        case date, cost, calls, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, topModels
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        date = try c.decode(String.self, forKey: .date)
        cost = try c.decode(Double.self, forKey: .cost)
        calls = try c.decode(Int.self, forKey: .calls)
        inputTokens = try c.decode(Int.self, forKey: .inputTokens)
        outputTokens = try c.decode(Int.self, forKey: .outputTokens)
        cacheReadTokens = try c.decode(Int.self, forKey: .cacheReadTokens)
        cacheWriteTokens = try c.decode(Int.self, forKey: .cacheWriteTokens)
        topModels = try c.decodeIfPresent([DailyModelBreakdown].self, forKey: .topModels) ?? []
    }
}

struct CurrentBlock: Codable, Sendable {
    let label: String
    /// In credits mode: always null. In token_plus mode: billedAmountUsd. Legacy: USD cost.
    let cost: Double?
    let calls: Int
    let sessions: Int
    let oneShotRate: Double?
    let inputTokens: Int
    let outputTokens: Int
    let cacheHitPercent: Double

    // Billing mode-specific fields (v2 JSON)
    /// Credits mode: ground-truth or synthesized credits. Token+ mode: null.
    let creditsAugment: Double?
    /// Credits mode: count of credits that were synthesized (no ground truth). Token+ mode: 0.
    let creditsSynthesized: Int?
    /// Token+ mode: base cost before surcharge. Credits mode: null.
    let baseCostUsd: Double?
    /// Token+ mode: surcharge amount. Credits mode: null.
    let surchargeUsd: Double?
    /// Token+ mode: base + surcharge. Credits mode: null.
    let billedAmountUsd: Double?

    let topActivities: [ActivityEntry]
    let topModels: [ModelEntry]
    let providers: [String: Double]

    enum CodingKeys: String, CodingKey {
        case label, cost, calls, sessions, oneShotRate, inputTokens, outputTokens, cacheHitPercent
        case creditsAugment, creditsSynthesized, baseCostUsd, surchargeUsd, billedAmountUsd
        case topActivities, topModels, providers
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        label = try c.decode(String.self, forKey: .label)
        cost = try c.decodeIfPresent(Double.self, forKey: .cost)
        calls = try c.decode(Int.self, forKey: .calls)
        sessions = try c.decode(Int.self, forKey: .sessions)
        oneShotRate = try c.decodeIfPresent(Double.self, forKey: .oneShotRate)
        inputTokens = try c.decode(Int.self, forKey: .inputTokens)
        outputTokens = try c.decode(Int.self, forKey: .outputTokens)
        cacheHitPercent = try c.decode(Double.self, forKey: .cacheHitPercent)
        creditsAugment = try c.decodeIfPresent(Double.self, forKey: .creditsAugment)
        creditsSynthesized = try c.decodeIfPresent(Int.self, forKey: .creditsSynthesized)
        baseCostUsd = try c.decodeIfPresent(Double.self, forKey: .baseCostUsd)
        surchargeUsd = try c.decodeIfPresent(Double.self, forKey: .surchargeUsd)
        billedAmountUsd = try c.decodeIfPresent(Double.self, forKey: .billedAmountUsd)
        topActivities = try c.decode([ActivityEntry].self, forKey: .topActivities)
        topModels = try c.decode([ModelEntry].self, forKey: .topModels)
        providers = try c.decode([String: Double].self, forKey: .providers)
    }

    /// Memberwise initializer for tests and empty placeholder.
    init(
        label: String, cost: Double?, calls: Int, sessions: Int, oneShotRate: Double?,
        inputTokens: Int, outputTokens: Int, cacheHitPercent: Double,
        creditsAugment: Double? = nil, creditsSynthesized: Int? = nil,
        baseCostUsd: Double? = nil, surchargeUsd: Double? = nil, billedAmountUsd: Double? = nil,
        topActivities: [ActivityEntry], topModels: [ModelEntry], providers: [String: Double]
    ) {
        self.label = label
        self.cost = cost
        self.calls = calls
        self.sessions = sessions
        self.oneShotRate = oneShotRate
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheHitPercent = cacheHitPercent
        self.creditsAugment = creditsAugment
        self.creditsSynthesized = creditsSynthesized
        self.baseCostUsd = baseCostUsd
        self.surchargeUsd = surchargeUsd
        self.billedAmountUsd = billedAmountUsd
        self.topActivities = topActivities
        self.topModels = topModels
        self.providers = providers
    }
}

struct ActivityEntry: Codable, Sendable {
    let name: String
    let cost: Double
    let turns: Int
    let oneShotRate: Double?
}

struct ModelEntry: Codable, Sendable {
    let name: String
    /// In credits mode: always null. In token_plus: billedAmountUsd. Legacy: USD cost.
    let cost: Double?
    let calls: Int
    /// Credits mode: credits for this model. Token+ mode: null.
    let creditsAugment: Double?
    /// Token+ mode: base cost for this model. Credits mode: null.
    let baseCostUsd: Double?
    /// Token+ mode: billed amount for this model. Credits mode: null.
    let billedAmountUsd: Double?

    enum CodingKeys: String, CodingKey {
        case name, cost, calls, creditsAugment, baseCostUsd, billedAmountUsd
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        cost = try c.decodeIfPresent(Double.self, forKey: .cost)
        calls = try c.decode(Int.self, forKey: .calls)
        creditsAugment = try c.decodeIfPresent(Double.self, forKey: .creditsAugment)
        baseCostUsd = try c.decodeIfPresent(Double.self, forKey: .baseCostUsd)
        billedAmountUsd = try c.decodeIfPresent(Double.self, forKey: .billedAmountUsd)
    }

    init(name: String, cost: Double?, calls: Int, creditsAugment: Double? = nil, baseCostUsd: Double? = nil, billedAmountUsd: Double? = nil) {
        self.name = name
        self.cost = cost
        self.calls = calls
        self.creditsAugment = creditsAugment
        self.baseCostUsd = baseCostUsd
        self.billedAmountUsd = billedAmountUsd
    }
}

struct OptimizeBlock: Codable, Sendable {
    let findingCount: Int
    let savingsUSD: Double
    let topFindings: [FindingEntry]
}

struct FindingEntry: Codable, Sendable {
    let title: String
    let impact: String
    let savingsUSD: Double
}

// MARK: - Empty fallback

extension MenubarPayload {
    /// Strictly-empty payload. Used as the fallback before real data arrives, so no
    /// plausible-looking fake numbers leak into the UI.
    static let empty = MenubarPayload(
        generated: "",
        billing: nil,
        current: CurrentBlock(
            label: "",
            cost: nil,
            calls: 0,
            sessions: 0,
            oneShotRate: nil,
            inputTokens: 0,
            outputTokens: 0,
            cacheHitPercent: 0,
            topActivities: [],
            topModels: [],
            providers: [:]
        ),
        optimize: OptimizeBlock(findingCount: 0, savingsUSD: 0, topFindings: []),
        history: HistoryBlock(daily: [])
    )
}
