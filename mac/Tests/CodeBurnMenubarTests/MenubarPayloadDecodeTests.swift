import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("MenubarPayload decode")
struct MenubarPayloadDecodeTests {
    private func decode(_ json: String) throws -> MenubarPayload {
        try JSONDecoder().decode(MenubarPayload.self, from: Data(json.utf8))
    }

    @Test("huge malformed token fields decode as zero")
    func hugeMalformedTokenFieldsDecodeAsZero() throws {
        let payload = try decode("""
        {
          "generated": "2026-06-22T00:00:00Z",
          "current": {
            "label": "Today",
            "cost": 1.0,
            "calls": 1,
            "sessions": 1,
            "inputTokens": 18446744073709527000,
            "outputTokens": "221360928884514260000",
            "cacheHitPercent": 0,
            "localModelSavings": {
              "totalUSD": 1,
              "calls": 1,
              "byModel": [{
                "name": "local",
                "calls": 1,
                "actualUSD": 0,
                "savingsUSD": 1,
                "baselineModel": "paid",
                "inputTokens": 221360928884514260000,
                "outputTokens": -1
              }],
              "byProvider": []
            },
            "topProjects": [{
              "name": "project",
              "cost": 1,
              "savingsUSD": 0,
              "sessions": 1,
              "avgCostPerSession": 1,
              "sessionDetails": [{
                "cost": 1,
                "savingsUSD": 0,
                "calls": 1,
                "inputTokens": 18446744073709527000,
                "outputTokens": 1.5,
                "date": "2026-06-21",
                "models": []
              }]
            }]
          },
          "optimize": {
            "findingCount": 0,
            "savingsUSD": 0,
            "topFindings": []
          },
          "history": {
            "daily": [{
              "date": "2026-06-21",
              "cost": 1,
              "savingsUSD": 0,
              "calls": 1,
              "inputTokens": 18446744073709527000,
              "outputTokens": -1,
              "cacheReadTokens": 1.5,
              "cacheWriteTokens": "221360928884514260000",
              "topModels": [{
                "name": "Gemini 3.5 Flash",
                "cost": 1,
                "savingsUSD": 0,
                "calls": 1,
                "inputTokens": 221360928884514260000,
                "outputTokens": -1
              }]
            }]
          }
        }
        """)

        #expect(payload.current.inputTokens == 0)
        #expect(payload.current.outputTokens == 0)
        #expect(payload.current.localModelSavings.byModel[0].inputTokens == 0)
        #expect(payload.current.localModelSavings.byModel[0].outputTokens == 0)
        #expect(payload.current.topProjects[0].sessionDetails[0].inputTokens == 0)
        #expect(payload.current.topProjects[0].sessionDetails[0].outputTokens == 0)
        #expect(payload.history.daily[0].inputTokens == 0)
        #expect(payload.history.daily[0].outputTokens == 0)
        #expect(payload.history.daily[0].cacheReadTokens == 0)
        #expect(payload.history.daily[0].cacheWriteTokens == 0)
        #expect(payload.history.daily[0].topModels[0].inputTokens == 0)
        #expect(payload.history.daily[0].topModels[0].outputTokens == 0)
    }

    @Test("huge non-token integers remain strict decode failures")
    func hugeNonTokenIntegersRemainStrictDecodeFailures() {
        var didThrow = false
        do {
            _ = try decode("""
            {
              "generated": "2026-06-22T00:00:00Z",
              "current": {
                "label": "Today",
                "cost": 1.0,
                "calls": 18446744073709551615,
                "sessions": 1,
                "inputTokens": 1,
                "outputTokens": 1
              },
              "optimize": {
                "findingCount": 0,
                "savingsUSD": 0,
                "topFindings": []
              },
              "history": { "daily": [] }
            }
            """)
        } catch {
            didThrow = true
        }

        #expect(didThrow)
    }
}
