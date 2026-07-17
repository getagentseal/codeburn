import Foundation
import XCTest
@testable import CodeBurnMenubar

final class ClaudeRateLimitTests: XCTestCase {
    func testRetryAfterDeltaSeconds() {
        XCTAssertEqual(
            ClaudeSubscriptionService.parseRetryAfter(
                header: " 42 ",
                body: #"{"retry_after": 91}"#
            ),
            42
        )
    }

    func testRetryAfterHTTPDate() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)

        XCTAssertEqual(
            ClaudeSubscriptionService.parseRetryAfter(
                header: "Tue, 14 Nov 2023 22:14:05 GMT",
                body: nil,
                now: now
            ),
            45
        )
    }

    func testMalformedHeaderFallsBackToBody() {
        XCTAssertEqual(
            ClaudeSubscriptionService.parseRetryAfter(
                header: "not-a-retry-after",
                body: #"{"retry_after": "91"}"#
            ),
            91
        )
    }

    func testMalformedHeaderAndBodyUseDefault() {
        XCTAssertEqual(
            ClaudeSubscriptionService.parseRetryAfter(
                header: "not-a-retry-after",
                body: #"{"retry_after": "not-a-number"}"#
            ),
            300
        )
    }

    func testRateLimitBlockNeverShrinks() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let existing = now.addingTimeInterval(600)

        XCTAssertEqual(
            ClaudeSubscriptionService.rateLimitBlockUntil(
                existingUntil: existing,
                now: now,
                retryAfterSeconds: 60
            ),
            existing
        )
        XCTAssertEqual(
            ClaudeSubscriptionService.rateLimitBlockUntil(
                existingUntil: existing,
                now: now,
                retryAfterSeconds: 900
            ),
            now.addingTimeInterval(900)
        )
    }

    func testFailureBackoffGrowsAndCapsAtCadence() {
        let delays = (1...5).map {
            SubscriptionRefreshBackoff.delay(
                failureCount: $0,
                cadence: 300,
                jitterUnit: 0
            )
        }

        XCTAssertEqual(delays, [30, 60, 120, 240, 300])
        XCTAssertEqual(delays, delays.sorted())
    }

    func testFailureBackoffJitterStaysWithinBounds() {
        let minimum = SubscriptionRefreshBackoff.delay(
            failureCount: 2,
            cadence: 300,
            jitterUnit: 0
        )
        let maximum = SubscriptionRefreshBackoff.delay(
            failureCount: 2,
            cadence: 300,
            jitterUnit: 1
        )

        XCTAssertEqual(minimum, 60)
        XCTAssertEqual(maximum, 65)
        XCTAssertLessThanOrEqual(maximum, 300)
    }
}
