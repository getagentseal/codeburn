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
    var precisionLabel: String {
        if estimated { return "Turn estimate" }
        switch resolution {
        case "token": return "Individual tokens"
        case "chunk": return "Chunk timing"
        case "request": return "Request timing"
        default: return "Turn timing"
        }
    }
}
