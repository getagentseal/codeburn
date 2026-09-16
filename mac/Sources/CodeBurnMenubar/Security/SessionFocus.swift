import AppKit
import Darwin
import Foundation

/// Where a live-session row points: the application that owns the agent's
/// process, plus the tty of the shell it runs in when the terminal can name a
/// tab by it.
struct SessionFocusTarget: Equatable, Sendable {
    let appPID: pid_t
    let bundleID: String
    let appName: String
    let tty: String?

    /// Terminal.app and iTerm2 can raise the exact tab; every other terminal
    /// only gets the app, and the tooltip promises no more than that.
    var selectsTab: Bool { SessionTabScript.script(bundleID: bundleID, tty: tty) != nil }

    var tooltip: String {
        selectsTab ? L("Open in %@", appName) : L("Bring %@ to front", appName)
    }
}

/// One process as the ancestry walk sees it.
struct SessionProcess: Equatable, Sendable {
    let ppid: pid_t
    let tty: String?
    /// Set only when macOS knows this pid as a running application, which is
    /// what makes an ancestor the terminal rather than another shell.
    let bundleID: String?
    let appName: String?
}

/// Raises the terminal a live session is running in.
///
/// A session row knows a session id, not a window: neither Claude Code nor Kimi
/// publishes one. What it can be given is a pid — Claude writes its own into
/// `~/.claude/sessions/<pid>.json`, Kimi is found by the working directory its
/// state file records — and a pid has a parent, and somewhere up that chain is
/// the terminal application. So the app is found by walking the process tree,
/// and the tab inside it by the tty the shell holds.
enum SessionFocus {
    /// A pid whose start time disagrees with the session file by more than this
    /// has been recycled and belongs to something else. Wide enough to absorb
    /// the gap between the process starting and the file being written.
    static let pidReuseTolerance: TimeInterval = 5 * 60

    // MARK: - Pure core

    /// Walks from the agent's process up to the application that owns it,
    /// keeping the first tty seen on the way — the shell the agent talks to.
    ///
    /// Bounded rather than looped to pid 1: a `kinfo_proc` naming itself as its
    /// own parent would otherwise spin, and no real agent-to-terminal chain is
    /// more than a handful deep. launchd ends the walk with nothing, which is
    /// the honest answer for an agent started outside a terminal.
    static func owner(
        of pid: pid_t,
        hops: Int = 8,
        lookup: (pid_t) -> SessionProcess?
    ) -> SessionFocusTarget? {
        var current = pid
        var tty: String?
        for _ in 0..<hops {
            guard current > 1, let process = lookup(current) else { return nil }
            if tty == nil { tty = process.tty }
            if let bundleID = process.bundleID {
                return SessionFocusTarget(
                    appPID: current,
                    bundleID: bundleID,
                    appName: process.appName ?? bundleID,
                    tty: tty
                )
            }
            guard process.ppid != current else { return nil }
            current = process.ppid
        }
        return nil
    }

    /// The pid running `sessionID`, or nil when no file claims it, the process
    /// is gone, or the pid has since been handed to something unrelated.
    static func pid(
        forSessionID sessionID: String,
        files: [ClaudeSessionFile],
        startTime: (pid_t) -> Date?
    ) -> pid_t? {
        // Claude Code writes a fresh `<pid>.json` on every resume and never
        // removes the old one, so several files can name this session and only
        // the newest of them names the process that is still running.
        guard let file = files.filter({ $0.sessionId == sessionID }).max(by: { $0.startedAt < $1.startedAt }),
              let started = startTime(file.pid),
              abs(started.timeIntervalSince1970 - file.startedAt / 1000) < pidReuseTolerance
        else { return nil }
        return file.pid
    }

    /// The one candidate working in `cwd`. Two agents in the same directory are
    /// treated as not found: raising the wrong window is worse than doing nothing.
    static func pid(forWorkingDirectory cwd: String, candidates: [(pid: pid_t, cwd: String)]) -> pid_t? {
        let matches = candidates.filter { $0.cwd == cwd }
        return matches.count == 1 ? matches[0].pid : nil
    }

    // MARK: - Resolving a row

    /// Where this row points, or nil when its process cannot be found — which
    /// leaves the row inert rather than promising a window that is not there.
    /// Reads files and walks the process tree, so callers keep it off the main
    /// actor.
    static func target(for session: LiveSession) -> SessionFocusTarget? {
        guard let pid = sessionPID(for: session) else { return nil }
        return owner(of: pid, lookup: process(of:))
    }

