import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Menubar period settings")
struct MenubarPeriodSettingsTests {
    @Test("settings picker exposes requested periods")
    func settingsPickerExposesRequestedPeriods() {
        #expect(Period.menubarMetricCases == [.today, .sevenDays, .month, .all])
    }

    @Test("period picker exposes the lifetime window, matching the CLI period set")
    func periodPickerExposesLifetime() {
        // The panel period selector iterates Period.allCases, so lifetime must be
        // present there while staying out of the menubar-metric subset.
        #expect(Period.allCases == [.today, .sevenDays, .thirtyDays, .month, .all, .lifetime])
        #expect(!Period.menubarMetricCases.contains(.lifetime))
    }

    @Test("period cliArg values match src/cli-date.ts --period values")
    func cliArgsMatchCLIPeriods() {
        #expect(Period.today.cliArg == "today")
        #expect(Period.sevenDays.cliArg == "week")
        #expect(Period.thirtyDays.cliArg == "30days")
        #expect(Period.month.cliArg == "month")
        #expect(Period.all.cliArg == "all")
        #expect(Period.lifetime.cliArg == "lifetime")
    }

    @Test("defaults values map to periods")
    func defaultsValuesMapToPeriods() {
        #expect(Period(menubarDefaultsValue: "today") == .today)
        #expect(Period(menubarDefaultsValue: "week") == .sevenDays)
        #expect(Period(menubarDefaultsValue: "month") == .month)
        #expect(Period(menubarDefaultsValue: "sixMonths") == .all)
        #expect(Period(menubarDefaultsValue: "all") == .all)
        #expect(Period(menubarDefaultsValue: "lifetime") == .lifetime)
        #expect(Period(menubarDefaultsValue: "30days") == .today)
        #expect(Period(menubarDefaultsValue: "bogus") == .today)
        #expect(Period(menubarDefaultsValue: nil) == .today)
    }

    @Test("periods persist canonical defaults values")
    func periodsPersistCanonicalDefaultsValues() {
        let suiteName = "CodeBurnMenubarTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        Period.sevenDays.persistAsMenubarDefault(defaults: defaults)
        #expect(defaults.string(forKey: "CodeBurnMenubarPeriod") == "week")
        #expect(Period.savedMenubarPeriod(defaults: defaults) == .sevenDays)

        Period.all.persistAsMenubarDefault(defaults: defaults)
        #expect(defaults.string(forKey: "CodeBurnMenubarPeriod") == "sixMonths")
        #expect(Period.savedMenubarPeriod(defaults: defaults) == .all)

        Period.thirtyDays.persistAsMenubarDefault(defaults: defaults)
        #expect(defaults.string(forKey: "CodeBurnMenubarPeriod") == "today")
        #expect(Period.savedMenubarPeriod(defaults: defaults) == .today)
    }

    @Test("menubar scope persistence defaults to local and round-trips")
    func menubarScopePersistenceDefaultsToLocalAndRoundTrips() {
        let suiteName = "CodeBurnMenubarTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(MenubarScope.savedMenubarScope(defaults: defaults) == .local)

        MenubarScope.combined.persistAsMenubarDefault(defaults: defaults)
        #expect(defaults.string(forKey: "CodeBurnMenubarScope") == "combined")
        #expect(MenubarScope.savedMenubarScope(defaults: defaults) == .combined)

        MenubarScope.local.persistAsMenubarDefault(defaults: defaults)
        #expect(defaults.string(forKey: "CodeBurnMenubarScope") == "local")
        #expect(MenubarScope.savedMenubarScope(defaults: defaults) == .local)
        #expect(MenubarScope(menubarDefaultsValue: "bogus") == .local)
    }

    @Test("non-today periods render compact and regular suffixes")
    func nonTodayPeriodsRenderCompactAndRegularSuffixes() {
        #expect(Period.today.menubarSuffix(compact: false) == "")
        #expect(Period.sevenDays.menubarSuffix(compact: false) == " / wk")
        #expect(Period.month.menubarSuffix(compact: false) == " / mo")
        #expect(Period.all.menubarSuffix(compact: false) == " / 6mo")
        #expect(Period.sevenDays.menubarSuffix(compact: true) == "/wk")
        #expect(Period.month.menubarSuffix(compact: true) == "/mo")
        #expect(Period.all.menubarSuffix(compact: true) == "/6mo")
    }
}
