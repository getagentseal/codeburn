import AppKit
import SwiftUI

private let trendChartHeight: CGFloat = 90

// Cached formatters and a calendar to avoid allocating fresh ones on every
// SwiftUI body re-eval. Hover scrubbing on the trend bars triggers many
// re-evals per second; a fresh DateFormatter / Calendar each time was a
// measurable hot spot.
private let yyyymmdd: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd"
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = .current
    return f
}()

private let prettyDayFormat: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "EEE MMM d"
    f.locale = Locale(identifier: "en_US_POSIX")
    return f
}()

private let mmmDayFormat: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "MMM d"
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = .current
    return f
}()

private let gregorianCalendar: Calendar = {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = .current
    return c
}()

/// Switchable insight visualizations: trend, calendar, forecast, pulse, stats,
/// optimize, plus provider-specific plan views.
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
        case .trend: TrendInsight(days: store.payload.history.daily, period: store.trendPeriod)
        case .calendar: ContributionHeatmapInsight(days: store.payload.history.daily)
        case .forecast: ForecastInsight(days: store.payload.history.daily)
        case .pulse: PulseInsight(payload: store.payload)
        case .stats: StatsInsight(payload: store.payload)
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

// MARK: - Trend (14-day bar chart with peak + average)

private struct TrendInsight: View {
    let days: [DailyHistoryEntry]
    let period: Period

    private var trendDayCount: Int {
        switch period {
        case .today, .sevenDays: return 19
        case .thirtyDays: return 30
        case .month: return 31
        case .all, .lifetime: return min(days.count, 90)
        }
    }

    private var barGap: CGFloat {
        trendDayCount > 45 ? 2 : 4
    }