    /// Selects the session's tab where the terminal allows it, then raises the
    /// owning application either way. The script is a subprocess, so it runs off
    /// the main actor with a hard cap on how long it may take.
    @MainActor
    static func raise(_ target: SessionFocusTarget) {
        let app = NSRunningApplication(processIdentifier: target.appPID)
        let script = SessionTabScript.script(bundleID: target.bundleID, tty: target.tty)
        DispatchQueue.global(qos: .userInitiated).async {
            if let script { runScript(script) }
            DispatchQueue.main.async { app?.activate() }
        }
    }

    private static func sessionPID(for session: LiveSession) -> pid_t? {
        switch session.provider {
        case "claude":
            return pid(forSessionID: session.id, files: claudeSessionFiles(), startTime: startTime(of:))
        case "kimicode":
            guard let cwd = kimiWorkingDirectory(sessionID: session.id) else { return nil }
            return pid(forWorkingDirectory: resolved(cwd), candidates: kimiProcesses())
        default:
            return nil
        }
    }

    // MARK: - Claude

    /// Every `<config dir>/sessions/<pid>.json` Claude Code has written. The
    /// directory also holds `.key` files, which are not sessions.
    private static func claudeSessionFiles() -> [ClaudeSessionFile] {
        let decoder = JSONDecoder()
        let directories = UsageDataChangeGuard.claudeConfigDirectories(
            environment: ProcessInfo.processInfo.environment,
            homeDirectory: NSHomeDirectory()
        )
        return directories.flatMap { configDir -> [ClaudeSessionFile] in
            let directory = URL(fileURLWithPath: configDir).appendingPathComponent("sessions")
            let entries = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
            return entries.filter { $0.hasSuffix(".json") }.compactMap { entry in
                guard let data = try? Data(contentsOf: directory.appendingPathComponent(entry)) else { return nil }
                return try? decoder.decode(ClaudeSessionFile.self, from: data)
            }
        }
    }

    // MARK: - Kimi Code

    /// Kimi keeps `<home>/sessions/<wd_…>/session_<id>/state.json`, and the row's
    /// id is that directory's suffix. Nothing on disk names the pid, so this only
    /// recovers the directory the agent is working in.
    static func kimiWorkingDirectory(
        sessionID: String,
        home: String = ProcessInfo.processInfo.environment["KIMI_CODE_HOME"]
            ?? NSHomeDirectory() + "/.kimi-code"
    ) -> String? {
        let sessions = URL(fileURLWithPath: home).appendingPathComponent("sessions")
        let workDirs = (try? FileManager.default.contentsOfDirectory(atPath: sessions.path)) ?? []
        for workDir in workDirs {
            let state = sessions
                .appendingPathComponent(workDir)
                .appendingPathComponent("session_" + sessionID)
                .appendingPathComponent("state.json")
            guard let data = try? Data(contentsOf: state),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { continue }
            if let cwd = object["cwd"] as? String, !cwd.isEmpty { return cwd }
            if let workDir = object["workDir"] as? String, !workDir.isEmpty { return workDir }
        }
        return nil
    }

