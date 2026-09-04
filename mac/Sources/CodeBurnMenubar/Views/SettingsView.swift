import AppKit
import SwiftUI

/// System Settings–style window: a fixed-width sidebar (search, General/About,
/// per-provider rows) drives the detail pane. New providers plug in by adding
/// one entry to `providers`; each pane owns its own Form content and this
/// top-level view only hosts the shell.
struct SettingsView: View {
    @Environment(AppStore.self) private var store
    @State private var searchText = ""

    /// One entry per provider pane. `id` doubles as the deep-link tag, so the
    /// sidebar, the detail switch, and `store.settingsTab` all speak the same
    /// strings.
    struct ProviderPane: Identifiable {
        let id: String
        let name: String
        let icon: String
        let isConnected: Bool
    }

    private static let mainPaneIDs: Set<String> = ["general", "about"]

    private var providers: [ProviderPane] {
        // Only surface providers CodeBurn actually has a live quota adapter for;
        // the rest of the catalog would just read "coming soon" and clutter the
        // list, so they stay hidden until their adapter ships.
        CapacityDockPreferences.supportedProviders
            .filter { $0.catalogEntry.hasLiveCodeBurnQuotaAdapter }
            .map { provider in
                ProviderPane(
                    id: provider.id,
                    name: provider.displayName,
                    icon: provider.iconName,
                    isConnected: providerIsConnected(provider)
                )
            }
    }

    private func providerIsConnected(_ provider: CapacityDockProvider) -> Bool {
        switch provider.id {
        case CapacityDockProvider.claude.id: store.subscriptionLoadState == .loaded
        case CapacityDockProvider.codex.id: store.codexLoadState == .loaded
        case CapacityDockProvider.kimiCode.id: store.kimiLoadState == .loaded
        case CapacityDockProvider.gemini.id: store.geminiLoadState == .loaded
        case CapacityDockProvider.copilot.id: store.copilotLoadState == .loaded
        case CapacityDockProvider.antigravity.id: store.antigravityLoadState == .loaded
        case "devin":
            store.capacityDockProviderIsConnected(provider) || CLIDevinConfig.loadAcuUsdRate() != nil
        default: store.capacityDockProviderIsConnected(provider)
        }
    }

    // Search narrows the provider list only; General/About stay put.
    private var filteredProviders: [ProviderPane] {
        let query = searchText.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else { return providers }
        return providers.filter { $0.name.localizedCaseInsensitiveContains(query) }
    }

    /// Deep links can name a pane that no longer exists; those fall back to
    /// General instead of leaving the sidebar without a selection.
    private var selection: Binding<String> {
        Binding(
            get: {
                let tab = store.settingsTab
                return Self.mainPaneIDs.contains(tab) || providers.contains { $0.id == tab } ? tab : "general"
            },
            set: { store.settingsTab = $0 }
        )
    }

    private static let windowWidth: CGFloat = 880
    private static let windowHeight: CGFloat = 620
    private static let sidebarWidth: CGFloat = 260

    var body: some View {
        HStack(spacing: 0) {
            // Fixed-width provider sidebar over an edge-to-edge system material,
            // followed by a hairline divider and the selected detail pane.
            sidebar
                .frame(width: Self.sidebarWidth)
                .background {
                    SettingsSidebarMaterial()
                        .ignoresSafeArea()
                }

            Divider()
                .ignoresSafeArea()

            detailView
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .frame(minWidth: Self.windowWidth, maxWidth: .infinity, minHeight: Self.windowHeight, maxHeight: .infinity)
        .background {
            SettingsWindowStyleAccessor(title: currentPaneTitle)
                .allowsHitTesting(false)
        }
    }

    private var sidebar: some View {
        VStack(spacing: 0) {
            SettingsSidebarSearchField(searchText: $searchText)
                .padding(.horizontal, 8)
                .padding(.top, 16)
                .padding(.bottom, 8)

            List(selection: selection) {
                Section {
                    SettingsSidebarPaneRow(pane: "general", title: L("General"), systemImage: "gearshape.fill", color: .gray)
                    SettingsSidebarAboutRow()
                }
                Section {
                    ForEach(filteredProviders) { provider in
                        SettingsSidebarProviderRow(provider: provider)
                            .tag(provider.id)
                    }
                } header: {
                    HStack(spacing: 4) {
                        Text("Providers")
                        Spacer()
                        Text("\(providers.filter(\.isConnected).count) on")
                            .foregroundStyle(.tertiary)
                            .monospacedDigit()
                            .padding(.trailing, 10)
                    }
                }
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
        }
        .padding(.horizontal, 8)
    }

    private var currentPaneTitle: String {
        switch selection.wrappedValue {
        case "general": return L("General")
        case "about": return L("About")
        default:
            return providers.first { $0.id == selection.wrappedValue }?.name ?? L("Settings")
        }
    }

    @ViewBuilder
    private var detailView: some View {
        switch selection.wrappedValue {
        case "claude": ClaudeSettingsTab()
        case "codex": CodexSettingsTab()
        case "kimi": KimiSettingsTab()
        case "devin": DevinSettingsTab()
        case "gemini": GeminiSettingsTab()
        case "copilot": CopilotSettingsTab()
        case "antigravity": AntigravitySettingsTab()
        case "about": AboutSettingsTab()
        default:
            if let provider = CapacityDockProvider(rawValue: selection.wrappedValue) {
                GenericProviderSettingsTab(provider: provider)
            } else {
                GeneralSettingsTab()
            }
        }
    }
}

// MARK: - Sidebar support

/// Colored rounded-square symbol used for app panes in the settings sidebar,
/// mirroring the System Settings sidebar style.
private struct SettingsIconChip: View {
    static let side: CGFloat = 20

    let systemImage: String
    let color: Color

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: Self.side, height: Self.side)
            .background(
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(LinearGradient(
                        colors: [color.opacity(0.85), color],
                        startPoint: .top,
                        endPoint: .bottom)))
            .accessibilityHidden(true)
    }
}

private struct SettingsSidebarPaneRow: View {
    let pane: String
    let title: String
    let systemImage: String
    let color: Color

    var body: some View {
        HStack(spacing: 8) {
            SettingsIconChip(systemImage: systemImage, color: color)
            Text(title)
        }
        .tag(pane)
    }
}

private struct SettingsSidebarAboutRow: View {
    var body: some View {
        HStack(spacing: 8) {
            // Standard info glyph in a chip, matching the General row's style.
            SettingsIconChip(systemImage: "info.circle.fill", color: .gray)
            Text("About")
        }
        .tag("about")
    }
}

private struct SettingsSidebarProviderRow: View {
    let provider: SettingsView.ProviderPane

    var body: some View {
        HStack(spacing: 8) {
            SettingsSidebarBrandIcon(icon: provider.icon, isConnected: provider.isConnected)

            Text(provider.name)
                .foregroundStyle(provider.isConnected ? .primary : .secondary)

            Spacer(minLength: 4)

            if provider.isConnected {
                Circle()
                    .fill(.green)
                    .frame(width: 6, height: 6)
                    .accessibilityHidden(true)
            }
        }
        .opacity(provider.isConnected ? 1 : 0.62)
    }
}

private struct SettingsSidebarBrandIcon: View {
    let icon: String
    let isConnected: Bool

    var body: some View {
        Group {
            if let image = ProviderIconCache.image(named: icon) {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFit()
            } else {
                Image(systemName: "circle.dotted")
                    .resizable()
                    .scaledToFit()
            }
        }
        .frame(width: 16, height: 16)
        .foregroundStyle(isConnected ? .primary : .secondary)
        .accessibilityHidden(true)
    }
}

private struct SettingsSidebarSearchField: View {
    @Binding var searchText: String

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)

            TextField("Search providers", text: $searchText)
                .textFieldStyle(.plain)

            if !searchText.isEmpty {
                Button {
                    searchText = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("Clear")
                }
                .buttonStyle(.plain)
            }
        }
        .font(.callout)
        .padding(.horizontal, 7)
        .padding(.vertical, 4)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(Color(nsColor: .textBackgroundColor).opacity(0.6)))
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .stroke(Color(nsColor: .separatorColor).opacity(0.6), lineWidth: 1))
    }
}

/// Edge-to-edge sidebar material so the sidebar runs up behind the transparent
/// titlebar, matching System Settings.
private struct SettingsSidebarMaterial: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        configure(view)
        return view
    }

    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {
        configure(nsView)
    }

    private func configure(_ view: NSVisualEffectView) {
        view.material = .sidebar
        view.blendingMode = .behindWindow
        view.state = .followsWindowActiveState
    }
}

/// Applies the System Settings window chrome (transparent, separator-less
/// titlebar over full-size content) to whichever window hosts this view.
/// Needed because the SwiftUI Settings scene exposes no styling hooks.
private struct SettingsWindowStyleAccessor: NSViewRepresentable {
    let title: String