    var body: some View {
        let dayCount = trendDayCount
        let bars = buildTrendBars(from: days, dayCount: dayCount)
        let stats = computeTrendStats(bars: bars, allDays: days, dayCount: dayCount)
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
                    Text("Last \(dayCount) days")
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
                        Text("\(delta >= 0 ? "+" : "")\(String(format: "%.0f", delta))% vs prior \(dayCount)d")
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
        if bar.isToday { return Theme.brandAccent }
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

private func buildTrendBars(from days: [DailyHistoryEntry], dayCount: Int) -> [TrendBar] {
    let calendar = gregorianCalendar
    let formatter = yyyymmdd
    let entryByDate = Dictionary(days.map { ($0.date, $0) }, uniquingKeysWith: { _, new in new })
    let today = calendar.startOfDay(for: Date())
    let todayKey = formatter.string(from: today)

    var bars: [TrendBar] = []
    for offset in (0..<dayCount).reversed() {
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

private func computeTrendStats(bars: [TrendBar], allDays: [DailyHistoryEntry], dayCount: Int) -> TrendStats {
    let total = bars.reduce(0.0) { $0 + $1.cost }
    let active = bars.filter { $0.cost > 0 }.count
    let avg = bars.isEmpty ? 0 : total / Double(bars.count)
    let peak = bars.filter { $0.cost > 0 }.max(by: { $0.cost < $1.cost })

    let calendar = gregorianCalendar
    let formatter = yyyymmdd
    let today = calendar.startOfDay(for: Date())
    let priorWindowStart = calendar.date(byAdding: .day, value: -(2 * dayCount - 1), to: today)
    let thisWindowStart = calendar.date(byAdding: .day, value: -(dayCount - 1), to: today)
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

// MARK: - Calendar

private struct ContributionHeatmapInsight: View {
    let days: [DailyHistoryEntry]

    private let cellSize: CGFloat = 8
    private let cellGap: CGFloat = 3
    private let weekdayLabelWidth: CGFloat = 26
    @State private var hoveredDayID: ContributionDay.ID?

    var body: some View {
        GeometryReader { geo in
            let weekCount = adaptiveWeekCount(for: geo.size.width)
            let weeks = buildContributionWeeks(from: days, weekCount: weekCount)
            let stats = computeContributionStats(weeks: weeks)
            let hoveredDay = weeks.flatMap(\.days).first { $0.id == hoveredDayID }

            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Daily activity")
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(.tertiary)
                        Text(stats.total.asCurrency())
                            .font(.system(size: 18, weight: .semibold, design: .rounded))
                            .monospacedDigit()
                            .foregroundStyle(.primary)
                    }
                    Spacer()
                    Text("\(stats.activeDays) active days")
                        .font(.system(size: 10.5, weight: .medium))
                        .monospacedDigit()
                        .foregroundStyle(Theme.brandAccent)
                }

                HStack(alignment: .top, spacing: 6) {
                    VStack(alignment: .trailing, spacing: cellGap) {
                        ForEach(0..<7, id: \.self) { idx in
                            Text(weekdayLabel(for: idx))
                                .font(.system(size: 8.5, weight: .medium))
                                .foregroundStyle(.tertiary)
                                .frame(width: weekdayLabelWidth, height: cellSize, alignment: .trailing)
                        }
                    }

                    HStack(alignment: .top, spacing: cellGap) {
                        ForEach(weeks) { week in
                            VStack(spacing: cellGap) {
                                ForEach(week.days) { day in
                                    ContributionCell(
                                        day: day,
                                        size: cellSize,
                                        isHovered: hoveredDayID == day.id
                                    )
                                    .onHover { hovering in
                                        hoveredDayID = hovering ? day.id : (hoveredDayID == day.id ? nil : hoveredDayID)
                                    }
                                }
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .trailing)
                }

                ContributionDayDetail(day: hoveredDay, fallbackStats: stats)
                    .animation(.easeInOut(duration: 0.12), value: hoveredDayID)

                HStack(spacing: 14) {
                    MiniStat(label: "Peak day", value: stats.peakLabel)
                    MiniStat(label: "Avg active", value: stats.avgActive.asCompactCurrency())
                    MiniStat(label: "Streak", value: "\(stats.currentStreak)d")
                }
            }
        }
        .frame(height: 216)
    }

    private func adaptiveWeekCount(for width: CGFloat) -> Int {
        let available = max(0, width - weekdayLabelWidth - 10)
        let raw = Int(floor((available + cellGap) / (cellSize + cellGap)))
        return min(max(raw, 1), 52)
    }

    private func weekdayLabel(for index: Int) -> String {
        switch index {
        case 0: return "Mon"
        case 2: return "Wed"
        case 4: return "Fri"
        case 6: return "Sun"
        default: return ""
        }
    }
}

private struct ContributionCell: View {
    let day: ContributionDay
    let size: CGFloat
    let isHovered: Bool

    var body: some View {
        RoundedRectangle(cornerRadius: 2)
            .fill(fillColor)
            .frame(width: size, height: size)
            .overlay(
                RoundedRectangle(cornerRadius: 2)
                    .stroke(strokeColor, lineWidth: isHovered || day.isToday ? 1 : 0)
            )
            .scaleEffect(isHovered ? 1.35 : 1.0)
            .animation(.easeOut(duration: 0.10), value: isHovered)
            .help(day.helpText)
            .accessibilityLabel(day.helpText)
    }

    private var strokeColor: Color {
        if isHovered { return Theme.brandAccent.opacity(0.95) }
        if day.isToday { return Theme.brandAccent.opacity(0.95) }
        return Color.clear
    }

    private var fillColor: Color {
        if day.isFuture { return Color.secondary.opacity(0.06) }
        if isHovered { return Theme.brandAccent.opacity(0.95) }
        switch day.level {
        case 0: return Color.secondary.opacity(0.14)
        case 1: return Theme.brandAccent.opacity(0.30)
        case 2: return Theme.brandAccent.opacity(0.48)
        case 3: return Theme.brandAccent.opacity(0.66)
        default: return Theme.brandAccent.opacity(0.88)
        }
    }
}

private struct ContributionDayDetail: View {
    let day: ContributionDay?
    let fallbackStats: ContributionStats

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.tertiary)
                Text(value)
                    .font(.system(size: 13, weight: .semibold))
                    .monospacedDigit()
                    .foregroundStyle(.primary)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            DetailMetric(label: "Calls", value: calls)
            DetailMetric(label: "Tokens", value: tokens)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, minHeight: 42, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(Color(nsColor: .separatorColor).opacity(0.25))
        )
    }

    private var title: String {
        // The header already shows the period total and active-day count, so
        // the resting state is a short hover hint — not a duplicate of those
        // (and not the full sentence that previously overflowed and truncated).
        guard let day else { return "Daily detail" }
        return prettyDate(day.date)
    }

    private var value: String {
        guard let day else { return "Hover a day" }
        if day.isFuture { return "Future day" }
        if day.cost <= 0 && day.calls == 0 { return "No tracked usage" }
        return day.cost.asCompactCurrency()
    }

    private var calls: String {
        guard let day, !day.isFuture else { return "—" }
        return "\(day.calls)"
    }

    private var tokens: String {
        guard let day, !day.isFuture else { return "—" }
        return formatTokensForContribution(day.totalTokens)
    }
}

private struct DetailMetric: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .trailing, spacing: 2) {
            Text(label)
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(.tertiary)
            Text(value)
                .font(.codeMono(size: 11, weight: .semibold))
                .foregroundStyle(.primary)
                .lineLimit(1)
        }
        .frame(minWidth: 42, alignment: .trailing)
    }
}

