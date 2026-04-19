import SwiftUI

private let trendDays = 19
private let trendBarWidth: CGFloat = 13
private let trendBarGap: CGFloat = 4
private let trendChartHeight: CGFloat = 90

/// Three switchable insight visualizations: Calendar (this month), Forecast (burn rate),
/// Pulse (efficiency KPIs). Pills at top toggle between them.
struct HeatmapSection: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            InsightPillSwitcher(selected: bindingMode, visibleModes: visibleModes)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear { ensureValidSelection() }
    }

    private var bindingMode: Binding<InsightMode> {
        Binding(get: { store.selectedInsight }, set: { store.selectedInsight = $0 })
    }

    private var visibleModes: [InsightMode] {
        InsightMode.allCases
    }

    private func ensureValidSelection() {
        if !visibleModes.contains(store.selectedInsight) {
            store.selectedInsight = visibleModes.first ?? .trend
        }
    }

    @ViewBuilder
    private var content: some View {
        switch store.selectedInsight {
        case .plan: PlanInsight(usage: store.subscription)
        case .trend: TrendInsight(days: store.payload.history.daily)
        case .forecast: ForecastInsight(days: store.payload.history.daily)
        case .pulse: PulseInsight(payload: store.payload)
        case .stats: StatsInsight(payload: store.payload)
        }
    }
}

// MARK: - Pill Switcher

private struct InsightPillSwitcher: View {
    @Binding var selected: InsightMode
    let visibleModes: [InsightMode]

    var body: some View {
        HStack(spacing: 4) {
            ForEach(visibleModes) { mode in
                Button {
                    selected = mode
                } label: {
                    Text(mode.rawValue)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(selected == mode ? AnyShapeStyle(.white) : AnyShapeStyle(.secondary))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(
                            RoundedRectangle(cornerRadius: 6)
                                .fill(selected == mode ? AnyShapeStyle(Theme.brandAccent) : AnyShapeStyle(Color.secondary.opacity(0.10)))
                        )
                }
                .buttonStyle(.plain)
            }
        }
    }
}

// MARK: - Trend (14-day bar chart with peak + average)

private struct TrendInsight: View {
    let days: [DailyHistoryEntry]

    var body: some View {
        let bars = buildTrendBars(from: days)
        let stats = computeTrendStats(bars: bars, allDays: days)
        // Tokens are real for the .all-providers view; per-provider history doesn't carry
        // token breakdown yet, so fall back to $ when no tokens are present.
        let totalTokens = bars.reduce(0.0) { $0 + $1.tokens }
        let useTokens = totalTokens > 0
        let metric: (TrendBar) -> Double = useTokens ? { $0.tokens } : { $0.cost }
        let maxValue = max(bars.map(metric).max() ?? 1, 0.01)
        let avgValue = bars.isEmpty ? 0 : bars.map(metric).reduce(0, +) / Double(bars.count)
        let peakValue = bars.filter({ metric($0) > 0 }).max(by: { metric($0) < metric($1) })
        let yesterdayValue = stats.yesterdayBar.map(metric)

        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Last \(trendDays) days")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.tertiary)
                    Text(formatHero(useTokens: useTokens, tokens: totalTokens, dollars: stats.totalThisWindow))
                        .font(.system(size: 18, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(.primary)
                }
                Spacer()
                if let delta = stats.deltaPercent {
                    HStack(spacing: 3) {
                        Image(systemName: delta >= 0 ? "arrow.up.right" : "arrow.down.right")
                            .font(.system(size: 9, weight: .bold))
                        Text("\(delta >= 0 ? "+" : "")\(String(format: "%.0f", delta))% vs prior \(trendDays)d")
                            .font(.system(size: 10.5))
                            .monospacedDigit()
                    }
                    .foregroundStyle(Theme.brandAccent)
                }
            }

            TrendChart(
                bars: bars,
                maxValue: maxValue,
                avgValue: avgValue,
                metric: metric,
                formatValue: { formatValue($0, useTokens: useTokens) }
            )
            .zIndex(1)

            HStack(spacing: 14) {
                MiniStat(label: "Avg/day", value: formatValue(avgValue, useTokens: useTokens))
                MiniStat(label: "Peak", value: peakLabel(peakValue, metric: metric, useTokens: useTokens))
                MiniStat(label: "Yesterday", value: yesterdayValue.map { formatValue($0, useTokens: useTokens) } ?? "—")
            }
        }
    }

    private func formatHero(useTokens: Bool, tokens: Double, dollars: Double) -> String {
        useTokens ? "\(formatTokens(tokens)) tokens" : dollars.asCurrency()
    }

    private func formatValue(_ v: Double, useTokens: Bool) -> String {
        useTokens ? "\(formatTokens(v)) tok" : v.asCompactCurrency()
    }

    private func peakLabel(_ peak: TrendBar?, metric: (TrendBar) -> Double, useTokens: Bool) -> String {
        guard let peak, metric(peak) > 0 else { return "—" }
        return "\(formatValue(metric(peak), useTokens: useTokens)) on \(shortDate(peak.date))"
    }

    private func formatTokens(_ n: Double) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", n / 1_000_000) }
        if n >= 1_000 { return String(format: "%.0fK", n / 1_000) }
        return String(format: "%.0f", n)
    }

    private func shortDate(_ ymd: String) -> String {
        let parts = ymd.split(separator: "-")
        guard parts.count == 3 else { return ymd }
        return "\(parts[1])/\(parts[2])"
    }
}

