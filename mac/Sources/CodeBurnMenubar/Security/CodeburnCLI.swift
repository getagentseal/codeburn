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

    private static func userNodePaths(
        homeDirectory: String,
        environment: [String: String]
    ) -> [String] {
        let home = homeDirectory
        var paths: [String] = []
        for dir in ["\(home)/.volta/bin", "\(home)/.npm-global/bin", "\(home)/.local/bin", "\(home)/.asdf/shims"] {
            paths.append(dir)
        }
        // `mise use -g npm:codeburn` installs the CLI under its npm backend, but
        // that wrapper still resolves `node` through PATH. Apps opened by
        // Spotlight inherit only the system PATH, so include mise's stable shim
        // directory (the same integration its official docs prescribe for
        // non-interactive environments). Respect a custom data directory when
        // it is available to the GUI process; otherwise use mise's macOS default.
        let miseDataDir = environment["MISE_DATA_DIR"] ?? "\(home)/.local/share/mise"
        paths.append("\(miseDataDir)/shims")

        let nvmDir = environment["NVM_DIR"] ?? "\(home)/.nvm"
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
        paths.append(contentsOf: nixPaths(homeDirectory: home))
        return paths
    }

    /// Nix keeps Node outside every location above. nix-darwin exposes the per-user profile at
    /// `/etc/profiles/per-user/$USER/bin` and the system profile at `/run/current-system/sw/bin`;
    /// standalone `nix profile` uses `~/.nix-profile/bin`, which on the XDG state layout resolves
    /// through `~/.local/state/nix/profiles/profile/bin`.
    ///
    /// These matter because a macOS system update clears `launchctl config user path`, the only
    /// mechanism that put those directories on a GUI-launched app's PATH. After the update the
    /// app inherits the bare `/usr/bin:/bin:/usr/sbin:/sbin`, so the CLI's `#!/usr/bin/env node`
    /// shim can no longer resolve `node` and every spawn dies with exit 127. Naming the
    /// directories here keeps the app working without any machine-level launchd configuration.
    private static func nixPaths(homeDirectory: String) -> [String] {
        var paths: [String] = []
        let user = (homeDirectory as NSString).lastPathComponent
        if !user.isEmpty {
            paths.append("/etc/profiles/per-user/\(user)/bin")
        }
        paths.append(contentsOf: [
            "\(homeDirectory)/.nix-profile/bin",
            "\(homeDirectory)/.local/state/nix/profiles/profile/bin",
            "/run/current-system/sw/bin",
            "/nix/var/nix/profiles/default/bin",
        ])
        return paths
    }
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
        [installedCLI().path ?? "codeburn"]
    }

    static func installedCLI() -> (path: String?, tried: [String]) {
        resolveInstalledCLI(
            recorded: persistedCLIPath(),
            homeDirectory: FileManager.default.homeDirectoryForCurrentUser.path,
            environment: ProcessInfo.processInfo.environment,
            isExecutable: FileManager.default.isExecutableFile(atPath:)
        )
    }

    /// The launcher a packaged desktop app carries inside its bundle (app/scripts/after-pack.cjs).
    private static let desktopAppCLI = "CodeBurn.app/Contents/Resources/cli/codeburn"

    /// The recorded path first (the desktop app or `codeburn menubar` wrote it), then the
    /// package-manager directories a GUI launch's PATH misses, then the CLI inside a CodeBurn
    /// desktop app, which is the only one a desktop-only install has. Returns the first that
    /// runs, and every path checked so a failure can name them.
    static func resolveInstalledCLI(
        recorded: String?,
        homeDirectory: String,
        environment: [String: String],
        isExecutable: (String) -> Bool
    ) -> (path: String?, tried: [String]) {
        let directories = additionalPathEntries + userNodePaths(homeDirectory: homeDirectory, environment: environment)
        var candidates: [String] = recorded.map { [$0] } ?? []
        candidates += directories.map { "\($0)/codeburn" }
        candidates += ["/Applications", "\(homeDirectory)/Applications"].map { "\($0)/\(desktopAppCLI)" }
        var tried: [String] = []
        for candidate in candidates where !tried.contains(candidate) {
            tried.append(candidate)
            if isSafe(candidate), isExecutable(candidate) { return (candidate, tried) }
        }
        return (nil, tried)
    }

    /// `env: codeburn: No such file or directory` is what the bare-name fallback says when
    /// nothing was found; this names every path that was checked instead.
    static func explainedFailure(code: Int32, stderr: String, tried: () -> [String] = { CodeburnCLI.installedCLI().tried }) -> String {
        guard code == 127, stderr.contains("env: codeburn: No such file or directory") else { return stderr }
        return "No CodeBurn CLI found: nothing on PATH, and no CodeBurn desktop app to borrow one from. "
            + "Tried: \(tried().joined(separator: ", ")). Install the desktop app, or run `npm install -g codeburn`."
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
    /// so PATH lookup happens without involving a shell, and augments PATH with common package
    /// manager locations. Caller sets stdout/stderr pipes and calls `run()`.
    static func makeProcess(
        subcommand: [String],
        qualityOfService: QualityOfService = .userInitiated
    ) -> Process {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        // Resolved once so the PATH we build and the argv we run can never disagree
        // about which install of the CLI this launch is talking about.
        let argv = baseArgv()
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = augmentedPath(
            environment["PATH"] ?? "",
            homeDirectory: FileManager.default.homeDirectoryForCurrentUser.path,
            environment: environment,
            resolvedCLI: argv.first
        )
        process.environment = environment
        // `env --` treats everything following as argv, not VAR=val pairs -- guards against an
        // argument accidentally resembling an env assignment.
        process.arguments = ["--"] + argv + subcommand
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

    /// `resolvedCLI` defaults to the CLI this app would actually launch; tests pass
    /// a fixture path so PATH ordering can be asserted without a real install.
    static func augmentedPath(
        _ existing: String,
        homeDirectory: String,
        environment: [String: String],
        resolvedCLI: String? = nil
    ) -> String {
        var parts = existing.split(separator: ":", omittingEmptySubsequences: true).map(String.init)
        // The CLI's shebang resolves `node` through PATH, so whichever node comes
        // first wins — and a version manager's default can easily be older than
        // the 22.13 the CLI requires, which surfaces as "Could not load Today"
        // rather than anything pointing at Node. The interpreter that sits beside
        // the CLI we are about to run is known to satisfy it, so it goes first.
        if let cli = resolvedCLI ?? baseArgv().first, cli.hasPrefix("/") {
            let binDir = (cli as NSString).deletingLastPathComponent
            if FileManager.default.isExecutableFile(atPath: "\(binDir)/node") {
                parts.removeAll { $0 == binDir }
                parts.insert(binDir, at: 0)
            }
        }
        let userPaths = userNodePaths(homeDirectory: homeDirectory, environment: environment)
        for extra in additionalPathEntries + userPaths where !parts.contains(extra) {
            parts.append(extra)
        }
        return parts.joined(separator: ":")
    }
}
