import Foundation
import Observation

private let releasesAPI = "https://api.github.com/repos/getagentseal/codeburn/releases?per_page=20"
// Written by release-menubar.yml after a mac-v* release is verified; the `codeburn menubar`
// installer reads the same file, so the pill and the install agree on "latest".
private let menubarFeedURL = "https://github.com/getagentseal/codeburn/releases/download/update-feeds/menubar-latest.json"
private let menubarAssetURLPrefix = "https://github.com/getagentseal/codeburn/releases/download/mac-v"
// Six hours puts a release on the pill within a working day for four cheap checks a day
// (one CLI spawn plus small feed/registry reads), well under GitHub's unauthenticated
// limit on the legacy path. A changed app or CLI version re-checks at once.
private let checkIntervalSeconds: TimeInterval = 6 * 60 * 60
private let pollIntervalSeconds: TimeInterval = 60 * 60
private let lastCheckKey = "UpdateChecker.lastCheckDate"
private let lastCheckStampKey = "UpdateChecker.lastCheckStamp"
private let cachedEngineResultKey = "UpdateChecker.engineResult"
private let cachedVersionKey = "UpdateChecker.latestVersion"
private let cachedCliVersionKey = "UpdateChecker.latestCliVersion"
private let lastNotifiedVersionsKey = "UpdateChecker.lastNotifiedVersions"
// Written just before the installer runs, settled on the next launch: the installer
// stops and relaunches this app, so nothing tracked in this process would survive.
private let pendingUpdateKey = "UpdateChecker.pendingUpdate"
// A global npm install on a slow link or a cold cache can run for minutes.
private let cliUpdateTimeoutSeconds: UInt64 = 600
private let menubarUpdateTimeoutSeconds: UInt64 = 300
private let maxUpdateStderrBytes = 64 * 1024
// The installer that scans `mac-v*` releases for the menubar zip (instead of
// `/releases/latest`, which can resolve to a CLI release that carries no menubar
// asset) landed in CLI 0.9.9 (commit 909efcf). Older CLIs cannot perform a correct
// `menubar --force`, so we refuse to run them and ask the user to upgrade the CLI first.
private let minCliVersionForUpdate = "0.9.9"
// `codeburn update --json` (src/update.ts) ships in 0.9.27; older CLIs keep the GitHub
// scan and the npm/brew + `menubar --force` path below.
private let minCliVersionForEngine = "0.9.27"
private let engineCheckTimeoutSeconds: UInt64 = 60
private let engineUpdateTimeoutSeconds: UInt64 = 900

enum UpdateFailureStage: Equatable {
    case check
    case cliUpdate
    case menubarUpdate
    case desktopUpdate

    var badgeLabel: String {
        switch self {
        case .check: L("Update Check Failed")
        case .cliUpdate: L("CLI Update Failed")
        case .menubarUpdate: L("Menubar Update Failed")
        case .desktopUpdate: L("Desktop Update Failed")
        }
    }

    var summary: String {
        switch self {
        case .check: L("CodeBurn could not check for updates.")
        case .cliUpdate: L("CodeBurn could not update the CLI.")
        case .menubarUpdate: L("CodeBurn could not update the menubar app.")
        case .desktopUpdate: L("CodeBurn could not update the desktop app.")
        }
    }

    var retryHelp: String {
        switch self {
        case .check: L("Click to retry the update check.")
        case .cliUpdate, .menubarUpdate, .desktopUpdate: L("Click to retry the update.")
        }
    }
}

/// One stdout line of `codeburn update --json` (design 2.1, frozen): a `step` or the final
/// `result`. Fields are optional and `code` stays a string, so a newer engine that adds a
/// code still reads as an ordinary error with its own message.
struct UpdateEngineLine: Codable, Equatable {
    struct Component: Codable, Equatable {
        let installed: String?
        let latest: String?
        let state: String?
        let method: String?

        var isBehind: Bool {
            guard let installed, let latest else { return false }
            let i = AppVersion.normalize(installed), l = AppVersion.normalize(latest)
            guard !i.isEmpty, !l.isEmpty else { return false }
            return l.compare(i, options: .numeric) == .orderedDescending
        }
    }

    let type: String
    let component: String?
    let state: String?
    let from: String?
    let to: String?
    let code: String?
    let message: String?
    let command: String?
    let ok: Bool?
    let components: [String: Component]?