private struct TrendChart: View {
    let bars: [TrendBar]
    let maxValue: Double
    let avgValue: Double
    let metric: (TrendBar) -> Double
    let formatValue: (Double) -> String

    @State private var hoveredBarID: TrendBar.ID?

    var body: some View {
        let avgFraction = maxValue > 0 ? CGFloat(min(avgValue / maxValue, 1.0)) : 0

        ZStack(alignment: .bottomLeading) {
            HStack(alignment: .bottom, spacing: trendBarGap) {
                ForEach(bars) { bar in
                    BarColumn(
                        bar: bar,
                        value: metric(bar),
                        maxValue: maxValue,
                        isHovered: hoveredBarID == bar.id
                    )
                    .onHover { hovering in
                        hoveredBarID = hovering ? bar.id : (hoveredBarID == bar.id ? nil : hoveredBarID)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .frame(height: trendChartHeight, alignment: .bottom)

            GeometryReader { geo in
                Path { p in
                    let y = geo.size.height - (geo.size.height * avgFraction)
                    p.move(to: CGPoint(x: 0, y: y))
                    p.addLine(to: CGPoint(x: geo.size.width, y: y))
                }
                .stroke(Color.secondary.opacity(0.5), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
            }
            .frame(height: trendChartHeight)
            .allowsHitTesting(false)
        }
        .frame(height: trendChartHeight)
        .overlay(alignment: .bottomLeading) {
            // Floats below the chart without taking layout space. Opaque dark card hides
            // whatever sits beneath it (mini stats, activity rows).
            if let hoveredBar {
                BarTooltipCard(bar: hoveredBar, value: metric(hoveredBar), formatValue: formatValue)
                    .padding(.top, 6)
                    .offset(y: 92)
                    .transition(.opacity)
                    .allowsHitTesting(false)
                    .zIndex(10)
            }
        }
        .animation(.easeInOut(duration: 0.12), value: hoveredBarID)
    }

    private var hoveredBar: TrendBar? {
        guard let id = hoveredBarID else { return nil }
        return bars.first { $0.id == id }
    }
}

private struct BarColumn: View {
    let bar: TrendBar
    let value: Double
    let maxValue: Double
    let isHovered: Bool

    var body: some View {
        let fraction = maxValue > 0 ? CGFloat(value / maxValue) : 0
        let height = max(2, trendChartHeight * fraction)

        VStack(spacing: 2) {
            Spacer(minLength: 0)
            RoundedRectangle(cornerRadius: 2)
                .fill(barColor)
                .frame(width: trendBarWidth, height: height)
                .overlay(
                    RoundedRectangle(cornerRadius: 2)
                        .stroke(Theme.brandAccent.opacity(isHovered ? 0.9 : 0), lineWidth: 1)
                )
                .scaleEffect(x: isHovered ? 1.08 : 1.0, y: 1.0, anchor: .bottom)
                .animation(.easeOut(duration: 0.12), value: isHovered)
        }
        .contentShape(Rectangle())
    }

    private var barColor: Color {
        if bar.isToday { return Theme.brandAccent }
        if value <= 0 { return Color.secondary.opacity(0.15) }
        return isHovered ? Theme.brandAccent.opacity(0.85) : Theme.brandAccent.opacity(0.55)
    }
}

private struct BarTooltipCard: View {
    let bar: TrendBar
    /// Value to display in the tooltip header. Matches the metric the trend chart
    /// is currently using (tokens when the .all-providers view has token data,
    /// cost when provider-filtered views force a $ fallback). Passing this in keeps
    /// the tooltip in sync with the chart instead of always reading bar.tokens,
    /// which is zero for provider-filtered days.
    let value: Double
    let formatValue: (Double) -> String
    @Environment(\.colorScheme) private var colorScheme

    private var backgroundFill: Color {
        colorScheme == .dark ? Color.white : Color.black
    }

    private var primaryText: Color {
        colorScheme == .dark ? Color.black : Color.white
    }

    private var secondaryText: Color {
        colorScheme == .dark ? Color.black.opacity(0.7) : Color.white.opacity(0.72)
    }

    private var tertiaryText: Color {
        colorScheme == .dark ? Color.black.opacity(0.5) : Color.white.opacity(0.52)
    }

    private var borderStroke: Color {
        colorScheme == .dark ? Color.black.opacity(0.12) : Color.white.opacity(0.12)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text(prettyDate(bar.date))
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(primaryText)
                Spacer()
                Text("\(formatValue(value))")
                    .font(.codeMono(size: 10.5, weight: .semibold))
                    .foregroundStyle(Theme.brandAccent)
            }

            if !bar.topModels.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(bar.topModels.prefix(4), id: \.name) { m in
                        HStack(spacing: 6) {
                            Circle().fill(Theme.brandAccent.opacity(0.7)).frame(width: 4, height: 4)
                            Text(m.name)
                                .font(.system(size: 10, weight: .medium))
                                .foregroundStyle(primaryText)
                            Spacer()
                            Text("\(formatTokensCompact(Double(m.totalTokens))) tok")
                                .font(.codeMono(size: 9.5, weight: .medium))
                                .foregroundStyle(secondaryText)
                            Text("(\(formatTokensCompact(Double(m.inputTokens)))/\(formatTokensCompact(Double(m.outputTokens))))")
                                .font(.codeMono(size: 9, weight: .regular))
                                .foregroundStyle(tertiaryText)
                        }
                    }
                }
            }
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(backgroundFill)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(borderStroke, lineWidth: 0.5)
        )
        .shadow(color: Color.black.opacity(0.35), radius: 10, y: 4)
    }

