import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Refresh backoff")
struct RefreshBackoffTests {
    @Test("pauses after threshold and escalates exponentially")
    func pausesAfterThresholdAndEscalatesExponentially() {
        let now = Date(timeIntervalSince1970: 1_000)
        var backoff = RefreshBackoff(stallThreshold: 3, initialDelay: 30, maximumDelay: 300)

        #expect(backoff.recordStall(now: now) == nil)
        #expect(backoff.recordStall(now: now) == nil)

        let firstPause = backoff.recordStall(now: now)
        #expect(firstPause == now.addingTimeInterval(30))
        let pausedBeforeExpiry = backoff.isPaused(now: now.addingTimeInterval(29))
        #expect(pausedBeforeExpiry)
        let pausedAfterExpiry = backoff.isPaused(now: now.addingTimeInterval(31))
        #expect(!pausedAfterExpiry)

        let secondPause = backoff.recordStall(now: now)
        #expect(secondPause == now.addingTimeInterval(60))

        _ = backoff.recordStall(now: now)
        _ = backoff.recordStall(now: now)
        _ = backoff.recordStall(now: now)
        _ = backoff.recordStall(now: now)
        let cappedPause = backoff.recordStall(now: now)
        #expect(cappedPause == now.addingTimeInterval(300))
    }

    @Test("success clears stall count and pause")
    func successClearsStallCountAndPause() {
        let now = Date(timeIntervalSince1970: 2_000)
        var backoff = RefreshBackoff(stallThreshold: 1, initialDelay: 30, maximumDelay: 300)

        #expect(backoff.recordStall(now: now) == now.addingTimeInterval(30))
        backoff.recordSuccess()

        #expect(backoff.consecutiveStalls == 0)
        #expect(backoff.pausedUntil == nil)
        #expect(backoff.recordStall(now: now) == now.addingTimeInterval(30))
    }

    @Test("manual retry clears pause without erasing stall history")
    func manualRetryClearsPauseWithoutErasingStallHistory() {
        let now = Date(timeIntervalSince1970: 3_000)
        var backoff = RefreshBackoff(stallThreshold: 1, initialDelay: 30, maximumDelay: 300)

        _ = backoff.recordStall(now: now)
        backoff.retryNow(resetStallCount: false)

        #expect(backoff.pausedUntil == nil)
        #expect(backoff.consecutiveStalls == 1)
    }
}
