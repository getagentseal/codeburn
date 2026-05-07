import SwiftUI

private let trendDays = 19
private let trendBarWidth: CGFloat = 13
private let trendBarGap: CGFloat = 4
private let trendChartHeight: CGFloat = 90

// Cached formatters and a calendar to avoid allocating fresh ones on every
// SwiftUI body re-eval. Hover scrubbing on the trend bars triggers many
// re-evals per second; a fresh DateFormatter / Calendar each time was a
// measurable hot spot.
private let yyyymmdd: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd"
    f.timeZone = .current
    return f
}()

private let prettyDayFormat: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "EEE MMM d"
    return f
}()

private let mmmDayFormat: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "MMM d"
    f.timeZone = .current
    return f
}()

private let gregorianCalendar: Calendar = {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = .current
    return c
}()

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
        .onChange(of: store.selectedProvider) { _, _ in ensureValidSelection() }
    }

    private var bindingMode: Binding<InsightMode> {
        Binding(get: { store.selectedInsight }, set: { store.selectedInsight = $0 })
    }

    private var visibleModes: [InsightMode] {
        // Plan sources from a provider's OAuth usage endpoint. Currently
        // implemented for Claude (Anthropic) and Codex (ChatGPT). Hidden on
        // All / Cursor / Droid / Gemini / Copilot until those providers ship
        // their own quota data sources.
        InsightMode.allCases.filter { mode in
            if mode == .plan {
                return store.selectedProvider == .claude || store.selectedProvider == .codex
            }
            return true
        }
    }

    private func ensureValidSelection() {
        if !visibleModes.contains(store.selectedInsight) {
            store.selectedInsight = visibleModes.first ?? .trend
        }
    }

    @ViewBuilder
    private var content: some View {
        switch store.selectedInsight {
        case .plan:
            if store.selectedProvider == .codex {
                CodexPlanInsight()
            } else {
                PlanInsight(usage: store.subscription)
            }
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
    guard let date = yyyymmdd.date(from: ymd) else { return ymd }
    return prettyDayFormat.string(from: date)
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
    var id: String { date }
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
    let calendar = gregorianCalendar
    let formatter = yyyymmdd
    let entryByDate = Dictionary(days.map { ($0.date, $0) }, uniquingKeysWith: { _, new in new })
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

    let calendar = gregorianCalendar
    let formatter = yyyymmdd
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
        return "\(sign)\(String(format: "%.0f", diff))% vs last month (\(previous.asCompactCurrency()))"
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
    let calendar = gregorianCalendar
    let formatter = yyyymmdd
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

@MainActor private func computeAllStats(payload: MenubarPayload) -> AllStats {
    let history = payload.history.daily
    let favoriteModel = payload.current.topModels.first?.name ?? "—"

    let calendar = gregorianCalendar
    let formatter = yyyymmdd
    let displayFormatter = mmmDayFormat

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

    let costByDate = Dictionary(history.map { ($0.date, $0.cost) }, uniquingKeysWith: +)

    var currentStreak = 0
    for offset in 0..<400 {
        guard let d = calendar.date(byAdding: .day, value: -offset, to: today) else { break }
        let key = formatter.string(from: d)
        if (costByDate[key] ?? 0) > 0 { currentStreak += 1 } else { break }
    }

    var longestStreak = 0
    var running = 0
    if let firstDate = history.map(\.date).min(),
       let lastDate = history.map(\.date).max(),
       let start = formatter.date(from: firstDate),
       let end = formatter.date(from: lastDate) {
        var cursor = start
        while cursor <= end {
            let key = formatter.string(from: cursor)
            if (costByDate[key] ?? 0) > 0 {
                running += 1
                longestStreak = max(longestStreak, running)
            } else {
                running = 0
            }
            guard let next = calendar.date(byAdding: .day, value: 1, to: cursor) else { break }
            cursor = next
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

    private static let fiveHourSeconds: TimeInterval = 5 * 3600
    private static let sevenDaySeconds: TimeInterval = 7 * 86400
    private static let freshWindowThreshold: Double = 0.05

    @State private var projections: [String: WindowProjection] = [:]

    var body: some View {
        Group {
            switch store.subscriptionLoadState {
            case .notBootstrapped:
                PlanConnectView { Task { await store.bootstrapSubscription() } }
            case .bootstrapping:
                PlanLoadingView()
            case .loading:
                if let usage {
                    loadedBody(usage: usage)
                } else {
                    PlanLoadingView()
                }
            case .noCredentials:
                PlanNoCredentialsView()
            case .failed:
                PlanFailedView(error: store.subscriptionError)
            case .transientFailure:
                if let usage {
                    loadedBody(usage: usage)
                } else {
                    PlanFailedView(error: store.subscriptionError ?? "Anthropic temporarily unreachable — retrying.")
                }
            case let .terminalFailure(reason):
                PlanReconnectView(reason: reason) { Task { await store.bootstrapSubscription() } }
            case .loaded:
                if let usage {
                    loadedBody(usage: usage)
                } else {
                    PlanLoadingView()
                }
            }
        }
    }

    @ViewBuilder
    private func loadedBody(usage: SubscriptionUsage) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(usage.tier.displayName)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.brandAccent)
                Spacer()
                if let resets = headlineReset(usage: usage) {
                    Text("Resets \(resets)")
                        .font(.system(size: 10.5))
                        .foregroundStyle(.secondary)
                }
            }

            VStack(spacing: 8) {
                if let p = usage.fiveHourPercent {
                    UtilizationRow(label: "5-hour window", percent: p, resetsAt: usage.fiveHourResetsAt, projection: projections["five_hour"])
                }
                if let p = usage.sevenDayPercent {
                    UtilizationRow(label: "7-day total", percent: p, resetsAt: usage.sevenDayResetsAt, projection: projections["seven_day"])
                }
                if let p = usage.sevenDayOpusPercent {
                    UtilizationRow(label: "7-day Opus", percent: p, resetsAt: usage.sevenDayOpusResetsAt, projection: projections["seven_day_opus"])
                }
                if let p = usage.sevenDaySonnetPercent {
                    UtilizationRow(label: "7-day Sonnet", percent: p, resetsAt: usage.sevenDaySonnetResetsAt, projection: projections["seven_day_sonnet"])
                }
            }

            OptimizeSavingsBadge(payload: store.payload)
        }
        .task(id: usage.fetchedAt) {
            await recomputeProjections(usage: usage)
        }
    }

    private func recomputeProjections(usage: SubscriptionUsage) async {
        var result: [String: WindowProjection] = [:]
        let inputs: [(String, Double?, Date?, TimeInterval)] = [
            ("five_hour", usage.fiveHourPercent, usage.fiveHourResetsAt, Self.fiveHourSeconds),
            ("seven_day", usage.sevenDayPercent, usage.sevenDayResetsAt, Self.sevenDaySeconds),
            ("seven_day_opus", usage.sevenDayOpusPercent, usage.sevenDayOpusResetsAt, Self.sevenDaySeconds),
            ("seven_day_sonnet", usage.sevenDaySonnetPercent, usage.sevenDaySonnetResetsAt, Self.sevenDaySeconds),
        ]
        for (key, percent, resetsAt, windowSeconds) in inputs {
            if let projection = await project(key: key, percent: percent, resetsAt: resetsAt, windowSeconds: windowSeconds) {
                result[key] = projection
            }
        }
        projections = result
    }

    /// Linear extrapolation when window is past the freshness threshold; otherwise falls back to
    /// the prior cycle's final percent from the snapshot store.
    private func project(key: String, percent: Double?, resetsAt: Date?, windowSeconds: TimeInterval) async -> WindowProjection? {
        guard let percent, let resetsAt else { return nil }
        let windowStart = resetsAt.addingTimeInterval(-windowSeconds)
        let elapsed = Date().timeIntervalSince(windowStart)
        let elapsedFraction = elapsed / windowSeconds

        if elapsedFraction > Self.freshWindowThreshold, percent > 0 {
            let projectedPercent = percent / elapsedFraction
            var hitDate: Date? = nil
            if projectedPercent > 100, percent < 100 {
                let remainingPercent = 100 - percent
                let percentPerSecond = percent / elapsed
                if percentPerSecond > 0 {
                    hitDate = Date().addingTimeInterval(remainingPercent / percentPerSecond)
                }
            }
            return WindowProjection(percent: projectedPercent, willOverflow: projectedPercent > 100, hitsLimitAt: hitDate, source: .linear)
        }

        // Window too fresh OR percent exactly zero -- use the prior cycle's final reading.
        if let prior = await SubscriptionSnapshotStore.previousWindowFinal(windowKey: key, currentResetsAt: resetsAt) {
            return WindowProjection(percent: prior, willOverflow: prior > 100, hitsLimitAt: nil, source: .historicalBaseline)
        }
        return nil
    }

    private func headlineReset(usage: SubscriptionUsage) -> String? {
        let candidates = [
            usage.fiveHourResetsAt,
            usage.sevenDayResetsAt,
            usage.sevenDayOpusResetsAt,
            usage.sevenDaySonnetResetsAt,
        ].compactMap { $0 }
        guard let earliest = candidates.min() else { return nil }
        return relativeReset(earliest)
    }
}