    static func decode(_ line: Data) -> UpdateEngineLine? {
        try? JSONDecoder().decode(UpdateEngineLine.self, from: line)
    }
}

/// Splits streamed stdout into JSON lines; a chunk can end mid-line.
final class UpdateEngineLineReader: @unchecked Sendable {
    private let lock = NSLock()
    private var pending = Data()
    private var decoded: [UpdateEngineLine] = []
    private var finished = false

    func append(_ chunk: Data) -> [UpdateEngineLine] {
        lock.withLock {
            guard !finished else { return [] }
            pending.append(chunk)
            var lines: [UpdateEngineLine] = []
            while let newline = pending.firstIndex(of: UInt8(ascii: "\n")) {
                if let line = UpdateEngineLine.decode(pending[pending.startIndex..<newline]) { lines.append(line) }
                pending.removeSubrange(pending.startIndex...newline)
            }
            decoded += lines
            return lines
        }
    }

    /// The unterminated tail, once; nil on every later call.
    func finish() -> [UpdateEngineLine]? {
        lock.withLock {
            guard !finished else { return nil }
            finished = true
            let tail = UpdateEngineLine.decode(pending).map { [$0] } ?? []
            pending = Data()
            decoded += tail
            return tail
        }
    }

    var lines: [UpdateEngineLine] { lock.withLock { decoded } }
}

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
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let makeNotifier: () -> any UpdateNotifier
    @ObservationIgnored private var notifier: (any UpdateNotifier)?
    @ObservationIgnored private let track: @MainActor (String, JSONValue) -> Void

    init(
        defaults: UserDefaults = .standard,
        makeNotifier: @escaping () -> any UpdateNotifier = { SystemUpdateNotifier() },
        track: @escaping @MainActor (String, JSONValue) -> Void = { Telemetry.shared.track($0, $1) }
    ) {
        self.defaults = defaults
        self.makeNotifier = makeNotifier
        self.track = track
    }

    private func trackUpdateResult(from: String, to: String, outcome: String) {
        track("update_result", .object(["from": .string(from), "to": .string(to), "outcome": .string(outcome)]))
    }

    /// On launch: a newer version running means the last install landed, and `to` is what
    /// runs; the old one still running means it did not. An older one is a manual
    /// downgrade: the marker goes and nothing is sent.
    func settlePendingUpdate(running: String? = nil) {
        guard let pending = defaults.dictionary(forKey: pendingUpdateKey) as? [String: String],
              let from = pending["from"], let to = pending["to"] else { return }
        defaults.removeObject(forKey: pendingUpdateKey)
        let now = AppVersion.normalize(running ?? currentVersion)
        switch now.compare(from, options: .numeric) {
        case .orderedDescending: trackUpdateResult(from: from, to: now, outcome: "ok")
        case .orderedSame: trackUpdateResult(from: from, to: to, outcome: "install_fail")
        case .orderedAscending: break
        }
    }

    /// A failed `codeburn menubar --force`, sorted by the installer's own messages
    /// (src/menubar-installer.ts) so the stderr itself never leaves the machine.
    nonisolated static func updateFailureOutcome(stderr: String) -> String {
        let text = stderr.lowercased()
        let verify = ["checksum", "not signed", "notarized", "bundle id", "refusing"]
        if verify.contains(where: text.contains) { return "verify_fail" }
        if text.range(of: #"failed after \d+ attempts|http \d{3}|econn|etimedout|enotfound|network"#, options: .regularExpression) != nil {
            return "download_fail"
        }
        return "install_fail"
    }

    private func failPendingUpdate(outcome: String) {
        guard let pending = defaults.dictionary(forKey: pendingUpdateKey) as? [String: String],
              let from = pending["from"], let to = pending["to"] else { return }
        defaults.removeObject(forKey: pendingUpdateKey)
        trackUpdateResult(from: from, to: to, outcome: outcome)
    }

    var latestVersion: String?
    var latestCliVersion: String?
    var installedCliVersion: String?
    var isUpdating = false
    var updateError: String?
    var updateFailureStage: UpdateFailureStage?
    /// Last `result` from `codeburn update --check --json`; nil on the legacy path.
    var engineResult: UpdateEngineLine?
    /// Component of the engine step in progress, for the badge.
    var updatingComponent: String?
    /// The engine's manual fallback for the failed step, when it gave one.
    var updateFailureCommand: String?
    @ObservationIgnored private var engineFailure: UpdateEngineLine?
    /// The engine reported the menubar placed; the installer relaunches this app next.
    @ObservationIgnored private var menubarReplaced = false

    var updateBadgeLabel: String {
        if isUpdating {
            switch updatingComponent ?? "" {
            case "cli": return L("Updating CLI...")
            case "menubar": return L("Updating menubar...")
            case "desktop": return L("Opening CodeBurn to update...")
            default: return L("Updating...")
            }
        }
        return updateFailureStage?.badgeLabel ?? L("Update")
    }

    var updateHelpText: String {
        guard let error = updateError, let stage = updateFailureStage else {
            return desktopUpdateAvailable
                ? L("Update the CLI, menubar and desktop app to the latest release")
                : L("Update the CLI and menubar to the latest release")
        }
        return "\(stage.summary)\n\n\(error)\n\n\(stage.retryHelp)"
    }

    var anyUpdateAvailable: Bool {
        updateAvailable || cliUpdateAvailable || desktopUpdateAvailable
    }

    var updateAvailable: Bool {
        guard let latest = latestVersion else { return false }
        let current = currentVersion
        let normalizedLatest = AppVersion.normalize(latest)
        let normalizedCurrent = AppVersion.normalize(current)
        guard !normalizedCurrent.isEmpty && normalizedCurrent != "dev" else { return false }
        return normalizedLatest.compare(normalizedCurrent, options: .numeric) == .orderedDescending
    }

    /// On the engine path the pair is the engine's: its `cli` is the global CLI, which is not
    /// what `installedCliVersion` probes when the menubar runs the desktop's launcher.
    var cliUpdateAvailable: Bool {
        if let engineResult { return engineResult.components?["cli"]?.isBehind ?? false }
        guard let latest = latestCliVersion, let installed = installedCliVersion else { return false }
        let normalizedLatest = AppVersion.normalize(latest)
        let normalizedInstalled = AppVersion.normalize(installed)
        guard !normalizedInstalled.isEmpty else { return false }
        return normalizedLatest.compare(normalizedInstalled, options: .numeric) == .orderedDescending
    }

    var desktopUpdateAvailable: Bool {
        engineResult?.components?["desktop"]?.isBehind ?? false
    }

    /// What the failure banner offers to copy: the engine's own fallback, or the
    /// package-manager command on the legacy path.
    var manualUpdateCommand: String? {
        Self.usesEngine(installedCli: installedCliVersion) ? updateFailureCommand : cliUpdateCommand
    }

    /// True when the installed CLI predates the `menubar --force` fix and would fail to
    /// install the new app. Distinct from `cliUpdateAvailable`: a CLI can be behind the
    /// latest release yet still new enough (>= 0.9.9) to update the menubar correctly.
    var cliTooOldForUpdate: Bool {
        Self.isCliTooOld(installed: installedCliVersion)
    }

    var cliUpdateCommand: String {
        let argv = CodeburnCLI.baseArgv()
        return Self.cliUpdateCommand(cliPath: argv.first ?? "")
    }

    /// Manual counterpart of `cliUpdateInvocation`, so the hint shown when the
    /// one-click path cannot find a manager names the same manager that path
    /// would have used.
    nonisolated static func cliUpdateCommand(
        cliPath: String,
        resolvingSymlinks: (String) -> String = { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path }
    ) -> String {
        if isHomebrewInstall(cliPath: cliPath, resolvingSymlinks: resolvingSymlinks) { return "brew upgrade codeburn" }
        return "npm update -g codeburn"
    }

    var currentVersion: String {
        AppVersion.normalizedBundleShortVersion
    }

    /// At launch and then hourly for the life of the app; `checkIfNeeded` keeps the real
    /// check to once per `checkIntervalSeconds` unless a version changed.
    func poll() async {
        while !Task.isCancelled {
            await checkIfNeeded()
            try? await Task.sleep(for: .seconds(pollIntervalSeconds))
        }
    }

    nonisolated static func checkStamp(app: String, cli: String?) -> String {
        "\(AppVersion.normalize(app))|\(AppVersion.normalize(cli ?? ""))"
    }

    /// The cached result still holds when it is recent and was taken against the same
    /// app and CLI versions; an update by any route changes one of them.
    nonisolated static func isCheckFresh(lastCheck: TimeInterval, now: TimeInterval, lastStamp: String?, stamp: String) -> Bool {
        now - lastCheck < checkIntervalSeconds && now >= lastCheck && lastStamp == stamp
    }

    nonisolated static func usesEngine(installedCli: String?) -> Bool {
        guard let installedCli else { return false }
        let installed = AppVersion.normalize(installedCli)
        guard !installed.isEmpty else { return false }
        return installed.compare(minCliVersionForEngine, options: .numeric) != .orderedAscending
    }

    func checkIfNeeded() async {
        // A background check would wipe an update failure the user has not acted on yet.
        guard !isUpdating, updateFailureStage == nil || updateFailureStage == .check else { return }
        installedCliVersion = await Task.detached { Self.queryInstalledCliVersion() }.value
        let stamp = Self.checkStamp(app: currentVersion, cli: installedCliVersion)
        if Self.isCheckFresh(
            lastCheck: defaults.double(forKey: lastCheckKey),
            now: Date().timeIntervalSince1970,
            lastStamp: defaults.string(forKey: lastCheckStampKey),
            stamp: stamp
        ) {
            if Self.usesEngine(installedCli: installedCliVersion),
               let data = defaults.data(forKey: cachedEngineResultKey),
               let cached = try? JSONDecoder().decode(UpdateEngineLine.self, from: data) {
                apply(engineResult: cached)
            } else {
                latestVersion = defaults.string(forKey: cachedVersionKey)
                latestCliVersion = defaults.string(forKey: cachedCliVersionKey)
            }
            return
        }
        await check()
        // Only the background poll notifies; a manual check already shows its result.
        await notifyIfUpdateAvailable(
            appVersion: updateAvailable ? latestVersion : nil,
            cliVersion: cliUpdateAvailable ? latestCliVersion : nil
        )
    }

    func check() async {
        updateError = nil
        updateFailureStage = nil
        installedCliVersion = Self.queryInstalledCliVersion()
        if Self.usesEngine(installedCli: installedCliVersion) {
            await checkWithEngine()
            return
        }
        engineResult = nil
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
            let version: String
            if let feedVersion = await Self.fetchFeedVersion() {
                version = feedVersion
            } else {
                guard let resolved = Self.resolveLatestMenubarRelease(in: releases) else {
                    throw UpdateCheckError.missingMenubarAsset
                }
                version = resolved.asset.name
                    .replacingOccurrences(of: "CodeBurnMenubar-", with: "")
                    .replacingOccurrences(of: ".zip", with: "")
            }

            let cliVersion = Self.resolveLatestCliVersion(in: releases)

            latestVersion = version
            latestCliVersion = cliVersion
            stampCheck()
            defaults.set(version, forKey: cachedVersionKey)
            if let cliVersion { defaults.set(cliVersion, forKey: cachedCliVersionKey) }
        } catch {
            updateFailureStage = .check
            updateError = error.localizedDescription
            NSLog("CodeBurn: update check failed: \(error)")
        }
    }

    private func stampCheck() {
        defaults.set(Date().timeIntervalSince1970, forKey: lastCheckKey)
        defaults.set(Self.checkStamp(app: currentVersion, cli: installedCliVersion), forKey: lastCheckStampKey)
    }

    /// The engine reads npm for the CLI (so a GitHub release that beats the npm publish no
    /// longer advertises a CLI npm cannot serve) and the feeds for the menubar and desktop.
    private func checkWithEngine() async {
        let (status, lines, stderr) = await withCheckedContinuation { continuation in
            Self.runEngine(["--check", "--json"], timeoutSeconds: engineCheckTimeoutSeconds) { status, lines, stderr in
                continuation.resume(returning: (status, lines, stderr))
            }
        }
        guard let result = lines.last(where: { $0.type == "result" }) else {
            updateFailureStage = .check
            updateError = stderr.isEmpty ? L("Update failed (exit %lld)", status) : stderr
            NSLog("CodeBurn: update check failed (exit \(status)): \(stderr)")
            return
        }
        apply(engineResult: result)
        stampCheck()
        if let data = try? JSONEncoder().encode(result) { defaults.set(data, forKey: cachedEngineResultKey) }
    }

    private func apply(engineResult result: UpdateEngineLine) {
        engineResult = result
        latestVersion = result.components?["menubar"]?.latest
        latestCliVersion = result.components?["cli"]?.latest
    }

    /// Marks the notifications a tap should install an update from. Other
    /// posters share the notification delegate.
    nonisolated static let notificationIdentifierPrefix = "UpdateChecker."

    /// Posts at most one notification per new version pair; the next repoll
    /// finds the same pair stamped and stays quiet.
    func notifyIfUpdateAvailable(appVersion: String?, cliVersion: String?) async {
        guard UpdateNotificationPreference.isEnabled(defaults: defaults) else { return }
        guard let copy = Self.updateNotificationCopy(appVersion: appVersion, cliVersion: cliVersion) else { return }
        let stamp = "\(appVersion ?? "-")|\(cliVersion ?? "-")"
        guard defaults.string(forKey: lastNotifiedVersionsKey) != stamp else { return }
        let notifier = notifier ?? makeNotifier()
        self.notifier = notifier
        guard await notifier.requestAuthorizationIfNeeded() else { return }
        notifier.post(title: copy.title, body: copy.body, identifier: "\(Self.notificationIdentifierPrefix)\(stamp)")
        defaults.set(stamp, forKey: lastNotifiedVersionsKey)
    }

    nonisolated static func updateNotificationCopy(appVersion: String?, cliVersion: String?) -> (title: String, body: String)? {
        switch (appVersion, cliVersion) {
        case let (app?, cli?):
            return (L("CodeBurn %@ available", AppVersion.display(app)), L("App and CLI %@ updates are ready. Click to install.", AppVersion.display(cli)))
        case let (app?, nil):
            return (L("CodeBurn %@ available", AppVersion.display(app)), L("Click to install the update."))
        case let (nil, cli?):
            return (L("CodeBurn CLI %@ available", AppVersion.display(cli)), L("Click to install the update."))
        case (nil, nil):
            return nil
        }
    }

    nonisolated static func fetchFeedVersion() async -> String? {
        guard let url = URL(string: menubarFeedURL) else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        request.setValue("codeburn-menubar-updater", forHTTPHeaderField: "User-Agent")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200
        else { return nil }
        return menubarVersion(fromFeed: data)
    }

    /// Nil unless the feed names a version and points at that version's mac-v* release zip.
    nonisolated static func menubarVersion(fromFeed data: Data) -> String? {
        guard let feed = try? JSONDecoder().decode(MenubarFeed.self, from: data) else { return nil }
        let version = AppVersion.normalize(feed.version)
        guard !version.isEmpty,
              feed.url == "\(menubarAssetURLPrefix)\(version)/CodeBurnMenubar-v\(version).zip"
        else { return nil }
        return "v\(version)"
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

    /// True when the CLI launcher resolves into a Homebrew cellar.
    ///
    /// The launcher's own directory is not enough to tell brew from npm: Homebrew's
    /// Node sets the npm global prefix to the Homebrew prefix, so an
    /// `npm install -g codeburn` lands at `<prefix>/bin/codeburn` and points at
    /// `<prefix>/lib/node_modules/codeburn`. A directory test sees `/homebrew/`
    /// there and picks brew, which has no codeburn formula to upgrade.
    nonisolated static func isHomebrewInstall(
        cliPath: String,
        resolvingSymlinks: (String) -> String = { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path }
    ) -> Bool {
        let resolved = resolvingSymlinks(cliPath)
        if resolved.contains("/Cellar/codeburn/") { return true }
        if resolved.contains("/node_modules/codeburn/") { return false }
        return cliPath.contains("/homebrew/") || cliPath.contains("/Cellar/")
    }

    /// The package-manager invocation that updates the CLI in place, derived
    /// from where the running CLI binary actually lives. Returns nil when no
    /// known manager is recognizable; callers fall back to showing the manual
    /// command rather than guessing at a mutation.
    nonisolated static func cliUpdateInvocation(
        cliPath: String,
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
        resolvingSymlinks: (String) -> String = { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path }
    ) -> [String]? {
        let dir = (cliPath as NSString).deletingLastPathComponent
        if isHomebrewInstall(cliPath: cliPath, resolvingSymlinks: resolvingSymlinks) {
            for brew in ["\(dir)/brew", "/opt/homebrew/bin/brew", "/usr/local/bin/brew"] where fileExists(brew) {
                return [brew, "upgrade", "codeburn"]
            }
            return nil
        }
        // npm-managed installs (plain npm -g, nvm, volta, asdf shims) keep npm
        // in the same bin directory as the codeburn launcher.
        for npm in ["\(dir)/npm", "/opt/homebrew/bin/npm", "/usr/local/bin/npm"] where fileExists(npm) {
            return [npm, "install", "-g", "codeburn@latest", "--force"]
        }
        return nil
    }

    /// The launcher the CodeBurn desktop app writes for the CLI it carries
    /// (app/electron/mac-menubar.ts), or the one inside its bundle. Only a desktop
    /// app update moves either.
    nonisolated static func isDesktopBundledCli(_ cliPath: String) -> Bool {
        (cliPath as NSString).lastPathComponent == "codeburn-desktop-cli.sh"
            || cliPath.hasSuffix("/CodeBurn.app/Contents/Resources/cli/codeburn")
    }

    /// `codeburn menubar --force` installs the menubar matching the CLI's own
    /// version, so without a CLI update it only moves the app forward when the
    /// CLI is already ahead of it.
    nonisolated static func menubarInstallAdvances(installedCli: String?, app: String) -> Bool {
        guard let installedCli else { return false }
        let cli = AppVersion.normalize(installedCli)
        let current = AppVersion.normalize(app)
        guard !cli.isEmpty, !current.isEmpty, current != "dev" else { return false }
        return cli.compare(current, options: .numeric) == .orderedDescending
    }

    nonisolated static func cliUpdateFailureMessage(stderr: String, status: Int32, manualCommand: String) -> String {
        if stderr.contains("EACCES") || stderr.contains("EPERM") {
            return L("npm does not have permission to update the global codeburn install. Run “%@” in Terminal, then try again.", manualCommand)
        }
        return stderr.isEmpty ? L("CLI update failed (exit %lld)", status) : stderr
    }

    /// One click, both updates: the CLI first (so the new `menubar --force`
    /// installer runs from the version it ships with), then the app itself.
    /// Each stage surfaces its own error and stops the sequence.
    func performFullUpdate() {
        installedCliVersion = Self.queryInstalledCliVersion()
        guard !isUpdating else { return }
        if Self.usesEngine(installedCli: installedCliVersion) {
            performEngineUpdate()
            return
        }

        if cliUpdateAvailable || cliTooOldForUpdate {
            updateError = nil
            updateFailureStage = nil
            let cliPath = CodeburnCLI.baseArgv().first ?? ""
            let bundled = Self.isDesktopBundledCli(cliPath)
            guard !bundled, let argv = Self.cliUpdateInvocation(cliPath: cliPath), let bin = argv.first else {
                if updateAvailable && !cliTooOldForUpdate
                    && Self.menubarInstallAdvances(installedCli: installedCliVersion, app: currentVersion) {
                    performUpdate()
                    return
                }
                updateFailureStage = .cliUpdate
                updateError = bundled
                    ? L("This codeburn CLI comes with the CodeBurn desktop app. Update the desktop app, then try again.")
                    : L(
                        "Could not find the package manager for %1$@. Run “%2$@” manually, then try again.",
                        cliPath.isEmpty ? L("the CLI") : cliPath,
                        cliUpdateCommand
                    )
                return
            }
            isUpdating = true
            let process = Process()
            process.executableURL = URL(fileURLWithPath: bin)
            process.arguments = Array(argv.dropFirst())
            runCaptured(process) { [weak self] status, stderr in
                Task { @MainActor in
                    guard let self else { return }
                    if status != 0 {
                        self.isUpdating = false
                        self.updateFailureStage = .cliUpdate
                        self.updateError = Self.cliUpdateFailureMessage(stderr: stderr, status: status, manualCommand: self.cliUpdateCommand)
                        NSLog("CodeBurn: CLI update failed (exit \(status)): \(stderr)")
                        return
                    }
                    self.installedCliVersion = Self.queryInstalledCliVersion()
                    self.latestCliVersion = self.installedCliVersion ?? self.latestCliVersion
                    self.isUpdating = false
                    if self.updateAvailable {
                        self.performUpdate()
                    }
                }
            }
            return
        }

        if updateAvailable { performUpdate() }
    }

    /// One engine run covers every component: the global CLI, then the menubar (the installer
    /// relaunches this app after the engine exits, as `menubar --force` always has), then the
    /// desktop through its own updater. A desktop launcher CLI is fine here: the engine aims
    /// `--cli` at the global CLI and hands the desktop to itself.
    private func performEngineUpdate() {
        isUpdating = true
        updateError = nil
        updateFailureStage = nil
        updateFailureCommand = nil
        updatingComponent = nil
        engineFailure = nil
        menubarReplaced = false
        // Main-queue hops keep the lines in order; unstructured Tasks would not promise that.
        Self.runEngine(["--all", "--json"], timeoutSeconds: engineUpdateTimeoutSeconds, onLine: { [weak self] line in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.handleEngineStep(line) } }
        }, onExit: { [weak self] status, _, stderr in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.finishEngineUpdate(status: status, stderr: stderr) } }
        })
    }

    func handleEngineStep(_ line: UpdateEngineLine) {
        guard line.type == "step", let component = line.component else { return }
        switch line.state {
        case "start", "progress":
            updatingComponent = component
            // The pending marker is what reports the menubar's own outcome after the relaunch.
            if component == "menubar", line.state == "start", let to = line.to {
                defaults.set(["from": AppVersion.normalize(currentVersion), "to": AppVersion.normalize(to)], forKey: pendingUpdateKey)
            }
        case "done":
            if component == "menubar" { menubarReplaced = true }
        case "skipped":
            if component == "menubar" { defaults.removeObject(forKey: pendingUpdateKey) }
        case "error":
            if component == "menubar" { failPendingUpdate(outcome: Self.engineTelemetryOutcome(code: line.code)) }
            if engineFailure == nil { engineFailure = line }
        default:
            break
        }
    }

    func finishEngineUpdate(status: Int32, stderr: String) {
        let lastComponent = updatingComponent
        isUpdating = false
        updatingComponent = nil
        if let failure = engineFailure {
            let message = Self.sanitizeForDisplay(failure.message ?? "")
            updateFailureStage = Self.failureStage(component: failure.component)
            updateError = message.isEmpty ? L("Update failed (exit %lld)", status) : message
            updateFailureCommand = failure.command.map(Self.sanitizeForDisplay)
            NSLog("CodeBurn: update failed at \(failure.component ?? "?") (\(failure.code ?? "?")): \(message)")
            return
        }
        // Once the menubar is placed the relaunch can stop this app or cut the stream before the
        // final result; the pending marker settles the outcome in the relaunched copy.
        guard status == 0 || menubarReplaced else {
            updateFailureStage = Self.failureStage(component: lastComponent)
            updateError = stderr.isEmpty ? L("Update failed (exit %lld)", status) : stderr
            NSLog("CodeBurn: update failed (exit \(status)): \(stderr)")
            return
        }
        latestVersion = nil
        latestCliVersion = nil
        engineResult = nil
        // Re-check on the next poll so the pill reflects what actually landed.
        defaults.removeObject(forKey: lastCheckKey)
    }

    nonisolated static func failureStage(component: String?) -> UpdateFailureStage {
        switch component ?? "" {
        case "menubar": .menubarUpdate
        case "desktop": .desktopUpdate
        default: .cliUpdate
        }
    }

    /// Only the outcomes `update_result` already sends; everything else counts as install_fail.
    nonisolated static func engineTelemetryOutcome(code: String?) -> String {
        let code = code ?? ""
        return code == "verify_fail" || code == "download_fail" ? code : "install_fail"
    }

    /// Streams `codeburn update <arguments>`; `onExit` runs once the process has exited and
    /// its stdout is drained (or 2s later, should a grandchild keep the pipe open).
    nonisolated static func runEngine(
        _ arguments: [String],
        timeoutSeconds: UInt64,
        onLine: @escaping @Sendable (UpdateEngineLine) -> Void = { _ in },
        onExit: @escaping @Sendable (Int32, [UpdateEngineLine], String) -> Void
    ) {
        let process = CodeburnCLI.makeProcess(subcommand: ["update"] + arguments)
        let outPipe = Pipe()
        let errPipe = Pipe()
        let reader = UpdateEngineLineReader()
        let errBuffer = LockedDataBuffer()
        let drained = DispatchGroup()
        drained.enter()
        let finish: @Sendable () -> Void = {
            guard let tail = reader.finish() else { return }
            outPipe.fileHandleForReading.readabilityHandler = nil
            tail.forEach(onLine)
            drained.leave()
        }
        process.standardOutput = outPipe
        process.standardError = errPipe
        outPipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty { finish() } else { reader.append(chunk).forEach(onLine) }
        }
        errPipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else { return }
            errBuffer.append(chunk, limit: maxUpdateStderrBytes)
        }
        let timeoutTask = Task.detached(priority: .utility) {
            try? await Task.sleep(nanoseconds: timeoutSeconds * 1_000_000_000)
            if process.isRunning {
                NSLog("CodeBurn: update subprocess timed out after %llus - terminating", timeoutSeconds)
                process.terminate()
            }
        }
        process.terminationHandler = { proc in
            timeoutTask.cancel()
            errPipe.fileHandleForReading.readabilityHandler = nil
            let status = proc.terminationStatus
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) { finish() }
            drained.notify(queue: .global()) {
                let stderr = Self.sanitizeForDisplay(String(data: errBuffer.snapshot(), encoding: .utf8) ?? "")
                onExit(status, reader.lines, stderr)
            }
        }
        do {
            try process.run()
        } catch {
            timeoutTask.cancel()
            outPipe.fileHandleForReading.readabilityHandler = nil
            errPipe.fileHandleForReading.readabilityHandler = nil
            onExit(-1, [], error.localizedDescription)
        }
    }

    /// Shared spawn-with-timeout-and-stderr-capture used by both update stages.
    nonisolated private func runCaptured(_ process: Process, onExit: @escaping @Sendable (Int32, String) -> Void) {
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
            try? await Task.sleep(nanoseconds: cliUpdateTimeoutSeconds * 1_000_000_000)
            if process.isRunning {
                NSLog("CodeBurn: update subprocess timed out after %llus - terminating", cliUpdateTimeoutSeconds)
                process.terminate()
            }
        }
        process.terminationHandler = { proc in
            timeoutTask.cancel()
            errPipe.fileHandleForReading.readabilityHandler = nil
            let stderr = Self.sanitizeForDisplay(String(data: errBuffer.snapshot(), encoding: .utf8) ?? "")
            onExit(proc.terminationStatus, stderr)
        }
        do {
            try process.run()
        } catch {
            timeoutTask.cancel()
            errPipe.fileHandleForReading.readabilityHandler = nil
            onExit(-1, error.localizedDescription)
        }
    }

    func performUpdate() {
        installedCliVersion = Self.queryInstalledCliVersion()
        if cliTooOldForUpdate {
            updateFailureStage = .menubarUpdate
            updateError = L(
                "Your codeburn CLI (%1$@) is too old to update the menubar. Run “%2$@” first, then try again.",
                AppVersion.display(installedCliVersion ?? ""),
                cliUpdateCommand
            )
            return
        }
        isUpdating = true
        updateError = nil
        updateFailureStage = nil
        // `menubar --force` installs the CLI's own version, so that is the target; when it
        // is not ahead of this app the run cannot move it, and there is nothing to settle.
        if Self.menubarInstallAdvances(installedCli: installedCliVersion, app: currentVersion),
           let installedCliVersion {
            defaults.set(
                ["from": AppVersion.normalize(currentVersion), "to": AppVersion.normalize(installedCliVersion)],
                forKey: pendingUpdateKey
            )
        }

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
            try? await Task.sleep(nanoseconds: menubarUpdateTimeoutSeconds * 1_000_000_000)
            if process.isRunning {
                NSLog("CodeBurn: update subprocess timed out after %llus - terminating", menubarUpdateTimeoutSeconds)
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
                    self.failPendingUpdate(outcome: Self.updateFailureOutcome(stderr: stderr))
                    self.updateFailureStage = .menubarUpdate
                    self.updateError = stderr.isEmpty ? L("Update failed (exit %lld)", proc.terminationStatus) : stderr
                    NSLog("CodeBurn: update failed (exit \(proc.terminationStatus)): \(stderr)")
                } else {
                    self.latestVersion = nil
                }
            }
        }

        do {
            try process.run()
        } catch {
            failPendingUpdate(outcome: "install_fail")
            isUpdating = false
            updateFailureStage = .menubarUpdate
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
        case let .http(status): L("GitHub returned HTTP %lld.", status)
        case .missingMenubarAsset: L("No mac-v release with a menubar zip and checksum was found.")
        }
    }
}

struct MenubarFeed: Decodable {
    let version: String
    let url: String
}

struct GitHubRelease: Decodable {
    let tag_name: String
    let assets: [GitHubAsset]
}

struct GitHubAsset: Decodable {
    let name: String
    let browser_download_url: String
}
