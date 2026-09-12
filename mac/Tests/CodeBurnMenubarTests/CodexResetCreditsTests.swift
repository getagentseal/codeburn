import Foundation
import XCTest
@testable import CodeBurnMenubar

final class CodexResetCreditsTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func parse(_ json: String) -> CodexUsage.ResetCredits? {
        CodexSubscriptionService.parseResetCredits(data: Data(json.utf8), now: now)
    }

    func testFullPayloadPicksSoonestAvailableExpiry() {
        let result = parse(#"""
        {
          "credits": [
            {"id": "c1", "reset_type": "weekly", "status": "available",
             "granted_at": "2026-07-01T00:00:00Z", "expires_at": "2027-01-25T12:00:00Z"},
            {"id": "c2", "reset_type": "weekly", "status": "available",
             "granted_at": "2026-07-02T00:00:00Z", "expires_at": "2027-01-16T08:30:00.500Z"},
            {"id": "c3", "reset_type": "weekly", "status": "redeemed",
             "granted_at": "2026-06-01T00:00:00Z", "expires_at": "2027-01-10T00:00:00Z",
             "redeemed_at": "2026-06-05T00:00:00Z"}
          ],
          "available_count": 2
        }
        """#)
        XCTAssertEqual(result?.availableCount, 2)
        // c2 (fractional-seconds timestamp) is soonest among *available* credits;
        // redeemed c3 must not win despite expiring earlier.
        XCTAssertEqual(
            result?.nextExpiresAt,
            ISO8601DateFormatter().date(from: "2027-01-16T08:30:00Z")?.addingTimeInterval(0.5)
        )
    }

    func testMissingExpiryStillReportsCount() {
        let result = parse(#"{"credits": [{"id": "c1", "status": "available"}], "available_count": 1}"#)
        XCTAssertEqual(result?.availableCount, 1)
        XCTAssertNil(result?.nextExpiresAt)
    }

    func testUnknownStatusIsIgnoredForExpiryButCountIsServerAuthoritative() {
        let result = parse(#"""
        {
          "credits": [{"id": "c1", "status": "pending_grant", "expires_at": "2027-01-16T08:30:00Z"}],
          "available_count": 1
        }
        """#)
        XCTAssertEqual(result?.availableCount, 1)
        XCTAssertNil(result?.nextExpiresAt)
    }

    func testAlreadyExpiredCreditDoesNotSurfaceAsNextExpiry() {
        let result = parse(#"""
        {
          "credits": [{"id": "c1", "status": "available", "expires_at": "2020-01-01T00:00:00Z"}],
          "available_count": 1
        }
        """#)
        XCTAssertEqual(result?.availableCount, 1)
        XCTAssertNil(result?.nextExpiresAt)
    }

    func testEmptyCreditsZeroCount() {
        let result = parse(#"{"credits": [], "available_count": 0}"#)
        XCTAssertEqual(result?.availableCount, 0)
        XCTAssertNil(result?.nextExpiresAt)
    }

    func testGrantsCarryIdentityTypeAndGrantTime() {
        let result = parse(#"""
        {
          "credits": [
            {"id": "c1", "reset_type": "weekly", "status": "available",
             "granted_at": "2027-01-02T00:00:00Z", "expires_at": "2027-01-25T12:00:00Z"},
            {"id": "c3", "reset_type": "weekly", "status": "redeemed",
             "granted_at": "2026-06-01T00:00:00Z"}
          ],
          "available_count": 1,
          "applicable_available_count": 1
        }
        """#)
        // Only available credits become grants: a redeemed one is spent history.
        XCTAssertEqual(result?.grants.map(\.id), ["c1"])
        XCTAssertEqual(result?.grants.first?.resetType, "weekly")
        XCTAssertEqual(result?.grants.first?.grantedAt,
                       ISO8601DateFormatter().date(from: "2027-01-02T00:00:00Z"))
        XCTAssertEqual(result?.applicableAvailableCount, 1)
    }

    func testApplicableCountIsUnknownRatherThanZeroWhenAbsent() {
        XCTAssertNil(parse(#"{"credits": [], "available_count": 0}"#)?.applicableAvailableCount)
        XCTAssertNil(parse(#"{"credits": [], "available_count": 0, "applicable_available_count": -1}"#)?
            .applicableAvailableCount)
        XCTAssertEqual(parse(#"{"credits": [], "available_count": 0, "applicable_available_count": 0}"#)?
            .applicableAvailableCount, 0)
    }

    func testGrantedAtIsTheIdentityWhenNoIdIsPresent() {
        let result = parse(#"""
        {
          "credits": [{"status": "available", "granted_at": "2027-01-02T00:00:00Z"}],
          "available_count": 1
        }
        """#)
        XCTAssertEqual(result?.grants.map(\.id), ["2027-01-02T00:00:00Z"])
    }

    func testCreditWithNoStableIdentityIsNotAGrant() {
        let result = parse(#"{"credits": [{"status": "available"}], "available_count": 1}"#)
        // Still counted — the server said one is available — but never announced,
        // because a second unidentifiable credit could not be told from this one.
        XCTAssertEqual(result?.availableCount, 1)
        XCTAssertTrue(result?.grants.isEmpty == true)
    }

    func testLatestGrantIgnoresCreditsThatCannotSayWhenTheyLanded() {
        let result = parse(#"""
        {
          "credits": [
            {"id": "c1", "status": "available", "granted_at": "2027-01-02T00:00:00Z"},
            {"id": "c2", "status": "available", "granted_at": "2027-01-04T00:00:00Z"},
            {"id": "c3", "status": "available"}
          ],
          "available_count": 3
        }
        """#)
        XCTAssertEqual(result?.latestGrant?.id, "c2")
    }

    func testInlineBlockCarriesBothCounts() {
        let usage = #"""
        {"plan_type": "plus",
         "rate_limit_reset_credits": {"available_count": 2, "applicable_available_count": 1}}
        """#
        let inline = CodexSubscriptionService.inlineResetCredits(data: Data(usage.utf8), now: now)
        XCTAssertEqual(inline?.availableCount, 2)
        XCTAssertEqual(inline?.applicableAvailableCount, 1)
        // Non-zero, so the companion fetch still runs: the inline block has no
        // per-credit list to detect a new grant from.
        XCTAssertNil(CodexSubscriptionService.inlineResetCreditsShortcut(data: Data(usage.utf8)))
    }

    func testUsagePayloadFillsInAMissingApplicableCount() throws {
        let usage = #"""
        {"plan_type": "plus",
         "rate_limit_reset_credits": {"available_count": 2, "applicable_available_count": 1}}
        """#
        // The companion endpoint answered without an applicable count; the usage
        // payload we already hold has one.
        let fromEndpoint = CodexUsage.ResetCredits(availableCount: 2, grants: [])
        let decoded = try CodexSubscriptionService.decodeUsage(
            data: Data(usage.utf8), resetCredits: fromEndpoint
        )
        XCTAssertEqual(decoded.resetCredits?.applicableAvailableCount, 1)

        // An authoritative count from the endpoint is never overwritten.
        let authoritative = CodexUsage.ResetCredits(availableCount: 2, applicableAvailableCount: 2)
        let kept = try CodexSubscriptionService.decodeUsage(
            data: Data(usage.utf8), resetCredits: authoritative
        )
        XCTAssertEqual(kept.resetCredits?.applicableAvailableCount, 2)
    }

    func testMalformedDocumentReturnsNil() {
        XCTAssertNil(parse("not json"))
        XCTAssertNil(parse(#"{"credits": "wrong-shape"}"#))
        XCTAssertNil(parse(#"{"credits": []}"#))
        XCTAssertNil(parse(#"{"available_count": -1, "credits": []}"#))
    }
}
