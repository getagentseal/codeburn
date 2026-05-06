import AppKit
import SwiftUI

/// Popover root. Assembles all sections matching the HTML design spec.
struct MenuBarContent: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        VStack(spacing: 0) {
            Header()

            Divider()

            if showAgentTabs {
                AgentTabStrip()
                Divider()
            }

            ZStack {
                ScrollView(.vertical, showsIndicators: false) {
                    VStack(spacing: 0) {
                        HeroSection()
                        Divider().opacity(0.5)
                        PeriodSegmentedControl()
                        Divider().opacity(0.5)
                        if isFilteredEmpty {
                            EmptyProviderState(provider: store.selectedProvider, period: store.selectedPeriod)
                        } else {
                            HeatmapSection()
                                .padding(.horizontal, 14)
                                .padding(.top, 10)
                                .padding(.bottom, 10)
                                .zIndex(10)
                            Divider().opacity(0.5)
                            ActivitySection()
                            Divider().opacity(0.5)
                            ModelsSection()
                            Divider().opacity(0.5)
                            FindingsSection()
                        }
                    }
                }

                if store.isLoading || (providerHasCostInAllPayload && !store.hasCachedData) {
                    BurnLoadingOverlay(periodLabel: store.selectedPeriod.rawValue)
                        .transition(.opacity)
                }
            }
            .frame(height: 520)
            .animation(.easeInOut(duration: 0.2), value: store.isLoading)

            Divider()

            FooterBar()

            StarBanner()
        }
    }

    private var isFilteredEmpty: Bool {
        guard store.selectedProvider != .all else { return false }
        if store.payload.current.cost > 0 || store.payload.current.calls > 0 { return false }
        if providerHasCostInAllPayload { return false }
        return true
    }

    private var providerHasCostInAllPayload: Bool {
        guard let allPayload = store.periodAllPayload else { return false }
        let providers = Dictionary(
            allPayload.current.providers.map { ($0.key.lowercased(), $0.value) },
            uniquingKeysWith: +
        )
        return store.selectedProvider.providerKeys.contains { key in
            (providers[key] ?? 0) > 0
        }
    }

    /// Show the tab row whenever the CLI detected at least one AI coding tool installed
    /// on this machine. Hidden only when nothing is detected, which means there's
    /// nothing to filter by anyway.
    private var showAgentTabs: Bool {
        let payload = store.todayPayload ?? store.payload
        return !payload.current.providers.isEmpty
    }

}

private struct EmptyProviderState: View {
    let provider: ProviderFilter
    let period: Period

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "tray")
                .font(.system(size: 26))
                .foregroundStyle(.tertiary)
            Text("No \(provider.rawValue) data for \(periodPhrase)")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 60)
    }

    private var periodPhrase: String {
        switch period {
        case .today: "today"
        case .sevenDays: "the last 7 days"
        case .thirtyDays: "the last 30 days"
        case .month: "this month"
        case .all: "the last 6 months"
        }
    }
}

/// Translucent overlay that blurs whatever's behind it (the previous tab/period content)
/// and centers an animated burning flame -- the brand mark filling up bottom-to-top in
/// yellow→orange→red, looping.
private struct BurnLoadingOverlay: View {
    let periodLabel: String
    @State private var fillProgress: CGFloat = 0
    @State private var glowing: Bool = false

    private let flameSize: CGFloat = 64

    var body: some View {
        ZStack {
            // Blur backdrop -- ultraThinMaterial uses live blur of underlying content.
            Rectangle()
                .fill(.ultraThinMaterial)

            VStack(spacing: 14) {
                BurnFlame(size: flameSize, fillProgress: fillProgress, glowing: glowing)
                Text("Loading \(periodLabel)…")
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundStyle(.secondary)
            }
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 1.4).repeatForever(autoreverses: true)) {
                fillProgress = 1.0
            }
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
                glowing = true
            }
        }
    }
}

private struct BurnFlame: View {
    let size: CGFloat
    let fillProgress: CGFloat
    let glowing: Bool

