import SwiftUI

struct ToolingSection: View {
    @Environment(AppStore.self) private var store
    @State private var isExpanded: Bool = false

    private var skillsAndAgents: [CostRowData] {
        let current = store.payload.current
        var merged: [String: (uses: Int, cost: Double)] = [:]
        for s in current.skills {
            let e = merged[s.name, default: (0, 0)]
            merged[s.name] = (e.uses + s.turns, e.cost + s.cost)
        }
        for a in current.subagents {
            let e = merged[a.name, default: (0, 0)]
            merged[a.name] = (e.uses + a.calls, e.cost + a.cost)
        }
        return merged
            .map { CostRowData(name: $0.key, uses: $0.value.uses, cost: $0.value.cost) }
            .sorted { $0.cost > $1.cost }
    }

    var body: some View {
        let current = store.payload.current
        let combined = skillsAndAgents
        let hasAny = !current.tools.isEmpty || !combined.isEmpty || !current.mcpServers.isEmpty
        if hasAny {
            CollapsibleSection(caption: L("Tooling"), isExpanded: $isExpanded) {
                VStack(alignment: .leading, spacing: 12) {
                    if !current.tools.isEmpty {
                        ToolingSubsection(title: L("Tools")) {
                            let maxCalls = current.tools.map(\.calls).max() ?? 1
                            ForEach(current.tools, id: \.name) { t in
                                CallsRow(name: t.name, calls: t.calls, maxCalls: maxCalls)
                            }
                        }
                    }
                    if !combined.isEmpty {
                        ToolingSubsection(title: L("Skills & Agents")) {
                            let maxCost = max(combined.map(\.cost).max() ?? 0.01, 0.01)
                            ForEach(combined, id: \.name) { d in
                                CostRow(name: d.name, cost: d.cost, count: d.uses, countLabel: "uses", maxCost: maxCost)
                            }
                        }
                    }
                    if !current.mcpServers.isEmpty {
                        ToolingSubsection(title: L("MCP Servers")) {
                            let maxCalls = current.mcpServers.map(\.calls).max() ?? 1
                            ForEach(current.mcpServers, id: \.name) { m in
                                CallsRow(name: m.name, calls: m.calls, maxCalls: maxCalls)
                            }
                        }
                    }
                }
            }
        }
    }
}

private struct CostRowData {
    let name: String
    let uses: Int
    let cost: Double
}

private struct ToolingSubsection<Content: View>: View {
    let title: String
    let content: Content

    init(title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title)
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(.tertiary)
                .textCase(.uppercase)
                .tracking(0.5)
            content
        }
    }
}

private struct CallsRow: View {
    let name: String
    let calls: Int
    let maxCalls: Int

    var body: some View {
        HStack(spacing: 8) {
            FixedBar(fraction: Double(calls) / Double(max(maxCalls, 1)))
                .frame(width: 40, height: 5)
            Text(name)
                .font(.system(size: 12, weight: .medium))
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text("\(calls)")
                .font(.system(size: 11))
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .frame(minWidth: 36, alignment: .trailing)
        }
        .padding(.vertical, 1)
    }
}

private struct CostRow: View {
    let name: String
    let cost: Double
    let count: Int
    let countLabel: String
    let maxCost: Double

    var body: some View {
        HStack(spacing: 8) {
            FixedBar(fraction: cost / max(maxCost, 0.01))
                .frame(width: 40, height: 5)
            Text(name)
                .font(.system(size: 12, weight: .medium))
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text("\(count)")
                .font(.system(size: 11))
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .frame(minWidth: 30, alignment: .trailing)
            Text(cost.asCompactCurrency())
                .font(.codeMono(size: 11, weight: .medium))
                .tracking(-0.2)
                .frame(minWidth: 46, alignment: .trailing)
        }
        .padding(.vertical, 1)
    }
}
