import AppKit
import SwiftUI

/// Shared state read by the NSEvent local monitor closure. The closure
/// snapshots its captured environment at install time, so SwiftUI @State
/// can't be used directly — a reference-type holder keeps the latest hover
/// status visible to the monitor across SwiftUI updates.
@MainActor
final class AgentTabStripScrollState {
    static let shared = AgentTabStripScrollState()
    var isStripHovered: Bool = false
}

struct AgentTabStrip: View {
    @Environment(AppStore.self) private var store
    @State private var stripViewportWidth: CGFloat = 0
    @State private var stripContentWidth: CGFloat = 0
    @State private var scrollWheelMonitor: Any?

    var body: some View {
        GeometryReader { viewportGeo in
            ScrollViewReader { proxy in
                HStack(spacing: 4) {
                    if isOverflowing {
                        Button {
                            selectAdjacentProvider(direction: -1, proxy: proxy)
                        } label: {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 10, weight: .semibold))
                                .frame(width: 18, height: 18)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(canMoveBackward ? Color.primary : Color.secondary.opacity(0.35))
                        .disabled(!canMoveBackward)
                        .help("Show previous providers")
                    }

                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 5) {
                            ForEach(visibleFilters) { filter in
                                AgentTab(
                                    filter: filter,
                                    cost: cost(for: filter),
                                    isActive: store.selectedProvider == filter,
                                    quota: store.quotaSummary(for: filter)
                                ) {
                                    store.switchTo(provider: filter)
                                    withAnimation(.easeInOut(duration: 0.18)) {
                                        proxy.scrollTo(filter.id, anchor: .center)
                                    }
                                }
                                .id(filter.id)
                            }
                        }
                        .background(
                            GeometryReader { contentGeo in
                                Color.clear
                                    .onAppear {
                                        stripContentWidth = contentGeo.size.width
                                    }
                                    .onChange(of: contentGeo.size.width) { _, newWidth in
                                        stripContentWidth = newWidth
                                    }
                            }
                        )
                    }
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
                    .padding(.bottom, 4)
                    .onHover { hovering in
                        AgentTabStripScrollState.shared.isStripHovered = hovering
                    }

                    if isOverflowing {
                        Button {
                            selectAdjacentProvider(direction: 1, proxy: proxy)
                        } label: {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 10, weight: .semibold))
                                .frame(width: 18, height: 18)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(canMoveForward ? Color.primary : Color.secondary.opacity(0.35))
                        .disabled(!canMoveForward)
                        .help("Show next providers")
                    }
                }
                .onAppear {
                    stripViewportWidth = viewportGeo.size.width
                    installScrollWheelMonitorIfNeeded()
                    withAnimation(.easeInOut(duration: 0.18)) {
                        proxy.scrollTo(store.selectedProvider.id, anchor: .center)
                    }
                }
                .onChange(of: viewportGeo.size.width) { _, newWidth in
                    stripViewportWidth = newWidth
                }
                .onChange(of: store.selectedProvider) { _, newProvider in
                    withAnimation(.easeInOut(duration: 0.18)) {
                        proxy.scrollTo(newProvider.id, anchor: .center)
                    }
                }
                .onDisappear {
                    removeScrollWheelMonitorIfNeeded()
                }
            }
        }
        .frame(height: 38)
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
        let detected = ProviderFilter.allCases.filter { filter in
            if filter == .all { return true }
            return filter.providerKeys.contains(where: detectedKeys.contains)
        }
        let costs = Dictionary(uniqueKeysWithValues: detected.map { ($0, cost(for: $0) ?? 0) })
        return detected.sorted { a, b in
            if a == .all { return true }
            if b == .all { return false }
            let ca = costs[a, default: 0]
            let cb = costs[b, default: 0]
            if ca != cb { return ca > cb }
            return a.rawValue < b.rawValue
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

    private var currentFilterIndex: Int {
        visibleFilters.firstIndex(of: store.selectedProvider) ?? 0
    }

    private var canMoveBackward: Bool { currentFilterIndex > 0 }
    private var canMoveForward: Bool { currentFilterIndex < visibleFilters.count - 1 }
    private var isOverflowing: Bool { stripContentWidth > (stripViewportWidth - 30) }

    private func selectAdjacentProvider(direction: Int, proxy: ScrollViewProxy) {
        guard !visibleFilters.isEmpty else { return }
        let targetIndex = min(max(currentFilterIndex + direction, 0), visibleFilters.count - 1)
        let target = visibleFilters[targetIndex]
        store.switchTo(provider: target)
        withAnimation(.easeInOut(duration: 0.18)) {
            proxy.scrollTo(target.id, anchor: .center)
        }
    }

    /// Standard mouse wheels emit vertical-only scroll deltas, which a horizontal
    /// `ScrollView` ignores. While the cursor is over the strip we transpose
    /// vertical-axis scroll fields onto the horizontal axis so the underlying
    /// NSScrollView receives a real horizontal delta. Trackpad events (precise
    /// deltas, with native horizontal component) are passed through untouched
    /// so vertical scrolling elsewhere in the popover is unaffected.
    private func installScrollWheelMonitorIfNeeded() {
        guard scrollWheelMonitor == nil else { return }
        scrollWheelMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { event in
            guard AgentTabStripScrollState.shared.isStripHovered,
                  !event.hasPreciseScrollingDeltas,
                  abs(event.scrollingDeltaX) < 0.001,
                  abs(event.scrollingDeltaY) > 0,
                  let cg = event.cgEvent?.copy() else {
                return event
            }
            let lineDeltaY = cg.getIntegerValueField(.scrollWheelEventDeltaAxis1)
            let pointDeltaY = cg.getDoubleValueField(.scrollWheelEventPointDeltaAxis1)
            let fixedDeltaY = cg.getDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1)
            cg.setIntegerValueField(.scrollWheelEventDeltaAxis1, value: 0)
            cg.setDoubleValueField(.scrollWheelEventPointDeltaAxis1, value: 0)
            cg.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1, value: 0)
            cg.setIntegerValueField(.scrollWheelEventDeltaAxis2, value: lineDeltaY)
            cg.setDoubleValueField(.scrollWheelEventPointDeltaAxis2, value: pointDeltaY)
            cg.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis2, value: fixedDeltaY)
            return NSEvent(cgEvent: cg) ?? event
        }
    }

    private func removeScrollWheelMonitorIfNeeded() {
        if let monitor = scrollWheelMonitor {
            NSEvent.removeMonitor(monitor)
            scrollWheelMonitor = nil
        }
    }
}