struct ContributionWeek: Identifiable, Equatable {
    let startDate: String
    let days: [ContributionDay]

    var id: String { startDate }
}

struct ContributionDay: Identifiable, Equatable {
    let date: String
    let cost: Double
    let calls: Int
    let inputTokens: Int
    let outputTokens: Int
    let level: Int
    let isToday: Bool
    let isFuture: Bool

    var id: String { date }
    var totalTokens: Int { inputTokens + outputTokens }

    @MainActor var helpText: String {
        if isFuture { return "\(prettyDate(date)): future day" }
        if cost <= 0 && calls == 0 { return "\(prettyDate(date)): no tracked usage" }
        return "\(prettyDate(date)): \(cost.asCompactCurrency()), \(calls) calls, \(formatTokensForContribution(totalTokens)) tokens"
    }
}

struct ContributionStats: Equatable {
    let total: Double
    let activeDays: Int
    let avgActive: Double
    let peakLabel: String
    let currentStreak: Int
}

func contributionLevel(value: Double, maxValue: Double) -> Int {
    guard value > 0, maxValue > 0 else { return 0 }
    let ratio = min(max(value / maxValue, 0), 1)
    if ratio < 0.25 { return 1 }
    if ratio < 0.50 { return 2 }
    if ratio < 0.75 { return 3 }
    return 4
}

func buildContributionWeeks(
    from days: [DailyHistoryEntry],
    weekCount: Int,
    now: Date = Date(),
    calendar: Calendar = gregorianCalendar,
    formatter: DateFormatter = yyyymmdd
) -> [ContributionWeek] {
    let today = calendar.startOfDay(for: now)
    let todayKey = formatter.string(from: today)
    let visibleWeekCount = min(max(weekCount, 1), 52)
    let entryByDate = Dictionary(days.map { ($0.date, $0) }, uniquingKeysWith: { _, new in new })
    guard
        let thisWeekStart = startOfContributionWeek(containing: today, calendar: calendar),
        let firstWeekStart = calendar.date(byAdding: .weekOfYear, value: -(visibleWeekCount - 1), to: thisWeekStart)
    else {
        return []
    }

    var visibleKeys: [String] = []
    for offset in 0..<(visibleWeekCount * 7) {
        guard let date = calendar.date(byAdding: .day, value: offset, to: firstWeekStart) else { continue }
        if date <= today { visibleKeys.append(formatter.string(from: date)) }
    }
    let maxCost = visibleKeys.compactMap { entryByDate[$0]?.cost }.max() ?? 0

    var weeks: [ContributionWeek] = []
    for weekOffset in 0..<visibleWeekCount {
        guard let weekStart = calendar.date(byAdding: .weekOfYear, value: weekOffset, to: firstWeekStart) else { continue }
        let weekStartKey = formatter.string(from: weekStart)
        var contributionDays: [ContributionDay] = []

        for dayOffset in 0..<7 {
            guard let date = calendar.date(byAdding: .day, value: dayOffset, to: weekStart) else { continue }
            let key = formatter.string(from: date)
            let entry = entryByDate[key]
            let isFuture = date > today
            let cost = isFuture ? 0 : (entry?.cost ?? 0)
            contributionDays.append(ContributionDay(
                date: key,
                cost: cost,
                calls: isFuture ? 0 : (entry?.calls ?? 0),
                inputTokens: isFuture ? 0 : (entry?.inputTokens ?? 0),
                outputTokens: isFuture ? 0 : (entry?.outputTokens ?? 0),
                level: isFuture ? 0 : contributionLevel(value: cost, maxValue: maxCost),
                isToday: key == todayKey,
                isFuture: isFuture
            ))
        }

        weeks.append(ContributionWeek(startDate: weekStartKey, days: contributionDays))
    }

    return weeks
}

