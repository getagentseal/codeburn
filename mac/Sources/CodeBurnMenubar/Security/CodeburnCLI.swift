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

    private static let userNodePaths: [String] = {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        var paths: [String] = []
        for dir in ["\(home)/.volta/bin", "\(home)/.npm-global/bin", "\(home)/.asdf/shims"] {
            paths.append(dir)
        }
        let nvmDir = ProcessInfo.processInfo.environment["NVM_DIR"] ?? "\(home)/.nvm"
        let versionsDir = "\(nvmDir)/versions/node"
        if let entries = try? FileManager.default.contentsOfDirectory(atPath: versionsDir) {
            for entry in entries.sorted().reversed() {
                let bin = "\(versionsDir)/\(entry)/bin"
                if FileManager.default.isExecutableFile(atPath: "\(bin)/codeburn") {
                    paths.append(bin)
                    break
                }
            }
        }
        return paths
    }()
    private static let persistedPathFilename = "codeburn-cli-path.v1"

    /// Returns the argv that launches the CLI. Dev override via `CODEBURN_BIN` is honoured only
    /// if every whitespace-delimited token passes `safeArgPattern`. Otherwise falls back to the
    /// plain `codeburn` name (resolved via PATH).
    static func baseArgv() -> [String] {
        if ProcessInfo.processInfo.environment["CODEBURN_ALLOW_DEV_BIN"] == "1",
           let raw = ProcessInfo.processInfo.environment["CODEBURN_BIN"],
           !raw.isEmpty
        {
            let parts = raw.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
            guard parts.allSatisfy(isSafe) else {
                NSLog("CodeBurn: refusing unsafe CODEBURN_BIN; using installed codeburn")
                return installedArgv()
            }
            return parts
        }

        return installedArgv()
    }

    private static func installedArgv() -> [String] {
        if let persisted = persistedCLIPath(), isSafe(persisted), FileManager.default.isExecutableFile(atPath: persisted) {
            return [persisted]
        }
        for candidate in (additionalPathEntries + userNodePaths).map({ "\($0)/codeburn" }) {
            if isSafe(candidate), FileManager.default.isExecutableFile(atPath: candidate) {
                return [candidate]
            }
        }
        return ["codeburn"]
    }

    private static func persistedCLIPath() -> String? {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        let url = support
            .appendingPathComponent("CodeBurn", isDirectory: true)
            .appendingPathComponent(persistedPathFilename)
        guard let value = try? String(contentsOf: url, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty,
              value.hasPrefix("/")
        else { return nil }
        return value
    }

    /// Builds a `Process` that runs the CLI with the given subcommand args. Uses `/usr/bin/env`
    /// so PATH lookup happens without involving a shell, and augments PATH with Homebrew
    /// defaults. Caller sets stdout/stderr pipes and calls `run()`.
    static func makeProcess(
        subcommand: [String],
        qualityOfService: QualityOfService = .userInitiated
    ) -> Process {
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
        // user-interactive terminal, which starves the 30s refresh cadence on large corpora.
        process.qualityOfService = qualityOfService
        return process
    }

    static func isSafe(_ s: String) -> Bool {
        let range = NSRange(s.startIndex..<s.endIndex, in: s)
        return safeArgPattern.firstMatch(in: s, range: range) != nil
    }

    private static func augmentedPath(_ existing: String) -> String {
        var parts = existing.split(separator: ":", omittingEmptySubsequences: true).map(String.init)
        for extra in additionalPathEntries + userNodePaths where !parts.contains(extra) {
            parts.append(extra)
        }
        return parts.joined(separator: ":")
    }
}
