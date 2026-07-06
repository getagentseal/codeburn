import Foundation
import Observation

private let releasesAPI = "https://api.github.com/repos/getagentseal/codeburn/releases?per_page=20"
private let checkIntervalSeconds: TimeInterval = 2 * 24 * 60 * 60
private let lastCheckKey = "UpdateChecker.lastCheckDate"
private let cachedVersionKey = "UpdateChecker.latestVersion"
private let cachedCliVersionKey = "UpdateChecker.latestCliVersion"
private let updateTimeoutSeconds: UInt64 = 120
private let maxUpdateStderrBytes = 64 * 1024
// The installer that scans `mac-v*` releases for the menubar zip (instead of
// `/releases/latest`, which can resolve to a CLI release that carries no menubar
// asset) landed in CLI 0.9.9 (commit 909efcf). Older CLIs cannot perform a correct
// `menubar --force`, so we refuse to run them and ask the user to upgrade the CLI first.
private let minCliVersionForUpdate = "0.9.9"

private final class LockedDataBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()

    func append(_ chunk: Data, limit: Int) {
        lock.withLock {
            guard data.count < limit else { return }
            data.append(Data(chunk.prefix(limit - data.count)))
        }
    }

    func snapshot() -> Data {
        lock.withLock { data }
    }
}

@MainActor
@Observable
final class UpdateChecker {
    var latestVersion: String?
    var latestCliVersion: String?
    var installedCliVersion: String?
    var isUpdating = false
    var updateError: String?

    var updateAvailable: Bool {
        guard let latest = latestVersion else { return false }
        let current = currentVersion
        let normalizedLatest = AppVersion.normalize(latest)
        let normalizedCurrent = AppVersion.normalize(current)
        guard !normalizedCurrent.isEmpty && normalizedCurrent != "dev" else { return false }
        return normalizedLatest.compare(normalizedCurrent, options: .numeric) == .orderedDescending
    }

    var cliUpdateAvailable: Bool {
        guard let latest = latestCliVersion, let installed = installedCliVersion else { return false }
        let normalizedLatest = AppVersion.normalize(latest)
        let normalizedInstalled = AppVersion.normalize(installed)
        guard !normalizedInstalled.isEmpty else { return false }
        return normalizedLatest.compare(normalizedInstalled, options: .numeric) == .orderedDescending
    }

    /// True when the installed CLI predates the `menubar --force` fix and would fail to
    /// install the new app. Distinct from `cliUpdateAvailable`: a CLI can be behind the
    /// latest release yet still new enough (>= 0.9.9) to update the menubar correctly.
    var cliTooOldForUpdate: Bool {
        Self.isCliTooOld(installed: installedCliVersion)
    }

    var cliUpdateCommand: String {
        let argv = CodeburnCLI.baseArgv()
        let path = argv.first ?? ""
        if path.contains("/homebrew/") { return "brew upgrade codeburn" }
        return "npm update -g codeburn"
    }

    var currentVersion: String {
        AppVersion.normalizedBundleShortVersion
    }

    func checkIfNeeded() async {
        installedCliVersion = Self.queryInstalledCliVersion()
        let lastCheck = UserDefaults.standard.double(forKey: lastCheckKey)
        let now = Date().timeIntervalSince1970
        if now - lastCheck < checkIntervalSeconds {
            latestVersion = UserDefaults.standard.string(forKey: cachedVersionKey)
            latestCliVersion = UserDefaults.standard.string(forKey: cachedCliVersionKey)
            return
        }
        await check()
    }

    func check() async {
        updateError = nil
        installedCliVersion = Self.queryInstalledCliVersion()
        guard let url = URL(string: releasesAPI) else { return }
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        request.setValue("codeburn-menubar-updater", forHTTPHeaderField: "User-Agent")
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? -1
                throw UpdateCheckError.http(status)
            }
            let releases = try JSONDecoder().decode([GitHubRelease].self, from: data)
            guard let resolved = Self.resolveLatestMenubarRelease(in: releases) else {
                throw UpdateCheckError.missingMenubarAsset
            }

            let version = resolved.asset.name
                .replacingOccurrences(of: "CodeBurnMenubar-", with: "")
                .replacingOccurrences(of: ".zip", with: "")

            let cliVersion = Self.resolveLatestCliVersion(in: releases)