@MainActor func computeContributionStats(weeks: [ContributionWeek]) -> ContributionStats {
    let days = weeks.flatMap(\.days).filter { !$0.isFuture }
    let active = days.filter { $0.cost > 0 }
    let total = active.reduce(0.0) { $0 + $1.cost }
    let avg = active.isEmpty ? 0 : total / Double(active.count)
    let peak = active.max(by: { $0.cost < $1.cost })
    let peakLabel = peak.map { "\($0.cost.asCompactCurrency()) on \(shortContributionDate($0.date))" } ?? "—"

    var streak = 0
    for day in days.reversed() {
        if day.cost > 0 {
            streak += 1
        } else {
            break
        }
    }

    return ContributionStats(
        total: total,
        activeDays: active.count,
        avgActive: avg,
        peakLabel: peakLabel,
        currentStreak: streak
    )
}

private func startOfContributionWeek(containing date: Date, calendar: Calendar) -> Date? {
    let start = calendar.startOfDay(for: date)
    let weekday = calendar.component(.weekday, from: start)
    let daysFromMonday = (weekday + 5) % 7
    return calendar.date(byAdding: .day, value: -daysFromMonday, to: start)
}

private func shortContributionDate(_ ymd: String) -> String {
    guard let date = yyyymmdd.date(from: ymd) else { return ymd }
    return mmmDayFormat.string(from: date)
}

