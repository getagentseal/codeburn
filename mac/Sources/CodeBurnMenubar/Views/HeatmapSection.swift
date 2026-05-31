import SwiftUI

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
        case .trend: TrendInsight(history: store.payload.history, period: store.trendPeriod)
        case .forecast: ForecastInsight(days: store.payload.history.daily)
        case .pulse: PulseInsight(payload: store.payload)
        case .stats: StatsInsight(payload: store.payload, period: store.selectedPeriod)
        case .optimize: OptimizeInsight(payload: store.payload)
        }
    }
}

// MARK: - Pill Switcher

private struct InsightPillSwitcher: View {
    @Binding var selected: InsightMode
    let visibleModes: [InsightMode]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(visibleModes) { mode in
                    Button {
                        selected = mode
                    } label: {
                        Text(mode.rawValue)
                            .font(.system(size: 11, weight: .medium))
                            .fixedSize()
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
}

// MARK: - Trend (period-aware bar chart with peak + average)

private struct TrendInsight: View {
    let history: HistoryBlock
    let period: Period

    private var descriptor: TrendDescriptor {
        let calendar = gregorianCalendar
        switch period {
        case .today:
            return TrendDescriptor(
                cadence: .intraday4Hour,
                windowLabel: "Today",
                comparisonLabel: "prior day",
                averageLabel: "Avg/4h",
                peakLabel: "Peak slot",
                latestLabel: "Current 4h",
                comparisonDaySpan: 1,
                latestMode: .current,
                peakJoiner: "in"
            )
        case .sevenDays:
            return TrendDescriptor(
                cadence: .daily(7),
                windowLabel: "Last 7 days",
                comparisonLabel: "prior 7d",
                averageLabel: "Avg/day",
                peakLabel: "Peak day",
                latestLabel: "Yesterday",
                comparisonDaySpan: 7,
                latestMode: .previousDay,
                peakJoiner: "on"
            )
        case .thirtyDays:
            return TrendDescriptor(
                cadence: .daily(30),
                windowLabel: "Last 30 days",
                comparisonLabel: "prior 30d",
                averageLabel: "Avg/day",
                peakLabel: "Peak day",
                latestLabel: "Yesterday",
                comparisonDaySpan: 30,
                latestMode: .previousDay,
                peakJoiner: "on"
            )
        case .month:
            let daysElapsed = max(calendar.component(.day, from: Date()), 1)
            return TrendDescriptor(
                cadence: .daily(daysElapsed),
                windowLabel: "Month to date",
                comparisonLabel: "prior \(daysElapsed)d",
                averageLabel: "Avg/day",
                peakLabel: "Peak day",
                latestLabel: "Yesterday",
                comparisonDaySpan: daysElapsed,
                latestMode: .previousDay,
                peakJoiner: "on"
            )
        case .all:
            return TrendDescriptor(
                cadence: .weekly(26),
                windowLabel: "Recent 26 weeks",
                comparisonLabel: "prior 26w",
                averageLabel: "Avg/week",
                peakLabel: "Peak week",
                latestLabel: "This week",
                comparisonDaySpan: 26 * 7,
                latestMode: .current,
                peakJoiner: "in"
            )
        case .lifetime:
            return lifetimeDescriptor(calendar: calendar)
        }
    }

    private var barGap: CGFloat {
        let count = bars.count
        if count > 24 { return 2 }
        if count > 12 { return 3 }
        return 4
    }

    private var bars: [TrendBar] {
        buildTrendBars(history: history, descriptor: descriptor)
    }

    var body: some View {
        let stats = computeTrendStats(
            bars: bars,
            allDays: history.daily,
            comparisonDaySpan: descriptor.comparisonDaySpan,
            latestMode: descriptor.latestMode
        )
        // Tokens are real for the .all-providers view; per-provider history doesn't carry
        // token breakdown yet, so fall back to $ when no tokens are present.
        let totalTokens = bars.reduce(0.0) { $0 + $1.tokens }
        let useTokens = totalTokens > 0
        let metric: (TrendBar) -> Double = useTokens ? { $0.tokens } : { $0.cost }
        let maxValue = max(bars.map(metric).max() ?? 1, 0.01)
        let avgValue = bars.isEmpty ? 0 : bars.map(metric).reduce(0, +) / Double(bars.count)
        let peakValue = bars.filter({ metric($0) > 0 }).max(by: { metric($0) < metric($1) })
        let latestValue = stats.latestBar.map(metric)

        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(descriptor.windowLabel)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.tertiary)
                    Text(formatHero(useTokens: useTokens, tokens: totalTokens, dollars: stats.totalThisWindow))
                        .font(.system(size: 18, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(.primary)
                }
                Spacer()
                if let delta = stats.deltaPercent, let comparisonLabel = descriptor.comparisonLabel {
                    HStack(spacing: 3) {
                        Image(systemName: delta >= 0 ? "arrow.up.right" : "arrow.down.right")
                            .font(.system(size: 9, weight: .bold))
                        Text("\(delta >= 0 ? "+" : "")\(String(format: "%.0f", delta))% vs \(comparisonLabel)")
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
                formatValue: { formatValue($0, useTokens: useTokens) },
                barGap: barGap
            )
            .zIndex(1)

            HStack(spacing: 14) {
                MiniStat(label: descriptor.averageLabel, value: formatValue(avgValue, useTokens: useTokens))
                MiniStat(label: descriptor.peakLabel, value: peakLabel(peakValue, metric: metric, useTokens: useTokens, joiner: descriptor.peakJoiner))
                MiniStat(label: descriptor.latestLabel, value: latestValue.map { formatValue($0, useTokens: useTokens) } ?? "—")
            }
        }
    }

    private func formatHero(useTokens: Bool, tokens: Double, dollars: Double) -> String {
        useTokens ? "\(formatTokens(tokens)) tokens" : dollars.asCurrency()
    }

    private func formatValue(_ v: Double, useTokens: Bool) -> String {
        useTokens ? "\(formatTokens(v)) tok" : v.asCompactCurrency()
    }

    private func peakLabel(_ peak: TrendBar?, metric: (TrendBar) -> Double, useTokens: Bool, joiner: String) -> String {
        guard let peak, metric(peak) > 0 else { return "—" }
        return "\(formatValue(metric(peak), useTokens: useTokens)) \(joiner) \(peak.shortLabel)"
    }

    private func formatTokens(_ n: Double) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", n / 1_000_000) }
        if n >= 1_000 { return String(format: "%.0fK", n / 1_000) }
        return String(format: "%.0f", n)
    }

    private func lifetimeDescriptor(calendar: Calendar) -> TrendDescriptor {
        makeLifetimeDescriptor(days: history.daily, calendar: calendar)
    }
}

private struct TrendChart: View {
    let bars: [TrendBar]
    let maxValue: Double
    let avgValue: Double
    let metric: (TrendBar) -> Double
    let formatValue: (Double) -> String
    let barGap: CGFloat