    /// Running `kimi` processes with the directory each is working in. The name
    /// comes from `p_comm`, which is the executable's, so a shell function or an
    /// alias named `kimi` is not mistaken for one.
    private static func kimiProcesses() -> [(pid: pid_t, cwd: String)] {
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0]
        var size = 0
        guard sysctl(&mib, u_int(mib.count), nil, &size, nil, 0) == 0, size > 0 else { return [] }
        var table = [kinfo_proc](repeating: kinfo_proc(), count: size / MemoryLayout<kinfo_proc>.stride)
        guard sysctl(&mib, u_int(mib.count), &table, &size, nil, 0) == 0 else { return [] }
        return table.prefix(size / MemoryLayout<kinfo_proc>.stride).compactMap { entry in
            var proc = entry
            let width = MemoryLayout.size(ofValue: proc.kp_proc.p_comm)
            let name = withUnsafePointer(to: &proc.kp_proc.p_comm) { pointer in
                pointer.withMemoryRebound(to: CChar.self, capacity: width) { String(cString: $0) }
            }
            guard name == "kimi", let cwd = workingDirectory(of: proc.kp_proc.p_pid) else { return nil }
            return (proc.kp_proc.p_pid, resolved(cwd))
        }
    }

    /// The kernel reports `/private/var/…` where the user's path says `/var/…`,
    /// and either side can carry a symlink, so both are compared resolved.
    private static func resolved(_ path: String) -> String {
        URL(fileURLWithPath: path).resolvingSymlinksInPath().path
    }

    // MARK: - Reading the process table

    private static func process(of pid: pid_t) -> SessionProcess? {
        guard let info = kernelProcess(pid) else { return nil }
        var tty: String?
        // NODEV (-1) means no controlling terminal; devname would read it as a
        // real device number and answer garbage.
        if info.kp_eproc.e_tdev != -1, let name = devname(info.kp_eproc.e_tdev, S_IFCHR) {
            tty = String(cString: name)
        }
        let app = NSRunningApplication(processIdentifier: pid)
        return SessionProcess(
            ppid: info.kp_eproc.e_ppid,
            tty: tty,
            bundleID: app?.bundleIdentifier,
            appName: app?.localizedName
        )
    }

    static func startTime(of pid: pid_t) -> Date? {
        guard let info = kernelProcess(pid) else { return nil }
        let started = info.kp_proc.p_starttime
        return Date(timeIntervalSince1970: Double(started.tv_sec) + Double(started.tv_usec) / 1_000_000)
    }

    private static func kernelProcess(_ pid: pid_t) -> kinfo_proc? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0, size > 0 else { return nil }
        return info
    }

    private static func workingDirectory(of pid: pid_t) -> String? {
        var info = proc_vnodepathinfo()
        let read = proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &info, Int32(MemoryLayout<proc_vnodepathinfo>.size))
        guard read == Int32(MemoryLayout<proc_vnodepathinfo>.size) else { return nil }
        return withUnsafePointer(to: &info.pvi_cdir.vip_path) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: Int(MAXPATHLEN)) { String(cString: $0) }
        }
    }

    // MARK: - Running the script

    /// Detached with a hard cap: a terminal wedged on its own AppleScript must
    /// not keep a worker alive, and the caller has already returned either way.
    private static func runScript(_ script: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", script]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        let finished = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in finished.signal() }
        do {
            try process.run()
        } catch {
            NSLog("CodeBurn: could not spawn osascript to focus a session: \(error.localizedDescription)")
            return
        }
        if finished.wait(timeout: .now() + 3) == .timedOut {
            NSLog("CodeBurn: osascript did not select the session's tab in 3s; terminating it")
            process.terminate()
        }
    }
}

/// One `~/.claude/sessions/<pid>.json`. Claude Code writes far more than this;
/// only the three fields that identify the running process are read.
struct ClaudeSessionFile: Decodable, Equatable, Sendable {
    let pid: pid_t
    let sessionId: String
    /// Epoch milliseconds, used only to notice a recycled pid.
    let startedAt: Double
}

/// AppleScript that selects the tab holding a tty.
///
/// There is no general mechanism: Terminal.app and iTerm2 both expose a tty per
/// tab, and everything else (Warp, Ghostty, WezTerm, kitty) publishes nothing to
/// match on, so those fall back to raising the application.
enum SessionTabScript {
    static func script(bundleID: String, tty: String?) -> String? {
        // The tty comes from the kernel, but it is interpolated into a script,
        // so it is held to the shape `devname` produces rather than trusted.
        guard let tty, !tty.isEmpty,
              tty.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) })
        else { return nil }
        switch bundleID {
        case "com.apple.Terminal":
            return """
            tell application "Terminal"
              repeat with w in windows
                repeat with t in tabs of w
                  if tty of t is "/dev/\(tty)" then
                    set selected of t to true
                    set index of w to 1
                    return
                  end if
                end repeat
              end repeat
            end tell
            """
        case "com.googlecode.iterm2":
            // "iTerm", not "iTerm2", for the reason PreferredTerminal records:
            // the bundle is iTerm.app, and that name resolves whether or not
            // the app's terminology has loaded.
            return """
            tell application "iTerm"
              repeat with w in windows
                repeat with t in tabs of w
                  repeat with s in sessions of t
                    if tty of s is "/dev/\(tty)" then
                      select s
                      select t
                      select w
                      return
                    end if
                  end repeat
                end repeat
              end repeat
            end tell
            """
        default:
            return nil
        }
    }
}