    private func formatTokensCompact(_ n: Double) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", n / 1_000_000) }
        if n >= 1_000 { return String(format: "%.0fK", n / 1_000) }
        return String(format: "%.0f", n)
    }
}

private func prettyDate(_ ymd: String) -> String {
    let parser = DateFormatter()
    parser.dateFormat = "yyyy-MM-dd"
    parser.timeZone = TimeZone(identifier: "UTC")
    guard let date = parser.date(from: ymd) else { return ymd }
    let display = DateFormatter()
    display.dateFormat = "EEE MMM d"
    return display.string(from: date)
}

private struct MiniStat: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label)
                .font(.system(size: 9.5, weight: .medium))
                .foregroundStyle(.tertiary)
            Text(value)
                .font(.system(size: 11.5, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(.primary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct TrendBar: Identifiable {
    let id = UUID()
    let date: String
    let cost: Double
    let inputTokens: Double
    let outputTokens: Double
    let isToday: Bool
    let topModels: [DailyModelBreakdown]

    var tokens: Double { inputTokens + outputTokens }
}

private struct TrendStats {
    let totalThisWindow: Double
    let avgPerDay: Double
    let peak: TrendBar?
    let activeDays: Int
    let deltaPercent: Double?
    let yesterdayBar: TrendBar?
}

private func buildTrendBars(from days: [DailyHistoryEntry]) -> [TrendBar] {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    let formatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()
    let entryByDate = Dictionary(uniqueKeysWithValues: days.map { ($0.date, $0) })
    let today = calendar.startOfDay(for: Date())
    let todayKey = formatter.string(from: today)

    var bars: [TrendBar] = []
    for offset in (0..<trendDays).reversed() {
        guard let d = calendar.date(byAdding: .day, value: -offset, to: today) else { continue }
        let key = formatter.string(from: d)
        let entry = entryByDate[key]
        bars.append(TrendBar(
            date: key,
            cost: entry?.cost ?? 0,
            inputTokens: Double(entry?.inputTokens ?? 0),
            outputTokens: Double(entry?.outputTokens ?? 0),
            isToday: key == todayKey,
            topModels: entry?.topModels ?? []
        ))
    }
    return bars
}

private func computeTrendStats(bars: [TrendBar], allDays: [DailyHistoryEntry]) -> TrendStats {
    let total = bars.reduce(0.0) { $0 + $1.cost }
    let active = bars.filter { $0.cost > 0 }.count
    let avg = bars.isEmpty ? 0 : total / Double(bars.count)
    let peak = bars.filter { $0.cost > 0 }.max(by: { $0.cost < $1.cost })

    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    let formatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()
    let today = calendar.startOfDay(for: Date())
    let priorWindowStart = calendar.date(byAdding: .day, value: -(2 * trendDays - 1), to: today)
    let thisWindowStart = calendar.date(byAdding: .day, value: -(trendDays - 1), to: today)
    var deltaPercent: Double? = nil
    if let priorStart = priorWindowStart, let thisStart = thisWindowStart {
        let priorStartStr = formatter.string(from: priorStart)
        let thisStartStr = formatter.string(from: thisStart)
        let priorTotal = allDays
            .filter { $0.date >= priorStartStr && $0.date < thisStartStr }
            .reduce(0.0) { $0 + $1.cost }
        if priorTotal > 0 {
            deltaPercent = ((total - priorTotal) / priorTotal) * 100
        }
    }

    let yesterdayDate = calendar.date(byAdding: .day, value: -1, to: today)
    let yesterdayKey = yesterdayDate.map { formatter.string(from: $0) }
    let yesterdayBar = bars.first(where: { $0.date == yesterdayKey })

    return TrendStats(
        totalThisWindow: total,
        avgPerDay: avg,
        peak: peak,
        activeDays: active,
        deltaPercent: deltaPercent,
        yesterdayBar: yesterdayBar
    )
}

// MARK: - Forecast

private struct ForecastInsight: View {
    let days: [DailyHistoryEntry]

    var body: some View {
        let stats = computeForecast(days: days)
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Month-to-date")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.tertiary)
                    Text(stats.mtd.asCurrency())
                        .font(.system(size: 22, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(Theme.brandAccent)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text("On pace for")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.tertiary)
                    Text(stats.projection.asCurrency())
                        .font(.system(size: 16, weight: .semibold))
                        .monospacedDigit()
                }
            }

            HStack(spacing: 14) {
                ForecastStat(label: "Avg/day (this wk)", value: stats.weekAvg.asCompactCurrency())
                ForecastStat(label: "Yesterday", value: stats.yesterday.asCompactCurrency())
                ForecastStat(label: "Last 7d", value: stats.weekTotal.asCompactCurrency())
            }

            if let prevTotal = stats.previousMonthTotal {
                HStack(spacing: 4) {
                    Image(systemName: stats.projection > prevTotal ? "arrow.up.right" : "arrow.down.right")
                        .font(.system(size: 9, weight: .bold))
                    Text(comparisonText(projection: stats.projection, previous: prevTotal))
                        .font(.system(size: 10.5))
                        .monospacedDigit()
                }
                .foregroundStyle(Theme.brandAccent)
            }
        }
    }

    private func comparisonText(projection: Double, previous: Double) -> String {
        guard previous > 0 else { return "no prior month" }
        let diff = ((projection - previous) / previous) * 100
        let sign = diff >= 0 ? "+" : ""
        return "\(sign)\(String(format: "%.0f", diff))% vs last month ($\(String(format: "%.0f", previous)))"
    }
}

private struct ForecastStat: View {
    let label: String
    let value: String
    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label)
                .font(.system(size: 9.5, weight: .medium))
                .foregroundStyle(.tertiary)
            Text(value)
                .font(.system(size: 12, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(.primary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ForecastStats {
    let mtd: Double
    let projection: Double
    let weekAvg: Double
    let weekTotal: Double
    let yesterday: Double
    let previousMonthTotal: Double?
}

private func computeForecast(days: [DailyHistoryEntry]) -> ForecastStats {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    let formatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()
    let now = Date()
    let comps = calendar.dateComponents([.year, .month, .day], from: now)
    guard
        let firstOfMonth = calendar.date(from: DateComponents(year: comps.year, month: comps.month, day: 1)),
        let rangeOfMonth = calendar.range(of: .day, in: .month, for: firstOfMonth)
    else {
        return ForecastStats(mtd: 0, projection: 0, weekAvg: 0, weekTotal: 0, yesterday: 0, previousMonthTotal: nil)
    }

    let firstStr = formatter.string(from: firstOfMonth)
    let totalDays = rangeOfMonth.count
    let dayOfMonth = comps.day ?? 1

    let mtdEntries = days.filter { $0.date >= firstStr }
    let mtd = mtdEntries.reduce(0.0) { $0 + $1.cost }
    let avgPerElapsedDay = dayOfMonth > 0 ? mtd / Double(dayOfMonth) : 0
    let projection = avgPerElapsedDay * Double(totalDays)

    let weekStart = calendar.date(byAdding: .day, value: -6, to: calendar.startOfDay(for: now))
    let weekStartStr = weekStart.map { formatter.string(from: $0) } ?? ""
    let weekEntries = days.filter { $0.date >= weekStartStr }
    let weekTotal = weekEntries.reduce(0.0) { $0 + $1.cost }
    let weekAvg = weekTotal / 7.0

    let yesterdayDate = calendar.date(byAdding: .day, value: -1, to: calendar.startOfDay(for: now))
    let yesterdayStr = yesterdayDate.map { formatter.string(from: $0) } ?? ""
    let yesterday = days.first(where: { $0.date == yesterdayStr })?.cost ?? 0

    var previousMonthTotal: Double? = nil
    if
        let prevMonthDate = calendar.date(byAdding: .month, value: -1, to: firstOfMonth),
        let prevRange = calendar.range(of: .day, in: .month, for: prevMonthDate),
        let prevFirst = calendar.date(from: DateComponents(year: calendar.component(.year, from: prevMonthDate), month: calendar.component(.month, from: prevMonthDate), day: 1)),
        let prevLast = calendar.date(byAdding: .day, value: prevRange.count - 1, to: prevFirst)
    {
        let prevFirstStr = formatter.string(from: prevFirst)
        let prevLastStr = formatter.string(from: prevLast)
        let prevEntries = days.filter { $0.date >= prevFirstStr && $0.date <= prevLastStr }
        if !prevEntries.isEmpty {
            previousMonthTotal = prevEntries.reduce(0.0) { $0 + $1.cost }
        }
    }

    return ForecastStats(
        mtd: mtd,
        projection: projection,
        weekAvg: weekAvg,
        weekTotal: weekTotal,
        yesterday: yesterday,
        previousMonthTotal: previousMonthTotal
    )
}

// MARK: - Pulse

private struct PulseInsight: View {
    let payload: MenubarPayload

    var body: some View {
        HStack(spacing: 10) {
            PulseTile(label: "Cache hit", value: cacheHitText, color: Theme.brandAccent)
            PulseTile(label: "1-shot", value: oneShotText, color: oneShotColor)
            PulseTile(
                label: "Cost / session",
                value: payload.current.sessions > 0
                    ? (payload.current.cost / Double(payload.current.sessions)).asCompactCurrency()
                    : "—",
                color: .secondary
            )
        }
    }

    private var cacheHitText: String {
        let v = payload.current.cacheHitPercent
        return v <= 0 ? "—" : String(format: "%.0f%%", v)
    }

    private var oneShotText: String {
        guard let r = payload.current.oneShotRate else { return "—" }
        return String(format: "%.0f%%", r * 100)
    }

    private var oneShotColor: Color {
        payload.current.oneShotRate == nil ? .secondary : Theme.brandAccent
    }
}

private struct PulseTile: View {
    let label: String
    let value: String
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(.tertiary)
            Text(value)
                .font(.system(size: 18, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(color)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(Color.secondary.opacity(0.06))
        )
    }
}

/// Connects optimize findings directly to plan utilization: "address N findings to recover X
/// tokens" framed as the same currency the rest of the Plan view uses (effective tokens).
/// Scoped to whatever period the user selected (today / 7d / 30d / month / all).
private struct OptimizeSavingsBadge: View {
    let payload: MenubarPayload

    var body: some View {
        let findingCount = payload.optimize.findingCount
        let savingsUSD = payload.optimize.savingsUSD
        if findingCount == 0 || savingsUSD <= 0 {
            EmptyView()
        } else {
            Button { openOptimize() } label: {
                HStack(spacing: 6) {
                    Image(systemName: "lightbulb.fill")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Theme.brandAccent)
                    Text(captionText(findingCount: findingCount, savingsUSD: savingsUSD))
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.primary)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(Theme.brandAccent.opacity(0.10))
                )
            }
            .buttonStyle(.plain)
            .padding(.top, 2)
        }
    }

    private func captionText(findingCount: Int, savingsUSD: Double) -> String {
        let tokens = savingsUSD / 9.0 * 1_000_000  // ~$9/M effective tokens (Sonnet-weighted approx)
        let tokensLabel = formatTokens(tokens)
        let plural = findingCount == 1 ? "finding" : "findings"
        return "Save ~\(savingsUSD.asCompactCurrency()) / ~\(tokensLabel) tokens · \(findingCount) \(plural)"
    }

    private func openOptimize() {
        TerminalLauncher.open(subcommand: ["optimize"])
    }

    private func formatTokens(_ n: Double) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", n / 1_000_000) }
        if n >= 1_000 { return String(format: "%.0fK", n / 1_000) }
        return String(format: "%.0f", n)
    }
}

// MARK: - Stats

private struct StatsInsight: View {
    let payload: MenubarPayload

    var body: some View {
        let stats = computeAllStats(payload: payload)

        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 14) {
                VStack(alignment: .leading, spacing: 8) {
                    StatRow(label: "Favorite model", value: stats.favoriteModel)
                    StatRow(label: "Active days (month)", value: stats.activeDaysFraction)
                    StatRow(label: "Most active day", value: stats.mostActiveDay)
                    StatRow(label: "Peak day spend", value: stats.peakDaySpend)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                VStack(alignment: .leading, spacing: 8) {
                    StatRow(label: "Sessions today", value: "\(payload.current.sessions)")
                    StatRow(label: "Calls today", value: payload.current.calls.asThousandsSeparated())
                    StatRow(label: "Current streak", value: stats.currentStreak)
                    StatRow(label: "Longest streak", value: stats.longestStreak)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            if let lifetime = stats.lifetimeTotal {
                Divider().opacity(0.5)
                HStack {
                    Text("Tracked spend (last \(stats.historyDayCount) days)")
                        .font(.system(size: 10.5, weight: .medium))
                        .foregroundStyle(.tertiary)
                    Spacer()
                    Text(lifetime.asCurrency())
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(Theme.brandAccent)
                }
            }
        }
    }
}

private struct StatRow: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label)
                .font(.system(size: 9.5, weight: .medium))
                .foregroundStyle(.tertiary)
            Text(value)
                .font(.system(size: 12, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(.primary)
        }
    }
}

