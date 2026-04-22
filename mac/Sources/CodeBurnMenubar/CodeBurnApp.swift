import SwiftUI
import AppKit
import Observation

private let refreshIntervalSeconds: UInt64 = 15
private let nanosPerSecond: UInt64 = 1_000_000_000
private let refreshIntervalNanos: UInt64 = refreshIntervalSeconds * nanosPerSecond
/// Fixed so the popover's anchor point doesn't shift each time today's cost changes.
private let statusItemFixedWidth: CGFloat = 130
private let statusItemCompactWidth: CGFloat = NSStatusItem.variableLength
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
    private var refreshTask: Task<Void, Never>?
    /// Held for the lifetime of the app to opt out of App Nap and Automatic Termination.
    /// Without this the 15s refresh Task gets suspended whenever the user is interacting with
    /// another app, and the status bar label freezes until they click the menubar icon (which
    /// calls NSApp.activate and wakes the app back up).
    private var backgroundActivity: NSObjectProtocol?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        ProcessInfo.processInfo.automaticTerminationSupportEnabled = false
        ProcessInfo.processInfo.disableSuddenTermination()
        backgroundActivity = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiated, .automaticTerminationDisabled, .suddenTerminationDisabled],
            reason: "CodeBurn menubar polls AI coding cost every 15 seconds while idle in the background."
        )

        restorePersistedCurrency()
        setupStatusItem()
        setupPopover()
        observeStore()
        startRefreshLoop()
        Task { await updateChecker.checkIfNeeded() }
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

    func applicationWillTerminate(_ notification: Notification) {
        refreshTask?.cancel()
    }

    private func startRefreshLoop() {
        refreshTask = Task { [weak self] in
            guard let s = self else { return }
            // First cycle: fetch today so the status icon has a number within seconds of launch.
            await s.store.refreshQuietly(period: .today)
            s.refreshStatusButton()
            await s.store.refresh(includeOptimize: true)
            s.refreshStatusButton()

            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: refreshIntervalNanos)
                guard let s = self else { return }
                await s.store.refreshQuietly(period: .today)
                s.refreshStatusButton()
                await s.store.refresh(includeOptimize: true)
                s.refreshStatusButton()
            }
        }

        // Period tabs are fetched lazily when the user first clicks them in the popover.
        // An earlier version prefetched every period on launch to make tab switching instant,
        // but on large session corpora that spawned four concurrent codeburn subprocesses
        // competing with the main refresh loop for disk and parser time, and the status label
        // drifted stale for minutes. A per-tab first-click cost of a few seconds is the better
        // tradeoff on user machines that track thousands of sessions.
    }

    private func observeStore() {
        withObservationTracking {
            _ = store.payload
            _ = store.todayPayload
        } onChange: { [weak self] in
            Task { @MainActor in
                self?.refreshStatusButton()
                self?.observeStore()
            }
        }
    }

    // MARK: - Status Item

    private var isCompact: Bool {
        UserDefaults.standard.bool(forKey: "CodeBurnMenubarCompact")
    }

    private func setupStatusItem() {
        let width = isCompact ? statusItemCompactWidth : statusItemFixedWidth
        statusItem = NSStatusBar.system.statusItem(withLength: width)
        guard let button = statusItem.button else { return }
        button.target = self
        button.action = #selector(handleButtonClick(_:))
        button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        refreshStatusButton()
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
        let color: NSColor = hasPayload ? .labelColor : .secondaryLabelColor

        let composed = NSMutableAttributedString()
        composed.append(NSAttributedString(attachment: attachment))
        composed.append(NSAttributedString(
            string: valueText,
            attributes: [.font: font, .foregroundColor: color, .baselineOffset: -1.0]
        ))
        button.attributedTitle = composed
        // Force immediate redraw. NSStatusItem sometimes defers the status bar paint for an
        // accessory app that is not foreground, so the label visually freezes until the user
        // opens the popover (which triggers NSApp.activate + a forced redraw cycle).
        button.needsDisplay = true
        button.display()
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
        guard let button = statusItem.button else { return }
        if popover.isShown {
            popover.performClose(sender)
        } else {
            NSApp.activate(ignoringOtherApps: true)
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            popover.contentViewController?.view.window?.makeKey()
        }
    }

    // MARK: - NSPopoverDelegate

    func popoverShouldDetach(_ popover: NSPopover) -> Bool {
        false
    }
}
