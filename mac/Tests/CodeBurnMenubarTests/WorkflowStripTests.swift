import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("WorkflowStrip -- duration formatter")
struct WorkflowStripDurationTests {
    @Test("seconds under a minute")
    func seconds() {
        #expect(WorkflowStripModel.formatDuration(ms: 8_000) == "8s")
        #expect(WorkflowStripModel.formatDuration(ms: 45_000) == "45s")
        // Rounds to nearest second (away from zero on .5).
        #expect(WorkflowStripModel.formatDuration(ms: 1_500) == "2s")
    }

    @Test("whole minutes below an hour")
    func minutes() {
        #expect(WorkflowStripModel.formatDuration(ms: 60_000) == "1m")
        #expect(WorkflowStripModel.formatDuration(ms: 360_000) == "6m")
        // 1m30s rounds up to 2m.
        #expect(WorkflowStripModel.formatDuration(ms: 90_000) == "2m")
    }

    @Test("hours and minutes at and above an hour")
    func hours() {
        #expect(WorkflowStripModel.formatDuration(ms: 3_600_000) == "1h 0m")
        #expect(WorkflowStripModel.formatDuration(ms: 3_900_000) == "1h 5m")
        #expect(WorkflowStripModel.formatDuration(ms: 7_500_000) == "2h 5m")
    }

    @Test("coaching-note short formatter matches the CLI (seconds/minutes only)")
    func shortFormatter() {
        #expect(WorkflowStripModel.formatDurationShort(ms: 45_000) == "45s")
        #expect(WorkflowStripModel.formatDurationShort(ms: 300_000) == "5m")
        // Above an hour the note still reads minutes, unlike the stat (which is "1h 5m").
        #expect(WorkflowStripModel.formatDurationShort(ms: 3_900_000) == "65m")
    }
}

@Suite("WorkflowStrip -- coaching note selection")
struct WorkflowStripNoteTests {
    private func file(_ path: String, sessions: Int, edits: Int) -> ReworkedFileEntry {
        ReworkedFileEntry(path: path, sessions: sessions, edits: edits)
    }

    @Test("corrections note fires at threshold and wins over the others")
    func correctionsWins() {
        let note = WorkflowStripModel.coachingNote(
            corrections: 5,
            correctionRate: 0.2,
            topFile: file("sdk.py", sessions: 15, edits: 42),
            medianTimeToFirstEditMs: 600_000
        )
        #expect(note == "You corrected the assistant on 20% of prompts (5 times). State the requirements in the first message to cut the back and forth.")
    }

    @Test("corrections note gated by rate and count")
    func correctionsGating() {
        // Rate below 0.15 -> falls through to churn.
        #expect(WorkflowStripModel.coachingNote(corrections: 9, correctionRate: 0.1, topFile: file("a.py", sessions: 4, edits: 8), medianTimeToFirstEditMs: nil)
                == "a.py was reworked across 4 sessions (8 edits). A focused pass on it may cost less than the repeated churn.")
        // Count below 3 -> falls through to churn.
        #expect(WorkflowStripModel.coachingNote(corrections: 2, correctionRate: 0.9, topFile: file("a.py", sessions: 4, edits: 8), medianTimeToFirstEditMs: nil)
                == "a.py was reworked across 4 sessions (8 edits). A focused pass on it may cost less than the repeated churn.")
    }

    @Test("churn note fires and uses the basename")
    func churn() {
        let note = WorkflowStripModel.coachingNote(
            corrections: 0,
            correctionRate: nil,
            topFile: file("src/lib/sdk.py", sessions: 15, edits: 42),
            medianTimeToFirstEditMs: nil
        )
        #expect(note == "sdk.py was reworked across 15 sessions (42 edits). A focused pass on it may cost less than the repeated churn.")
    }

    @Test("ttfe note fires at 5 minutes when nothing stronger does")
    func ttfe() {
        let note = WorkflowStripModel.coachingNote(
            corrections: 0,
            correctionRate: nil,
            topFile: file("a.py", sessions: 2, edits: 3),
            medianTimeToFirstEditMs: 300_000
        )
        #expect(note == "Median time to first edit is 5m. Point the assistant at the target file to cut the exploration before it starts editing.")
    }

    @Test("no note when nothing crosses a threshold")
    func none() {
        #expect(WorkflowStripModel.coachingNote(corrections: 1, correctionRate: 0.05, topFile: file("a.py", sessions: 1, edits: 2), medianTimeToFirstEditMs: 120_000) == nil)
        #expect(WorkflowStripModel.coachingNote(corrections: 0, correctionRate: nil, topFile: nil, medianTimeToFirstEditMs: nil) == nil)
    }
}

@Suite("WorkflowStrip -- model derivation")
struct WorkflowStripModelTests {
    @Test("full payload renders all three stats and a note")
    func full() {
        let model = WorkflowStripModel(
            workflow: WorkflowBlock(corrections: 5, correctionRate: 0.03, medianTimeToFirstEditMs: 360_000),
            topReworkedFiles: [ReworkedFileEntry(path: "sdk.py", sessions: 15, edits: 42)]
        )
        #expect(model.corrections == "3% (5)")
        #expect(model.firstEdit == "6m")
        #expect(model.reworked == "sdk.py ×15")
        #expect(model.isEmpty == false)
        // rate 0.03 < 0.15 so corrections note doesn't fire; churn does.
        #expect(model.note == "sdk.py was reworked across 15 sessions (42 edits). A focused pass on it may cost less than the repeated churn.")
    }

