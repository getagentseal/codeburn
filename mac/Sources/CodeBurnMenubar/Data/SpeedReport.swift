import Foundation

/// Local timing report, independent of usage/plan/project/account snapshots.
struct SpeedReport: Decodable, Sendable {
    let rows: [SpeedRow]
    let generatedAt: String
    let rejectedRecords: Int
    let omittedRecords: Int
    let warnings: [String]
    let historyLimit: Int

    var hasCoverageWarning: Bool { rejectedRecords > 0 || omittedRecords > 0 || !warnings.isEmpty }

    /// Latest observed groups, never the fastest model or a blended provider rate.
    /// Recheck the rolling window even when the CLI snapshot is stale.
    func recentRows(harness: String? = nil, now: Date = Date()) -> [SpeedRow] {
        rows.filter { row in
            guard harness == nil || row.harness == harness,
                  row.timedRequests > 0,
                  let startedAt = row.latestDate else { return false }
            // A completed turn without first-token timing remains visible as
            // unavailable; never replace generation speed with its request rate.
            if let rate = row.generationTokensPerSecondP50, !rate.isFinite || rate <= 0 { return false }
            return startedAt >= now.addingTimeInterval(-86_400) && startedAt <= now
        }.sorted { $0.latestStartedAt > $1.latestStartedAt }
    }
}

struct SpeedRow: Decodable, Sendable, Identifiable {
    let harness: String
    let model: String
    let source: String
    let resolution: String
    let latestStartedAt: String
    let estimated: Bool
    let generationRateEstimated: Bool
    let generationRequests: Int
    let timedRequests: Int
    let requests: Int
    let generationTokensPerSecondP50: Double?
    let firstEmissionMsP50: Double?
    /// Median day in the week before the window; absent from older CLIs.
    let typical: SpeedTypical?
    /// Most requests arrived in sub-second bursts, so the CLI withholds a rate.
    let bufferedDelivery: Bool?

    var id: String { [harness, model, source, resolution].joined(separator: "|") }
    var harnessName: String {
        switch harness {
        case "codex": "Codex"
        case "claude": "Claude Code"
        case "zcode": "ZCode"
        case "dsh": "DeepSeek Harness"
        case "hermes": "Hermes"
        case "antigravity": "Antigravity"
        default: harness
        }
    }
    var latestDate: Date? {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = parser.date(from: latestStartedAt) { return date }
        parser.formatOptions = [.withInternetDateTime]
        return parser.date(from: latestStartedAt)
    }
    var formattedRate: String {
        guard let rate = generationTokensPerSecondP50, rate.isFinite, rate > 0, generationRequests > 0 else { return "—" }
        return (generationRateEstimated ? "~" : "") + String(format: "%.1f tok/s", rate)
    }
    var formattedFirstArrival: String {
        guard let first = firstEmissionMsP50, first.isFinite else { return "—" }
        return String(format: "%.0f ms", first)
    }
    /// "Typical 70.1 tok/s · 4944 ms", or nil without a typical day.
    var typicalLabel: String? {
        let parts = [
            typical?.generationTokensPerSecondP50.flatMap { $0.isFinite && $0 > 0 ? String(format: "%.1f tok/s", $0) : nil },
            typical?.firstEmissionMsP50.flatMap { $0.isFinite ? String(format: "%.0f ms", $0) : nil },
        ].compactMap { $0 }
        return parts.isEmpty ? nil : "\(L("Typical")) \(parts.joined(separator: " · "))"
    }
    var generationChange: SpeedChange? {
        SpeedChange(typical?.generationChangePct, shift: typical?.generationShift == true, higherIsBetter: true)
    }
    var firstArrivalChange: SpeedChange? {
        SpeedChange(typical?.firstEmissionChangePct, shift: typical?.firstEmissionShift == true, higherIsBetter: false)
    }
    var precisionLabel: String {
        if estimated { return L("Turn estimate") }
        switch resolution {
        case "token": return L("Individual tokens")
        case "chunk": return L("Chunk timing")
        case "request": return L("Request timing")
        default: return L("Turn timing")
        }
    }
}

/// Change against the typical day. The CLI's 25% rule decides a shift; a
/// shift reads green when it helps (faster, earlier) and orange when it hurts.
struct SpeedChange: Equatable {
    enum Tone { case good, bad, flat }
    let text: String
    let tone: Tone

    init?(_ pct: Double?, shift: Bool, higherIsBetter: Bool) {
        guard let pct, pct.isFinite else { return nil }
        let rounded = pct.rounded()
        text = (rounded > 0 ? "+" : rounded < 0 ? "−" : "") + String(format: "%.0f%%", abs(rounded))
        tone = !shift || rounded == 0 ? .flat : (rounded > 0) == higherIsBetter ? .good : .bad
    }
}

struct SpeedTypical: Decodable, Sendable {
    let days: Int
    let generationTokensPerSecondP50: Double?
    let firstEmissionMsP50: Double?
    let generationChangePct: Double?
    let firstEmissionChangePct: Double?
    let generationShift: Bool
    let firstEmissionShift: Bool
}