private func formatTokensForContribution(_ n: Int) -> String {
    if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
    if n >= 1_000 { return String(format: "%.0fK", Double(n) / 1_000) }
    return "\(n)"
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
                    Text("· \(projectDisplayName(top.project))")
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

private func projectDisplayName(_ path: String) -> String {
    path.split(separator: "/").last.map(String.init) ?? path
}

private struct TopProjectsList: View {
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
                        Text(projectDisplayName(project.name))
                            .font(.system(size: 10.5, weight: .medium))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                        Spacer()
                        Text("\(project.sessions) sess")
                            .font(.system(size: 9.5))
                            .foregroundStyle(.quaternary)
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
            case .notBootstrapped, .dormant:
                PlanConnectView(
                    title: "Connect Claude subscription",
                    message: "CodeBurn will read your Claude Code credentials once. macOS will ask permission. After that, the live quota bar shows next to the Claude tab and updates automatically."
                ) { Task { await store.bootstrapSubscription() } }
            case .bootstrapping:
                PlanLoadingView(message: "Reading Claude credentials...")
            case .loading:
                if let usage {
                    loadedBody(usage: usage)
                } else {
                    PlanLoadingView(message: "Reading Claude credentials...")
                }
            case .noCredentials:
                PlanNoCredentialsView(
                    title: "No Claude credentials found",
                    message: "Sign in with Claude Code first: open `claude` in your terminal and type `/login`. Then click Try Again."
                ) { Task { await store.bootstrapSubscription() } }
            case .failed:
                PlanFailedView(
                    error: store.subscriptionError
                ) { refreshSubscriptionThroughAppDelegate() }
            case .transientFailure:
                if let usage {
                    loadedBody(usage: usage)
                } else {
                    PlanFailedView(
                        error: store.subscriptionError ?? "Anthropic temporarily unreachable — retrying."
                    ) { refreshSubscriptionThroughAppDelegate() }
                }
            case let .terminalFailure(reason):
                PlanReconnectView(
                    title: "Reconnect Claude",
                    reason: reason,
                    fallback: "Your Claude session has expired. Open Claude Code in your terminal and type `/login`, then click Reconnect."
                ) { Task { await store.bootstrapSubscription() } }
            case .loaded:
                if let usage {
                    loadedBody(usage: usage)
                } else {
                    PlanLoadingView(message: "Reading Claude credentials...")
                }
            }
        }
    }

    private func refreshSubscriptionThroughAppDelegate() {
        if let delegate = NSApp.delegate as? AppDelegate {
            delegate.refreshSubscriptionNow()
        } else {
            Task { await store.refreshSubscription() }
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
                ForEach(usage.scopedWeekly, id: \.label) { scoped in
                    UtilizationRow(label: "7-day \(scoped.label)", percent: scoped.percent, resetsAt: scoped.resetsAt, projection: projections["scoped_\(scoped.label)"])
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
        var inputs: [(String, Double?, Date?, TimeInterval)] = [
            ("five_hour", usage.fiveHourPercent, usage.fiveHourResetsAt, Self.fiveHourSeconds),
            ("seven_day", usage.sevenDayPercent, usage.sevenDayResetsAt, Self.sevenDaySeconds),
            ("seven_day_opus", usage.sevenDayOpusPercent, usage.sevenDayOpusResetsAt, Self.sevenDaySeconds),
            ("seven_day_sonnet", usage.sevenDaySonnetPercent, usage.sevenDaySonnetResetsAt, Self.sevenDaySeconds),
        ]
        for scoped in usage.scopedWeekly {
            inputs.append(("scoped_\(scoped.label)", scoped.percent, scoped.resetsAt, Self.sevenDaySeconds))
        }
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
    let message: String

    var body: some View {
        VStack(spacing: 8) {
            ProgressView().scaleEffect(0.8)
            Text(message)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 16)
    }
}

private struct PlanNoCredentialsView: View {
    let title: String
    let message: String
    let onRetry: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "key.slash")
                .font(.system(size: 24))
                .foregroundStyle(.tertiary)
            Text(title)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.primary)
            Text(.init(message))
                .font(.system(size: 10.5))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 280)
            Button("Try Again", action: onRetry)
            .controlSize(.small)
            .buttonStyle(.borderedProminent)
            .tint(Theme.brandAccent)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 16)
    }
}

private struct PlanFailedView: View {
    let error: String?
    let onRetry: () -> Void

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
            Button("Retry", action: onRetry)
            .controlSize(.small)
            .buttonStyle(.borderedProminent)
            .tint(Theme.brandAccent)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
    }
}

