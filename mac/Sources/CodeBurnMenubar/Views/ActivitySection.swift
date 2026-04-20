import SwiftUI

struct ActivitySection: View {
    @Environment(AppStore.self) private var store
    @State private var isExpanded: Bool = true

    var body: some View {
        CollapsibleSection(
            caption: "Activity",
            isExpanded: $isExpanded,
            trailing: {
                HStack(spacing: 8) {
                    Text(costColumnHeader).frame(minWidth: 54, alignment: .trailing)
                    Text("Turns").frame(minWidth: 52, alignment: .trailing)
                    Text("1-shot").frame(minWidth: 44, alignment: .trailing)
                }
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(.tertiary)
                .tracking(-0.05)
            }
        ) {
            VStack(alignment: .leading, spacing: 7) {
                let billingMode = store.payload.billingMode
                let maxCost = store.payload.current.topActivities.map(\.cost).max() ?? 1
                ForEach(store.payload.current.topActivities, id: \.name) { activity in
                    ActivityRow(activity: activity, maxCost: maxCost, billingMode: billingMode)
                }
            }
        }
    }

    /// Column header varies by billing mode
    private var costColumnHeader: String {
        switch store.payload.billingMode {
        case .credits: "Cost"  // Activities don't have per-activity credits in v2
        case .tokenPlus, .legacy: "Cost"
        }
    }
}

struct ActivityRow: View {
    let activity: ActivityEntry
    let maxCost: Double
    let billingMode: BillingMode

    var body: some View {
        HStack(spacing: 8) {
            FixedBar(fraction: activity.cost / maxCost)
                .frame(width: 56, height: 6)

            Text(activity.name)
                .font(.system(size: 12.5, weight: .medium))
                .frame(maxWidth: .infinity, alignment: .leading)

            Text(formattedCost)
                .font(.codeMono(size: 12, weight: .medium))
                .tracking(-0.2)
                .frame(minWidth: 54, alignment: .trailing)

            Text("\(activity.turns)")
                .font(.system(size: 11))
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .frame(minWidth: 52, alignment: .trailing)

            Text(oneShotText)
                .font(.system(size: 10.5))
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .frame(minWidth: 44, alignment: .trailing)
        }
        .padding(.horizontal, 2)
        .padding(.vertical, 1)
    }

    /// Format cost based on billing mode. Activities in the v2 schema only have `cost`
    /// (no per-activity credits field), so we show the numeric cost without $ in credits mode.
    private var formattedCost: String {
        switch billingMode {
        case .credits:
            // In credits mode, activities don't have a credits field in the JSON schema,
            // so we show the cost value as a raw number (no $ symbol)
            return String(format: "%.2f", activity.cost)
        case .tokenPlus, .legacy:
            return activity.cost.asCompactCurrency()
        }
    }

    private var oneShotText: String {
        guard let rate = activity.oneShotRate else { return "—" }
        return "\(Int(rate * 100))%"
    }
}

/// Fixed-width horizontal bar that shows a fill fraction.
struct FixedBar: View {
    let fraction: Double

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(.secondary.opacity(0.15))
                RoundedRectangle(cornerRadius: 2)
                    .fill(Theme.brandAccent)
                    .frame(width: max(0, min(geo.size.width, geo.size.width * CGFloat(fraction))))
            }
        }
    }
}
