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

            ClaudeSettingsTab()
                .tabItem { Label("Claude", systemImage: "brain") }

            CodexSettingsTab()
                .tabItem { Label("Codex", systemImage: "chevron.left.forwardslash.chevron.right") }

            AboutSettingsTab()
                .tabItem { Label("About", systemImage: "info.circle") }
        }
        .frame(width: 520, height: 400)
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
                    ForEach(SupportedCurrency.allCases) { currency in
                        Text("\(currency.rawValue) — \(currency.displayName)").tag(currency.rawValue)
                    }
                }
                Picker("Metric", selection: Binding(
                    get: { store.displayMetric },
                    set: { store.displayMetric = $0 }
                )) {
                    Text("Cost ($)").tag(DisplayMetric.cost)
                    Text("Tokens (↑↓)").tag(DisplayMetric.tokens)
                    Text("Total Tokens").tag(DisplayMetric.totalTokens)
                    Text("Icon Only").tag(DisplayMetric.iconOnly)
                }
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

            Section("Alerts") {
                Picker("Daily budget", selection: Binding(
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
                Text("Flame icon turns yellow when you pass the daily budget.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
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
        case .bootstrapping: return "macOS may ask permission to read your credentials."
        case .loading: return "Background refresh in progress."
        case .dormant: return "Tap Load Quota to fetch live usage from Anthropic."
        case .notBootstrapped, .noCredentials: return "Click Connect to read your Claude Code credentials and start tracking quota."
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

// MARK: - Claude config directories

private struct ClaudeConfigDirsSection: View {
    @Environment(AppStore.self) private var store
    @State private var dirs: [String] = CLIClaudeConfig.load()

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if dirs.isEmpty {
                Text("No extra directories — tracking the default `~/.claude`.")
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
        panel.prompt = "Add"
        panel.message = "Choose one or more Claude config directories (each containing a `projects` folder)."
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
