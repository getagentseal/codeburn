import Foundation

/// Single entry point for spawning the `codeburn` CLI. All callers route through here so the
/// binary argv is validated once and no code path ever passes user-influenced strings through
/// a shell (`/bin/zsh -c`, `open --args`, AppleScript). This closes the shell-injection attack
/// surface end-to-end.
enum CodeburnCLI {
    /// Matches a plain file path / program name: alphanumerics, dot, underscore, slash, hyphen,
    /// space. Deliberately excludes shell metacharacters (`$`, `;`, `&`, `|`, quotes, backticks,
    /// newlines) so a malicious `CODEBURN_BIN="codeburn; rm -rf ~"` can't slip through.
    private static let safeArgPattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9 ._/\\-]+$")

    /// PATH additions for GUI-launched apps, which otherwise get a minimal PATH that misses
    /// Homebrew and npm global installs.
    private static let additionalPathEntries = ["/opt/homebrew/bin", "/usr/local/bin"]

    /// Returns the argv that launches the CLI. Dev override via `CODEBURN_BIN` is honoured only
    /// if every whitespace-delimited token passes `safeArgPattern`. Otherwise falls back to the
    /// plain `codeburn` name (resolved via PATH).
    static func baseArgv() -> [String] {
        guard let raw = ProcessInfo.processInfo.environment["CODEBURN_BIN"], !raw.isEmpty else {
            return ["codeburn"]
        }
        let parts = raw.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
        guard parts.allSatisfy(isSafe) else {
            NSLog("CodeBurn: refusing unsafe CODEBURN_BIN; using default 'codeburn'")
            return ["codeburn"]
        }
        return parts
    }

    /// Builds a `Process` that runs the CLI with the given subcommand args. Uses `/usr/bin/env`
    /// so PATH lookup happens without involving a shell, and augments PATH with Homebrew
    /// defaults. Caller sets stdout/stderr pipes and calls `run()`.
    static func makeProcess(subcommand: [String]) -> Process {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = augmentedPath(environment["PATH"] ?? "")
        process.environment = environment
        // `env --` treats everything following as argv, not VAR=val pairs -- guards against an
        // argument accidentally resembling an env assignment.
        process.arguments = ["--"] + baseArgv() + subcommand
        // The menubar runs as an accessory app with no foreground window, and macOS
        // background-throttles accessory apps and their children. Without this lift the
        // codeburn subprocess parses 5-10x slower than the same command run from a
        // user-interactive terminal, which starves the 15s refresh cadence on large corpora.
        process.qualityOfService = .userInitiated
        return process
    }

    static func isSafe(_ s: String) -> Bool {
        let range = NSRange(s.startIndex..<s.endIndex, in: s)
        return safeArgPattern.firstMatch(in: s, range: range) != nil
    }

    private static func augmentedPath(_ existing: String) -> String {
        var parts = existing.split(separator: ":", omittingEmptySubsequences: true).map(String.init)
        for extra in additionalPathEntries where !parts.contains(extra) {
            parts.append(extra)
        }
        for dir in discoverNodeManagerBinDirs() where !parts.contains(dir) {
            parts.append(dir)
        }
        return parts.joined(separator: ":")
    }

    /// Login-item launches don't source .zshrc, so nvm / fnm / volta / asdf bin
    /// directories are absent from PATH. Scan common version-manager locations
    /// and add the latest Node version's bin dir so `codeburn` can be found.
    private static func discoverNodeManagerBinDirs() -> [String] {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let fm = FileManager.default

        // fnm: ~/.local/share/fnm/node-versions/<version>/installation/bin
        let fnmVersionsDir = "\(home)/.local/share/fnm/node-versions"
        if let latest = latestVersionDir(in: fnmVersionsDir) {
            let binDir = "\(fnmVersionsDir)/\(latest)/installation/bin"
            if fm.fileExists(atPath: "\(binDir)/node") {
                return [binDir]
            }
        }

        // nvm: ~/.nvm/versions/node/<version>/bin
        let nvmVersionsDir = "\(home)/.nvm/versions/node"
        if let latest = latestVersionDir(in: nvmVersionsDir) {
            let binDir = "\(nvmVersionsDir)/\(latest)/bin"
            if fm.fileExists(atPath: "\(binDir)/node") {
                return [binDir]
            }
        }

        // volta: ~/.volta/bin (flat, no version dirs)
        let voltaBin = "\(home)/.volta/bin"
        if fm.fileExists(atPath: "\(voltaBin)/node") {
            return [voltaBin]
        }

        // asdf: ~/.asdf/shims (flat shim dir)
        let asdfShims = "\(home)/.asdf/shims"
        if fm.fileExists(atPath: "\(asdfShims)/node") {
            return [asdfShims]
        }

        return []
    }

    /// Returns the latest version directory name (e.g. "v22.15.0") from a
    /// parent directory containing version-named subdirectories.
    private static func latestVersionDir(in parent: String) -> String? {
        let fm = FileManager.default
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: parent, isDirectory: &isDir), isDir.boolValue,
              let entries = try? fm.contentsOfDirectory(atPath: parent) else {
            return nil
        }
        return entries
            .filter { $0.hasPrefix("v") }
            .sorted()
            .last
    }
}
