import Foundation
import Testing
@testable import CodeBurnMenubar

/// The glance card is scoped to ONE provider, so its Today row has to be too.
/// It used to render the machine-wide block, which printed every provider's
/// spend under whichever card the pointer happened to be on.
private func todayPayload(
    cost: Double,
    calls: Int,
    inputTokens: Int,
    outputTokens: Int,
    providerDetails: [ProviderDetail]
) -> MenubarPayload {
    MenubarPayload(
        generated: "test",
        current: CurrentBlock(
            label: "Today",
            cost: cost,
            calls: calls,
            sessions: 0,
            oneShotRate: nil,
            inputTokens: inputTokens,
            outputTokens: outputTokens,
            cacheHitPercent: 0,
            codexCredits: nil,
            topActivities: [],
            topModels: [],
            localModelSavings: LocalModelSavings(totalUSD: 0, calls: 0, byModel: [], byProvider: []),
            providers: [:],
            providerDetails: providerDetails,
            topProjects: [],
            modelEfficiency: [],
            topSessions: [],
            retryTax: RetryTax(totalUSD: 0, retries: 0, editTurns: 0, byModel: []),
            routingWaste: RoutingWaste(totalSavingsUSD: 0, baselineModel: "", baselineCostPerEdit: 0, byModel: []),
            tools: [],
            skills: [],
            subagents: [],
            mcpServers: []
        ),
        optimize: OptimizeBlock(findingCount: 0, savingsUSD: 0, topFindings: []),
        history: HistoryBlock(daily: []),
        combined: nil,
        claudeConfigs: nil
    )
}

@MainActor
private func store(_ payload: MenubarPayload) -> AppStore {
    let store = AppStore()
    store.setCachedPayloadForTesting(payload, period: .today, provider: .all, fetchedAt: Date())
    return store
}

@Suite("Capacity Dock Today row")
@MainActor
struct CapacityDockTodayTests {
    @Test("The row is the hovered provider's own figures, not the machine's")
    func rowIsSelectedByProviderID() {
        let store = store(todayPayload(
            cost: 278.94,
            calls: 1_542,
            inputTokens: 9_000_000,
            outputTokens: 400_000,
            providerDetails: [
                ProviderDetail(id: "claude", label: "Claude", cost: 190.10, calls: 900,
                               hasUsage: true, inputTokens: 6_000_000, outputTokens: 250_000, sessions: 12),
                ProviderDetail(id: "codex", label: "Codex", cost: 88.84, calls: 642,
                               hasUsage: true, inputTokens: 3_000_000, outputTokens: 150_000, sessions: 4),
            ]
        ))

        let claude = store.capacityDockToday(for: .claude)
        #expect(claude?.cost == 190.10)
        #expect(claude?.calls == 900)
        #expect(claude?.inputTokens == 6_000_000)
        #expect(claude?.outputTokens == 250_000)
        // The machine-wide block is still there; it just is not what the card shows.
        #expect(store.capacityDockToday?.cost == 278.94)
        #expect(store.capacityDockToday(for: .codex)?.cost == 88.84)
        #expect(store.capacityDockToday(for: .codex)?.calls == 642)
    }

    @Test("One Cursor tile sums the editor and the agent rows the CLI splits it into")
    func tileCoveringSeveralRowsSums() {
        let cursor = CapacityDockProvider(rawValue: "cursor")!
        #expect(cursor.payloadProviderIDs == ["cursor", "cursor-agent"])
        // Every other tile stands for exactly one row.
        #expect(CapacityDockProvider.claude.payloadProviderIDs == ["claude"])
        #expect(CapacityDockProvider.kimiCode.payloadProviderIDs == ["kimicode"])

        let store = store(todayPayload(
            cost: 292.52,
            calls: 1_709,
            inputTokens: 9_008,
            outputTokens: 1_528_196,
            providerDetails: [
                ProviderDetail(id: "claude", label: "Claude", cost: 292.51, calls: 1_695,
                               hasUsage: true, inputTokens: 7_510, outputTokens: 1_527_919, sessions: 30),
                // The account was busy, but every session landed under the agent row,
                // so a tile reading only "cursor" reported zero.
                ProviderDetail(id: "cursor", label: "Cursor", cost: 0, calls: 0, hasUsage: false,
                               inputTokens: nil, outputTokens: nil, sessions: nil),
                ProviderDetail(id: "cursor-agent", label: "Cursor Agent", cost: 0.0086, calls: 14,
                               hasUsage: true, inputTokens: 1_498, outputTokens: 277, sessions: 2),
            ]
        ))

        let row = store.capacityDockToday(for: cursor)
        #expect(row?.cost == 0.0086)
        #expect(row?.calls == 14)
        #expect(row?.inputTokens == 1_498)
        #expect(row?.outputTokens == 277)
        #expect(row?.sessions == 2)
        #expect(row?.hasUsage == true)
        // The tile keeps its own identity rather than borrowing a row's.
        #expect(row?.id == "cursor")
    }