            latestVersion = version
            latestCliVersion = cliVersion
            UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: lastCheckKey)
            UserDefaults.standard.set(version, forKey: cachedVersionKey)
            if let cliVersion { UserDefaults.standard.set(cliVersion, forKey: cachedCliVersionKey) }
        } catch {
            updateError = "Update check failed: \(error.localizedDescription)"
            NSLog("CodeBurn: update check failed: \(error)")
        }
    }

    nonisolated static func resolveLatestCliVersion(in releases: [GitHubRelease]) -> String? {
        for release in releases where release.tag_name.hasPrefix("v") && !release.tag_name.hasPrefix("mac-v") {
            return AppVersion.normalize(release.tag_name)
        }
        return nil
    }

    nonisolated static func queryInstalledCliVersion() -> String? {
        let process = CodeburnCLI.makeProcess(subcommand: ["--version"])
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return nil }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return output.isEmpty ? nil : output
        } catch {
            return nil
        }
    }

    nonisolated static func resolveLatestMenubarRelease(in releases: [GitHubRelease]) -> (release: GitHubRelease, asset: GitHubAsset)? {
        for release in releases where release.tag_name.hasPrefix("mac-v") {
            guard let asset = release.assets.first(where: {
                $0.name.hasPrefix("CodeBurnMenubar-v") && $0.name.hasSuffix(".zip")
            }) else { continue }
            guard release.assets.contains(where: { $0.name == "\(asset.name).sha256" }) else { continue }
            return (release, asset)
        }
        return nil
    }

    nonisolated static func isCliTooOld(installed: String?) -> Bool {
        guard let installed else { return false }
        let normalizedInstalled = AppVersion.normalize(installed)
        guard !normalizedInstalled.isEmpty else { return false }
        return AppVersion.normalize(minCliVersionForUpdate).compare(normalizedInstalled, options: .numeric) == .orderedDescending
    }

    func performUpdate() {
        installedCliVersion = Self.queryInstalledCliVersion()
        if cliTooOldForUpdate {
            updateError = "Your codeburn CLI (\(AppVersion.display(installedCliVersion ?? ""))) is too old to update the menubar. Run “\(cliUpdateCommand)” first, then try again."
            return
        }
        isUpdating = true
        updateError = nil

        let process = CodeburnCLI.makeProcess(subcommand: ["menubar", "--force"])
        let errPipe = Pipe()
        let errBuffer = LockedDataBuffer()
        process.standardOutput = FileHandle.nullDevice
        process.standardError = errPipe
        errPipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else { return }
            errBuffer.append(chunk, limit: maxUpdateStderrBytes)
        }

        let timeoutTask = Task.detached(priority: .utility) {
            try? await Task.sleep(nanoseconds: updateTimeoutSeconds * 1_000_000_000)
            if process.isRunning {
                NSLog("CodeBurn: update subprocess timed out after %llus - terminating", updateTimeoutSeconds)
                process.terminate()
            }
        }

        process.terminationHandler = { [weak self] proc in
            timeoutTask.cancel()
            errPipe.fileHandleForReading.readabilityHandler = nil
            let stderrData = errBuffer.snapshot()
            let stderr = Self.sanitizeForDisplay(String(data: stderrData, encoding: .utf8) ?? "")
            Task { @MainActor in
                guard let self else { return }
                self.isUpdating = false
                if proc.terminationStatus != 0 {
                    self.updateError = stderr.isEmpty ? "Update failed (exit \(proc.terminationStatus))" : stderr
                    NSLog("CodeBurn: update failed (exit \(proc.terminationStatus)): \(stderr)")
                } else {
                    self.latestVersion = nil
                }
            }
        }

        do {
            try process.run()
        } catch {
            isUpdating = false
            updateError = error.localizedDescription
            NSLog("CodeBurn: update spawn failed: \(error)")
        }
    }

    nonisolated private static func sanitizeForDisplay(_ value: String) -> String {
        var cleaned = value.replacingOccurrences(of: "\u{0000}", with: "")
        let patterns: [(String, String)] = [
            (#"sk-ant-[A-Za-z0-9_-]+"#, "sk-ant-***"),
            (#"sk-[A-Za-z0-9_-]{16,}"#, "sk-***"),
            (#"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"#, "eyJ***"),
            (#"(?i)Bearer\s+\S+"#, "Bearer ***"),
        ]
        for (pattern, replacement) in patterns {
            cleaned = cleaned.replacingOccurrences(of: pattern, with: replacement, options: .regularExpression)
        }
        if cleaned.count > 1_000 { cleaned = String(cleaned.prefix(1_000)) + "..." }
        return cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

enum UpdateCheckError: LocalizedError {
    case http(Int)
    case missingMenubarAsset

    var errorDescription: String? {
        switch self {
        case let .http(status): "GitHub returned HTTP \(status)."
        case .missingMenubarAsset: "No mac-v release with a menubar zip and checksum was found."
        }
    }
}

struct GitHubRelease: Decodable {
    let tag_name: String
    let assets: [GitHubAsset]
}

struct GitHubAsset: Decodable {
    let name: String
    let browser_download_url: String
}
