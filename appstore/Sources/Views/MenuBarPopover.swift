import SwiftUI

struct MenuBarPopover: View {
    @ObservedObject var store: SessionStore

    var body: some View {
        if store.needsOnboarding {
            OnboardingView(store: store)
                .frame(width: 360, height: 300)
        } else {
            DashboardView(store: store)
                .frame(width: 380)
        }
    }
}

// MARK: - Dashboard

struct DashboardView: View {
    @ObservedObject var store: SessionStore
    @State private var showSettings = false

    private var totalCost: Double {
        filteredSessions.reduce(0) { $0 + $1.cost }
    }

    private var totalCalls: Int {
        filteredSessions.reduce(0) { $0 + $1.calls }
    }

    private var totalSessions: Int {
        filteredSessions.count
    }

    private var filteredSessions: [ParsedSession] {
        if store.selectedProvider == "all" {
            return store.providers.flatMap(\.sessions)
        }
        return store.providers.first(where: { $0.name == store.selectedProvider })?.sessions ?? []
    }

    var body: some View {
        VStack(spacing: 0) {
            Header(store: store)
            Divider()

            if !store.providers.isEmpty {
                AgentTabStrip(store: store)
                Divider()
            }

            ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 0) {
                    HeroSection(store: store, cost: totalCost, calls: totalCalls, sessions: totalSessions)
                    Divider().opacity(0.5)
                    PeriodSegmentedControl(store: store)
                    Divider().opacity(0.5)

                    if isFilteredEmpty {
                        EmptyProviderState(provider: store.selectedProvider, period: store.selectedPeriod)
                    } else {
                        InsightSection(store: store)
                            .zIndex(10)
                        Divider().opacity(0.5)
                        ActivitySection(store: store)
                        Divider().opacity(0.5)
                        ModelsSection(store: store)
                    }
                }
            }
            .frame(height: 520)
            .animation(.easeInOut(duration: 0.2), value: store.isLoading)

            Divider()
            FooterBar(store: store, showSettings: $showSettings)
        }
    }

    private var isFilteredEmpty: Bool {
        totalCost <= 0 && totalCalls <= 0
    }
}

// MARK: - Header

private struct Header: View {
    @ObservedObject var store: SessionStore

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
            if store.isLoading {
                ProgressView()
                    .scaleEffect(0.6)
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 8)
    }
}

// MARK: - Hero Section

private struct HeroSection: View {
    @ObservedObject var store: SessionStore
    let cost: Double
    let calls: Int
    let sessions: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionCaption(text: caption)

