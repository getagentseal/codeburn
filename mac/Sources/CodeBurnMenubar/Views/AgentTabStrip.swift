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

    private var todayAll: MenubarPayload {
        store.todayPayload ?? store.payload
    }

    private var periodAll: MenubarPayload {
        store.periodAllPayload ?? store.payload
    }

    private var visibleFilters: [ProviderFilter] {
        let detectedKeys = Set(
            todayAll.current.providers.keys.map { $0.lowercased() }
        )
        return ProviderFilter.allCases.filter { filter in
            if filter == .all { return true }
            return filter.providerKeys.contains(where: detectedKeys.contains)
        }
    }

    private func cost(for filter: ProviderFilter) -> Double? {
        let data = periodAll
        if filter == .all { return data.current.cost }
        let providers = Dictionary(
            data.current.providers.map { ($0.key.lowercased(), $0.value) },
            uniquingKeysWith: +
        )
        return filter.providerKeys.reduce(0.0) { sum, key in
            sum + (providers[key] ?? 0)
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
    @MainActor var color: Color {
        switch self {
        case .all: return Theme.brandAccent
        case .claude: return Theme.categoricalClaude
        case .codex: return Theme.categoricalCodex
        case .cursor: return Theme.categoricalCursor
        case .copilot: return Color(red: 0x6D/255.0, green: 0x8F/255.0, blue: 0xA6/255.0)
        case .gemini: return Color(red: 0x44/255.0, green: 0x85/255.0, blue: 0xF4/255.0)
        case .kiro: return Color(red: 0x4A/255.0, green: 0x9E/255.0, blue: 0xC4/255.0)
        case .opencode: return Color(red: 0x5B/255.0, green: 0x83/255.0, blue: 0x5B/255.0)
        case .pi: return Color(red: 0xB2/255.0, green: 0x6B/255.0, blue: 0x3D/255.0)
        case .omp: return Color(red: 0x8B/255.0, green: 0x5C/255.0, blue: 0xB0/255.0)
        }
    }
}
