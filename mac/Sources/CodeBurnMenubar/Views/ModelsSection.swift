import SwiftUI

struct ModelsSection: View {
    @Environment(AppStore.self) private var store
    @State private var isExpanded: Bool = true

    // Only surface the Saved column when something was actually saved by a
    // local-model mapping. With no mapping it would be an unlabeled column of
    // dashes, so we drop it entirely and keep the plain Cost / Calls layout.
    private var showSavings: Bool {
        store.payload.current.topModels.contains { $0.savingsUSD > 0 }
    }

    var body: some View {
        CollapsibleSection(
            caption: "Models",
            isExpanded: $isExpanded,
            trailing: {
                HStack(spacing: 8) {
                    Text("Cost").frame(minWidth: 54, alignment: .trailing)
                    if showSavings {
                        Text("Saved").frame(minWidth: 54, alignment: .trailing)
                    }
                    Text("Calls").frame(minWidth: 52, alignment: .trailing)
                }
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(.tertiary)
                .tracking(-0.05)
            }
        ) {
            VStack(alignment: .leading, spacing: 7) {
                let maxCost = max(store.payload.current.topModels.map(\.cost).max() ?? 1, 0.01)
                ForEach(store.payload.current.topModels, id: \.name) { model in
                    ModelRow(model: model, maxCost: maxCost, showSavings: showSavings)
                }

                TokensLine()
                    .padding(.top, 5)
            }
        }
    }
}

/// Compact token count for the narrow popover: `1.2K` / `3.4M`, plain digits
/// below a thousand. The exact values ride along in the row's accessibility
/// label, so compact rounding never hides the real number.
private func compactTokenCount(_ n: Int) -> String {
    if n >= 1_000_000 {
        return String(format: "%.1fM", Double(n) / 1_000_000)
    } else if n >= 1_000 {
        return String(format: "%.1fK", Double(n) / 1_000)
    }
    return "\(n)"
}

private struct ModelRow: View {
    let model: ModelEntry
    let maxCost: Double
    let showSavings: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                // Bar tracks actual cost; for local models the cost is $0 and the
                // bar will be empty. Saved counterfactual (if any) renders as
                // green text in the saved column, never summed into the bar.
                FixedBar(fraction: model.cost / maxCost)
                    .frame(width: 56, height: 6)

                Text(model.name)
                    .font(.system(size: 12.5, weight: .medium))
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Text(model.cost.asCompactCurrency())
                    .font(.codeMono(size: 12, weight: .medium))
                    .tracking(-0.2)
                    .frame(minWidth: 54, alignment: .trailing)

                if showSavings {
                    Text(model.savingsUSD > 0 ? model.savingsUSD.asCompactCurrency() : "—")
                        .font(.codeMono(size: 12))
                        .tracking(-0.2)
                        .foregroundStyle(model.savingsUSD > 0 ? Color.green : Color.secondary)
                        .frame(minWidth: 54, alignment: .trailing)
                }

                Text("\(model.calls)")
                    .font(.system(size: 11))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .frame(minWidth: 52, alignment: .trailing)
            }

            // Token counts sit on their own secondary line under the model name:
            // seven squashed columns cannot stay legible in the narrow popover,
            // and the cost stays visually attached to its model either way. The
            // line appears only when the payload carries counts for the row — an
            // older CLI renders exactly as before.
            if model.hasTokenCounts {
                Text("\(count(model.inputTokens)) in · \(count(model.outputTokens)) out · \(count(model.cacheReadTokens)) cache read")
                    .font(.system(size: 10.5))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.leading, 64)
                    .accessibilityLabel(model.tokenAccessibilityText)
            }
        }
        .padding(.horizontal, 2)
        .padding(.vertical, 1)
    }

    // Unknown (absent count) renders as a dash; a known zero renders as "0".
    private func count(_ value: Int?) -> String {
        value.map(compactTokenCount) ?? "—"
    }
}

extension ModelEntry {
    /// Exact token counts for assistive tech, since the visible line rounds
    /// compactly. Cache read is labelled as reused input, and cache write is
    /// named separately so the two are never read as one bucket. Locale-pinned
    /// comma grouping so the text is deterministic.
    var tokenAccessibilityText: String {
        func exact(_ value: Int) -> String {
            // Group the MAGNITUDE, then re-apply the sign. Grouping the signed
            // string treats "-" as a leading digit, so the sign is emitted
            // twice ("--1,234,567"). `magnitude` is unsigned, so Int.min is
            // handled too rather than trapping on negation.
            var digits = String(value.magnitude)
            var grouped = ""
            while digits.count > 3 {
                let cut = digits.index(digits.endIndex, offsetBy: -3)
                grouped = "," + digits[cut...] + grouped
                digits = String(digits[..<cut])
            }
            return (value < 0 ? "-" : "") + digits + grouped
        }

        var parts: [String] = []
        if let inputTokens { parts.append("\(exact(inputTokens)) input") }
        if let outputTokens { parts.append("\(exact(outputTokens)) output") }
        if let cacheReadTokens { parts.append("\(exact(cacheReadTokens)) cache read (reused input)") }
        if let cacheWriteTokens, cacheWriteTokens > 0 { parts.append("\(exact(cacheWriteTokens)) cache write") }
        return parts.joined(separator: ", ")
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
        compactTokenCount(n)
    }
}
