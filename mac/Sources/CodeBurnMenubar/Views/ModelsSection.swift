import SwiftUI

struct ModelsSection: View {
    @Environment(AppStore.self) private var store
    @State private var isExpanded: Bool = true

    var body: some View {
        CollapsibleSection(
            caption: "Models",
            isExpanded: $isExpanded,
            trailing: {
                HStack(spacing: 8) {
                    Text(costColumnHeader).frame(minWidth: 54, alignment: .trailing)
                    Text("Calls").frame(minWidth: 52, alignment: .trailing)
                }
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(.tertiary)
                .tracking(-0.05)
            }
        ) {
            VStack(alignment: .leading, spacing: 7) {
                let billingMode = store.payload.billingMode
                let maxValue = store.payload.current.topModels.map { modelMetric($0, mode: billingMode) }.max() ?? 1
                ForEach(store.payload.current.topModels, id: \.name) { model in
                    ModelRow(model: model, maxValue: maxValue, billingMode: billingMode)
                }

                TokensLine()
                    .padding(.top, 5)
            }
        }
    }

    /// Column header varies by billing mode
    private var costColumnHeader: String {
        switch store.payload.billingMode {
        case .credits: "Credits"
        case .tokenPlus, .legacy: "Cost"
        }
    }

    /// Extract the numeric metric used for the bar chart from a model entry
    private func modelMetric(_ model: ModelEntry, mode: BillingMode) -> Double {
        switch mode {
        case .credits:
            return model.creditsAugment ?? 0
        case .tokenPlus:
            return model.billedAmountUsd ?? model.cost ?? 0
        case .legacy:
            return model.cost ?? 0
        }
    }
}

private struct ModelRow: View {
    let model: ModelEntry
    let maxValue: Double
    let billingMode: BillingMode

    var body: some View {
        HStack(spacing: 8) {
            FixedBar(fraction: metricValue / maxValue)
                .frame(width: 56, height: 6)

            Text(model.name)
                .font(.system(size: 12.5, weight: .medium))
                .frame(maxWidth: .infinity, alignment: .leading)

            Text(formattedMetric)
                .font(.codeMono(size: 12, weight: .medium))
                .tracking(-0.2)
                .frame(minWidth: 54, alignment: .trailing)

            Text("\(model.calls)")
                .font(.system(size: 11))
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .frame(minWidth: 52, alignment: .trailing)
        }
        .padding(.horizontal, 2)
        .padding(.vertical, 1)
    }

    private var metricValue: Double {
        switch billingMode {
        case .credits:
            return model.creditsAugment ?? 0
        case .tokenPlus:
            return model.billedAmountUsd ?? model.cost ?? 0
        case .legacy:
            return model.cost ?? 0
        }
    }

    private var formattedMetric: String {
        switch billingMode {
        case .credits:
            return model.creditsAugment.asCompactCredits(fallback: "—")
        case .tokenPlus:
            return model.billedAmountUsd.asCompactCurrency(fallback: model.cost.asCompactCurrency(fallback: "—"))
        case .legacy:
            return model.cost.asCompactCurrency(fallback: "—")
        }
    }
}

private struct TokensLine: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        let t = store.payload.current
        let cacheHit = String(format: "%.0f", t.cacheHitPercent)

        HStack(spacing: 4) {
            Text("Tokens")
                .foregroundStyle(.tertiary)
            Text(formatTokens(t.inputTokens) + " in")
                .foregroundStyle(.secondary)
            Text("·")
                .foregroundStyle(.tertiary)
            Text(formatTokens(t.outputTokens) + " out")
                .foregroundStyle(.secondary)
            Text("·")
                .foregroundStyle(.tertiary)
            Text(cacheHit + "% cache hit")
                .foregroundStyle(.secondary)
            Spacer()
        }
        .font(.system(size: 10.5))
        .monospacedDigit()
    }

    private func formatTokens(_ n: Int) -> String {
        if n >= 1_000_000 {
            return String(format: "%.1fM", Double(n) / 1_000_000)
        } else if n >= 1_000 {
            return String(format: "%.1fK", Double(n) / 1_000)
        }
        return "\(n)"
    }
}
