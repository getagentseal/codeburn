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
            providers: ["claude": cost]
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
        #expect(!store.hasStaleInteractivePayload)
        #expect(!store.shouldResetInteractiveRefreshPipeline)
    }
}
