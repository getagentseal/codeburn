import Foundation
import Testing
@testable import CodeBurnMenubar

private func combinedUsage(cost: Double = 12.5) -> CombinedUsage {
    CombinedUsage(
        perDevice: [
            CombinedDeviceUsage(
                id: "local",
                name: "MacBook",
                local: true,
                error: nil,
                cost: cost,
                calls: 3,
                sessions: 2,
                inputTokens: 100,
                outputTokens: 50,
                cacheCreateTokens: 10,
                cacheReadTokens: 20,
                totalTokens: 180
            )
        ],
        combined: CombinedUsageTotals(
            cost: cost,
            calls: 3,
            sessions: 2,
            inputTokens: 100,
            outputTokens: 50,
            cacheCreateTokens: 10,
            cacheReadTokens: 20,
            totalTokens: 180,
            deviceCount: 1,
            reachableCount: 1
        )
    )
}

private func menubarPayload(cost: Double, combined: CombinedUsage? = nil) -> MenubarPayload {
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
        history: HistoryBlock(daily: []),
        combined: combined
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

    @Test("payload cache partitions local and combined scope")
    func payloadCachePartitionsByScope() {
        let store = AppStore()
        store.setCachedPayloadForTesting(
            menubarPayload(cost: 10),
            scope: .local,
            period: .today,
            provider: .all,
            fetchedAt: Date()
        )
        store.setCachedPayloadForTesting(
            menubarPayload(cost: 99, combined: combinedUsage(cost: 42)),
            scope: .combined,
            period: .today,
            provider: .all,
            fetchedAt: Date()
        )

        #expect(store.cachedPayloadForTesting(scope: .local, period: .today, provider: .all)?.current.cost == 10)
        #expect(store.cachedPayloadForTesting(scope: .combined, period: .today, provider: .all)?.current.cost == 99)

        store.selectedScope = .combined

        #expect(store.payload.current.cost == 10)
        #expect(store.payload.combined?.combined.cost == 42)
    }

    @Test("multi-day combined selection uses local cache path")
    func multiDayCombinedSelectionUsesLocalCachePath() {
        let store = AppStore()
        let days: Set<String> = ["2026-06-01", "2026-06-02"]
        store.selectedScope = .combined
        store.selectedDays = days

        store.setCachedPayloadForTesting(
            menubarPayload(cost: 18),
            scope: .local,
            period: .today,
            provider: .all,
            days: days,
            fetchedAt: Date()
        )
        store.setCachedPayloadForTesting(
            menubarPayload(cost: 99, combined: combinedUsage(cost: 44)),
            scope: .combined,
            period: .today,
            provider: .all,
            days: days,
            fetchedAt: Date()
        )

        #expect(store.activeScope == .local)
        #expect(store.payload.current.cost == 18)
        #expect(store.payload.combined == nil)
    }

    @Test("combined failure state does not invalidate local badge payload")
    func combinedFailureDoesNotInvalidateLocalBadgePayload() {
        let store = AppStore()
        store.setCachedPayloadForTesting(
            menubarPayload(cost: 31),
            scope: .local,
            period: .today,
            provider: .all,
            fetchedAt: Date()
        )
        store.selectedScope = .combined
        store.setLastErrorForTesting(
            "timeout",
            scope: .combined,
            period: .today,
            provider: .all
        )

        #expect(store.lastError == "timeout")
        #expect(store.menubarPayload?.current.cost == 31)
        #expect(!store.needsStatusPayloadRefresh)
        #expect(store.payload.current.cost == 31)
        #expect(store.payload.combined == nil)
    }

    @Test("switching to combined resets selected provider to all")
    func switchingToCombinedResetsSelectedProviderToAll() {
        let store = AppStore()
        store.suppressRefreshesForTesting()
        store.selectedScope = .local
        store.selectedProvider = .claude

        store.switchTo(scope: .combined)

        #expect(store.selectedScope == .combined)
        #expect(store.selectedProvider == .all)
    }

    @Test("daily budget warning is suppressed for combined scope")
    func dailyBudgetWarningIsSuppressedForCombinedScope() {
        let defaults = UserDefaults.standard
        let previousDisplayMetric = defaults.object(forKey: "CodeBurnDisplayMetric")
        let previousDailyBudget = defaults.object(forKey: "CodeBurnDailyBudget")
        defer {
            if let previousDisplayMetric {
                defaults.set(previousDisplayMetric, forKey: "CodeBurnDisplayMetric")
            } else {
                defaults.removeObject(forKey: "CodeBurnDisplayMetric")
            }
            if let previousDailyBudget {
                defaults.set(previousDailyBudget, forKey: "CodeBurnDailyBudget")
            } else {
                defaults.removeObject(forKey: "CodeBurnDailyBudget")
            }
        }

        let store = AppStore()
        store.selectedScope = .local
        store.selectedDays = []
        store.displayMetric = .cost
        store.dailyBudget = 10
        store.setCachedPayloadForTesting(
            menubarPayload(cost: 12.5),
            scope: .local,
            period: .today,
            provider: .all,
            fetchedAt: Date()
        )

        #expect(store.isOverDailyBudget)
        #expect(store.shouldShowDailyBudgetWarning)

        store.selectedScope = .combined

        #expect(store.isOverDailyBudget)
        #expect(!store.shouldShowDailyBudgetWarning)
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
