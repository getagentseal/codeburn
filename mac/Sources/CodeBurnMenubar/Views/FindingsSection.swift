import SwiftUI


/// Three-category insights panel: wins, improvements, risks.
/// Wins/risks are derived from current + history; improvements come from the optimize findings.
struct FindingsSection: View {
    @Environment(AppStore.self) private var store
    @State private var isExpanded: Bool = false

    var body: some View {
        let groups = computeTipGroups(payload: store.payload)
        if groups.allSatisfy({ $0.items.isEmpty }) { return AnyView(EmptyView()) }

        return AnyView(
            VStack(alignment: .leading, spacing: 8) {
                Button {
                    withAnimation(.easeInOut(duration: 0.18)) { isExpanded.toggle() }
                } label: {
                    HStack(alignment: .firstTextBaseline) {
                        HStack(spacing: 6) {
                            Image(systemName: "lightbulb.fill")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(Theme.brandAccent)
                            Text("Tips for you")
                                .font(.system(size: 12.5, weight: .semibold))
                                .foregroundStyle(.primary)
                        }
                        Spacer()
                        Text("\(groups.flatMap { $0.items }.count) signals")
                            .font(.system(size: 10.5))
                            .foregroundStyle(.secondary)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 9, weight: .semibold))
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                            .opacity(0.55)
                            .foregroundStyle(.secondary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                if isExpanded {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(groups) { group in
                            if !group.items.isEmpty {
                                TipsGroup(group: group)
                            }
                        }

                        if store.payload.optimize.findingCount > 0 {
                            Button {
                                openOptimize()
                            } label: {
                                HStack(spacing: 4) {
                                    Text("Open Full Optimize")
                                        .font(.system(size: 11.5, weight: .semibold))
                                    Image(systemName: "arrow.forward")
                                        .font(.system(size: 9, weight: .semibold))
                                }
                                .foregroundStyle(Theme.brandAccent)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .transition(.opacity)
                }
            }
            .padding(12)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color.secondary.opacity(0.06))
            )
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
        )
    }

    private func openOptimize() {
        TerminalLauncher.open(subcommand: ["optimize"])
    }
}

private struct TipsGroup: View {
    let group: TipGroup

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 5) {
                Image(systemName: group.icon)
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(group.color)
                Text(group.label)
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(group.color)
                    .textCase(.uppercase)
                    .tracking(0.4)
            }
            VStack(alignment: .leading, spacing: 4) {
                ForEach(group.items) { item in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Circle().fill(group.color).frame(width: 3, height: 3).padding(.top, 4)
                        Text(item.text)
                            .font(.system(size: 11.5))
                            .foregroundStyle(.primary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if let trailing = item.trailing {
                            Text(trailing)
                                .font(.codeMono(size: 11, weight: .medium))
                                .foregroundStyle(.secondary)
                                .tracking(-0.2)
                        }
                    }
                }
            }
        }
    }
}

private struct TipGroup: Identifiable {
    let id = UUID()
    let label: String
    let icon: String
    let color: Color
    let items: [TipItem]
}

private struct TipItem: Identifiable {
    let id = UUID()
    let text: String
    let trailing: String?
}

@MainActor private func computeTipGroups(payload: MenubarPayload) -> [TipGroup] {
    let stats = computeHistoryStats(history: payload.history.daily)

    // What's working
    var wins: [TipItem] = []
    let cacheHit = payload.current.cacheHitPercent
    if cacheHit >= 80 {
        wins.append(TipItem(
            text: "Cache hit at \(Int(cacheHit))% — most prompts reuse cache",
            trailing: nil
        ))
    }
    if let oneShot = payload.current.oneShotRate, oneShot >= 0.75 {
        wins.append(TipItem(
            text: "\(Int(oneShot * 100))% one-shot — edits landing first try",
            trailing: nil
        ))
    }
    if let delta = stats.weekDeltaPercent, delta < -10 {
        wins.append(TipItem(
            text: "Spend down \(Int(abs(delta)))% vs last 7 days",
            trailing: nil
        ))
    }
    if stats.activeStreakDays >= 5 {
        wins.append(TipItem(
            text: "\(stats.activeStreakDays)-day usage streak",
            trailing: nil
        ))
    }

    // What to improve (existing optimize findings)
    var improvements: [TipItem] = []
    for finding in payload.optimize.topFindings.prefix(3) {
        improvements.append(TipItem(
            text: finding.title,
            trailing: finding.savingsUSD.asCompactCurrency()
        ))
    }

    // Risks
    var risks: [TipItem] = []
    if let delta = stats.weekDeltaPercent, delta > 25 {
        risks.append(TipItem(
            text: "Spend up \(Int(delta))% vs prior 7 days",
            trailing: nil
        ))
    }
    if cacheHit > 0 && cacheHit < 50 {
        risks.append(TipItem(
            text: "Cache hit only \(Int(cacheHit))% — paying for cold prompts",
            trailing: nil
        ))
    }
    if let oneShot = payload.current.oneShotRate, oneShot < 0.5 {
        risks.append(TipItem(
            text: "\(Int(oneShot * 100))% one-shot — lots of iteration",
            trailing: nil
        ))
    }
    if let projected = stats.projectedMonth, let prevMonth = stats.previousMonthTotal, projected > prevMonth * 1.3 {
        risks.append(TipItem(
            text: "On pace for \(projected.asCompactCurrency()) this month (+\(Int(((projected - prevMonth) / prevMonth) * 100))% vs last)",
            trailing: nil
        ))
    }

    return [
        TipGroup(label: "What's working", icon: "checkmark.circle.fill", color: Theme.brandAccent, items: wins),
        TipGroup(label: "What to improve", icon: "arrow.up.right.circle.fill", color: Theme.brandAccent, items: improvements),
        TipGroup(label: "Risks", icon: "exclamationmark.triangle.fill", color: Theme.brandAccent, items: risks),
    ]
}

