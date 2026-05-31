import AppKit
import SwiftUI

/// Settings window using a sidebar list for navigation instead of toolbar tabs
/// (which overflow into a >> chevron on narrow windows).
struct SettingsView: View {
    @Environment(AppStore.self) private var store
    @State private var selected: SidebarItem? = .settings(.general)

    enum SettingsPane: String, CaseIterable, Identifiable, Hashable {
        case general, providers, debug, about
        var id: String { rawValue }

        var label: String {
            switch self {
            case .general: "General"
            case .providers: "Providers"
            case .debug: "Debug"
            case .about: "About"
            }
        }

        var icon: String {
            switch self {
            case .general: "gearshape"
            case .providers: "switch.2"
            case .debug: "wrench.and.screwdriver"
            case .about: "info.circle"
            }
        }
    }

    enum SidebarItem: Hashable, Identifiable {
        case settings(SettingsPane)
        case provider(String)

        var id: String {
            switch self {
            case .settings(let pane): "s-\(pane.rawValue)"
            case .provider(let key): "p-\(key)"
            }
        }
    }

    static let providerMeta: [(name: String, key: String, icon: String)] = [
        ("Claude", "claude", "brain"),
        ("Codex", "codex", "chevron.left.forwardslash.chevron.right"),
        ("Copilot", "copilot", "airplane"),
        ("Vertex AI", "vertex", "cloud"),
        ("Antigravity", "antigravity", "atom"),
        ("Cursor", "cursor", "cursorarrow.rays"),
        ("Cline", "cline", "terminal"),
        ("Roo Code", "roo-code", "hare"),
        ("KiloCode", "kilocode", "k.circle"),
        ("OpenCode", "opencode", "chevron.left.slash.chevron.right"),
        ("Forge", "forge", "hammer"),
        ("Gemini", "gemini", "sparkles"),
        ("Goose", "goose", "bird"),
        ("Warp", "warp", "wand.and.rays"),
        ("Hermes", "hermes", "bolt.horizontal"),
        ("OpenClaw", "openclaw", "pawprint"),
    ]

    private var activeProviders: [(name: String, key: String, icon: String)] {
        Self.providerMeta.filter { !store.disabledProviders.contains($0.key) }
    }

    var body: some View {
        NavigationSplitView {
            List(selection: $selected) {
                Section("Settings") {
                    ForEach(SettingsPane.allCases) { pane in
                        Label(pane.label, systemImage: pane.icon)
                            .tag(SidebarItem.settings(pane))
                    }
                }
                Section("Providers") {
                    ForEach(activeProviders, id: \.key) { p in
                        Label(p.name, systemImage: p.icon)
                            .tag(SidebarItem.provider(p.key))
                    }
                }
            }
            .navigationSplitViewColumnWidth(min: 150, ideal: 160, max: 200)
            .listStyle(.sidebar)
        } detail: {
            detailView
        }
        .navigationSplitViewStyle(.balanced)
        .frame(width: 650, height: 520)
    }

    @ViewBuilder
    private var detailView: some View {
        switch selected {
        case .settings(.general), .none:
            GeneralSettingsTab()
        case .settings(.providers):
            ProvidersSettingsTab()
        case .settings(.debug):
            DebugSettingsTab()
        case .settings(.about):
            AboutSettingsTab()
        case .provider(let key):
            ProviderDetailView(providerKey: key)
        }
    }
}

// MARK: - General

