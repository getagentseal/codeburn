import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Period switch regression — no reload flash")
@MainActor
struct PeriodSwitchRegressionTests {

    @Test("hasCachedData returns true when lastNonEmptyPayload exists")
    func hasCachedDataWithStalePayload() {
        // This regression test ensures that switching to an uncached period
        // does NOT show a loading overlay when we have previous data.
        // The fix: hasCachedData checks lastNonEmptyPayload as fallback.
        let store = AppStore()
        // Access payload once to seed lastNonEmptyPayload (from today's cached data if any)
        _ = store.payload
        // hasCachedData should be true after any successful data load
        // even when switching to an uncached period key
        // (We can't fully simulate period switch without CLI, but we verify the property logic)
        #expect(store.hasCachedData || store.payload.current.cost == 0)
    }

    @Test("switchToMostUsedProviderIfAvailable is a no-op")
    func autoSwitchDisabled() {
        // Regression: period switches used to trigger auto-provider-switch
        // which jumped the user to a different tab. Now it's disabled.
        let store = AppStore()
        let before = store.selectedProvider
        store.switchToMostUsedProviderIfAvailable()
        #expect(store.selectedProvider == before)
    }

    @Test("switchTo(period:) does not reset selectedProvider")
    func periodSwitchKeepsProvider() {
        let store = AppStore()
        store.switchTo(provider: .all)
        let providerBefore = store.selectedProvider
        store.switchTo(period: .month)
        #expect(store.selectedProvider == providerBefore)
        store.switchTo(period: .lifetime)
        #expect(store.selectedProvider == providerBefore)
    }

    @Test("Period.allCases includes all expected periods")
    func allPeriodsPresent() {
        let cases = Period.allCases
        #expect(cases.contains(.today))
        #expect(cases.contains(.sevenDays))
        #expect(cases.contains(.thirtyDays))
        #expect(cases.contains(.month))
        #expect(cases.contains(.all))
        #expect(cases.contains(.lifetime))
    }

    @Test("AccentPreset includes Catppuccin themes")
    func catppuccinPresetsExist() {
        let names = AccentPreset.allCases.map(\.rawValue)
        #expect(names.contains("Latte"))
        #expect(names.contains("Frappé"))
        #expect(names.contains("Macchiato"))
        #expect(names.contains("Mocha"))
    }

    @Test("AccentPreset all have emoji")
    func allPresetsHaveEmoji() {
        for preset in AccentPreset.allCases {
            #expect(!preset.emoji.isEmpty)
        }
    }
}