// MARK: - Plan empty/loading/failure states

private struct PlanLoadingView: View {
    var body: some View {
        VStack(spacing: 8) {
            ProgressView().scaleEffect(0.8)
            Text("Reading Claude credentials...")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 16)
    }
}

private struct PlanNoCredentialsView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "key.slash")
                .font(.system(size: 24))
                .foregroundStyle(.tertiary)
            Text("No Claude credentials found")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.primary)
            Text("Sign in with Claude Code first: open `claude` in your terminal and type `/login`. Then click Try Again.")
                .font(.system(size: 10.5))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 280)
            Button("Try Again") {
                Task { await store.bootstrapSubscription() }
            }
            .controlSize(.small)
            .buttonStyle(.borderedProminent)
            .tint(Theme.brandAccent)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 16)
    }
}

private struct PlanFailedView: View {
    @Environment(AppStore.self) private var store
    let error: String?

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 18))
                .foregroundStyle(Theme.brandAccent)
            Text("Couldn't load plan data")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.primary)
            if let error {
                Text(error)
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 280)
                    .lineLimit(3)
            }
            Button("Retry") {
                Task { await store.refreshSubscription() }
            }
            .controlSize(.small)
            .buttonStyle(.borderedProminent)
            .tint(Theme.brandAccent)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
    }
}