private struct GeneralSettingsTab: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        Form {
            Section("Display") {
                Picker("Currency", selection: Binding(
                    get: { store.currency },
                    set: { applyCurrency(code: $0) }
                )) {
                    ForEach(["USD", "EUR", "GBP", "INR", "JPY", "AUD", "CAD"], id: \.self) { code in
                        Text(code).tag(code)
                    }
                }
                Picker("Metric", selection: Binding(
                    get: { store.displayMetric },
                    set: { store.displayMetric = $0 }
                )) {
                    Text("Cost ($)").tag(DisplayMetric.cost)
                    Text("Tokens (↑↓)").tag(DisplayMetric.tokens)
                    Text("Total Tokens").tag(DisplayMetric.totalTokens)
                    Text("Quota Left (%)").tag(DisplayMetric.quotaRemaining)
                    Text("Icon Only").tag(DisplayMetric.iconOnly)
                }
                Toggle("Show quota left in menu bar", isOn: Binding(
                    get: { store.displayMetric == .quotaRemaining },
                    set: { enabled in
                        if enabled {
                            store.displayMetric = .quotaRemaining
                        } else if store.displayMetric == .quotaRemaining {
                            store.displayMetric = .cost
                        }
                    }
                ))
                Picker("Period", selection: Binding(
                    get: { store.menubarPeriod },
                    set: { store.setMenubarPeriod($0) }
                )) {
                    ForEach(Period.menubarMetricCases) { period in
                        Text(period.menubarMetricLabel).tag(period)
                    }
                }
                .pickerStyle(.menu)
                                Picker("Accent", selection: Binding(
                    get: { store.accentPreset },
                    set: { store.accentPreset = $0 }
                )) {
                    ForEach(AccentPreset.allCases) { preset in
                        Text("\(preset.emoji) \(preset.rawValue)").tag(preset)
                    }
                }
                Picker("Rounding", selection: Binding(
                    get: { store.costGranularity },
                    set: { store.costGranularity = $0 }
                )) {
                    Text("$437.08").tag(CostGranularity.exact)
                    Text("$437").tag(CostGranularity.rounded)
                    Text("$440").tag(CostGranularity.coarse)
                }
                Toggle("Show period suffix (/wk, /mo)", isOn: Binding(
                    get: { store.showMenubarSuffix },
                    set: { store.showMenubarSuffix = $0 }
                ))
                Picker("Icon", selection: Binding(
                    get: { store.menubarIcon },
                    set: { store.menubarIcon = $0 }
                )) {
                    ForEach(MenubarIcon.allCases) { icon in
                        Text("\(icon.emoji) \(icon.rawValue)").tag(icon)
                    }
                }
            }

            Section("Refresh") {
                Picker("Auto refresh", selection: Binding(
                    get: { store.usageRefreshCadence },
                    set: { store.usageRefreshCadence = $0 }
                )) {
                    ForEach(UsageRefreshCadence.allCases) { cadence in
                        Text(cadence.label).tag(cadence)
                    }
                }
                .pickerStyle(.menu)
                Toggle("Auto-show most-used provider", isOn: Binding(
                    get: { store.autoShowMostUsedProvider },
                    set: { store.autoShowMostUsedProvider = $0 }
                ))
                Button("Refresh Now") {
                    refreshNow()
                }
            }

            Section("Launch") {
                Toggle("Start at login", isOn: Binding(
                    get: { store.startAtLoginEnabled },
                    set: { store.startAtLoginEnabled = $0 }
                ))
            }

