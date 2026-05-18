import SwiftUI

// MARK: - Shared Components

struct SectionCaption: View {
    let text: String
    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(Theme.brandAccent.opacity(0.7))
                .frame(width: 3, height: 3)
            Text(text)
                .font(.system(size: 11.5, weight: .medium))
                .foregroundStyle(.secondary)
                .tracking(-0.1)
        }
    }
}

struct CollapsibleSection<Trailing: View, Content: View>: View {
    let caption: String
    @Binding var isExpanded: Bool
    let trailing: Trailing
    let content: Content

    init(
        caption: String,
        isExpanded: Binding<Bool>,
        @ViewBuilder trailing: () -> Trailing,
        @ViewBuilder content: () -> Content
    ) {
        self.caption = caption
        self._isExpanded = isExpanded
        self.trailing = trailing()
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Button {
                withAnimation(.easeInOut(duration: 0.18)) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    HStack(spacing: 5) {
                        Circle()
                            .fill(Theme.brandAccent.opacity(0.7))
                            .frame(width: 3, height: 3)
                        Text(caption)
                            .font(.system(size: 11.5, weight: .medium))
                            .tracking(-0.1)
                    }
                    Spacer()
                    trailing
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .opacity(0.55)
                }
                .foregroundStyle(.secondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                content.transition(.opacity)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
    }
}

extension CollapsibleSection where Trailing == EmptyView {
    init(caption: String, isExpanded: Binding<Bool>, @ViewBuilder content: () -> Content) {
        self.init(caption: caption, isExpanded: isExpanded, trailing: { EmptyView() }, content: content)
    }
}

struct FixedBar: View {
    let fraction: Double
    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 2).fill(.secondary.opacity(0.15))
                RoundedRectangle(cornerRadius: 2)
                    .fill(Theme.brandAccent)
                    .frame(width: max(0, min(geo.size.width, geo.size.width * CGFloat(fraction))))
            }
        }
    }
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

// MARK: - Insight Pill Switcher

enum InsightMode: String, CaseIterable, Identifiable {
    case trend = "Trend"
    case forecast = "Forecast"
    case pulse = "Pulse"
    case stats = "Stats"
    var id: String { rawValue }
}

