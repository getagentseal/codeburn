import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("CLI watchdog")
struct CLIWatchdogTests {
    @Test("silence is measured from the last output, not from the start")
    func silenceIsMeasuredFromLastOutput() {
        // Ten minutes in, still chattering every second: not silent.
        let verdict = CLIWatchdog.verdict(now: 600, startedAt: 0, lastOutputAt: 599, silenceSeconds: 45)
        #expect(verdict == .wait)
    }

    @Test("a mute child is killed after the silence window")
    func muteChildIsKilled() {
        #expect(CLIWatchdog.verdict(now: 44, startedAt: 0, lastOutputAt: 0, silenceSeconds: 45) == .wait)
        #expect(CLIWatchdog.verdict(now: 45, startedAt: 0, lastOutputAt: 0, silenceSeconds: 45) == .silent)
    }

    /// The cold floor must not become a licence to live forever: a child that
    /// never emits a byte is still killed, it just gets the cold budget first.
    @Test("the cold floor still ends in a kill for a child that never speaks")
    func coldFloorStillEndsInAKill() {
        let window = CLIWatchdog.silenceWindow(warm: false)
        #expect(window == CLIWatchdog.coldSilenceSeconds)
        #expect(CLIWatchdog.verdict(now: window - 1, startedAt: 0, lastOutputAt: 0, silenceSeconds: window) == .wait)
        #expect(CLIWatchdog.verdict(now: window, startedAt: 0, lastOutputAt: 0, silenceSeconds: window) == .silent)
    }

    @Test("a child that chatters forever is still reaped at the ceiling")
    func chatteringChildHitsTheCeiling() {
        let now = CLIWatchdog.ceilingSeconds + 1
        #expect(CLIWatchdog.verdict(now: now, startedAt: 0, lastOutputAt: now - 1, silenceSeconds: 45) == .ceiling)
    }

    @Test("a warm request uses the short silence window")
    func warmRequestUsesShortWindow() {
        #expect(CLIWatchdog.silenceWindow(warm: true) == CLIWatchdog.silenceSeconds)
        #expect(CLIWatchdog.silenceSeconds < CLIWatchdog.coldSilenceSeconds)
        #expect(CLIWatchdog.coldSilenceSeconds < CLIWatchdog.ceilingSeconds)
    }

    @Test("progress heartbeats never become the error message")
    func progressLinesAreStrippedFromStderr() {
        let stderr = """
        CODEBURN_PROGRESS {"kind":"keepalive"}
        warn: something real
        CODEBURN_PROGRESS {"kind":"tick"}
        """
        #expect(CLIWatchdog.withoutProgressLines(stderr) == "warn: something real")
        #expect(CLIWatchdog.withoutProgressLines("CODEBURN_PROGRESS {\"kind\":\"keepalive\"}") == "")
    }

    @Test("spawn env enables the CLI keepalive the watchdog listens for")
    func spawnEnvEnablesKeepalive() {
        let env = CLIWatchdog.withProgressHeartbeat(["PATH": "/usr/bin"])
        #expect(env["CODEBURN_PROGRESS"] == "1")
        #expect(env["PATH"] == "/usr/bin")
    }

    @Test("orphan reap only signals the exact recorded serve command")
    func orphanReapMatchesExactCommand() {
        // A shebang exec rewrites argv[0], so the recorded argv matches as a suffix.
        #expect(ServeOrphanReaper.serveCommandMatches(
            recorded: "/opt/homebrew/bin/codeburn serve --stdio",
            observed: "node /opt/homebrew/bin/codeburn serve --stdio"
        ))
        // A recycled pid running something else is never signalled.
        #expect(!ServeOrphanReaper.serveCommandMatches(
            recorded: "/opt/homebrew/bin/codeburn serve --stdio",
            observed: "node /opt/homebrew/bin/codeburn status"
        ))
        #expect(!ServeOrphanReaper.serveCommandMatches(
            recorded: "/opt/homebrew/bin/codeburn serve --stdio",
            observed: nil
        ))
        #expect(!ServeOrphanReaper.serveCommandMatches(recorded: "", observed: "anything"))
    }

    @Test("a pid record left by something other than a serve child is never signalled")
    func orphanReapIgnoresNonServeRecord() throws {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("serve-reap-" + UUID().uuidString)
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/sleep")
        child.arguments = ["5"]
        try child.run()
        defer { if child.isRunning { child.terminate() } }

        // The recorded argv matches this pid exactly, so only the serve suffix
        // check stands between a test fixture's record and a stray SIGTERM.
        ServeOrphanReaper.record(at: url, pid: child.processIdentifier, command: "/bin/sleep 5")
        ServeOrphanReaper.reap(at: url)

        Thread.sleep(forTimeInterval: 0.2)
        #expect(child.isRunning)
        #expect(!FileManager.default.fileExists(atPath: url.path))
    }
}
