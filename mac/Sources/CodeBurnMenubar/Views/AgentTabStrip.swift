import SwiftUI

struct AgentTabStrip: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            // Align chips to .top so the label baseline matches across all
            // providers. Claude/Codex chips reserve a 6pt quota-bar slot
            // (label + 3pt spacing + 3pt bar); chips without that slot
            // (All / Cursor / Droid / Gemini / Copilot / etc.) are 6pt
            // shorter, so a default .center alignment pushes their label
            // ~3pt below the Claude/Codex labels. Top alignment makes every
            // chip start at the same y, putting all labels on a shared line.
            HStack(alignment: .top, spacing: 5) {
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

    @State private var hoverPopoverShown = false
    @State private var hoverEnterTask: DispatchWorkItem?
    @State private var hoverExitTask: DispatchWorkItem?

    /// Providers whose AgentTab chip reserves a 3pt bar slot underneath the
    /// label, even when not yet connected. Driven by which providers we
    /// actually implement live-quota fetching for in AppStore.quotaSummary.
    static func providerSupportsQuota(_ filter: ProviderFilter) -> Bool {
        switch filter {
        case .claude, .codex: return true
        default: return false
        }
    }

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
            // Reserve the bar slot only for providers whose quota source we
            // implement (Claude, Codex). Providers that will never have a bar
            // (All / Cursor / Droid / Gemini / Copilot) skip the slot entirely
            // so the text centers naturally and the chip stays compact.
            // Reserving the slot for Claude/Codex prevents the strip from
            // jumping by 6pt the moment the user clicks Connect.
            if Self.providerSupportsQuota(filter) {
                AgentTabQuotaBar(quota: quota, isActive: isActive)
                    .frame(height: 3)
                    .opacity(quota == nil ? 0 : 1)
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
        .onHover { hovering in
            // Debounce: 250ms enter so swiping across chips doesn't pop a
            // popover for every chip touched, and 150ms exit so cursor travel
            // between chip and popover doesn't dismiss prematurely.
            hoverEnterTask?.cancel()
            hoverExitTask?.cancel()
            if hovering, quota != nil {
                let task = DispatchWorkItem { hoverPopoverShown = true }
                hoverEnterTask = task
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: task)
            } else {
                let task = DispatchWorkItem { hoverPopoverShown = false }
                hoverExitTask = task
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: task)
            }
        }
        .popover(isPresented: $hoverPopoverShown) {
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
        case .warning:  return Color.yellow
        case .critical: return Color.orange
        case .danger:   return Color.red
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
                Text(disconnectedMessage)
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

    private var disconnectedMessage: String {
        switch quota.providerFilter {
        case .codex:  return "Sign in with `codex` (ChatGPT mode) to track quota."
        case .claude: return "Sign in to Claude Code to track quota."
        default:      return "Sign in to track quota."
        }
    }

    private var rowsCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text("\(quota.providerFilter.rawValue) usage")
                    .font(.system(size: 11, weight: .semibold))
                if case .stale = quota.connection {
                    Text("stale")
                        .font(.system(size: 9.5))
                        .foregroundStyle(.secondary)
                } else if case .transientFailure = quota.connection {
                    Text("retrying")
                        .font(.system(size: 9.5))
                        .foregroundStyle(.orange)
                }
                Spacer()
                if let plan = quota.planLabel, !plan.isEmpty {
                    Text(plan)
                        .font(.system(size: 9.5, weight: .medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(
                            RoundedRectangle(cornerRadius: 4)
                                .fill(Color.secondary.opacity(0.12))
                        )
                        // Size to content. Plan names are bounded short strings
                        // ("Max 20x", "Pro Lite", "Free Workspace"); a forced
                        // maxWidth was making short labels look stretched.
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
            ForEach(Array(quota.details.enumerated()), id: \.offset) { _, w in
                QuotaDetailRow(window: w)
            }
            if !quota.footerLines.isEmpty {
                Divider()
                    .padding(.top, 2)
                ForEach(Array(quota.footerLines.enumerated()), id: \.offset) { _, line in
                    Text(line)
                        .font(.system(size: 10.5))
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func terminalFailureCard(reason: String?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(reconnectTitle)
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundStyle(.red)
            Text(reason ?? defaultReconnectReason)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .lineLimit(2)
            Text(reconnectInstruction)
                .font(.system(size: 10.5))
                .foregroundStyle(.secondary)
        }
    }

    private var reconnectTitle: String {
        switch quota.providerFilter {
        case .codex:  return "Reconnect Codex"
        default:      return "Reconnect Claude"
        }
    }

    private var defaultReconnectReason: String {
        switch quota.providerFilter {
        case .codex:  return "Refresh token rejected by OpenAI."
        default:      return "Refresh token rejected by Anthropic."
        }
    }

    private var reconnectInstruction: String {
        switch quota.providerFilter {
        case .codex:  return "Run `codex login` in your terminal, then click Reconnect."
        default:      return "Open Claude Code in your terminal and type `/login`, then click Reconnect."
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
        case .warning:  return Color.yellow
        case .critical: return Color.orange
        case .danger:   return Color.red
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
