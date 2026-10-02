import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Local generation speed")
struct SpeedReportTests {
    private let now = ISO8601DateFormatter().date(from: "2026-10-02T12:00:00Z")!

    private func report(_ rows: String) throws -> SpeedReport {
        try JSONDecoder().decode(SpeedReport.self, from: Data("""
        {"rows":[\(rows)],"generatedAt":"2026-10-02T12:00:00Z","rejectedRecords":0,"omittedRecords":0,"warnings":[],"historyLimit":10}
        """.utf8))
    }

    private func row(_ harness: String = "dsh", model: String = "deepseek-flash", time: String = "2026-10-02T11:00:00.000Z", rate: String = "36.2", timed: Int = 1, estimated: Bool = false, resolution: String = "chunk") -> String {
        """
        {"harness":"\(harness)","model":"\(model)","source":"proxy","resolution":"\(resolution)","latestStartedAt":"\(time)","estimated":\(estimated),"timedRequests":\(timed),"requests":2,"effectiveTokensPerSecond":6.7,"generationTokensPerSecondP50":\(resolution == "turn" ? "null" : rate),"generationRateEstimated":\(resolution != "token"),"generationRequests":\(resolution == "turn" || rate == "null" ? 0 : timed),"firstEmissionMsP50":741.9}
        """
    }

    @Test("Decode CLI records with full harness names and honest precision")
    func precision() throws {
        let rows = try report([row(), row("codex", estimated: true, resolution: "turn"), row("hermes", resolution: "token")].joined(separator: ",")).rows
        #expect(rows[0].harnessName == "DeepSeek Harness")
        #expect(rows[0].formattedRate == "~36.2 tok/s")
        #expect(rows[0].formattedFirstArrival == "742 ms")
        #expect(rows[0].precisionLabel == L("Chunk timing"))
        #expect(rows[1].formattedRate == "—")
        #expect(rows[1].precisionLabel == L("Turn estimate"))
        #expect(rows[2].precisionLabel == L("Individual tokens"))
        #expect(rows[2].formattedRate == "36.2 tok/s")
    }

    @Test("Select the latest matching model, not the fastest; never mix harnesses")
    func latestMatching() throws {
        let data = try report([
            row(model: "fast-old", time: "2026-10-02T09:00:00.000Z", rate: "99"),
            row("hermes", model: "other-harness", time: "2026-10-02T11:30:00.000Z"),
            row(model: "recent-model"),
        ].joined(separator: ","))
        #expect(data.recentRows(harness: "dsh", now: now).map(\.model) == ["recent-model", "fast-old"])
        #expect(data.recentRows(now: now).first?.model == "other-harness")
    }

    @Test("Rolling window excludes expired, future and incomplete timings; missing generation stays unavailable")
    func unavailable() throws {
        let data = try report([
            row(time: "2026-10-01T11:59:59.000Z"), row(time: "2026-10-03T11:00:00.000Z"),
            row(model: "unavailable", rate: "null"), row(timed: 0), row(rate: "0"), row(time: "invalid"),
            row(model: "boundary", time: "2026-10-01T12:00:00Z"),
        ].joined(separator: ","))
        #expect(data.recentRows(now: now).map(\.model) == ["unavailable", "boundary"])
        #expect(data.rows[2].formattedRate == "—")
        #expect(data.rows[3].formattedRate == "—")
    }
}
