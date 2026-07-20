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
        XCTAssertNil(r?.hitsLimitAt)
    }

    func testDeficitOverflowWeeklyGetsETABeforeReset() {
        let resetsAt = resets(afterElapsedFraction: 0.5, windowSeconds: week)
        let r = QuotaPace.evaluate(usedPercent: 80, resetsAt: resetsAt, windowSeconds: week, now: now)
        XCTAssertEqual(r?.deltaPercent ?? 0, 30, accuracy: 0.001)
        XCTAssertEqual(r?.projectedPercent ?? 0, 160, accuracy: 0.001)
        XCTAssertEqual(r?.willOverflow, true)
        // At this pace: 80% in 3.5 days → 100% at 4.375 days elapsed.
        let expectedHit = now.addingTimeInterval(TimeInterval(week) * (0.5 * 100 / 80 - 0.5))
        XCTAssertEqual(
            r?.hitsLimitAt?.timeIntervalSince1970 ?? 0,
            expectedHit.timeIntervalSince1970,
            accuracy: 1
        )
        XCTAssertLessThan(r!.hitsLimitAt!, resetsAt)
    }

    func testReserveNoETA() {
        let r = QuotaPace.evaluate(
            usedPercent: 20, resetsAt: resets(afterElapsedFraction: 0.5, windowSeconds: week),
            windowSeconds: week, now: now
        )
        XCTAssertEqual(r?.deltaPercent ?? 0, -30, accuracy: 0.001)
        XCTAssertEqual(r?.projectedPercent ?? 0, 40, accuracy: 0.001)
        XCTAssertEqual(r?.willOverflow, false)
        XCTAssertNil(r?.hitsLimitAt)
    }

    func testShortWindowOverflowSuppressesETAButKeepsDeficit() {
        let r = QuotaPace.evaluate(
            usedPercent: 90, resetsAt: resets(afterElapsedFraction: 0.5, windowSeconds: fiveHours),
            windowSeconds: fiveHours, now: now
        )
        XCTAssertEqual(r?.deltaPercent ?? 0, 40, accuracy: 0.001)
        XCTAssertEqual(r?.willOverflow, true)
        XCTAssertNil(r?.hitsLimitAt, "5h window must not show a linear run-out ETA")
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
        XCTAssertNil(r?.hitsLimitAt)
    }
}