    @State private var hoveredBarID: TrendBar.ID?

    private var peakBarID: TrendBar.ID? {
        bars.filter { metric($0) > 0 }.max(by: { metric($0) < metric($1) })?.id
    }

    var body: some View {
        let avgFraction = maxValue > 0 ? CGFloat(min(avgValue / maxValue, 1.0)) : 0

        ZStack(alignment: .bottomLeading) {
            HStack(alignment: .bottom, spacing: barGap) {
                ForEach(bars) { bar in
                    BarColumn(
                        bar: bar,
                        value: metric(bar),
                        maxValue: maxValue,
                        isHovered: hoveredBarID == bar.id,
                        isPeak: bar.id == peakBarID
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
    let isPeak: Bool

    var body: some View {
        let fraction = maxValue > 0 ? CGFloat(value / maxValue) : 0
        let height = max(2, trendChartHeight * fraction)

        VStack(spacing: 0) {
            Spacer(minLength: 0)
            if isPeak && value > 0 {
                RoundedRectangle(cornerRadius: 2)
                    .fill(Color.yellow.opacity(0.85))
                    .frame(maxWidth: .infinity)
                    .frame(height: max(2, trendChartHeight * 0.05))
            }
            RoundedRectangle(cornerRadius: 2)
                .fill(barColor)
                .frame(maxWidth: .infinity)
                .frame(height: height)
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
        if bar.isCurrent { return Theme.brandAccent }
        if value <= 0 { return Color.secondary.opacity(0.15) }
        if isHovered { return Theme.brandAccent.opacity(0.85) }
        let ratio = maxValue > 0 ? value / maxValue : 0
        return Theme.brandAccent.opacity(0.42 + ratio * 0.48)
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
                Text(bar.label)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(primaryText)
                Spacer()
                Text("\(formatValue(value))")
                    .font(.codeMono(size: 10.5, weight: .semibold))
                    .foregroundStyle(Theme.brandAccent)
            }

            if !bar.topModels.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(Array(bar.topModels.prefix(4).enumerated()), id: \.offset) { idx, m in
                        HStack(spacing: 6) {
                            RoundedRectangle(cornerRadius: 1)
                                .fill(Theme.brandAccent.opacity(0.75 - Double(idx) * 0.12))
                                .frame(width: 3, height: 12)
                            Text(m.name)
                                .font(.system(size: 10, weight: .medium))
                                .foregroundStyle(primaryText)
                                .lineLimit(1)
                            Spacer()
                            if m.cost > 0 {
                                Text(m.cost.asCompactCurrency())
                                    .font(.codeMono(size: 9.5, weight: .semibold))
                                    .foregroundStyle(secondaryText)
                            }
                            Text("\(formatTokensCompact(Double(m.totalTokens))) tok")
                                .font(.codeMono(size: 9.5, weight: .medium))
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
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.system(size: 9.5, weight: .medium))
                .foregroundStyle(.tertiary)
            Text(value)
                .font(.system(size: 11.5, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(.primary)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(Color(nsColor: .separatorColor).opacity(0.35))
        )
    }
}

private struct TrendBar: Identifiable {
    let id: String
    let label: String
    let shortLabel: String
    let anchorDateKey: String
    let cost: Double
    let inputTokens: Double
    let outputTokens: Double
    let isCurrent: Bool
    let topModels: [DailyModelBreakdown]

    var tokens: Double { inputTokens + outputTokens }
}

private struct TrendStats {
    let totalThisWindow: Double
    let deltaPercent: Double?
    let latestBar: TrendBar?
}

private enum TrendCadence {
    case intraday4Hour
    case daily(Int)
    case weekly(Int)
    case monthly(Int)
    case quarterly(Int)
    case yearly(Int)
}

private enum TrendLatestMode {
    case current
    case previousDay
}

private struct TrendDescriptor {
    let cadence: TrendCadence
    let windowLabel: String
    let comparisonLabel: String?
    let averageLabel: String
    let peakLabel: String
    let latestLabel: String
    let comparisonDaySpan: Int?
    let latestMode: TrendLatestMode
    let peakJoiner: String
}

private struct TrendAggregate {
    let cost: Double
    let inputTokens: Double
    let outputTokens: Double
    let topModels: [DailyModelBreakdown]
}

private func buildTrendBars(history: HistoryBlock, descriptor: TrendDescriptor, now: Date = Date()) -> [TrendBar] {
    switch descriptor.cadence {
    case .intraday4Hour:
        return buildIntradayTrendBars(from: history.intraday, now: now)
    case .daily(let dayCount):
        return buildDailyTrendBars(from: history.daily, dayCount: dayCount, now: now)
    case .weekly(let weekCount):
        return buildWeeklyTrendBars(from: history.daily, weekCount: weekCount, now: now)
    case .monthly(let monthCount):
        return buildMonthlyTrendBars(from: history.daily, monthCount: monthCount, now: now)
    case .quarterly(let quarterCount):
        return buildQuarterlyTrendBars(from: history.daily, quarterCount: quarterCount, now: now)
    case .yearly(let yearCount):
        return buildYearlyTrendBars(from: history.daily, yearCount: yearCount, now: now)
    }
}

private func buildDailyTrendBars(from days: [DailyHistoryEntry], dayCount: Int, now: Date = Date()) -> [TrendBar] {
    let calendar = gregorianCalendar
    let formatter = yyyymmdd
    let entryByDate = Dictionary(days.map { ($0.date, $0) }, uniquingKeysWith: { _, new in new })
    let today = calendar.startOfDay(for: now)
    let todayKey = formatter.string(from: today)

    var bars: [TrendBar] = []
    for offset in (0..<dayCount).reversed() {
        guard let d = calendar.date(byAdding: .day, value: -offset, to: today) else { continue }
        let key = formatter.string(from: d)
        let entry = entryByDate[key]
        bars.append(TrendBar(
            id: key,
            label: prettyDate(key),
            shortLabel: shortDate(key),
            anchorDateKey: key,
            cost: entry?.cost ?? 0,
            inputTokens: Double(entry?.inputTokens ?? 0),
            outputTokens: Double(entry?.outputTokens ?? 0),
            isCurrent: key == todayKey,
            topModels: entry?.topModels ?? []
        ))
    }
    return bars
}

private func buildIntradayTrendBars(from buckets: [IntradayHistoryEntry], now: Date = Date()) -> [TrendBar] {
    let currentHour = gregorianCalendar.component(.hour, from: now)
    let today = gregorianCalendar.startOfDay(for: now)
    let todayKey = yyyymmdd.string(from: today)

    return buckets.map { bucket in
        TrendBar(
            id: "hour-\(bucket.bucketStartHour)",
            label: hourRangeLabel(startHour: bucket.bucketStartHour, endHour: bucket.bucketEndHour, compact: false),
            shortLabel: hourRangeLabel(startHour: bucket.bucketStartHour, endHour: bucket.bucketEndHour, compact: true),
            anchorDateKey: todayKey,
            cost: bucket.cost,
            inputTokens: Double(bucket.inputTokens),
            outputTokens: Double(bucket.outputTokens),
            isCurrent: currentHour >= bucket.bucketStartHour && currentHour < bucket.bucketEndHour,
            topModels: bucket.topModels
        )
    }
}

private func buildWeeklyTrendBars(from days: [DailyHistoryEntry], weekCount: Int, now: Date = Date()) -> [TrendBar] {
    let calendar = gregorianCalendar
    let today = calendar.startOfDay(for: now)
    guard let currentWeek = calendar.dateInterval(of: .weekOfYear, for: today) else { return [] }
    let entryByDate = Dictionary(days.map { ($0.date, $0) }, uniquingKeysWith: { _, new in new })
    let formatter = yyyymmdd

    return (0..<weekCount).reversed().compactMap { offset in
        guard let start = calendar.date(byAdding: .weekOfYear, value: -offset, to: currentWeek.start),
              let end = calendar.date(byAdding: .day, value: 7, to: start) else { return nil }
        let aggregate = aggregateTrendRange(entryByDate: entryByDate, start: start, end: end)
        let key = formatter.string(from: start)
        return TrendBar(
            id: "week-\(key)",
            label: "Week of \(shortDate(key))",
            shortLabel: "wk of \(shortDate(key))",
            anchorDateKey: key,
            cost: aggregate.cost,
            inputTokens: aggregate.inputTokens,
            outputTokens: aggregate.outputTokens,
            isCurrent: offset == 0,
            topModels: aggregate.topModels
        )
    }
}

private func buildMonthlyTrendBars(from days: [DailyHistoryEntry], monthCount: Int, now: Date = Date()) -> [TrendBar] {
    let calendar = gregorianCalendar
    let today = calendar.startOfDay(for: now)
    let currentMonthStart = calendar.date(from: calendar.dateComponents([.year, .month], from: today)) ?? today
    let entryByDate = Dictionary(days.map { ($0.date, $0) }, uniquingKeysWith: { _, new in new })
    let formatter = yyyymmdd

    return (0..<monthCount).reversed().compactMap { offset in
        guard let start = calendar.date(byAdding: .month, value: -offset, to: currentMonthStart),
              let end = calendar.date(byAdding: .month, value: 1, to: start) else { return nil }
        let aggregate = aggregateTrendRange(entryByDate: entryByDate, start: start, end: end)
        let key = formatter.string(from: start)
        return TrendBar(
            id: "month-\(key)",
            label: monthYearLabel(start),
            shortLabel: monthYearLabel(start),
            anchorDateKey: key,
            cost: aggregate.cost,
            inputTokens: aggregate.inputTokens,
            outputTokens: aggregate.outputTokens,
            isCurrent: offset == 0,
            topModels: aggregate.topModels
        )
    }
}

private func buildQuarterlyTrendBars(from days: [DailyHistoryEntry], quarterCount: Int, now: Date = Date()) -> [TrendBar] {
    let calendar = gregorianCalendar
    let today = calendar.startOfDay(for: now)
    let currentQuarterStart = quarterStart(for: today, calendar: calendar)
    let entryByDate = Dictionary(days.map { ($0.date, $0) }, uniquingKeysWith: { _, new in new })
    let formatter = yyyymmdd

    return (0..<quarterCount).reversed().compactMap { offset in
        guard let start = calendar.date(byAdding: .month, value: -(offset * 3), to: currentQuarterStart),
              let end = calendar.date(byAdding: .month, value: 3, to: start) else { return nil }
        let aggregate = aggregateTrendRange(entryByDate: entryByDate, start: start, end: end)
        let key = formatter.string(from: start)
        return TrendBar(
            id: "quarter-\(key)",
            label: quarterLabel(start, calendar: calendar),
            shortLabel: quarterLabel(start, calendar: calendar),
            anchorDateKey: key,
            cost: aggregate.cost,
            inputTokens: aggregate.inputTokens,
            outputTokens: aggregate.outputTokens,
            isCurrent: offset == 0,
            topModels: aggregate.topModels
        )
    }
}

private func buildYearlyTrendBars(from days: [DailyHistoryEntry], yearCount: Int, now: Date = Date()) -> [TrendBar] {
    let calendar = gregorianCalendar
    let today = calendar.startOfDay(for: now)
    let currentYearStart = calendar.date(from: calendar.dateComponents([.year], from: today)) ?? today
    let entryByDate = Dictionary(days.map { ($0.date, $0) }, uniquingKeysWith: { _, new in new })
    let formatter = yyyymmdd

    return (0..<yearCount).reversed().compactMap { offset in
        guard let start = calendar.date(byAdding: .year, value: -offset, to: currentYearStart),
              let end = calendar.date(byAdding: .year, value: 1, to: start) else { return nil }
        let aggregate = aggregateTrendRange(entryByDate: entryByDate, start: start, end: end)
        let key = formatter.string(from: start)
        return TrendBar(
            id: "year-\(key)",
            label: yearLabel(start, calendar: calendar),
            shortLabel: yearLabel(start, calendar: calendar),
            anchorDateKey: key,
            cost: aggregate.cost,
            inputTokens: aggregate.inputTokens,
            outputTokens: aggregate.outputTokens,
            isCurrent: offset == 0,
            topModels: aggregate.topModels
        )
    }
}

private func aggregateTrendRange(entryByDate: [String: DailyHistoryEntry], start: Date, end: Date) -> TrendAggregate {
    let calendar = gregorianCalendar
    let formatter = yyyymmdd
    var cursor = start
    var cost = 0.0
    var inputTokens = 0.0
    var outputTokens = 0.0
    var topModelTotals: [String: (calls: Int, cost: Double, inputTokens: Int, outputTokens: Int)] = [:]

    while cursor < end {
        let key = formatter.string(from: cursor)
        if let entry = entryByDate[key] {
            cost += entry.cost
            inputTokens += Double(entry.inputTokens)
            outputTokens += Double(entry.outputTokens)

            for model in entry.topModels {
                let existing = topModelTotals[model.name] ?? (calls: 0, cost: 0, inputTokens: 0, outputTokens: 0)
                topModelTotals[model.name] = (
                    calls: existing.calls + model.calls,
                    cost: existing.cost + model.cost,
                    inputTokens: existing.inputTokens + model.inputTokens,
                    outputTokens: existing.outputTokens + model.outputTokens
                )
            }
        }

        guard let next = calendar.date(byAdding: .day, value: 1, to: cursor) else { break }
        cursor = next
    }

    let topModels = topModelTotals
        .map { name, total in
            DailyModelBreakdown(
                name: name,
                cost: total.cost,
                calls: total.calls,
                inputTokens: total.inputTokens,
                outputTokens: total.outputTokens
            )
        }
        .sorted { $0.cost > $1.cost }
        .prefix(5)

    return TrendAggregate(
        cost: cost,
        inputTokens: inputTokens,
        outputTokens: outputTokens,
        topModels: Array(topModels)
    )
}

private func computeTrendStats(
    bars: [TrendBar],
    allDays: [DailyHistoryEntry],
    comparisonDaySpan: Int?,
    latestMode: TrendLatestMode
) -> TrendStats {
    let total = bars.reduce(0.0) { $0 + $1.cost }

    let calendar = gregorianCalendar
    let formatter = yyyymmdd
    let today = calendar.startOfDay(for: Date())
    var deltaPercent: Double? = nil
    if let comparisonDaySpan,
       let priorStart = calendar.date(byAdding: .day, value: -(2 * comparisonDaySpan - 1), to: today),
       let thisStart = calendar.date(byAdding: .day, value: -(comparisonDaySpan - 1), to: today) {
        let priorStartStr = formatter.string(from: priorStart)
        let thisStartStr = formatter.string(from: thisStart)
        let priorTotal = allDays
            .filter { $0.date >= priorStartStr && $0.date < thisStartStr }
            .reduce(0.0) { $0 + $1.cost }
        if priorTotal > 0 {
            deltaPercent = ((total - priorTotal) / priorTotal) * 100
        }
    }

    let latestBar: TrendBar?
    switch latestMode {
    case .current:
        latestBar = bars.last(where: { $0.isCurrent })
    case .previousDay:
        let yesterdayDate = calendar.date(byAdding: .day, value: -1, to: today)
        let yesterdayKey = yesterdayDate.map { formatter.string(from: $0) }
        latestBar = bars.first(where: { $0.anchorDateKey == yesterdayKey })
    }

    return TrendStats(
        totalThisWindow: total,
        deltaPercent: deltaPercent,
        latestBar: latestBar
    )
}

private func hourRangeLabel(startHour: Int, endHour: Int, compact: Bool) -> String {
    let start = hourLabel(startHour, compact: compact)
    let end = hourLabel(endHour % 24, compact: compact)
    return compact ? "\(start)-\(end)" : "\(start) - \(end)"
}

private func hourLabel(_ hour: Int, compact: Bool) -> String {
    let normalized = (hour + 24) % 24
    let value = normalized == 0 ? 12 : (normalized > 12 ? normalized - 12 : normalized)
    let suffix = normalized < 12 ? (compact ? "a" : "AM") : (compact ? "p" : "PM")
    return compact ? "\(value)\(suffix)" : "\(value) \(suffix)"
}

private func monthYearLabel(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "MMM yyyy"
    return formatter.string(from: date)
}

private func lifetimeMonthSpan(calendar: Calendar, days: [DailyHistoryEntry], now: Date = Date()) -> Int {
    let today = calendar.startOfDay(for: now)
    let currentMonthStart = calendar.date(from: calendar.dateComponents([.year, .month], from: today)) ?? today

    guard let firstDateKey = days.map(\ .date).min(),
          let firstDate = yyyymmdd.date(from: firstDateKey) else {
        return 1
    }

    let firstMonthStart = calendar.date(from: calendar.dateComponents([.year, .month], from: firstDate)) ?? firstDate
    let firstComponents = calendar.dateComponents([.year, .month], from: firstMonthStart)
    let currentComponents = calendar.dateComponents([.year, .month], from: currentMonthStart)
    let firstYear = firstComponents.year ?? currentComponents.year ?? 0
    let firstMonth = firstComponents.month ?? currentComponents.month ?? 1
    let currentYear = currentComponents.year ?? firstYear
    let currentMonth = currentComponents.month ?? firstMonth
    let diff = (currentYear - firstYear) * 12 + (currentMonth - firstMonth)
    return max(diff + 1, 1)
}

private func makeLifetimeDescriptor(days: [DailyHistoryEntry], calendar: Calendar, now: Date = Date()) -> TrendDescriptor {
    let monthSpan = lifetimeMonthSpan(calendar: calendar, days: days, now: now)
    if monthSpan <= 24 {
        return TrendDescriptor(
            cadence: .monthly(monthSpan),
            windowLabel: "All time by month",
            comparisonLabel: nil,
            averageLabel: "Avg/month",
            peakLabel: "Peak month",
            latestLabel: "This month",
            comparisonDaySpan: nil,
            latestMode: .current,
            peakJoiner: "in"
        )
    }

    if monthSpan <= 60 {
        let quarterCount = Int(ceil(Double(monthSpan) / 3.0))
        return TrendDescriptor(
            cadence: .quarterly(quarterCount),
            windowLabel: "All time by quarter",
            comparisonLabel: nil,
            averageLabel: "Avg/quarter",
            peakLabel: "Peak quarter",
            latestLabel: "This quarter",
            comparisonDaySpan: nil,
            latestMode: .current,
            peakJoiner: "in"
        )
    }

    let yearCount = Int(ceil(Double(monthSpan) / 12.0))
    return TrendDescriptor(
        cadence: .yearly(yearCount),
        windowLabel: "All time by year",
        comparisonLabel: nil,
        averageLabel: "Avg/year",
        peakLabel: "Peak year",
        latestLabel: "This year",
        comparisonDaySpan: nil,
        latestMode: .current,
        peakJoiner: "in"
    )
}

struct LifetimeTrendTestSummary: Equatable {
    let windowLabel: String
    let labels: [String]
}

func makeLifetimeTrendTestSummary(days: [DailyHistoryEntry], now: Date) -> LifetimeTrendTestSummary {
    let descriptor = makeLifetimeDescriptor(days: days, calendar: gregorianCalendar, now: now)
    let bars = buildTrendBars(history: HistoryBlock(daily: days, intraday: []), descriptor: descriptor, now: now)
    return LifetimeTrendTestSummary(windowLabel: descriptor.windowLabel, labels: bars.map(\.label))
}

private func quarterStart(for date: Date, calendar: Calendar) -> Date {
    let components = calendar.dateComponents([.year, .month], from: date)
    let month = components.month ?? 1
    let quarterMonth = ((month - 1) / 3) * 3 + 1
    return calendar.date(from: DateComponents(year: components.year, month: quarterMonth, day: 1)) ?? date
}

private func quarterLabel(_ date: Date, calendar: Calendar) -> String {
    let components = calendar.dateComponents([.year, .month], from: date)
    let month = components.month ?? 1
    let quarter = ((month - 1) / 3) + 1
    let year = components.year ?? 0
    return "Q\(quarter) \(year)"
}

private func yearLabel(_ date: Date, calendar: Calendar) -> String {
    String(calendar.component(.year, from: date))
}

private func shortDate(_ ymd: String) -> String {
    let parts = ymd.split(separator: "-")
    guard parts.count == 3 else { return ymd }
    return "\(parts[1])/\(parts[2])"
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
        VStack(alignment: .leading, spacing: 8) {
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
            CostPerEditCaption(models: payload.current.modelEfficiency)
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

private struct CostPerEditCaption: View {
    let models: [ModelEfficiencyEntry]

    var body: some View {
        let valid = models.compactMap { m -> (String, Double)? in
            guard let cpe = m.costPerEdit, cpe > 0 else { return nil }
            return (m.name, cpe)
        }.sorted(by: { $0.1 < $1.1 })

        if let best = valid.first {
            HStack(spacing: 4) {
                Image(systemName: "pencil.line")
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(.tertiary)
                Text("Cost/edit")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.tertiary)
                Text(formatCPE(best.1))
                    .font(.codeMono(size: 10.5, weight: .semibold))
                    .foregroundStyle(Theme.brandAccent)
                Text(best.0)
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if valid.count > 1, let worst = valid.last, worst.0 != best.0 {
                    Text("—")
                        .font(.system(size: 9))
                        .foregroundStyle(.quaternary)
                    Text(formatCPE(worst.1))
                        .font(.codeMono(size: 10.5, weight: .semibold))
                        .foregroundStyle(.primary)
                    Text(worst.0)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
            }
        }
    }

    private func formatCPE(_ v: Double) -> String {
        if v < 0.01 { return String(format: "$%.3f", v) }
        return String(format: "$%.2f", v)
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
    @Environment(AppStore.self) private var store
    let payload: MenubarPayload
    let period: Period

    var body: some View {
        let stats = computeAllStats(payload: payload, period: period)

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
                    StatRow(label: stats.sessionsLabel, value: "\(payload.current.sessions)")
                    StatRow(label: stats.callsLabel, value: payload.current.calls.asThousandsSeparated())
                    StatRow(label: "Current streak", value: stats.currentStreak)
                    StatRow(label: "Longest streak", value: stats.longestStreak)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            if let trackedSpend = stats.trackedSpend {
                Divider().opacity(0.5)
                HStack {
                    Text(stats.trackedSpendLabel)
                        .font(.system(size: 10.5, weight: .medium))
                        .foregroundStyle(.tertiary)
                    Spacer()
                    Text(trackedSpend.asCurrency())
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(Theme.brandAccent)
                }
            }

            if !payload.current.topProjects.isEmpty {
                Divider().opacity(0.5)
                TopProjectsList(projects: payload.current.topProjects)
            }

            if let top = payload.current.topSessions.first, top.cost > 0 {
                HStack(spacing: 4) {
                    Image(systemName: "flame")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(Theme.brandAccent)
                    Text("Costliest session")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.tertiary)
                    Spacer()
                    Text(top.cost.asCompactCurrency())
                        .font(.codeMono(size: 10.5, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                    Text("· \(projectDisplayName(top.project, hidePersonalInformation: store.hidePersonalInformation))")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
            }

        }
    }
}

private struct RetryTaxSection: View {
    let retryTax: RetryTax
    let totalCost: Double
    @State private var expanded = false

    var body: some View {
        if retryTax.totalUSD > 0 {
            Divider().opacity(0.5)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.2.squarepath")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(.orange)
                    Text("Retry tax")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.tertiary)
                    Spacer()
                    Text(retryTax.totalUSD.asCompactCurrency())
                        .font(.codeMono(size: 11, weight: .bold))
                        .foregroundStyle(.orange)
                        .monospacedDigit()
                    if totalCost > 0 {
                        Text("(\(Int((retryTax.totalUSD / totalCost * 100).rounded()))%)")
                            .font(.system(size: 9.5))
                            .foregroundStyle(.tertiary)
                    }
                    Image(systemName: "chevron.right")
                        .font(.system(size: 7, weight: .bold))
                        .foregroundStyle(.quaternary)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                }
                .contentShape(Rectangle())
                .onTapGesture {
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) {
                        expanded.toggle()
                    }
                }

                Text("\(retryTax.retries) retries across \(retryTax.editTurns) edits")
                    .font(.system(size: 9.5))
                    .foregroundStyle(.quaternary)

                if expanded {
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(Array(retryTax.byModel.enumerated()), id: \.offset) { idx, model in
                            HStack(spacing: 0) {
                                Text(model.name)
                                    .font(.system(size: 9.5, weight: .medium))
                                    .foregroundStyle(.secondary)
                                Spacer()
                                if let rpe = model.retriesPerEdit {
                                    Text(String(format: "%.1f ret/edit", rpe))
                                        .font(.system(size: 9))
                                        .foregroundStyle(.quaternary)
                                        .padding(.trailing, 8)
                                }
                                Text(model.taxUSD.asCompactCurrency())
                                    .font(.codeMono(size: 10, weight: .semibold))
                                    .foregroundStyle(.orange.opacity(0.85))
                                    .monospacedDigit()
                            }
                            .padding(.vertical, 2)
                            .padding(.horizontal, 6)
                            .background(RoundedRectangle(cornerRadius: 4).fill(.orange.opacity(0.05)))
                            .transition(
                                .asymmetric(
                                    insertion: .opacity.combined(with: .scale(scale: 0.95, anchor: .top))
                                        .animation(.spring(response: 0.3, dampingFraction: 0.8).delay(Double(idx) * 0.03)),
                                    removal: .opacity.animation(.easeOut(duration: 0.12))
                                )
                            )
                        }
                    }
                    .padding(.top, 2)
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

private func projectDisplayName(_ path: String, hidePersonalInformation: Bool) -> String {
    let name = path.split(separator: "/").last.map(String.init) ?? path
    return PrivacyRedactor.redact(name, enabled: hidePersonalInformation)
}

private struct TopProjectsList: View {
    @Environment(AppStore.self) private var store
    let projects: [ProjectEntry]
    @State private var expanded: String?

    var body: some View {
        let top = Array(projects.prefix(3))
        let maxCost = top.first?.cost ?? 1

        VStack(alignment: .leading, spacing: 5) {
            ForEach(Array(top.enumerated()), id: \.offset) { idx, project in
                let expandKey = "\(idx):\(project.name)"
                let isOpen = expanded == expandKey
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 7, weight: .bold))
                            .foregroundStyle(.quaternary)
                            .rotationEffect(.degrees(isOpen ? 90 : 0))
                        Text(projectDisplayName(project.name, hidePersonalInformation: store.hidePersonalInformation))
                            .font(.system(size: 10.5, weight: .medium))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                        Spacer()
                        Text("\(project.sessions) sess")
                            .font(.system(size: 9.5, weight: .medium))
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                        Text(project.cost.asCompactCurrency())
                            .font(.codeMono(size: 10.5, weight: .semibold))
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                        RoundedRectangle(cornerRadius: 2)
                            .fill(Theme.brandAccent.opacity(0.5))
                            .frame(
                                width: max(2, 40 * CGFloat(project.cost / max(maxCost, 0.01))),
                                height: 6
                            )
                    }
                    .contentShape(Rectangle())
                    .onTapGesture {
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) {
                            expanded = isOpen ? nil : expandKey
                        }
                    }

                    if isOpen, !project.sessionDetails.isEmpty {
                        SessionDetailsList(sessions: project.sessionDetails)
                            .padding(.top, 6)
                            .padding(.leading, 14)
                    }
                }
            }
        }
    }
}

private struct SessionDetailsList: View {
    let sessions: [SessionDetailEntry]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(sessions.prefix(5).enumerated()), id: \.offset) { idx, sess in
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 0) {
                        Text(sess.cost.asCompactCurrency())
                            .font(.codeMono(size: 10, weight: .semibold))
                            .foregroundStyle(.primary)
                            .monospacedDigit()
                            .frame(width: 52, alignment: .trailing)
                        Text("  \(sess.calls) calls")
                            .font(.system(size: 9))
                            .foregroundStyle(.quaternary)
                        Spacer()
                        HStack(spacing: 3) {
                            Image(systemName: "arrow.down")
                                .font(.system(size: 7, weight: .semibold))
                            Text(compactTokens(sess.inputTokens))
                        }
                        .font(.system(size: 9))
                        .foregroundStyle(.tertiary)
                        HStack(spacing: 3) {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 7, weight: .semibold))
                            Text(compactTokens(sess.outputTokens))
                        }
                        .font(.system(size: 9))
                        .foregroundStyle(.tertiary)
                        .padding(.leading, 4)
                    }
                    HStack(spacing: 4) {
                        ForEach(Array(sess.models.prefix(3).enumerated()), id: \.offset) { _, model in
                            Text(model.name)
                                .font(.system(size: 8.5, weight: .medium))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1.5)
                                .background(Theme.brandAccent.opacity(0.1))
                                .clipShape(Capsule())
                        }
                    }
                    .padding(.leading, 52)
                }
                .padding(.vertical, 3)
                .padding(.horizontal, 6)
                .background(
                    RoundedRectangle(cornerRadius: 5)
                        .fill(.primary.opacity(0.03))
                )
                .transition(
                    .asymmetric(
                        insertion: .opacity.combined(with: .scale(scale: 0.95, anchor: .top))
                            .animation(.spring(response: 0.3, dampingFraction: 0.8).delay(Double(idx) * 0.03)),
                        removal: .opacity.animation(.easeOut(duration: 0.15))
                    )
                )
            }
        }
    }

    private func compactTokens(_ n: Int) -> String {
        let d = Double(n)
        if d >= 1_000_000 { return String(format: "%.1fM", d / 1_000_000) }
        if d >= 1_000 { return String(format: "%.0fK", d / 1_000) }
        return "\(n)"
    }
}

