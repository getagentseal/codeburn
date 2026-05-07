import SwiftUI
import AppKit
import Observation

private let refreshIntervalSeconds: UInt64 = 30
private let nanosPerSecond: UInt64 = 1_000_000_000
private let refreshIntervalNanos: UInt64 = refreshIntervalSeconds * nanosPerSecond
private let statusItemWidth: CGFloat = NSStatusItem.variableLength
private let popoverWidth: CGFloat = 360
private let popoverHeight: CGFloat = 660
private let menubarTitleFontSize: CGFloat = 13

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
        }
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
    private var refreshLoopTask: Task<Void, Never>?

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
            options: [.userInitiated, .automaticTerminationDisabled, .suddenTerminationDisabled],
            reason: "CodeBurn menubar polls AI coding cost every 30 seconds while idle in the background."
        )

        restorePersistedCurrency()
        setupStatusItem()
        setupPopover()
        observeStore()
        startRefreshLoop()
        setupWakeObservers()
        setupDistributedNotificationListener()
        installLaunchAgentIfNeeded()
        registerLoginItemIfNeeded()
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
                self?.refreshLoopTask?.cancel()
                self?.refreshLoopTask = nil
            }
        }

        // didWakeNotification + screensDidWakeNotification can both fire on
        // the same wake. forceRefresh has a 5-second rate-limit gate so the
        // duplicate is squashed there. Restart the refresh loop too, since
        // we cancelled it on willSleep.
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.forceRefresh()
                if self?.refreshLoopTask == nil { self?.startRefreshLoop() }
            }
        }

        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.screensDidWakeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.forceRefresh() }
        }
    }

    private func setupDistributedNotificationListener() {
        DistributedNotificationCenter.default().addObserver(
            forName: NSNotification.Name("com.codeburn.refresh"),
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.forceRefresh() }
        }
    }

    private func installLaunchAgentIfNeeded() {
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
    <integer>30</integer>
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

    private func registerLoginItemIfNeeded() {
        let key = "codeburn.loginItemRegistered"
        guard !UserDefaults.standard.bool(forKey: key) else { return }

        let appPath = Bundle.main.bundlePath
        let script = "tell application \"System Events\" to make login item at end with properties {path:\"\(appPath)\", hidden:false}"

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

    private var lastRefreshTime: Date = .distantPast

    private func forceRefresh() {
        let now = Date()
        guard now.timeIntervalSince(lastRefreshTime) > 5 else { return }
        lastRefreshTime = now

        // Note: do NOT call store.invalidateCache() here. The day-rollover guard
        // inside refresh() already wipes the cache when the calendar date has
        // changed; wiping unconditionally on every wake/manual-refresh empties
        // todayPayload, makes showAgentTabs go false, and triggers the
        // full-popover loading overlay (because cache[key] == nil after wipe).
        // That's the regression chain documented in the multi-agent review.
        //
        // showLoading: true is fine now that the overlay condition is
        // `!hasCachedData`: it lights up the refresh-button spinner glyph
        // without covering the popover body.
        Task {
            async let main: Void = store.refresh(includeOptimize: false, force: true, showLoading: true)
            async let today: Void = store.refreshQuietly(period: .today)
            _ = await (main, today)
            refreshStatusButton()
        }
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

    private func startRefreshLoop() {
        refreshLoopTask?.cancel()
        refreshLoopTask = Task { [weak self] in
            // Provider refreshes only run when the user has explicitly connected.
            // Each refresh is a no-op until its corresponding bootstrap flag is set.
            if let self {
                async let claude = self.store.refreshSubscriptionReportingSuccess()
                async let codex  = self.store.refreshCodexReportingSuccess()
                if await claude { self.lastSubscriptionRefreshAt = Date() }
                if await codex   { self.lastCodexRefreshAt = Date() }
            }
            while !Task.isCancelled {
                guard let self else { return }
                // Skip the loop's tick if a wake / manual / distributed-
                // notification refresh just ran. Without this gate, every
                // wake produced two refreshes (forceRefresh from the wake
                // observer plus the loop's natural tick).
                let sinceLast = Date().timeIntervalSince(self.lastRefreshTime)
                if sinceLast >= 5 {
                    if self.store.selectedPeriod != .today || self.store.selectedProvider != .all {
                        await self.store.refreshQuietly(period: .today)
                    }
                    await self.store.refresh(includeOptimize: false, force: true)
                    self.lastRefreshTime = Date()
                    self.refreshStatusButton()
                }
                // Cadence-driven live-quota refresh, anchored on LAST SUCCESS
                // (not last attempt) so an intermittent failure doesn't reset
                // the timer. Each provider has its own anchor so a Codex 429
                // doesn't delay a due Claude refresh.
                let cadence = SubscriptionRefreshCadence.current
                if cadence != .manual {
                    let claudeElapsed = Date().timeIntervalSince(self.lastSubscriptionRefreshAt ?? .distantPast)
                    if claudeElapsed >= TimeInterval(cadence.rawValue) {
                        let succeeded = await self.store.refreshSubscriptionReportingSuccess()
                        if succeeded { self.lastSubscriptionRefreshAt = Date() }
                    }
                    let codexElapsed = Date().timeIntervalSince(self.lastCodexRefreshAt ?? .distantPast)
                    if codexElapsed >= TimeInterval(cadence.rawValue) {
                        let succeeded = await self.store.refreshCodexReportingSuccess()
                        if succeeded { self.lastCodexRefreshAt = Date() }
                    }
                }
                try? await Task.sleep(nanoseconds: refreshIntervalNanos)
            }
        }
    }

    fileprivate var lastCodexRefreshAt: Date?

    @MainActor
    func refreshSubscriptionNow() {
        Task { [weak self] in
            guard let self else { return }
            // "Refresh Now" should refresh the menubar payload AND every
            // connected provider's live quota — the user's intent is "make
            // this match reality right now."
            async let payload: Void = self.store.refresh(includeOptimize: false, force: true, showLoading: true)
            async let claude: Bool = self.store.refreshSubscriptionReportingSuccess()
            async let codex:  Bool = self.store.refreshCodexReportingSuccess()
            _ = await payload
            if await claude { self.lastSubscriptionRefreshAt = Date() }
            if await codex  { self.lastCodexRefreshAt = Date() }
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
        // Read closure uses [weak self] so the implicit self capture from
        // accessing store.* doesn't pin self for the lifetime of an
        // unfired observation. withObservationTracking is one-shot per
        // call: once any read property changes, onChange fires and the
        // registration is consumed, then we re-arm. There is at most one
        // active subscription at a time.
        withObservationTracking { [weak self] in
            guard let self else { return }
            _ = self.store.payload
            _ = self.store.todayPayload
            // Track currency so the menubar title catches up immediately on
            // currency switch instead of waiting for the next 30s payload tick.
            _ = self.store.currency
            // Track the live-quota state too so the flame icon re-tints on
            // every subscription / codex usage update, not just every 30s.
            _ = self.store.subscription
            _ = self.store.subscriptionLoadState
            _ = self.store.codexUsage
            _ = self.store.codexLoadState
        } onChange: { [weak self] in
            DispatchQueue.main.async {
                guard let self else { return }
                self.pendingRefreshWork?.cancel()
                let work = DispatchWorkItem { [weak self] in
                    self?.refreshStatusButton()
                    self?.observeStore()
                }
                self.pendingRefreshWork = work
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05, execute: work)
            }
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

        let font = NSFont.monospacedDigitSystemFont(ofSize: menubarTitleFontSize, weight: .medium)
        let baseConfig = NSImage.SymbolConfiguration(pointSize: menubarTitleFontSize, weight: .medium)
        // Tint the flame based on the worst-affected connected provider's quota.
        // Normal (<70%) keeps the template (auto white-on-dark / black-on-light);
        // warning/critical/danger override with a fixed palette color so the
        // user gets a glanceable signal even when the menu bar is busy.
        let aggregate = store.aggregateQuotaStatus
        let tint = Self.flameTint(for: aggregate.severity)
        let flameConfig: NSImage.SymbolConfiguration
        if let tint {
            flameConfig = baseConfig.applying(.init(paletteColors: [tint]))
        } else {
            flameConfig = baseConfig
        }
        let flame = NSImage(systemSymbolName: "flame.fill", accessibilityDescription: "CodeBurn")?
            .withSymbolConfiguration(flameConfig)
        flame?.isTemplate = (tint == nil)

        let attachment = NSTextAttachment()
        attachment.image = flame
        if let size = flame?.size {
            attachment.bounds = CGRect(x: 0, y: -3, width: size.width, height: size.height)
        }

        let hasPayload = store.todayPayload != nil
        let compact = isCompact
        let fallback = compact ? "$-" : "$—"
        let formatted = store.todayPayload?.current.cost
        let valueText = compact
            ? (formatted?.asCompactCurrencyWhole() ?? fallback)
            : " " + (formatted?.asCompactCurrency() ?? fallback)

        var textAttrs: [NSAttributedString.Key: Any] = [.font: font, .baselineOffset: -1.0]
        if !hasPayload {
            textAttrs[.foregroundColor] = NSColor.secondaryLabelColor
        }

        let composed = NSMutableAttributedString()
        composed.append(NSAttributedString(attachment: attachment))
        composed.append(NSAttributedString(string: valueText, attributes: textAttrs))
        button.attributedTitle = composed
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
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 380),
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
            if updateChecker.updateAvailable, let latest = updateChecker.latestVersion {
                alert.messageText = "Update Available"
                alert.informativeText = "v\(latest) is available (you have v\(updateChecker.currentVersion)). Run:\n\ncodeburn menubar --force"
            } else {
                alert.messageText = "Up to Date"
                alert.informativeText = "You're on the latest version (v\(updateChecker.currentVersion))."
            }
            alert.alertStyle = .informational
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
