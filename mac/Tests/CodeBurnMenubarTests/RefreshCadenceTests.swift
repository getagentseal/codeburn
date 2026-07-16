import XCTest
@testable import CodeBurnMenubar

final class RefreshCadenceTests: XCTestCase {
    func testAutoPopoverOpenAlwaysUsesActiveCadence() {
        XCTAssertEqual(
            RefreshCadence.interval(mode: .auto, popoverOpen: true, onBattery: true, lowPowerMode: true),
            RefreshCadence.activeSeconds
        )
    }

    func testAutoIdleOnACUsesTwoMinuteMinimum() {
        XCTAssertEqual(
            RefreshCadence.interval(mode: .auto, popoverOpen: false, onBattery: false, lowPowerMode: false),
            120
        )
    }

    func testAutoIdleOnBatteryBacksOff() {
        XCTAssertEqual(
            RefreshCadence.interval(mode: .auto, popoverOpen: false, onBattery: true, lowPowerMode: false),
            RefreshCadence.batteryIdleSeconds
        )
    }

    func testAutoLowPowerModeBacksOffFurthest() {
        XCTAssertEqual(
            RefreshCadence.interval(mode: .auto, popoverOpen: false, onBattery: true, lowPowerMode: true),
            RefreshCadence.lowPowerIdleSeconds
        )
        XCTAssertEqual(
            RefreshCadence.interval(mode: .auto, popoverOpen: false, onBattery: false, lowPowerMode: true),
            RefreshCadence.lowPowerIdleSeconds
        )
    }

    func testManualNeverAutoSpawns() {
        XCTAssertNil(RefreshCadence.interval(mode: .manual, popoverOpen: false, onBattery: false, lowPowerMode: false))
        XCTAssertNil(RefreshCadence.interval(mode: .manual, popoverOpen: true, onBattery: false, lowPowerMode: false))
    }

    func testFixedCadenceIgnoresPowerState() {
        XCTAssertEqual(
            RefreshCadence.interval(mode: .fiveMinutes, popoverOpen: false, onBattery: true, lowPowerMode: true),
            300
        )
        XCTAssertEqual(
            RefreshCadence.interval(mode: .fifteenMinutes, popoverOpen: false, onBattery: false, lowPowerMode: false),
            900
        )
    }

    func testFixedCadenceGoesActiveWhilePopoverOpen() {
        XCTAssertEqual(
            RefreshCadence.interval(mode: .fiveMinutes, popoverOpen: true, onBattery: true, lowPowerMode: false),
            RefreshCadence.activeSeconds
        )
    }

    func testBackoffOrdering() {
        XCTAssertLessThan(RefreshCadence.activeSeconds, RefreshCadence.batteryIdleSeconds)
        XCTAssertLessThan(RefreshCadence.batteryIdleSeconds, RefreshCadence.lowPowerIdleSeconds)
    }

    func testCadenceDefaultsToAutoWhenUnset() {
        let key = UsageRefreshCadence.defaultsKey
        let saved = UserDefaults.standard.object(forKey: key)
        defer {
            if let saved { UserDefaults.standard.set(saved, forKey: key) }
            else { UserDefaults.standard.removeObject(forKey: key) }
        }
        UserDefaults.standard.removeObject(forKey: key)
        XCTAssertEqual(UsageRefreshCadence.current, .auto)

        UsageRefreshCadence.current = .manual
        XCTAssertEqual(UsageRefreshCadence.current, .manual)
        UsageRefreshCadence.current = .fiveMinutes
        XCTAssertEqual(UsageRefreshCadence.current, .fiveMinutes)
    }
}
