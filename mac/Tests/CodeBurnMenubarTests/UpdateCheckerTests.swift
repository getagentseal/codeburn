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
        #expect(checker.updateHelpText.contains("could not check GitHub for updates"))
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
        let argv = UpdateChecker.cliUpdateInvocation(cliPath: "/opt/homebrew/bin/codeburn", fileExists: { $0 == "/opt/homebrew/bin/brew" })
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
        #expect(UpdateChecker.cliUpdateInvocation(cliPath: "/opt/homebrew/bin/codeburn", fileExists: { $0.hasSuffix("/npm") }) == nil)
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
