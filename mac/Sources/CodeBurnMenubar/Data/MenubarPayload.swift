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

struct CurrentBlock: Codable, Sendable {
    let label: String
    let cost: Double
    let calls: Int
    let sessions: Int
    let oneShotRate: Double?
    let inputTokens: Int
    let outputTokens: Int
    let cacheReadTokens: Int
    let cacheWriteTokens: Int
    let cacheHitPercent: Double
    let topActivities: [ActivityEntry]
    let topModels: [ModelEntry]
    let providers: [String: Double]

    var totalTokens: Int {
        inputTokens + outputTokens
    }
}

struct ActivityEntry: Codable, Sendable {
    let name: String
    let cost: Double
    let turns: Int
    let inputTokens: Int
    let outputTokens: Int
    let cacheReadTokens: Int
    let cacheWriteTokens: Int
    let oneShotRate: Double?

    var totalTokens: Int {
        inputTokens + outputTokens
    }
}

extension CurrentBlock {
    enum CodingKeys: String, CodingKey {
        case label, cost, calls, sessions, oneShotRate, inputTokens, outputTokens
        case cacheReadTokens, cacheWriteTokens, cacheHitPercent, topActivities, topModels, providers
    }

    /// Legacy current blocks already carried input/output tokens; only cache
    /// read/write tokens are new here, so malformed payloads still fail loudly
    /// for the pre-existing required fields.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        label = try c.decode(String.self, forKey: .label)
        cost = try c.decode(Double.self, forKey: .cost)
        calls = try c.decode(Int.self, forKey: .calls)
        sessions = try c.decode(Int.self, forKey: .sessions)
        oneShotRate = try c.decodeIfPresent(Double.self, forKey: .oneShotRate)
        inputTokens = try c.decode(Int.self, forKey: .inputTokens)
        outputTokens = try c.decode(Int.self, forKey: .outputTokens)
        cacheReadTokens = try c.decodeIfPresent(Int.self, forKey: .cacheReadTokens) ?? 0
        cacheWriteTokens = try c.decodeIfPresent(Int.self, forKey: .cacheWriteTokens) ?? 0
        cacheHitPercent = try c.decode(Double.self, forKey: .cacheHitPercent)
        topActivities = try c.decode([ActivityEntry].self, forKey: .topActivities)
        topModels = try c.decode([ModelEntry].self, forKey: .topModels)
        providers = try c.decode([String: Double].self, forKey: .providers)
    }
}

extension ActivityEntry {
    enum CodingKeys: String, CodingKey {
        case name, cost, turns, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, oneShotRate
    }

    /// Older activity rows only carried cost/turns/one-shot data, so every
    /// per-activity token bucket defaults to zero for defensive readback.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        cost = try c.decode(Double.self, forKey: .cost)
        turns = try c.decode(Int.self, forKey: .turns)
        inputTokens = try c.decodeIfPresent(Int.self, forKey: .inputTokens) ?? 0
        outputTokens = try c.decodeIfPresent(Int.self, forKey: .outputTokens) ?? 0
        cacheReadTokens = try c.decodeIfPresent(Int.self, forKey: .cacheReadTokens) ?? 0
        cacheWriteTokens = try c.decodeIfPresent(Int.self, forKey: .cacheWriteTokens) ?? 0
        oneShotRate = try c.decodeIfPresent(Double.self, forKey: .oneShotRate)
    }
}

struct ModelEntry: Codable, Sendable {
    let name: String
    let cost: Double
    let calls: Int
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
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            cacheHitPercent: 0,
            topActivities: [],
            topModels: [],
            providers: [:]
        ),
        optimize: OptimizeBlock(findingCount: 0, savingsUSD: 0, topFindings: []),
        history: HistoryBlock(daily: [])
    )
}