    func makeNSView(context: Context) -> SettingsWindowStyleView {
        SettingsWindowStyleView()
    }

    func updateNSView(_ nsView: SettingsWindowStyleView, context: Context) {
        nsView.paneTitle = title
        nsView.applyStyle()
    }
}

private final class SettingsWindowStyleView: NSView {
    var paneTitle = L("Settings")

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        applyStyle()
    }

    private var didPlaceWindow = false

    func applyStyle() {
        guard let window else { return }
        // Full-size content lets the sidebar material extend behind the
        // titlebar so the edge-to-edge sidebar reaches the top of the window.
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .visible
        window.titlebarSeparatorStyle = .none
        window.styleMask.insert(.fullSizeContentView)
        window.styleMask.insert(.resizable)
        // Match System Settings: the window is named after the visible pane.
        window.title = paneTitle
        window.collectionBehavior.insert(.fullScreenPrimary)
        // The frameAutosave may restore a position saved when the window was
        // smaller, leaving the grown window hanging off the screen edge —
        // recenter once whenever it does not fit fully on its screen.
        if !didPlaceWindow {
            didPlaceWindow = true
            if let screen = window.screen ?? NSScreen.main,
               !screen.visibleFrame.contains(window.frame) {
                window.center()
            }
        }
    }
}

// MARK: - General

private struct GeneralSettingsTab: View {
    @Environment(AppStore.self) private var store

    // "Custom…" budget entry state, one per metric (cost in dollars, tokens in
    // millions). When custom is active the picker shows "Custom…" and a field
    // appears for an exact amount.
    @State private var costCustom = false
    @State private var tokenCustom = false
    @State private var costText = ""
    @State private var tokenText = ""

    // AppStorage (not a computed Binding over UsageRefreshCadence.current):
    // a plain UserDefaults write does not invalidate the view, so the picker
    // label would never reflect the selection even though the value landed.
    @AppStorage(UsageRefreshCadence.defaultsKey)
    private var usageRefreshSeconds: Int = UsageRefreshCadence.default.rawValue

    // Stored as the raw string so an unrecognised value (older build, manual
    // `defaults write`) parses back to .terminal instead of failing to decode.
    @AppStorage(PreferredTerminal.defaultsKey)
    private var preferredTerminalRaw: String = PreferredTerminal.default.rawValue

    private let costPresets: Set<Double> = [25, 50, 100, 200, 500]
    private let tokenPresets: Set<Double> = [1_000_000, 5_000_000, 10_000_000, 25_000_000, 50_000_000, 100_000_000]

    private func applyCostBudget() {
        store.dailyBudget = max(0, Double(costText.trimmingCharacters(in: .whitespaces)) ?? 0)
    }

    private func applyTokenBudget() {
        let millions = Double(tokenText.trimmingCharacters(in: .whitespaces)) ?? 0
        store.dailyTokenBudget = max(0, millions * 1_000_000)
    }

    private func trimNumber(_ v: Double) -> String {
        v == v.rounded() ? String(Int(v)) : String(v)
    }

    // Help text under the budget picker. When "Custom…" is selected but no amount
    // has been entered, the budget is effectively 0 (off); call that out so the
    // alert does not look armed when it isn't.
    private var alertHelpText: String {
        let customEmpty = store.isTokenMetric
            ? (tokenCustom && store.dailyTokenBudget == 0)
            : (costCustom && store.dailyBudget == 0)
        if customEmpty { return L("Enter an amount above, or the alert stays off.") }
        let metric = store.isTokenMetric ? L("tokens") : L("cost")
        return L("Flame icon turns yellow when today's \(metric) pass the daily budget.")
    }

