import SwiftUI
import AppKit
import Observation
import UserNotifications

private let forceRefreshWatchdogSeconds: TimeInterval = 90
private let refreshLoopWatchdogSeconds: TimeInterval = 90
private let statusPayloadRefreshWatchdogSeconds: TimeInterval = 60
private let refreshRateLimitSeconds: TimeInterval = 5
private let interactiveQuotaRefreshFloorSeconds: TimeInterval = 30
private let statusItemWidth: CGFloat = NSStatusItem.variableLength
private let popoverWidth: CGFloat = 360
private let popoverHeight: CGFloat = 660
private let menubarTitleFontSize: CGFloat = 13

@main
struct CodeBurnApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate

    var body: some Scene {
        // Empty Settings scene satisfies SwiftUI's "at least one Scene" requirement
        // without creating visible windows. The actual settings UI is presented via
        // openSettings() which uses its own NSWindow + NavigationSplitView sidebar.
        // DO NOT put SettingsView() here — macOS auto-converts NavigationSplitView
        // sidebar items into toolbar tabs that overflow into a >> chevron.
        Settings { EmptyView() }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    private var statusItem: NSStatusItem!
    private var popover: NSPopover!
    fileprivate let store = AppStore()
    let updateChecker = UpdateChecker()
    /// Held for the lifetime of the app to opt out of App Nap and Automatic Termination.
    private var backgroundActivity: NSObjectProtocol?
    private var pendingRefreshWork: DispatchWorkItem?
    private var refreshTimer: DispatchSourceTimer?
    private var forceRefreshTask: Task<Void, Never>?
    private var forceRefreshStartedAt: Date?
    private var forceRefreshGeneration: UInt64 = 0
    private var statusPayloadRefreshTask: Task<Void, Never>?
    private var statusPayloadRefreshStartedAt: Date?
    private var statusPayloadRefreshGeneration: UInt64 = 0
    private var manualRefreshTask: Task<Void, Never>?
    private var manualRefreshGeneration: UInt64 = 0
    private var claudeQuotaRefreshTask: Task<Bool, Never>?
    private var codexQuotaRefreshTask: Task<Bool, Never>?
    private var refreshLoopHeartbeatAt: Date = .distantPast
    private var lastLaunchAgentHeartbeatAt: Date = .distantPast
    private var lastAppliedUsageRefreshCadence: UsageRefreshCadence?
    private var notifiedQuotaEventIDs: Set<String> = []
    private var quotaNotificationAuthorizationRequested = false
    private var historyWindowController: NSWindowController?

    func applicationWillFinishLaunching(_ notification: Notification) {
        // Set accessory policy before the app's focus chain forms. On macOS Tahoe
        // (26.x), setting it after didFinishLaunching causes ghost status items
        // because the policy gets baked into the initial focus chain.
        NSApp.setActivationPolicy(.accessory)
    }

    private func observeSubscriptionDisconnect() {
        NotificationCenter.default.addObserver(
            forName: .codeBurnSubscriptionDisconnected,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.resetSubscriptionCadenceAnchor()
            }
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        ProcessInfo.processInfo.automaticTerminationSupportEnabled = false
        ProcessInfo.processInfo.disableSuddenTermination()
        backgroundActivity = ProcessInfo.processInfo.beginActivity(
            options: [.automaticTerminationDisabled, .suddenTerminationDisabled],
            reason: "CodeBurn menubar background refresh"
        )

        restorePersistedCurrency()
        setupStatusItem()
        setupPopover()
        observeStore()
        startRefreshLoop()
        setupWakeObservers()
        setupDistributedNotificationListener()
        applyLaunchAgentSetting()
        StartAtLoginController.applyCurrentSetting()
        removeLegacyRefreshAgent()
        registerLoginItemIfNeeded()
        prepareQuotaNotificationsIfNeeded()
        observeSubscriptionDisconnect()
        Task { await updateChecker.checkIfNeeded() }
    }

    private func setupWakeObservers() {
        // Pause the refresh loop while the machine is asleep. Without this,
        // Task.sleep keeps a wakeup pending across the suspension and the
        // loop tick fires the same instant the wake notifications do,
        // producing 2-3 concurrent CLI spawns within ms of every wake.
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.willSleepNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.prepareRefreshPipelineForSleep()
            }
        }

        // didWakeNotification + screensDidWakeNotification can both fire on
        // the same wake. forceRefreshTask squashes overlap; both notifications
        // still bypass the short manual-click rate limit so a just-before-sleep
        // refresh cannot block wake recovery.
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.recoverRefreshPipelineAfterInterruption(resetLoading: true, reason: "wake")
            }
        }

        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.screensDidWakeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.recoverRefreshPipelineAfterInterruption(resetLoading: true, reason: "screen wake")
            }
        }
    }

    private func setupDistributedNotificationListener() {
        DistributedNotificationCenter.default().addObserver(
            forName: NSNotification.Name("com.codeburn.refresh"),
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.handleLaunchAgentHeartbeat()
            }
        }
    }

    private func handleLaunchAgentHeartbeat() {
        guard store.usageRefreshCadence.seconds != nil else { return }
        let now = Date()
        guard now.timeIntervalSince(lastLaunchAgentHeartbeatAt) >= refreshRateLimitSeconds else { return }
        lastLaunchAgentHeartbeatAt = now
        let loopAge = now.timeIntervalSince(refreshLoopHeartbeatAt)
        guard refreshTimer == nil || loopAge > refreshLoopWatchdogSeconds else {
            _ = store.clearStaleLoadingIfNeeded()
            _ = clearStaleForceRefreshIfNeeded(now: now)
            _ = clearStaleStatusPayloadRefreshIfNeeded(now: now)
            return
        }
        if refreshTimer != nil {
            NSLog("CodeBurn: refresh loop stale for %ds after launch agent - restarting", Int(loopAge))
        }
        startRefreshLoop(forceQuotaOnStart: false)
    }

    private func prepareRefreshPipelineForSleep() {
        // Leave the timer running: the kernel pauses DispatchSourceTimer during
        // sleep automatically and resumes it on wake. Tearing it down here
        // stranded the loop whenever a wake notification was missed.
        forceRefreshTask?.cancel()
        forceRefreshTask = nil
        forceRefreshStartedAt = nil
        forceRefreshGeneration &+= 1
        manualRefreshTask?.cancel()
        manualRefreshTask = nil
        manualRefreshGeneration &+= 1
        statusPayloadRefreshTask?.cancel()
        statusPayloadRefreshTask = nil
        statusPayloadRefreshStartedAt = nil
        statusPayloadRefreshGeneration &+= 1
        store.resetLoadingState()
        lastRefreshTime = .distantPast
    }

    private func recoverRefreshPipelineAfterInterruption(resetLoading: Bool, clearCache: Bool = false, reason: String) {
        if resetLoading {
            forceRefreshTask?.cancel()
            forceRefreshTask = nil
            forceRefreshStartedAt = nil
            forceRefreshGeneration &+= 1
            manualRefreshTask?.cancel()
            manualRefreshTask = nil
            manualRefreshGeneration &+= 1
            statusPayloadRefreshTask?.cancel()
            statusPayloadRefreshTask = nil
            statusPayloadRefreshStartedAt = nil
            statusPayloadRefreshGeneration &+= 1
            store.resetRefreshState(clearCache: clearCache)
        } else {
            _ = store.clearStaleLoadingIfNeeded()
        }
        let now = Date()
        let loopAge = now.timeIntervalSince(refreshLoopHeartbeatAt)
        if refreshTimer == nil || loopAge > refreshLoopWatchdogSeconds {
            if refreshTimer != nil {
                NSLog("CodeBurn: refresh loop stale for %ds after %@ - restarting", Int(loopAge), reason)
            }
            startRefreshLoop(forceQuotaOnStart: false)
        } else {
            runRefreshLoopTick(reason: reason, forcePayload: true, forceQuota: false)
        }
    }

    private func applyLaunchAgentSetting() {
        let cadence = store.usageRefreshCadence
        guard lastAppliedUsageRefreshCadence != cadence else { return }
        lastAppliedUsageRefreshCadence = cadence

        guard let seconds = cadence.seconds else {
            removeLaunchAgentIfNeeded()
            return
        }

        let fm = FileManager.default
        let agentName = "com.codeburn.refresh.plist"
        let home = fm.homeDirectoryForCurrentUser.path
        let destPath = "\(home)/Library/LaunchAgents/\(agentName)"

        let plist = """
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.codeburn.refresh</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/osascript</string>
        <string>-l</string>
        <string>JavaScript</string>
        <string>-e</string>
        <string>ObjC.import("Foundation"); $.NSDistributedNotificationCenter.defaultCenter.postNotificationNameObjectUserInfoDeliverImmediately("com.codeburn.refresh", $(), $(), true)</string>
    </array>
    <key>StartInterval</key>
    <integer>\(Int(seconds))</integer>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
"""

        do {
            let existing = try? String(contentsOfFile: destPath, encoding: .utf8)
            if existing == plist { return }

            try fm.createDirectory(atPath: "\(home)/Library/LaunchAgents", withIntermediateDirectories: true)
            try plist.write(toFile: destPath, atomically: true, encoding: .utf8)

            let unload = Process()
            unload.launchPath = "/bin/launchctl"
            unload.arguments = ["unload", destPath]
            try? unload.run()
            unload.waitUntilExit()

            let load = Process()
            load.launchPath = "/bin/launchctl"
            load.arguments = ["load", destPath]
            try load.run()
            load.waitUntilExit()
        } catch {
            NSLog("CodeBurn: LaunchAgent setup failed: \(error)")
        }
    }

    private func removeLaunchAgentIfNeeded() {
        let fm = FileManager.default
        let agentName = "com.codeburn.refresh.plist"
        let home = fm.homeDirectoryForCurrentUser.path
        let destPath = "\(home)/Library/LaunchAgents/\(agentName)"
        guard fm.fileExists(atPath: destPath) else { return }

        let unload = Process()
        unload.launchPath = "/bin/launchctl"
        unload.arguments = ["unload", destPath]
        try? unload.run()
        unload.waitUntilExit()
        try? fm.removeItem(atPath: destPath)
    }
    // Earlier builds installed a launchd job that re-fetched data out of process.
    // macOS attributes a launchd-spawned binary differently from the LaunchServices
    // app, so it triggered its own "access data from other apps" prompt on every
    // run. Remove any such leftover job on upgrade; the in-app loop is the source
    // of truth and writes the badge backstop file itself.
    private func removeLegacyRefreshAgent() {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser.path
        let destPath = "\(home)/Library/LaunchAgents/com.codeburn.refresh.plist"
        guard fm.fileExists(atPath: destPath) else { return }

        let unload = Process()
        unload.launchPath = "/bin/launchctl"
        unload.arguments = ["unload", destPath]
        try? unload.run()
        unload.waitUntilExit()
        try? fm.removeItem(atPath: destPath)
    }

    private func registerLoginItemIfNeeded() {
        let key = "codeburn.loginItemRegistered"
        guard !UserDefaults.standard.bool(forKey: key) else { return }

        let appPath = Bundle.main.bundlePath
        let script = "tell application \"System Events\" to make login item at end with properties {path:\(appleScriptStringLiteral(appPath)), hidden:false}"

        let process = Process()
        process.launchPath = "/usr/bin/osascript"
        process.arguments = ["-e", script]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            process.waitUntilExit()
            if process.terminationStatus == 0 {
                UserDefaults.standard.set(true, forKey: key)
            }
        } catch {
            NSLog("CodeBurn: Login item registration failed: \(error)")
        }
    }

    private func appleScriptStringLiteral(_ value: String) -> String {
        var escaped = value.replacingOccurrences(of: "\\", with: "\\\\")
        escaped = escaped.replacingOccurrences(of: "\"", with: "\\\"")
        escaped = escaped.replacingOccurrences(of: "\r", with: "")
        escaped = escaped.replacingOccurrences(of: "\n", with: "")
        return "\"\(escaped)\""
    }

    private var currentRefreshIntervalSeconds: UInt64? {
        store.usageRefreshCadence.seconds.map { UInt64($0) }
    }

    private var lastRefreshTime: Date = .distantPast

    @discardableResult
    private func clearStaleForceRefreshIfNeeded(now: Date = Date()) -> Bool {
        if forceRefreshTask != nil {
            guard let started = forceRefreshStartedAt else {
                NSLog("CodeBurn: force refresh task had no start timestamp - clearing")
                forceRefreshTask?.cancel()
                forceRefreshTask = nil
                forceRefreshGeneration &+= 1
                store.resetLoadingState()
                return true
            }
            let elapsed = now.timeIntervalSince(started)
            guard elapsed > forceRefreshWatchdogSeconds else { return false }
            NSLog("CodeBurn: force refresh stuck for %ds - cancelling and restarting", Int(elapsed))
            forceRefreshTask?.cancel()
            forceRefreshTask = nil
            forceRefreshStartedAt = nil
            forceRefreshGeneration &+= 1
            store.resetLoadingState()
            return true
        }
        return false
    }

    @discardableResult
    private func clearStaleStatusPayloadRefreshIfNeeded(now: Date = Date()) -> Bool {
        if statusPayloadRefreshTask != nil {
            guard let started = statusPayloadRefreshStartedAt else {
                NSLog("CodeBurn: today status refresh task had no start timestamp - clearing")
                statusPayloadRefreshTask?.cancel()
                statusPayloadRefreshTask = nil
                statusPayloadRefreshGeneration &+= 1
                return true
            }
            let elapsed = now.timeIntervalSince(started)
            guard elapsed > statusPayloadRefreshWatchdogSeconds else { return false }
            NSLog("CodeBurn: today status refresh stuck for %ds - cancelling", Int(elapsed))
            statusPayloadRefreshTask?.cancel()
            statusPayloadRefreshTask = nil
            statusPayloadRefreshStartedAt = nil
            statusPayloadRefreshGeneration &+= 1
            return true
        }
        return false
    }

    private func refreshStatusPayloadIfNeeded(reason: String, force: Bool = false) {
        let now = Date()
        _ = clearStaleStatusPayloadRefreshIfNeeded(now: now)
        guard statusPayloadRefreshTask == nil else { return }
        guard force || store.needsStatusPayloadRefresh else { return }

        let menubarPeriod = store.menubarPeriod
        if let age = store.menubarPayloadAgeSeconds, age > 120 {
            NSLog("CodeBurn: status payload stale for %ds on %@ refresh", age, reason)
        }

        statusPayloadRefreshStartedAt = now
        statusPayloadRefreshGeneration &+= 1
        let generation = statusPayloadRefreshGeneration
        statusPayloadRefreshTask = Task { [weak self] in
            guard let self else { return }
            await self.store.refreshQuietly(period: menubarPeriod, force: true)
            self.refreshStatusButton()
            guard self.statusPayloadRefreshGeneration == generation, !Task.isCancelled else { return }
            self.statusPayloadRefreshTask = nil
            self.statusPayloadRefreshStartedAt = nil
        }
    }

    private func forceRefresh(bypassRateLimit: Bool = false, forceQuota: Bool = false) {
        let now = Date()
        _ = clearStaleForceRefreshIfNeeded(now: now)
        if forceRefreshTask != nil {
            refreshStatusPayloadIfNeeded(reason: "blocked force refresh")
        }
        guard forceRefreshTask == nil else { return }
        if !bypassRateLimit {
            guard now.timeIntervalSince(lastRefreshTime) > refreshRateLimitSeconds else { return }
        }
        lastRefreshTime = now
        forceRefreshStartedAt = now
        forceRefreshGeneration &+= 1
        let generation = forceRefreshGeneration

        forceRefreshTask = Task {
            async let main: Void = refreshUsagePayloads(force: true, showLoading: true)
            async let quotas: Bool = refreshLiveQuotaProgressIfDue(force: forceQuota)
            _ = await main
            if popover.isShown {
                store.switchToMostUsedProviderIfAvailable()
            }
            refreshStatusButton()
            _ = await quotas
            await MainActor.run { [weak self] in
                guard let self, self.forceRefreshGeneration == generation else { return }
                self.forceRefreshTask = nil
                self.forceRefreshStartedAt = nil
                self.lastRefreshTime = Date()
            }
        }
    }

    private func refreshUsagePayloads(force: Bool, showLoading: Bool = false) async {
        let menubarPeriod = store.menubarPeriod
        let needsMenubarPayload = store.selectedPeriod != menubarPeriod || store.selectedProvider != .all
        let needsTodayPayload = (store.selectedPeriod != .today || store.selectedProvider != .all) && menubarPeriod != .today
        let needsMonthPayload = store.needsMonthlyQuotaPayloadRefresh &&
            store.selectedPeriod != .month &&
            menubarPeriod != .month

        async let visible: Void = store.refresh(includeOptimize: false, force: force, showLoading: showLoading)
        async let menubar: Void = needsMenubarPayload
            ? store.refreshQuietly(period: menubarPeriod, force: force)
            : ()
        async let today: Void = needsTodayPayload
            ? store.refreshQuietly(period: .today, force: force)
            : ()
        async let month: Void = needsMonthPayload
            ? store.refreshQuietly(period: .month, force: force)
            : ()
        _ = await (visible, menubar, today, month)
    }

    /// Loads the currency code persisted by `codeburn currency` so a relaunch picks up where
    /// the user left off. Rate is resolved from the on-disk FX cache if present, otherwise
    /// fetched live in the background.
    private func restorePersistedCurrency() {
        guard let code = CLICurrencyConfig.loadCode(), code != "USD" else { return }
        let symbol = CurrencyState.symbolForCode(code)
        store.currency = code

        Task {
            let cached = await FXRateCache.shared.cachedRate(for: code)
            await MainActor.run {
                CurrencyState.shared.apply(code: code, rate: cached, symbol: symbol)
            }
            let fresh = await FXRateCache.shared.rate(for: code)
            if let fresh, fresh != cached {
                await MainActor.run {
                    CurrencyState.shared.apply(code: code, rate: fresh, symbol: symbol)
                }
            }
        }
    }

    fileprivate var lastSubscriptionRefreshAt: Date?
    fileprivate var lastCodexRefreshAt: Date?

    @discardableResult
    private func refreshLiveQuotaProgressIfDue(force: Bool = false) async -> Bool {
        let cadence = SubscriptionRefreshCadence.current
        if !force && cadence == .manual { return false }

        let now = Date()
        let threshold = force ? 0 : TimeInterval(cadence.rawValue)
        let shouldRefreshClaude = force || now.timeIntervalSince(lastSubscriptionRefreshAt ?? .distantPast) >= threshold
        let shouldRefreshCodex = force || now.timeIntervalSince(lastCodexRefreshAt ?? .distantPast) >= threshold
        guard shouldRefreshClaude || shouldRefreshCodex else { return false }

        switch (shouldRefreshClaude, shouldRefreshCodex) {
        case (true, true):
            async let claude = refreshClaudeQuotaSingleFlight()
            async let codex = refreshCodexQuotaSingleFlight()
            if await claude { lastSubscriptionRefreshAt = Date() }
            if await codex { lastCodexRefreshAt = Date() }
        case (true, false):
            if await refreshClaudeQuotaSingleFlight() {
                lastSubscriptionRefreshAt = Date()
            }
        case (false, true):
            if await refreshCodexQuotaSingleFlight() {
                lastCodexRefreshAt = Date()
            }
        case (false, false):
            break
        }
        return true
    }

    private func refreshClaudeQuotaSingleFlight() async -> Bool {
        if let task = claudeQuotaRefreshTask {
            return await task.value
        }
        let task = Task { [store] in
            await store.refreshSubscriptionReportingSuccess()
        }
        claudeQuotaRefreshTask = task
        let result = await task.value
        if claudeQuotaRefreshTask != nil {
            claudeQuotaRefreshTask = nil
        }
        return result
    }

    private func refreshCodexQuotaSingleFlight() async -> Bool {
        if let task = codexQuotaRefreshTask {
            return await task.value
        }
        let task = Task { [store] in
            await store.refreshCodexReportingSuccess()
        }
        codexQuotaRefreshTask = task
        let result = await task.value
        if codexQuotaRefreshTask != nil {
            codexQuotaRefreshTask = nil
        }
        return result
    }

    private func refreshLiveQuotaProgressForPopoverOpen() {
        let now = Date()
        let claudeElapsed = now.timeIntervalSince(lastSubscriptionRefreshAt ?? .distantPast)
        let codexElapsed = now.timeIntervalSince(lastCodexRefreshAt ?? .distantPast)
        guard claudeElapsed >= interactiveQuotaRefreshFloorSeconds ||
              codexElapsed >= interactiveQuotaRefreshFloorSeconds else { return }

        Task { [weak self] in
            guard let self else { return }
            _ = await self.refreshLiveQuotaProgressIfDue(force: true)
        }
    }

    private func refreshPayloadForPopoverOpen() {
        // A user viewing the popover is ground truth: unconditionally ensure the
        // loop is alive, then clear any stuck loading / in-flight state for the
        // current key and force a fresh fetch.
        if refreshTimer == nil {
            startRefreshLoop(forceQuotaOnStart: false, refreshImmediately: false)
        }
        if store.shouldResetInteractiveRefreshPipeline,
           let age = store.staleInteractivePayloadAgeSeconds {
            NSLog("CodeBurn: popover opened with %ds stale payload cache - hard recovery", age)
        }
        forceRefreshTask?.cancel()
        forceRefreshTask = nil
        forceRefreshStartedAt = nil
        forceRefreshGeneration &+= 1
        store.resetLoadingState()
        forceRefresh(bypassRateLimit: true)
    }

    private func stopRefreshTimer() {
        refreshTimer?.setEventHandler {}
        refreshTimer?.cancel()
        refreshTimer = nil
    }

    private func runRefreshLoopTick(reason: String, forcePayload: Bool = false, forceQuota: Bool = false) {
        refreshLoopHeartbeatAt = Date()
        let hadForceRefreshInFlight = forceRefreshTask != nil
        let clearedStaleForceRefresh = clearStaleForceRefreshIfNeeded()
        let clearedStaleStatusRefresh = clearStaleStatusPayloadRefreshIfNeeded()
        let clearedStaleLoading = store.clearStaleLoadingIfNeeded()
        let statusPayloadStale = store.needsStatusPayloadRefresh
        let sinceLast = Date().timeIntervalSince(lastRefreshTime)
        let interval = currentRefreshIntervalSeconds.map(TimeInterval.init) ?? .greatestFiniteMagnitude
        let shouldForceRefresh = forcePayload ||
            clearedStaleForceRefresh ||
            clearedStaleLoading ||
            sinceLast >= interval

        if shouldForceRefresh {
            forceRefresh(bypassRateLimit: true, forceQuota: forceQuota)
        }

        let forceRefreshWasBlocked = hadForceRefreshInFlight && forceRefreshTask != nil
        if statusPayloadStale && (!shouldForceRefresh || forceRefreshWasBlocked || clearedStaleStatusRefresh) {
            refreshStatusPayloadIfNeeded(reason: reason, force: forcePayload)
        }
    }

    private func startRefreshLoop(forceQuotaOnStart: Bool = false, refreshImmediately: Bool = true) {
        stopRefreshTimer()
        if refreshImmediately {
            runRefreshLoopTick(reason: "start", forcePayload: true, forceQuota: forceQuotaOnStart)
        } else {
            refreshLoopHeartbeatAt = Date()
        }
        guard let refreshIntervalSeconds = currentRefreshIntervalSeconds else {
            refreshLoopHeartbeatAt = Date()
            return
        }

        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(
            deadline: .now() + .seconds(Int(refreshIntervalSeconds)),
            repeating: .seconds(Int(refreshIntervalSeconds)),
            leeway: .seconds(2)
        )
        timer.setEventHandler { [weak self] in
            Task { @MainActor [weak self] in
                self?.runRefreshLoopTick(reason: "timer")
            }
        }
        refreshTimer = timer
        refreshLoopHeartbeatAt = Date()
        timer.resume()
    }

    @MainActor
    func refreshSubscriptionNow() {
        manualRefreshTask?.cancel()
        manualRefreshGeneration &+= 1
        let generation = manualRefreshGeneration
        forceRefreshTask?.cancel()
        forceRefreshTask = nil
        forceRefreshStartedAt = nil
        forceRefreshGeneration &+= 1
        statusPayloadRefreshTask?.cancel()
        statusPayloadRefreshTask = nil
        statusPayloadRefreshStartedAt = nil
        statusPayloadRefreshGeneration &+= 1
        pendingRefreshWork?.cancel()
        pendingRefreshWork = nil
        stopRefreshTimer()
        store.resetRefreshState(clearCache: true)
        lastRefreshTime = .distantPast
        refreshStatusButton()

        manualRefreshTask = Task { [weak self] in
            guard let self else { return }
            // "Refresh Now" should refresh the menubar payload AND every
            // connected provider's live quota. The user's intent is "make
            // this match reality right now."
            async let payload: Void = self.refreshUsagePayloads(force: true, showLoading: true)
            async let quotas: Bool = self.refreshLiveQuotaProgressIfDue(force: true)
            _ = await payload
            guard self.manualRefreshGeneration == generation, !Task.isCancelled else { return }
            self.lastRefreshTime = Date()
            if self.popover.isShown {
                self.store.switchToMostUsedProviderIfAvailable()
            }
            self.refreshStatusButton()
            _ = await quotas
            guard self.manualRefreshGeneration == generation, !Task.isCancelled else { return }
            self.manualRefreshTask = nil
            if self.refreshTimer == nil {
                self.startRefreshLoop(refreshImmediately: false)
            }
        }
    }

    /// Reset the cadence anchor so the next loop tick re-evaluates from "now"
    /// rather than measuring against a timestamp from the previous connection.
    /// Triggered on disconnect of any provider — the cost of clearing both
    /// anchors is one extra refresh tick on the unaffected provider, far less
    /// disruptive than waiting a full cadence after a reconnect.
    @MainActor
    func resetSubscriptionCadenceAnchor() {
        lastSubscriptionRefreshAt = nil
        lastCodexRefreshAt = nil
    }

    private func observeStore() {
        // Only track properties that affect the menubar title or notifications.
        // Settings-only changes (keychainAccess, hidePersonalInfo, startAtLogin)
        // don't need to trigger a menubar refresh.
        withObservationTracking { [weak self] in
            guard let self else { return }
            _ = self.store.payload
            _ = self.store.menubarPeriod
            _ = self.store.menubarPayload
            _ = self.store.currency
            _ = self.store.displayMetric
            _ = self.store.dailyBudget
            _ = self.store.monthlyQuota
            _ = self.store.quotaWarningThreshold
            _ = self.store.quotaNotificationsEnabled
            _ = self.store.usageRefreshCadence
            _ = self.store.autoShowMostUsedProvider
            _ = self.store.quotaDisplayMode
            _ = self.store.quotaWarningEvents
            _ = self.store.subscription
            _ = self.store.subscriptionLoadState
            _ = self.store.codexUsage
            _ = self.store.codexLoadState
        } onChange: { [weak self] in
            DispatchQueue.main.async {
                guard let self else { return }
                self.pendingRefreshWork?.cancel()
                let work = DispatchWorkItem { [weak self] in
                    guard let self else { return }
                    self.applyRefreshSettingsIfNeeded()
                    self.prepareQuotaNotificationsIfNeeded()
                    self.deliverQuotaNotificationsIfNeeded()
                    self.refreshStatusButton()
                    self.observeStore()
                }
                self.pendingRefreshWork = work
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05, execute: work)
            }
        }
    }

    private func applyRefreshSettingsIfNeeded() {
        guard lastAppliedUsageRefreshCadence != store.usageRefreshCadence else { return }
        applyLaunchAgentSetting()
        startRefreshLoop(forceQuotaOnStart: false)
    }

    private func prepareQuotaNotificationsIfNeeded() {
        guard store.quotaNotificationsEnabled else { return }
        guard !quotaNotificationAuthorizationRequested else { return }
        quotaNotificationAuthorizationRequested = true
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { [weak self] granted, error in
            if let error {
                NSLog("CodeBurn: quota notification authorization failed: %@", String(describing: error))
            } else if !granted {
                NSLog("CodeBurn: quota notification authorization was not granted")
            } else {
                Task { @MainActor [weak self] in
                    self?.deliverQuotaNotificationsIfNeeded()
                }
            }
        }
    }

    private func deliverQuotaNotificationsIfNeeded() {
        guard store.quotaNotificationsEnabled else { return }
        let events = store.quotaWarningEvents
        notifiedQuotaEventIDs.formIntersection(Set(events.map(\.id)))
        for event in events where !notifiedQuotaEventIDs.contains(event.id) {
            notifiedQuotaEventIDs.insert(event.id)
            let content = UNMutableNotificationContent()
            content.title = event.title
            content.body = event.body
            content.sound = notificationSound(for: event.severity)
            let request = UNNotificationRequest(
                identifier: "codeburn.quota.\(event.id)",
                content: content,
                trigger: nil
            )
            UNUserNotificationCenter.current().add(request) { error in
                if let error {
                    NSLog("CodeBurn: quota notification delivery failed: %@", String(describing: error))
                }
            }
        }
    }

    private func notificationSound(for severity: QuotaSummary.Severity) -> UNNotificationSound? {
        switch severity {
        case .normal: return nil
        case .warning, .critical, .danger: return .default
        }
    }

    // MARK: - Status Item

    private var isCompact: Bool {
        UserDefaults.standard.bool(forKey: "CodeBurnMenubarCompact")
    }

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: statusItemWidth)
        guard let button = statusItem.button else { return }

        // Set a simple SF Symbol image immediately to ensure the status item renders.
        // On macOS Tahoe, status items may fail to appear if only an attributed title
        // is set during initial setup.
        let flameConfig = NSImage.SymbolConfiguration(pointSize: menubarTitleFontSize, weight: .medium)
        let flame = NSImage(systemSymbolName: "flame.fill", accessibilityDescription: "CodeBurn")?
            .withSymbolConfiguration(flameConfig)
        flame?.isTemplate = true
        button.image = flame
        button.imagePosition = .imageLeading

        button.target = self
        button.action = #selector(handleButtonClick(_:))
        button.sendAction(on: [.leftMouseUp, .rightMouseUp])

        // Defer the full attributed title setup to ensure initial render completes
        DispatchQueue.main.async { [weak self] in
            self?.refreshStatusButton()
        }
    }

    /// Composes the menubar title as a single attributed string with the flame as an inline
    /// NSTextAttachment. NSStatusItem's separate `image` + `attributedTitle` path leaves a
    /// stubborn gap between icon and text on some macOS releases (the icon hugs the left edge
    /// of the status item, the title starts at its own baseline), so we inline both so they
    /// flow as one typographic unit with a single, controllable gap.
    private static func flameTint(for severity: QuotaSummary.Severity) -> NSColor? {
        switch severity {
        case .normal:   return nil                              // template, auto-adapt
        case .warning:  return NSColor.systemYellow            // 70-90%
        case .critical: return NSColor.systemOrange            // 90-100%
        case .danger:   return NSColor.systemRed               // 100%+
        }
    }

    // Cached inputs for refreshStatusButton to avoid redundant NSAttributedString rebuilds
    private var lastMenubarInputs: (metric: DisplayMetric, period: Period, cost: Double?, severity: QuotaSummary.Severity, compact: Bool, quotaLabel: String?, granularity: CostGranularity, showSuffix: Bool, icon: MenubarIcon)?

    private func refreshStatusButton() {
        guard let button = statusItem.button else { return }
        // Skip while the popover is anchored to this button. Rewriting the
        // attributedTitle changes the button's intrinsic width, which makes
        // macOS reflow the status item in the menubar and detaches the
        // anchored popover (it pops to a stale default position). The
        // popoverDidClose delegate calls back through here once the popover
        // is dismissed so the menubar cost catches up immediately on close.
        if popover != nil && popover.isShown { return }

        // Skip rebuild if the inputs that affect the rendered title are unchanged
        let currentInputs: (metric: DisplayMetric, period: Period, cost: Double?, severity: QuotaSummary.Severity, compact: Bool, quotaLabel: String?, granularity: CostGranularity, showSuffix: Bool, icon: MenubarIcon) = (
            store.displayMetric,
            store.menubarPeriod,
            store.menubarPayload?.current.cost,
            store.aggregateQuotaStatus.severity,
            isCompact,
            store.quotaRemainingLabel,
            store.costGranularity,
            store.showMenubarSuffix,
            store.menubarIcon
        )
        if let last = lastMenubarInputs,
           last.metric == currentInputs.metric,
           last.period == currentInputs.period,
           last.cost == currentInputs.cost,
           last.severity == currentInputs.severity,
           last.compact == currentInputs.compact,
           last.quotaLabel == currentInputs.quotaLabel,
           last.granularity == currentInputs.granularity,
           last.showSuffix == currentInputs.showSuffix,
           last.icon == currentInputs.icon {
            return
        }
        lastMenubarInputs = currentInputs

        // Clear any previously-set image so the attachment is the only glyph rendered.
        button.image = nil
        button.imagePosition = .noImage

        let font = NSFont.monospacedDigitSystemFont(ofSize: menubarTitleFontSize, weight: .medium)
        let baseConfig = NSImage.SymbolConfiguration(pointSize: menubarTitleFontSize, weight: .medium)
        // Tint the flame based on the worst connected-provider or spend quota
        // that crossed the user's warning threshold. Normal keeps the template
        // so the icon follows the menu bar appearance.
        let aggregate = store.aggregateQuotaStatus
        var tint = Self.flameTint(for: aggregate.severity)
        if tint == nil, store.quotaWarningEvents.contains(where: { $0.id.hasPrefix("daily:") || $0.id.hasPrefix("monthly:") }) {
            tint = NSColor.systemYellow
        }
        let flameConfig: NSImage.SymbolConfiguration
        if let tint {
            flameConfig = baseConfig.applying(.init(paletteColors: [tint]))
        } else {
            flameConfig = baseConfig
        }
        let flame = NSImage(systemSymbolName: store.menubarIcon.systemName, accessibilityDescription: "CodeBurn")?
            .withSymbolConfiguration(flameConfig)
        flame?.isTemplate = (tint == nil)

        let attachment = NSTextAttachment()
        attachment.image = flame
        if let size = flame?.size {
            attachment.bounds = CGRect(x: 0, y: -3, width: size.width, height: size.height)
        }

        let menubarPeriod = store.menubarPeriod
        let menubarPayload = store.menubarPayload
        let hasPayload = menubarPayload != nil || (store.displayMetric == .quotaRemaining && store.quotaRemainingLabel != nil)
        let compact = isCompact

        let composed = NSMutableAttributedString()
        composed.append(NSAttributedString(attachment: attachment))

        if store.displayMetric != .iconOnly {
            let suffix = store.showMenubarSuffix ? menubarPeriod.menubarSuffix(compact: compact) : ""
            let valueText: String
            if store.displayMetric == .tokens, let p = menubarPayload?.current {
                let out = formatTokensMenubar(Double(p.outputTokens))
                let inp = formatTokensMenubar(Double(p.inputTokens))
                valueText = compact ? "↑\(out)↓\(inp)\(suffix)" : " ↑\(out) ↓\(inp)\(suffix)"
            } else if store.displayMetric == .totalTokens, let p = menubarPayload?.current {
                let total = formatTokensMenubar(Double(p.inputTokens + p.outputTokens))
                valueText = compact ? "\(total)\(suffix)" : " \(total) tok\(suffix)"
            } else if store.displayMetric == .quotaRemaining {
                let quota = store.quotaRemainingLabel ?? "--% left"
                valueText = compact ? quota.replacingOccurrences(of: " ", with: "") : " \(quota)"
            } else {
                let state = CurrencyState.shared
                let fallback = compact ? "\(state.symbol)-" : "\(state.symbol)—"
                if let cost = menubarPayload?.current.cost {
                    let formatted = store.costGranularity.format(cost * state.rate, symbol: state.symbol)
                    valueText = compact ? formatted + suffix : " " + formatted + suffix
                } else {
                    valueText = compact ? fallback + suffix : " " + fallback + suffix
                }
            }

            var textAttrs: [NSAttributedString.Key: Any] = [.font: font, .baselineOffset: -1.0]
            if !hasPayload {
                textAttrs[.foregroundColor] = NSColor.secondaryLabelColor
            }
            composed.append(NSAttributedString(string: valueText, attributes: textAttrs))
        }

        button.attributedTitle = composed
        button.toolTip = "CodeBurn v2 \(menubarPeriod.menubarMetricLabel)"
        persistBadgeStatusFile()
    }

    private var lastWrittenBadgeGenerated: String?

    // Mirror the freshest in-memory payload to disk so the badge survives an app
    // restart. Skips redundant writes by tracking the last payload's `generated`
    // stamp. This is the badge backstop write — runs after every menubar update.
    private func persistBadgeStatusFile() {
        guard let payload = store.menubarPayload else { return }
        guard payload.generated != lastWrittenBadgeGenerated else { return }
        do {
            try MenubarStatusCache.standard().writeStatus(payload)
            lastWrittenBadgeGenerated = payload.generated
        } catch {
            NSLog("CodeBurn: failed to write badge status file: \(error)")
        }
    }

    private func formatTokensMenubar(_ n: Double) -> String {
        if n >= 1_000_000_000 { return String(format: "%.1fB", n / 1_000_000_000) }
        if n >= 1_000_000 { return String(format: "%.1fM", n / 1_000_000) }
        if n >= 1_000 { return String(format: "%.0fK", n / 1_000) }
        return String(format: "%.0f", n)
    }

    // MARK: - Popover

    private func setupPopover() {
        popover = NSPopover()
        popover.contentSize = NSSize(width: popoverWidth, height: popoverHeight)
        popover.behavior = .transient  // auto-close only on explicit outside click
        popover.animates = true
        popover.delegate = self

        let content = MenuBarContent()
            .environment(store)
            .environment(updateChecker)
            .frame(width: popoverWidth)

        popover.contentViewController = NSHostingController(rootView: content)
    }

    @objc private func handleButtonClick(_ sender: AnyObject?) {
        guard let button = statusItem.button,
              let event = NSApp.currentEvent else { return }

        if event.type == .rightMouseUp {
            showContextMenu(from: button)
            return
        }

        if popover.isShown {
            popover.performClose(sender)
        } else {
            // Do NOT call NSApp.activate(ignoringOtherApps:) here. On macOS
            // Tahoe an accessory app activating while a popover anchors to
            // its NSStatusItem can race with the system menu bar's auto-hide
            // logic and leave the user's apple-menu hidden until the popover
            // closes. The popover's window takes keyboard focus on its own
            // via makeKeyAndOrderFront, which is enough for keystrokes to
            // reach the SwiftUI content.
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            if let window = popover.contentViewController?.view.window {
                // Pin the popover's window above the status-bar layer but tag
                // it as auxiliary so macOS Tahoe does not treat it as an
                // app-level focus event — that's what was hiding the system
                // menu bar (Terminal's apple-logo / Shell / Edit / View row)
                // every time the popover opened.
                window.level = .statusBar
                window.collectionBehavior.insert(.fullScreenAuxiliary)
                window.collectionBehavior.insert(.canJoinAllSpaces)
                window.makeKeyAndOrderFront(nil)
            }
            refreshPayloadForPopoverOpen()
            refreshLiveQuotaProgressForPopoverOpen()
            store.switchToMostUsedProviderIfAvailable()
        }
    }

    private func showContextMenu(from button: NSStatusBarButton) {
        let menu = NSMenu()

        let settingsItem = NSMenuItem(title: "Settings…", action: #selector(openSettings), keyEquivalent: ",")
        settingsItem.target = self
        menu.addItem(settingsItem)

        let refreshNow = NSMenuItem(title: "Refresh Now", action: #selector(refreshNowAction), keyEquivalent: "r")
        refreshNow.target = self
        menu.addItem(refreshNow)

        let historyItem = NSMenuItem(title: "History…", action: #selector(openHistory), keyEquivalent: "h")
        historyItem.target = self
        menu.addItem(historyItem)

        menu.addItem(.separator())
        let updateItem = NSMenuItem(title: "Check for Updates", action: #selector(checkForUpdates), keyEquivalent: "")
        updateItem.target = self
        menu.addItem(updateItem)
        menu.addItem(.separator())
        let quitItem = NSMenuItem(title: "Quit CodeBurn", action: #selector(quitApp), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        statusItem.menu = menu
        button.performClick(nil)
        statusItem.menu = nil
    }

    private var settingsWindowController: NSWindowController?

    @objc private func openSettings() {
        // Accessory-policy apps (no Dock icon, no main menu) don't get the
        // SwiftUI Settings scene wired into the responder chain reliably, so
        // the standard `showSettingsWindow:` selector silently no-ops. We host
        // the SwiftUI view in our own NSWindowController instead.
        if let controller = settingsWindowController {
            NSApp.activate(ignoringOtherApps: true)
            controller.window?.makeKeyAndOrderFront(nil)
            return
        }

        let hosting = NSHostingController(
            rootView: SettingsView().environment(store)
        )
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 600, height: 500),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "CodeBurn Settings"
        window.contentViewController = hosting
        window.center()
        window.isReleasedWhenClosed = false
        let controller = NSWindowController(window: window)
        settingsWindowController = controller
        NSApp.activate(ignoringOtherApps: true)
        controller.showWindow(nil)
    }

    @objc func openHistory() {
        if let controller = historyWindowController {
            NSApp.activate(ignoringOtherApps: true)
            controller.window?.makeKeyAndOrderFront(nil)
            return
        }

        let hosting = NSHostingController(
            rootView: HistoryWindowView().environment(store)
        )
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 640, height: 520),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "CodeBurn History"
        window.contentViewController = hosting
        window.center()
        window.isReleasedWhenClosed = false
        let controller = NSWindowController(window: window)
        historyWindowController = controller
        NSApp.activate(ignoringOtherApps: true)
        controller.showWindow(nil)
    }

    @objc private func refreshNowAction() {
        refreshSubscriptionNow()
    }

    private func codeburnAlertIcon() -> NSImage? {
        let config = NSImage.SymbolConfiguration(pointSize: 32, weight: .medium)
        guard let symbol = NSImage(systemSymbolName: "flame.fill", accessibilityDescription: "CodeBurn")?
            .withSymbolConfiguration(config) else { return nil }
        let size = NSSize(width: 64, height: 64)
        let img = NSImage(size: size, flipped: false) { rect in
            let symbolSize = symbol.size
            let x = (rect.width - symbolSize.width) / 2
            let y = (rect.height - symbolSize.height) / 2
            symbol.draw(in: NSRect(x: x, y: y, width: symbolSize.width, height: symbolSize.height))
            return true
        }
        img.isTemplate = false
        return img
    }

    @objc private func checkForUpdates() {
        Task {
            await updateChecker.check()
            let alert = NSAlert()
            alert.icon = codeburnAlertIcon()
            if let error = updateChecker.updateError {
                alert.messageText = "Update Check Failed"
                alert.informativeText = error
                alert.alertStyle = .warning
            } else if updateChecker.updateAvailable, let latest = updateChecker.latestVersion {
                alert.messageText = "Update Available"
                alert.informativeText = "\(AppVersion.display(latest)) is available (you have \(AppVersion.display(updateChecker.currentVersion))). Run:\n\ncodeburn menubar --force"
                alert.alertStyle = .informational
            } else {
                alert.messageText = "Up to Date"
                alert.informativeText = "You're on the latest version (\(AppVersion.display(updateChecker.currentVersion)))."
                alert.alertStyle = .informational
            }
            alert.addButton(withTitle: "OK")
            alert.runModal()
        }
    }

    @objc private func quitApp() {
        NSApp.terminate(nil)
    }

    // MARK: - NSPopoverDelegate

    func popoverShouldDetach(_ popover: NSPopover) -> Bool {
        false
    }

    func popoverDidClose(_ notification: Notification) {
        // Catch up on any menubar title updates that were skipped while the
        // popover was anchored.
        refreshStatusButton()
    }
}