private struct AllStats {
    let favoriteModel: String
    let activeDaysFraction: String
    let mostActiveDay: String
    let peakDaySpend: String
    let currentStreak: String
    let longestStreak: String
    let lifetimeTotal: Double?
    let historyDayCount: Int
}

private func computeAllStats(payload: MenubarPayload) -> AllStats {
    let history = payload.history.daily
    let favoriteModel = payload.current.topModels.first?.name ?? "—"

    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    let formatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()
    let displayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()

    let now = Date()
    let today = calendar.startOfDay(for: now)
    let comps = calendar.dateComponents([.year, .month, .day], from: now)

    var activeDaysFraction = "—"
    if
        let firstOfMonth = calendar.date(from: DateComponents(year: comps.year, month: comps.month, day: 1)),
        let rangeOfMonth = calendar.range(of: .day, in: .month, for: firstOfMonth)
    {
        let firstStr = formatter.string(from: firstOfMonth)
        let mtdActive = history.filter { $0.date >= firstStr && $0.cost > 0 }.count
        activeDaysFraction = "\(mtdActive)/\(rangeOfMonth.count)"
    }

    let peak = history.max(by: { $0.cost < $1.cost })
    let mostActiveDay: String
    let peakDaySpend: String
    if let peak, peak.cost > 0, let date = formatter.date(from: peak.date) {
        mostActiveDay = displayFormatter.string(from: date)
        peakDaySpend = peak.cost.asCompactCurrency()
    } else {
        mostActiveDay = "—"
        peakDaySpend = "—"
    }

    let costByDate = Dictionary(uniqueKeysWithValues: history.map { ($0.date, $0.cost) })

    var currentStreak = 0
    for offset in 0..<400 {
        guard let d = calendar.date(byAdding: .day, value: -offset, to: today) else { break }
        let key = formatter.string(from: d)
        if (costByDate[key] ?? 0) > 0 { currentStreak += 1 } else { break }
    }

    var longestStreak = 0
    var running = 0
    let sortedDates = history.map(\.date).sorted()
    for date in sortedDates {
        if (costByDate[date] ?? 0) > 0 {
            running += 1
            longestStreak = max(longestStreak, running)
        } else {
            running = 0
        }
    }

    let lifetimeTotal: Double? = history.isEmpty ? nil : history.reduce(0.0) { $0 + $1.cost }

    return AllStats(
        favoriteModel: favoriteModel,
        activeDaysFraction: activeDaysFraction,
        mostActiveDay: mostActiveDay,
        peakDaySpend: peakDaySpend,
        currentStreak: currentStreak == 0 ? "—" : "\(currentStreak) days",
        longestStreak: longestStreak == 0 ? "—" : "\(longestStreak) days",
        lifetimeTotal: lifetimeTotal,
        historyDayCount: history.count
    )
}

