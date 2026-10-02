import SwiftUI

struct SpeedSection: View {
    @Environment(AppStore.self) private var store
    @State private var isExpanded = true

    var body: some View {
        CollapsibleSection(caption: L("Generation speed"), isExpanded: $isExpanded, trailing: {
            Text("tok/s · p50").font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
        }) {
            VStack(alignment: .leading, spacing: 8) {
                Text(L("Last 24h · this device · all accounts and projects"))
                    .font(.system(size: 10)).foregroundStyle(.secondary)
                let rows = store.speedReport?.recentRows(
                    harness: store.selectedProvider == .all ? nil : store.selectedProvider.cliArg
                ) ?? []
                ForEach(Array(rows.prefix(6))) { row in
                    HStack(alignment: .top, spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(row.model).font(.system(size: 11, weight: .medium)).lineLimit(1)
                            Text("\(row.harnessName) · \(L(row.precisionLabel))")
                                .font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer(minLength: 4)
                        VStack(alignment: .trailing, spacing: 2) {
                            Text(row.formattedRate).font(.system(size: 12, weight: .semibold, design: .monospaced))
                            Text("\(L("First arrival")): \(row.formattedFirstArrival)")
                                .font(.system(size: 10)).foregroundStyle(.secondary)
                        }
                    }
                    .help("\(row.model) · \(row.source) · \(row.generationRequests)/\(row.requests) · \(row.latestStartedAt)")
                }
                if rows.isEmpty {
                    Text(L(store.speedReport == nil && !store.speedRefreshFailed ? "Reading local timings…" : "No timing samples. Set up capture in the desktop Speed tab."))
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }
                Text(L("Generation excludes the initial wait. ~ = estimate; short or buffered replies may distort it. — = unavailable."))
                    .font(.system(size: 10)).foregroundStyle(.secondary)
                if store.speedRefreshFailed {
                    Text(L("Speed refresh failed. Showing the last available snapshot."))
                        .font(.system(size: 10)).foregroundStyle(.orange)
                }
                if store.speedReport?.hasCoverageWarning == true {
                    Text(L("Some timing records are unavailable. See desktop Speed for details."))
                        .font(.system(size: 10)).foregroundStyle(.secondary)
                }
                if let refreshed = store.speedRefreshedAt {
                    Text(refreshed, style: .time).font(.system(size: 10)).foregroundStyle(.tertiary)
                }
            }
        }
    }
}

/// Fixed-height block shared with the Capacity Dock panel's measured layout.
struct SpeedGlance: View {
    let row: SpeedRow
    let stale: Bool
    let scale: CGFloat

    var body: some View {
        let s = scale
        return VStack(alignment: .leading, spacing: 3 * s) {
            HStack {
                Text(L("Generation speed")).font(.system(size: 10 * s))
                Spacer(minLength: 4)
                Text(row.formattedRate).font(.system(size: 14 * s, weight: .semibold, design: .monospaced))
            }
            Text(row.model).font(.system(size: 11 * s, weight: .medium)).lineLimit(1)
            Text("\(L(row.precisionLabel)) · \(L("First arrival")): \(row.formattedFirstArrival)")
                .font(.system(size: 10 * s)).lineLimit(1)
            Text(L("24h · local · all accounts/projects"))
                .font(.system(size: 9 * s)).lineLimit(1)
            if stale {
                Text(L("Speed snapshot is stale"))
                    .font(.system(size: 9 * s)).foregroundStyle(.orange).lineLimit(1)
            }
        }
        .foregroundStyle(Color.capacityDockText)
        .padding(.horizontal, CapacityDockGlance.contentInset * s)
        .frame(height: CapacityDockGlance.speedHeight * s)
        .help("\(L("Generation excludes the initial wait. ~ = estimate; short or buffered replies may distort it. — = unavailable."))\n\(row.harnessName) · \(row.source) · \(row.generationRequests)/\(row.requests) · \(row.latestStartedAt)")
    }

}
