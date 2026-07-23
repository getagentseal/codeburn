import XCTest
@testable import CodeBurnMenubar

/// Fixture-driven decode tests for the Kimi Code /coding/v1/usages response.
/// The API has shipped numbers as both JSON numbers and strings, and the
/// reset timestamp under several key spellings (resetTime / reset_at / ...),
/// so the parser must tolerate all of them.
final class KimiUsageParsingTests: XCTestCase {

    func testParsesNumericShapeWithResetTime() throws {
        let json = """
        {
          "usage": {"limit": 100, "used": 40, "remaining": 60, "resetTime": "2026-07-30T12:00:00Z"},
          "limits": [
            {"window": {"duration": 5, "timeUnit": "hour"},
             "detail": {"limit": 20, "used": 10, "remaining": 10, "resetTime": "2026-07-23T21:00:00Z"}}
          ]
        }
        """.data(using: .utf8)!
        let usage = try KimiSubscriptionService.parseUsage(data: json)
        XCTAssertEqual(usage.primary?.limit, 100)
        XCTAssertEqual(usage.primary?.used, 40)
        XCTAssertEqual(usage.primary?.usedPercent ?? -1, 40, accuracy: 0.001)
        XCTAssertEqual(usage.primary?.remaining, 60)
        XCTAssertNotNil(usage.primary?.resetsAt)
        XCTAssertEqual(usage.details.count, 1)
        XCTAssertEqual(usage.details.first?.label, "5-hour")
        XCTAssertEqual(usage.details.first?.usedPercent ?? -1, 50, accuracy: 0.001)
    }

    func testParsesStringNumbersAndSnakeCaseReset() throws {
        let json = """
        {
          "usage": {"limit": "500", "used": "123", "remaining": "377", "reset_at": "2026-07-30T12:00:00.000Z"},
          "limits": []
        }
        """.data(using: .utf8)!
        let usage = try KimiSubscriptionService.parseUsage(data: json)
        XCTAssertEqual(usage.primary?.limit, 500)
        XCTAssertEqual(usage.primary?.used, 123)
        XCTAssertNotNil(usage.primary?.resetsAt)
    }

    func testWeeklyWindowLabel() throws {
        let json = """
        {
          "limits": [
            {"window": {"duration": 7, "timeUnit": "day"},
             "detail": {"limit": 1000, "used": 250}}
          ]
        }
        """.data(using: .utf8)!
        let usage = try KimiSubscriptionService.parseUsage(data: json)
        XCTAssertNil(usage.primary)
        XCTAssertEqual(usage.details.first?.label, "Weekly")
    }

    func testEpochResetTime() throws {
        let json = """
        {"usage": {"limit": 10, "used": 5, "resetTime": "1784900000"}}
        """.data(using: .utf8)!
        let usage = try KimiSubscriptionService.parseUsage(data: json)
        XCTAssertEqual(usage.primary?.resetsAt, Date(timeIntervalSince1970: 1_784_900_000))
    }

    func testNumericEpochResetTime() throws {
        // A JSON number (not string) must not fail the whole decode.
        let json = """
        {"usage": {"limit": 10, "used": 5, "resetTime": 1784900000}}
        """.data(using: .utf8)!
        let usage = try KimiSubscriptionService.parseUsage(data: json)
        XCTAssertEqual(usage.primary?.resetsAt, Date(timeIntervalSince1970: 1_784_900_000))
    }

    func testLiveResponseShape() {
        // Captured from GET https://api.kimi.com/coding/v1/usages (2026-07-23).
        let json = """
        {
          "user": {"userId": "x", "region": "REGION_OVERSEA",
                   "membership": {"level": "LEVEL_INTERMEDIATE"}},
          "usage": {"limit": "100", "used": "5", "remaining": "95",
                    "resetTime": "2026-07-30T13:27:17.211180Z"},
          "limits": [
            {"window": {"duration": 300, "timeUnit": "TIME_UNIT_MINUTE"},
             "detail": {"limit": "100", "remaining": "100",
                        "resetTime": "2026-07-23T23:27:17.211180Z"}}
          ],
          "parallel": {"limit": "20"}
        }
        """.data(using: .utf8)!
        let usage = try! KimiSubscriptionService.parseUsage(data: json)
        XCTAssertEqual(usage.plan, "Intermediate")
        XCTAssertEqual(usage.parallelLimit, 20)
        XCTAssertEqual(usage.primary?.label, "Weekly")
        XCTAssertEqual(usage.primary?.usedPercent ?? -1, 5, accuracy: 0.001)
        // 300 minutes rolls up to a 5-hour label; used derives from remaining.
        XCTAssertEqual(usage.details.count, 1)
        XCTAssertEqual(usage.details.first?.label, "5-hour")
        XCTAssertEqual(usage.details.first?.usedPercent ?? -1, 0, accuracy: 0.001)
        XCTAssertNotNil(usage.details.first?.resetsAt)
    }

    func testEmptyEnvelopeThrows() {
        let json = "{}".data(using: .utf8)!
        XCTAssertThrowsError(try KimiSubscriptionService.parseUsage(data: json))
    }

    func testZeroLimitWindowDropped() throws {
        let json = """
        {"usage": {"limit": 0, "used": 0}, "limits": []}
        """.data(using: .utf8)!
        XCTAssertThrowsError(try KimiSubscriptionService.parseUsage(data: json))
    }
}