    @Test("The Droid tile reads the CLI's droid rows, not its own catalog id")
    func factoryTileReadsDroid() {
        let droid = CapacityDockProvider(rawValue: "factory")!
        #expect(droid.payloadProviderIDs == ["droid"])
        let store = store(todayPayload(
            cost: 5,
            calls: 20,
            inputTokens: 100,
            outputTokens: 200,
            providerDetails: [
                ProviderDetail(id: "droid", label: "Droid", cost: 5, calls: 20,
                               hasUsage: true, inputTokens: 100, outputTokens: 200, sessions: 3),
            ]
        ))
        #expect(store.capacityDockToday(for: droid)?.calls == 20)
        #expect(store.capacityDockToday(for: droid)?.cost == 5)
    }

    @Test("ClinePass covers both Cline surfaces the CLI records separately")
    func clinePassCoversBothClineRows() {
        let pass = CapacityDockProvider(rawValue: "clinepass")!
        #expect(pass.payloadProviderIDs == ["cline", "cline-cli"])
        let store = store(todayPayload(
            cost: 9,
            calls: 30,
            inputTokens: 900,
            outputTokens: 90,
            providerDetails: [
                ProviderDetail(id: "cline", label: "Cline", cost: 6, calls: 20,
                               hasUsage: true, inputTokens: 600, outputTokens: 60, sessions: 4),
                ProviderDetail(id: "cline-cli", label: "Cline CLI", cost: 3, calls: 10,
                               hasUsage: true, inputTokens: 300, outputTokens: 30, sessions: 1),
            ]
        ))
        let row = store.capacityDockToday(for: pass)
        #expect(row?.cost == 9)
        #expect(row?.calls == 30)
        #expect(row?.inputTokens == 900)
        #expect(row?.sessions == 5)
    }

    @Test("A tile whose rows carry no token breakdown reports none rather than zero")
    func combinedTileKeepsTokensAbsent() {
        let cursor = CapacityDockProvider(rawValue: "cursor")!
        let store = store(todayPayload(
            cost: 1,
            calls: 4,
            inputTokens: 0,
            outputTokens: 0,
            providerDetails: [
                ProviderDetail(id: "cursor", label: "Cursor", cost: 0.5, calls: 2, hasUsage: true,
                               inputTokens: nil, outputTokens: nil, sessions: nil),
                ProviderDetail(id: "cursor-agent", label: "Cursor Agent", cost: 0.5, calls: 2, hasUsage: true,
                               inputTokens: nil, outputTokens: nil, sessions: nil),
            ]
        ))
        let row = store.capacityDockToday(for: cursor)
        #expect(row?.cost == 1)
        #expect(row?.calls == 4)
        #expect(row?.inputTokens == nil)
        #expect(row?.outputTokens == nil)
    }

    @Test("Cache read is the hovered provider's own figure, not the machine's")
    func cacheReadIsProviderScoped() {
        let store = store(todayPayload(
            cost: 278.94,
            calls: 1_542,
            inputTokens: 9_000_000,
            outputTokens: 400_000,
            providerDetails: [
                ProviderDetail(id: "claude", label: "Claude", cost: 190.10, calls: 900,
                               hasUsage: true, inputTokens: 6_000_000, outputTokens: 250_000,
                               sessions: 12, cacheReadTokens: 4_200_000),
                ProviderDetail(id: "codex", label: "Codex", cost: 88.84, calls: 642,
                               hasUsage: true, inputTokens: 3_000_000, outputTokens: 150_000,
                               sessions: 4, cacheReadTokens: 120_000),
            ]
        ))
        #expect(store.capacityDockToday(for: .claude)?.cacheReadTokens == 4_200_000)
        #expect(store.capacityDockToday(for: .codex)?.cacheReadTokens == 120_000)
    }