// MARK: - Optimize

private struct OptimizeInsight: View {
    let payload: MenubarPayload

    var body: some View {
        let totalWaste = payload.current.retryTax.totalUSD + payload.current.routingWaste.totalSavingsUSD
        let cost = payload.current.cost

        VStack(alignment: .leading, spacing: 12) {
            if totalWaste > 0, cost > 0 {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Potential savings")
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(.tertiary)
                        Text(totalWaste.asCompactCurrency())
                            .font(.system(size: 24, weight: .bold, design: .rounded))
                            .monospacedDigit()
                            .foregroundStyle(.orange)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        Text("\(Int((totalWaste / cost * 100).rounded()))% of spend")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(.orange.opacity(0.8))
                        Text("could be optimized")
                            .font(.system(size: 9.5))
                            .foregroundStyle(.quaternary)
                    }
                }
                .padding(.bottom, 2)
            }

            RetryTaxSection(retryTax: payload.current.retryTax, totalCost: cost)

            RoutingWasteSection(routingWaste: payload.current.routingWaste, totalCost: cost)
        }
    }
}

private struct RoutingWasteSection: View {
    let routingWaste: RoutingWaste
    let totalCost: Double
    @State private var expanded = false

    var body: some View {
        if routingWaste.totalSavingsUSD > 0 {
            Divider().opacity(0.5)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.triangle.swap")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(.purple)
                    Text("Routing waste")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.tertiary)
                    Spacer()
                    Text(routingWaste.totalSavingsUSD.asCompactCurrency())
                        .font(.codeMono(size: 11, weight: .bold))
                        .foregroundStyle(.purple)
                        .monospacedDigit()
                    if totalCost > 0 {
                        Text("(\(Int((routingWaste.totalSavingsUSD / totalCost * 100).rounded()))%)")
                            .font(.system(size: 9.5))
                            .foregroundStyle(.tertiary)
                    }
                    Image(systemName: "chevron.right")
                        .font(.system(size: 7, weight: .bold))
                        .foregroundStyle(.quaternary)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                }
                .contentShape(Rectangle())
                .onTapGesture {
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) {
                        expanded.toggle()
                    }
                }

                if !routingWaste.baselineModel.isEmpty {
                    Text("vs \(routingWaste.baselineModel) @ \(routingWaste.baselineCostPerEdit.asCompactCurrency())/edit")
                        .font(.system(size: 9.5))
                        .foregroundStyle(.quaternary)
                }

                if expanded {
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(Array(routingWaste.byModel.enumerated()), id: \.offset) { idx, model in
                            HStack(spacing: 0) {
                                Text(model.name)
                                    .font(.system(size: 9.5, weight: .medium))
                                    .foregroundStyle(.secondary)
                                Spacer()
                                Text(String(format: "$%.2f/edit", model.costPerEdit))
                                    .font(.system(size: 9))
                                    .foregroundStyle(.quaternary)
                                    .padding(.trailing, 8)
                                Text(model.savingsUSD.asCompactCurrency())
                                    .font(.codeMono(size: 10, weight: .semibold))
                                    .foregroundStyle(.purple.opacity(0.85))
                                    .monospacedDigit()
                            }
                            .padding(.vertical, 2)
                            .padding(.horizontal, 6)
                            .background(RoundedRectangle(cornerRadius: 4).fill(.purple.opacity(0.05)))
                            .transition(
                                .asymmetric(
                                    insertion: .opacity.combined(with: .scale(scale: 0.95, anchor: .top))
                                        .animation(.spring(response: 0.3, dampingFraction: 0.8).delay(Double(idx) * 0.03)),
                                    removal: .opacity.animation(.easeOut(duration: 0.12))
                                )
                            )
                        }
                    }
                    .padding(.top, 2)
                }
            }
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
    let trackedSpend: Double?
    let trackedSpendLabel: String
    let sessionsLabel: String
    let callsLabel: String
}

