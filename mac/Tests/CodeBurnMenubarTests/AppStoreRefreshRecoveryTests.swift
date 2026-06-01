import Foundation
import Testing
@testable import CodeBurnMenubar

private func menubarPayload(cost: Double) -> MenubarPayload {
    MenubarPayload(
        generated: "test",
        current: CurrentBlock(
            label: "Today",
            cost: cost,
            calls: 1,
            sessions: 1,
            oneShotRate: nil,
            inputTokens: 1,
            outputTokens: 1,
            cacheHitPercent: 0,
            topActivities: [],
            topModels: [],
            providers: ["claude": cost],
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
        history: HistoryBlock(daily: [], intraday: []),
        stats: StatsSummary(trackedSpend: cost, trackedDays: 1, mostActiveDay: nil, peakDaySpend: cost, currentStreakDays: 1, longestStreakDays: 1)
    )
}

private func menubarPayload(providers: [String: Double]) -> MenubarPayload {
    let cost = providers.values.reduce(0, +)
    return MenubarPayload(
        generated: "test",
        current: CurrentBlock(
            label: "Today",
            cost: cost,
            calls: 1,
            sessions: 1,
            oneShotRate: nil,
            inputTokens: 1,
            outputTokens: 1,
            cacheHitPercent: 0,
            topActivities: [],
            topModels: [],
            providers: providers,
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
        history: HistoryBlock(daily: [], intraday: []),
        stats: StatsSummary(trackedSpend: cost, trackedDays: 1, mostActiveDay: nil, peakDaySpend: cost, currentStreakDays: 1, longestStreakDays: 1)
    )
}

@Suite("AppStore refresh recovery")
@MainActor
struct AppStoreRefreshRecoveryTests {
    @Test("stale visible payload triggers hard recovery without clearing cache")
    func stalePayloadTriggersHardRecoveryWithoutClearingCache() {
        let store = AppStore()
        store.setCachedPayloadForTesting(
            menubarPayload(cost: 92.33),
            period: .today,
            provider: .all,
            fetchedAt: Date().addingTimeInterval(-180)
        )

        #expect(store.todayPayload?.current.cost == 92.33)
        #expect(store.needsInteractivePayloadRefresh)
        #expect(store.needsStatusPayloadRefresh)
        #expect(store.hasStaleInteractivePayload)
        #expect(store.shouldResetInteractiveRefreshPipeline)

        store.resetRefreshState(clearCache: false)

        #expect(store.todayPayload?.current.cost == 92.33)
    }

    @Test("fresh visible payload does not trigger hard recovery")
    func freshPayloadDoesNotTriggerHardRecovery() {
        let store = AppStore()
        store.setCachedPayloadForTesting(
            menubarPayload(cost: 164.06),
            period: .today,
            provider: .all,
            fetchedAt: Date()
        )

        #expect(!store.needsInteractivePayloadRefresh)
        #expect(!store.needsStatusPayloadRefresh)
        #expect(!store.hasStaleInteractivePayload)
        #expect(!store.shouldResetInteractiveRefreshPipeline)
    }

    @Test("missing today status payload needs status refresh")
    func missingTodayStatusPayloadNeedsStatusRefresh() {
        let store = AppStore()

        #expect(store.todayPayload == nil)
        #expect(store.needsStatusPayloadRefresh)
    }

    @Test("missing unattempted payload triggers hard recovery")
    func missingUnattemptedPayloadTriggersHardRecovery() {
        let store = AppStore()

        #expect(!store.hasCachedData)
        #expect(!store.hasAttemptedCurrentKeyLoad)
        #expect(store.needsInteractivePayloadRefresh)
        #expect(store.hasMissingInteractivePayloadWithoutAttempt)
        #expect(store.shouldResetInteractiveRefreshPipeline)
    }

    @Test("refresh pause message is visible and clearable")
    func refreshPauseMessageIsVisibleAndClearable() {
        let store = AppStore()

        store.pauseAutomaticRefresh(until: Date().addingTimeInterval(60), consecutiveStalls: 3)
        #expect(store.refreshPauseMessage?.contains("Refresh paused") == true)
        #expect(store.refreshPauseMessage?.contains("3 stalled attempts") == true)

        store.clearRefreshPause()
        #expect(store.refreshPauseMessage == nil)
    }

    @Test("most used provider is resolved from cached provider totals")
    func mostUsedProviderUsesCachedProviderTotals() {
        let store = AppStore()
        store.setCachedPayloadForTesting(
            menubarPayload(providers: ["claude": 3, "codex": 8, "gemini": 2]),
            period: .today,
            provider: .all,
            fetchedAt: Date()
        )

        #expect(store.mostUsedProviderFilter == .codex)
    }

    @Test("most used provider includes lazy provider filters")
    func mostUsedProviderIncludesLazyProviderFilters() {
        let store = AppStore()
        store.setCachedPayloadForTesting(
            menubarPayload(providers: ["mistral-vibe": 12, "forge": 9, "warp": 7]),
            period: .today,
            provider: .all,
            fetchedAt: Date()
        )

        #expect(store.mostUsedProviderFilter == .mistralVibe)
    }
}
