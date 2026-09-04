import Foundation
import SwiftUI
import AppKit
import Observation
import ServiceManagement

private let refreshIntervalSeconds: UInt64 = 30
private let forceRefreshWatchdogSeconds: TimeInterval = 90
private let refreshLoopWatchdogSeconds: TimeInterval = 90
private let statusPayloadRefreshWatchdogSeconds: TimeInterval = 60
private let refreshRateLimitSeconds: TimeInterval = 5
private let interactiveQuotaRefreshFloorSeconds: TimeInterval = 30
private let statusItemWidth: CGFloat = NSStatusItem.variableLength
private let popoverWidth: CGFloat = 360
private let popoverHeight: CGFloat = 660
private let menubarTitleFontSize: CGFloat = 13

enum SubscriptionRefreshBackoff {
    static let initialDelaySeconds: TimeInterval = TimeInterval(refreshIntervalSeconds)
    static let maxJitterSeconds: TimeInterval = 5

    static func delay(
        failureCount: Int,
        cadence: TimeInterval,
        jitterUnit: Double
    ) -> TimeInterval {
        guard cadence > 0 else { return 0 }

        let exponent = min(max(failureCount, 1) - 1, 10)
        let exponential = min(cadence, initialDelaySeconds * pow(2, Double(exponent)))
        let normalizedJitter = min(max(jitterUnit, 0), 1)
        let jitter = normalizedJitter * min(maxJitterSeconds, cadence)
        return min(cadence, exponential + jitter)
    }
}

