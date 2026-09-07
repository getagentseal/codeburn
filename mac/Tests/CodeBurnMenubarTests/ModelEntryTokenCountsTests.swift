import Foundation
import Testing
@testable import CodeBurnMenubar

/// Per-model token counts on `current.topModels` rows: decode shape, the
/// unknown-vs-zero rule, and the row presentation contract (compact secondary
/// line, exact values in accessibility, dashes for unknown).
@Suite("ModelEntry token counts")
struct ModelEntryTokenCountsTests {

    private func payloadJSON(topModels: String) -> Data {
        Data("""
        {
          "generated": "2026-09-07T00:00:00Z",
          "current": {
            "label": "Today",
            "cost": 3.25,
            "calls": 12,
            "sessions": 2,
            "inputTokens": 1000,
            "outputTokens": 500,
            "cacheHitPercent": 40,
            "topModels": \(topModels)
          },
          "optimize": { "findingCount": 0, "savingsUSD": 0, "topFindings": [] },
          "history": { "daily": [] }
        }
        """.utf8)
    }

    private func decode(_ topModels: String) throws -> MenubarPayload {
        try JSONDecoder().decode(MenubarPayload.self, from: payloadJSON(topModels: topModels))
    }

    @Test("decodes per-model counts when the payload carries them")
    func decodesCounts() throws {
        let payload = try decode("""
        [
          { "name": "Sonnet 4.6", "cost": 2.5, "savingsUSD": 0, "savingsBaselineModel": "", "calls": 9,
            "inputTokens": 152300, "outputTokens": 40200, "cacheReadTokens": 1180000, "cacheWriteTokens": 46000 }
        ]
        """)
        let row = payload.current.topModels[0]
        #expect(row.inputTokens == 152_300)
        #expect(row.outputTokens == 40_200)
        #expect(row.cacheReadTokens == 1_180_000)
        #expect(row.cacheWriteTokens == 46_000)
        #expect(row.hasTokenCounts)
    }

    @Test("counts stay nil on legacy rows that predate the fields")
    func legacyRowsStayNil() throws {
        let payload = try decode("""
        [
          { "name": "Sonnet 4.6", "cost": 2.5, "savingsUSD": 0, "savingsBaselineModel": "", "calls": 9 }
        ]
        """)
        let row = payload.current.topModels[0]
        #expect(row.inputTokens == nil)
        #expect(row.outputTokens == nil)
        #expect(row.cacheReadTokens == nil)
        #expect(row.cacheWriteTokens == nil)
        #expect(!row.hasTokenCounts)
    }

    @Test("a known zero decodes as zero, never as unknown")
    func knownZeroStaysZero() throws {
        let payload = try decode("""
        [
          { "name": "Haiku 4.5", "cost": 0, "savingsUSD": 0, "savingsBaselineModel": "", "calls": 3,
            "inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 900000, "cacheWriteTokens": 0 }
        ]
        """)
        let row = payload.current.topModels[0]
        #expect(row.inputTokens == 0)
        #expect(row.outputTokens == 0)
        #expect(row.cacheReadTokens == 900_000)
        #expect(row.cacheWriteTokens == 0)
        #expect(row.hasTokenCounts)
    }

    @Test("partially present counts keep the missing ones nil")
    func partialCountsStayNil() throws {
        let payload = try decode("""
        [
          { "name": "Sonnet 4.6", "cost": 1, "savingsUSD": 0, "savingsBaselineModel": "", "calls": 1,
            "inputTokens": 100 }
        ]
        """)
        let row = payload.current.topModels[0]
        #expect(row.inputTokens == 100)
        #expect(row.outputTokens == nil)
        #expect(row.cacheReadTokens == nil)
        #expect(row.hasTokenCounts)
    }

    @Test("secondary line: known zeros render as 0, unknown as a dash")
    func secondaryLineRenderings() throws {
        let zero = ModelEntry(name: "zero", cost: 0, savingsUSD: 0, savingsBaselineModel: "", calls: 1,
                              inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0)
        #expect(zero.hasTokenCounts)
        let unknown = ModelEntry(name: "unknown", cost: 1, savingsUSD: 0, savingsBaselineModel: "", calls: 1,
                                 outputTokens: 12)
        #expect(unknown.hasTokenCounts)
        // hasTokenCounts drives whether the secondary line renders at all.
        #expect(!ModelEntry(name: "legacy", cost: 1, savingsUSD: 0, savingsBaselineModel: "", calls: 1).hasTokenCounts)
    }

    @Test("accessibility text: exact counts, cache read labelled reused input, cache write separate")
    func accessibilityTextKeepsCacheKindsDistinct() throws {
        let payload = try decode("""
        [
          { "name": "Sonnet 4.6", "cost": 2.5, "savingsUSD": 0, "savingsBaselineModel": "", "calls": 9,
            "inputTokens": 152300, "outputTokens": 40200, "cacheReadTokens": 1180000, "cacheWriteTokens": 46000 }
        ]
        """)
        let label = payload.current.topModels[0].tokenAccessibilityText
        #expect(label.contains("152,300 input"))
        #expect(label.contains("40,200 output"))
        #expect(label.contains("1,180,000 cache read (reused input)"))
        #expect(label.contains("46,000 cache write"))
        // The two cache flavors must never merge into one bucket.
        #expect(!label.contains("cache 1,226,000"))
    }

    @Test("accessibility text omits zero cache write instead of pairing it with cache read")
    func accessibilityTextOmitsZeroCacheWrite() throws {
        let payload = try decode("""
        [
          { "name": "Haiku 4.5", "cost": 0, "savingsUSD": 0, "savingsBaselineModel": "", "calls": 3,
            "inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 900000, "cacheWriteTokens": 0 }
        ]
        """)
        let label = payload.current.topModels[0].tokenAccessibilityText
        #expect(label.contains("900,000 cache read (reused input)"))
        #expect(!label.contains("cache write"))
    }
}