/// Shown the very first time a user opens the Plan tab. Clicking Connect is the
/// only path to triggering the macOS keychain prompt for Claude Code credentials —
/// the menubar app does not touch the keychain at startup.
private struct PlanConnectView: View {
    let onConnect: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "link.circle")
                .font(.system(size: 26))
                .foregroundStyle(Theme.brandAccent)
            Text("Connect Claude subscription")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.primary)
            Text("CodeBurn will read your Claude Code credentials once. macOS will ask permission. After that, the live quota bar shows next to the Claude tab and updates automatically.")
                .font(.system(size: 10.5))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 280)
            Button("Connect", action: onConnect)
                .controlSize(.small)
                .buttonStyle(.borderedProminent)
                .tint(Theme.brandAccent)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 18)
    }
}

/// Shown when the refresh token has been invalidated (typically because the user
/// re-authenticated on another device). Clicking the button re-runs bootstrap,
/// which reads Claude's credentials source again and writes a fresh copy to our
/// own keychain item.
private struct PlanReconnectView: View {
    let reason: String?
    let onReconnect: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "arrow.triangle.2.circlepath.circle")
                .font(.system(size: 24))
                .foregroundStyle(.red)
            Text("Reconnect Claude")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.primary)
            Text(reason ?? "Your Claude session has expired. Open Claude Code in your terminal and type `/login`, then click Reconnect.")
                .font(.system(size: 10.5))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 280)
                .lineLimit(3)
            Button("Reconnect", action: onReconnect)
                .controlSize(.small)
                .buttonStyle(.borderedProminent)
                .tint(.red)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 16)
    }
}