@main
struct CodeBurnApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate

    var body: some Scene {
        // The Settings scene gives us a real macOS Settings window with the
        // standard ⌘, shortcut and the menubar "Settings…" item. Provider tabs
        // (Claude today, Codex/Cursor/etc. in follow-ups) live inside SettingsView.
        Settings {
            SettingsView()
                .environment(delegate.store)
                .environment(delegate.updateChecker)
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private var statusItemPlacementRecoveryTask: Task<Void, Never>?
    private var popover: NSPopover!
    private var capacityDockController: CapacityDockController?
    private var rightClickMonitor: Any?
    /// Closes the popover on any click outside it. `.transient` relies on
    /// AppKit noticing the outside interaction, which is unreliable for an
    /// accessory app whose popover anchors to a status item (clicks into an
    /// already-active app can leave it open), so watch mouse-downs directly.
    /// Global monitors never see clicks in this app's own windows, so the
    /// popover content, the status item and Capacity Dock are unaffected.
    private var popoverOutsideClickMonitor: Any?
    private var lastContextMenuPresentedAt: Date = .distantPast
    /// Held only while the right-click menu is open. Cleared in menuDidClose so
    /// left-click goes back to the popover action instead of re-showing the menu.
    private var contextMenu: NSMenu?
    fileprivate let store = AppStore()
    let updateChecker = UpdateChecker()
    /// True while the displays are asleep. Refresh ticks skip spawning
    /// entirely then: nobody can see the menubar, and every fetch is a full
    /// Node process (#647).
    private var displayAsleep = false
    /// Bounds status staleness under App Nap: the 30s timer can be coalesced
    /// once the app naps (no permanent activity assertion anymore, #647), so
    /// this system-scheduled activity guarantees a tick attempt every few
    /// minutes. It goes through the same cadence gate as every other tick.
    private var napBackstop: NSBackgroundActivityScheduler?
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
    private var providerSettingsObserver: NSObjectProtocol?

    func applicationWillTerminate(_ notification: Notification) {
        // Synchronously, before the actor hop: the app can exit before a
        // detached Task is ever scheduled, and a serve child that outlives us
        // is the orphan in #1117. shutdown() still runs for the tidy case.
        ServeChildRegistry.shared.reapAll()
        Task { await ServeConnection.shared.shutdown() }
        stopStatusItemPlacementRecovery()
        capacityDockController?.stop()
        capacityDockController = nil
        if let providerSettingsObserver {
            NotificationCenter.default.removeObserver(providerSettingsObserver)
            self.providerSettingsObserver = nil
        }
        if let iconStyleObserver {
            NotificationCenter.default.removeObserver(iconStyleObserver)
            self.iconStyleObserver = nil
        }
        removePopoverOutsideClickMonitor()
        if let currencyObserver {
            NotificationCenter.default.removeObserver(currencyObserver)
            self.currencyObserver = nil
        }
        if let monitor = rightClickMonitor {
            NSEvent.removeMonitor(monitor)
            rightClickMonitor = nil
        }
    }

    func applicationWillFinishLaunching(_ notification: Notification) {
        // Belt-and-suspenders for dev runs only: packaged builds ship
        // LSUIElement=true (package-app.sh / build-local.sh), so LaunchServices
        // starts the process at .accessory before main() runs and this call is
        // a measured no-op there (returns false, no state change — #868
        // analysis). What actually matters is that the policy NEVER
        // transitions while a live NSStatusItem exists: the .regular →
        // .accessory dance from #147 is what plausibly caused the ghost item
        // that 85b5728 fixed. Keep the policy pinned; see the activate() call
        // in applicationDidFinishLaunching for the other half of the story.
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
        // Deliberately NO app-lifetime beginActivity here. A permanent
        // assertion opted the app out of App Nap forever, which kept the 30s
        // spawn loop running at full tilt on battery and with the display
        // off (#647). App Nap coalescing an idle tick is the desired
        // behavior; each in-flight refresh holds its own short .background
        // activity so a fetch is never napped mid-flight, and any user
        // interaction (popover open, wake) refreshes immediately.

        restorePersistedCurrency()
        // Start the resident CLI early without an artificial query. The first
        // real status refresh becomes its only cold warm-up. See ServeConnection.
        Task { await ServeConnection.shared.ensureStarted() }
        // #868 experiment: restore only the activation half of the #147 fix.
        // Packaged builds ship LSUIElement=true, so the policy is .accessory
        // before main() runs and never transitions (the transition is what
        // plausibly caused the ghost item). Accessory apps can still activate,
        // which registers the app with the window server before the status
        // item is created - the effect #147 actually needed for #146.
        NSApp.activate(ignoringOtherApps: true)
        setupStatusItem()
        setupPopover()
        capacityDockController = CapacityDockController(store: store)
        capacityDockController?.start()
        observeStore()
        startRefreshLoop()
        startNapBackstop()
        setupWakeObservers()
        removeLegacyRefreshAgent()
        registerLoginItemIfNeeded()
        observeSubscriptionDisconnect()
        observeCapacityDockProviderSettingsRequests()
        Task { await updateChecker.checkIfNeeded() }
    }

    private var iconStyleObserver: NSObjectProtocol?
    private var currencyObserver: NSObjectProtocol?

    private func observeMenubarIconStyle() {
        iconStyleObserver = NotificationCenter.default.addObserver(
            forName: MenubarIconStyle.changed,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in self?.refreshStatusButton() }
        }
        currencyObserver = NotificationCenter.default.addObserver(
            forName: CurrencyState.didChange,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in self?.refreshStatusButton() }
        }
    }

    private func observeCapacityDockProviderSettingsRequests() {
        observeMenubarIconStyle()
        providerSettingsObserver = NotificationCenter.default.addObserver(
            forName: .capacityDockOpenProviderSettings,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let providerID = notification.object as? String else { return }
            Task { @MainActor [weak self] in
                self?.store.settingsTab = providerID
                self?.openSettings()
            }
        }
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
                self?.stopStatusItemPlacementRecovery()
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
                self?.displayAsleep = false
                self?.recoverRefreshPipelineAfterInterruption(resetLoading: true, reason: "wake")
                self?.startStatusItemPlacementRecovery()
            }
        }

        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.screensDidWakeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.displayAsleep = false
                self?.recoverRefreshPipelineAfterInterruption(resetLoading: true, reason: "screen wake")
                self?.startStatusItemPlacementRecovery()
            }
        }

        // Display sleep without system sleep (clamshell displays off, screen
        // saver energy settings) previously kept the full spawn cadence
        // running for hours. Skip refreshes until the screens wake.
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.screensDidSleepNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.displayAsleep = true
                self?.stopStatusItemPlacementRecovery()
            }
        }
    }

    private func prepareRefreshPipelineForSleep() {
        // Leave the timer running: the kernel pauses it during sleep, and tearing
        // it down stranded the loop whenever a wake notification was missed.
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
            // Manual cadence means no automatic spawns, wakes included; the
            // user refreshes via popover open or Refresh Now. The tick still
            // runs so stuck-state cleanup happens.
            runRefreshLoopTick(
                reason: reason,
                forcePayload: UsageRefreshCadence.current != .manual,
                forceQuota: false
            )
        }
    }

    // Earlier builds installed a launchd job that re-fetched data out of process.
    // macOS attributes a launchd-spawned binary differently from the LaunchServices
    // app, so it triggered its own "access data from other apps" prompt on every
    // run. Remove any such leftover job on upgrade; the in-app loop is the source of
    // truth and writes the badge backstop file itself.
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

        // Registers in-process. The old path told System Events to make the login
        // item, which made macOS ask for Automation access on first launch (#1026).
        // No AppleScript fallback: a failure here must not bring that prompt back.
        do {
            if SMAppService.mainApp.status != .enabled {
                try SMAppService.mainApp.register()
            }
            UserDefaults.standard.set(true, forKey: key)
        } catch {
            NSLog("CodeBurn: login item registration failed: \(error.localizedDescription)")
        }
    }

    private var lastRefreshTime: Date = .distantPast
    /// Anchors the shallow provider-root snapshot only after a complete usage
    /// refresh succeeds. It sits beside the cadence anchor so a failed fetch
    /// never makes a later unchanged tick look successful.
    private var lastSuccessfulUsageDataSnapshot: UsageDataSnapshot?
    private var lastSuccessfulUsageDataSnapshotAt: Date?

    private func recordSuccessfulUsageDataSnapshot() {
        lastSuccessfulUsageDataSnapshot = UsageDataChangeGuard.snapshot()
        lastSuccessfulUsageDataSnapshotAt = Date()
    }

    private func shouldSkipBackgroundUsageRefresh() -> Bool {
        let current = UsageDataChangeGuard.snapshot()
        let shouldSkip = UsageDataChangeGuard.shouldSkip(
            current: current,
            lastSuccessful: lastSuccessfulUsageDataSnapshot,
            lastSuccessAt: lastSuccessfulUsageDataSnapshotAt,
            force: false
        )
        if shouldSkip {
            NSLog("CodeBurn: skipping unchanged background usage refresh")
        }
        return shouldSkip
    }

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

    private func refreshStatusPayloadIfNeeded(
        reason: String,
        force: Bool = false,
        minAgeSeconds: TimeInterval = 0,
        qualityOfService: QualityOfService = .userInitiated
    ) {
        let now = Date()
        _ = clearStaleStatusPayloadRefreshIfNeeded(now: now)
        guard statusPayloadRefreshTask == nil else { return }
        guard force || store.needsStatusPayloadRefresh else { return }
        // The 30s cache TTL would otherwise defeat the battery/low-power
        // backoff through this fallback path: honor the same spawn interval
        // the main loop uses. A missing payload (nil age) always fetches.
        if !force, minAgeSeconds > 0, let age = store.menubarPayloadAgeSeconds,
           TimeInterval(age) < minAgeSeconds { return }

        let menubarPeriod = store.menubarPeriod
        if let age = store.menubarPayloadAgeSeconds, age > 120 {
            NSLog("CodeBurn: status payload stale for %ds on %@ refresh", age, reason)
        }

        statusPayloadRefreshStartedAt = now
        statusPayloadRefreshGeneration &+= 1
        let generation = statusPayloadRefreshGeneration
        statusPayloadRefreshTask = Task { [weak self] in
            guard let self else { return }
            let activity = ProcessInfo.processInfo.beginActivity(
                options: .background, reason: "CodeBurn status refresh")
            defer { ProcessInfo.processInfo.endActivity(activity) }
            let succeeded = await self.store.refreshQuietly(
                period: menubarPeriod,
                force: true,
                qualityOfService: qualityOfService
            )
            if succeeded {
                self.recordSuccessfulUsageDataSnapshot()
            }
            self.refreshStatusButton()
            guard self.statusPayloadRefreshGeneration == generation, !Task.isCancelled else { return }
            self.statusPayloadRefreshTask = nil
            self.statusPayloadRefreshStartedAt = nil
        }
    }

    private func forceRefresh(
        bypassRateLimit: Bool = false,
        forceQuota: Bool = false,
        qualityOfService: QualityOfService = .userInitiated
    ) {
        let now = Date()
        _ = clearStaleForceRefreshIfNeeded(now: now)
        if forceRefreshTask != nil {
            if qualityOfService != .utility || !shouldSkipBackgroundUsageRefresh() {
                refreshStatusPayloadIfNeeded(reason: "blocked force refresh", qualityOfService: qualityOfService)
            }
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
            let activity = ProcessInfo.processInfo.beginActivity(
                options: .background, reason: "CodeBurn refresh")
            defer { ProcessInfo.processInfo.endActivity(activity) }
            async let main = refreshUsagePayloads(
                force: true,
                showLoading: true,
                qualityOfService: qualityOfService
            )
            async let quotas: Bool = refreshLiveQuotaProgressIfDue(force: forceQuota)
            let mainSucceeded = await main
            if mainSucceeded {
                recordSuccessfulUsageDataSnapshot()
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

    private func refreshUsagePayloads(
        force: Bool,
        showLoading: Bool = false,
        qualityOfService: QualityOfService = .userInitiated
    ) async -> Bool {
        let menubarPeriod = store.menubarPeriod

        // With the popover closed, only the payloads the status item actually
        // renders are worth a Node spawn: the menubar period, plus today for
        // the context-menu summary and day views. The popover's selected key
        // is refreshed by refreshPayloadForPopoverOpen the moment it opens,
        // so a closed-popover tick never pays for it (#647).
        if !(popover?.isShown ?? false) {
            async let menubar = store.refreshMenubarBadge(
                period: menubarPeriod,
                force: force,
                qualityOfService: qualityOfService
            )
            async let today = menubarPeriod != .today
                ? store.refreshQuietly(period: .today, force: force, qualityOfService: qualityOfService)
                : true
            let (menubarSucceeded, todaySucceeded) = await (menubar, today)
            return menubarSucceeded && todaySucceeded
        }

        let needsMenubarPayload = store.selectedPeriod != menubarPeriod || store.selectedProvider != .all
        let needsTodayPayload = (store.selectedPeriod != .today || store.selectedProvider != .all) && menubarPeriod != .today

        async let visible = store.refresh(
            includeOptimize: false,
            force: force,
            showLoading: showLoading,
            qualityOfService: qualityOfService
        )
        async let menubar = needsMenubarPayload
            ? store.refreshMenubarBadge(period: menubarPeriod, force: force, qualityOfService: qualityOfService)
            : true
        async let today = needsTodayPayload
            ? store.refreshQuietly(period: .today, force: force, qualityOfService: qualityOfService)
            : true
        let (visibleSucceeded, menubarSucceeded, todaySucceeded) = await (visible, menubar, today)
        return visibleSucceeded && menubarSucceeded && todaySucceeded
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
    fileprivate var lastKimiRefreshAt: Date?
    fileprivate var lastGeminiRefreshAt: Date?
    fileprivate var lastCopilotRefreshAt: Date?
    fileprivate var lastAntigravityRefreshAt: Date?
    fileprivate var lastCapacityDockProviderRefreshAt: Date?
    private var claudeQuotaFailureCount = 0
    private var nextClaudeQuotaRefreshAt: Date?

    @discardableResult
    private func refreshLiveQuotaProgressIfDue(
        force: Bool = false,
        forceClaude: Bool = false,
        forceCodex: Bool = false,
        forceCapacityDockProviders: Bool = false
    ) async -> Bool {
        let cadence = SubscriptionRefreshCadence.current
        let autoRefreshAllowed = cadence != .manual
        if !force && !forceClaude && !forceCodex && !forceCapacityDockProviders
            && !autoRefreshAllowed { return false }

        let now = Date()
        let threshold = TimeInterval(cadence.rawValue)
        let claudeDue = autoRefreshAllowed && (
            nextClaudeQuotaRefreshAt.map { now >= $0 } ??
            (now.timeIntervalSince(lastSubscriptionRefreshAt ?? .distantPast) >= threshold)
        )
        let shouldRefreshClaude = force || forceClaude || claudeDue
        let shouldRefreshCodex = force || forceCodex || (
            autoRefreshAllowed && now.timeIntervalSince(lastCodexRefreshAt ?? .distantPast) >= threshold
        )
        let shouldRefreshCapacityDockProviders = force || forceCapacityDockProviders || (
            autoRefreshAllowed
                && now.timeIntervalSince(lastCapacityDockProviderRefreshAt ?? .distantPast) >= threshold
        )
        guard shouldRefreshClaude || shouldRefreshCodex || shouldRefreshCapacityDockProviders else {
            return false
        }

        if shouldRefreshClaude {
            // The cadence anchor represents the start of an attempt, even if
            // the provider fails. Failures get their own shorter backoff below.
            lastSubscriptionRefreshAt = now
        }

        switch (shouldRefreshClaude, shouldRefreshCodex) {
        case (true, true):
            async let claude = refreshClaudeQuotaSingleFlight()
            async let codex = refreshCodexQuotaSingleFlight()
            let claudeSucceeded = await claude
            let codexSucceeded = await codex
            finishClaudeQuotaRefresh(
                succeeded: claudeSucceeded,
                attemptedAt: now,
                cadence: threshold
            )
            if codexSucceeded { lastCodexRefreshAt = Date() }
        case (true, false):
            let succeeded = await refreshClaudeQuotaSingleFlight()
            finishClaudeQuotaRefresh(succeeded: succeeded, attemptedAt: now, cadence: threshold)
        case (false, true):
            if await refreshCodexQuotaSingleFlight() {
                lastCodexRefreshAt = Date()
            }
        case (false, false):
            break
        }
        if shouldRefreshCapacityDockProviders {
            // Generic adapters have their own attempt anchor. They must not be
            // polled on every payload tick merely because Codex is disconnected
            // or a Codex refresh failed.
            lastCapacityDockProviderRefreshAt = now
            await store.refreshSelectedCapacityDockProviders()
        }
        return true
    }

    private func finishClaudeQuotaRefresh(
        succeeded: Bool,
        attemptedAt: Date,
        cadence: TimeInterval
    ) {
        guard !succeeded else {
            claudeQuotaFailureCount = 0
            nextClaudeQuotaRefreshAt = nil
            return
        }

        claudeQuotaFailureCount += 1
        let delay = SubscriptionRefreshBackoff.delay(
            failureCount: claudeQuotaFailureCount,
            cadence: cadence,
            jitterUnit: Double.random(in: 0...1)
        )
        nextClaudeQuotaRefreshAt = attemptedAt.addingTimeInterval(delay)
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
        // Kimi Code, Gemini, Copilot, and Antigravity ride the same tick,
        // each with its own cadence anchor: when Codex is not connected its
        // refresh returns false
        // immediately, so lastCodexRefreshAt never advances — anchoring them
        // on it would poll the quota endpoints on every payload tick instead
        // of the configured quota cadence. Anchor on attempt (not success)
        // so a failing endpoint also respects the cadence.
        let kimiDue: Bool = {
            let cadence = SubscriptionRefreshCadence.current
            guard cadence != .manual else { return false }
            return Date().timeIntervalSince(lastKimiRefreshAt ?? .distantPast) >= TimeInterval(cadence.rawValue)
        }()
        if kimiDue { lastKimiRefreshAt = Date() }
        let geminiDue: Bool = {
            let cadence = SubscriptionRefreshCadence.current
            guard cadence != .manual else { return false }
            return Date().timeIntervalSince(lastGeminiRefreshAt ?? .distantPast) >= TimeInterval(cadence.rawValue)
        }()
        if geminiDue { lastGeminiRefreshAt = Date() }
        let copilotDue: Bool = {
            let cadence = SubscriptionRefreshCadence.current
            guard cadence != .manual else { return false }
            return Date().timeIntervalSince(lastCopilotRefreshAt ?? .distantPast) >= TimeInterval(cadence.rawValue)
        }()
        if copilotDue { lastCopilotRefreshAt = Date() }
        let antigravityDue: Bool = {
            let cadence = SubscriptionRefreshCadence.current
            guard cadence != .manual else { return false }
            return Date().timeIntervalSince(lastAntigravityRefreshAt ?? .distantPast) >= TimeInterval(cadence.rawValue)
        }()
        if antigravityDue { lastAntigravityRefreshAt = Date() }
        let task = Task { [store, kimiDue, geminiDue, copilotDue, antigravityDue] in
            async let codex = store.refreshCodexReportingSuccess()
            if kimiDue {
                _ = await store.refreshKimiReportingSuccess()
            }
            if geminiDue {
                _ = await store.refreshGeminiReportingSuccess()
            }
            if copilotDue {
                _ = await store.refreshCopilotReportingSuccess()
            }
            if antigravityDue {
                _ = await store.refreshAntigravityReportingSuccess()
            }
            return await codex
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
        let capacityDockElapsed = now.timeIntervalSince(lastCapacityDockProviderRefreshAt ?? .distantPast)
        let refreshClaude = claudeElapsed >= interactiveQuotaRefreshFloorSeconds
        let refreshCodex = codexElapsed >= interactiveQuotaRefreshFloorSeconds
        let refreshCapacityDockProviders = capacityDockElapsed >= interactiveQuotaRefreshFloorSeconds
        guard refreshClaude || refreshCodex || refreshCapacityDockProviders else { return }

        Task { [weak self] in
            guard let self else { return }
            _ = await self.refreshLiveQuotaProgressIfDue(
                forceClaude: refreshClaude,
                forceCodex: refreshCodex,
                forceCapacityDockProviders: refreshCapacityDockProviders
            )
        }
    }

    private func refreshPayloadForPopoverOpen() {
        // A user viewing the popover is ground truth and must always recover.
        // Unconditionally ensure the loop is alive, then clear the current
        // key's stuck loading / in-flight / generation bookkeeping and force a
        // fresh fetch — even if the cache looks "not stale yet". This is the
        // guaranteed one-round-trip recovery path.
        // An open popover also proves the screens are on: recover from a
        // missed screensDidWake so a latched flag can't suppress refreshes.
        displayAsleep = false
        if refreshTimer == nil {
            startRefreshLoop(forceQuotaOnStart: false)
        }
        // The status figure may have gone stale under App Nap while the
        // popover was closed; catch it up alongside the visible payload.
        refreshStatusPayloadIfNeeded(reason: "popover open")
        if store.shouldResetInteractiveRefreshPipeline,
           let age = store.staleInteractivePayloadAgeSeconds {
            NSLog("CodeBurn: popover opened with %ds stale payload cache - hard recovery", age)
        }
        Task { [weak self] in
            guard let self else { return }
            let succeeded = await self.store.recoverFromStuckLoading()
            if succeeded {
                self.recordSuccessfulUsageDataSnapshot()
            }
            self.refreshStatusButton()
        }
    }

    private func stopRefreshTimer() {
        refreshTimer?.setEventHandler {}
        refreshTimer?.cancel()
        refreshTimer = nil
    }

    private func startNapBackstop() {
        let scheduler = NSBackgroundActivityScheduler(
            identifier: "org.agentseal.codeburn-menubar.refresh-backstop")
        scheduler.repeats = true
        scheduler.interval = 180
        scheduler.tolerance = 60
        scheduler.qualityOfService = .utility
        scheduler.schedule { [weak self] completion in
            Task { @MainActor [weak self] in
                self?.runRefreshLoopTick(reason: "nap backstop")
                completion(.finished)
            }
        }
        napBackstop = scheduler
    }

    private func runRefreshLoopTick(reason: String, forcePayload: Bool = false, forceQuota: Bool = false) {
        refreshLoopHeartbeatAt = Date()
        if displayAsleep && !forcePayload { return }
        let hadForceRefreshInFlight = forceRefreshTask != nil
        let clearedStaleForceRefresh = clearStaleForceRefreshIfNeeded()
        let clearedStaleStatusRefresh = clearStaleStatusPayloadRefreshIfNeeded()
        let clearedStaleLoading = store.clearStaleLoadingIfNeeded()
        let statusPayloadStale = store.needsStatusPayloadRefresh
        let sinceLast = Date().timeIntervalSince(lastRefreshTime)
        // The timer stays at 30s; the spawn interval follows the user's
        // Settings cadence, stretching on battery / Low Power Mode in Auto
        // and never auto-spawning in Manual (#647).
        let interval = currentRefreshInterval()
        let intervalElapsed = interval.map { sinceLast >= $0 } ?? false
        // Stuck-refresh cleanup may retrigger a spawn only when the cadence
        // allows auto-spawns at all: in Manual mode the stale state is
        // cleared and the next user interaction fetches fresh.
        let recoveryRespawnAllowed = interval != nil
        let shouldForceRefresh = forcePayload ||
            ((clearedStaleForceRefresh || clearedStaleLoading) && recoveryRespawnAllowed) ||
            intervalElapsed
        let popoverOpen = popover?.isShown ?? false
        let interactiveUsageRefresh = forcePayload || popoverOpen
        let qualityOfService: QualityOfService = interactiveUsageRefresh ? .userInitiated : .utility
        var skippedUnchangedUsageRefresh = false

        if shouldForceRefresh {
            skippedUnchangedUsageRefresh = !interactiveUsageRefresh && shouldSkipBackgroundUsageRefresh()
            if !skippedUnchangedUsageRefresh {
                forceRefresh(
                    bypassRateLimit: true,
                    forceQuota: forceQuota,
                    qualityOfService: qualityOfService
                )
            }
        }

        let forceRefreshWasBlocked = hadForceRefreshInFlight && forceRefreshTask != nil
        if statusPayloadStale && (!shouldForceRefresh || forceRefreshWasBlocked || clearedStaleStatusRefresh) {
            guard forcePayload || interval != nil else { return }
            if !interactiveUsageRefresh && (skippedUnchangedUsageRefresh || shouldSkipBackgroundUsageRefresh()) {
                return
            }
            refreshStatusPayloadIfNeeded(
                reason: reason,
                force: forcePayload,
                minAgeSeconds: interval ?? 0,
                qualityOfService: qualityOfService
            )
        }
    }

    private func currentRefreshInterval() -> TimeInterval? {
        RefreshCadence.interval(
            mode: UsageRefreshCadence.current,
            popoverOpen: popover?.isShown ?? false,
            onBattery: PowerSource.isOnBattery(),
            lowPowerMode: ProcessInfo.processInfo.isLowPowerModeEnabled
        )
    }

    private func startRefreshLoop(forceQuotaOnStart: Bool = false) {
        stopRefreshTimer()
        runRefreshLoopTick(reason: "start", forcePayload: true, forceQuota: forceQuotaOnStart)

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
            let activity = ProcessInfo.processInfo.beginActivity(
                options: .userInitiated, reason: "CodeBurn manual refresh")
            defer { ProcessInfo.processInfo.endActivity(activity) }
            // "Refresh Now" should refresh the menubar payload AND every
            // connected provider's live quota. The user's intent is "make
            // this match reality right now."
            async let payload = self.refreshUsagePayloads(
                force: true,
                showLoading: true,
                qualityOfService: .userInitiated
            )
            async let quotas: Bool = self.refreshLiveQuotaProgressIfDue(force: true)
            let payloadSucceeded = await payload
            if payloadSucceeded {
                self.recordSuccessfulUsageDataSnapshot()
            }
            guard self.manualRefreshGeneration == generation, !Task.isCancelled else { return }
            self.lastRefreshTime = Date()
            self.refreshStatusButton()
            _ = await quotas
            guard self.manualRefreshGeneration == generation, !Task.isCancelled else { return }
            self.manualRefreshTask = nil
            if self.refreshTimer == nil {
                self.startRefreshLoop()
            }
        }
    }

    /// Reset the cadence anchor so the next loop tick re-evaluates from "now"
    /// rather than measuring against a timestamp from the previous connection.
    /// Triggered on disconnect of any provider — the cost of clearing all
    /// anchors is one extra refresh tick on the unaffected providers, far less
    /// disruptive than waiting a full cadence after a reconnect.
    @MainActor
    func resetSubscriptionCadenceAnchor() {
        lastSubscriptionRefreshAt = nil
        lastCodexRefreshAt = nil
        lastKimiRefreshAt = nil
        lastGeminiRefreshAt = nil
        lastCopilotRefreshAt = nil
        lastAntigravityRefreshAt = nil
        lastCapacityDockProviderRefreshAt = nil
        claudeQuotaFailureCount = 0
        nextClaudeQuotaRefreshAt = nil
    }

    private func observeStore() {
        // Read closure uses [weak self] so the implicit self capture from
        // accessing store.* doesn't pin self for the lifetime of an
        // unfired observation. withObservationTracking is one-shot per
        // call: once any read property changes, onChange fires and the
        // registration is consumed, then we re-arm. There is at most one
        // active subscription at a time.
        withObservationTracking { [weak self] in
            guard let self else { return }
            _ = self.store.payload
            _ = self.store.menubarPeriod
            _ = self.store.menubarPayload
            // Combined-scope badge total: re-render the badge when the cross-device
            // aggregate for the menubar period lands (or a peer goes reachable).
            _ = self.store.menubarBadgeCombined
            // Track currency so the menubar title catches up immediately on
            // currency switch instead of waiting for the next 30s payload tick.
            _ = self.store.currency
            _ = self.store.displayMetric
            _ = self.store.dailyBudget
            _ = self.store.dailyTokenBudget
            // Read the derived flag so the flame re-tints when today's usage
            // crosses the budget, not only when the budget value itself changes.
            // This also makes the dependency on todayPayload explicit instead of
            // relying on payload/menubarPayload happening to touch the same cache.
            _ = self.store.isOverDailyBudget
            // Track the live-quota state too so the flame icon re-tints on
            // every connected provider's usage update, not just every 30s.
            _ = self.store.subscription
            _ = self.store.subscriptionLoadState
            _ = self.store.codexUsage
            _ = self.store.codexLoadState
            _ = self.store.kimiUsage
            _ = self.store.kimiLoadState
            _ = self.store.geminiUsage
            _ = self.store.geminiLoadState
            _ = self.store.copilotUsage
            _ = self.store.copilotLoadState
            _ = self.store.antigravityUsage
            _ = self.store.antigravityLoadState
            _ = self.store.capacityDockProviderSummaries
            _ = self.store.capacityDockProviderErrors
            _ = self.store.capacityDockProvidersLoading
            _ = self.store.capacityDockProviderTransientFailures
        } onChange: { [weak self] in
            DispatchQueue.main.async {
                guard let self else { return }
                self.pendingRefreshWork?.cancel()
                let work = DispatchWorkItem { [weak self] in
                    self?.refreshStatusButton()
                    self?.seedCapacityDockFromConnectedProviders()
                    self?.capacityDockController?.refreshQuotaPresentation()
                    self?.observeStore()
                }
                self.pendingRefreshWork = work
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05, execute: work)
            }
        }
    }

    /// Fresh-install default: mirror the connected subscriptions (capped) into
    /// the dock until the user first edits the set. Cheap — reads cached quota
    /// state — and no-ops once seeded or once the user takes over.
    private func seedCapacityDockFromConnectedProviders() {
        let connected = CapacityDockPreferences.supportedProviders
            .filter { store.capacityDockProviderIsConnected($0) }
        CapacityDockPreferences.autoSeedFromConnected(connected)
    }

    // MARK: - Status Item

    private var isCompact: Bool {
        UserDefaults.standard.bool(forKey: "CodeBurnMenubarCompact")
    }

    private func setupStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: statusItemWidth)
        item.autosaveName = StatusItemPlacementPolicy.autosaveName
        // `autosaveName` makes AppKit restore status-item state across launches.
        // CodeBurn has no user-facing hide toggle, so explicitly restore the
        // supported visible state in case Tahoe persisted a hidden/parked item.
        item.isVisible = true
        statusItem = item
        guard let button = statusItem.button else {
            startStatusItemPlacementRecovery()
            return
        }

        // Set the bundled flame image immediately to ensure the status item renders.
        // On macOS Tahoe, status items may fail to appear if only an attributed title
        // is set during initial setup.
        button.image = Self.menubarFlameImage(tint: nil)
        button.imagePosition = .imageLeading

        button.target = self
        button.action = #selector(handleButtonClick(_:))
        // Left-click drives the popover. We keep .rightMouseUp in the mask so the
        // legacy action path below still fires on macOS <= 26; on macOS 27 the
        // system consumes the right button entirely and this never fires, so the
        // global monitor (below) is what restores the right-click menu there.
        button.sendAction(on: [.leftMouseUp, .rightMouseUp])

        // macOS 27 no longer routes any right-mouse event to the status-item
        // button's target/action. A global monitor still observes right-mouse-up;
        // we hit-test it against our own status-item window and present the menu
        // ourselves.
        //
        // Must be mouse-*up*, not mouse-down: presenting on down starts menu
        // tracking while the button is still held, so the matching rightMouseUp
        // is treated as an outside click and the menu flashes then dismisses.
        // Presenting on up (after the click completes) keeps it open. Harmless
        // on 15/26 too (the debounce in showContextMenu prevents a double-present
        // if the legacy path also fires).
        rightClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: StatusItemContextMenuPolicy.presentEventMask) { [weak self] _ in
            guard let self,
                  let button = self.statusItem.button,
                  let window = button.window,
                  window.frame.contains(NSEvent.mouseLocation) else { return }
            // Defer one turn so menu presentation is not nested inside the
            // monitor callback. Safe on mouse-*up* (the click is already
            // complete); on mouse-down a deferred present was killed by the
            // matching up event and the menu only flashed.
            DispatchQueue.main.async { self.showContextMenu(from: button) }
        }

        // Defer the full attributed title setup to ensure initial render completes
        DispatchQueue.main.async { [weak self] in
            self?.refreshStatusButton()
            self?.startStatusItemPlacementRecovery()
        }
    }

    /// Tahoe can park an accessory app's status item at the screen's top-right
    /// corner when the auto-hidden menu bar is hidden during launch (#1148).
    /// Wait for the user's pointer to reveal the bar, then perform up to three
    /// supported visibility pulses. Never remove/recreate the item: repeated
    /// creation churn is implicated in poisoning the bundle-id state this
    /// recovery protects.
    private func startStatusItemPlacementRecovery() {
        stopStatusItemPlacementRecovery()

        statusItemPlacementRecoveryTask = Task { @MainActor [weak self] in
            guard let self else { return }
            let clock = ContinuousClock()
            let deadline = clock.now.advanced(by: .seconds(120))
            var recovery = StatusItemPlacementRecoveryCoordinator()

            while !Task.isCancelled && clock.now < deadline {
                let placement = self.statusItemPlacementState
                let revealed = placement.screen.map { screen in
                    StatusItemPlacementPolicy.isMenuBarRevealed(
                        pointer: NSEvent.mouseLocation,
                        screenFrame: screen.frame,
                        screenVisibleFrame: screen.visibleFrame
                    )
                } ?? false
                switch recovery.action(
                    for: placement.geometry,
                    isMenuBarRevealed: revealed,
                    revealHasSettled: false
                ) {
                case .stopHealthy:
                    return
                case .poll, .waitForReveal:
                    try? await Task.sleep(for: .milliseconds(250))
                    continue
                case .stopExhausted:
                    NSLog("CodeBurn: status item remains parked after bounded retries")
                    return
                case .settleBeforePulse:
                    // Let the auto-hide animation finish before asking AppKit
                    // to place the existing item again.
                    try? await Task.sleep(for: .milliseconds(500))
                    guard !Task.isCancelled else { return }
                    let settledPlacement = self.statusItemPlacementState
                    let settledReveal = settledPlacement.screen.map { screen in
                        StatusItemPlacementPolicy.isMenuBarRevealed(
                            pointer: NSEvent.mouseLocation,
                            screenFrame: screen.frame,
                            screenVisibleFrame: screen.visibleFrame
                        )
                    } ?? false
                    switch recovery.action(
                        for: settledPlacement.geometry,
                        isMenuBarRevealed: settledReveal,
                        revealHasSettled: true
                    ) {
                    case .stopHealthy:
                        return
                    case .poll, .waitForReveal, .settleBeforePulse:
                        continue
                    case .stopExhausted:
                        NSLog("CodeBurn: status item remains parked after bounded retries")
                        return
                    case .pulse(let attempt):
                        NSLog("CodeBurn: retrying parked status-item placement after menu bar reveal (\(attempt)/\(recovery.maximumPulseCount))")
                        await StatusItemVisibilityPulse.run { self.statusItem.isVisible = $0 }
                        guard !Task.isCancelled else { return }
                        try? await Task.sleep(for: .milliseconds(250))
                        continue
                    }
                case .pulse:
                    // A pulse is only emitted after the settle phase above.
                    assertionFailure("status item pulse emitted before reveal settled")
                    return
                }
            }

            guard !Task.isCancelled else { return }
            switch self.statusItemPlacementState {
            case .healthy:
                return
            case .unrealized:
                NSLog("CodeBurn: status item did not realize before placement recovery timed out")
            case .parked:
                NSLog("CodeBurn: status item stayed parked without a menu-bar reveal")
            }
        }
    }

    private func stopStatusItemPlacementRecovery() {
        statusItemPlacementRecoveryTask?.cancel()
        statusItemPlacementRecoveryTask = nil
    }

    private enum StatusItemPlacementState {
        case unrealized
        case healthy
        case parked(NSScreen)

        var geometry: StatusItemPlacementRecoveryGeometry {
            switch self {
            case .unrealized: return .unrealized
            case .healthy: return .healthy
            case .parked: return .parked
            }
        }

        var screen: NSScreen? {
            if case .parked(let screen) = self { return screen }
            return nil
        }
    }

    private var statusItemPlacementState: StatusItemPlacementState {
        guard let window = statusItem?.button?.window else { return .unrealized }
        let frame = window.frame
        guard !frame.isEmpty else { return .unrealized }
        guard let screen = window.screen
                ?? NSScreen.screens.first(where: { $0.frame.intersects(frame) })
                ?? NSScreen.main else { return .unrealized }
        let parked = StatusItemPlacementPolicy.isParked(
            itemFrame: frame,
            screenFrame: screen.frame,
            statusBarThickness: NSStatusBar.system.thickness
        )
        return parked ? .parked(screen) : .healthy
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

    /// Loads the bundled binary-flame PNG (Resources/ProviderIcons/flame.png) at the
    /// menubar text point size. With no tint it stays a template image so the system
    /// auto-adapts to the menu bar; a tint returns a recolored non-template copy for
    /// the budget/quota warning states.
    private static func menubarFlameImage(tint: NSColor?) -> NSImage? {
        let config = NSImage.SymbolConfiguration(pointSize: menubarTitleFontSize, weight: .medium)
        guard let symbol = NSImage(systemSymbolName: "flame.fill", accessibilityDescription: "CodeBurn")?
            .withSymbolConfiguration(config) else { return nil }
        guard let tint else {
            symbol.isTemplate = true
            return symbol
        }
        let recolored = NSImage(size: symbol.size, flipped: false) { rect in
            symbol.draw(in: rect)
            tint.set()
            rect.fill(using: .sourceAtop)
            return true
        }
        recolored.isTemplate = false
        return recolored
    }

    private func refreshStatusButton() {
        guard let button = statusItem.button else { return }
        // Skip while the popover is anchored to this button. Rewriting the
        // attributedTitle changes the button's intrinsic width, which makes
        // macOS reflow the status item in the menubar and detaches the
        // anchored popover (it pops to a stale default position). The
        // popoverDidClose delegate calls back through here once the popover
        // is dismissed so the menubar cost catches up immediately on close.
        if popover != nil && popover.isShown { return }

        // Clear any previously-set image so the attachment is the only glyph rendered.
        button.image = nil
        button.imagePosition = .noImage

        let font = NSFont.monospacedDigitSystemFont(ofSize: menubarTitleFontSize, weight: .regular)
        // Tint the flame based on the worst-affected connected provider's quota.
        // Normal (<70%) keeps the template (auto white-on-dark / black-on-light);
        // warning/critical/danger override with a fixed palette color so the
        // user gets a glanceable signal even when the menu bar is busy.
        let aggregate = store.aggregateQuotaStatus
        var tint = Self.flameTint(for: aggregate.severity)
        if tint == nil, store.isOverDailyBudget {
            tint = NSColor.systemYellow
        }
        // Monochrome mode keeps the flame a template image like the system's own
        // menu bar icons; quota and budget warnings still show in the popover.
        if MenubarIconStyle.current == .monochrome { tint = nil }
        let flame = Self.menubarFlameImage(tint: tint)

        let attachment = NSTextAttachment()
        attachment.image = flame
        if let size = flame?.size {
            attachment.bounds = CGRect(x: 0, y: -3, width: size.width, height: size.height)
        }

        let menubarPeriod = store.menubarPeriod
        let menubarPayload = badgePayload()
        let hasPayload = menubarPayload != nil
        let compact = isCompact

        let composed = NSMutableAttributedString()
        composed.append(NSAttributedString(attachment: attachment))

        if store.displayMetric != .iconOnly {
            let suffix = menubarPeriod.menubarSuffix(compact: compact)
            // Under combined scope the badge shows the cross-device aggregate, so
            // it matches the popover hero instead of trailing it with the local
            // figure. Falls back to local when no combined payload is available
            // (local scope, cold cache, or an unreachable peer). Credits have no
            // combined total, so that metric always reflects the local device.
            let badgeCombined = store.menubarBadgeCombined
            let cost: Double? = badgeCombined?.cost ?? menubarPayload?.current.cost
            let outputTokens: Int? = badgeCombined?.outputTokens ?? menubarPayload?.current.outputTokens
            let inputTokens: Int? = badgeCombined?.inputTokens ?? menubarPayload?.current.inputTokens
            let valueText: String
            if store.displayMetric == .tokens, let out = outputTokens, let inp = inputTokens {
                let outText = formatTokensMenubar(Double(out))
                let inpText = formatTokensMenubar(Double(inp))
                valueText = compact ? "↑\(outText)↓\(inpText)\(suffix)" : " ↑\(outText) ↓\(inpText)\(suffix)"
            } else if store.displayMetric == .totalTokens, let out = outputTokens, let inp = inputTokens {
                let total = formatTokensMenubar(Double(inp + out))
                valueText = compact ? "\(total)\(suffix)" : " \(total)\(suffix)"
            } else if store.displayMetric == .credits, let p = menubarPayload?.current {
                let credits = formatTokensMenubar((p.codexCredits ?? 0).rounded())
                valueText = compact ? L("\(credits)cr\(suffix)") : L(" \(credits) credits\(suffix)")
            } else {
                let fallback = compact ? "$-" : "$—"
                valueText = compact
                    ? (cost?.asCompactCurrencyWhole() ?? fallback) + suffix
                    : " " + (cost?.asCompactCurrency() ?? fallback) + suffix
            }

            var textAttrs: [NSAttributedString.Key: Any] = [.font: font, .baselineOffset: -1.0]
            if !hasPayload {
                textAttrs[.foregroundColor] = NSColor.secondaryLabelColor
            }
            composed.append(NSAttributedString(string: valueText, attributes: textAttrs))

            // Combined scope, but a paired device didn't report this cycle: append
            // a dimmed "reachable/total" so the reduced total reads as "peer
            // unreachable" rather than a glitch (mirrors the popover's device list).
            if let shortfall = store.menubarBadgeDeviceShortfall {
                let marker = " · \(shortfall.reachable)/\(shortfall.total)"
                let markerAttrs: [NSAttributedString.Key: Any] = [
                    .font: font,
                    .baselineOffset: -1.0,
                    .foregroundColor: NSColor.secondaryLabelColor,
                ]
                composed.append(NSAttributedString(string: marker, attributes: markerAttrs))
            }
        }

        button.attributedTitle = composed
        if let shortfall = store.menubarBadgeDeviceShortfall {
            button.toolTip = L("CodeBurn \(menubarPeriod.menubarMetricLabel) · \(shortfall.reachable) of \(shortfall.total) devices reporting")
        } else {
            button.toolTip = L("CodeBurn \(menubarPeriod.menubarMetricLabel)")
        }

        persistBadgeStatusFile()
    }

    private var lastWrittenBadgeGenerated: String?

    // Mirror the freshest in-memory payload to disk so the badge survives an app
    // restart. Skips redundant writes by tracking the last payload's `generated`
    // stamp. This is the only writer now that the launchd fetcher is gone.
    private func persistBadgeStatusFile() {
        // Only persist the unscoped (All) badge. Config selection resets to All
        // on relaunch, so a scoped payload on disk would show the wrong config's
        // number at next launch.
        guard store.selectedClaudeConfigSourceId == nil else { return }
        guard let payload = store.menubarPayload else { return }
        guard payload.generated != lastWrittenBadgeGenerated else { return }
        do {
            try MenubarStatusCache.standard().writeStatus(payload)
            lastWrittenBadgeGenerated = payload.generated
        } catch {
            NSLog("CodeBurn: failed to write badge status file: \(error)")
        }
    }

    // Badge falls back to the on-disk status file (written by a prior app run)
    // when the in-app loop has no payload yet; in-memory wins when it's fresher.
    // The 10-min bound discards a file too stale to trust.
    private func badgePayload() -> MenubarPayload? {
        let inMemory = store.menubarPayload
        // While scoped to a config, never fall back to the on-disk badge: it
        // holds the unscoped All payload and would show the wrong number.
        if store.selectedClaudeConfigSourceId != nil { return inMemory }
        let inMemoryAge = store.menubarPayloadAgeSeconds.map(TimeInterval.init)
        guard let fileRead = MenubarStatusCache.standard().readBadgePayload(maxAgeSeconds: 600) else {
            return inMemory
        }
        if inMemory == nil { return fileRead.payload }
        if let age = inMemoryAge, fileRead.ageSeconds < age { return fileRead.payload }
        return inMemory
    }

    private func formatTokensMenubar(_ n: Double) -> String {
        if n >= 1_000_000_000 { return String(format: "%.1fB", n / 1_000_000_000) }
        if n >= 1_000_000 { return String(format: "%.1fM", n / 1_000_000) }
        if n >= 1_000 { return String(format: "%.0fK", n / 1_000) }
        return String(format: "%.0f", n)
    }

    // MARK: - Popover

    private func installPopoverOutsideClickMonitor() {
        removePopoverOutsideClickMonitor()
        popoverOutsideClickMonitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        ) { [weak self] _ in
            guard let self, self.popover.isShown else { return }
            DispatchQueue.main.async { self.popover.performClose(nil) }
        }
    }

    private func removePopoverOutsideClickMonitor() {
        if let monitor = popoverOutsideClickMonitor {
            NSEvent.removeMonitor(monitor)
            popoverOutsideClickMonitor = nil
        }
    }

    private func setupPopover() {
        popover = NSPopover()
        popover.contentSize = NSSize(width: popoverWidth, height: popoverHeight)
        popover.behavior = .transient  // auto-close only on explicit outside click
        popover.animates = true
        popover.delegate = self

        popover.contentViewController = makePopoverContent()
    }

    /// Built fresh for every show and dropped on close: a popover content view
    /// that outlives its window kept re-laying itself out at display cadence
    /// after being shown once during the first load (6 percent idle CPU until
    /// relaunch). Rebuilding a 360pt view on open is far cheaper than that.
    private func makePopoverContent() -> NSViewController {
        let content = MenuBarContent()
            .environment(store)
            .environment(updateChecker)
            .frame(width: popoverWidth)

        let hosting = NSHostingController(rootView: content)
        // Let the popover size itself from preferredContentSize only. With the
        // default options the hosting view also pushes min/max content sizes at
        // its window on every pass, and once the popover has been shown while
        // loading (content 520pt tall, then the real height), the closed
        // popover keeps re-laying itself out at display cadence: 6 percent idle
        // CPU until relaunch.
        hosting.sizingOptions = [.preferredContentSize]
        return hosting
    }

    @objc private func handleButtonClick(_ sender: AnyObject?) {
        guard let button = statusItem.button,
              let event = NSApp.currentEvent else { return }

        // Legacy right-click path for macOS <= 26 (no-op on 27, where the action
        // never receives a right-mouse event — the global monitor handles it).
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
            if popover.contentViewController == nil {
                popover.contentViewController = makePopoverContent()
            }
            store.menuPopoverVisible = true
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            installPopoverOutsideClickMonitor()
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
        }
    }

    private func showContextMenu(from button: NSStatusBarButton) {
        // Debounce: on macOS <= 26 both the legacy action path and the global
        // monitor can fire for a single right-click. Present at most once per click.
        // Policy lives in StatusItemContextMenuPolicy so the gate is unit-tested (#802).
        guard StatusItemContextMenuPolicy.acceptPresent(
            now: Date(),
            lastPresentedAt: &lastContextMenuPresentedAt
        ) else { return }

        // Don't let an open popover steal the click / sit under the menu.
        if popover?.isShown == true {
            popover.performClose(nil)
        }

        let menu = NSMenu()

        // Glanceable "today" usage at the top as a single non-interactive (dimmed)
        // row. A real .sectionHeader adds section padding (and pulls the actions
        // into its group without a separator), so use a plain disabled item.
        let usageItem = NSMenuItem(title: contextMenuUsageSummary(), action: nil, keyEquivalent: "")
        usageItem.isEnabled = false
        menu.addItem(usageItem)

        let settingsItem = NSMenuItem(title: L("Settings…"), action: #selector(openSettings), keyEquivalent: "")
        settingsItem.target = self
        settingsItem.image = NSImage(systemSymbolName: "gearshape", accessibilityDescription: L("Settings"))
        menu.addItem(settingsItem)

        let dockSettingsItem = NSMenuItem(title: L("Capacity Dock Settings…"), action: #selector(openCapacityDockSettings), keyEquivalent: "")
        dockSettingsItem.target = self
        dockSettingsItem.image = NSImage(systemSymbolName: "rectangle.trailinghalf.inset.filled.arrow.trailing", accessibilityDescription: L("Capacity Dock"))
        menu.addItem(dockSettingsItem)

        let refreshNow = NSMenuItem(title: L("Refresh Now"), action: #selector(refreshNowAction), keyEquivalent: "")
        refreshNow.target = self
        menu.addItem(refreshNow)

        let updateItem = NSMenuItem(title: L("Check for Updates"), action: #selector(checkForUpdates), keyEquivalent: "")
        updateItem.target = self
        menu.addItem(updateItem)

        let aboutItem = NSMenuItem(title: L("About CodeBurn"), action: #selector(openAbout), keyEquivalent: "")
        aboutItem.target = self
        menu.addItem(aboutItem)

        let quitItem = NSMenuItem(title: L("Quit CodeBurn"), action: #selector(quitApp), keyEquivalent: "")
        quitItem.target = self
        menu.addItem(quitItem)

        // Present via the status item's own menu slot. AppKit positions and tracks
        // that menu correctly under the status item (no scroll chevron / first-row
        // jump). Manual NSMenu.popUp(at:in:) is what caused the jump: the menu was
        // tracked against a point while the cursor still sat on the status item
        // above it, so the first mouse move engaged scroll mode.
        //
        // #472 dropped this pattern because assigning `statusItem.menu` from the
        // right-mouse *action* never ran on macOS 27 (right-clicks no longer reach
        // the button action). We still open from our global rightMouseUp monitor
        // (or the legacy action on ≤26); once we set `statusItem.menu` ourselves,
        // performClick is just "open the attached menu" and works on 27 too.
        //
        // menuDidClose clears `statusItem.menu` so the next left-click hits our
        // action (popover) instead of re-opening this menu.
        menu.delegate = self
        contextMenu = menu
        statusItem.menu = menu
        button.performClick(nil)
    }

    // MARK: - NSMenuDelegate

    // AppKit invokes menu callbacks on the main thread. Clear the status-item
    // menu slot so the next left-click hits our action (popover) again.
    nonisolated func menuDidClose(_ menu: NSMenu) {
        // Hop explicitly — don't assumeIsolated across the NSMenuDelegate boundary
        // under Swift 6 strict concurrency (NSMenu isn't Sendable).
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            // Always clear: we only ever attach our own context menu to the item.
            self.statusItem.menu = nil
            self.contextMenu = nil
        }
    }

    /// One-line "today" summary for the context menu's usage row.
    private func contextMenuUsageSummary() -> String {
        guard let current = store.todayPayload?.current else { return L("Today · no usage yet") }
        let calls = current.calls == 1 ? L("1 call") : L("\(current.calls) calls")
        return L("Today · \(current.cost.asCurrency()) · \(calls)")
    }

    private var settingsWindowController: NSWindowController?

    @objc private func openAbout() {
        store.settingsTab = "about"
        openSettings()
    }

    @objc private func openCapacityDockSettings() {
        // The Capacity Dock controls live in the General pane; jump straight there.
        store.settingsTab = "general"
        openSettings()
    }

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
            rootView: SettingsView().environment(store).environment(updateChecker)
        )
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 380),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = L("CodeBurn Settings")
        window.contentViewController = hosting
        window.center()
        window.isReleasedWhenClosed = false
        let controller = NSWindowController(window: window)
        settingsWindowController = controller
        NSApp.activate(ignoringOtherApps: true)
        controller.showWindow(nil)
        // SwiftUI resizes the window past the initial contentRect after first
        // layout, which drifts the earlier center(). Re-center once that settles.
        DispatchQueue.main.async { [weak window] in window?.center() }
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
                alert.messageText = L("Update Check Failed")
                alert.informativeText = error
                alert.alertStyle = .warning
            } else if updateChecker.updateAvailable, let latest = updateChecker.latestVersion {
                alert.messageText = L("Update Available")
                let header = L("\(AppVersion.display(latest)) is available (you have \(AppVersion.display(updateChecker.currentVersion))).")
                if updateChecker.cliTooOldForUpdate {
                    alert.informativeText = L("\(header) Your codeburn CLI is too old to install it. First run:\n\n\(updateChecker.cliUpdateCommand)\n\nthen:\n\ncodeburn menubar --force")
                } else {
                    alert.informativeText = L("\(header) Run:\n\ncodeburn menubar --force")
                }
                alert.alertStyle = .informational
            } else {
                alert.messageText = L("Up to Date")
                alert.informativeText = L("You're on the latest version (\(AppVersion.display(updateChecker.currentVersion))).")
                alert.alertStyle = .informational
            }
            alert.addButton(withTitle: L("OK"))
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
        store.menuPopoverVisible = false
        popover.contentViewController = nil
        removePopoverOutsideClickMonitor()
        // Catch up on any menubar title updates that were skipped while the
        // popover was anchored.
        refreshStatusButton()
    }
}
