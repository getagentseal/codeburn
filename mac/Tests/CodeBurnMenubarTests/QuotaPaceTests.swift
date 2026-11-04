import Foundation
import XCTest
@testable import CodeBurnMenubar

final class QuotaPaceTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private let week = 7 * 24 * 3600
    private let fiveHours = 5 * 3600

    /// resetsAt such that `fraction` of the window has elapsed at `now`.
    private func resets(afterElapsedFraction fraction: Double, windowSeconds: Int) -> Date {
        now.addingTimeInterval(TimeInterval(windowSeconds) * (1 - fraction))
    }

    func testOnPaceMidWindow() {
        let r = QuotaPace.evaluate(
            usedPercent: 50, resetsAt: resets(afterElapsedFraction: 0.5, windowSeconds: week),
            windowSeconds: week, now: now
        )
        XCTAssertEqual(r?.deltaPercent ?? -1, 0, accuracy: 0.001)
        XCTAssertEqual(r?.projectedPercent ?? -1, 100, accuracy: 0.001)
        XCTAssertEqual(r?.willOverflow, false)
    }

    func testDeficitOverflowWeekly() {
        let resetsAt = resets(afterElapsedFraction: 0.5, windowSeconds: week)
        let r = QuotaPace.evaluate(usedPercent: 80, resetsAt: resetsAt, windowSeconds: week, now: now)
        XCTAssertEqual(r?.deltaPercent ?? 0, 30, accuracy: 0.001)
        XCTAssertEqual(r?.projectedPercent ?? 0, 160, accuracy: 0.001)
        XCTAssertEqual(r?.willOverflow, true)
    }

    func testReserveNoETA() {
        let r = QuotaPace.evaluate(
            usedPercent: 20, resetsAt: resets(afterElapsedFraction: 0.5, windowSeconds: week),
            windowSeconds: week, now: now
        )
        XCTAssertEqual(r?.deltaPercent ?? 0, -30, accuracy: 0.001)
        XCTAssertEqual(r?.projectedPercent ?? 0, 40, accuracy: 0.001)
        XCTAssertEqual(r?.willOverflow, false)
    }

    func testShortWindowOverflowKeepsDeficit() {
        let r = QuotaPace.evaluate(
            usedPercent: 90, resetsAt: resets(afterElapsedFraction: 0.5, windowSeconds: fiveHours),
            windowSeconds: fiveHours, now: now
        )
        XCTAssertEqual(r?.deltaPercent ?? 0, 40, accuracy: 0.001)
        XCTAssertEqual(r?.willOverflow, true)
    }

    func testEarlyWindowShowsNothing() {
        XCTAssertNil(QuotaPace.evaluate(
            usedPercent: 5, resetsAt: resets(afterElapsedFraction: 0.02, windowSeconds: week),
            windowSeconds: week, now: now
        ))
    }

    func testSkewGuards() {
        // Reset in the past.
        XCTAssertNil(QuotaPace.evaluate(
            usedPercent: 50, resetsAt: now.addingTimeInterval(-60), windowSeconds: week, now: now
        ))
        // Reset further out than one full window.
        XCTAssertNil(QuotaPace.evaluate(
            usedPercent: 50, resetsAt: now.addingTimeInterval(TimeInterval(week) + 3600),
            windowSeconds: week, now: now
        ))
        // Missing reset or nonsense window length.
        XCTAssertNil(QuotaPace.evaluate(usedPercent: 50, resetsAt: nil, windowSeconds: week, now: now))
        XCTAssertNil(QuotaPace.evaluate(
            usedPercent: 50, resetsAt: resets(afterElapsedFraction: 0.5, windowSeconds: week),
            windowSeconds: 0, now: now
        ))
    }

    func testExhaustedWindowShowsNothing() {
        XCTAssertNil(QuotaPace.evaluate(
            usedPercent: 100, resetsAt: resets(afterElapsedFraction: 0.5, windowSeconds: week),
            windowSeconds: week, now: now
        ))
        // Over-100 inputs clamp to exhausted, same silence.
        XCTAssertNil(QuotaPace.evaluate(
            usedPercent: 130, resetsAt: resets(afterElapsedFraction: 0.5, windowSeconds: week),
            windowSeconds: week, now: now
        ))
    }

    func testZeroUsageMidWindowIsAllReserve() {
        let r = QuotaPace.evaluate(
            usedPercent: 0, resetsAt: resets(afterElapsedFraction: 0.5, windowSeconds: week),
            windowSeconds: week, now: now
        )
        XCTAssertEqual(r?.deltaPercent ?? 0, -50, accuracy: 0.001)
        XCTAssertEqual(r?.projectedPercent ?? -1, 0, accuracy: 0.001)
        XCTAssertEqual(r?.willOverflow, false)
    }

    // MARK: - Recent-pace forecast

    /// A reading `minutesAgo` before `now` on the cycle that resets at `resetsAt`.
    private func reading(_ percent: Double, minutesAgo: Double, resetsAt: Date) -> QuotaPace.Reading {
        QuotaPace.Reading(percent: percent, resetsAt: resetsAt, observedAt: now.addingTimeInterval(-minutesAgo * 60))
    }

    func testForecastArithmeticOnAFixedSeries() {
        let resetsAt = now.addingTimeInterval(3 * 3600)
        let readings = [
            reading(40, minutesAgo: 30, resetsAt: resetsAt),
            reading(45, minutesAgo: 20, resetsAt: resetsAt),
            reading(50, minutesAgo: 0, resetsAt: resetsAt),
        ]
        // 10 points in 30 min: the remaining 50 take 150 min.
        XCTAssertEqual(
            QuotaPace.forecast(readings: readings, resetsAt: resetsAt, now: now),
            .runsOut(at: now.addingTimeInterval(150 * 60))
        )
    }

    func testForecastNeedsTwoPointsOfRise() {
        let resetsAt = now.addingTimeInterval(3 * 3600)
        let flat = [reading(40, minutesAgo: 30, resetsAt: resetsAt), reading(41.9, minutesAgo: 0, resetsAt: resetsAt)]
        XCTAssertNil(QuotaPace.forecast(readings: flat, resetsAt: resetsAt, now: now))
        let rising = [reading(40, minutesAgo: 30, resetsAt: resetsAt), reading(42, minutesAgo: 0, resetsAt: resetsAt)]
        XCTAssertNotNil(QuotaPace.forecast(readings: rising, resetsAt: resetsAt, now: now))
    }

    func testForecastNeedsTwoReadingsTenMinutesApart() {
        let resetsAt = now.addingTimeInterval(3 * 3600)
        XCTAssertNil(QuotaPace.forecast(readings: [reading(50, minutesAgo: 0, resetsAt: resetsAt)], resetsAt: resetsAt, now: now))
        let close = [reading(40, minutesAgo: 9, resetsAt: resetsAt), reading(50, minutesAgo: 0, resetsAt: resetsAt)]
        XCTAssertNil(QuotaPace.forecast(readings: close, resetsAt: resetsAt, now: now))
    }

    func testForecastLooksBackAnHourOnShortWindows() {
        let resetsAt = now.addingTimeInterval(3 * 3600)
        // The 0% reading 90 min ago falls outside the hour; only the last 10
        // points in 30 min count.
        let readings = [
            reading(0, minutesAgo: 90, resetsAt: resetsAt),
            reading(40, minutesAgo: 30, resetsAt: resetsAt),
            reading(50, minutesAgo: 0, resetsAt: resetsAt),
        ]
        XCTAssertEqual(
            QuotaPace.forecast(readings: readings, resetsAt: resetsAt, now: now),
            .runsOut(at: now.addingTimeInterval(150 * 60))
        )
    }

    func testForecastLooksBackSixHoursOnLongWindows() {
        let resetsAt = now.addingTimeInterval(2 * 86400)
        let readings = [
            reading(10, minutesAgo: 7 * 60, resetsAt: resetsAt),
            reading(40, minutesAgo: 5 * 60, resetsAt: resetsAt),
            reading(50, minutesAgo: 0, resetsAt: resetsAt),
        ]
        // 10 points in 5 h: the remaining 50 take 25 h, before the reset.
        XCTAssertEqual(
            QuotaPace.forecast(readings: readings, resetsAt: resetsAt, now: now),
            .runsOut(at: now.addingTimeInterval(25 * 3600))
        )
    }

    func testForecastDropsReadingsBeforeTheLastFall() {
        let resetsAt = now.addingTimeInterval(3 * 3600)
        let readings = [
            reading(80, minutesAgo: 50, resetsAt: resetsAt),
            reading(10, minutesAgo: 40, resetsAt: resetsAt),
            reading(20, minutesAgo: 0, resetsAt: resetsAt),
        ]
        // 10 points in 40 min from the fall: the remaining 80 take 320 min,
        // after the reset.
        XCTAssertEqual(QuotaPace.forecast(readings: readings, resetsAt: resetsAt, now: now), .lastsUntilReset)
    }

    func testForecastKeepsOnlyTheSameCycle() {
        let resetsAt = now.addingTimeInterval(3 * 3600)
        let readings = [
            reading(0, minutesAgo: 40, resetsAt: resetsAt.addingTimeInterval(-5 * 3600)),
            reading(40, minutesAgo: 30, resetsAt: resetsAt.addingTimeInterval(90)),
            reading(50, minutesAgo: 0, resetsAt: resetsAt),
        ]
        // The 0% reading is the previous cycle; the 90 s reset jitter is not.
        XCTAssertEqual(
            QuotaPace.forecast(readings: readings, resetsAt: resetsAt, now: now),
            .runsOut(at: now.addingTimeInterval(150 * 60))
        )
    }

    func testForecastLastsUntilReset() {
        let resetsAt = now.addingTimeInterval(3600)
        let readings = [reading(40, minutesAgo: 30, resetsAt: resetsAt), reading(50, minutesAgo: 0, resetsAt: resetsAt)]
        XCTAssertEqual(QuotaPace.forecast(readings: readings, resetsAt: resetsAt, now: now), .lastsUntilReset)
    }

    func testForecastSaysNothingAtTheLimit() {
        let resetsAt = now.addingTimeInterval(3600)
        let readings = [reading(80, minutesAgo: 30, resetsAt: resetsAt), reading(100, minutesAgo: 0, resetsAt: resetsAt)]
        XCTAssertNil(QuotaPace.forecast(readings: readings, resetsAt: resetsAt, now: now))
    }
}
