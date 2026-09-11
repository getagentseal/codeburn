import Foundation
import XCTest
@testable import CodeBurnMenubar

/// The one-line verdict the Capacity Dock columns and the agent-tab hover card
/// draw under the bar (#1215). Pure mapping of (utilization, elapsed fraction,
/// window length) to a string, so every outcome and every silence is testable
/// without a view.
final class QuotaPaceVerdictTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private let week = 7 * 24 * 3600
    private let fiveHours = 5 * 3600
    private let sixHours = 6 * 3600
    private let twelveHours = 12 * 3600

    /// resetsAt such that `fraction` of the window has elapsed at `now`.
    private func resets(afterElapsedFraction fraction: Double, windowSeconds: Int) -> Date {
        now.addingTimeInterval(TimeInterval(windowSeconds) * (1 - fraction))
    }

    private func verdict(
        usedPercent: Double,
        elapsedFraction: Double,
        windowSeconds: Int
    ) -> QuotaPace.Verdict? {
        QuotaPace.verdict(
            usedPercent: usedPercent,
            resetsAt: resets(afterElapsedFraction: elapsedFraction, windowSeconds: windowSeconds),
            windowSeconds: windowSeconds,
            now: now
        )
    }

    // MARK: - The four outcomes

    func testUnderPaceLastsUntilReset() {
        let v = verdict(usedPercent: 40, elapsedFraction: 0.5, windowSeconds: week)
        XCTAssertEqual(v?.text, "Lasts until reset")
        XCTAssertEqual(v?.willOverflow, false)
    }

    func testExactlyOnPaceStillLastsUntilReset() {
        // Projected 100% at reset is not an overflow: the window holds.
        let v = verdict(usedPercent: 50, elapsedFraction: 0.5, windowSeconds: week)
        XCTAssertEqual(v?.text, "Lasts until reset")
        XCTAssertEqual(v?.willOverflow, false)
    }

    func testWeeklyOverflowGetsTheRunOutETA() {
        // 60% at half a week: 40% left at 60%/3.5d runs out 2d 8h from now.
        let v = verdict(usedPercent: 60, elapsedFraction: 0.5, windowSeconds: week)
        XCTAssertEqual(v?.text, "Runs out in 2d 8h")
        XCTAssertEqual(v?.willOverflow, true)
    }

    func testMonthlyOverflowGetsTheRunOutETA() {
        // A calendar month measured back from the reset, as the credit window is.
        let resetsAt = now.addingTimeInterval(15 * 86_400)
        let windowSeconds = QuotaPace.inferredWindowSeconds(
            label: "Monthly usage limit",
            resetsAt: resetsAt
        )
        XCTAssertNotNil(windowSeconds)
        let v = QuotaPace.verdict(
            usedPercent: 90,
            resetsAt: resetsAt,
            windowSeconds: windowSeconds ?? 0,
            now: now
        )
        XCTAssertEqual(v?.willOverflow, true)
        XCTAssertTrue(v?.text.hasPrefix("Runs out in ") == true, "got \(v?.text ?? "nil")")
    }

    func testOverflowJustOverTheSuppressionBoundaryStillGetsTheETA() {
        // 12h window: long enough for a linear ETA, so it reads as a deadline.
        let v = verdict(usedPercent: 60, elapsedFraction: 0.5, windowSeconds: twelveHours)
        XCTAssertEqual(v?.text, "Runs out in 4h 0m")
        XCTAssertEqual(v?.willOverflow, true)
    }

    func testShortWindowOverflowWontLastAndKeepsTheETASuppressed() {
        let v = verdict(usedPercent: 90, elapsedFraction: 0.5, windowSeconds: fiveHours)
        XCTAssertEqual(v?.text, "Won't last until reset")
        XCTAssertEqual(v?.willOverflow, true)
    }

    func testSixHourWindowIsStillInsideTheSuppressionGuard() {
        let v = verdict(usedPercent: 90, elapsedFraction: 0.5, windowSeconds: sixHours)
        XCTAssertEqual(v?.text, "Won't last until reset")
    }

    // MARK: - Silence

    func testEarlyInTheWindowSaysNothing() {
        // Same 3% threshold the Plan tab's caption uses: projecting a whole
        // week off the first few minutes is noise.
        XCTAssertNil(verdict(usedPercent: 5, elapsedFraction: 0.02, windowSeconds: week))
        XCTAssertNil(verdict(usedPercent: 80, elapsedFraction: 0.01, windowSeconds: week))
        // Just past it the verdict appears.
        XCTAssertNotNil(verdict(usedPercent: 5, elapsedFraction: 0.05, windowSeconds: week))
    }

    func testExhaustedUnknownResetAndSkewSayNothing() {
        XCTAssertNil(verdict(usedPercent: 100, elapsedFraction: 0.5, windowSeconds: week))
        XCTAssertNil(QuotaPace.verdict(
            usedPercent: 50, resetsAt: nil, windowSeconds: week, now: now
        ))
        XCTAssertNil(QuotaPace.verdict(
            usedPercent: 50, resetsAt: now.addingTimeInterval(-60), windowSeconds: week, now: now
        ))
    }

    // MARK: - Countdown wording

    func testCountdownLabelShape() {
        XCTAssertEqual(QuotaPace.countdownLabel(seconds: 30), "now")
        XCTAssertEqual(QuotaPace.countdownLabel(seconds: -10), "now")
        XCTAssertEqual(QuotaPace.countdownLabel(seconds: 8 * 60), "8m")
        XCTAssertEqual(QuotaPace.countdownLabel(seconds: 4 * 3600 + 12 * 60), "4h 12m")
        XCTAssertEqual(QuotaPace.countdownLabel(seconds: 2 * 86_400 + 3 * 3600), "2d 3h")
    }

    // MARK: - Window length inference from the provider's own label

    func testLabelInference() {
        func seconds(_ label: String, resetsAt: Date? = nil) -> Int? {
            QuotaPace.inferredWindowSeconds(label: label, resetsAt: resetsAt)
        }
        XCTAssertEqual(seconds("Weekly"), 604_800)
        XCTAssertEqual(seconds("Weekly · Opus"), 604_800)
        XCTAssertEqual(seconds("5-hour"), 5 * 3600)
        XCTAssertEqual(seconds("GPT-5.3-Codex-Spark · 5-hour"), 5 * 3600)
        XCTAssertEqual(seconds("Gemini Models · Five-hour"), 5 * 3600)
        XCTAssertEqual(seconds("Daily"), 86_400)
        XCTAssertEqual(seconds("Hourly"), 3600)
        XCTAssertEqual(seconds("30-day"), 30 * 86_400)
        XCTAssertEqual(seconds("90-min"), 90 * 60)
        // Calendar months come back from the reset date in UTC, so February is
        // shorter than March, and no reset means no window.
        let march = Date(timeIntervalSince1970: 1_772_323_200)  // 2026-03-01T00:00:00Z
        XCTAssertEqual(seconds("Monthly", resetsAt: march), 28 * 86_400)
        XCTAssertEqual(seconds("Monthly usage limit · limit reached", resetsAt: march), 28 * 86_400)
        XCTAssertNil(seconds("Monthly"))
        // Labels that name a bucket, not a duration, stay silent.
        XCTAssertNil(seconds("Premium requests"))
        XCTAssertNil(seconds("Team pool"))
        XCTAssertNil(seconds("Credits"))
        XCTAssertNil(seconds("gemini-3-pro"))
        XCTAssertNil(seconds("Rate Limit"))
    }

    // MARK: - The window the two surfaces actually hand it

    func testQuotaSummaryWindowVerdict() {
        // percent is 0...1 on the presentation type, not 0...100.
        let overflowing = QuotaSummary.Window(
            label: "Weekly",
            percent: 0.60,
            resetsAt: resets(afterElapsedFraction: 0.5, windowSeconds: week)
        )
        XCTAssertEqual(overflowing.paceVerdict(now: now)?.text, "Runs out in 2d 8h")
        let comfortable = QuotaSummary.Window(
            label: "Weekly · Sonnet",
            percent: 0.30,
            resetsAt: resets(afterElapsedFraction: 0.5, windowSeconds: week)
        )
        XCTAssertEqual(comfortable.paceVerdict(now: now)?.text, "Lasts until reset")
        let short = QuotaSummary.Window(
            label: "5-hour",
            percent: 0.90,
            resetsAt: resets(afterElapsedFraction: 0.5, windowSeconds: fiveHours)
        )
        XCTAssertEqual(short.paceVerdict(now: now)?.text, "Won't last until reset")
        // No window length to infer, so the row keeps its reset countdown only.
        let unlabelled = QuotaSummary.Window(
            label: "Premium requests",
            percent: 0.90,
            resetsAt: resets(afterElapsedFraction: 0.5, windowSeconds: 30 * 86_400)
        )
        XCTAssertNil(unlabelled.paceVerdict(now: now))
    }
}