/// Plan tab for Codex. Mirrors PlanInsight's layout but reads from
/// store.codexUsage / store.codexLoadState. We deliberately skip the
/// "On pace at reset" projection here — that math is fed by local
/// per-message Claude spend extrapolated against the API quota windows;
/// our local Codex spend isn't an apples-to-apples signal for the
/// ChatGPT-subscription rate windows reported by wham/usage. Add when
/// we wire a comparable extrapolator.
private struct CodexPlanInsight: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        Group {
            switch store.codexLoadState {
            case .notBootstrapped:
                PlanConnectView { Task { await store.bootstrapCodex() } }
            case .bootstrapping:
                PlanLoadingView()
            case .loading:
                if let usage = store.codexUsage {
                    loadedBody(usage: usage)
                } else {
                    PlanLoadingView()
                }
            case .noCredentials:
                PlanNoCredentialsView()
            case .failed:
                PlanFailedView(error: store.codexError)
            case .transientFailure:
                if let usage = store.codexUsage {
                    loadedBody(usage: usage)
                } else {
                    PlanFailedView(error: store.codexError ?? "ChatGPT temporarily unreachable — retrying.")
                }
            case let .terminalFailure(reason):
                PlanReconnectView(reason: reason) { Task { await store.bootstrapCodex() } }
            case .loaded:
                if let usage = store.codexUsage {
                    loadedBody(usage: usage)
                } else {
                    PlanLoadingView()
                }
            }
        }
    }

    @ViewBuilder
    private func loadedBody(usage: CodexUsage) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(usage.plan.displayName)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.primary)
                Spacer()
                if let resetsAt = (usage.primary ?? usage.secondary)?.resetsAt {
                    Text("Resets \(relativeReset(resetsAt))")
                        .font(.system(size: 10.5))
                        .foregroundStyle(.secondary)
                }
            }
            if let primary = usage.primary {
                UtilizationRow(
                    label: "\(primary.windowLabel) window",
                    percent: primary.usedPercent,
                    resetsAt: primary.resetsAt,
                    projection: nil
                )
            }
            if let secondary = usage.secondary {
                UtilizationRow(
                    label: "\(secondary.windowLabel) window",
                    percent: secondary.usedPercent,
                    resetsAt: secondary.resetsAt,
                    projection: nil
                )
            }
            // Surface non-zero per-model rate limits (Codex Spark, etc.) so
            // power users see them; idle ones stay collapsed.
            ForEach(Array(usage.additionalLimits.enumerated()), id: \.offset) { _, limit in
                if let p = limit.primary, p.usedPercent > 0 {
                    UtilizationRow(
                        label: "\(limit.name) · \(p.windowLabel)",
                        percent: p.usedPercent,
                        resetsAt: p.resetsAt,
                        projection: nil
                    )
                }
                if let s = limit.secondary, s.usedPercent > 0 {
                    UtilizationRow(
                        label: "\(limit.name) · \(s.windowLabel)",
                        percent: s.usedPercent,
                        resetsAt: s.resetsAt,
                        projection: nil
                    )
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 4)
        .padding(.bottom, 8)
    }

    private func relativeReset(_ date: Date) -> String {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        return f.localizedString(for: date, relativeTo: Date())
    }
}

private struct WindowProjection {
    enum Source { case linear, historicalBaseline }
    let percent: Double
    let willOverflow: Bool
    let hitsLimitAt: Date?
    let source: Source
}

private struct UtilizationRow: View {
    let label: String
    /// API returns utilization as 0..100 (a percentage value, not a fraction).
    let percent: Double
    let resetsAt: Date?
    let projection: WindowProjection?

    var body: some View {
        VStack(spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text(label)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
                Spacer()
                Text(String(format: "%.0f%%", clampedPercent))
                    .font(.codeMono(size: 11, weight: .semibold))
                    .foregroundStyle(barColor)
                    .monospacedDigit()
            }
            UtilizationBar(
                fraction: clampedPercent / 100,
                color: barColor,
                markerFraction: projection.map { min(max($0.percent, 0), 100) / 100 }
            )
            .frame(height: 6)
            if let projection {
                ProjectionCaption(projection: projection)
            }
        }
    }

    private var clampedPercent: Double { min(max(percent, 0), 100) }

    /// Single-color brand palette decision (see session notes): the number is the signal, not
    /// the color. Keeping this as a computed property so a future threshold-based palette
    /// reintroduction stays scoped to one place.
    private var barColor: Color { Theme.brandAccent }
}

private struct ProjectionCaption: View {
    let projection: WindowProjection

    var body: some View {
        HStack(spacing: 3) {
            if projection.willOverflow {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundStyle(Theme.brandAccent)
            } else {
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundStyle(.tertiary)
            }
            Text(captionText)
                .font(.system(size: 9.5, weight: .medium))
                .foregroundStyle(projection.willOverflow
                    ? AnyShapeStyle(Theme.brandAccent)
                    : AnyShapeStyle(.tertiary))
            Spacer()
        }
    }

    private var captionText: String {
        let projected = String(format: "%.0f%%", projection.percent)
        switch projection.source {
        case .linear:
            if projection.willOverflow, let hit = projection.hitsLimitAt {
                return "On pace: \(projected) at reset · hits 100% \(relativeReset(hit))"
            }
            return "On pace: \(projected) at reset"
        case .historicalBaseline:
            return "Based on last cycle: \(projected)"
        }
    }
}

private struct UtilizationBar: View {
    /// 0..1 fraction of the bar to fill.
    let fraction: Double
    let color: Color
    /// Optional 0..1 marker position for projected utilization at reset.
    let markerFraction: Double?

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 3).fill(Color.secondary.opacity(0.12))
                RoundedRectangle(cornerRadius: 3)
                    .fill(color)
                    .frame(width: max(0, geo.size.width * CGFloat(fraction)))
                if let m = markerFraction {
                    Rectangle()
                        .fill(Color.primary.opacity(0.55))
                        .frame(width: 1.5)
                        .offset(x: max(0, geo.size.width * CGFloat(m)) - 0.75)
                }
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