struct InsightSection: View {
    @ObservedObject var store: SessionStore
    @State private var selected: InsightMode = .trend

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 4) {
                ForEach(InsightMode.allCases) { mode in
                    Button { selected = mode } label: {
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

            switch selected {
            case .trend: TrendInsight(store: store)
            case .forecast: ForecastInsight(store: store)
            case .pulse: PulseInsight(store: store)
            case .stats: StatsInsight(store: store)
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 10)
    }
}

// MARK: - Trend Insight

private let trendDays = 19
private let trendBarWidth: CGFloat = 13
private let trendBarGap: CGFloat = 4
private let trendChartHeight: CGFloat = 90

private struct TrendBar: Identifiable {
    var id: String { date }
    let date: String
    let cost: Double
    let inputTokens: Double
    let outputTokens: Double
    let isToday: Bool
    let topModels: [(name: String, cost: Double)]
    var tokens: Double { inputTokens + outputTokens }
}

private struct TrendInsight: View {
    @ObservedObject var store: SessionStore

    var body: some View {
        let bars = buildBars()
        let totalCost = bars.reduce(0.0) { $0 + $1.cost }
        let totalTokens = bars.reduce(0.0) { $0 + $1.tokens }
        let useTokens = totalTokens > 0
        let metric: (TrendBar) -> Double = useTokens ? { $0.tokens } : { $0.cost }
        let maxValue = max(bars.map(metric).max() ?? 1, 0.01)
        let avgValue = bars.isEmpty ? 0 : bars.map(metric).reduce(0, +) / Double(bars.count)
        let peakBar = bars.filter({ metric($0) > 0 }).max(by: { metric($0) < metric($1) })
        let yesterdayBar = bars.dropLast().last

        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Last \(trendDays) days")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.tertiary)
                    Text(useTokens ? "\(formatTokens(totalTokens)) tokens" : totalCost.asCurrency())
                        .font(.system(size: 18, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(.primary)
                }
                Spacer()
                if let delta = deltaPercent(bars: bars, metric: metric) {
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

            TrendChart(bars: bars, maxValue: maxValue, avgValue: avgValue, metric: metric) { v in
                useTokens ? "\(formatTokens(v)) tok" : v.asCompactCurrency()
            }

            HStack(spacing: 14) {
                MiniStat(label: "Avg/day", value: formatValue(avgValue, useTokens: useTokens))
                MiniStat(label: "Peak", value: peakLabel(peakBar, metric: metric, useTokens: useTokens))
                MiniStat(label: "Yesterday", value: yesterdayBar.map { formatValue(metric($0), useTokens: useTokens) } ?? "—")
            }
        }
    }

    private func formatValue(_ v: Double, useTokens: Bool) -> String {
        useTokens ? "\(formatTokens(v)) tok" : v.asCompactCurrency()
    }

    private func peakLabel(_ peak: TrendBar?, metric: (TrendBar) -> Double, useTokens: Bool) -> String {
        guard let peak, metric(peak) > 0 else { return "—" }
        let parts = peak.date.split(separator: "-")
        let short = parts.count == 3 ? "\(parts[1])/\(parts[2])" : peak.date
        return "\(formatValue(metric(peak), useTokens: useTokens)) on \(short)"
    }

    private func deltaPercent(bars: [TrendBar], metric: (TrendBar) -> Double) -> Double? {
        let sessions = filteredSessions
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"

        guard let priorStart = calendar.date(byAdding: .day, value: -(2 * trendDays - 1), to: today),
              let thisStart = calendar.date(byAdding: .day, value: -(trendDays - 1), to: today)
        else { return nil }

        let thisTotal = bars.map(metric).reduce(0, +)
        var priorTotal = 0.0
        for session in sessions {
            let sd = calendar.startOfDay(for: session.startDate)
            if sd >= priorStart && sd < thisStart {
                priorTotal += session.cost
            }
        }
        guard priorTotal > 0 else { return nil }
        return ((thisTotal - priorTotal) / priorTotal) * 100
    }

    private func buildBars() -> [TrendBar] {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        let todayKey = formatter.string(from: today)

        let sessions = filteredSessions
        var costByDate: [String: Double] = [:]
        var inputByDate: [String: Double] = [:]
        var outputByDate: [String: Double] = [:]
        var modelsByDate: [String: [String: Double]] = [:]

        for session in sessions {
            for turn in session.turns {
                let key = formatter.string(from: turn.timestamp)
                costByDate[key, default: 0] += turn.cost
                inputByDate[key, default: 0] += Double(turn.inputTokens)
                outputByDate[key, default: 0] += Double(turn.outputTokens)
                modelsByDate[key, default: [:]][turn.model, default: 0] += turn.cost
            }
            if session.turns.isEmpty {
                let key = formatter.string(from: session.startDate)
                costByDate[key, default: 0] += session.cost
            }
        }

        return (0..<trendDays).reversed().map { offset in
            let date = calendar.date(byAdding: .day, value: -offset, to: today)!
            let key = formatter.string(from: date)
            let models = (modelsByDate[key] ?? [:]).sorted(by: { $0.value > $1.value }).prefix(3).map { ($0.key, $0.value) }
            return TrendBar(
                date: key,
                cost: costByDate[key] ?? 0,
                inputTokens: inputByDate[key] ?? 0,
                outputTokens: outputByDate[key] ?? 0,
                isToday: key == todayKey,
                topModels: models
            )
        }
    }

    private var filteredSessions: [ParsedSession] {
        if store.selectedProvider == "all" {
            return store.providers.flatMap(\.sessions)
        }
        return store.providers.first(where: { $0.name == store.selectedProvider })?.sessions ?? []
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
                    BarColumn(bar: bar, value: metric(bar), maxValue: maxValue, isHovered: hoveredBarID == bar.id)
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
            if let bar = bars.first(where: { $0.id == hoveredBarID }) {
                BarTooltipCard(bar: bar, value: metric(bar), formatValue: formatValue)
                    .padding(.top, 6)
                    .offset(y: 92)
                    .transition(.opacity)
                    .allowsHitTesting(false)
                    .zIndex(10)
            }
        }
        .animation(.easeInOut(duration: 0.12), value: hoveredBarID)
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
    let value: Double
    let formatValue: (Double) -> String
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text(prettyDate(bar.date))
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(colorScheme == .dark ? .black : .white)
                Spacer()
                Text(formatValue(value))
                    .font(.codeMono(size: 10.5, weight: .semibold))
                    .foregroundStyle(Theme.brandAccent)
            }
            if !bar.topModels.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(bar.topModels.prefix(3), id: \.name) { m in
                        HStack(spacing: 6) {
                            Circle().fill(Theme.brandAccent.opacity(0.7)).frame(width: 4, height: 4)
                            Text(m.name)
                                .font(.system(size: 10, weight: .medium))
                                .foregroundStyle(colorScheme == .dark ? .black : .white)
                            Spacer()
                            Text(m.cost.asCompactCurrency())
                                .font(.codeMono(size: 9.5, weight: .medium))
                                .foregroundStyle(colorScheme == .dark ? Color.black.opacity(0.7) : Color.white.opacity(0.72))
                        }
                    }
                }
            }
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(colorScheme == .dark ? Color.white : Color.black)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(colorScheme == .dark ? Color.black.opacity(0.12) : Color.white.opacity(0.12), lineWidth: 0.5)
        )
        .shadow(color: Color.black.opacity(0.35), radius: 10, y: 4)
    }
}

