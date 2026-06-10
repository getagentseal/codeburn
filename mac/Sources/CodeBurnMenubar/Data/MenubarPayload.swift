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
    let savingsUSD: Double
    let calls: Int
    let inputTokens: Int
    let outputTokens: Int

    var totalTokens: Int { inputTokens + outputTokens }

    enum CodingKeys: String, CodingKey {
        case name, cost, savingsUSD, calls, inputTokens, outputTokens
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        cost = try c.decode(Double.self, forKey: .cost)
        savingsUSD = try c.decodeIfPresent(Double.self, forKey: .savingsUSD) ?? 0
        calls = try c.decode(Int.self, forKey: .calls)
        inputTokens = try c.decode(Int.self, forKey: .inputTokens)
        outputTokens = try c.decode(Int.self, forKey: .outputTokens)
    }
}

struct DailyHistoryEntry: Codable, Sendable {
    let date: String
    let cost: Double
    let savingsUSD: Double
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
        case date, cost, savingsUSD, calls, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, topModels
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        date = try c.decode(String.self, forKey: .date)
        cost = try c.decode(Double.self, forKey: .cost)
        savingsUSD = try c.decodeIfPresent(Double.self, forKey: .savingsUSD) ?? 0
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
    let localModelSavings: LocalModelSavings
    let providers: [String: Double]
    let topProjects: [ProjectEntry]
    let modelEfficiency: [ModelEfficiencyEntry]
    let topSessions: [TopSessionEntry]
    let retryTax: RetryTax
    let routingWaste: RoutingWaste
    let tools: [ToolEntry]
    let skills: [SkillEntry]
    let subagents: [SubagentEntry]
    let mcpServers: [McpServerEntry]
    let codexChats48h: CodexChatsReport
}

extension CurrentBlock {
    enum CodingKeys: String, CodingKey {
        case label, cost, calls, sessions, oneShotRate, inputTokens, outputTokens,
             cacheHitPercent, topActivities, topModels, localModelSavings, providers, topProjects,
             modelEfficiency, topSessions, retryTax, routingWaste,
             tools, skills, subagents, mcpServers, codexChats48h
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
        localModelSavings = try c.decodeIfPresent(LocalModelSavings.self, forKey: .localModelSavings) ?? LocalModelSavings(totalUSD: 0, calls: 0, byModel: [], byProvider: [])
        providers = try c.decodeIfPresent([String: Double].self, forKey: .providers) ?? [:]
        topProjects = try c.decodeIfPresent([ProjectEntry].self, forKey: .topProjects) ?? []
        modelEfficiency = try c.decodeIfPresent([ModelEfficiencyEntry].self, forKey: .modelEfficiency) ?? []
        topSessions = try c.decodeIfPresent([TopSessionEntry].self, forKey: .topSessions) ?? []
        retryTax = try c.decodeIfPresent(RetryTax.self, forKey: .retryTax) ?? RetryTax(totalUSD: 0, retries: 0, editTurns: 0, byModel: [])
        routingWaste = try c.decodeIfPresent(RoutingWaste.self, forKey: .routingWaste) ?? RoutingWaste(totalSavingsUSD: 0, baselineModel: "", baselineCostPerEdit: 0, byModel: [])
        tools = try c.decodeIfPresent([ToolEntry].self, forKey: .tools) ?? []
        skills = try c.decodeIfPresent([SkillEntry].self, forKey: .skills) ?? []
        subagents = try c.decodeIfPresent([SubagentEntry].self, forKey: .subagents) ?? []
        mcpServers = try c.decodeIfPresent([McpServerEntry].self, forKey: .mcpServers) ?? []
        codexChats48h = try c.decodeIfPresent(CodexChatsReport.self, forKey: .codexChats48h) ?? .empty
    }
}

struct CodexChatsReport: Codable, Sendable {
    let label: String
    let provider: String
    let hours: Int
    let totalChats: Int
    let returnedChats: Int
    let totals: CodexChatTotals
    let chats: [CodexChatEntry]

    static let empty = CodexChatsReport(
        label: "Last 48h",
        provider: "codex",
        hours: 48,
        totalChats: 0,
        returnedChats: 0,
        totals: .empty,
        chats: []
    )
}

