import Foundation

/// Shape of `codeburn status --format menubar-json --period <period>`.
/// `current` is scoped to the requested period; the whole payload reflects that slice.
struct MenubarPayload: Codable, Sendable {
    let generated: String
    let current: CurrentBlock
    let optimize: OptimizeBlock
    let history: HistoryBlock
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

struct RetryTaxModelEntry: Codable, Sendable {
    let name: String
    let taxUSD: Double
    let retries: Int
    let retriesPerEdit: Double?
}

struct RetryTax: Codable, Sendable {
    let totalUSD: Double
    let retries: Int
    let editTurns: Int
    let byModel: [RetryTaxModelEntry]
}

struct RoutingWasteModelEntry: Codable, Sendable {
    let name: String
    let costPerEdit: Double
    let editTurns: Int
    let actualUSD: Double
    let counterfactualUSD: Double
    let savingsUSD: Double
}

struct RoutingWaste: Codable, Sendable {
    let totalSavingsUSD: Double
    let baselineModel: String
    let baselineCostPerEdit: Double
    let byModel: [RoutingWasteModelEntry]
}

struct CurrentBlock: Codable, Sendable {
    let label: String
    let cost: Double
    let calls: Int
    let sessions: Int
    let oneShotRate: Double?
    let inputTokens: Int
    let outputTokens: Int
    let cacheHitPercent: Double
    let topActivities: [ActivityEntry]
    let topModels: [ModelEntry]
    let providers: [String: Double]
    let topProjects: [ProjectEntry]
    let modelEfficiency: [ModelEfficiencyEntry]
    let topSessions: [TopSessionEntry]
    let retryTax: RetryTax
    let routingWaste: RoutingWaste
}

extension CurrentBlock {
    enum CodingKeys: String, CodingKey {
        case label, cost, calls, sessions, oneShotRate, inputTokens, outputTokens,
             cacheHitPercent, topActivities, topModels, providers, topProjects,
             modelEfficiency, topSessions, retryTax, routingWaste
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        label = try c.decode(String.self, forKey: .label)
        cost = try c.decode(Double.self, forKey: .cost)
        calls = try c.decode(Int.self, forKey: .calls)
        sessions = try c.decode(Int.self, forKey: .sessions)
        oneShotRate = try c.decodeIfPresent(Double.self, forKey: .oneShotRate)
        inputTokens = try c.decode(Int.self, forKey: .inputTokens)
        outputTokens = try c.decode(Int.self, forKey: .outputTokens)
        cacheHitPercent = try c.decodeIfPresent(Double.self, forKey: .cacheHitPercent) ?? 0
        topActivities = try c.decodeIfPresent([ActivityEntry].self, forKey: .topActivities) ?? []
        topModels = try c.decodeIfPresent([ModelEntry].self, forKey: .topModels) ?? []
        providers = try c.decodeIfPresent([String: Double].self, forKey: .providers) ?? [:]
        topProjects = try c.decodeIfPresent([ProjectEntry].self, forKey: .topProjects) ?? []
        modelEfficiency = try c.decodeIfPresent([ModelEfficiencyEntry].self, forKey: .modelEfficiency) ?? []
        topSessions = try c.decodeIfPresent([TopSessionEntry].self, forKey: .topSessions) ?? []
        retryTax = try c.decodeIfPresent(RetryTax.self, forKey: .retryTax) ?? RetryTax(totalUSD: 0, retries: 0, editTurns: 0, byModel: [])
        routingWaste = try c.decodeIfPresent(RoutingWaste.self, forKey: .routingWaste) ?? RoutingWaste(totalSavingsUSD: 0, baselineModel: "", baselineCostPerEdit: 0, byModel: [])
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
    let cost: Double
    let calls: Int
}

struct SessionModelEntry: Codable, Sendable {
    let name: String
    let cost: Double
}

struct SessionDetailEntry: Codable, Sendable {
    let cost: Double
    let calls: Int
    let inputTokens: Int
    let outputTokens: Int
    let date: String
    let models: [SessionModelEntry]
}

struct ProjectEntry: Codable, Sendable {
    let name: String
    let cost: Double
    let sessions: Int
    let avgCostPerSession: Double
    let sessionDetails: [SessionDetailEntry]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        cost = try c.decode(Double.self, forKey: .cost)
        sessions = try c.decode(Int.self, forKey: .sessions)
        avgCostPerSession = try c.decode(Double.self, forKey: .avgCostPerSession)
        sessionDetails = try c.decodeIfPresent([SessionDetailEntry].self, forKey: .sessionDetails) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case name, cost, sessions, avgCostPerSession, sessionDetails
    }
}

struct ModelEfficiencyEntry: Codable, Sendable {
    let name: String
    let costPerEdit: Double?
    let oneShotRate: Double?
}

struct TopSessionEntry: Codable, Sendable {
    let project: String
    let cost: Double
    let calls: Int
    let date: String
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
        current: CurrentBlock(
            label: "",
            cost: 0,
            calls: 0,
            sessions: 0,
            oneShotRate: nil,
            inputTokens: 0,
            outputTokens: 0,
            cacheHitPercent: 0,
            topActivities: [],
            topModels: [],
            providers: [:],
            topProjects: [],
            modelEfficiency: [],
            topSessions: [],
            retryTax: RetryTax(totalUSD: 0, retries: 0, editTurns: 0, byModel: []),
            routingWaste: RoutingWaste(totalSavingsUSD: 0, baselineModel: "", baselineCostPerEdit: 0, byModel: [])
        ),
        optimize: OptimizeBlock(findingCount: 0, savingsUSD: 0, topFindings: []),
        history: HistoryBlock(daily: [])
    )
}
