import AppKit
import Foundation

/// Runs commands in the user's Terminal. Every string that reaches AppleScript `do script`
/// must be whitespace-joined argv where each token passes `CodeburnCLI.isSafe` (regex allowlist
/// that excludes shell metacharacters), OR a hardcoded literal defined here. The private
/// `runInTerminal` re-validates any non-literal input defensively so a future caller can't
/// bypass the invariant.
/// Falls back to a detached headless spawn on machines without Terminal.app (iTerm/Ghostty/Warp
/// users) so the subcommand still runs.
enum TerminalLauncher {
    private static let terminalPaths = [
        "/System/Applications/Utilities/Terminal.app",
        "/Applications/Utilities/Terminal.app",
    ]

    static func open(subcommand: [String]) {
        let argv = CodeburnCLI.baseArgv() + subcommand
        guard argv.allSatisfy(CodeburnCLI.isSafe) else {
            NSLog("CodeBurn: refusing to open terminal with unsafe argv")
            return
        }
        let command = argv.joined(separator: " ")

        if terminalPaths.contains(where: FileManager.default.fileExists(atPath:)) {
            runInTerminal(command: command, preValidated: true)
            return
        }

        let headless = CodeburnCLI.makeProcess(subcommand: subcommand)
        try? headless.run()
    }

    /// Launches `claude login` in Terminal.app so the user can complete the OAuth flow
    /// without leaving CodeBurn. The command is a hardcoded literal -- no user input is
    /// interpolated, so there's no injection surface.
    static func openClaudeLogin() -> Bool {
        guard terminalPaths.contains(where: FileManager.default.fileExists(atPath:)) else {
            NSLog("CodeBurn: Terminal.app not present; user must run `claude login` manually")
            return false
        }
        runInTerminal(command: "claude login", preValidated: true)
        return true
    }

    private static func runInTerminal(command: String, preValidated: Bool) {
        if !preValidated {
            let tokens = command.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
            guard tokens.allSatisfy(CodeburnCLI.isSafe) else {
                NSLog("CodeBurn: refusing to run unvalidated command in Terminal")
                return
            }
        }
        let script = """
        tell application "Terminal"
            activate
            do script "\(command)"
        end tell
        """
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", script]
        try? process.run()
    }
}
