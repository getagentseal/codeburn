import SwiftUI
import AppKit
import Observation

private let refreshIntervalSeconds: UInt64 = 60
private let nanosPerSecond: UInt64 = 1_000_000_000
private let refreshIntervalNanos: UInt64 = refreshIntervalSeconds * nanosPerSecond
/// Fixed so the popover's anchor point doesn't shift each time today's cost changes.
private let statusItemFixedWidth: CGFloat = 130
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
    private var refreshTask: Task<Void, Never>?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Menubar accessory -- no Dock icon, no app switcher entry.
        NSApp.setActivationPolicy(.accessory)

        restorePersistedCurrency()
        setupStatusItem()
        setupPopover()
        observeStore()
        startRefreshLoop()
        // Subscription is fetched lazily when the user opens the Plan pill, so the macOS
        // Keychain prompt never fires until the user explicitly asks for it.
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
            while !Task.isCancelled {
                guard let self else { return }
                // Always keep the (today, all) payload warm. The menubar title and the
                // agent tab strip both read from it, so it has to refresh every cycle
                // regardless of whether the user is currently viewing Today or a
                // different period / provider.
                await self.store.refreshQuietly(period: .today)
                // Refresh the currently-viewed payload. Optimize is fast (~1s warm-cache)
                // so include findings on every refresh.
                await self.store.refresh(includeOptimize: true)
                try? await Task.sleep(nanoseconds: refreshIntervalNanos)
            }
        }
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

    private func setupStatusItem() {
        // Fixed width so the popover anchor (and thus popover position) doesn't shift
        // every time today's cost or findings badge changes.
        statusItem = NSStatusBar.system.statusItem(withLength: statusItemFixedWidth)
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
            // Nudge the image down ~2pt so its visual centre sits on the text baseline mid-line
            // rather than riding high. Exact value tuned against SF Pro Display 13pt.
            attachment.bounds = CGRect(x: 0, y: -2, width: size.width, height: size.height)
        }

        let hasPayload = store.todayPayload != nil
        let valueText = " " + (store.todayPayload?.current.cost.asCompactCurrency() ?? "$—")
        let color: NSColor = hasPayload ? .labelColor : .secondaryLabelColor

        let composed = NSMutableAttributedString()
        composed.append(NSAttributedString(attachment: attachment))
        composed.append(NSAttributedString(
            string: valueText,
            attributes: [.font: font, .foregroundColor: color]
        ))
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
