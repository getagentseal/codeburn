import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("UpdateChecker")
struct UpdateCheckerTests {
    @Test("selects newest mac release with zip and checksum")
    func selectsNewestMacReleaseWithChecksum() {
        let releases = [
            GitHubRelease(
                tag_name: "v0.9.9",
                assets: [GitHubAsset(name: "codeburn-0.9.9.tgz", browser_download_url: "https://example.test/cli")]
            ),
            GitHubRelease(
                tag_name: "mac-v0.9.8",
                assets: [
                    GitHubAsset(name: "CodeBurnMenubar-v0.9.8.zip", browser_download_url: "https://example.test/app"),
                    GitHubAsset(name: "CodeBurnMenubar-v0.9.8.zip.sha256", browser_download_url: "https://example.test/app.sha256"),
                ]
            ),
        ]

        let resolved = UpdateChecker.resolveLatestMenubarRelease(in: releases)

        #expect(resolved?.release.tag_name == "mac-v0.9.8")
        #expect(resolved?.asset.name == "CodeBurnMenubar-v0.9.8.zip")
    }

    @Test("ignores mac release missing checksum")
    func ignoresMacReleaseMissingChecksum() {
        let releases = [
            GitHubRelease(
                tag_name: "mac-v0.9.8",
                assets: [GitHubAsset(name: "CodeBurnMenubar-v0.9.8.zip", browser_download_url: "https://example.test/app")]
            ),
        ]

        #expect(UpdateChecker.resolveLatestMenubarRelease(in: releases) == nil)
    }

    @Test("flags CLI older than the menubar-update fix as too old")
    func flagsCliBelowMinimumAsTooOld() {
        #expect(UpdateChecker.isCliTooOld(installed: "0.9.8"))
        #expect(UpdateChecker.isCliTooOld(installed: "v0.9.8"))
        #expect(UpdateChecker.isCliTooOld(installed: "0.8.12"))
    }

    @Test("accepts CLI at or above the menubar-update fix version")
    func acceptsCliAtOrAboveMinimum() {
        #expect(!UpdateChecker.isCliTooOld(installed: "0.9.9"))
        #expect(!UpdateChecker.isCliTooOld(installed: "0.9.10"))
        #expect(!UpdateChecker.isCliTooOld(installed: "0.9.14"))
        #expect(!UpdateChecker.isCliTooOld(installed: "1.0.0"))
    }

    @Test("does not flag when the CLI version is unknown")
    func ignoresUnknownCliVersion() {
        #expect(!UpdateChecker.isCliTooOld(installed: nil))
        #expect(!UpdateChecker.isCliTooOld(installed: ""))
    }
}

@Suite("Update failure presentation")
@MainActor
struct UpdateFailurePresentationTests {
    @Test("identifies an automatic update check failure")
    func updateCheckFailure() {
        let checker = UpdateChecker()
        checker.updateFailureStage = .check
        checker.updateError = "GitHub returned HTTP 403."

        #expect(checker.updateBadgeLabel == "Update Check Failed")
        #expect(checker.updateHelpText.contains("could not check for updates"))
        #expect(checker.updateHelpText.contains("GitHub returned HTTP 403."))
        #expect(checker.updateHelpText.contains("retry the update check"))
    }

    @Test("distinguishes CLI update failures")
    func cliUpdateFailure() {
        let checker = UpdateChecker()
        checker.updateFailureStage = .cliUpdate
        checker.updateError = "npm exited with status 1."

        #expect(checker.updateBadgeLabel == "CLI Update Failed")
        #expect(checker.updateHelpText.contains("could not update the CLI"))
        #expect(checker.updateHelpText.contains("npm exited with status 1."))
    }

    @Test("distinguishes menubar update failures")
    func menubarUpdateFailure() {
        let checker = UpdateChecker()
        checker.updateFailureStage = .menubarUpdate
        checker.updateError = "Checksum mismatch."

        #expect(checker.updateBadgeLabel == "Menubar Update Failed")
        #expect(checker.updateHelpText.contains("could not update the menubar app"))
        #expect(checker.updateHelpText.contains("Checksum mismatch."))
    }
}


// MARK: - one-click full update: package-manager resolution