/// Shown the very first time a user opens the Plan tab. Clicking Connect is the
/// only path to triggering the provider's credential read (for Claude, the
/// macOS keychain prompt) — the menubar app does not touch credentials at
/// startup.
private struct PlanConnectView: View {
    let title: String
    let message: String
    let onConnect: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "link.circle")
                .font(.system(size: 26))
                .foregroundStyle(Theme.brandAccent)
            Text(title)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.primary)
            Text(.init(message))
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
/// which reads the provider's credentials source again and writes a fresh copy
/// to our own keychain item.
private struct PlanReconnectView: View {
    let title: String
    let reason: String?
    let fallback: String
    let onReconnect: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "arrow.triangle.2.circlepath.circle")
                .font(.system(size: 24))
                .foregroundStyle(.red)
            Text(title)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.primary)
            Text(reason ?? fallback)
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
                    title: "Connect ChatGPT subscription",
                    message: "CodeBurn will read your Codex CLI credentials once. After that, the live quota bar shows next to the Codex tab and updates automatically."
                ) { Task { await store.bootstrapCodex() } }
            case .bootstrapping:
                PlanLoadingView(message: "Reading Codex CLI credentials...")
            case .loading:
                if let usage = store.codexUsage {
                    loadedBody(usage: usage)
                } else {
                    PlanLoadingView(message: "Reading Codex CLI credentials...")
                }
            case .noCredentials:
                PlanNoCredentialsView(
                    title: "No Codex credentials found",
                    message: "Sign in with Codex first: run `codex login` in your terminal. Then click Try Again."
                ) { Task { await store.bootstrapCodex() } }
            case .failed:
                PlanFailedView(
                    error: store.codexError
                ) { Task { await store.refreshCodex() } }
            case .transientFailure:
                if let usage = store.codexUsage {
                    loadedBody(usage: usage)
                } else {
                    PlanFailedView(
                        error: store.codexError ?? "ChatGPT temporarily unreachable — retrying."
                    ) { Task { await store.refreshCodex() } }
                }
            case let .terminalFailure(reason):
                PlanReconnectView(
                    title: "Reconnect Codex",
                    reason: reason,
                    fallback: "Your ChatGPT session has expired. Run `codex login` in your terminal, then click Reconnect."
                ) { Task { await store.bootstrapCodex() } }
            case .loaded:
                if let usage = store.codexUsage {
                    loadedBody(usage: usage)
                } else {
                    PlanLoadingView(message: "Reading Codex CLI credentials...")
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
                    projection: pace(for: primary)
                )
            }
            if let secondary = usage.secondary {
                UtilizationRow(
                    label: "\(secondary.windowLabel) window",
                    percent: secondary.usedPercent,
                    resetsAt: secondary.resetsAt,
                    projection: pace(for: secondary)
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
                        projection: pace(for: p)
                    )
                }
                if let s = limit.secondary, s.usedPercent > 0 {
                    UtilizationRow(
                        label: "\(limit.name) · \(s.windowLabel)",
                        percent: s.usedPercent,
                        resetsAt: s.resetsAt,
                        projection: pace(for: s)
                    )
                }
            }
            // Limit-reset credits the account is holding. Hidden at zero so
            // plans that never receive these grants see no extra row.
            if let resets = usage.resetCredits, resets.availableCount > 0 {
                HStack(alignment: .firstTextBaseline) {
                    Text("Limit resets")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text(resetCreditsLabel(resets))
                        .font(.system(size: 10.5))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 4)
        .padding(.bottom, 8)
    }

    /// Codex has no snapshot history yet, so this is the linear phase-1 pace
    /// (#726): deficit/reserve everywhere, projection and ETA only where the
    /// window is long enough for a whole-window rate to be defensible.
    private func pace(for window: CodexUsage.Window) -> WindowProjection? {
        guard let result = QuotaPace.evaluate(
            usedPercent: window.usedPercent,
            resetsAt: window.resetsAt,
            windowSeconds: window.limitWindowSeconds
        ) else { return nil }
        return WindowProjection(
            percent: result.projectedPercent,
            willOverflow: result.willOverflow,
            hitsLimitAt: result.hitsLimitAt,
            source: .linear,
            deltaPercent: result.deltaPercent,
            compact: TimeInterval(window.limitWindowSeconds) <= QuotaPace.etaSuppressionMaxSeconds
        )
    }

    private func resetCreditsLabel(_ resets: CodexUsage.ResetCredits) -> String {
        let count = "\(resets.availableCount) available"
        guard let next = resets.nextExpiresAt else { return count }
        return "\(count) · next expires \(relativeReset(next))"
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
    /// used% − expected%; set by pace-aware callers (#726) to get the
    /// deficit/reserve caption. Nil keeps the original caption wording.
    var deltaPercent: Double? = nil
    /// Stage-only caption: deficit/reserve without projection or ETA. Used on
    /// short windows where a linear extrapolation isn't defensible.
    var compact: Bool = false
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
        // Deficit-first wording (#726): pace state up front, projection or
        // ETA after it, and neither on windows flagged compact.
        if let delta = projection.deltaPercent {
            if abs(delta) <= 2 {
                return projection.compact ? "On pace" : "On pace: \(projected) at reset"
            }
            let stage = delta > 0
                ? String(format: "%.0f%% in deficit", delta)
                : String(format: "%.0f%% in reserve", -delta)
            if projection.compact { return stage }
            if projection.willOverflow, let hit = projection.hitsLimitAt {
                return "\(stage) · hits 100% \(relativeReset(hit))"
            }
            return "\(stage) · \(projected) at reset"
        }
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
