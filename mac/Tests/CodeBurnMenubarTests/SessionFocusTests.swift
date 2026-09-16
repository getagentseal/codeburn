import Foundation
import Testing
@testable import CodeBurnMenubar

/// The parts of "raise the terminal this session runs in" that can be decided
/// without a process table: the ancestry walk, the tab script, and the two
/// matchers that turn a session row into a pid.
@Suite("Session focus")
struct SessionFocusTests {

    /// A table of processes standing in for the kernel's.
    static func lookup(_ table: [pid_t: SessionProcess]) -> (pid_t) -> SessionProcess? {
        { table[$0] }
    }

    static func shell(ppid: pid_t, tty: String? = nil) -> SessionProcess {
        SessionProcess(ppid: ppid, tty: tty, bundleID: nil, appName: nil)
    }

    static func app(_ bundleID: String, _ name: String) -> SessionProcess {
        SessionProcess(ppid: 1, tty: nil, bundleID: bundleID, appName: name)
    }

    // MARK: - Walking to the owning app

    @Test("the first ancestor macOS knows as an application is the owner")
    func findsOwningApp() {
        let target = SessionFocus.owner(of: 500, lookup: Self.lookup([
            500: Self.shell(ppid: 400, tty: "ttys004"),
            400: Self.shell(ppid: 300),
            300: Self.app("com.apple.Terminal", "Terminal"),
        ]))
        #expect(target?.appPID == 300)
        #expect(target?.bundleID == "com.apple.Terminal")
        #expect(target?.appName == "Terminal")
        // The tty belongs to the shell, not to the app above it.
        #expect(target?.tty == "ttys004")
    }

    @Test("a chain that reaches launchd owns nothing")
    func stopsAtLaunchd() {
        let target = SessionFocus.owner(of: 500, lookup: Self.lookup([
            500: Self.shell(ppid: 1, tty: "ttys004"),
            1: Self.shell(ppid: 0),
        ]))
        #expect(target == nil)
    }

    @Test("the walk gives up after eight hops rather than following a long chain")
    func stopsAfterEightHops() {
        var table: [pid_t: SessionProcess] = [:]
        for pid in pid_t(100)...pid_t(120) { table[pid] = Self.shell(ppid: pid + 1) }
        table[121] = Self.app("com.apple.Terminal", "Terminal")
        #expect(SessionFocus.owner(of: 100, lookup: Self.lookup(table)) == nil)
        #expect(SessionFocus.owner(of: 100, hops: 30, lookup: Self.lookup(table))?.appPID == 121)
    }

    @Test("a process that names itself as its own parent does not loop")
    func survivesSelfParent() {
        let target = SessionFocus.owner(of: 500, lookup: Self.lookup([500: Self.shell(ppid: 500)]))
        #expect(target == nil)
    }

    @Test("an app that is not a known terminal still owns the session")
    func ownsAnyAppBundle() {
        let target = SessionFocus.owner(of: 500, lookup: Self.lookup([
            500: Self.shell(ppid: 300, tty: "ttys004"),
            300: Self.app("dev.warp.Warp-Stable", "Warp"),
        ]))
        #expect(target?.appName == "Warp")
        // Warp publishes no tab to select, so the row promises only a raise.
        #expect(target?.selectsTab == false)
        #expect(target?.tooltip == "Bring Warp to front")
    }

    // MARK: - The tab script

    @Test("Terminal.app and iTerm2 select the tab holding the tty")
    func buildsTabScripts() throws {
        let terminal = try #require(SessionTabScript.script(bundleID: "com.apple.Terminal", tty: "ttys004"))
        #expect(terminal.contains("tell application \"Terminal\""))
        #expect(terminal.contains("if tty of t is \"/dev/ttys004\""))

        let iterm = try #require(SessionTabScript.script(bundleID: "com.googlecode.iterm2", tty: "ttys012"))
        #expect(iterm.contains("tell application \"iTerm\""))
        #expect(iterm.contains("if tty of s is \"/dev/ttys012\""))
        #expect(iterm.contains("sessions of t"))
    }

    @Test("a terminal with no tab to name, or a session with no tty, gets no script")
    func refusesWhatItCannotSelect() {
        #expect(SessionTabScript.script(bundleID: "dev.warp.Warp-Stable", tty: "ttys004") == nil)
        #expect(SessionTabScript.script(bundleID: "com.apple.Terminal", tty: nil) == nil)
        #expect(SessionTabScript.script(bundleID: "com.apple.Terminal", tty: "") == nil)
    }