@Suite("cliUpdateInvocation")
struct CliUpdateInvocationTests {
    @Test("homebrew path resolves brew upgrade")
    func homebrewPath() {
        let argv = UpdateChecker.cliUpdateInvocation(cliPath: "/opt/homebrew/bin/codeburn", fileExists: { $0 == "/opt/homebrew/bin/brew" }, resolvingSymlinks: { $0 })
        #expect(argv == ["/opt/homebrew/bin/brew", "upgrade", "codeburn"])
    }

    @Test("Cellar path resolves brew upgrade")
    func cellarPath() {
        let argv = UpdateChecker.cliUpdateInvocation(cliPath: "/usr/local/Cellar/codeburn/0.9.18/bin/codeburn", fileExists: { $0 == "/usr/local/bin/brew" })
        #expect(argv == ["/usr/local/bin/brew", "upgrade", "codeburn"])
    }

    @Test("sibling npm wins over global npm so the update lands in the same toolchain")
    func siblingNpmWins() {
        let exists: (String) -> Bool = { $0 == "/Users/u/.nvm/versions/node/v22.1.0/bin/npm" || $0 == "/opt/homebrew/bin/npm" }
        let argv = UpdateChecker.cliUpdateInvocation(cliPath: "/Users/u/.nvm/versions/node/v22.1.0/bin/codeburn", fileExists: exists)
        #expect(argv == ["/Users/u/.nvm/versions/node/v22.1.0/bin/npm", "install", "-g", "codeburn@latest", "--force"])
    }

    @Test("falls back to well-known npm locations")
    func fallbackNpm() {
        let argv = UpdateChecker.cliUpdateInvocation(cliPath: "/some/odd/place/codeburn", fileExists: { $0 == "/usr/local/bin/npm" })
        #expect(argv == ["/usr/local/bin/npm", "install", "-g", "codeburn@latest", "--force"])
    }

    @Test("no known manager returns nil instead of guessing")
    func unknownManager() {
        #expect(UpdateChecker.cliUpdateInvocation(cliPath: "/some/odd/place/codeburn", fileExists: { _ in false }) == nil)
    }

    @Test("homebrew CLI without a findable brew never falls through to npm")
    func brewMissingStaysNil() {
        // Falling through to npm --force would create a second, conflicting install.
        #expect(UpdateChecker.cliUpdateInvocation(cliPath: "/opt/homebrew/bin/codeburn", fileExists: { $0.hasSuffix("/npm") }, resolvingSymlinks: { $0 }) == nil)
    }

    @Test("brew-provided node with an npm-global CLI resolves npm, not brew")
    func brewNodeNpmGlobal() {
        // Homebrew's node sets the npm global prefix to /opt/homebrew, so the
        // launcher sits in the brew prefix but points into node_modules.
        let resolve: (String) -> String = { path in
            path == "/opt/homebrew/bin/codeburn" ? "/opt/homebrew/lib/node_modules/codeburn/dist/cli.js" : path
        }
        let exists: (String) -> Bool = { $0 == "/opt/homebrew/bin/brew" || $0 == "/opt/homebrew/bin/npm" }
        let argv = UpdateChecker.cliUpdateInvocation(
            cliPath: "/opt/homebrew/bin/codeburn",
            fileExists: exists,
            resolvingSymlinks: resolve
        )
        #expect(argv == ["/opt/homebrew/bin/npm", "install", "-g", "codeburn@latest", "--force"])
    }

    @Test("a real Cellar symlink still resolves brew")
    func cellarSymlink() {
        let resolve: (String) -> String = { path in
            path == "/opt/homebrew/bin/codeburn" ? "/opt/homebrew/Cellar/codeburn/0.9.25/bin/codeburn" : path
        }
        let argv = UpdateChecker.cliUpdateInvocation(
            cliPath: "/opt/homebrew/bin/codeburn",
            fileExists: { $0 == "/opt/homebrew/bin/brew" },
            resolvingSymlinks: resolve
        )
        #expect(argv == ["/opt/homebrew/bin/brew", "upgrade", "codeburn"])
    }

