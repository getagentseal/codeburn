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

    @Test("Typical-day labels carry the CLI's change; a thin window or an older CLI shows none")
    func typicalDay() throws {
        let typical = { (change: String) in
            #"{"days":4,"generationTokensPerSecondP50":70.1,"firstEmissionMsP50":4944,"generationChangePct":\#(change),"firstEmissionChangePct":351.2,"generationShift":false,"firstEmissionShift":true}"#
        }
        let with = { (change: String) in row().replacingOccurrences(of: #""firstEmissionMsP50":741.9}"#, with: #""firstEmissionMsP50":741.9,"typical":\#(typical(change))}"#) }
        let rows = try report([with("-22.6"), with("null"), row()].joined(separator: ",")).rows
        let moved = try #require(rows[0].typical)
        #expect(moved.firstEmissionShift)
        #expect(!moved.generationShift)
        #expect(rows[0].typicalLabel == "\(L("Typical")) 70.1 tok/s · 4944 ms")
        // A 23% dip stays neutral; the CLI flagged the later first arrival, which hurts.
        #expect(rows[0].generationChange?.text == "−23%")
        #expect(rows[0].generationChange?.tone == .flat)
        #expect(rows[0].firstArrivalChange?.text == "+351%")
        #expect(rows[0].firstArrivalChange?.tone == .bad)
        #expect(rows[1].generationChange == nil)
        #expect(rows[1].typicalLabel == "\(L("Typical")) 70.1 tok/s · 4944 ms")
        #expect(rows[2].typical == nil)
        #expect(rows[2].typicalLabel == nil)
        #expect(rows[2].firstArrivalChange == nil)
        #expect(SpeedChange(40, shift: true, higherIsBetter: true)?.tone == .good)
        #expect(SpeedChange(-40, shift: true, higherIsBetter: false)?.tone == .good)
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
