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
        // SwiftUI App needs at least one scene. Settings is invisible by default.
        Settings {
            EmptyView()
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    private var statusItem: NSStatusItem!
    private var popover: NSPopover!
    private let store = AppStore()
    let updateChecker = UpdateChecker()
    /// Held for the lifetime of the app to opt out of App Nap and Automatic Termination.
    private var backgroundActivity: NSObjectProtocol?
    private var pendingRefreshWork: DispatchWorkItem?

    func applicationWillFinishLaunching(_ notification: Notification) {
        // Set accessory policy before the app's focus chain forms. On macOS Tahoe
        // (26.x), setting it after didFinishLaunching causes ghost status items
        // because the policy gets baked into the initial focus chain.
        NSApp.setActivationPolicy(.accessory)
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
        Task { await updateChecker.checkIfNeeded() }
    }

    private func setupWakeObservers() {
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.forceRefresh() }
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

        store.invalidateCache()
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

    private func startRefreshLoop() {
        Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                if self.store.selectedPeriod != .today || self.store.selectedProvider != .all {
                    await self.store.refreshQuietly(period: .today)
                }
                await self.store.refresh(includeOptimize: false, force: true)
                self.refreshStatusButton()
                try? await Task.sleep(nanoseconds: refreshIntervalNanos)
            }
        }
    }

    private func observeStore() {
        withObservationTracking {
            _ = store.payload
            _ = store.todayPayload
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
    private func refreshStatusButton() {
        guard let button = statusItem.button else { return }

        // Clear any previously-set image so the attachment is the only glyph rendered.
        button.image = nil
        button.imagePosition = .noImage

        let font = NSFont.monospacedDigitSystemFont(ofSize: menubarTitleFontSize, weight: .medium)
        let flameConfig = NSImage.SymbolConfiguration(pointSize: menubarTitleFontSize, weight: .medium)
        let flame = NSImage(systemSymbolName: "flame.fill", accessibilityDescription: "CodeBurn")?
            .withSymbolConfiguration(flameConfig)
        flame?.isTemplate = true

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
            NSApp.activate(ignoringOtherApps: true)
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            popover.contentViewController?.view.window?.makeKey()
        }
    }

    private func showContextMenu(from button: NSStatusBarButton) {
        let menu = NSMenu()
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
}
