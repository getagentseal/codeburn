import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Claude plan recorder")
struct ClaudePlanRecorderTests {
    @Test("hands the plan to the CLI only when it changed for that config dir")
    func runsOnlyWhenChanged() {
        let calls = Calls()
        let recorder = ClaudePlanRecorder(run: { calls.append($0) })

        recorder.record(plan: "Max 5x", configDir: "/u/.claude")
        recorder.record(plan: "Max 5x", configDir: "/u/.claude")
        recorder.record(plan: "Max 20x", configDir: "/u/.claude")
        recorder.record(plan: "Max 20x", configDir: "/u/other")

        #expect(calls.value == [
            ["identity", "plan", "--config-dir", "/u/.claude", "--plan", "Max 5x"],
            ["identity", "plan", "--config-dir", "/u/.claude", "--plan", "Max 20x"],
            ["identity", "plan", "--config-dir", "/u/other", "--plan", "Max 20x"],
        ])
    }
}

private final class Calls: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [[String]] = []
    var value: [[String]] { lock.withLock { stored } }
    func append(_ call: [String]) { lock.withLock { stored.append(call) } }
}
