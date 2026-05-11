import Foundation
import XCTest
@testable import CodeBurnMenubar

final class MenubarPeriodSettingsTests: XCTestCase {
    func testSettingsPickerExposesRequestedPeriods() {
        XCTAssertEqual(Period.menubarMetricCases, [.today, .sevenDays, .month, .all])
    }

    func testDefaultsValuesMapToPeriods() {
        XCTAssertEqual(Period(menubarDefaultsValue: "today"), .today)
        XCTAssertEqual(Period(menubarDefaultsValue: "week"), .sevenDays)
        XCTAssertEqual(Period(menubarDefaultsValue: "month"), .month)
        XCTAssertEqual(Period(menubarDefaultsValue: "sixMonths"), .all)
        XCTAssertEqual(Period(menubarDefaultsValue: "all"), .all)
        XCTAssertEqual(Period(menubarDefaultsValue: "30days"), .today)
        XCTAssertEqual(Period(menubarDefaultsValue: "bogus"), .today)
        XCTAssertEqual(Period(menubarDefaultsValue: nil), .today)
    }

    func testPeriodsPersistCanonicalDefaultsValues() throws {
        let suiteName = "CodeBurnMenubarTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        Period.sevenDays.persistAsMenubarDefault(defaults: defaults)
        XCTAssertEqual(defaults.string(forKey: "CodeBurnMenubarPeriod"), "week")
        XCTAssertEqual(Period.savedMenubarPeriod(defaults: defaults), .sevenDays)

        Period.all.persistAsMenubarDefault(defaults: defaults)
        XCTAssertEqual(defaults.string(forKey: "CodeBurnMenubarPeriod"), "sixMonths")
        XCTAssertEqual(Period.savedMenubarPeriod(defaults: defaults), .all)

        Period.thirtyDays.persistAsMenubarDefault(defaults: defaults)
        XCTAssertEqual(defaults.string(forKey: "CodeBurnMenubarPeriod"), "today")
        XCTAssertEqual(Period.savedMenubarPeriod(defaults: defaults), .today)
    }

    func testNonTodayPeriodsRenderCompactAndRegularSuffixes() {
        XCTAssertEqual(Period.today.menubarSuffix(compact: false), "")
        XCTAssertEqual(Period.sevenDays.menubarSuffix(compact: false), " / wk")
        XCTAssertEqual(Period.month.menubarSuffix(compact: false), " / mo")
        XCTAssertEqual(Period.all.menubarSuffix(compact: false), " / 6mo")
        XCTAssertEqual(Period.sevenDays.menubarSuffix(compact: true), "/wk")
        XCTAssertEqual(Period.month.menubarSuffix(compact: true), "/mo")
        XCTAssertEqual(Period.all.menubarSuffix(compact: true), "/6mo")
    }
}