private struct AgentTab: View {
    let filter: ProviderFilter
    let cost: Double?
    let isActive: Bool
    let quota: QuotaSummary?
    let onTap: () -> Void

    @State private var hoverPopoverShown = false
    @State private var hoverEnterTask: DispatchWorkItem?
    @State private var hoverExitTask: DispatchWorkItem?
    @State private var clickDismissed = false

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
        .onTapGesture {
            hoverPopoverShown = false
            hoverEnterTask?.cancel()
            clickDismissed = true
            onTap()
        }
        .onHover { hovering in
            hoverEnterTask?.cancel()
            hoverExitTask?.cancel()
            if !hovering {
                clickDismissed = false
                let task = DispatchWorkItem { hoverPopoverShown = false }
                hoverExitTask = task
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: task)
            } else if !clickDismissed, quota != nil {
                let task = DispatchWorkItem { hoverPopoverShown = true }
                hoverEnterTask = task
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: task)
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
        case .cline: return Color(red: 0x23/255.0, green: 0x8A/255.0, blue: 0x7E/255.0)
        case .codex: return Theme.categoricalCodex
        case .cursor: return Theme.categoricalCursor
        case .cursorAgent: return Color(red: 0x4E/255.0, green: 0xC9/255.0, blue: 0xB0/255.0)
        case .copilot: return Color(red: 0x6D/255.0, green: 0x8F/255.0, blue: 0xA6/255.0)
        case .devin: return Color(red: 0x25/255.0, green: 0xA0/255.0, blue: 0x8D/255.0)
        case .droid: return Color(red: 0x7C/255.0, green: 0x3A/255.0, blue: 0xED/255.0)
        case .gemini: return Color(red: 0x44/255.0, green: 0x85/255.0, blue: 0xF4/255.0)
        case .ibmBob: return Color(red: 0x0F/255.0, green: 0x62/255.0, blue: 0xFE/255.0)
        case .kiloCode: return Color(red: 0x00/255.0, green: 0x96/255.0, blue: 0x88/255.0)
        case .kiro: return Color(red: 0x4A/255.0, green: 0x9E/255.0, blue: 0xC4/255.0)
        case .kimi: return Color(red: 0xA4/255.0, green: 0xC6/255.0, blue: 0x39/255.0)
        case .openclaw: return Color(red: 0xDA/255.0, green: 0x70/255.0, blue: 0x56/255.0)
        case .opencode: return Color(red: 0x5B/255.0, green: 0x83/255.0, blue: 0x5B/255.0)
        case .pi: return Color(red: 0xB2/255.0, green: 0x6B/255.0, blue: 0x3D/255.0)
        case .qwen: return Color(red: 0x61/255.0, green: 0x5E/255.0, blue: 0xEB/255.0)
        case .omp: return Color(red: 0x8B/255.0, green: 0x5C/255.0, blue: 0xB0/255.0)
        case .rooCode: return Color(red: 0x4C/255.0, green: 0xAF/255.0, blue: 0x50/255.0)
        case .crush: return Color(red: 0xE0/255.0, green: 0x6C/255.0, blue: 0x9F/255.0)
        case .antigravity: return Color(red: 0xFF/255.0, green: 0x7A/255.0, blue: 0x45/255.0)
        case .goose: return Color(red: 0xB7/255.0, green: 0x8D/255.0, blue: 0x52/255.0)
        }
    }
}
