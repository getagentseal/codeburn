import SwiftUI

struct HeroSection: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionCaption(text: caption)

            HStack(alignment: .firstTextBaseline) {
                Text(heroText)
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
                    if store.displayMetric == .tokens {
                        HStack(spacing: 2) {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 9, weight: .semibold))
                            Text(formatTokens(Double(totals.outputTokens)))
                        }
                        .font(.system(size: 11))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        HStack(spacing: 2) {
                            Image(systemName: "arrow.down")
                                .font(.system(size: 9, weight: .semibold))
                            Text(formatTokens(Double(totals.inputTokens)))
                        }
                        .font(.system(size: 10.5))
                        .monospacedDigit()
                        .foregroundStyle(.tertiary)
                    } else {
                        Text("\(totals.calls.asThousandsSeparated()) calls")
                            .font(.system(size: 11))
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                        Text("\(totals.sessions) sessions")
                            .font(.system(size: 10.5))
                            .monospacedDigit()
                            .foregroundStyle(.tertiary)
                    }
                }
            }

            if !store.isDayMode,
               store.selectedPeriod == .today,
               store.shouldShowDailyBudgetWarning {
                HStack(spacing: 4) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 10))
                    Text("Daily budget of \(store.dailyBudgetLabel) exceeded")
                        .font(.system(size: 11, weight: .medium))
                }
                .foregroundStyle(.orange)
                .padding(.top, 2)
            }

            if let usage = combinedUsage {
                CombinedDeviceBreakdown(usage: usage, formatTokens: formatTokens)
            } else if store.activeScope == .combined, store.lastError != nil {
                HStack(spacing: 4) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 10))
                    Text("Combined unavailable · showing local")
                        .font(.system(size: 11, weight: .medium))
                }
                .foregroundStyle(.secondary)
            }

            if let savingsCaption {
                HStack(spacing: 4) {
                    Image(systemName: "leaf.fill")
                        .font(.system(size: 10))
                    Text(savingsCaption)
                        .font(.system(size: 11, weight: .medium))
                }
                .foregroundStyle(.green)
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 12)
    }

    private var heroText: String {
        if store.displayMetric == .tokens || store.displayMetric == .totalTokens {
            let total = Double(totals.totalTokens)
            if total >= 1_000_000_000 { return String(format: "%.2fB tok", total / 1_000_000_000) }
            if total >= 1_000_000 { return String(format: "%.1fM tok", total / 1_000_000) }
            if total >= 1_000 { return String(format: "%.0fK tok", total / 1_000) }
            return String(format: "%.0f tok", total)
        }
        return totals.cost.asCurrency()
    }

    private var combinedUsage: CombinedUsage? {
        guard store.activeScope == .combined else { return nil }
        return store.payload.combined
    }

    private var totals: HeroTotals {
        HeroTotals(payload: store.payload, activeScope: store.activeScope)
    }

    private func formatTokens(_ n: Double) -> String {
        if n >= 1_000_000_000 { return String(format: "%.1fB", n / 1_000_000_000) }
        if n >= 1_000_000 { return String(format: "%.1fM", n / 1_000_000) }
        if n >= 1_000 { return String(format: "%.0fK", n / 1_000) }
        return String(format: "%.0f", n)
    }

    private var caption: String {
        let label = store.payload.current.label.isEmpty ? store.selectedPeriod.rawValue : store.payload.current.label
        if combinedUsage != nil {
            return "Combined · \(label)"
        }
        if !store.isDayMode && store.selectedPeriod == .today {
            return "\(label) · \(todayDate)"
        }
        return label
    }

    /// Local-model savings caption shown beneath the hero amount when the
    /// user has mapped any local model to a paid baseline via
    /// `codeburn model-savings`. Kept as a separate line so actual spend
    /// (above) and hypothetical avoided spend (below) never get summed
    /// into a misleading "real cost" by the reader.
    private var savingsCaption: String? {
        guard combinedUsage == nil else { return nil }
        let savings = store.payload.current.localModelSavings.totalUSD
        guard savings > 0 else { return nil }
        return "Saved \(savings.asCurrency()) with local models"
    }

    private var todayDate: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "EEE MMM d"
        return formatter.string(from: Date())
    }
}

struct HeroTotals: Equatable {
    let cost: Double
    let calls: Int
    let sessions: Int
    let inputTokens: Int
    let outputTokens: Int
    let totalTokens: Int

    init(cost: Double, calls: Int, sessions: Int, inputTokens: Int, outputTokens: Int, totalTokens: Int) {
        self.cost = cost
        self.calls = calls
        self.sessions = sessions
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.totalTokens = totalTokens
    }

    init(payload: MenubarPayload, activeScope: MenubarScope) {
        if activeScope == .combined, let combined = payload.combined?.combined {
            self.init(
                cost: combined.cost,
                calls: combined.calls,
                sessions: combined.sessions,
                inputTokens: combined.inputTokens,
                outputTokens: combined.outputTokens,
                totalTokens: combined.inputTokens + combined.outputTokens
            )
            return
        }

        let current = payload.current
        self.init(
            cost: current.cost,
            calls: current.calls,
            sessions: current.sessions,
            inputTokens: current.inputTokens,
            outputTokens: current.outputTokens,
            totalTokens: current.inputTokens + current.outputTokens
        )
    }
}

private struct CombinedDeviceBreakdown: View {
    let usage: CombinedUsage
    let formatTokens: (Double) -> String

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 4) {
                Image(systemName: "desktopcomputer")
                    .font(.system(size: 10))
                Text("\(usage.combined.reachableCount) of \(usage.combined.deviceCount) devices")
                    .font(.system(size: 11, weight: .medium))
            }
            .foregroundStyle(.secondary)

            VStack(spacing: 3) {
                ForEach(usage.perDevice, id: \.id) { device in
                    HStack(spacing: 6) {
                        Image(systemName: device.error == nil ? "circle.fill" : "exclamationmark.triangle.fill")
                            .font(.system(size: device.error == nil ? 5 : 9, weight: .semibold))
                            .foregroundStyle(device.error == nil ? Color.secondary.opacity(0.75) : Theme.semanticWarning)
                            .frame(width: 10)
                        Text(device.local ? "\(device.name) · local" : device.name)
                            .font(.system(size: 10.5, weight: .medium))
                            .lineLimit(1)
                            .truncationMode(.tail)
                        Spacer(minLength: 6)
                        Text(device.error == nil ? device.cost.asCurrency() : "Unavailable")
                            .font(.system(size: 10.5))
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                        Text(formatTokens(Double(device.totalTokens)))
                            .font(.system(size: 10))
                            .monospacedDigit()
                            .foregroundStyle(.tertiary)
                    }
                }
            }
        }
    }
}