    @Test("basename is applied to the reworked stat")
    func reworkedBasename() {
        let model = WorkflowStripModel(
            workflow: nil,
            topReworkedFiles: [ReworkedFileEntry(path: "app/src/main.ts", sessions: 4, edits: 9)]
        )
        #expect(model.reworkedName == "main.ts")
        #expect(model.reworked == "main.ts ×4")
    }

    @Test("nil workflow and empty files -> hidden")
    func emptyHidden() {
        let model = WorkflowStripModel(workflow: nil, topReworkedFiles: [])
        #expect(model.isEmpty)
        #expect(model.corrections == nil)
        #expect(model.firstEdit == nil)
        #expect(model.reworkedName == nil)
        #expect(model.note == nil)
    }

    @Test("all-empty workflow (zeros/nulls) -> hidden, no zero placeholders")
    func allEmptyHidden() {
        let model = WorkflowStripModel(
            workflow: WorkflowBlock(corrections: 0, correctionRate: 0.0, medianTimeToFirstEditMs: nil),
            topReworkedFiles: []
        )
        #expect(model.isEmpty)
        #expect(model.corrections == nil)   // 0 corrections is never "0% (0)"
        #expect(model.firstEdit == nil)
    }

    @Test("zero median and zero-session file are treated as absent")
    func degenerateValues() {
        let model = WorkflowStripModel(
            workflow: WorkflowBlock(corrections: 0, correctionRate: nil, medianTimeToFirstEditMs: 0),
            topReworkedFiles: [ReworkedFileEntry(path: "a.py", sessions: 0, edits: 0)]
        )
        #expect(model.firstEdit == nil)
        #expect(model.reworkedName == nil)
        #expect(model.isEmpty)
    }

    @Test("a correction rate that rounds to 0% hides the corrections stat")
    func subOnePercentCorrections() {
        // Mirrors real month data: 6 corrections over thousands of turns -> 0.17%.
        let model = WorkflowStripModel(
            workflow: WorkflowBlock(corrections: 6, correctionRate: 0.001692524682651622, medianTimeToFirstEditMs: 384_425),
            topReworkedFiles: [ReworkedFileEntry(path: "sdk.py", sessions: 9, edits: 54)]
        )
        #expect(model.corrections == nil)
        #expect(model.firstEdit == "6m")
        #expect(model.reworked == "sdk.py ×9")
        #expect(model.note == "sdk.py was reworked across 9 sessions (54 edits). A focused pass on it may cost less than the repeated churn.")
        #expect(model.isEmpty == false)
    }

    @Test("only a reworked file present renders one stat and the churn note")
    func onlyReworked() {
        let model = WorkflowStripModel(
            workflow: nil,
            topReworkedFiles: [ReworkedFileEntry(path: "a.py", sessions: 4, edits: 10)]
        )
        #expect(model.corrections == nil)
        #expect(model.firstEdit == nil)
        #expect(model.reworked == "a.py ×4")
        #expect(model.isEmpty == false)
        #expect(model.note == "a.py was reworked across 4 sessions (10 edits). A focused pass on it may cost less than the repeated churn.")
    }
}

@Suite("WorkflowStrip -- payload decoding")
struct WorkflowStripDecodeTests {
    private func decodeCurrent(_ json: String) throws -> CurrentBlock {
        try JSONDecoder().decode(CurrentBlock.self, from: Data(json.utf8))
    }

    @Test("decodes workflow and topReworkedFiles when present")
    func present() throws {
        let current = try decodeCurrent("""
        {
          "label": "Month", "cost": 1, "calls": 2, "sessions": 3,
          "inputTokens": 4, "outputTokens": 5,
          "workflow": { "corrections": 5, "correctionRate": 0.03, "medianTimeToFirstEditMs": 360000 },
          "topReworkedFiles": [ { "path": "sdk.py", "sessions": 15, "edits": 42 } ]
        }
        """)
        #expect(current.workflow?.corrections == 5)
        #expect(current.workflow?.correctionRate == 0.03)
        #expect(current.workflow?.medianTimeToFirstEditMs == 360_000)
        #expect(current.topReworkedFiles.first?.path == "sdk.py")
        #expect(current.topReworkedFiles.first?.sessions == 15)
        #expect(current.topReworkedFiles.first?.edits == 42)
    }

    @Test("decodes null workflow rates to nil")
    func nulls() throws {
        let current = try decodeCurrent("""
        {
          "label": "Month", "cost": 1, "calls": 2, "sessions": 3,
          "inputTokens": 4, "outputTokens": 5,
          "workflow": { "corrections": 0, "correctionRate": null, "medianTimeToFirstEditMs": null },
          "topReworkedFiles": []
        }
        """)
        #expect(current.workflow?.corrections == 0)
        #expect(current.workflow?.correctionRate == nil)
        #expect(current.workflow?.medianTimeToFirstEditMs == nil)
        #expect(current.topReworkedFiles.isEmpty)
    }

    @Test("older payloads without the keys decode fine")
    func backwardCompatible() throws {
        let current = try decodeCurrent("""
        {
          "label": "Month", "cost": 1, "calls": 2, "sessions": 3,
          "inputTokens": 4, "outputTokens": 5
        }
        """)
        #expect(current.workflow == nil)
        #expect(current.topReworkedFiles.isEmpty)
        // And an older payload yields a hidden strip.
        let model = WorkflowStripModel(workflow: current.workflow, topReworkedFiles: current.topReworkedFiles)
        #expect(model.isEmpty)
    }
}
