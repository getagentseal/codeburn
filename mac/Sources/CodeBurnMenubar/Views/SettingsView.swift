import AppKit
import SwiftUI

/// macOS-standard tabbed Settings window. New per-provider sections (Codex,
/// Cursor, Copilot, etc.) plug in as additional tabs. Each tab owns its own
/// concerns; this top-level view only hosts the TabView shell.
struct SettingsView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        TabView {
            GeneralSettingsTab()
                .tabItem { Label("General", systemImage: "gearshape") }

            ProvidersSettingsTab()
                .tabItem { Label("Providers", systemImage: "switch.2") }

            ClaudeSettingsTab()
                .tabItem { Label("Claude", systemImage: "brain") }

            CodexSettingsTab()
                .tabItem { Label("Codex", systemImage: "chevron.left.forwardslash.chevron.right") }

            CopilotSettingsTab()
                .tabItem { Label("Copilot", systemImage: "airplane") }

            VertexSettingsTab()
                .tabItem { Label("Vertex", systemImage: "cloud") }

            DebugSettingsTab()
                .tabItem { Label("Debug", systemImage: "wrench.and.screwdriver") }

            AboutSettingsTab()
                .tabItem { Label("About", systemImage: "info.circle") }
        }
        .frame(width: 560, height: 500)
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
                        Text(preset.rawValue).tag(preset)
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

// MARK: - Claude

private struct ClaudeSettingsTab: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        Form {
            Section("Connection") {
                ClaudeConnectionRow()
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
                    Task { await store.refreshSubscription() }
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

// MARK: - Codex

private struct CodexSettingsTab: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        Form {
            Section("Connection") {
                CodexConnectionRow()
            }
            Section {
                Text("Codex live-quota tracking reads `~/.codex/auth.json` once on Connect, then keeps a local copy under Application Support so subsequent quota fetches don't re-read the original. Only ChatGPT-mode auth (Plus / Pro / Team / Business) is supported — API-key users are billed per request and have a different reporting surface.")
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

// MARK: - Providers (Toggle)

private struct ProvidersSettingsTab: View {
    @Environment(AppStore.self) private var store

    private let toggleableProviders: [(name: String, key: String, icon: String)] = [
        ("Claude", "claude", "brain"),
        ("Codex", "codex", "chevron.left.forwardslash.chevron.right"),
        ("Copilot", "copilot", "airplane"),
        ("Vertex AI", "vertex", "cloud"),
        ("Antigravity", "antigravity", "atom"),
        ("Cursor", "cursor", "cursorarrow.rays"),
        ("Cline", "cline", "terminal"),
        ("Roo Code", "roo-code", "hare"),
        ("Forge", "forge", "hammer"),
        ("Gemini", "gemini", "sparkles"),
        ("Goose", "goose", "bird"),
    ]

    var body: some View {
        Form {
            Section {
                Text("Toggle providers on or off. Disabled providers are excluded from cost tracking and the menubar summary.")
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
        }
        .formStyle(.grouped)
        .padding()
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

// MARK: - Copilot

private struct CopilotSettingsTab: View {
    @Environment(AppStore.self) private var store
    @State private var copilotDetected = false
    @State private var checkDone = false

    var body: some View {
        Form {
            Section("Connection") {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: copilotDetected ? "checkmark.circle.fill" : "link.circle")
                        .font(.system(size: 18))
                        .foregroundStyle(copilotDetected ? .green : .secondary)
                        .frame(width: 22)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(copilotDetected ? "Detected" : (checkDone ? "Not found" : "Checking…"))
                            .font(.system(size: 12, weight: .semibold))
                        Text(copilotDetected
                            ? "GitHub Copilot sessions detected. Cost is estimated from session transcripts."
                            : "Looking for ~/.copilot/ session data.")
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                .padding(.vertical, 4)
            }
            Section {
                Text("Copilot CLI usage is tracked as a shared provider (IDE + CLI combined). Cost estimates are derived from session transcripts using token heuristics — actual billing may differ.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            } header: {
                Text("How it works")
            }
        }
        .formStyle(.grouped)
        .padding()
        .task {
            let home = FileManager.default.homeDirectoryForCurrentUser
            let paths = [
                home.appendingPathComponent(".copilot").path,
                home.appendingPathComponent("Library/Application Support/GitHub Copilot").path,
            ]
            copilotDetected = paths.contains { FileManager.default.fileExists(atPath: $0) }
            checkDone = true
        }
    }
}

// MARK: - Vertex AI

private struct VertexSettingsTab: View {
    @Environment(AppStore.self) private var store
    @State private var vertexDetected = false
    @State private var detectedPath: String = ""
    @State private var checkDone = false

    var body: some View {
        Form {
            Section("Connection") {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: vertexDetected ? "checkmark.circle.fill" : "link.circle")
                        .font(.system(size: 18))
                        .foregroundStyle(vertexDetected ? .green : .secondary)
                        .frame(width: 22)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(vertexDetected ? "Detected" : (checkDone ? "Not found" : "Checking…"))
                            .font(.system(size: 12, weight: .semibold))
                        if vertexDetected {
                            Text("Session data at: \(detectedPath)")
                                .font(.system(size: 11))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        } else if checkDone {
                            Text("No Vertex AI / gcloud session data found. Sessions should appear in ~/.config/google-cloud-sdk/ai/ or ~/.vertex-ai/.")
                                .font(.system(size: 11))
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                }
                .padding(.vertical, 4)
            }
            Section {
                Text("Vertex AI tracks gcloud CLI and Antigravity CLI sessions. Costs are estimated from Gemini model pricing. If you use `gcloud ai` or the Antigravity CLI, sessions are discovered automatically.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            } header: {
                Text("How it works")
            }
        }
        .formStyle(.grouped)
        .padding()
        .task {
            let home = FileManager.default.homeDirectoryForCurrentUser
            let paths = [
                home.appendingPathComponent(".config/google-cloud-sdk/ai/sessions").path,
                home.appendingPathComponent(".vertex-ai/sessions").path,
                home.appendingPathComponent(".config/gemini-code-assist/sessions").path,
            ]
            for path in paths {
                if FileManager.default.fileExists(atPath: path) {
                    vertexDetected = true
                    detectedPath = path
                    break
                }
            }
            checkDone = true
        }
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