    @Test("a tty that is not the shape devname produces never reaches the script")
    func refusesUnshapedTTY() {
        for tty in ["ttys004\" or true or \"", "../../evil", "ttys 004"] {
            #expect(SessionTabScript.script(bundleID: "com.apple.Terminal", tty: tty) == nil)
        }
    }

    // MARK: - Claude: session id to pid

    static func file(pid: pid_t, id: String, startedAt: Date) -> ClaudeSessionFile {
        ClaudeSessionFile(pid: pid, sessionId: id, startedAt: startedAt.timeIntervalSince1970 * 1000)
    }

    @Test("the session file naming this id gives up its pid")
    func matchesSessionFile() {
        let started = Date(timeIntervalSince1970: 1_780_000_000)
        let files = [
            Self.file(pid: 111, id: "other", startedAt: started),
            Self.file(pid: 222, id: "wanted", startedAt: started),
        ]
        let pid = SessionFocus.pid(forSessionID: "wanted", files: files) { _ in started.addingTimeInterval(2) }
        #expect(pid == 222)
    }

    @Test("a resumed session keeps the newest of the files claiming its id")
    func prefersNewestSessionFile() {
        let older = Date(timeIntervalSince1970: 1_780_000_000)
        let newer = older.addingTimeInterval(3_600)
        let files = [
            Self.file(pid: 111, id: "wanted", startedAt: older),
            Self.file(pid: 222, id: "wanted", startedAt: newer),
        ]
        let pid = SessionFocus.pid(forSessionID: "wanted", files: files) { $0 == 111 ? older : newer }
        #expect(pid == 222)
    }

    @Test("a newest file that fails the guard is not answered with the stale one")
    func refusesStaleFileBehindARecycledNewest() {
        let older = Date(timeIntervalSince1970: 1_780_000_000)
        let newer = older.addingTimeInterval(3_600)
        let files = [
            Self.file(pid: 111, id: "wanted", startedAt: older),
            Self.file(pid: 222, id: "wanted", startedAt: newer),
        ]
        let recycled = newer.addingTimeInterval(SessionFocus.pidReuseTolerance + 1)
        let pid = SessionFocus.pid(forSessionID: "wanted", files: files) { $0 == 111 ? older : recycled }
        #expect(pid == nil)
    }

    @Test("a pid the kernel no longer knows is not a session")
    func rejectsDeadPID() {
        let files = [Self.file(pid: 222, id: "wanted", startedAt: Date(timeIntervalSince1970: 1_780_000_000))]
        #expect(SessionFocus.pid(forSessionID: "wanted", files: files) { _ in nil } == nil)
    }

    @Test("a pid handed to an unrelated process since the file was written is not a session")
    func rejectsRecycledPID() {
        let started = Date(timeIntervalSince1970: 1_780_000_000)
        let files = [Self.file(pid: 222, id: "wanted", startedAt: started)]
        let recycled = started.addingTimeInterval(SessionFocus.pidReuseTolerance + 1)
        #expect(SessionFocus.pid(forSessionID: "wanted", files: files) { _ in recycled } == nil)
    }

    @Test("a session no file claims is not found")
    func rejectsUnknownSession() {
        let files = [Self.file(pid: 222, id: "wanted", startedAt: Date())]
        #expect(SessionFocus.pid(forSessionID: "missing", files: files) { _ in Date() } == nil)
    }

    // MARK: - Kimi: working directory to pid

    @Test("the one kimi working in this directory is the session's")
    func matchesKimiByWorkingDirectory() {
        let pid = SessionFocus.pid(forWorkingDirectory: "/Users/x/Projects/app", candidates: [
            (pid: 10, cwd: "/Users/x/Projects/other"),
            (pid: 20, cwd: "/Users/x/Projects/app"),
        ])
        #expect(pid == 20)
    }

    @Test("two kimis in the same directory are an ambiguity, not a guess")
    func refusesAmbiguousKimi() {
        let pid = SessionFocus.pid(forWorkingDirectory: "/Users/x/Projects/app", candidates: [
            (pid: 10, cwd: "/Users/x/Projects/app"),
            (pid: 20, cwd: "/Users/x/Projects/app"),
        ])
        #expect(pid == nil)
    }

    @Test("no kimi in that directory is not found")
    func refusesMissingKimi() {
        let pid = SessionFocus.pid(forWorkingDirectory: "/Users/x/Projects/app", candidates: [
            (pid: 10, cwd: "/Users/x/Projects/other"),
        ])
        #expect(pid == nil)
    }
}