            Section("Alerts") {
                Picker("Daily quota", selection: Binding(
                    get: { store.dailyBudget },
                    set: { store.dailyBudget = $0 }
                )) {
                    Text("Off").tag(0.0)
                    Text("$25").tag(25.0)
                    Text("$50").tag(50.0)
                    Text("$100").tag(100.0)
                    Text("$200").tag(200.0)
                    Text("$500").tag(500.0)
                }
                TextField("Custom daily quota USD", value: Binding(
                    get: { store.dailyBudget },
                    set: { store.dailyBudget = max(0, $0) }
                ), formatter: Self.quotaFormatter)
                Picker("Monthly quota", selection: Binding(
                    get: { store.monthlyQuota },
                    set: { store.monthlyQuota = $0 }
                )) {
                    Text("Off").tag(0.0)
                    Text("$50").tag(50.0)
                    Text("$100").tag(100.0)
                    Text("$200").tag(200.0)
                    Text("$500").tag(500.0)
                    Text("$1,000").tag(1000.0)
                    Text("$2,000").tag(2000.0)
                }
                TextField("Custom monthly quota USD", value: Binding(
                    get: { store.monthlyQuota },
                    set: { store.monthlyQuota = max(0, $0) }
                ), formatter: Self.quotaFormatter)
                Picker("Warn at", selection: Binding(
                    get: { store.quotaWarningThreshold },
                    set: { store.quotaWarningThreshold = $0 }
                )) {
                    Text("70%").tag(0.7)
                    Text("80%").tag(0.8)
                    Text("90%").tag(0.9)
                    Text("100%").tag(1.0)
                }
                Picker("Quota labels", selection: Binding(
                    get: { store.quotaDisplayMode },
                    set: { store.quotaDisplayMode = $0 }
                )) {
                    ForEach(QuotaDisplayMode.allCases) { mode in
                        Text(mode.label).tag(mode)
                    }
                }
                Toggle("Quota warning notifications", isOn: Binding(
                    get: { store.quotaNotificationsEnabled },
                    set: { store.quotaNotificationsEnabled = $0 }
                ))
                Text("Flame icon and notifications follow the warning threshold for live provider quota and spend quotas.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }

            Section("Privacy") {
                Toggle("Hide personal information", isOn: Binding(
                    get: { store.hidePersonalInformation },
                    set: { store.hidePersonalInformation = $0 }
                ))
                Toggle("Allow Claude Keychain access", isOn: Binding(
                    get: { store.keychainAccessEnabled },
                    set: { store.keychainAccessEnabled = $0 }
                ))
                Text("Privacy mode obscures email addresses in visible project labels. Disabling Keychain access makes Claude Connect use file credentials only.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .padding()
    }

    private static let quotaFormatter: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        formatter.minimumFractionDigits = 0
        formatter.maximumFractionDigits = 2
        return formatter
    }()

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

    private func refreshNow() {
        if let delegate = NSApp.delegate as? AppDelegate {
            delegate.refreshSubscriptionNow()
        } else {
            Task { await store.refresh(includeOptimize: false, force: true, showLoading: true) }
        }
    }
}

// MARK: - Claude Connection

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
        case .loaded: return "Connected"
        case let .terminalFailure(reason): return reason ?? "Reconnect required"
        case .transientFailure: return "Backing off"
        case .bootstrapping: return "Connecting…"
        case .loading: return "Refreshing…"
        case .dormant: return "Ready"
        case .notBootstrapped, .noCredentials: return "Not connected"
        case .failed: return "Couldn't load plan data"
        }
    }

    private var stateDetail: String {
        switch store.subscriptionLoadState {
        case .loaded:
            if let tier = store.subscription?.tier.displayName {
                return "Plan: \(tier)"
            }
            return "Live quota tracked from Anthropic."
        case .terminalFailure: return "Open Claude Code in your terminal and type `/login`, then click Reconnect."
        case .transientFailure: return store.subscriptionError ?? "Anthropic rate-limited; auto-retrying."
        case .bootstrapping:
            return store.keychainAccessEnabled
                ? "macOS may ask permission to read your credentials."
                : "Reading ~/.claude/.credentials.json only; Keychain access is disabled."
        case .loading: return "Background refresh in progress."
        case .dormant: return "Tap Load Quota to fetch live usage from Anthropic."
        case .notBootstrapped, .noCredentials:
            return store.keychainAccessEnabled
                ? "Click Connect to read your Claude Code credentials and start tracking quota."
                : "Keychain access is disabled; Connect only works if ~/.claude/.credentials.json exists."
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
                    Text("CodeBurn will stop tracking quota and delete its local copy of your Claude credentials. Your Claude Code keychain entry is untouched — Claude Code keeps working.")
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

// MARK: - Codex Connection

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
        case .loaded: return "Connected"
        case let .terminalFailure(reason): return reason ?? "Reconnect required"
        case .transientFailure: return "Backing off"
        case .bootstrapping: return "Connecting…"
        case .loading: return "Refreshing…"
        case .dormant: return "Ready"
        case .notBootstrapped, .noCredentials: return "Not connected"
        case .failed: return "Couldn't load Codex quota"
        }
    }

    private var stateDetail: String {
        switch store.codexLoadState {
        case .loaded:
            if let plan = store.codexUsage?.plan.displayName {
                return "Plan: \(plan)"
            }
            return "Live quota tracked from chatgpt.com."
        case .terminalFailure:
            // Be specific about the cause: the message we already surface in
            // codexError will say "API-key mode" if that's the situation, so
            // the generic "run codex login" hint covers both cases.
            if let err = store.codexError, err.lowercased().contains("api-key") {
                return "Codex is in API-key mode. Run `codex login` and choose a ChatGPT plan to enable quota tracking."
            }
            return "Run `codex login` in your terminal to sign in again, then click Reconnect."
        case .transientFailure: return store.codexError ?? "ChatGPT rate-limited; auto-retrying."
        case .bootstrapping: return "Reading ~/.codex/auth.json."
        case .loading: return "Background refresh in progress."
        case .dormant: return "Tap Load Quota to fetch live usage from chatgpt.com."
        case .notBootstrapped, .noCredentials:
            return "Click Connect to read your Codex CLI credentials. If Connect fails, run `codex login` in your terminal first to create ~/.codex/auth.json."
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
                    Text("CodeBurn will stop tracking quota and delete its local copy of your Codex credentials. Your ~/.codex/auth.json is untouched — Codex CLI keeps working.")
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

// MARK: - Providers (Toggles + Connections)

private struct ProvidersSettingsTab: View {
    @Environment(AppStore.self) private var store
    @State private var copilotDetected = false
    @State private var vertexDetected = false
    @State private var vertexPath: String = ""

    private let toggleableProviders: [(name: String, key: String, icon: String)] = [
        ("Claude", "claude", "brain"),
        ("Codex", "codex", "chevron.left.forwardslash.chevron.right"),
        ("Copilot", "copilot", "airplane"),
        ("Vertex AI", "vertex", "cloud"),
        ("Antigravity", "antigravity", "atom"),
        ("Cursor", "cursor", "cursorarrow.rays"),
        ("Cline", "cline", "terminal"),
        ("Roo Code", "roo-code", "hare"),
        ("KiloCode", "kilocode", "k.circle"),
        ("OpenCode", "opencode", "chevron.left.slash.chevron.right"),
        ("Forge", "forge", "hammer"),
        ("Gemini", "gemini", "sparkles"),
        ("Goose", "goose", "bird"),
        ("Warp", "warp", "wand.and.rays"),
        ("Hermes", "hermes", "bolt.horizontal"),
        ("OpenClaw", "openclaw", "pawprint"),
    ]

    var body: some View {
        Form {
            Section {
                Text("Disabled providers are excluded from cost tracking and the menubar.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            Section("Active Providers") {
                ForEach(toggleableProviders, id: \.key) { provider in
                    Toggle(isOn: providerBinding(for: provider.key)) {
                        Label(provider.name, systemImage: provider.icon)
                    }
                }
            }
            Section("Claude Connection") {
                ClaudeConnectionRow()
                Picker("Quota refresh", selection: Binding(
                    get: { SubscriptionRefreshCadence.current },
                    set: { SubscriptionRefreshCadence.current = $0 }
                )) {
                    ForEach(SubscriptionRefreshCadence.allCases) { cadence in
                        Text(cadence.label).tag(cadence)
                    }
                }
                .pickerStyle(.menu)
            }
            Section("Codex Connection") {
                CodexConnectionRow()
            }
        }
        .formStyle(.grouped)
        .padding()
        .task { detectProviders() }
    }

    private func detectProviders() {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let copilotPaths = [
            home.appendingPathComponent(".copilot").path,
            home.appendingPathComponent("Library/Application Support/GitHub Copilot").path,
        ]
        copilotDetected = copilotPaths.contains { FileManager.default.fileExists(atPath: $0) }

        let vertexPaths = [
            home.appendingPathComponent(".config/google-cloud-sdk/ai/sessions").path,
            home.appendingPathComponent(".vertex-ai/sessions").path,
            home.appendingPathComponent(".config/gemini-code-assist/sessions").path,
        ]
        for path in vertexPaths {
            if FileManager.default.fileExists(atPath: path) {
                vertexDetected = true
                vertexPath = path
                break
            }
        }
    }

    private func providerBinding(for key: String) -> Binding<Bool> {
        Binding(
            get: { !store.disabledProviders.contains(key) },
            set: { enabled in
                if enabled {
                    store.disabledProviders.remove(key)
                } else {
                    store.disabledProviders.insert(key)
                }
            }
        )
    }
}

// MARK: - Provider Detail (per-provider sidebar item)

private struct ProviderDetailView: View {
    @Environment(AppStore.self) private var store
    let providerKey: String

    private var providerName: String {
        SettingsView.providerMeta.first { $0.key == providerKey }?.name ?? providerKey.capitalized
    }

    private var providerIcon: String {
        SettingsView.providerMeta.first { $0.key == providerKey }?.icon ?? "cpu"
    }

    var body: some View {
        Form {
            Section {
                HStack {
                    Image(systemName: providerIcon)
                        .font(.title2)
                    VStack(alignment: .leading) {
                        Text(providerName).font(.headline)
                        Text("Active").font(.caption).foregroundStyle(.green)
                    }
                    Spacer()
                    Toggle("Enabled", isOn: enabledBinding)
                        .labelsHidden()
                }
            }

            if providerKey == "claude" {
                Section("Connection") {
                    ClaudeConnectionRow()
                    Picker("Quota refresh", selection: Binding(
                        get: { SubscriptionRefreshCadence.current },
                        set: { SubscriptionRefreshCadence.current = $0 }
                    )) {
                        ForEach(SubscriptionRefreshCadence.allCases) { cadence in
                            Text(cadence.label).tag(cadence)
                        }
                    }
                    .pickerStyle(.menu)
                }
            }

            if providerKey == "codex" {
                Section("Connection") {
                    CodexConnectionRow()
                }
            }

            Section("Usage") {
                Text("Select this provider in the menubar dropdown to see live usage data.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .padding()
    }

    private var enabledBinding: Binding<Bool> {
        Binding(
            get: { !store.disabledProviders.contains(providerKey) },
            set: { enabled in
                if enabled {
                    store.disabledProviders.remove(providerKey)
                } else {
                    store.disabledProviders.insert(providerKey)
                }
            }
        )
    }
}

// MARK: - Debug

private struct DebugSettingsTab: View {
    @State private var storageEntries: [ProviderStorageEntry] = []
    @State private var isLoadingStorage = false

    var body: some View {
        Form {
            Section("CLI") {
                LabeledContent("Command") {
                    Text(CodeburnCLI.baseArgv().joined(separator: " "))
                        .font(.codeMono(size: 10.5))
                        .textSelection(.enabled)
                }
                HStack {
                    Button("Open Report") {
                        TerminalLauncher.open(subcommand: ["report"])
                    }
                    Button("CLI Help") {
                        TerminalLauncher.open(subcommand: ["--help"])
                    }
                    Button("Storage CLI") {
                        TerminalLauncher.open(subcommand: ["debug", "storage"])
                    }
                    Button("Reveal Support") {
                        revealApplicationSupport()
                    }
                }
            }

            Section("Shortcuts") {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 128), alignment: .leading)], alignment: .leading, spacing: 8) {
                    Button("History") {
                        (NSApp.delegate as? AppDelegate)?.openHistory()
                    }
                    Button("Claude Folder") {
                        revealPath("~/.claude")
                    }
                    Button("Codex Folder") {
                        revealPath("~/.codex")
                    }
                    Button("Cursor Data") {
                        revealPath("~/Library/Application Support/Cursor/User")
                    }
                    Button("Cline Extension") {
                        openVSCodeExtension("saoudrizwan.claude-dev")
                    }
                    Button("Roo Extension") {
                        openVSCodeExtension("RooVeterinaryInc.roo-cline")
                    }
                    Button("Kilo Extension") {
                        openVSCodeExtension("kilocode.kilo-code")
                    }
                    Button("Antigravity CLI") {
                        revealPath("~/.gemini/antigravity-cli")
                    }
                    Button("Antigravity IDE") {
                        revealPath("~/Library/Application Support/Google/Antigravity")
                    }
                    Button("Install AG Hook") {
                        TerminalLauncher.open(subcommand: ["antigravity-hook", "install"])
                    }
                    Button("Uninstall AG Hook") {
                        TerminalLauncher.open(subcommand: ["antigravity-hook", "uninstall"])
                    }
                }
            }

            Section("Storage") {
                HStack {
                    Text(storageSummary)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button(isLoadingStorage ? "Refreshing..." : "Refresh Storage") {
                        Task { await refreshStorage() }
                    }
                    .disabled(isLoadingStorage)
                }

                ForEach(storageEntries) { entry in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("\(entry.provider) · \(entry.label)")
                                .font(.system(size: 11, weight: .medium))
                            Text(entry.path)
                                .font(.codeMono(size: 9.5))
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        Spacer()
                        Text(entry.sizeLabel)
                            .font(.codeMono(size: 10.5, weight: .medium))
                            .foregroundStyle(entry.exists ? .secondary : .tertiary)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .padding()
        .task {
            if storageEntries.isEmpty {
                await refreshStorage()
            }
        }
    }

    private var storageSummary: String {
        let found = storageEntries.filter(\.exists).count
        return storageEntries.isEmpty ? "Provider storage has not been scanned." : "\(found) storage locations found."
    }

    @MainActor
    private func refreshStorage() async {
        isLoadingStorage = true
        let entries = await ProviderStorageProbe.load()
        storageEntries = entries
        isLoadingStorage = false
    }

    private func revealApplicationSupport() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        let codeburn = support.appendingPathComponent("CodeBurn", isDirectory: true)
        try? FileManager.default.createDirectory(at: codeburn, withIntermediateDirectories: true)
        NSWorkspace.shared.activateFileViewerSelecting([codeburn])
    }

    private func revealPath(_ path: String) {
        let expanded: String
        if path.hasPrefix("~/") {
            expanded = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(String(path.dropFirst(2)))
                .path
        } else {
            expanded = path
        }
        let url = URL(fileURLWithPath: expanded)
        if FileManager.default.fileExists(atPath: expanded) {
            NSWorkspace.shared.activateFileViewerSelecting([url])
        } else {
            NSWorkspace.shared.open(url.deletingLastPathComponent())
        }
    }

    private func openURL(_ raw: String) {
        guard let url = URL(string: raw) else { return }
        NSWorkspace.shared.open(url)
    }

    private func openVSCodeExtension(_ extensionID: String) {
        if let url = URL(string: "vscode:extension/\(extensionID)"),
           NSWorkspace.shared.open(url) {
            return
        }
        openURL("https://marketplace.visualstudio.com/items?itemName=\(extensionID)")
    }
}

// MARK: - About

private struct AboutSettingsTab: View {
    private let appVersion: String = AppVersion.normalizedBundleShortVersion
    private let buildVersion: String = AppVersion.normalizedBundleBuildVersion

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "flame.fill")
                .font(.system(size: 40))
                .foregroundStyle(Theme.brandAccent)
            Text("CodeBurn")
                .font(.system(size: 18, weight: .semibold))
            Text("AI Coding Cost Tracker")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            Text("Version \(appVersion) (\(buildVersion))")
                .font(.codeMono(size: 11))
                .foregroundStyle(.secondary)
            HStack(spacing: 10) {
                Link("GitHub", destination: URL(string: "https://github.com/getagentseal/codeburn")!)
                Link("Issues", destination: URL(string: "https://github.com/getagentseal/codeburn/issues")!)
            }
            .font(.system(size: 12))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}