// MARK: - Plan (subscription)

private struct PlanInsight: View {
    @Environment(AppStore.self) private var store
    let usage: SubscriptionUsage?

    var body: some View {
        Group {
            switch store.subscriptionLoadState {
            case .idle:
                PlanIdleView()
            case .loading:
                PlanLoadingView()
            case .noCredentials:
                PlanNoCredentialsView()
            case .sessionExpired:
                PlanSessionExpiredView()
            case .failed:
                PlanFailedView(error: store.subscriptionError)
            case .loaded:
                if let usage {
                    loadedBody(usage: usage)
                } else {
                    PlanNoCredentialsView()
                }
            }
        }
        .task {
            if store.subscriptionLoadState == .idle {
                await store.refreshSubscription()
            }
        }
    }

    @ViewBuilder
    private func loadedBody(usage: SubscriptionUsage) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                HStack(spacing: 6) {
                    Text(usage.planDisplayName)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.brandAccent)
                    if usage.isLow {
                        Text("LOW")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 2)
                            .background(Theme.brandAccent)
                            .clipShape(RoundedRectangle(cornerRadius: 3))
                    }
                }
                Spacer()
                if let resets = usage.resetsAt {
                    Text("Resets \(relativeReset(resets))")
                        .font(.system(size: 10.5))
                        .foregroundStyle(.secondary)
                }
            }

            VStack(spacing: 8) {
                CreditUsageRow(usage: usage)
            }

            OptimizeSavingsBadge(payload: store.payload)
        }
    }
}