struct CodexChatTotals: Codable, Sendable {
    let calls: Int
    let cost: Double
    let inputTokens: Int
    let outputTokens: Int
    let cacheReadTokens: Int
    let cacheWriteTokens: Int
    let totalTokens: Int

    static let empty = CodexChatTotals(
        calls: 0,
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0
    )
}

struct CodexChatEntry: Codable, Sendable {
    let project: String
    let projectDisplayName: String
    let projectPath: String
    let sessionId: String
    let sessionDisplayId: String
    let chatTitle: String
    let startedAt: String
    let lastSeenAt: String
    let calls: Int
    let cost: Double
    let inputTokens: Int
    let outputTokens: Int
    let cacheReadTokens: Int
    let cacheWriteTokens: Int
    let totalTokens: Int
    let models: [CodexChatModelEntry]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        project = try c.decode(String.self, forKey: .project)
        projectDisplayName = try c.decodeIfPresent(String.self, forKey: .projectDisplayName) ?? project
        projectPath = try c.decodeIfPresent(String.self, forKey: .projectPath) ?? ""
        sessionId = try c.decode(String.self, forKey: .sessionId)
        sessionDisplayId = try c.decodeIfPresent(String.self, forKey: .sessionDisplayId) ?? String(sessionId.suffix(8))
        let title = try c.decodeIfPresent(String.self, forKey: .chatTitle) ?? ""
        chatTitle = title.isEmpty ? "Untitled chat" : title
        startedAt = try c.decodeIfPresent(String.self, forKey: .startedAt) ?? ""
        lastSeenAt = try c.decodeIfPresent(String.self, forKey: .lastSeenAt) ?? ""
        calls = try c.decodeIfPresent(Int.self, forKey: .calls) ?? 0
        cost = try c.decodeIfPresent(Double.self, forKey: .cost) ?? 0
        inputTokens = try c.decodeIfPresent(Int.self, forKey: .inputTokens) ?? 0
        outputTokens = try c.decodeIfPresent(Int.self, forKey: .outputTokens) ?? 0
        cacheReadTokens = try c.decodeIfPresent(Int.self, forKey: .cacheReadTokens) ?? 0
        cacheWriteTokens = try c.decodeIfPresent(Int.self, forKey: .cacheWriteTokens) ?? 0
        totalTokens = try c.decodeIfPresent(Int.self, forKey: .totalTokens) ?? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
        models = try c.decodeIfPresent([CodexChatModelEntry].self, forKey: .models) ?? []
    }
}

struct CodexChatModelEntry: Codable, Sendable {
    let name: String
    let calls: Int
    let cost: Double
    let inputTokens: Int
    let outputTokens: Int
    let cacheReadTokens: Int
    let cacheWriteTokens: Int
}

struct LocalModelSavingsByModel: Codable, Sendable {
    let name: String
    let calls: Int
    let actualUSD: Double
    let savingsUSD: Double
    let baselineModel: String
    let inputTokens: Int
    let outputTokens: Int
}

struct LocalModelSavingsByProvider: Codable, Sendable {
    let name: String
    let calls: Int
    let savingsUSD: Double
}

struct LocalModelSavings: Codable, Sendable {
    let totalUSD: Double
    let calls: Int
    let byModel: [LocalModelSavingsByModel]
    let byProvider: [LocalModelSavingsByProvider]
}

struct ActivityEntry: Codable, Sendable {
    let name: String
    let cost: Double
    let savingsUSD: Double
    let turns: Int
    let oneShotRate: Double?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        cost = try c.decode(Double.self, forKey: .cost)
        savingsUSD = try c.decodeIfPresent(Double.self, forKey: .savingsUSD) ?? 0
        turns = try c.decode(Int.self, forKey: .turns)
        oneShotRate = try c.decodeIfPresent(Double.self, forKey: .oneShotRate)
    }

    private enum CodingKeys: String, CodingKey {
        case name, cost, savingsUSD, turns, oneShotRate
    }
}

