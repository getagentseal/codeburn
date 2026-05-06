import SwiftUI

struct AgentTabStrip: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 5) {
                ForEach(visibleFilters) { filter in
                    Button {
                        store.switchTo(provider: filter)
                    } label: {
                        AgentTab(
                            filter: filter,
                            cost: cost(for: filter),
                            isActive: store.selectedProvider == filter,
                            quota: store.quotaSummary(for: filter)
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
        if filter == store.selectedProvider, store.hasCachedData {
            return store.payload.current.cost
        }
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
    let quota: QuotaSummary?

    @State private var isHovering = false

    var body: some View {
        VStack(spacing: 3) {
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
            if quota != nil {
                AgentTabQuotaBar(quota: quota, isActive: isActive)
                    .frame(height: 3)
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
        .onHover { hovering in isHovering = hovering }
        .popover(isPresented: Binding(get: { isHovering && quota != nil }, set: { _ in })) {
            if let quota {
                QuotaDetailPopover(quota: quota)
            }
        }
    }
}

/// Thin progress bar drawn inside an AgentTab chip when that provider has a live quota
/// source. Width matches the chip; color shifts green → amber → red at 70% / 90%.
private struct AgentTabQuotaBar: View {
    let quota: QuotaSummary?
    let isActive: Bool

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(trackColor)
                if let percent = filledFraction {
                    Capsule()
                        .fill(barColor)
                        .frame(width: max(2, geo.size.width * CGFloat(percent)))
                        .animation(.easeOut(duration: 0.25), value: percent)
                }
                if case .terminalFailure = quota?.connection {
                    // Hatched/red strip to telegraph "broken; reconnect needed".
                    Capsule()
                        .fill(Color.red.opacity(0.7))
                }
            }
        }
    }

    private var filledFraction: Double? {
        guard let pct = quota?.primary?.percent else { return nil }
        return min(max(pct, 0), 1)
    }

    private var barColor: Color {
        guard let pct = quota?.primary?.percent else { return .clear }
        switch QuotaSummary.severity(for: pct) {
        case .normal:   return isActive ? Color.white : Color.green.opacity(0.85)
        case .warning:  return Color.orange
        case .critical: return Color.red
        }
    }

    private var trackColor: Color {
        isActive ? Color.white.opacity(0.20) : Color.secondary.opacity(0.18)
    }
}

private struct QuotaDetailPopover: View {
    let quota: QuotaSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch quota.connection {
            case .terminalFailure(let reason):
                terminalFailureCard(reason: reason)
            case .disconnected:
                Text("Sign in to Claude Code to track quota.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            case .loading where quota.details.isEmpty:
                Text("Loading…")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            default:
                rowsCard
            }
        }
        .padding(12)
        .frame(width: 260)
    }

    private var rowsCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Claude usage")
                    .font(.system(size: 11, weight: .semibold))
                Spacer()
                if case .stale = quota.connection {
                    Text("stale")
                        .font(.system(size: 9.5))
                        .foregroundStyle(.secondary)
                } else if case .transientFailure = quota.connection {
                    Text("retrying")
                        .font(.system(size: 9.5))
                        .foregroundStyle(.orange)
                }
            }
            ForEach(Array(quota.details.enumerated()), id: \.offset) { _, w in
                QuotaDetailRow(window: w)
            }
        }
    }

    private func terminalFailureCard(reason: String?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Reconnect Claude")
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundStyle(.red)
            Text(reason ?? "Refresh token rejected by Anthropic.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .lineLimit(2)
            Text("Run `claude login` in your terminal — the menu bar will pick it up automatically.")
                .font(.system(size: 10.5))
                .foregroundStyle(.secondary)
        }
    }
}

private struct QuotaDetailRow: View {
    let window: QuotaSummary.Window

    var body: some View {
        HStack(spacing: 8) {
            Text(window.label)
                .font(.system(size: 10.5))
                .frame(width: 92, alignment: .leading)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.secondary.opacity(0.18))
                    Capsule()
                        .fill(barColor)
                        .frame(width: max(2, geo.size.width * CGFloat(min(max(window.percent, 0), 1))))
                }
            }
            .frame(height: 4)
            Text(window.percentLabel)
                .font(.codeMono(size: 10.5, weight: .medium))
                .frame(width: 36, alignment: .trailing)
            if !window.resetsInLabel.isEmpty {
                Text(window.resetsInLabel)
                    .font(.codeMono(size: 10))
                    .foregroundStyle(.secondary)
                    .frame(width: 50, alignment: .trailing)
            }
        }
    }

    private var barColor: Color {
        switch QuotaSummary.severity(for: window.percent) {
        case .normal:   return Color.green.opacity(0.85)
        case .warning:  return Color.orange
        case .critical: return Color.red
        }
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
        case .droid: return Color(red: 0x7C/255.0, green: 0x3A/255.0, blue: 0xED/255.0)
        case .gemini: return Color(red: 0x44/255.0, green: 0x85/255.0, blue: 0xF4/255.0)
        case .kiloCode: return Color(red: 0x00/255.0, green: 0x96/255.0, blue: 0x88/255.0)
        case .kiro: return Color(red: 0x4A/255.0, green: 0x9E/255.0, blue: 0xC4/255.0)
        case .openclaw: return Color(red: 0xDA/255.0, green: 0x70/255.0, blue: 0x56/255.0)
        case .opencode: return Color(red: 0x5B/255.0, green: 0x83/255.0, blue: 0x5B/255.0)
        case .pi: return Color(red: 0xB2/255.0, green: 0x6B/255.0, blue: 0x3D/255.0)
        case .qwen: return Color(red: 0x61/255.0, green: 0x5E/255.0, blue: 0xEB/255.0)
        case .omp: return Color(red: 0x8B/255.0, green: 0x5C/255.0, blue: 0xB0/255.0)
        case .rooCode: return Color(red: 0x4C/255.0, green: 0xAF/255.0, blue: 0x50/255.0)
        }
    }
}