    @Test("A tile spanning several rows sums cache read, absent until a row reports it")
    func combinedTileSumsCacheRead() {
        let cursor = CapacityDockProvider(rawValue: "cursor")!
        let sums = store(todayPayload(
            cost: 1,
            calls: 4,
            inputTokens: 0,
            outputTokens: 0,
            providerDetails: [
                ProviderDetail(id: "cursor", label: "Cursor", cost: 0.5, calls: 2, hasUsage: true,
                               cacheReadTokens: 3_000),
                ProviderDetail(id: "cursor-agent", label: "Cursor Agent", cost: 0.5, calls: 2, hasUsage: true,
                               cacheReadTokens: 40_000),
            ]
        ))
        #expect(sums.capacityDockToday(for: cursor)?.cacheReadTokens == 43_000)

        // Neither row reports cache read -> unknown, not a fabricated zero.
        let absent = store(todayPayload(
            cost: 1, calls: 4, inputTokens: 0, outputTokens: 0,
            providerDetails: [
                ProviderDetail(id: "cursor", label: "Cursor", cost: 0.5, calls: 2, hasUsage: true),
                ProviderDetail(id: "cursor-agent", label: "Cursor Agent", cost: 0.5, calls: 2, hasUsage: true),
            ]
        ))
        #expect(absent.capacityDockToday(for: cursor)?.cacheReadTokens == nil)
    }

    @Test("Known zero cache read stays zero; a legacy row stays unknown")
    func cacheReadZeroVersusMissing() {
        let store = store(todayPayload(
            cost: 1, calls: 4, inputTokens: 0, outputTokens: 0,
            providerDetails: [
                ProviderDetail(id: "claude", label: "Claude", cost: 1, calls: 4, hasUsage: true,
                               cacheReadTokens: 0),
            ]
        ))
        #expect(store.capacityDockToday(for: .claude)?.cacheReadTokens == 0)
    }

    @Test("A partial cache-read sum is unknown, not a complete-looking total")
    func partialCacheReadSumStaysUnknown() {
        // One tile row reports cache read, the other is an active row from a
        // CLI that predates the field: the tile must report none rather than
        // present the one known row's figure as the whole account's total.
        let cursor = CapacityDockProvider(rawValue: "cursor")!
        let partial = store(todayPayload(
            cost: 1, calls: 6, inputTokens: 0, outputTokens: 0,
            providerDetails: [
                ProviderDetail(id: "cursor", label: "Cursor", cost: 0.5, calls: 2, hasUsage: true,
                               cacheReadTokens: 3_000),
                ProviderDetail(id: "cursor-agent", label: "Cursor Agent", cost: 0.5, calls: 4, hasUsage: true),
            ]
        ))
        #expect(partial.capacityDockToday(for: cursor)?.cacheReadTokens == nil)
        // An idle row (no usage) does not force unknown: its cache read is a
        // genuine zero.
        let idle = store(todayPayload(
            cost: 0.5, calls: 2, inputTokens: 0, outputTokens: 0,
            providerDetails: [
                ProviderDetail(id: "cursor", label: "Cursor", cost: 0.5, calls: 2, hasUsage: true,
                               cacheReadTokens: 3_000),
                ProviderDetail(id: "cursor-agent", label: "Cursor Agent", cost: 0, calls: 0, hasUsage: false),
            ]
        ))
        #expect(idle.capacityDockToday(for: cursor)?.cacheReadTokens == 3_000)
    }

    @Test("Large cache counts survive without overflow")
    func cacheReadLargeCounts() {
        let store = store(todayPayload(
            cost: 1, calls: 4, inputTokens: 0, outputTokens: 0,
            providerDetails: [
                ProviderDetail(id: "claude", label: "Claude", cost: 1, calls: 4, hasUsage: true,
                               cacheReadTokens: 2_147_483_647),
            ]
        ))
        #expect(store.capacityDockToday(for: .claude)?.cacheReadTokens == 2_147_483_647)
    }

    @Test("Kimi Code reads its CLI row rather than the CLI's separate kimi provider")
    func dockIDMapsToTheCLIProviderID() {
        #expect(CapacityDockProvider.kimiCode.payloadProviderID == "kimicode")
        #expect(CapacityDockProvider.claude.payloadProviderID == "claude")
        #expect(CapacityDockProvider.codex.payloadProviderID == "codex")
        let store = store(todayPayload(
            cost: 9, calls: 9, inputTokens: 9, outputTokens: 9,
            providerDetails: [
                ProviderDetail(id: "kimi", label: "Kimi", cost: 8, calls: 8, hasUsage: true),
                ProviderDetail(id: "kimicode", label: "Kimi Code", cost: 1, calls: 1, hasUsage: true),
            ]
        ))
        #expect(store.capacityDockToday(for: .kimiCode)?.cost == 1)
    }

    @Test("A CLI without per-provider tokens hides them instead of borrowing the global pair")
    func absentTokensDoNotFallBackToTheGlobalFigures() {
        // Exactly what 0.9.23 emits: cost and calls per provider, no tokens.
        let store = store(todayPayload(
            cost: 278.94,
            calls: 1_542,
            inputTokens: 9_000_000,
            outputTokens: 400_000,
            providerDetails: [
                ProviderDetail(id: "claude", label: "Claude", cost: 190.10, calls: 900, hasUsage: true),
            ]
        ))
        let claude = store.capacityDockToday(for: .claude)
        // Cost and calls are still provider-scoped; the tokens are simply absent.
        #expect(claude?.cost == 190.10)
        #expect(claude?.calls == 900)
        #expect(claude?.inputTokens == nil)
        #expect(claude?.outputTokens == nil)
    }