@MainActor private func computeAllStats(payload: MenubarPayload, period: Period) -> AllStats {
    let history = payload.history.daily
    let favoriteModel = payload.current.topModels.first?.name ?? "—"

    let calendar = gregorianCalendar
    let formatter = yyyymmdd
    let displayFormatter = mmmDayFormat

    let now = Date()
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

    let mostActiveDay: String
    let peakDaySpend: String
    if let peakDate = payload.stats.mostActiveDay,
       let peakValue = payload.stats.peakDaySpend,
       peakValue > 0,
       let date = formatter.date(from: peakDate) {
        mostActiveDay = displayFormatter.string(from: date)
        peakDaySpend = peakValue.asCompactCurrency()
    } else {
        mostActiveDay = "—"
        peakDaySpend = "—"
    }

    let trackedSpend: Double? = payload.stats.trackedSpend > 0 ? payload.stats.trackedSpend : nil
    let trackedSpendLabel: String
    let sessionsLabel: String
    let callsLabel: String
    switch period {
    case .today:
        trackedSpendLabel = "Tracked spend (today)"
        sessionsLabel = "Sessions today"
        callsLabel = "Calls today"
    case .sevenDays:
        trackedSpendLabel = "Tracked spend (last 7 days)"
        sessionsLabel = "Sessions (last 7 days)"
        callsLabel = "Calls (last 7 days)"
    case .thirtyDays:
        trackedSpendLabel = "Tracked spend (last 30 days)"
        sessionsLabel = "Sessions (last 30 days)"
        callsLabel = "Calls (last 30 days)"
    case .month:
        trackedSpendLabel = "Tracked spend (this month)"
        sessionsLabel = "Sessions (this month)"
        callsLabel = "Calls (this month)"
    case .all:
        trackedSpendLabel = "Tracked spend (last 6 months)"
        sessionsLabel = "Sessions (last 6 months)"
        callsLabel = "Calls (last 6 months)"
    case .lifetime:
        trackedSpendLabel = "Tracked spend (all time)"
        sessionsLabel = "Sessions (all time)"
        callsLabel = "Calls (all time)"
    }

    return AllStats(
        favoriteModel: favoriteModel,
        activeDaysFraction: activeDaysFraction,
        mostActiveDay: mostActiveDay,
        peakDaySpend: peakDaySpend,
        currentStreak: payload.stats.currentStreakDays == 0 ? "—" : "\(payload.stats.currentStreakDays) days",
        longestStreak: payload.stats.longestStreakDays == 0 ? "—" : "\(payload.stats.longestStreakDays) days",
        trackedSpend: trackedSpend,
        trackedSpendLabel: trackedSpendLabel,
        sessionsLabel: sessionsLabel,
        callsLabel: callsLabel
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
            case .notBootstrapped, .dormant:
                PlanConnectView(providerName: "Claude") { Task { await store.bootstrapSubscription() } }
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

/// Shown the very first time a user opens a provider's Plan tab. Clicking
/// Connect is the only path that reads provider credentials; the menubar app
/// does not touch those sources at startup.
private struct PlanConnectView: View {
    @Environment(AppStore.self) private var store
    let providerName: String
    var detail: String? = nil
    let onConnect: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "link.circle")
                .font(.system(size: 26))
                .foregroundStyle(Theme.brandAccent)
            Text("Connect \(providerName) subscription")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.primary)
            Text(connectDetail)
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

    private var connectDetail: String {
        if let detail { return detail }
        if store.keychainAccessEnabled {
            return "CodeBurn will read your Claude Code credentials once. macOS will ask permission. After that, the live quota bar shows next to the Claude tab and updates automatically."
        }
        return "Keychain access is disabled. CodeBurn will only read ~/.claude/.credentials.json and will not prompt macOS Keychain."
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
            case .notBootstrapped, .dormant:
                PlanConnectView(
                    providerName: "Codex",
                    detail: "CodeBurn will read ~/.codex/auth.json once, then keep a local token cache for live quota refreshes."
                ) { Task { await store.bootstrapCodex() } }
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
