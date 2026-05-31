import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Menubar period settings")
struct MenubarPeriodSettingsTests {
    @Test("settings picker exposes requested periods")
    func settingsPickerExposesRequestedPeriods() {
        #expect(Period.menubarMetricCases == [.today, .sevenDays, .month, .all])
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
    func periodsPersistCanonicalDefaultsValues() throws {
        let suiteName = "CodeBurnMenubarTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        Period.sevenDays.persistAsMenubarDefault(defaults: defaults)
        #expect(defaults.string(forKey: "CodeBurnMenubarPeriod") == "week")
        #expect(Period.savedMenubarPeriod(defaults: defaults) == .sevenDays)

        Period.all.persistAsMenubarDefault(defaults: defaults)
        #expect(defaults.string(forKey: "CodeBurnMenubarPeriod") == "sixMonths")
        #expect(Period.savedMenubarPeriod(defaults: defaults) == .all)

        Period.lifetime.persistAsMenubarDefault(defaults: defaults)
        #expect(defaults.string(forKey: "CodeBurnMenubarPeriod") == "today")
        #expect(Period.savedMenubarPeriod(defaults: defaults) == .today)

        Period.thirtyDays.persistAsMenubarDefault(defaults: defaults)
        #expect(defaults.string(forKey: "CodeBurnMenubarPeriod") == "today")
        #expect(Period.savedMenubarPeriod(defaults: defaults) == .today)
    }

    @Test("non-today periods render compact and regular suffixes")
    func nonTodayPeriodsRenderCompactAndRegularSuffixes() {
        #expect(Period.today.menubarSuffix(compact: false) == "")
        #expect(Period.sevenDays.menubarSuffix(compact: false) == " / wk")
        #expect(Period.month.menubarSuffix(compact: false) == " / mo")
        #expect(Period.all.menubarSuffix(compact: false) == " / 6mo")
        #expect(Period.lifetime.menubarSuffix(compact: false) == " / all")
        #expect(Period.sevenDays.menubarSuffix(compact: true) == "/wk")
        #expect(Period.month.menubarSuffix(compact: true) == "/mo")
        #expect(Period.all.menubarSuffix(compact: true) == "/6mo")
        #expect(Period.lifetime.menubarSuffix(compact: true) == "/all")
    }

    @Test("usage refresh cadence defaults")
    func usageRefreshCadenceDefaults() {
        #expect(UsageRefreshCadence.default == .thirtySeconds)
        #expect(UsageRefreshCadence.thirtySeconds.seconds == 30)
        #expect(UsageRefreshCadence.manual.seconds == nil)
        #expect(UsageRefreshCadence.manual.cacheTTLSeconds == .greatestFiniteMagnitude)
    }

    @Test("privacy redactor masks email addresses when enabled")
    func privacyRedactorMasksEmailAddressesWhenEnabled() {
        #expect(PrivacyRedactor.redact("repo-owner@example.com", enabled: true) == "r***@example.com")
        #expect(PrivacyRedactor.redact("repo-owner@example.com", enabled: false) == "repo-owner@example.com")
    }
}