// MARK: - Plan empty/loading/failure states

private struct PlanIdleView: View {
    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "person.crop.circle.dashed")
                .font(.system(size: 22))
                .foregroundStyle(.tertiary)
            Text("Loading your plan...")
                .font(.system(size: 11.5, weight: .medium))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 16)
    }
}

private struct PlanLoadingView: View {
    var body: some View {
        VStack(spacing: 8) {
            ProgressView().scaleEffect(0.8)
            Text("Fetching credit info...")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 16)
    }
}

private struct PlanNoCredentialsView: View {
    @Environment(AppStore.self) private var store
    @State private var showManualFallback = false

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "key.slash")
                .font(.system(size: 20))
                .foregroundStyle(.tertiary)
            Text("Sign in to Auggie")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.primary)
            if showManualFallback {
                Text("Terminal.app isn't available. Open your terminal and run `auggie login`.")
                    .font(.system(size: 10.5))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 280)
            } else {
                Text("Run `auggie login` to connect your account.")
                    .font(.system(size: 10.5))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 260)
            }
            HStack(spacing: 8) {
                Button("Sign In") {
                    if !TerminalLauncher.openAuggieLogin() { showManualFallback = true }
                }
                .controlSize(.small)
                .buttonStyle(.borderedProminent)
                .tint(Theme.brandAccent)
                Button("Retry") {
                    Task { await store.refreshSubscription() }
                }
                .controlSize(.small)
                .buttonStyle(.bordered)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
    }
}

