import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("MenubarPayload combined")
struct MenubarPayloadCombinedTests {
    @Test("decodes combined block")
    func decodesCombinedBlock() throws {
        let json = combinedPayloadJSON()

        let payload = try JSONDecoder().decode(MenubarPayload.self, from: json)

        #expect(payload.combined?.perDevice.count == 2)
        #expect(payload.combined?.perDevice.first?.id == "local-device")
        #expect(payload.combined?.perDevice.first?.local == true)
        #expect(payload.combined?.perDevice.last?.error == "offline")
        #expect(payload.combined?.combined.cost == 4.5)
        #expect(payload.combined?.combined.calls == 7)
        #expect(payload.combined?.combined.deviceCount == 2)
        #expect(payload.combined?.combined.reachableCount == 1)
    }

    @Test("combined hero token total excludes cache tokens")
    func combinedHeroTokenTotalExcludesCacheTokens() throws {
        let payload = try JSONDecoder().decode(MenubarPayload.self, from: combinedPayloadJSON())
        let totals = HeroTotals(payload: payload, activeScope: .combined)

        #expect(payload.combined?.combined.totalTokens == 2000)
        #expect(totals.inputTokens == 1000)
        #expect(totals.outputTokens == 500)
        #expect(totals.totalTokens == 1500)
    }

    @Test("combined block is nil when absent")
    func combinedBlockIsNilWhenAbsent() throws {
        let json = Data("""
        {
          "generated": "2026-06-24T00:00:00Z",
          "current": {
            "label": "Today",
            "cost": 1.25,
            "calls": 2,
            "sessions": 1,
            "inputTokens": 100,
            "outputTokens": 50
          },
          "optimize": {
            "findingCount": 0,
            "savingsUSD": 0,
            "topFindings": []
          },
          "history": {
            "daily": []
          }
        }
        """.utf8)

        let payload = try JSONDecoder().decode(MenubarPayload.self, from: json)

        #expect(payload.combined == nil)
    }
}

private func combinedPayloadJSON() -> Data {
    Data("""
    {
      "generated": "2026-06-24T00:00:00Z",
      "current": {
        "label": "Today",
        "cost": 1.25,
        "calls": 2,
        "sessions": 1,
        "inputTokens": 100,
        "outputTokens": 50
      },
      "optimize": {
        "findingCount": 0,
        "savingsUSD": 0,
        "topFindings": []
      },
      "history": {
        "daily": []
      },
      "combined": {
        "perDevice": [
          {
            "id": "local-device",
            "name": "MacBook Pro",
            "local": true,
            "error": null,
            "cost": 4.5,
            "calls": 7,
            "sessions": 3,
            "inputTokens": 1000,
            "outputTokens": 500,
            "cacheCreateTokens": 200,
            "cacheReadTokens": 300,
            "totalTokens": 2000
          },
          {
            "id": "remote-device",
            "name": "Studio",
            "local": false,
            "error": "offline",
            "cost": 0,
            "calls": 0,
            "sessions": 0,
            "inputTokens": 0,
            "outputTokens": 0,
            "cacheCreateTokens": 0,
            "cacheReadTokens": 0,
            "totalTokens": 0
          }
        ],
        "combined": {
          "cost": 4.5,
          "calls": 7,
          "sessions": 3,
          "inputTokens": 1000,
          "outputTokens": 500,
          "cacheCreateTokens": 200,
          "cacheReadTokens": 300,
          "totalTokens": 2000,
          "deviceCount": 2,
          "reachableCount": 1
        }
      }
    }
    """.utf8)
}