    @Test("A provider with no usage today reads as a real zero")
    func zeroStateForAnIdleProvider() {
        let store = store(todayPayload(
            cost: 190.10,
            calls: 900,
            inputTokens: 6_000_000,
            outputTokens: 250_000,
            providerDetails: [
                ProviderDetail(id: "claude", label: "Claude", cost: 190.10, calls: 900,
                               hasUsage: true, inputTokens: 6_000_000, outputTokens: 250_000, sessions: 12),
            ]
        ))
        let codex = store.capacityDockToday(for: .codex)
        #expect(codex?.cost == 0)
        #expect(codex?.calls == 0)
        #expect(codex?.hasUsage == false)
        #expect(codex?.inputTokens == nil)
    }

    @Test("A payload with no provider breakdown drops the section rather than guess")
    func noBreakdownHidesTheSection() {
        let store = store(todayPayload(
            cost: 278.94, calls: 1_542, inputTokens: 1, outputTokens: 1, providerDetails: []
        ))
        #expect(store.capacityDockToday != nil)
        #expect(store.capacityDockToday(for: .claude) == nil)
        // Which is what the panel reserves height from.
        #expect(
            CapacityDockMetrics.detailHeight(
                quota: nil, sessionCount: nil, hasToday: false, tailEdge: .right, scale: 1
            ) == CapacityDockMetrics.detailHeight(
                quota: nil, sessionCount: nil, hasToday: true, tailEdge: .right, scale: 1
            )
        )
    }

    @Test("The Today row reserves the same height with or without the token column")
    func todayHeightIsIndependentOfTokenPresence() {
        // The token lines drop out of a fixed frame, so nothing in the panel's
        // computed height may vary with them — a fractional or drifting panel
        // height re-runs the window layout at display cadence.
        #expect(
            CapacityDockGlance.todayHeight
                == CapacityDockGlance.sectionPadTop
                + CapacityDockGlance.captionLine
                + CapacityDockGlance.pillGap
                + CapacityDockGlance.todayContentHeight
                + CapacityDockGlance.sectionPadBottom
        )
        let quota = QuotaSummary(
            providerFilter: .all,
            connection: .connected,
            primary: nil,
            details: [QuotaSummary.Window(label: "5-hour", percent: 0.2, resetsAt: nil)],
            planLabel: nil,
            footerLines: []
        )
        func height(_ hasToday: Bool, scale: CGFloat) -> CGFloat {
            CapacityDockMetrics.detailHeight(
                quota: quota, sessionCount: 1, hasToday: hasToday, tailEdge: .right, scale: scale
            )
        }
        #expect(height(true, scale: 1) - height(false, scale: 1) == CapacityDockGlance.todayHeight)
        for scale in [0.9, 1.0, 1.15, 1.25, 1.4] {
            let h = height(true, scale: CGFloat(scale))
            #expect(h == h.rounded())
        }
    }

    @Test("Token and session fields decode as absent on a payload that omits them")
    func providerDetailTokensAreOptional() throws {
        let legacy = """
        {"id":"claude","label":"Claude","cost":190.1,"calls":900,"hasUsage":true}
        """
        let old = try JSONDecoder().decode(ProviderDetail.self, from: Data(legacy.utf8))
        #expect(old.cost == 190.1)
        #expect(old.inputTokens == nil)
        #expect(old.outputTokens == nil)
        #expect(old.sessions == nil)
        #expect(old.cacheReadTokens == nil)

        let current = """
        {"id":"claude","label":"Claude","cost":190.1,"calls":900,"hasUsage":true,
         "inputTokens":6000000,"outputTokens":250000,"sessions":12}
        """
        let new = try JSONDecoder().decode(ProviderDetail.self, from: Data(current.utf8))
        #expect(new.inputTokens == 6_000_000)
        #expect(new.outputTokens == 250_000)
        #expect(new.sessions == 12)

        let withCache = """
        {"id":"claude","label":"Claude","cost":190.1,"calls":900,"hasUsage":true,
         "inputTokens":6000000,"outputTokens":250000,"sessions":12,"cacheReadTokens":4200000}
        """
        let cached = try JSONDecoder().decode(ProviderDetail.self, from: Data(withCache.utf8))
        #expect(cached.cacheReadTokens == 4_200_000)
    }
}