private struct PlanSessionExpiredView: View {
    @Environment(AppStore.self) private var store
    @State private var showManualFallback = false

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "clock.badge.exclamationmark")
                .font(.system(size: 20))
                .foregroundStyle(Theme.brandAccent)
            Text("Session expired")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.primary)
            if showManualFallback {
                Text("Terminal.app isn't available. Open your terminal and run `auggie login`.")
                    .font(.system(size: 10.5))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 280)
            } else {
                Text("Run `auggie login` and reopen.")
                    .font(.system(size: 10.5))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 260)
            }
            HStack(spacing: 8) {
                Button("Sign In") {
                    if !TerminalLauncher.openAuggieLogin() { showManualFallback = true }
                }
                .controlSize(.small)
                .buttonStyle(.borderedProminent)
                .tint(Theme.brandAccent)
                Button("Retry") {
                    Task { await store.refreshSubscription() }
                }
                .controlSize(.small)
                .buttonStyle(.bordered)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
    }
}

private struct PlanFailedView: View {
    @Environment(AppStore.self) private var store
    let error: String?
    @State private var showManualFallback = false

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 18))
                .foregroundStyle(Theme.brandAccent)
            Text("Couldn't load plan data")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.primary)
            if showManualFallback {
                Text("Terminal.app isn't available. Open your terminal and run `auggie login`.")
                    .font(.system(size: 10.5))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 280)
            } else if let error {
                Text(error)
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 280)
                    .lineLimit(3)
            }
            HStack(spacing: 8) {
                Button("Reconnect") {
                    if !TerminalLauncher.openAuggieLogin() { showManualFallback = true }
                }
                .controlSize(.small)
                .buttonStyle(.borderedProminent)
                .tint(Theme.brandAccent)
                Button("Retry") {
                    Task { await store.refreshSubscription() }
                }
                .controlSize(.small)
                .buttonStyle(.bordered)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
    }
}