// MARK: - Forecast Insight

private struct ForecastInsight: View {
    @ObservedObject var store: SessionStore

    var body: some View {
        let stats = computeForecast()
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
                MiniStat(label: "Avg/day (this wk)", value: stats.weekAvg.asCompactCurrency())
                MiniStat(label: "Yesterday", value: stats.yesterday.asCompactCurrency())
                MiniStat(label: "Last 7d", value: stats.weekTotal.asCompactCurrency())
            }
        }
    }

    private func computeForecast() -> (mtd: Double, projection: Double, weekAvg: Double, weekTotal: Double, yesterday: Double) {
        let calendar = Calendar.current
        let now = Date()
        let today = calendar.startOfDay(for: now)
        let comps = calendar.dateComponents([.year, .month, .day], from: now)
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"

        let sessions = filteredSessions
        var costByDate: [String: Double] = [:]
        for session in sessions {
            let key = formatter.string(from: session.startDate)
            costByDate[key, default: 0] += session.cost
        }

        let firstOfMonth = calendar.date(from: DateComponents(year: comps.year, month: comps.month, day: 1))!
        let firstStr = formatter.string(from: firstOfMonth)
        let daysInMonth = calendar.range(of: .day, in: .month, for: firstOfMonth)?.count ?? 30
        let dayOfMonth = comps.day ?? 1

        let mtd = costByDate.filter { $0.key >= firstStr }.values.reduce(0, +)
        let avgPerDay = dayOfMonth > 0 ? mtd / Double(dayOfMonth) : 0
        let projection = avgPerDay * Double(daysInMonth)

        let weekStart = calendar.date(byAdding: .day, value: -6, to: today)!
        let weekStartStr = formatter.string(from: weekStart)
        let weekTotal = costByDate.filter { $0.key >= weekStartStr }.values.reduce(0, +)
        let weekAvg = weekTotal / 7.0

        let yesterdayStr = formatter.string(from: calendar.date(byAdding: .day, value: -1, to: today)!)
        let yesterday = costByDate[yesterdayStr] ?? 0

        return (mtd, projection, weekAvg, weekTotal, yesterday)
    }

    private var filteredSessions: [ParsedSession] {
        if store.selectedProvider == "all" {
            return store.providers.flatMap(\.sessions)
        }
        return store.providers.first(where: { $0.name == store.selectedProvider })?.sessions ?? []
    }
}

// MARK: - Pulse Insight

