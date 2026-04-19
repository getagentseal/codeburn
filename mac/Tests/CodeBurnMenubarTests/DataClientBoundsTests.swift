import Foundation
import Testing
@testable import CodeBurnMenubar

/// Builds a minimal-but-valid MenubarPayload with `daily` populated to a given length so tests
/// can exercise the post-decode array-length guards without constructing hundreds of fields.
private func payload(with dailyCount: Int, topModelsPerEntry: Int = 0) -> MenubarPayload {
    let entry = DailyHistoryEntry(
        date: "2026-04-19",
        cost: 0,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        topModels: Array(
            repeating: DailyModelBreakdown(name: "m", cost: 0, calls: 0, inputTokens: 0, outputTokens: 0),
            count: topModelsPerEntry
        )
    )
    return MenubarPayload(
        generated: "",
        current: CurrentBlock(
            label: "", cost: 0, calls: 0, sessions: 0, oneShotRate: nil,
            inputTokens: 0, outputTokens: 0, cacheHitPercent: 0,
            topActivities: [], topModels: [], providers: [:]
        ),
        optimize: OptimizeBlock(findingCount: 0, savingsUSD: 0, topFindings: []),
        history: HistoryBlock(daily: Array(repeating: entry, count: dailyCount))
    )
}

@Suite("DataClient -- payload bounds")
struct DataClientBoundsTests {
    @Test("accepts a payload within every per-array cap")
    func acceptsWithinBounds() throws {
        try DataClient.validatePayloadBounds(payload(with: 400, topModelsPerEntry: 64))
    }

    @Test("rejects history.daily longer than cap")
    func rejectsOversizedDaily() {
        #expect(throws: DataClientError.self) {
            try DataClient.validatePayloadBounds(payload(with: 401))
        }
    }

    @Test("rejects an oversized nested topModels array")
    func rejectsOversizedTopModels() {
        #expect(throws: DataClientError.self) {
            try DataClient.validatePayloadBounds(payload(with: 1, topModelsPerEntry: 65))
        }
    }

    @Test("rejects oversized current.topActivities")
    func rejectsOversizedActivities() {
        let base = payload(with: 0)
        let oversizeActivities = Array(
            repeating: ActivityEntry(name: "a", cost: 0, turns: 0, oneShotRate: nil),
            count: 65
        )
        let poisoned = MenubarPayload(
            generated: base.generated,
            current: CurrentBlock(
                label: "", cost: 0, calls: 0, sessions: 0, oneShotRate: nil,
                inputTokens: 0, outputTokens: 0, cacheHitPercent: 0,
                topActivities: oversizeActivities,
                topModels: [],
                providers: [:]
            ),
            optimize: base.optimize,
            history: base.history
        )
        #expect(throws: DataClientError.self) {
            try DataClient.validatePayloadBounds(poisoned)
        }
    }
}