    @Test("an unresolvable launcher keeps the previous directory heuristic")
    func unresolvableKeepsHeuristic() {
        let argv = UpdateChecker.cliUpdateInvocation(
            cliPath: "/opt/homebrew/bin/codeburn",
            fileExists: { $0 == "/opt/homebrew/bin/brew" },
            resolvingSymlinks: { $0 }
        )
        #expect(argv == ["/opt/homebrew/bin/brew", "upgrade", "codeburn"])
    }
}

@Suite("cliUpdateCommand")
struct CliUpdateCommandTests {
    @Test("manual hint follows the same decision as the one-click path")
    func hintMatchesInvocation() {
        let resolve: (String) -> String = { path in
            path == "/opt/homebrew/bin/codeburn" ? "/opt/homebrew/lib/node_modules/codeburn/dist/cli.js" : path
        }
        #expect(UpdateChecker.cliUpdateCommand(cliPath: "/opt/homebrew/bin/codeburn", resolvingSymlinks: resolve) == "npm update -g codeburn")
        #expect(UpdateChecker.cliUpdateCommand(cliPath: "/usr/local/Cellar/codeburn/0.9.25/bin/codeburn") == "brew upgrade codeburn")
        #expect(UpdateChecker.cliUpdateCommand(cliPath: "/Users/u/.nvm/versions/node/v22.1.0/bin/codeburn") == "npm update -g codeburn")
    }
}

@Suite("Menubar update feed")
struct MenubarUpdateFeedTests {
    private func feed(_ json: String) -> Data { Data(json.utf8) }