private struct PulseInsight: View {
    @ObservedObject var store: SessionStore

    var body: some View {
        let sessions = filteredSessions
        let totalInput = sessions.reduce(0) { $0 + $1.inputTokens }
        let totalCacheRead = sessions.reduce(0) { $0 + $1.cacheReadTokens }
        let cacheHit = totalInput > 0 ? Double(totalCacheRead) / Double(totalInput + totalCacheRead) * 100 : 0
        let costPerSession = sessions.isEmpty ? 0 : sessions.reduce(0.0) { $0 + $1.cost } / Double(sessions.count)

        HStack(spacing: 10) {
            PulseTile(label: "Cache hit", value: totalCacheRead > 0 ? String(format: "%.0f%%", cacheHit) : "—", color: Theme.brandAccent)
            PulseTile(label: "Cost / session", value: sessions.isEmpty ? "—" : costPerSession.asCompactCurrency(), color: .secondary)
            PulseTile(label: "Sessions", value: "\(sessions.count)", color: Theme.brandAccent)
        }
    }

    private var filteredSessions: [ParsedSession] {
        if store.selectedProvider == "all" {
            return store.providers.flatMap(\.sessions)
        }
        return store.providers.first(where: { $0.name == store.selectedProvider })?.sessions ?? []
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

// MARK: - Stats Insight

private struct StatsInsight: View {
    @ObservedObject var store: SessionStore

    var body: some View {
        let stats = computeStats()
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 14) {
                VStack(alignment: .leading, spacing: 8) {
                    StatRow(label: "Favorite model", value: stats.favoriteModel)
                    StatRow(label: "Active days", value: stats.activeDaysFraction)
                    StatRow(label: "Peak day spend", value: stats.peakDaySpend)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                VStack(alignment: .leading, spacing: 8) {
                    StatRow(label: "Sessions today", value: "\(stats.sessionsToday)")
                    StatRow(label: "Current streak", value: stats.currentStreak)
                    StatRow(label: "Longest streak", value: stats.longestStreak)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            if stats.lifetimeTotal > 0 {
                Divider().opacity(0.5)
                HStack {
                    Text("Total tracked spend")
                        .font(.system(size: 10.5, weight: .medium))
                        .foregroundStyle(.tertiary)
                    Spacer()
                    Text(stats.lifetimeTotal.asCurrency())
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(Theme.brandAccent)
                }
            }
        }
    }

    private struct Stats {
        let favoriteModel: String
        let activeDaysFraction: String
        let peakDaySpend: String
        let sessionsToday: Int
        let currentStreak: String
        let longestStreak: String
        let lifetimeTotal: Double
    }

    private func computeStats() -> Stats {
        let sessions = filteredSessions
        let allTurns = sessions.flatMap(\.turns)
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"

        let modelCosts = Dictionary(grouping: allTurns, by: \.model)
            .mapValues { $0.reduce(0.0) { $0 + $1.cost } }
        let favoriteModel = modelCosts.max(by: { $0.value < $1.value })?.key ?? "—"

        var costByDate: [String: Double] = [:]
        for session in sessions {
            let key = formatter.string(from: session.startDate)
            costByDate[key, default: 0] += session.cost
        }

        let comps = calendar.dateComponents([.year, .month, .day], from: Date())
        let firstOfMonth = calendar.date(from: DateComponents(year: comps.year, month: comps.month, day: 1))!
        let firstStr = formatter.string(from: firstOfMonth)
        let daysInMonth = calendar.range(of: .day, in: .month, for: firstOfMonth)?.count ?? 30
        let activeDays = costByDate.filter { $0.key >= firstStr && $0.value > 0 }.count

        let peak = costByDate.max(by: { $0.value < $1.value })
        let peakDaySpend = peak.map { $0.value.asCompactCurrency() } ?? "—"

        let todayStr = formatter.string(from: today)
        let sessionsToday = sessions.filter { formatter.string(from: $0.startDate) == todayStr }.count

        var currentStreak = 0
        for offset in 0..<400 {
            guard let d = calendar.date(byAdding: .day, value: -offset, to: today) else { break }
            let key = formatter.string(from: d)
            if (costByDate[key] ?? 0) > 0 { currentStreak += 1 } else { break }
        }

        var longestStreak = 0
        var running = 0
        let sortedDates = costByDate.keys.sorted()
        if let first = sortedDates.first, let last = sortedDates.last,
           let start = formatter.date(from: first), let end = formatter.date(from: last) {
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

        let lifetime = sessions.reduce(0.0) { $0 + $1.cost }

        return Stats(
            favoriteModel: favoriteModel,
            activeDaysFraction: "\(activeDays)/\(daysInMonth)",
            peakDaySpend: peakDaySpend,
            sessionsToday: sessionsToday,
            currentStreak: currentStreak == 0 ? "—" : "\(currentStreak) days",
            longestStreak: longestStreak == 0 ? "—" : "\(longestStreak) days",
            lifetimeTotal: lifetime
        )
    }

    private var filteredSessions: [ParsedSession] {
        if store.selectedProvider == "all" {
            return store.providers.flatMap(\.sessions)
        }
        return store.providers.first(where: { $0.name == store.selectedProvider })?.sessions ?? []
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

// MARK: - Activity Section (Projects)

struct ActivitySection: View {
    @ObservedObject var store: SessionStore
    @State private var isExpanded: Bool = true

    var body: some View {
        let projects = topProjects
        if projects.isEmpty { return AnyView(EmptyView()) }
        let maxCost = projects.first?.cost ?? 1

        return AnyView(
            CollapsibleSection(
                caption: "Activity",
                isExpanded: $isExpanded,
                trailing: {
                    HStack(spacing: 8) {
                        Text("Cost").frame(minWidth: 54, alignment: .trailing)
                        Text("Turns").frame(minWidth: 52, alignment: .trailing)
                    }
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.tertiary)
                    .tracking(-0.05)
                }
            ) {
                VStack(alignment: .leading, spacing: 7) {
                    ForEach(projects, id: \.name) { project in
                        HStack(spacing: 8) {
                            FixedBar(fraction: project.cost / maxCost)
                                .frame(width: 56, height: 6)
                            Text(project.name)
                                .font(.system(size: 12.5, weight: .medium))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Text(project.cost.asCompactCurrency())
                                .font(.codeMono(size: 12, weight: .medium))
                                .tracking(-0.2)
                                .frame(minWidth: 54, alignment: .trailing)
                            Text("\(project.turns)")
                                .font(.system(size: 11))
                                .monospacedDigit()
                                .foregroundStyle(.secondary)
                                .frame(minWidth: 52, alignment: .trailing)
                        }
                        .padding(.vertical, 1)
                    }
                }
            }
        )
    }

    private struct ProjectEntry {
        let name: String
        let cost: Double
        let turns: Int
    }

    private var topProjects: [ProjectEntry] {
        let sessions = filteredSessions
        var byCost: [String: Double] = [:]
        var byTurns: [String: Int] = [:]
        for s in sessions {
            byCost[s.project, default: 0] += s.cost
            byTurns[s.project, default: 0] += s.turns.count
        }
        return byCost.map { ProjectEntry(name: $0.key, cost: $0.value, turns: byTurns[$0.key] ?? 0) }
            .sorted(by: { $0.cost > $1.cost })
            .prefix(8)
            .map { $0 }
    }

    private var filteredSessions: [ParsedSession] {
        if store.selectedProvider == "all" {
            return store.providers.flatMap(\.sessions)
        }
        return store.providers.first(where: { $0.name == store.selectedProvider })?.sessions ?? []
    }
}

// MARK: - Models Section

struct ModelsSection: View {
    @ObservedObject var store: SessionStore
    @State private var isExpanded: Bool = true

    var body: some View {
        let models = topModels
        if models.isEmpty { return AnyView(EmptyView()) }
        let maxCost = models.first?.cost ?? 1

        return AnyView(
            CollapsibleSection(
                caption: "Models",
                isExpanded: $isExpanded,
                trailing: {
                    HStack(spacing: 8) {
                        Text("Cost").frame(minWidth: 54, alignment: .trailing)
                        Text("Calls").frame(minWidth: 52, alignment: .trailing)
                    }
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.tertiary)
                    .tracking(-0.05)
                }
            ) {
                VStack(alignment: .leading, spacing: 7) {
                    ForEach(models, id: \.name) { model in
                        HStack(spacing: 8) {
                            FixedBar(fraction: model.cost / maxCost)
                                .frame(width: 56, height: 6)
                            Text(model.name)
                                .font(.system(size: 12.5, weight: .medium))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .lineLimit(1)
                            Text(model.cost.asCompactCurrency())
                                .font(.codeMono(size: 12, weight: .medium))
                                .tracking(-0.2)
                                .frame(minWidth: 54, alignment: .trailing)
                            Text("\(model.calls)")
                                .font(.system(size: 11))
                                .monospacedDigit()
                                .foregroundStyle(.secondary)
                                .frame(minWidth: 52, alignment: .trailing)
                        }
                        .padding(.vertical, 1)
                    }

                    TokensLine(store: store)
                        .padding(.top, 5)
                }
            }
        )
    }

    private struct ModelEntry {
        let name: String
        let cost: Double
        let calls: Int
    }

    private var topModels: [ModelEntry] {
        let sessions = filteredSessions
        let allTurns = sessions.flatMap(\.turns)
        var byCost: [String: Double] = [:]
        var byCalls: [String: Int] = [:]
        for t in allTurns {
            byCost[t.model, default: 0] += t.cost
            byCalls[t.model, default: 0] += 1
        }
        return byCost.map { ModelEntry(name: $0.key, cost: $0.value, calls: byCalls[$0.key] ?? 0) }
            .sorted(by: { $0.cost > $1.cost })
            .prefix(6)
            .map { $0 }
    }

    private var filteredSessions: [ParsedSession] {
        if store.selectedProvider == "all" {
            return store.providers.flatMap(\.sessions)
        }
        return store.providers.first(where: { $0.name == store.selectedProvider })?.sessions ?? []
    }
}

private struct TokensLine: View {
    @ObservedObject var store: SessionStore

    var body: some View {
        let sessions = store.selectedProvider == "all"
            ? store.providers.flatMap(\.sessions)
            : store.providers.first(where: { $0.name == store.selectedProvider })?.sessions ?? []
        let totalIn = sessions.reduce(0) { $0 + $1.inputTokens }
        let totalOut = sessions.reduce(0) { $0 + $1.outputTokens }
        let totalCacheRead = sessions.reduce(0) { $0 + $1.cacheReadTokens }
        let cacheHit = (totalIn + totalCacheRead) > 0
            ? String(format: "%.0f", Double(totalCacheRead) / Double(totalIn + totalCacheRead) * 100)
            : "0"

        HStack(spacing: 4) {
            Text("Tokens")
                .foregroundStyle(.tertiary)
            Text(formatTokens(totalIn) + " in")
                .foregroundStyle(.secondary)
            Text("·")
                .foregroundStyle(.tertiary)
            Text(formatTokens(totalOut) + " out")
                .foregroundStyle(.secondary)
            Text("·")
                .foregroundStyle(.tertiary)
            Text(cacheHit + "% cache hit")
                .foregroundStyle(.secondary)
            Spacer()
        }
        .font(.system(size: 10.5))
        .monospacedDigit()
    }
}

// MARK: - Helpers

private func prettyDate(_ ymd: String) -> String {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd"
    guard let date = formatter.date(from: ymd) else { return ymd }
    let pretty = DateFormatter()
    pretty.dateFormat = "EEE MMM d"
    return pretty.string(from: date)
}

func formatTokens(_ n: Double) -> String {
    if n >= 1_000_000 { return String(format: "%.1fM", n / 1_000_000) }
    if n >= 1_000 { return String(format: "%.0fK", n / 1_000) }
    return String(format: "%.0f", n)
}

func formatTokens(_ n: Int) -> String {
    formatTokens(Double(n))
}