    var body: some View {
        Form {
            Section("Display") {
                Picker("Currency", selection: Binding(
                    get: { store.currency },
                    set: { applyCurrency(code: $0) }
                )) {
                    ForEach(SupportedCurrency.allCases) { currency in
                        Text("\(currency.rawValue) · \(currency.displayName)").tag(currency.rawValue)
                    }
                }
                Picker("Metric", selection: Binding(
                    get: { store.displayMetric },
                    set: { store.displayMetric = $0 }
                )) {
                    Text("Cost ($)").tag(DisplayMetric.cost)
                    Text("Tokens (↑↓)").tag(DisplayMetric.tokens)
                    Text("Total Tokens").tag(DisplayMetric.totalTokens)
                    Text("Credits (Codex)").tag(DisplayMetric.credits)
                    Text("Icon Only").tag(DisplayMetric.iconOnly)
                }
                Picker("Icon color", selection: Binding(
                    get: { MenubarIconStyle.current },
                    set: { MenubarIconStyle.select($0) }
                )) {
                    ForEach(MenubarIconStyle.allCases) { style in
                        Text(style.displayName).tag(style)
                    }
                }
                .pickerStyle(.menu)
                Picker("Period", selection: Binding(
                    get: { store.menubarPeriod },
                    set: { store.setMenubarPeriod($0) }
                )) {
                    ForEach(Period.menubarMetricCases) { period in
                        Text(period.menubarMetricLabel).tag(period)
                    }
                }
                .pickerStyle(.menu)
                Picker("Scope", selection: Binding(
                    get: { store.menubarScope },
                    set: { store.setMenubarScope($0) }
                )) {
                    ForEach(MenubarScope.allCases) { scope in
                        Text(LR(scope.rawValue)).tag(scope)
                    }
                }
                .pickerStyle(.menu)
                Picker("Accent", selection: Binding(
                    get: { store.accentPreset },
                    set: { store.accentPreset = $0 }
                )) {
                    ForEach(AccentPreset.allCases) { preset in
                        Text(LR(preset.rawValue)).tag(preset)
                    }
                }
            }

            LanguageSettingsSection()

            CapacityDockSettingsSection()

            Section("Usage Refresh") {
                Picker("Update every", selection: Binding(
                    get: { UsageRefreshCadence(rawValue: usageRefreshSeconds) ?? .default },
                    set: { usageRefreshSeconds = $0.rawValue }
                )) {
                    ForEach(UsageRefreshCadence.allCases) { cadence in
                        Text(cadence.label).tag(cadence)
                    }
                }
                .pickerStyle(.menu)
                Text("How often the menubar figure re-reads your local session data. Auto refreshes every 30 seconds while you're plugged in and backs off on battery; Manual only refreshes when you open the popover or click Refresh Now.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }

            Section("Terminal") {
                Picker("Open commands in", selection: Binding(
                    get: { PreferredTerminal(rawValue: preferredTerminalRaw) ?? .default },
                    set: { preferredTerminalRaw = $0.rawValue }
                )) {
                    ForEach(PreferredTerminal.allCases) { terminal in
                        Text(terminal.isInstalled ? terminal.label : L("\(terminal.label) (not installed)"))
                            .tag(terminal)
                    }
                }
                .pickerStyle(.menu)
                Text("Where Full Report and Optimize open. If the chosen app isn't installed CodeBurn falls back to Terminal; if that's missing too the command runs in the background. Only terminals that can script a command into a live window are listed.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }

            Section("Alerts") {
                // The budget tracks whatever the menubar metric shows: dollars for
                // the Cost metric, tokens for the Tokens / Total Tokens metrics.
                // "Custom…" reveals a field for an exact amount.
                if store.isTokenMetric {
                    Picker("Daily budget", selection: Binding(
                        get: { tokenCustom ? -1.0 : store.dailyTokenBudget },
                        set: { sel in
                            if sel < 0 {
                                tokenCustom = true
                                tokenText = store.dailyTokenBudget > 0 ? trimNumber(store.dailyTokenBudget / 1_000_000) : ""
                            } else {
                                tokenCustom = false
                                store.dailyTokenBudget = sel
                            }
                        }
                    )) {
                        Text("Off").tag(0.0)
                        Text("1M").tag(1_000_000.0)
                        Text("5M").tag(5_000_000.0)
                        Text("10M").tag(10_000_000.0)
                        Text("25M").tag(25_000_000.0)
                        Text("50M").tag(50_000_000.0)
                        Text("100M").tag(100_000_000.0)
                        Text("Custom…").tag(-1.0)
                    }
                    if tokenCustom {
                        HStack {
                            TextField("Amount", text: $tokenText)
                                .multilineTextAlignment(.trailing)
                                .onSubmit { applyTokenBudget() }
                                .onChange(of: tokenText) { _, _ in applyTokenBudget() }
                            Text("M tokens").foregroundStyle(.secondary)
                        }
                    }
                } else {
                    Picker("Daily budget", selection: Binding(
                        get: { costCustom ? -1.0 : store.dailyBudget },
                        set: { sel in
                            if sel < 0 {
                                costCustom = true
                                costText = store.dailyBudget > 0 ? trimNumber(store.dailyBudget) : ""
                            } else {
                                costCustom = false
                                store.dailyBudget = sel
                            }
                        }
                    )) {
                        Text("Off").tag(0.0)
                        Text("$25").tag(25.0)
                        Text("$50").tag(50.0)
                        Text("$100").tag(100.0)
                        Text("$200").tag(200.0)
                        Text("$500").tag(500.0)
                        Text("Custom…").tag(-1.0)
                    }
                    if costCustom {
                        HStack {
                            Text("$").foregroundStyle(.secondary)
                            TextField("Amount", text: $costText)
                                .multilineTextAlignment(.trailing)
                                .onSubmit { applyCostBudget() }
                                .onChange(of: costText) { _, _ in applyCostBudget() }
                        }
                    }
                }
                Text(alertHelpText)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            .onAppear {
                costCustom = store.dailyBudget > 0 && !costPresets.contains(store.dailyBudget)
                if costCustom { costText = trimNumber(store.dailyBudget) }
                tokenCustom = store.dailyTokenBudget > 0 && !tokenPresets.contains(store.dailyTokenBudget)
                if tokenCustom { tokenText = trimNumber(store.dailyTokenBudget / 1_000_000) }
            }
        }
        .formStyle(.grouped)
        .padding()
    }

    private func applyCurrency(code: String) {
        let symbol = CurrencyState.symbolForCode(code)
        Task {
            let cached = await FXRateCache.shared.cachedRate(for: code)
            if let cached {
                store.currency = code
                CurrencyState.shared.apply(code: code, rate: cached, symbol: symbol)
            }
            let fresh = await FXRateCache.shared.rate(for: code)
            store.currency = code
            CurrencyState.shared.apply(code: code, rate: fresh ?? cached, symbol: symbol)
        }
        CLICurrencyConfig.persist(code: code)
    }
}

private struct CapacityDockSettingsSection: View {
    @Environment(AppStore.self) private var store
    @State private var snapshot = CapacityDockPreferences.load()

    private var manageableProviders: [CapacityDockProvider] {
        CapacityDockProviderSelection.manageableProviders(
            selected: snapshot.selectedProviders,
            isConnected: store.capacityDockProviderIsDockEligible
        )
    }

    private var enabledEligibleProviders: [CapacityDockProvider] {
        manageableProviders.filter {
            snapshot.selectedProviders.contains($0)
                && store.capacityDockProviderIsDockEligible($0)
        }
    }

    var body: some View {
        Section("Capacity Dock") {
            Toggle("Show Capacity Dock", isOn: Binding(
                get: { snapshot.isEnabled },
                set: { CapacityDockPreferences.setEnabled($0) }
            ))

            Toggle("Auto-hide at screen edge", isOn: Binding(
                get: { snapshot.isAutoHideEnabled },
                set: { CapacityDockPreferences.setAutoHide($0) }
            ))
            .disabled(snapshot.dockedEdge == nil)
            Text("Tucks the dock into the edge it is attached to and slides it out when the pointer reaches that edge. Only applies while the dock is snapped to an edge.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if !enabledEligibleProviders.isEmpty {
                Picker("Resting provider", selection: Binding(
                    get: {
                        enabledEligibleProviders.contains(snapshot.preferredProvider)
                            ? snapshot.preferredProvider
                            : enabledEligibleProviders[0]
                    },
                    set: { CapacityDockPreferences.setPreferredProvider($0) }
                )) {
                    ForEach(enabledEligibleProviders) { provider in
                        Text(provider.displayName).tag(provider)
                    }
                }
                .pickerStyle(.menu)
            }

            HStack(spacing: 10) {
                Text("Size")
                Slider(
                    value: Binding(
                        get: { snapshot.scale },
                        set: { CapacityDockPreferences.setScale($0) }
                    ),
                    in: CapacityDockPreferences.scaleRange,
                    step: 0.05
                )
                .accessibilityLabel("Capacity Dock size")
                Text("\(Int((snapshot.scale * 100).rounded()))%")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .frame(width: 38, alignment: .trailing)
            }

            Picker("Appearance", selection: Binding(
                get: { snapshot.theme },
                set: { CapacityDockPreferences.setTheme($0) }
            )) {
                ForEach(CapacityDockTheme.allCases, id: \.self) { theme in
                    Text(theme.displayName).tag(theme)
                }
            }
            .pickerStyle(.menu)

            Picker("Gauge shape", selection: Binding(
                get: { snapshot.gaugeShape },
                set: { CapacityDockPreferences.setGaugeShape($0) }
            )) {
                ForEach(CapacityDockGaugeShape.allCases, id: \.self) { shape in
                    Text(shape.displayName).tag(shape)
                }
            }
            .pickerStyle(.menu)

            Text("Dock providers")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
                .padding(.top, 4)

            if manageableProviders.isEmpty {
                Text("Connect a provider from its sidebar page to make it available here.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }

            ForEach(manageableProviders) { provider in
                Toggle(isOn: Binding(
                    get: { snapshot.selectedProviders.contains(provider) },
                    set: { setProvider(provider, selected: $0) }
                )) {
                    HStack(spacing: 7) {
                        if let image = ProviderIconCache.image(named: provider.iconName) {
                            Image(nsImage: image)
                                .resizable()
                                .scaledToFit()
                                .frame(width: 15, height: 15)
                                .foregroundStyle(.primary)
                        }
                        Text(provider.displayName)
                        if !store.capacityDockProviderIsConnected(provider) {
                            Text("Needs attention")
                                .font(.system(size: 10))
                                .foregroundStyle(.red)
                        }
                    }
                }
                .toggleStyle(.switch)
                .disabled(!CapacityDockProviderSelection.canDeselect(
                    provider,
                    selected: snapshot.selectedProviders,
                    isConnected: store.capacityDockProviderIsDockEligible
                ))
            }

            Text("Connected providers and anything already shown in the dock appear here, so a provider can always be removed even if its connection later fails.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .onAppear(perform: reload)
        .onReceive(NotificationCenter.default.publisher(for: .capacityDockPreferencesDidChange)) { _ in
            reload()
        }
        .onReceive(NotificationCenter.default.publisher(for: .capacityDockCredentialPresenceDidChange)) { _ in
            reload()
        }
    }

    private func setProvider(_ provider: CapacityDockProvider, selected: Bool) {
        var providers = snapshot.selectedProviders
        if selected {
            providers.append(provider)
        } else {
            providers.removeAll { $0 == provider }
        }
        CapacityDockPreferences.setSelectedProviders(providers)
    }

    private func reload() {
        snapshot = CapacityDockPreferences.load()
    }
}

// MARK: - Claude

private struct ClaudeSettingsTab: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        Form {
            Section("Connection") {
                ClaudeConnectionRow()
            }
            Section {
                ClaudeConfigDirsSection()
            } header: {
                Text("Config Directories")
            } footer: {
                Text("Aggregate usage across multiple Claude config directories (e.g. work and personal accounts). Leave empty to track just the default `~/.claude`. The `CLAUDE_CONFIG_DIRS` environment variable, if set, overrides this list.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            Section("Quota Refresh") {
                Picker("Update every", selection: Binding(
                    get: { SubscriptionRefreshCadence.current },
                    set: { SubscriptionRefreshCadence.current = $0 }
                )) {
                    ForEach(SubscriptionRefreshCadence.allCases) { cadence in
                        Text(cadence.label).tag(cadence)
                    }
                }
                .pickerStyle(.menu)
                Text("Anthropic rate-limits this endpoint per account. 2 minutes is plenty for the 5-hour and weekly windows; pick Manual if you only want updates on demand.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                Button("Refresh Now") {
                    if let delegate = NSApp.delegate as? AppDelegate {
                        delegate.refreshSubscriptionNow()
                    } else {
                        Task { await store.refreshSubscription() }
                    }
                }
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}

private struct ClaudeConnectionRow: View {
    @Environment(AppStore.self) private var store
    @State private var showDisconnectConfirm = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: stateIcon)
                .font(.system(size: 18))
                .foregroundStyle(stateTint)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(stateTitle)
                    .font(.system(size: 12, weight: .semibold))
                Text(stateDetail)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer()
            actionButton
        }
        .padding(.vertical, 4)
    }

    private var stateIcon: String {
        switch store.subscriptionLoadState {
        case .loaded: return "checkmark.circle.fill"
        case .terminalFailure: return "exclamationmark.triangle.fill"
        case .transientFailure: return "clock.arrow.circlepath"
        case .bootstrapping, .loading: return "ellipsis.circle"
        case .notBootstrapped, .dormant, .noCredentials: return "link.circle"
        case .failed: return "xmark.circle"
        }
    }

    private var stateTint: Color {
        switch store.subscriptionLoadState {
        case .loaded: return .green
        case .terminalFailure, .failed: return .red
        case .transientFailure: return .orange
        default: return .secondary
        }
    }

    private var stateTitle: String {
        switch store.subscriptionLoadState {
        case .loaded: return L("Connected")
        case let .terminalFailure(reason): return reason ?? L("Reconnect required")
        case .transientFailure: return L("Backing off")
        case .bootstrapping: return L("Connecting…")
        case .loading: return L("Refreshing…")
        case .dormant: return L("Ready")
        case .notBootstrapped, .noCredentials: return L("Not connected")
        case .failed: return L("Couldn't load plan data")
        }
    }

    private var stateDetail: String {
        switch store.subscriptionLoadState {
        case .loaded:
            if let tier = store.subscription?.tier.displayName {
                return L("Plan: \(tier)")
            }
            return L("Live quota tracked from Anthropic.")
        case .terminalFailure: return L("Open Claude Code in your terminal and type `/login`, then click Reconnect.")
        case .transientFailure: return store.subscriptionError ?? L("Anthropic rate-limited; auto-retrying.")
        case .bootstrapping: return "macOS may ask permission to read your credentials."
        case .loading: return L("Background refresh in progress.")
        case .dormant: return L("Tap Load Quota to fetch live usage from Anthropic.")
        case .notBootstrapped, .noCredentials: return L("Click Connect to read your Claude Code credentials and start tracking quota.")
        case .failed: return store.subscriptionError ?? ""
        }
    }

    @ViewBuilder
    private var actionButton: some View {
        switch store.subscriptionLoadState {
        case .loaded, .transientFailure, .loading:
            Button("Disconnect") { showDisconnectConfirm = true }
                .confirmationDialog(
                    "Disconnect Claude?",
                    isPresented: $showDisconnectConfirm
                ) {
                    Button("Disconnect", role: .destructive) {
                        store.disconnectSubscription()
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("CodeBurn will stop tracking quota and clear its connection state plus any legacy credential cache. Your Claude Code credential is untouched. Claude Code keeps working.")
                }
        case .terminalFailure, .noCredentials, .failed:
            Button("Reconnect") { Task { await store.bootstrapSubscription() } }
                .buttonStyle(.borderedProminent)
        case .dormant:
            Button("Load Quota") { Task { await store.activateClaudeFromDormant() } }
                .buttonStyle(.borderedProminent)
        case .notBootstrapped:
            Button("Connect") { Task { await store.bootstrapSubscription() } }
                .buttonStyle(.borderedProminent)
        case .bootstrapping:
            ProgressView().controlSize(.small)
        }
    }
}

// MARK: - Claude config directories

private struct ClaudeConfigDirsSection: View {
    @Environment(AppStore.self) private var store
    @State private var dirs: [String] = CLIClaudeConfig.load()

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if dirs.isEmpty {
                Text("No extra directories. Tracking the default `~/.claude`.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Array(dirs.enumerated()), id: \.offset) { index, dir in
                    HStack(spacing: 8) {
                        Image(systemName: "folder")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                        Text(dir)
                            .font(.system(size: 12))
                            .truncationMode(.middle)
                            .lineLimit(1)
                            .help(dir)
                        Spacer()
                        Button {
                            remove(at: index)
                        } label: {
                            Image(systemName: "minus.circle.fill")
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                        .help("Remove")
                    }
                }
            }

            Button {
                addDirectory()
            } label: {
                Label("Add Directory…", systemImage: "plus")
            }
            .controlSize(.small)
        }
        .padding(.vertical, 2)
    }

    private func addDirectory() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = true
        panel.prompt = L("Add")
        panel.message = L("Choose one or more Claude config directories (each containing a `projects` folder).")
        guard panel.runModal() == .OK else { return }

        let added = panel.urls.map { $0.path }
        var next = dirs
        for path in added where !next.contains(path) {
            next.append(path)
        }
        apply(next)
    }

    private func remove(at index: Int) {
        guard dirs.indices.contains(index) else { return }
        var next = dirs
        next.remove(at: index)
        apply(next)
    }

    /// Persists the new list and kicks a forced refresh so the dashboard
    /// reflects the changed aggregation immediately.
    private func apply(_ next: [String]) {
        dirs = next
        CLIClaudeConfig.persist(dirs: next)
        Task { await store.refresh(includeOptimize: false, force: true, showLoading: true) }
    }
}

// MARK: - Codex

private struct CodexSettingsTab: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        Form {
            Section {
                CodexConnectionRow()
            }
            Section {
                Text("Codex live-quota tracking follows the authoritative `~/.codex/auth.json` session directly and does not create a second Keychain copy. A legacy CodeBurn Keychain item, when present, is read only as a migration fallback. Only ChatGPT-mode auth (Plus / Pro / Team / Business / Edu / Enterprise) is supported. API-key users are billed per request and have a different reporting surface. Credit-metered workspaces report no rate-limit windows, so their monthly credit allowance is shown instead.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            } header: {
                Text("How it works")
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}

private struct CodexConnectionRow: View {
    @Environment(AppStore.self) private var store
    @State private var showDisconnectConfirm = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: stateIcon)
                .font(.system(size: 18))
                .foregroundStyle(stateTint)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(stateTitle)
                    .font(.system(size: 12, weight: .semibold))
                Text(stateDetail)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer()
            actionButton
        }
        .padding(.vertical, 4)
    }

    private var stateIcon: String {
        switch store.codexLoadState {
        case .loaded: return "checkmark.circle.fill"
        case .terminalFailure: return "exclamationmark.triangle.fill"
        case .transientFailure: return "clock.arrow.circlepath"
        case .bootstrapping, .loading: return "ellipsis.circle"
        case .notBootstrapped, .dormant, .noCredentials: return "link.circle"
        case .failed: return "xmark.circle"
        }
    }

    private var stateTint: Color {
        switch store.codexLoadState {
        case .loaded: return .green
        case .terminalFailure, .failed: return .red
        case .transientFailure: return .orange
        default: return .secondary
        }
    }

    private var stateTitle: String {
        switch store.codexLoadState {
        case .loaded: return L("Connected")
        case let .terminalFailure(reason): return reason ?? L("Reconnect required")
        case .transientFailure: return L("Backing off")
        case .bootstrapping: return L("Connecting…")
        case .loading: return L("Refreshing…")
        case .dormant: return L("Ready")
        case .notBootstrapped, .noCredentials: return L("Not connected")
        case .failed: return L("Couldn't load Codex quota")
        }
    }

    private var stateDetail: String {
        switch store.codexLoadState {
        case .loaded:
            if let plan = store.codexUsage?.plan.displayName {
                return L("Plan: \(plan)")
            }
            return L("Live quota tracked from chatgpt.com.")
        case .terminalFailure:
            // Be specific about the cause: the message we already surface in
            // codexError will say "API-key mode" if that's the situation, so
            // the generic "run codex login" hint covers both cases.
            if let err = store.codexError, err.lowercased().contains("api-key") {
                return L("Codex is in API-key mode. Run `codex login` and choose a ChatGPT plan to enable quota tracking.")
            }
            return L("Run `codex login` in your terminal to sign in again, then click Reconnect.")
        case .transientFailure: return store.codexError ?? L("ChatGPT rate-limited; auto-retrying.")
        case .bootstrapping: return L("Reading ~/.codex/auth.json.")
        case .loading: return L("Background refresh in progress.")
        case .dormant: return L("Tap Load Quota to fetch live usage from chatgpt.com.")
        case .notBootstrapped, .noCredentials:
            return L("Click Connect to read your Codex CLI credentials. If Connect fails, run `codex login` in your terminal first to create ~/.codex/auth.json.")
        case .failed: return store.codexError ?? ""
        }
    }

    @ViewBuilder
    private var actionButton: some View {
        switch store.codexLoadState {
        case .loaded, .transientFailure, .loading:
            Button("Disconnect") { showDisconnectConfirm = true }
                .confirmationDialog(
                    "Disconnect Codex?",
                    isPresented: $showDisconnectConfirm
                ) {
                    Button("Disconnect", role: .destructive) {
                        store.disconnectCodex()
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("CodeBurn will stop tracking quota and clear its connection state plus any legacy credential cache. Your ~/.codex/auth.json is untouched. Codex CLI keeps working.")
                }
        case .terminalFailure, .noCredentials, .failed:
            Button("Reconnect") { Task { await store.bootstrapCodex() } }
                .buttonStyle(.borderedProminent)
        case .dormant:
            Button("Load Quota") { Task { await store.activateCodexFromDormant() } }
                .buttonStyle(.borderedProminent)
        case .notBootstrapped:
            Button("Connect") { Task { await store.bootstrapCodex() } }
                .buttonStyle(.borderedProminent)
        case .bootstrapping:
            ProgressView().controlSize(.small)
        }
    }
}

// MARK: - Kimi Code

private struct KimiSettingsTab: View {
    var body: some View {
        Form {
            Section("Connection") {
                KimiConnectionRow()
            }
            Section {
                Text("Kimi Code live-quota tracking reads `~/.kimi-code/credentials/kimi-code.json` directly. Nothing is copied or stored. Access tokens are short-lived (~15 minutes) and only the Kimi CLI refreshes them, so if the connection shows as expired, run the Kimi CLI once and click Reconnect.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            } header: {
                Text("How it works")
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}

private struct KimiConnectionRow: View {
    @Environment(AppStore.self) private var store
    @State private var showDisconnectConfirm = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: stateIcon)
                .font(.system(size: 18))
                .foregroundStyle(stateTint)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(stateTitle)
                    .font(.system(size: 12, weight: .semibold))
                Text(stateDetail)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer()
            actionButton
        }
        .padding(.vertical, 4)
    }

    private var stateIcon: String {
        switch store.kimiLoadState {
        case .loaded: return "checkmark.circle.fill"
        case .terminalFailure: return "exclamationmark.triangle.fill"
        case .transientFailure: return "clock.arrow.circlepath"
        case .bootstrapping, .loading: return "ellipsis.circle"
        case .notBootstrapped, .dormant, .noCredentials: return "link.circle"
        case .failed: return "xmark.circle"
        }
    }

    private var stateTint: Color {
        switch store.kimiLoadState {
        case .loaded: return .green
        case .terminalFailure, .failed: return .red
        case .transientFailure: return .orange
        default: return .secondary
        }
    }

    private var stateTitle: String {
        switch store.kimiLoadState {
        case .loaded: return L("Connected")
        case let .terminalFailure(reason): return reason ?? L("Login refresh required")
        case .transientFailure: return L("Backing off")
        case .bootstrapping: return L("Connecting…")
        case .loading: return L("Refreshing…")
        case .dormant: return L("Ready")
        case .notBootstrapped, .noCredentials: return L("Not connected")
        case .failed: return L("Couldn't load Kimi quota")
        }
    }

    private var stateDetail: String {
        switch store.kimiLoadState {
        case .loaded:
            return L("Live quota tracked from api.kimi.com.")
        case .terminalFailure:
            return L("Run the Kimi CLI once to refresh your login, then click Reconnect.")
        case .transientFailure: return store.kimiError ?? L("Kimi rate-limited; auto-retrying.")
        case .bootstrapping: return L("Reading ~/.kimi-code credentials.")
        case .loading: return L("Background refresh in progress.")
        case .dormant: return L("Tap Load Quota to fetch live usage from api.kimi.com.")
        case .notBootstrapped, .noCredentials:
            return L("Sign in with the Kimi CLI first, then click Connect.")
        case .failed: return store.kimiError ?? ""
        }
    }

    @ViewBuilder
    private var actionButton: some View {
        switch store.kimiLoadState {
        case .loaded, .transientFailure, .loading:
            Button("Disconnect") { showDisconnectConfirm = true }
                .confirmationDialog(
                    "Disconnect Kimi Code?",
                    isPresented: $showDisconnectConfirm
                ) {
                    Button("Disconnect", role: .destructive) {
                        store.disconnectKimi()
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("CodeBurn will stop tracking Kimi Code quota. Your ~/.kimi-code credentials are untouched. The Kimi CLI keeps working.")
                }
        case .terminalFailure, .noCredentials, .failed:
            Button("Reconnect") { Task { await store.bootstrapKimi() } }
                .buttonStyle(.borderedProminent)
        case .dormant:
            Button("Load Quota") { Task { await store.bootstrapKimi() } }
                .buttonStyle(.borderedProminent)
        case .notBootstrapped:
            Button("Connect") { Task { await store.bootstrapKimi() } }
                .buttonStyle(.borderedProminent)
        case .bootstrapping:
            ProgressView().controlSize(.small)
        }
    }
}

// MARK: - Gemini

private struct GeminiSettingsTab: View {
    var body: some View {
        Form {
            Section("Connection") {
                GeminiConnectionRow()
            }
            Section {
                Text("Gemini live-quota tracking reads `~/.gemini/oauth_creds.json` read-only. Nothing is copied or stored, and tokens stay in memory. If the connection shows as expired, run the Gemini CLI once to refresh your login, then click Reconnect.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            } header: {
                Text("How it works")
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}

private struct GeminiConnectionRow: View {
    @Environment(AppStore.self) private var store
    @State private var showDisconnectConfirm = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: stateIcon)
                .font(.system(size: 18))
                .foregroundStyle(stateTint)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(stateTitle)
                    .font(.system(size: 12, weight: .semibold))
                Text(stateDetail)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer()
            actionButton
        }
        .padding(.vertical, 4)
    }

    private var stateIcon: String {
        switch store.geminiLoadState {
        case .loaded: return "checkmark.circle.fill"
        case .terminalFailure: return "exclamationmark.triangle.fill"
        case .transientFailure: return "clock.arrow.circlepath"
        case .bootstrapping, .loading: return "ellipsis.circle"
        case .notBootstrapped, .dormant, .noCredentials: return "link.circle"
        case .failed: return "xmark.circle"
        }
    }

    private var stateTint: Color {
        switch store.geminiLoadState {
        case .loaded: return .green
        case .terminalFailure, .failed: return .red
        case .transientFailure: return .orange
        default: return .secondary
        }
    }

    private var stateTitle: String {
        switch store.geminiLoadState {
        case .loaded: return L("Connected")
        case let .terminalFailure(reason): return reason ?? L("Login refresh required")
        case .transientFailure: return L("Backing off")
        case .bootstrapping: return L("Connecting…")
        case .loading: return L("Refreshing…")
        case .dormant: return L("Ready")
        case .notBootstrapped, .noCredentials: return L("Not connected")
        case .failed: return L("Couldn't load Gemini quota")
        }
    }

    private var stateDetail: String {
        switch store.geminiLoadState {
        case .loaded:
            if let plan = store.geminiUsage?.plan {
                return L("Plan: \(plan)")
            }
            return L("Live quota tracked from Google Code Assist.")
        case .terminalFailure:
            return L("Run the Gemini CLI once to refresh your login, then click Reconnect.")
        case .transientFailure: return store.geminiError ?? L("Gemini rate-limited; auto-retrying.")
        case .bootstrapping: return L("Reading ~/.gemini credentials.")
        case .loading: return L("Background refresh in progress.")
        case .dormant: return L("Tap Load Quota to fetch live usage from Google Code Assist.")
        case .notBootstrapped, .noCredentials:
            return L("Sign in with the Gemini CLI first, then click Connect.")
        case .failed: return store.geminiError ?? ""
        }
    }

    @ViewBuilder
    private var actionButton: some View {
        switch store.geminiLoadState {
        case .loaded, .transientFailure, .loading:
            Button("Disconnect") { showDisconnectConfirm = true }
                .confirmationDialog(
                    "Disconnect Gemini?",
                    isPresented: $showDisconnectConfirm
                ) {
                    Button("Disconnect", role: .destructive) {
                        store.disconnectGemini()
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("CodeBurn will stop tracking Gemini quota. Your ~/.gemini credentials are untouched. The Gemini CLI keeps working.")
                }
        case .terminalFailure, .noCredentials, .failed:
            Button("Reconnect") { Task { await store.bootstrapGemini() } }
                .buttonStyle(.borderedProminent)
        case .dormant:
            Button("Load Quota") { Task { await store.bootstrapGemini() } }
                .buttonStyle(.borderedProminent)
        case .notBootstrapped:
            Button("Connect") { Task { await store.bootstrapGemini() } }
                .buttonStyle(.borderedProminent)
        case .bootstrapping:
            ProgressView().controlSize(.small)
        }
    }
}

// MARK: - Copilot

private struct CopilotSettingsTab: View {
    var body: some View {
        Form {
            Section("Connection") {
                CopilotConnectionRow()
            }
            CopilotTokenSection()
            Section {
                Text("Copilot live-quota tracking reads a GitHub token that is already on this Mac, read-only. Nothing is copied or stored. CodeBurn looks at the editor plugin files in `~/.config/github-copilot`, the Copilot CLI's `~/.copilot` files, the COPILOT_GITHUB_TOKEN, GH_TOKEN and GITHUB_TOKEN variables, `gh auth token`, and finally a token you paste below. Usage tracking works without any of this; only the live quota bars need a token.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            } header: {
                Text("How it works")
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}

/// Last rung of the credential chain: a token the user pastes here. Stored in
/// CodeBurn's own provider-scoped Keychain item, the same one ClinePass uses.
private struct CopilotTokenSection: View {
    @Environment(AppStore.self) private var store
    @State private var token = ""
    @State private var isSaving = false
    @State private var errorText: String?

    var body: some View {
        Section {
            SecureField("GitHub token", text: $token)
            HStack {
                Button("Save & Connect") { save(token) }
                    .buttonStyle(.borderedProminent)
                    .disabled(isSaving || token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button("Clear Token") { save("") }
                    .disabled(isSaving)
                if isSaving {
                    ProgressView().controlSize(.small)
                }
            }
            if let errorText {
                Text(errorText)
                    .font(.system(size: 11))
                    .foregroundStyle(.red)
            }
        } header: {
            Text("Paste a token")
        } footer: {
            Text("Optional, and only needed when nothing else on this Mac is signed in. A fine-grained personal access token with the \"Plan: Read-only\" permission is enough. The token is saved in CodeBurn's own Keychain item and is used only to read your Copilot quota.")
                .font(.system(size: 11))
        }
    }

    private func save(_ raw: String) {
        isSaving = true
        errorText = nil
        Task {
            defer { isSaving = false }
            do {
                try await CapacityDockProviderCredentialStore.saveAsync(
                    CapacityDockProviderCredential(apiKey: raw),
                    for: CopilotSubscriptionService.providerID
                )
                token = ""
                CopilotSubscriptionService.resetProbeCache()
                await store.bootstrapCopilot()
            } catch {
                errorText = error.localizedDescription
            }
        }
    }
}

private struct CopilotConnectionRow: View {
    @Environment(AppStore.self) private var store
    @State private var showDisconnectConfirm = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: stateIcon)
                .font(.system(size: 18))
                .foregroundStyle(stateTint)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(stateTitle)
                    .font(.system(size: 12, weight: .semibold))
                Text(stateDetail)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer()
            actionButton
        }
        .padding(.vertical, 4)
    }

    private var stateIcon: String {
        switch store.copilotLoadState {
        case .loaded: return "checkmark.circle.fill"
        case .terminalFailure: return "exclamationmark.triangle.fill"
        case .transientFailure: return "clock.arrow.circlepath"
        case .bootstrapping, .loading: return "ellipsis.circle"
        case .notBootstrapped, .dormant, .noCredentials: return "link.circle"
        case .failed: return "xmark.circle"
        }
    }

    private var stateTint: Color {
        switch store.copilotLoadState {
        case .loaded: return .green
        case .terminalFailure, .failed: return .red
        case .transientFailure: return .orange
        default: return .secondary
        }
    }

    private var stateTitle: String {
        switch store.copilotLoadState {
        case .loaded: return L("Connected")
        case let .terminalFailure(reason): return reason ?? L("Login refresh required")
        case .transientFailure: return L("Backing off")
        case .bootstrapping: return L("Connecting…")
        case .loading: return L("Refreshing…")
        case .dormant: return L("Ready")
        case .notBootstrapped, .noCredentials: return L("Not connected")
        case .failed: return L("Couldn't load Copilot quota")
        }
    }

    private var stateDetail: String {
        switch store.copilotLoadState {
        case .loaded:
            if let plan = store.copilotUsage?.plan {
                return L("Plan: \(plan)")
            }
            return L("Live quota tracked from api.github.com.")
        case .terminalFailure:
            return L("Sign in again with the Copilot CLI, an editor's Copilot plugin, or gh auth login, then click Reconnect.")
        case .transientFailure: return store.copilotError ?? L("GitHub rate-limited; auto-retrying.")
        case .bootstrapping: return L("Looking for a GitHub token on this Mac.")
        case .loading: return L("Background refresh in progress.")
        case .dormant: return L("Tap Load Quota to fetch live usage from api.github.com.")
        case .notBootstrapped, .noCredentials:
            return L("Usage tracking still works. For live quota, sign in with the Copilot CLI or gh auth login, or paste a token below, then click Connect.")
        case .failed: return store.copilotError ?? ""
        }
    }

    @ViewBuilder
    private var actionButton: some View {
        switch store.copilotLoadState {
        case .loaded, .transientFailure, .loading:
            Button("Disconnect") { showDisconnectConfirm = true }
                .confirmationDialog(
                    "Disconnect Copilot?",
                    isPresented: $showDisconnectConfirm
                ) {
                    Button("Disconnect", role: .destructive) {
                        store.disconnectCopilot()
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("CodeBurn will stop tracking Copilot quota. Every credential it read stays untouched, and your Copilot clients keep working.")
                }
        case .terminalFailure, .noCredentials, .failed:
            Button("Reconnect") { Task { await store.bootstrapCopilot() } }
                .buttonStyle(.borderedProminent)
        case .dormant:
            Button("Load Quota") { Task { await store.bootstrapCopilot() } }
                .buttonStyle(.borderedProminent)
        case .notBootstrapped:
            Button("Connect") { Task { await store.bootstrapCopilot() } }
                .buttonStyle(.borderedProminent)
        case .bootstrapping:
            ProgressView().controlSize(.small)
        }
    }
}

// MARK: - Antigravity

private struct AntigravitySettingsTab: View {
    var body: some View {
        Form {
            Section("Connection") {
                AntigravityConnectionRow()
            }
            Section {
                Text("Antigravity live-quota tracking talks to the Antigravity app's local language server on 127.0.0.1 only. Nothing leaves the machine and no credential files are read. If it shows as disconnected, start the Antigravity app, then click Reconnect.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            } header: {
                Text("How it works")
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}

private struct AntigravityConnectionRow: View {
    @Environment(AppStore.self) private var store
    @State private var showDisconnectConfirm = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: stateIcon)
                .font(.system(size: 18))
                .foregroundStyle(stateTint)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(stateTitle)
                    .font(.system(size: 12, weight: .semibold))
                Text(stateDetail)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer()
            actionButton
        }
        .padding(.vertical, 4)
    }

    private var stateIcon: String {
        switch store.antigravityLoadState {
        case .loaded: return "checkmark.circle.fill"
        case .terminalFailure: return "exclamationmark.triangle.fill"
        case .transientFailure: return "clock.arrow.circlepath"
        case .bootstrapping, .loading: return "ellipsis.circle"
        case .notBootstrapped, .dormant, .noCredentials: return "link.circle"
        case .failed: return "xmark.circle"
        }
    }

    private var stateTint: Color {
        switch store.antigravityLoadState {
        case .loaded: return .green
        case .terminalFailure, .failed: return .red
        case .transientFailure: return .orange
        default: return .secondary
        }
    }

    private var stateTitle: String {
        switch store.antigravityLoadState {
        case .loaded: return L("Connected")
        case let .terminalFailure(reason): return reason ?? L("Reconnect required")
        case .transientFailure: return L("Backing off")
        case .bootstrapping: return L("Connecting…")
        case .loading: return L("Refreshing…")
        case .dormant: return L("Ready")
        case .notBootstrapped, .noCredentials: return L("Not connected")
        case .failed: return L("Couldn't load Antigravity quota")
        }
    }

    private var stateDetail: String {
        switch store.antigravityLoadState {
        case .loaded:
            if let plan = store.antigravityUsage?.plan {
                return L("Plan: \(plan)")
            }
            return L("Live quota tracked from the local Antigravity server.")
        case .terminalFailure:
            return L("Start the Antigravity app, then click Reconnect.")
        case .transientFailure: return store.antigravityError ?? L("Local probe failed; auto-retrying.")
        case .bootstrapping: return L("Probing the local Antigravity language server.")
        case .loading: return L("Background refresh in progress.")
        case .dormant: return L("Tap Load Quota to probe the local Antigravity server.")
        case .notBootstrapped:
            return L("Start the Antigravity app first, then click Connect.")
        case .noCredentials:
            return L("No local Antigravity server found. Start the Antigravity app, then click Reconnect.")
        case .failed: return store.antigravityError ?? ""
        }
    }

    @ViewBuilder
    private var actionButton: some View {
        switch store.antigravityLoadState {
        case .loaded, .transientFailure, .loading:
            Button("Disconnect") { showDisconnectConfirm = true }
                .confirmationDialog(
                    "Disconnect Antigravity?",
                    isPresented: $showDisconnectConfirm
                ) {
                    Button("Disconnect", role: .destructive) {
                        store.disconnectAntigravity()
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("CodeBurn will stop tracking Antigravity quota. Nothing is read from or written to disk. The Antigravity app keeps working.")
                }
        case .terminalFailure, .noCredentials, .failed:
            Button("Reconnect") { Task { await store.bootstrapAntigravity() } }
                .buttonStyle(.borderedProminent)
        case .dormant:
            Button("Load Quota") { Task { await store.bootstrapAntigravity() } }
                .buttonStyle(.borderedProminent)
        case .notBootstrapped:
            Button("Connect") { Task { await store.bootstrapAntigravity() } }
                .buttonStyle(.borderedProminent)
        case .bootstrapping:
            ProgressView().controlSize(.small)
        }
    }
}

// MARK: - Catalog providers

/// Draft connection-override fields shown in Settings. Persistence stays
/// account-keyed; this value is only the in-memory editor and must be
/// rebuilt whenever the selected provider identity changes.
struct ProviderSettingsEditorState: Equatable {
    var providerID: String
    var credential: CapacityDockProviderCredential
    var savedCredential: CapacityDockProviderCredential
    var localError: String?

    static func load(
        providerID: String,
        stored: CapacityDockProviderCredential
    ) -> ProviderSettingsEditorState {
        ProviderSettingsEditorState(
            providerID: providerID,
            credential: stored,
            savedCredential: stored,
            localError: nil
        )
    }

    mutating func applyProviderChange(
        to providerID: String,
        stored: CapacityDockProviderCredential
    ) {
        guard self.providerID != providerID else { return }
        self = .load(providerID: providerID, stored: stored)
    }

    mutating func beginLoading(providerID: String) {
        guard self.providerID != providerID else { return }
        self = .load(providerID: providerID, stored: CapacityDockProviderCredential())
    }

    /// A Keychain read can finish after the user has selected another row.
    /// Ignore that stale result so one provider's secret can never appear in
    /// another provider's editor, even for a single rendered frame.
    mutating func applyLoadedCredential(
        _ stored: CapacityDockProviderCredential,
        for providerID: String
    ) {
        guard self.providerID == providerID else { return }
        self = .load(providerID: providerID, stored: stored)
    }
}

private struct GenericProviderSettingsTab: View {
    let provider: CapacityDockProvider

    var body: some View {
        Form {
            GenericProviderConnectionSections(provider: provider)
                .id(provider.id)
        }
        .formStyle(.grouped)
        .padding()
    }
}

private struct GenericProviderConnectionSections: View {
    @Environment(AppStore.self) private var store

    let provider: CapacityDockProvider
    @State private var editor = ProviderSettingsEditorState.load(
        providerID: "",
        stored: CapacityDockProviderCredential()
    )
    @State private var credentialIsLoading = false

    private var summary: QuotaSummary? {
        store.capacityDockQuotaSummary(for: provider)
    }

    private var isLoading: Bool {
        store.capacityDockProvidersLoading.contains(provider.id)
    }

    private var isConnected: Bool {
        guard let connection = summary?.connection else { return false }
        return connection == .connected || connection == .stale
    }

    private var hasLiveAdapter: Bool {
        provider.catalogEntry.hasLiveCodeBurnQuotaAdapter
    }

    private var sourceModes: [ProviderReferenceSourceMode] {
        ProviderReferenceSourceMode.allCases.filter(provider.catalogEntry.sourceModes.contains)
    }

    private var authMethods: [ProviderAuthMethod] {
        ProviderAuthMethod.allCases.filter(provider.catalogEntry.authMethods.contains)
    }

    private var supportsAPIKey: Bool {
        provider.catalogEntry.authMethods.contains(.apiTokenOrCloudCredentials)
    }

    var body: some View {
        Group {
            Section {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: connectionIcon)
                        .font(.system(size: 18))
                        .foregroundStyle(connectionTint)
                        .frame(width: 22)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(connectionTitle)
                            .font(.system(size: 12, weight: .semibold))
                        Text(connectionDetail)
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer()
                    if !hasLiveAdapter {
                        Text("Not yet supported")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.secondary)
                    } else if isLoading {
                        ProgressView().controlSize(.small)
                    } else if isConnected {
                        Button("Disconnect", role: .destructive) {
                            Task {
                                do {
                                    try await store.disconnectCapacityDockProvider(provider)
                                    editor = .load(
                                        providerID: provider.id,
                                        stored: CapacityDockProviderCredential()
                                    )
                                } catch {
                                    editor.localError = error.localizedDescription
                                }
                            }
                        }
                    } else {
                        Button(primaryConnectionButtonTitle, action: connect)
                        .buttonStyle(.borderedProminent)
                    }
                }
                .padding(.vertical, 4)
            } header: {
                Text("Connection")
            } footer: {
                Text(hasLiveAdapter
                    ? "Automatic connection uses the provider's existing app, CLI, OAuth, browser session, or environment credentials first. CodeBurn does not copy those source credentials into its Keychain."
                    : "Authentication methods are listed for reference. A native CodeBurn quota adapter is required before this provider can connect to Capacity Dock.")
                    .font(.system(size: 11))
            }

            Section("Authentication methods") {
                ForEach(authMethods, id: \.self) { method in
                    Label(method.title, systemImage: authIcon(method))
                        .font(.system(size: 11.5))
                }
            }

            if hasLiveAdapter {
                Section {
                Picker("Source", selection: $editor.credential.sourceMode) {
                    ForEach(sourceModes, id: \.self) { source in
                        Text(sourceTitle(source)).tag(source.rawValue)
                    }
                }
                .pickerStyle(.menu)

                if supportsAPIKey {
                    SecureField("API key or token", text: $editor.credential.apiKey)
                }

                HStack {
                    Button("Save & Connect") { saveAndConnect() }
                        .buttonStyle(.borderedProminent)
                    Button("Clear Override") {
                        Task {
                            do {
                                try await store.disconnectCapacityDockProvider(provider)
                                editor = .load(
                                    providerID: provider.id,
                                    stored: CapacityDockProviderCredential()
                                )
                            } catch {
                                editor.localError = error.localizedDescription
                            }
                        }
                    }
                    .disabled(editor.savedCredential.isEmpty || credentialIsLoading)

                    if credentialIsLoading {
                        ProgressView()
                            .controlSize(.small)
                            .accessibilityLabel("Loading saved provider credential")
                    }
                }

                if let localError = editor.localError {
                    Text(localError)
                        .font(.system(size: 11))
                        .foregroundStyle(.red)
                }
            } header: {
                Text("Connection override")
            } footer: {
                Text("Overrides are optional and are saved only when you press Save & Connect. Secret values use one CodeBurn-owned Keychain item for this provider; background reads suppress authentication UI.")
                    .font(.system(size: 11))
            }
            .disabled(credentialIsLoading)
            } else if CapacityDockProviderCredentialPresence.contains(provider.id) {
                Section {
                    Button("Remove saved override", role: .destructive) {
                        Task {
                            do {
                                try await store.disconnectCapacityDockProvider(provider)
                                editor = .load(
                                    providerID: provider.id,
                                    stored: CapacityDockProviderCredential()
                                )
                            } catch {
                                editor.localError = error.localizedDescription
                            }
                        }
                    }
                    if let localError = editor.localError {
                        Text(localError)
                            .font(.system(size: 11))
                            .foregroundStyle(.red)
                    }
                } header: {
                    Text("Saved data")
                } footer: {
                    Text("This credential predates a live CodeBurn quota adapter and is not treated as a connection.")
                        .font(.system(size: 11))
                }
            }
        }
        .task(id: provider.id) {
            await reloadEditor()
        }
    }

    private var connectionTitle: String {
        guard hasLiveAdapter else { return L("Quota adapter not available") }
        if isLoading { return L("Connecting…") }
        guard let summary else { return L("Not connected") }
        switch summary.connection {
        case .connected: return L("Connected")
        case .loading: return L("Connecting…")
        case .stale: return L("Refreshing…")
        case .transientFailure: return L("Retrying")
        case .terminalFailure: return L("Reconnect required")
        case .disconnected: return L("Not connected")
        }
    }

    private var connectionDetail: String {
        guard hasLiveAdapter else {
            return L("\(provider.displayName) is catalogued, but CodeBurn cannot fetch its live quota yet.")
        }
        if let error = store.capacityDockProviderErrors[provider.id], !error.isEmpty {
            return "\(error) \(ProviderConnectionGuidance.instruction(for: provider))"
        }
        guard let summary else {
            return ProviderConnectionGuidance.instruction(for: provider)
        }
        if case let .terminalFailure(reason) = summary.connection {
            let instruction = ProviderConnectionGuidance.instruction(for: provider)
            guard let reason, !reason.isEmpty else { return instruction }
            return "\(reason) \(instruction)"
        }
        if let source = summary.footerLines.first(where: { $0.hasPrefix("Source:") }) {
            return LR(source)
        }
        return isConnected ? L("Live quota is available to Capacity Dock.") : L("Waiting for quota data.")
    }

    private var connectionIcon: String {
        if isLoading { return "ellipsis.circle" }
        return isConnected ? "checkmark.circle.fill" : "link.circle"
    }

    private var connectionTint: Color {
        if isConnected { return .green }
        if case .terminalFailure = summary?.connection { return .red }
        return .secondary
    }

    private var requiresExplicitCredential: Bool {
        // A provider whose only authentication path is an API credential cannot
        // be connected from an empty "Automatic" draft: its live adapter still
        // needs this provider-scoped key. Mixed-auth providers may legitimately
        // discover an existing app, CLI, OAuth, or browser session instead.
        provider.catalogEntry.authMethods == [.apiTokenOrCloudCredentials]
    }

    private var submissionAction: ProviderConnectionSubmissionPolicy.Action {
        ProviderConnectionSubmissionPolicy.resolve(
            credential: editor.credential,
            savedCredential: editor.savedCredential,
            requiresExplicitCredential: requiresExplicitCredential
        )
    }

    private var primaryConnectionButtonTitle: String {
        switch submissionAction {
        case .saveAndConnect: return L("Save & Connect")
        case .connect, .requiresCredential: return summary == nil ? L("Connect") : L("Retry")
        }
    }

    private func saveAndConnect() {
        if requiresExplicitCredential,
           editor.credential.apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            editor.localError = ProviderConnectionGuidance.instruction(for: provider)
            return
        }
        let credential = editor.credential
        Task {
            do {
                try await store.saveCapacityDockCredential(credential, for: provider)
                editor.savedCredential = credential
                editor.localError = nil
                await store.connectCapacityDockProvider(provider)
            } catch {
                editor.localError = error.localizedDescription
            }
        }
    }

    private func authIcon(_ method: ProviderAuthMethod) -> String {
        switch method {
        case .localAppOrCLI: "terminal"
        case .oauth: "person.badge.key"
        case .apiTokenOrCloudCredentials: "key"
        case .cookieOrWebSession: "globe"
        case .localhost: "network"
        case .none: "checkmark.seal"
        }
    }

    private func sourceTitle(_ source: ProviderReferenceSourceMode) -> String {
        switch source {
        case .automatic: L("Automatic")
        case .web: L("Browser session")
        case .cli: L("CLI")
        case .oauth: L("OAuth")
        case .api: L("API")
        }
    }

    private func connect() {
        switch submissionAction {
        case .requiresCredential:
            editor.localError = ProviderConnectionGuidance.instruction(for: provider)
        case .saveAndConnect:
            saveAndConnect()
        case .connect:
            editor.localError = nil
            Task { await store.connectCapacityDockProvider(provider) }
        }
    }

    private func reloadEditor() async {
        let providerID = provider.id
        editor.beginLoading(providerID: providerID)
        credentialIsLoading = true
        defer {
            if editor.providerID == providerID {
                credentialIsLoading = false
            }
        }

        do {
            let stored = try await CapacityDockProviderCredentialStore.loadAsync(for: providerID)
            guard !Task.isCancelled else { return }
            editor.applyLoadedCredential(stored, for: providerID)
        } catch {
            guard !Task.isCancelled, editor.providerID == providerID else { return }
            editor.localError = error.localizedDescription
        }
    }

}

// MARK: - Devin

private struct DevinSettingsTab: View {
    @State private var rateText: String = ""
    @State private var statusText: String = ""

    private var parsedRate: Double? {
        let trimmed = rateText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let value = Double(trimmed), value.isFinite, value > 0 else { return nil }
        return value
    }

    var body: some View {
        Form {
            GenericProviderConnectionSections(provider: CapacityDockProvider(rawValue: "devin")!)

            Section("ACU Conversion") {
                HStack(alignment: .center, spacing: 10) {
                    Text("USD per ACU")
                    Spacer()
                    TextField("", text: $rateText)
                        .textFieldStyle(.roundedBorder)
                        .multilineTextAlignment(.trailing)
                        .frame(width: 96)
                        .accessibilityLabel("USD per ACU")
                    Text("USD")
                        .foregroundStyle(.secondary)
                        .frame(width: 36, alignment: .leading)
                }

                Button("Save") {
                    saveRate()
                }
                .buttonStyle(.borderedProminent)
                .disabled(parsedRate == nil)

                if !statusText.isEmpty {
                    Text(statusText)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
            }

            Section {
                Text("CodeBurn reads Devin ACU usage from local transcripts only after this rate is configured, then multiplies each step by the rate before reporting cost.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            } header: {
                Text("How it works")
            }
        }
        .formStyle(.grouped)
        .padding()
        .onAppear {
            if let rate = CLIDevinConfig.loadAcuUsdRate() {
                rateText = Self.format(rate)
            }
        }
    }

    private func saveRate() {
        guard let rate = parsedRate else { return }
        CLIDevinConfig.persistAcuUsdRate(rate)
        rateText = Self.format(rate)
        statusText = L("Saved. Refresh CodeBurn to recalculate Devin cost.")
    }

    private static func format(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.numberStyle = .decimal
        formatter.minimumFractionDigits = 0
        formatter.maximumFractionDigits = 6
        return formatter.string(from: NSNumber(value: value)) ?? String(value)
    }
}

// MARK: - About

private struct AboutSettingsTab: View {
    @Environment(UpdateChecker.self) private var updateChecker

    private var versionString: String {
        let version = AppVersion.normalizedBundleShortVersion
        let build = AppVersion.normalizedBundleBuildVersion
        return build == version ? version : "\(version) (\(build))"
    }

    var body: some View {
        Form {
            Section {
                hero
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
            }

            Section {
                LabeledContent("Version \(versionString)") {
                    Button("Check for Updates") {
                        Task { await updateChecker.check() }
                    }
                }
                if let error = updateChecker.updateError {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else if updateChecker.updateAvailable, let latest = updateChecker.latestVersion {
                    Text("\(AppVersion.display(latest)) is available. Choose Check for Updates in the CodeBurn menu to install it.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("Updates")
            }

            Section {
                AboutLinkRow(
                    icon: "chevron.left.slash.chevron.right",
                    title: "GitHub",
                    url: "https://github.com/getagentseal/codeburn")
                AboutLinkRow(
                    icon: "globe",
                    title: L("Website"),
                    url: "https://codeburn.app")
                AboutLinkRow(
                    icon: "exclamationmark.bubble",
                    title: L("Issues"),
                    url: "https://github.com/getagentseal/codeburn/issues")
            } header: {
                Text("Links")
            } footer: {
                Text("© 2026 Resham Joshi (iamtoruk) · AgentSeal. MIT License.")
                    .frame(maxWidth: .infinity)
                    .multilineTextAlignment(.center)
            }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
    }

    private var hero: some View {
        VStack(spacing: 10) {
            if let flame = AboutFlameImage.load() {
                Image(nsImage: flame)
                    .resizable()
                    .scaledToFit()
                    .frame(width: 72, height: 72)
            } else if let icon = NSApplication.shared.applicationIconImage {
                Image(nsImage: icon)
                    .resizable()
                    .frame(width: 64, height: 64)
                    .cornerRadius(12)
            }

            VStack(spacing: 2) {
                Text("CodeBurn")
                    .font(.title3).fontWeight(.semibold)
                Text("Version \(versionString)")
                    .foregroundStyle(.secondary)
                Text("Your AI Bill, Itemized")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 6)
    }
}

private struct AboutLinkRow: View {
    let icon: String
    let title: String
    let url: String
    @State private var hovering = false

    var body: some View {
        Button {
            if let url = URL(string: self.url) { NSWorkspace.shared.open(url) }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .frame(width: 18)
                    .foregroundStyle(.secondary)
                Text(title)
                    .foregroundStyle(.primary)
                Spacer()
                Image(systemName: "arrow.up.right")
                    .font(.caption)
                    .foregroundStyle(hovering ? Color.accentColor : Color.secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

/// The full-color binary-flame brand mark shown in the About hero. Loaded
/// directly (not via ProviderIconCache) because it must keep its colors —
/// the cache marks everything as a template image.
@MainActor
enum AboutFlameImage {
    private static var cached: NSImage?

    static func load() -> NSImage? {
        if let cached { return cached }
        for subdirectory in ["Resources/ProviderIcons", "ProviderIcons", nil] {
            if let url = Bundle.module.url(forResource: "about-flame", withExtension: "png", subdirectory: subdirectory),
               let image = NSImage(contentsOf: url) {
                cached = image
                return image
            }
        }
        return nil
    }
}

/// UI language picker. macOS applies a per-app language choice only on the
/// next launch, so the section offers a relaunch button once the selection
/// differs from the language the running process resolved to.
private struct LanguageSettingsSection: View {
    @State private var selection = AppLanguage.current

    private var needsRelaunch: Bool {
        let target = selection == .system ? nil : selection
        return target != nil ? target != AppLanguage.effective : AppLanguage.current != .system
    }

    var body: some View {
        Section("Language") {
            Picker("Language", selection: Binding(
                get: { selection },
                set: { language in
                    selection = language
                    AppLanguage.select(language)
                }
            )) {
                ForEach(AppLanguage.allCases) { language in
                    Text(language.displayName).tag(language)
                }
            }
            .pickerStyle(.menu)

            if needsRelaunch {
                HStack(spacing: 10) {
                    Text("Relaunch CodeBurn to apply the new language.")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Relaunch Now") { AppLanguage.relaunch() }
                }
            } else {
                Text("Follows the macOS system language unless you pick one here.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
        }
    }
}
