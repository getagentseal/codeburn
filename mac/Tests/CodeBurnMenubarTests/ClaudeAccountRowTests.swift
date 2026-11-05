import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Claude account rows")
struct ClaudeAccountRowTests {
    @Test("decodes identities with an optional plan, and an absent field as empty")
    func decodesIdentities() throws {
        let payload = try JSONDecoder().decode(MenubarPayload.self, from: payloadJSON(identities: """
        ,"identities": [
          {"hash": "aaaaaaaaaaaa", "label": "Acme Corp", "plan": "Max 5x", "cost": 3, "calls": 4, "sessions": 2},
          {"hash": "unattributed", "label": "unattributed", "cost": 1, "calls": 1, "sessions": 1}
        ]
        """))

        #expect(payload.current.identities == [
            IdentitySplitRow(hash: "aaaaaaaaaaaa", label: "Acme Corp", plan: "Max 5x", cost: 3, calls: 4, sessions: 2),
            IdentitySplitRow(hash: "unattributed", label: "unattributed", cost: 1, calls: 1, sessions: 1),
        ])
        let legacy = try JSONDecoder().decode(MenubarPayload.self, from: payloadJSON(identities: ""))
        #expect(legacy.current.identities.isEmpty)
    }

    @Test("two or more identities become rows by cost with the plan suffix; one becomes none")
    func rowsSortedByCost() {
        let rows = ClaudeAccountRow.rows([
            IdentitySplitRow(hash: "bbbbbbbbbbbb", label: "Home", cost: 1, calls: 2, sessions: 1),
            IdentitySplitRow(hash: "aaaaaaaaaaaa", label: "Acme Corp", plan: "Max 5x", cost: 5, calls: 9, sessions: 3),
            IdentitySplitRow(hash: "unattributed", label: "unattributed", cost: 2, calls: 1, sessions: 1),
        ])

        #expect(rows.map(\.title) == ["Acme Corp · Max 5x", L("Unattributed"), "Home"])
        #expect(rows.map(\.cost) == [5, 2, 1])
        #expect(rows.first == ClaudeAccountRow(id: "aaaaaaaaaaaa", title: "Acme Corp · Max 5x", cost: 5, calls: 9, sessions: 3))
        #expect(ClaudeAccountRow.rows([
            IdentitySplitRow(hash: "aaaaaaaaaaaa", label: "Acme Corp", plan: "Max 5x", cost: 5, calls: 9, sessions: 3),
        ]).isEmpty)
        #expect(ClaudeAccountRow.rows([]).isEmpty)
    }
}

private func payloadJSON(identities: String) -> Data {
    Data("""
    {
      "generated": "2026-11-04T00:00:00Z",
      "current": {
        "label": "Today",
        "cost": 4,
        "calls": 5,
        "sessions": 3,
        "inputTokens": 100,
        "outputTokens": 50
        \(identities)
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
}