private struct CreditUsageRow: View {
    let usage: SubscriptionUsage

    var body: some View {
        VStack(spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text(usageLabel)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
                Spacer()
                Text(String(format: "%.0f%%", usage.usagePercent))
                    .font(.codeMono(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.brandAccent)
                    .monospacedDigit()
            }
            CreditBar(fraction: min(max(usage.usagePercent / 100, 0), 1))
                .frame(height: 6)
        }
    }

    private var usageLabel: String {
        let used = formatUnits(usage.usedUnits)
        let total = formatUnits(usage.totalUnits)
        return "\(used) / \(total) \(usage.unitLabel)"
    }

    private func formatUnits(_ n: Double) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", n / 1_000_000) }
        if n >= 1_000 { return String(format: "%.0fK", n / 1_000) }
        return String(format: "%.0f", n)
    }
}

private struct CreditBar: View {
    let fraction: Double

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 3).fill(Color.secondary.opacity(0.12))
                RoundedRectangle(cornerRadius: 3)
                    .fill(Theme.brandAccent)
                    .frame(width: max(0, geo.size.width * CGFloat(fraction)))
            }
        }
    }
}

private func relativeReset(_ date: Date) -> String {
    let interval = date.timeIntervalSinceNow
    if interval <= 0 { return "now" }
    let hours = interval / 3600
    if hours < 1 {
        let minutes = Int(ceil(interval / 60))
        return "in \(minutes)m"
    }
    if hours < 24 { return "in \(Int(ceil(hours)))h" }
    let days = Int(ceil(hours / 24))
    return "in \(days)d"
}

