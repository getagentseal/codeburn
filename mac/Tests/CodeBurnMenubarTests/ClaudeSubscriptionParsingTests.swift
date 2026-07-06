import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Claude usage response parsing")
struct ClaudeSubscriptionParsingTests {
    // Shape captured from the live oauth/usage endpoint (2026-07): named
    // windows plus a `limits` array carrying model-scoped weekly buckets.
    private let liveShape = """
    {
      "five_hour": { "utilization": 13.0, "resets_at": "2026-07-02T22:09:59.599633+00:00", "limit_dollars": null, "used_dollars": null, "remaining_dollars": null },
      "seven_day": { "utilization": 63.0, "resets_at": "2026-07-03T06:59:59.599658+00:00", "limit_dollars": null, "used_dollars": null, "remaining_dollars": null },
      "seven_day_oauth_apps": null,
      "seven_day_opus": null,
      "seven_day_sonnet": null,
      "extra_usage": { "is_enabled": false },
      "limits": [
        { "kind": "session", "group": "session", "percent": 13, "severity": "normal", "resets_at": "2026-07-02T22:09:59.456907+00:00", "scope": null, "is_active": false },
        { "kind": "weekly_all", "group": "weekly", "percent": 63, "severity": "normal", "resets_at": "2026-07-03T06:59:59.456926+00:00", "scope": null, "is_active": false },
        { "kind": "weekly_scoped", "group": "weekly", "percent": 94, "severity": "critical", "resets_at": "2026-07-03T06:59:59.457220+00:00", "scope": { "model": { "id": null, "display_name": "Fable" }, "surface": null }, "is_active": true }
      ]
    }
    """

    @Test("model-scoped weekly bucket surfaces with its display name")
    func scopedWeeklyParsed() throws {
        let usage = try ClaudeSubscriptionService.parseUsage(Data(liveShape.utf8), rawTier: "max_20x")
        #expect(usage.scopedWeekly.count == 1)
        let fable = try #require(usage.scopedWeekly.first)
        #expect(fable.label == "Fable")
        #expect(fable.percent == 94)
        #expect(fable.resetsAt != nil)
    }

    @Test("named windows still map alongside limits")
    func namedWindowsUnaffected() throws {
        let usage = try ClaudeSubscriptionService.parseUsage(Data(liveShape.utf8), rawTier: "max_20x")
        #expect(usage.fiveHourPercent == 13.0)
        #expect(usage.sevenDayPercent == 63.0)
        #expect(usage.sevenDayOpusPercent == nil)
        #expect(usage.sevenDaySonnetPercent == nil)
        #expect(usage.tier == .max20x)
    }

    @Test("session and weekly_all limits are not duplicated as scoped rows")
    func unscopedKindsSkipped() throws {
        let usage = try ClaudeSubscriptionService.parseUsage(Data(liveShape.utf8), rawTier: nil)
        #expect(!usage.scopedWeekly.contains { $0.percent == 13 || $0.percent == 63 })
    }

    @Test("response without a limits array parses with no scoped windows")
    func missingLimitsIsBackCompat() throws {
        let old = """
        {
          "five_hour": { "utilization": 40.0, "resets_at": "2026-07-02T22:00:00+00:00" },
          "seven_day": { "utilization": 12.5, "resets_at": "2026-07-03T07:00:00+00:00" }
        }
        """
        let usage = try ClaudeSubscriptionService.parseUsage(Data(old.utf8), rawTier: "pro")
        #expect(usage.scopedWeekly.isEmpty)
        #expect(usage.fiveHourPercent == 40.0)
        #expect(usage.tier == .pro)
    }

    @Test("weekly_scoped without a model display name is skipped")
    func scopedWithoutNameSkipped() throws {
        let body = """
        {
          "limits": [
            { "kind": "weekly_scoped", "percent": 50, "resets_at": "2026-07-03T07:00:00+00:00", "scope": { "model": null } }
          ]
        }
        """
        let usage = try ClaudeSubscriptionService.parseUsage(Data(body.utf8), rawTier: nil)
        #expect(usage.scopedWeekly.isEmpty)
    }
}