struct ModelEntry: Codable, Sendable {
    let name: String
    let cost: Double
    let savingsUSD: Double
    let savingsBaselineModel: String
    let calls: Int

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        cost = try c.decode(Double.self, forKey: .cost)
        savingsUSD = try c.decodeIfPresent(Double.self, forKey: .savingsUSD) ?? 0
        savingsBaselineModel = try c.decodeIfPresent(String.self, forKey: .savingsBaselineModel) ?? ""
        calls = try c.decode(Int.self, forKey: .calls)
    }

    private enum CodingKeys: String, CodingKey {
        case name, cost, savingsUSD, savingsBaselineModel, calls
    }
}

struct SessionModelEntry: Codable, Sendable {
    let name: String
    let cost: Double
    let savingsUSD: Double

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        cost = try c.decode(Double.self, forKey: .cost)
        savingsUSD = try c.decodeIfPresent(Double.self, forKey: .savingsUSD) ?? 0
    }

    private enum CodingKeys: String, CodingKey {
        case name, cost, savingsUSD
    }
}

struct SessionDetailEntry: Codable, Sendable {
    let cost: Double
    let savingsUSD: Double
    let calls: Int
    let inputTokens: Int
    let outputTokens: Int
    let date: String
    let models: [SessionModelEntry]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        cost = try c.decode(Double.self, forKey: .cost)
        savingsUSD = try c.decodeIfPresent(Double.self, forKey: .savingsUSD) ?? 0
        calls = try c.decode(Int.self, forKey: .calls)
        inputTokens = try c.decode(Int.self, forKey: .inputTokens)
        outputTokens = try c.decode(Int.self, forKey: .outputTokens)
        date = try c.decode(String.self, forKey: .date)
        models = try c.decodeIfPresent([SessionModelEntry].self, forKey: .models) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case cost, savingsUSD, calls, inputTokens, outputTokens, date, models
    }
}

struct ProjectEntry: Codable, Sendable {
    let name: String
    let cost: Double
    let savingsUSD: Double
    let sessions: Int
    let avgCostPerSession: Double
    let sessionDetails: [SessionDetailEntry]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        cost = try c.decode(Double.self, forKey: .cost)
        savingsUSD = try c.decodeIfPresent(Double.self, forKey: .savingsUSD) ?? 0
        sessions = try c.decode(Int.self, forKey: .sessions)
        avgCostPerSession = try c.decode(Double.self, forKey: .avgCostPerSession)
        sessionDetails = try c.decodeIfPresent([SessionDetailEntry].self, forKey: .sessionDetails) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case name, cost, savingsUSD, sessions, avgCostPerSession, sessionDetails
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
    let savingsUSD: Double
    let calls: Int
    let date: String

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        project = try c.decode(String.self, forKey: .project)
        cost = try c.decode(Double.self, forKey: .cost)
        savingsUSD = try c.decodeIfPresent(Double.self, forKey: .savingsUSD) ?? 0
        calls = try c.decode(Int.self, forKey: .calls)
        date = try c.decode(String.self, forKey: .date)
    }

    private enum CodingKeys: String, CodingKey {
        case project, cost, savingsUSD, calls, date
    }
}

struct ToolEntry: Codable, Sendable {
    let name: String
    let calls: Int
}

struct SkillEntry: Codable, Sendable {
    let name: String
    let turns: Int
    let cost: Double
}

struct SubagentEntry: Codable, Sendable {
    let name: String
    let calls: Int
    let cost: Double
}

struct McpServerEntry: Codable, Sendable {
    let name: String
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
            cacheHitPercent: 0,
            topActivities: [],
            topModels: [],
            localModelSavings: LocalModelSavings(totalUSD: 0, calls: 0, byModel: [], byProvider: []),
            providers: [:],
            topProjects: [],
            modelEfficiency: [],
            topSessions: [],
            retryTax: RetryTax(totalUSD: 0, retries: 0, editTurns: 0, byModel: []),
            routingWaste: RoutingWaste(totalSavingsUSD: 0, baselineModel: "", baselineCostPerEdit: 0, byModel: []),
            tools: [],
            skills: [],
            subagents: [],
            mcpServers: [],
            codexChats48h: .empty
        ),
        optimize: OptimizeBlock(findingCount: 0, savingsUSD: 0, topFindings: []),
        history: HistoryBlock(daily: [])
    )
}