            HStack(alignment: .firstTextBaseline) {
                Text(cost.asCurrency())
                    .font(.system(size: 32, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                    .tracking(-1)
                    .foregroundStyle(
                        LinearGradient(
                            colors: [Theme.brandAccent, Theme.brandAccentDeep],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )

                Spacer()

                VStack(alignment: .trailing, spacing: 2) {
                    Text("\(calls.asThousandsSeparated()) calls")
                        .font(.system(size: 11))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                    Text("\(sessions) sessions")
                        .font(.system(size: 10.5))
                        .monospacedDigit()
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 12)
    }

    private var caption: String {
        let label = store.selectedPeriod.label
        if store.selectedPeriod == .today {
            let formatter = DateFormatter()
            formatter.dateFormat = "EEE MMM d"
            return "\(label) · \(formatter.string(from: Date()))"
        }
        return label
    }
}

// MARK: - Period Picker

private struct PeriodSegmentedControl: View {
    @ObservedObject var store: SessionStore

    var body: some View {
        HStack(spacing: 1) {
            ForEach(SessionStore.Period.allCases) { period in
                Button {
                    store.selectedPeriod = period
                    Task { await store.refresh() }
                } label: {
                    Text(period.label)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(store.selectedPeriod == period ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 4)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .background(
                    RoundedRectangle(cornerRadius: 5)
                        .fill(store.selectedPeriod == period ? Color(NSColor.windowBackgroundColor).opacity(0.85) : .clear)
                        .shadow(color: .black.opacity(store.selectedPeriod == period ? 0.06 : 0), radius: 1, y: 0.5)
                )
            }
        }
        .padding(2)
        .background(
            RoundedRectangle(cornerRadius: 7)
                .fill(Color.secondary.opacity(0.08))
        )
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 10)
    }
}

// MARK: - Agent Tab Strip

private struct AgentTabStrip: View {
    @ObservedObject var store: SessionStore

    private var totalCost: Double {
        store.providers.reduce(0) { $0 + $1.totalCost }
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 5) {
                AgentTab(
                    name: "All",
                    cost: totalCost,
                    color: Theme.brandAccent,
                    isActive: store.selectedProvider == "all"
                ) {
                    store.selectedProvider = "all"
                }

                ForEach(store.providers) { provider in
                    AgentTab(
                        name: provider.name.capitalized,
                        cost: provider.totalCost,
                        color: Theme.providerColor(provider.name),
                        isActive: store.selectedProvider == provider.name
                    ) {
                        store.selectedProvider = provider.name
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)
            .padding(.bottom, 4)
        }
        .frame(height: 38)
    }
}

private struct AgentTab: View {
    let name: String
    let cost: Double
    let color: Color
    let isActive: Bool
    let onTap: () -> Void

    var body: some View {
        VStack(spacing: 3) {
            HStack(spacing: 5) {
                Text(name)
                    .font(.system(size: 11.5, weight: .medium))
                    .tracking(-0.05)
                if cost > 0 {
                    Text(cost.asCompactCurrency())
                        .font(.codeMono(size: 10.5, weight: .medium))
                        .foregroundStyle(isActive ? AnyShapeStyle(.white.opacity(0.8)) : AnyShapeStyle(.secondary))
                        .tracking(-0.2)
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(isActive ? AnyShapeStyle(color) : AnyShapeStyle(Color.secondary.opacity(0.08)))
        )
        .foregroundStyle(isActive ? AnyShapeStyle(.white) : AnyShapeStyle(.secondary))
        .contentShape(Rectangle())
        .onTapGesture { onTap() }
    }
}

// MARK: - Empty State

private struct EmptyProviderState: View {
    let provider: String
    let period: SessionStore.Period

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "tray")
                .font(.system(size: 26))
                .foregroundStyle(.tertiary)
            Text("No \(provider == "all" ? "" : provider + " ")data for \(periodPhrase)")
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
        case .week: "the last 7 days"
        case .month: "the last 30 days"
        case .threeMonths: "the last 3 months"
        case .sixMonths: "the last 6 months"
        }
    }
}

// MARK: - Footer

private struct FooterBar: View {
    @ObservedObject var store: SessionStore
    @Binding var showSettings: Bool

    var body: some View {
        HStack(spacing: 6) {
            Button {
                Task { await store.refresh() }
            } label: {
                Image(systemName: store.isLoading ? "arrow.triangle.2.circlepath" : "arrow.clockwise")
                    .font(.system(size: 11, weight: .medium))
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(store.isLoading)

            Button {
                showSettings = true
            } label: {
                Image(systemName: "gearshape")
                    .font(.system(size: 11, weight: .medium))
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .popover(isPresented: $showSettings) {
                SettingsView(store: store)
            }

            Spacer()

            Text(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "")
                .font(.system(size: 10, weight: .regular, design: .monospaced))
                .foregroundStyle(.tertiary)

            Button {
                NSApplication.shared.terminate(nil)
            } label: {
                Text("Quit")
                    .font(.system(size: 11, weight: .medium))
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

// MARK: - Onboarding

struct OnboardingView: View {
    @ObservedObject var store: SessionStore

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "flame.fill")
                .font(.system(size: 48))
                .foregroundStyle(
                    LinearGradient(
                        colors: [Theme.brandAccent, Theme.brandAccentDeep],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )

            (
                Text("Code").foregroundStyle(.primary)
                + Text("Burn").foregroundStyle(Theme.brandAccent)
                + Text(" Pro").foregroundStyle(.primary)
            )
            .font(.system(size: 18, weight: .semibold))

            Text("Grant access to your home folder so CodeBurn can discover session logs from your coding tools.")
                .font(.system(size: 12))
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .padding(.horizontal)

            Button("Grant Folder Access") {
                store.grantFolderAccess()
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.brandAccent)
            .controlSize(.large)

            Text("We only read session logs. Nothing is uploaded.")
                .font(.system(size: 10))
                .foregroundStyle(.tertiary)
        }
        .padding(24)
    }
}
