import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("MenubarStatusCache")
struct MenubarStatusCacheTests {
    private func tempDir() -> String {
        let dir = NSTemporaryDirectory() + "menubar-status-test-" + UUID().uuidString
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        return dir
    }

    private func validPayloadJSON(cost: Double) -> Data {
        let p = MenubarPayload(
            generated: "2026-05-29T00:00:00Z",
            current: CurrentBlock(
                label: "Today", cost: cost, calls: 1, sessions: 1, oneShotRate: nil,
                inputTokens: 1, outputTokens: 1, cacheHitPercent: 0,
                topActivities: [], topModels: [], providers: ["claude": cost],
                topProjects: [], modelEfficiency: [], topSessions: [],
                retryTax: RetryTax(totalUSD: 0, retries: 0, editTurns: 0, byModel: []),
                routingWaste: RoutingWaste(totalSavingsUSD: 0, baselineModel: "", baselineCostPerEdit: 0, byModel: []),
                tools: [], skills: [], subagents: [], mcpServers: []
            ),
            optimize: OptimizeBlock(findingCount: 0, savingsUSD: 0, topFindings: []),
            history: HistoryBlock(daily: [], intraday: []),
            stats: StatsSummary(trackedSpend: 0, trackedDays: 0, mostActiveDay: nil, peakDaySpend: nil, currentStreakDays: 0, longestStreakDays: 0)
        )
        return try! JSONEncoder().encode(p)
    }

    @Test("reads a fresh, valid status file")
    func readsValidFile() throws {
        let dir = tempDir()
        let path = dir + "/menubar-status.json"
        try validPayloadJSON(cost: 42.5).write(to: URL(fileURLWithPath: path))
        let cache = MenubarStatusCache(statusPath: path)

        let result = cache.readBadgePayload(maxAgeSeconds: 3600)

        #expect(result?.payload.current.cost == 42.5)
        #expect((result?.ageSeconds ?? .infinity) < 60)
    }

    @Test("returns nil for a missing file")
    func missingFileReturnsNil() {
        let dir = tempDir()
        let cache = MenubarStatusCache(statusPath: dir + "/nope.json")
        #expect(cache.readBadgePayload(maxAgeSeconds: 3600) == nil)
    }

    @Test("returns nil for a corrupt file")
    func corruptFileReturnsNil() throws {
        let dir = tempDir()
        let path = dir + "/menubar-status.json"
        try Data("{ not json".utf8).write(to: URL(fileURLWithPath: path))
        let cache = MenubarStatusCache(statusPath: path)
        #expect(cache.readBadgePayload(maxAgeSeconds: 3600) == nil)
    }

    @Test("returns nil for an over-age file")
    func overAgeFileReturnsNil() throws {
        let dir = tempDir()
        let path = dir + "/menubar-status.json"
        let url = URL(fileURLWithPath: path)
        try validPayloadJSON(cost: 7).write(to: url)
        try FileManager.default.setAttributes(
            [.modificationDate: Date().addingTimeInterval(-7200)], ofItemAtPath: path
        )
        let cache = MenubarStatusCache(statusPath: path)
        #expect(cache.readBadgePayload(maxAgeSeconds: 3600) == nil)
    }

    @Test("writeStatus round-trips through readBadgePayload")
    func writeStatusRoundTrips() throws {
        let dir = tempDir()
        let path = dir + "/menubar-status.json"
        let cache = MenubarStatusCache(statusPath: path)

        let payload = try JSONDecoder().decode(MenubarPayload.self, from: validPayloadJSON(cost: 13.5))
        try cache.writeStatus(payload)

        let result = cache.readBadgePayload(maxAgeSeconds: 3600)
        #expect(result?.payload.current.cost == 13.5)
    }
}
