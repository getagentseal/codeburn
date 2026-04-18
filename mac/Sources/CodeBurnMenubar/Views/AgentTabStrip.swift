import SwiftUI

struct AgentTabStrip: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 5) {
                ForEach(visibleFilters) { filter in
                    Button {
                        Task { await store.switchTo(provider: filter) }
                    } label: {
                        AgentTab(
                            filter: filter,
                            cost: cost(for: filter),
                            isActive: store.selectedProvider == filter
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)
            .padding(.bottom, 4)
        }
    }

    /// Drive tab visibility and per-tab cost labels from the *all-provider* payload (today),
    /// not the currently selected provider's payload. Without this, switching to Codex (which
    /// has no data) would hide every other tab including Claude.
    private var allProvidersToday: MenubarPayload {
        store.todayPayload ?? store.payload
    }

    private var visibleFilters: [ProviderFilter] {
        // Show a tab for every provider detected on this machine. The CLI decides what
        // to include in the providers map based on session dirs / credential files it
        // finds, so zero-cost-today is still "installed" and the user expects to see
        // it. Only providers that aren't installed at all are absent from the map.
        let detectedKeys = Set(
            allProvidersToday.current.providers.keys.map { $0.lowercased() }
        )
        return ProviderFilter.allCases.filter { filter in
            if filter == .all { return true }
            return detectedKeys.contains(filter.rawValue.lowercased())
        }
    }

    private func cost(for filter: ProviderFilter) -> Double? {
        switch filter {
        case .all:
            return allProvidersToday.current.cost
        default:
            let key = filter.rawValue.lowercased()
            return allProvidersToday.current.providers[key]
        }
    }
}

private struct AgentTab: View {
    let filter: ProviderFilter
    let cost: Double?
    let isActive: Bool

    var body: some View {
        HStack(spacing: 5) {
            Text(filter.rawValue)
                .font(.system(size: 11.5, weight: .medium))
                .tracking(-0.05)
            if let cost, cost > 0 {
                Text(cost.asCompactCurrency())
                    .font(.codeMono(size: 10.5, weight: .medium))
                    .foregroundStyle(isActive ? AnyShapeStyle(.white.opacity(0.8)) : AnyShapeStyle(.secondary))
                    .tracking(-0.2)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(isActive ? AnyShapeStyle(Theme.brandAccent) : AnyShapeStyle(Color.secondary.opacity(0.08)))
        )
        .foregroundStyle(isActive ? AnyShapeStyle(.white) : AnyShapeStyle(.secondary))
        .contentShape(Rectangle())
    }
}

extension ProviderFilter {
    var color: Color {
        switch self {
        case .all: return Theme.brandAccent
        case .claude: return Theme.categoricalClaude
        case .codex: return Theme.categoricalCodex
        case .cursor: return Theme.categoricalCursor
        case .copilot: return Color(red: 0x6D/255.0, green: 0x8F/255.0, blue: 0xA6/255.0)
        case .opencode: return Color(red: 0x5B/255.0, green: 0x83/255.0, blue: 0x5B/255.0)
        case .pi: return Color(red: 0xB2/255.0, green: 0x6B/255.0, blue: 0x3D/255.0)
        }
    }
}
