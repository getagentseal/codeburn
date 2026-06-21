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
            codexCredits: nil,
            topActivities: [],
            topModels: [],
            localModelSavings: LocalModelSavings(totalUSD: 0, calls: 0, byModel: [], byProvider: []),
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
        history: HistoryBlock(daily: [])
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

    @Test("orphaned stale in-flight entry does not block stuck-loading recovery")
    func staleInFlightDoesNotBlockRecovery() {
        let store = AppStore()
        // A quiet refresh torn down across sleep/wake can leave an in-flight
        // entry behind for the current key with no cache and no active loading
        // counter, far older than the watchdog window. Recovery must clear it
        // and proceed instead of bailing on the in-flight guard forever.
        store.seedInFlightForTesting(period: .today, provider: .all, insertedAt: Date().addingTimeInterval(-3600))

        #expect(store.isInFlightForTesting(period: .today, provider: .all))

        let canRecover = store.prepareStuckLoadingRecovery()

        #expect(canRecover)
        #expect(!store.isInFlightForTesting(period: .today, provider: .all))
    }

    @Test("healthy in-flight fetch is not killed by recovery")
    func healthyInFlightFetchSurvivesRecovery() {
        let store = AppStore()
        store.seedInFlightForTesting(period: .today, provider: .all, insertedAt: Date())

        let canRecover = store.prepareStuckLoadingRecovery()

        #expect(!canRecover)
        #expect(store.isInFlightForTesting(period: .today, provider: .all))
    }

    @Test("prepareStuckLoadingRecovery clears stale loading bookkeeping for the current key")
    func popoverRecoveryClearsStuckLoading() {
        let store = AppStore()
        // Seed an orphaned in-flight entry older than the 60s watchdog so the
        // stale-clear path runs, mimicking a fetch torn down across sleep/wake.
        store.seedInFlightForTesting(
            period: .today,
            provider: .all,
            insertedAt: Date().addingTimeInterval(-120)
        )
        #expect(store.isInFlightForTesting(period: .today, provider: .all))

        let willFetch = store.prepareStuckLoadingRecovery()

        #expect(willFetch)
        #expect(!store.isInFlightForTesting(period: .today, provider: .all))
    }

}
