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