    var body: some View {
        ZStack {
            // Soft outer glow that pulses, matching the brand terracotta palette.
            Image(systemName: "flame.fill")
                .font(.system(size: size, weight: .regular))
                .foregroundStyle(Theme.brandAccentGlow.opacity(glowing ? 0.55 : 0.20))
                .blur(radius: glowing ? 14 : 6)

            // Empty (cool) flame as base
            Image(systemName: "flame")
                .font(.system(size: size, weight: .regular))
                .foregroundStyle(Theme.brandAccent.opacity(0.25))

            // Burning gradient (brand orange) masked by an animated bottom-up rectangle
            Image(systemName: "flame.fill")
                .font(.system(size: size, weight: .regular))
                .foregroundStyle(
                    LinearGradient(
                        colors: [
                            Theme.brandAccentGlow,
                            Theme.brandAccentLight,
                            Theme.brandAccent,
                            Theme.brandAccentDeep
                        ],
                        startPoint: .bottom,
                        endPoint: .top
                    )
                )
                .mask(
                    GeometryReader { geo in
                        Rectangle()
                            .frame(height: geo.size.height * fillProgress)
                            .frame(maxHeight: .infinity, alignment: .bottom)
                    }
                )
        }
        .frame(width: size, height: size)
    }
}

private struct Header: View {
    @Environment(UpdateChecker.self) private var updateChecker
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 1) {
                (
                    Text("Code").foregroundStyle(.primary)
                    + Text("Burn").foregroundStyle(Theme.brandEmber)
                )
                .font(.system(size: 13, weight: .semibold))
                .tracking(-0.15)
                Text("AI Coding Cost Tracker")
                    .font(.system(size: 10.5))
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if updateChecker.updateAvailable {
                UpdateBadge()
            }
            AccentPicker()
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 8)
    }
}

private struct AccentPicker: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        HStack(spacing: 0) {
            if store.showingAccentPicker {
                HStack(spacing: 5) {
                    ForEach(AccentPreset.allCases) { preset in
                        Button {
                            withAnimation(.easeInOut(duration: 0.15)) {
                                store.accentPreset = preset
                            }
                        } label: {
                            Circle()
                                .fill(preset.base)
                                .frame(width: 12, height: 12)
                                .overlay(
                                    Circle()
                                        .stroke(.white.opacity(store.accentPreset == preset ? 0.9 : 0), lineWidth: 1.5)
                                )
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(preset.rawValue)
                    }
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 4)
                .background(
                    RoundedRectangle(cornerRadius: 8)
                        .fill(Color.secondary.opacity(0.08))
                )
                .transition(.opacity.combined(with: .move(edge: .trailing)))
            }

            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    store.showingAccentPicker.toggle()
                }
            } label: {
                Circle()
                    .fill(store.accentPreset.base)
                    .frame(width: 14, height: 14)
                    .overlay(
                        Circle()
                            .stroke(.white.opacity(0.3), lineWidth: 0.5)
                    )
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Change accent color")
            .padding(.leading, 4)
        }
    }
}

private struct UpdateBadge: View {
    @Environment(UpdateChecker.self) private var updateChecker

    var body: some View {
        Button {
            updateChecker.performUpdate()
        } label: {
            HStack(spacing: 4) {
                if updateChecker.isUpdating {
                    ProgressView()
                        .controlSize(.mini)
                        .scaleEffect(0.7)
                } else {
                    Image(systemName: "arrow.down.circle.fill")
                        .font(.system(size: 10))
                }
                Text(updateChecker.isUpdating ? "Updating..." : "Update")
                    .font(.system(size: 10, weight: .medium))
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
        }
        .buttonStyle(.borderedProminent)
        .tint(Theme.brandAccent)
        .controlSize(.mini)
        .disabled(updateChecker.isUpdating)
    }
}

struct FlameMark: View {
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 5)
                .fill(
                    LinearGradient(
                        colors: [Theme.brandAccentLight, Theme.brandAccentDeep],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .shadow(color: .black.opacity(0.2), radius: 1, y: 0.5)
            Image(systemName: "flame.fill")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.white)
        }
    }
}

private let starBannerGitHubURL = URL(string: "https://github.com/getagentseal/codeburn")!

/// Shown at the very bottom on first launch. A small terracotta strip nudges users to star the
/// repo; clicking opens GitHub, clicking the close icon hides it forever (persisted to
/// UserDefaults so it never returns across launches).
struct StarBanner: View {
    @AppStorage("codeburn.starBannerDismissed") private var dismissed: Bool = false

