import Foundation

/// Pure, testable derivation of the menubar Workflow strip from the decoded
/// payload. The view renders exactly these values; all formatting and the
/// coaching-note selection live here so they can be unit-tested without SwiftUI.
///
/// Every field is nil unless it carries real signal: a stat is never shown as a
/// zero placeholder. `isEmpty` is true when none of the three stats fire, and
/// the section renders nothing in that case.
struct WorkflowStripModel: Equatable {
    /// Correction rate as a percent with the raw count, e.g. "3% (5)".
    let corrections: String?
    /// Median time to the first edit, e.g. "6m".
    let firstEdit: String?
    /// Most reworked file, basename only, e.g. "sdk.py".
    let reworkedName: String?
    /// Distinct-session count for the most reworked file, e.g. 15.
    let reworkedSessions: Int?
    /// One coaching note, or nil. Mirrors the first-firing note in
    /// src/workflow-insights.ts buildCoachingNotes over the payload's signals.
    let note: String?

    /// Nothing worth showing -> the section hides itself.
    var isEmpty: Bool {
        corrections == nil && firstEdit == nil && reworkedName == nil
    }

    /// The reworked stat as one string, e.g. "sdk.py ×15" (used for the exact
    /// rendered value and by tests).
    var reworked: String? {
        guard let reworkedName, let reworkedSessions else { return nil }
        return "\(reworkedName) ×\(reworkedSessions)"
    }
}

extension WorkflowStripModel {
    // Coaching-note thresholds, matching src/workflow-insights.ts exactly.
    static let correctionHighRate = 0.15
    static let correctionMinCount = 3
    static let churnMinSessions = 3
    static let ttfeSlowMs: Double = 5 * 60 * 1000

    init(workflow: WorkflowBlock?, topReworkedFiles: [ReworkedFileEntry]) {
        let topFile = topReworkedFiles.first

        // Corrections: only when the displayed rate is a real, non-zero percent.
        // The rate is the headline; a count of corrections that rounds to 0% (a
        // handful over thousands of turns) carries no signal, so the whole stat
        // hides rather than reading "0% (6)".
        if let rate = workflow?.correctionRate, let count = workflow?.corrections,
           count > 0, Int((rate * 100).rounded()) >= 1 {
            corrections = "\(Self.percent(rate)) (\(count))"
        } else {
            corrections = nil
        }

        // First edit: only a real, positive median.
        if let ms = workflow?.medianTimeToFirstEditMs, ms > 0 {
            firstEdit = Self.formatDuration(ms: ms)
        } else {
            firstEdit = nil
        }

        // Top reworked file: basename ×sessions.
        if let file = topFile, file.sessions > 0 {
            reworkedName = Self.basename(file.path)
            reworkedSessions = file.sessions
        } else {
            reworkedName = nil
            reworkedSessions = nil
        }

        note = Self.coachingNote(
            corrections: workflow?.corrections ?? 0,
            correctionRate: workflow?.correctionRate,
            topFile: topFile,
            medianTimeToFirstEditMs: workflow?.medianTimeToFirstEditMs
        )
    }

    /// Picks the single coaching note: the first threshold that fires, in the
    /// same order as buildCoachingNotes (the worst-one-shot note is omitted
    /// because that signal is not in the menubar payload). Copy is byte-for-byte
    /// the CLI's, no em-dashes.
    static func coachingNote(corrections: Int,
                             correctionRate: Double?,
                             topFile: ReworkedFileEntry?,
                             medianTimeToFirstEditMs: Double?) -> String? {
        if let rate = correctionRate, rate >= correctionHighRate, corrections >= correctionMinCount {
            return "You corrected the assistant on \(percent(rate)) of prompts (\(corrections) times). State the requirements in the first message to cut the back and forth."
        }
        if let file = topFile, file.sessions >= churnMinSessions {
            return "\(basename(file.path)) was reworked across \(file.sessions) sessions (\(file.edits) edits). A focused pass on it may cost less than the repeated churn."
        }
        if let ms = medianTimeToFirstEditMs, ms >= ttfeSlowMs {
            return "Median time to first edit is \(formatDurationShort(ms: ms)). Point the assistant at the target file to cut the exploration before it starts editing."
        }
        return nil
    }

    /// "First edit" stat duration: <60s -> "Ns", <60m -> "Nm", else "Nh Nm".
    static func formatDuration(ms: Double) -> String {
        if ms < 60_000 { return "\(Int((ms / 1000).rounded()))s" }
        let totalMinutes = Int((ms / 60_000).rounded())
        if totalMinutes < 60 { return "\(totalMinutes)m" }
        return "\(totalMinutes / 60)h \(totalMinutes % 60)m"
    }

    /// Mirrors formatDurationShort in src/workflow-insights.ts: whole seconds
    /// under a minute, whole minutes above. Used only inside the coaching note so
    /// the copy matches the CLI exactly.
    static func formatDurationShort(ms: Double) -> String {
        if ms >= 60_000 { return "\(Int((ms / 60_000).rounded()))m" }
        return "\(Int((ms / 1000).rounded()))s"
    }

    /// Rounded percent from a 0-1 rate, matching JS `Math.round(rate * 100)`.
    static func percent(_ rate: Double) -> String {
        "\(Int((rate * 100).rounded()))%"
    }

    /// Last path component. The payload is already basename-only, but an older
    /// CLI could emit a fuller (forward-slash) path.
    static func basename(_ path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }
}