private struct HistoryStats {
    let weekDeltaPercent: Double?
    let activeStreakDays: Int
    let projectedMonth: Double?
    let previousMonthTotal: Double?
}

private func computeHistoryStats(history: [DailyHistoryEntry]) -> HistoryStats {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = .current
    let formatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = .current
        return f
    }()
    let now = Date()
    let today = calendar.startOfDay(for: now)
    let costByDate = Dictionary(history.map { ($0.date, $0.cost) }, uniquingKeysWith: +)

    let lastWeekStart = calendar.date(byAdding: .day, value: -6, to: today)
    let priorWeekStart = calendar.date(byAdding: .day, value: -13, to: today)
    let priorWeekEnd = calendar.date(byAdding: .day, value: -7, to: today)
    var weekDeltaPercent: Double? = nil
    if let lws = lastWeekStart, let pws = priorWeekStart, let pwe = priorWeekEnd {
        let lwsStr = formatter.string(from: lws)
        let pwsStr = formatter.string(from: pws)
        let pweStr = formatter.string(from: pwe)
        let thisWeek = history.filter { $0.date >= lwsStr }.reduce(0.0) { $0 + $1.cost }
        let prior = history.filter { $0.date >= pwsStr && $0.date <= pweStr }.reduce(0.0) { $0 + $1.cost }
        if prior > 0 {
            weekDeltaPercent = ((thisWeek - prior) / prior) * 100
        }
    }

    var streak = 0
    for offset in 0..<60 {
        guard let d = calendar.date(byAdding: .day, value: -offset, to: today) else { break }
        let key = formatter.string(from: d)
        if (costByDate[key] ?? 0) > 0 { streak += 1 } else { break }
    }

    var projectedMonth: Double? = nil
    var previousMonthTotal: Double? = nil
    let comps = calendar.dateComponents([.year, .month, .day], from: now)
    if
        let firstOfMonth = calendar.date(from: DateComponents(year: comps.year, month: comps.month, day: 1)),
        let rangeOfMonth = calendar.range(of: .day, in: .month, for: firstOfMonth)
    {
        let firstStr = formatter.string(from: firstOfMonth)
        let mtd = history.filter { $0.date >= firstStr }.reduce(0.0) { $0 + $1.cost }
        let dayOfMonth = comps.day ?? 1
        if dayOfMonth > 0 {
            projectedMonth = (mtd / Double(dayOfMonth)) * Double(rangeOfMonth.count)
        }

        if
            let prevMonth = calendar.date(byAdding: .month, value: -1, to: firstOfMonth),
            let prevRange = calendar.range(of: .day, in: .month, for: prevMonth),
            let prevFirst = calendar.date(from: DateComponents(
                year: calendar.component(.year, from: prevMonth),
                month: calendar.component(.month, from: prevMonth),
                day: 1
            )),
            let prevLast = calendar.date(byAdding: .day, value: prevRange.count - 1, to: prevFirst)
        {
            let prevFirstStr = formatter.string(from: prevFirst)
            let prevLastStr = formatter.string(from: prevLast)
            let prevTotal = history.filter { $0.date >= prevFirstStr && $0.date <= prevLastStr }
                .reduce(0.0) { $0 + $1.cost }
            if prevTotal > 0 { previousMonthTotal = prevTotal }
        }
    }

    return HistoryStats(
        weekDeltaPercent: weekDeltaPercent,
        activeStreakDays: streak,
        projectedMonth: projectedMonth,
        previousMonthTotal: previousMonthTotal
    )
}