    var body: some View {
        if !dismissed {
            HStack(spacing: 8) {
                Image(systemName: "star.fill")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.brandAccent)

                Button {
                    NSWorkspace.shared.open(starBannerGitHubURL)
                } label: {
                    HStack(spacing: 4) {
                        Text("Enjoying CodeBurn?")
                            .foregroundStyle(.primary)
                        Text("Star us on GitHub")
                            .foregroundStyle(Theme.brandAccent)
                            .underline(true, pattern: .solid)
                    }
                    .font(.system(size: 10.5, weight: .medium))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                Spacer()

                Button {
                    dismissed = true
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .padding(4)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Hide this banner")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Theme.brandAccent.opacity(0.08))
            .overlay(alignment: .top) {
                Rectangle()
                    .fill(Color.secondary.opacity(0.18))
                    .frame(height: 0.5)
            }
        }
    }
}

struct FooterBar: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        HStack(spacing: 6) {
            Menu {
                ForEach(SupportedCurrency.allCases) { currency in
                    Button {
                        applyCurrency(code: currency.rawValue)
                    } label: {
                        if currency.rawValue == store.currency {
                            Label("\(currency.displayName) (\(currency.rawValue))", systemImage: "checkmark")
                        } else {
                            Text("\(currency.displayName) (\(currency.rawValue))")
                        }
                    }
                }
            } label: {
                Label(store.currency, systemImage: "dollarsign.circle")
                    .font(.system(size: 11, weight: .medium))
                    .labelStyle(.titleAndIcon)
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
            .buttonStyle(.bordered)
            .controlSize(.small)
            .fixedSize()

            Button {
                Task { await store.refresh(includeOptimize: false, force: true, showLoading: true) }
            } label: {
                Image(systemName: store.isLoading ? "arrow.triangle.2.circlepath" : "arrow.clockwise")
                    .font(.system(size: 11, weight: .medium))
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(store.isLoading)

            Menu {
                Button("CSV (folder)") { runExport(format: .csv) }
                Button("JSON") { runExport(format: .json) }
            } label: {
                Label("Export", systemImage: "square.and.arrow.down")
                    .font(.system(size: 11, weight: .medium))
                    .labelStyle(.titleAndIcon)
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
            .buttonStyle(.bordered)
            .controlSize(.small)
            .fixedSize()

            Spacer()

            Text("v\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?")")
                .font(.system(size: 10, weight: .regular, design: .monospaced))
                .foregroundStyle(.tertiary)

            Button { openReport() } label: {
                Label("Full Report", systemImage: "terminal")
                    .font(.system(size: 11, weight: .semibold))
                    .labelStyle(.titleAndIcon)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .tint(Theme.brandAccent)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private func openReport() {
        TerminalLauncher.open(subcommand: ["report"])
    }

    private enum ExportFormat {
        case csv, json
        var cliName: String { self == .csv ? "csv" : "json" }
        var suffix: String { self == .csv ? "" : ".json" }
    }

    /// Runs `codeburn export` directly into ~/Downloads and reveals the result in Finder. CSV
    /// produces a folder of clean one-table-per-file CSVs; JSON produces a single structured
    /// file. The CLI is spawned with argv (no shell interpretation), so the output path cannot
    /// be abused to inject shell commands even if a pathological value slips through.
    private func runExport(format: ExportFormat) {
        Task {
            let downloads = (NSHomeDirectory() as NSString).appendingPathComponent("Downloads")
            let formatter = DateFormatter()
            formatter.dateFormat = "yyyy-MM-dd-HHmmss"
            let base = "codeburn-\(formatter.string(from: Date()))"
            let outputPath = (downloads as NSString).appendingPathComponent(base + format.suffix)

            let process = CodeburnCLI.makeProcess(subcommand: [
                "export", "-f", format.cliName, "-o", outputPath
            ])

            do {
                let fmt = format
                process.terminationHandler = { proc in
                    Task { @MainActor in
                        if proc.terminationStatus == 0 {
                            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: outputPath)])
                        } else {
                            NSLog("CodeBurn: \(fmt.cliName.uppercased()) export exited with status \(proc.terminationStatus)")
                        }
                    }
                }
                try process.run()
            } catch {
                NSLog("CodeBurn: \(format.cliName.uppercased()) export failed: \(error)")
            }
        }
    }

    /// Instant-feeling currency switch. Updates the symbol and any cached FX rate on the main
     /// thread right away so the UI redraws the next frame, then fetches a fresh rate in the
     /// background. CLI config is persisted so other codeburn commands stay in sync.
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