    @Test("reads the version when the url is that version's mac-v zip")
    func readsMatchingFeed() {
        let data = feed(#"{"version":"0.9.30","url":"https://github.com/getagentseal/codeburn/releases/download/mac-v0.9.30/CodeBurnMenubar-v0.9.30.zip","sha256":"ab"}"#)
        #expect(UpdateChecker.menubarVersion(fromFeed: data) == "v0.9.30")
    }

    @Test("rejects a feed whose url does not match its version")
    func rejectsMismatchedFeed() {
        let other = feed(#"{"version":"0.9.30","url":"https://github.com/getagentseal/codeburn/releases/download/mac-v0.9.29/CodeBurnMenubar-v0.9.29.zip"}"#)
        let foreign = feed(#"{"version":"0.9.30","url":"https://evil.test/mac-v0.9.30/CodeBurnMenubar-v0.9.30.zip"}"#)
        #expect(UpdateChecker.menubarVersion(fromFeed: other) == nil)
        #expect(UpdateChecker.menubarVersion(fromFeed: foreign) == nil)
        #expect(UpdateChecker.menubarVersion(fromFeed: feed("not json")) == nil)
    }
}

@Suite("CLI the menubar cannot update")
struct UnmanagedCliTests {
    @Test("recognizes the desktop app's bundled CLI launcher")
    func desktopLauncher() {
        #expect(UpdateChecker.isDesktopBundledCli("/Users/u/Library/Application Support/CodeBurn/codeburn-desktop-cli.sh"))
        #expect(UpdateChecker.isDesktopBundledCli("/Applications/CodeBurn.app/Contents/Resources/cli/codeburn"))
        #expect(!UpdateChecker.isDesktopBundledCli("/opt/homebrew/bin/codeburn"))
    }

    @Test("runs the installer without a CLI update only when the CLI is ahead of the app")
    func installAdvancesOnlyWhenCliAhead() {
        #expect(UpdateChecker.menubarInstallAdvances(installedCli: "0.9.31", app: "0.9.30"))
        #expect(!UpdateChecker.menubarInstallAdvances(installedCli: "0.9.30", app: "0.9.30"))
        #expect(!UpdateChecker.menubarInstallAdvances(installedCli: nil, app: "0.9.30"))
        #expect(!UpdateChecker.menubarInstallAdvances(installedCli: "0.9.31", app: "dev"))
    }

    @Test("npm permission errors read as a permission problem with the manual command")
    func npmPermissionError() {
        let stderr = "npm error code EACCES\nnpm error syscall rename\nnpm error path /usr/local/lib/node_modules/codeburn"
        let message = UpdateChecker.cliUpdateFailureMessage(stderr: stderr, status: 243, manualCommand: "npm update -g codeburn")
        #expect(message.contains("permission"))
        #expect(message.contains("npm update -g codeburn"))
        #expect(UpdateChecker.cliUpdateFailureMessage(stderr: "boom", status: 1, manualCommand: "x") == "boom")
    }
}

@Suite("update_result telemetry")
@MainActor
struct UpdateResultTelemetryTests {
    @Test("sorts installer failures by the installer's own messages")
    func failureOutcome() {
        #expect(UpdateChecker.updateFailureOutcome(stderr: "Checksum mismatch for /tmp/x.zip.") == "verify_fail")
        #expect(UpdateChecker.updateFailureOutcome(stderr: "Refusing to install: the downloaded CodeBurn Menubar is not signed and notarized by AgentSeal") == "verify_fail")
        #expect(UpdateChecker.updateFailureOutcome(stderr: "Menubar download failed after 3 attempts: ECONNRESET (https://x)") == "download_fail")
        #expect(UpdateChecker.updateFailureOutcome(stderr: "ditto exited with status 1") == "install_fail")
        #expect(UpdateChecker.updateFailureOutcome(stderr: "") == "install_fail")
    }

    @Test("settles a pending update once: ok when newer, install_fail when unchanged, nothing when older")
    func settlesPendingUpdate() {
        let cases: [(String, [String: String]?)] = [
            ("0.9.27", ["from": "0.9.26", "to": "0.9.27", "outcome": "ok"]),
            ("0.9.28", ["from": "0.9.26", "to": "0.9.28", "outcome": "ok"]),
            ("0.9.26", ["from": "0.9.26", "to": "0.9.27", "outcome": "install_fail"]),
            ("0.9.25", nil),
        ]
        for (running, expected) in cases {
            let (defaults, suiteName) = TestDefaults.make("codeburn.update-result.\(running)")
            defer { TestDefaults.forget(suiteName) }
            var tracked: [(String, JSONValue)] = []
            let checker = UpdateChecker(defaults: defaults, track: { tracked.append(($0, $1)) })
            defaults.set(["from": "0.9.26", "to": "0.9.27"], forKey: "UpdateChecker.pendingUpdate")
            checker.settlePendingUpdate(running: running)
            checker.settlePendingUpdate(running: running)
            #expect(defaults.dictionary(forKey: "UpdateChecker.pendingUpdate") == nil)
            guard let expected else {
                #expect(tracked.isEmpty)
                continue
            }
            #expect(tracked.count == 1)
            #expect(tracked.first?.0 == "update_result")
            #expect(tracked.first?.1 == .object(expected.mapValues { .string($0) }))
            #expect(Telemetry.eventNames.contains("update_result"))
        }
    }
}

// MARK: - `codeburn update --json` engine (CLI >= 0.9.27)

private func engineLine(_ json: String) -> UpdateEngineLine? {
    UpdateEngineLine.decode(Data(json.utf8))
}

@Suite("Update engine gate")
struct UpdateEngineGateTests {
    @Test("the engine runs only for a CLI at or above 0.9.27")
    func gate() {
        #expect(!UpdateChecker.usesEngine(installedCli: "0.9.26"))
        #expect(!UpdateChecker.usesEngine(installedCli: "0.9.9"))
        #expect(UpdateChecker.usesEngine(installedCli: "0.9.27"))
        #expect(UpdateChecker.usesEngine(installedCli: "v0.9.27"))
        #expect(UpdateChecker.usesEngine(installedCli: "0.9.100"))
        #expect(UpdateChecker.usesEngine(installedCli: "1.0.0"))
        #expect(!UpdateChecker.usesEngine(installedCli: nil))
        #expect(!UpdateChecker.usesEngine(installedCli: ""))
    }

    @Test("older CLIs keep the legacy copy command, the engine path offers only its own")
    @MainActor
    func fallbackCommand() {
        let checker = UpdateChecker()
        checker.updateFailureCommand = "npm install -g codeburn@0.9.28"
        checker.installedCliVersion = "0.9.26"
        #expect(checker.manualUpdateCommand == checker.cliUpdateCommand)
        checker.installedCliVersion = "0.9.27"
        #expect(checker.manualUpdateCommand == "npm install -g codeburn@0.9.28")
        checker.updateFailureCommand = nil
        #expect(checker.manualUpdateCommand == nil)
    }

    @Test("without an engine result the CLI pill keeps the legacy comparison")
    @MainActor
    func legacyCliComparison() {
        let checker = UpdateChecker()
        checker.installedCliVersion = "0.9.25"
        checker.latestCliVersion = "0.9.26"
        #expect(checker.cliUpdateAvailable)
        #expect(!checker.desktopUpdateAvailable)
    }
}

@Suite("Update engine JSON")
struct UpdateEngineDecodingTests {
    static let codes = [
        "ok", "up_to_date", "not_installed", "managed", "not_propagated", "permission",
        "no_manager", "download_fail", "verify_fail", "install_fail", "busy", "timeout",
    ]

    @Test("every contract code decodes on a step line", arguments: codes)
    func decodesCode(_ code: String) {
        let line = engineLine(#"{"type":"step","component":"cli","state":"error","from":"0.9.27","to":"0.9.28","code":"\#(code)","message":"m","command":"npm install -g codeburn@0.9.28"}"#)
        #expect(line?.type == "step")
        #expect(line?.component == "cli")
        #expect(line?.state == "error")
        #expect(line?.from == "0.9.27")
        #expect(line?.to == "0.9.28")
        #expect(line?.code == code)
        #expect(line?.message == "m")
        #expect(line?.command == "npm install -g codeburn@0.9.28")
    }

    @Test("telemetry keeps only the outcomes update_result already sends", arguments: codes)
    func telemetryOutcome(_ code: String) {
        let expected = code == "verify_fail" || code == "download_fail" ? code : "install_fail"
        #expect(UpdateChecker.engineTelemetryOutcome(code: code) == expected)
    }

    @Test("an unknown code or a missing field still decodes")
    func tolerant() {
        #expect(engineLine(#"{"type":"step","component":"menubar","state":"error","code":"brand_new"}"#)?.code == "brand_new")
        #expect(engineLine(#"{"type":"step","component":"desktop","state":"start"}"#)?.message == nil)
        #expect(engineLine("not json") == nil)
        #expect(engineLine(#"{"component":"cli"}"#) == nil)
    }

    @Test("a result line reports which components are behind")
    func result() throws {
        let line = try #require(engineLine(#"{"type":"result","ok":true,"components":{"cli":{"installed":"0.9.27","latest":"0.9.28","state":"done","method":"npm"},"menubar":{"installed":"0.9.28","latest":"0.9.28","state":"skipped"},"desktop":{"installed":null,"latest":"0.9.28","state":"skipped"}}}"#))
        #expect(line.ok == true)
        #expect(line.components?["cli"]?.method == "npm")
        #expect(line.components?["cli"]?.isBehind == true)
        #expect(line.components?["menubar"]?.isBehind == false)
        #expect(line.components?["desktop"]?.isBehind == false)
    }

    @Test("components map onto failure stages")
    func stages() {
        #expect(UpdateChecker.failureStage(component: "cli") == .cliUpdate)
        #expect(UpdateChecker.failureStage(component: "menubar") == .menubarUpdate)
        #expect(UpdateChecker.failureStage(component: "desktop") == .desktopUpdate)
        #expect(UpdateChecker.failureStage(component: nil) == .cliUpdate)
    }

    @Test("lines split across chunks are read once, the tail on finish")
    func reader() {
        let reader = UpdateEngineLineReader()
        #expect(reader.append(Data(#"{"type":"step","compo"#.utf8)).isEmpty)
        let first = reader.append(Data("nent\":\"cli\",\"state\":\"start\"}\nnoise\n{\"type\":\"result\",\"ok\":true}".utf8))
        #expect(first.map(\.component) == ["cli"])
        #expect(reader.finish()?.map(\.type) == ["result"])
        #expect(reader.finish() == nil)
        #expect(reader.append(Data("{\"type\":\"step\"}\n".utf8)).isEmpty)
        #expect(reader.lines.map(\.type) == ["step", "result"])
    }
}

@Suite("Update engine check cache")
struct UpdateEngineCacheTests {
    let hour: TimeInterval = 60 * 60

    @Test("a check holds for six hours against the same app and CLI versions")
    func interval() {
        let stamp = UpdateChecker.checkStamp(app: "0.9.27", cli: "0.9.27")
        #expect(UpdateChecker.isCheckFresh(lastCheck: 0, now: 5.9 * hour, lastStamp: stamp, stamp: stamp))
        #expect(!UpdateChecker.isCheckFresh(lastCheck: 0, now: 6 * hour, lastStamp: stamp, stamp: stamp))
        #expect(!UpdateChecker.isCheckFresh(lastCheck: 2 * hour, now: hour, lastStamp: stamp, stamp: stamp))
    }

    @Test("a new app or CLI version re-checks inside the window")
    func bust() {
        let stamp = UpdateChecker.checkStamp(app: "0.9.27", cli: "0.9.27")
        #expect(!UpdateChecker.isCheckFresh(lastCheck: 0, now: hour, lastStamp: UpdateChecker.checkStamp(app: "0.9.26", cli: "0.9.27"), stamp: stamp))
        #expect(!UpdateChecker.isCheckFresh(lastCheck: 0, now: hour, lastStamp: UpdateChecker.checkStamp(app: "0.9.27", cli: "0.9.26"), stamp: stamp))
        #expect(!UpdateChecker.isCheckFresh(lastCheck: 0, now: hour, lastStamp: nil, stamp: stamp))
        #expect(UpdateChecker.checkStamp(app: "v0.9.27", cli: nil) == "0.9.27|")
    }
}

@Suite("Update engine progress")
@MainActor
struct UpdateEngineProgressTests {
    private func step(_ component: String, _ state: String, extra: String = "") -> UpdateEngineLine {
        engineLine(#"{"type":"step","component":"\#(component)","state":"\#(state)"\#(extra)}"#)!
    }

    @Test("the badge names the component being updated")
    func badge() {
        let checker = UpdateChecker()
        checker.isUpdating = true
        #expect(checker.updateBadgeLabel == "Updating...")
        checker.handleEngineStep(step("cli", "start"))
        #expect(checker.updateBadgeLabel == "Updating CLI...")
        checker.handleEngineStep(step("menubar", "progress"))
        #expect(checker.updateBadgeLabel == "Updating menubar...")
        checker.handleEngineStep(step("desktop", "start"))
        #expect(checker.updateBadgeLabel == "Opening CodeBurn to update...")
    }

    @Test("the first error line becomes the message and the copyable command")
    func error() {
        let checker = UpdateChecker()
        checker.isUpdating = true
        checker.handleEngineStep(step("cli", "error", extra: #","code":"permission","message":"npm cannot write to /usr/local.","command":"npm install -g codeburn@0.9.28""#))
        checker.handleEngineStep(step("desktop", "error", extra: #","code":"busy","message":"later""#))
        checker.finishEngineUpdate(status: 1, stderr: "")
        #expect(!checker.isUpdating)
        #expect(checker.updateFailureStage == .cliUpdate)
        #expect(checker.updateError == "npm cannot write to /usr/local.")
        #expect(checker.updateFailureCommand == "npm install -g codeburn@0.9.28")
        #expect(checker.updateBadgeLabel == "CLI Update Failed")
    }

    @Test("a desktop error reads as a desktop failure; no message falls back to the exit status")
    func desktopError() {
        let checker = UpdateChecker()
        checker.handleEngineStep(step("desktop", "error", extra: #","code":"timeout""#))
        checker.finishEngineUpdate(status: 1, stderr: "")
        #expect(checker.updateFailureStage == .desktopUpdate)
        #expect(checker.updateError == "Update failed (exit 1)")
        #expect(checker.updateFailureCommand == nil)
    }

    @Test("a crash with no error line blames the step in progress")
    func crash() {
        let checker = UpdateChecker()
        checker.isUpdating = true
        checker.handleEngineStep(step("menubar", "start"))
        checker.finishEngineUpdate(status: 15, stderr: "killed")
        #expect(checker.updateFailureStage == .menubarUpdate)
        #expect(checker.updateError == "killed")
    }

    @Test("a stream cut short after the menubar was placed is not a failure; the marker stays for the relaunch")
    func cutAfterMenubarDone() {
        let (defaults, suiteName) = TestDefaults.make("codeburn.update-engine.cut")
        defer { TestDefaults.forget(suiteName) }
        let checker = UpdateChecker(defaults: defaults)
        checker.isUpdating = true
        checker.handleEngineStep(step("menubar", "start", extra: #","to":"0.9.28""#))
        checker.handleEngineStep(step("menubar", "done", extra: #","code":"ok","to":"0.9.28""#))
        checker.handleEngineStep(step("desktop", "start"))
        checker.finishEngineUpdate(status: 1, stderr: "")
        #expect(!checker.isUpdating)
        #expect(checker.updateFailureStage == nil)
        #expect(checker.updateError == nil)
        #expect((defaults.dictionary(forKey: "UpdateChecker.pendingUpdate") as? [String: String])?["to"] == "0.9.28")
    }

    @Test("the menubar step drives the pending marker and its telemetry")
    func menubarTelemetry() {
        let (defaults, suiteName) = TestDefaults.make("codeburn.update-engine.marker")
        defer { TestDefaults.forget(suiteName) }
        var tracked: [(String, JSONValue)] = []
        let checker = UpdateChecker(defaults: defaults, track: { tracked.append(($0, $1)) })
        checker.handleEngineStep(step("menubar", "start", extra: #","from":"0.9.27","to":"v0.9.28""#))
        #expect((defaults.dictionary(forKey: "UpdateChecker.pendingUpdate") as? [String: String])?["to"] == "0.9.28")
        checker.handleEngineStep(step("menubar", "error", extra: #","code":"verify_fail","message":"bad signature""#))
        #expect(defaults.dictionary(forKey: "UpdateChecker.pendingUpdate") == nil)
        #expect(tracked.count == 1)
        if case let .object(fields)? = tracked.first?.1 {
            #expect(fields["outcome"] == .string("verify_fail"))
            #expect(fields["to"] == .string("0.9.28"))
        } else {
            Issue.record("expected an update_result object")
        }

        checker.handleEngineStep(step("menubar", "start", extra: #","to":"0.9.28""#))
        checker.handleEngineStep(step("menubar", "skipped", extra: #","code":"up_to_date""#))
        #expect(defaults.dictionary(forKey: "UpdateChecker.pendingUpdate") == nil)
    }

    @Test("success clears every pill and forces a fresh check")
    func success() throws {
        let (defaults, suiteName) = TestDefaults.make("codeburn.update-engine.success")
        defer { TestDefaults.forget(suiteName) }
        let checker = UpdateChecker(defaults: defaults)
        checker.engineResult = try #require(engineLine(#"{"type":"result","ok":true,"components":{"cli":{"installed":"0.9.27","latest":"0.9.28"},"desktop":{"installed":"0.9.27","latest":"0.9.28"}}}"#))
        checker.latestCliVersion = "0.9.28"
        defaults.set(123.0, forKey: "UpdateChecker.lastCheckDate")
        #expect(checker.cliUpdateAvailable)
        #expect(checker.desktopUpdateAvailable)
        #expect(checker.updateHelpText == "Update the CLI, menubar and desktop app to the latest release")
        checker.isUpdating = true
        checker.finishEngineUpdate(status: 0, stderr: "")
        #expect(!checker.anyUpdateAvailable)
        #expect(checker.updateError == nil)
        #expect(defaults.double(forKey: "UpdateChecker.lastCheckDate") == 0)
    }

    @Test("the engine's CLI pair wins over the menubar's own CLI probe")
    func enginePair() throws {
        let checker = UpdateChecker()
        checker.installedCliVersion = "0.9.28"
        checker.latestCliVersion = "0.9.28"
        checker.engineResult = try #require(engineLine(#"{"type":"result","ok":true,"components":{"cli":{"installed":"0.9.27","latest":"0.9.28"}}}"#))
        #expect(checker.cliUpdateAvailable)
        checker.engineResult = try #require(engineLine(#"{"type":"result","ok":true,"components":{"cli":{"installed":null,"latest":"0.9.28","state":"skipped"}}}"#))
        #expect(!checker.cliUpdateAvailable)
    }
}
