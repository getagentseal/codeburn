import SwiftUI

struct HistoryWindowView: View {
    @Environment(AppStore.self) private var store

    private var days: [DailyHistoryEntry] {
        Array(store.payload.history.daily.reversed())
    }

    private var totalCost: Double {
        store.payload.history.daily.reduce(0) { $0 + $1.cost }
    }

    private var totalCalls: Int {
        store.payload.history.daily.reduce(0) { $0 + $1.calls }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            if days.isEmpty {
                emptyState
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        columnHeader
                        ForEach(days, id: \.date) { day in
                            HistoryDayRow(day: day)
                            Divider()
                        }
                    }
                }
            }
        }
        .frame(minWidth: 560, minHeight: 420)
    }

    private var header: some View {
        HStack(spacing: 18) {
            VStack(alignment: .leading, spacing: 2) {
                Text("History")
                    .font(.system(size: 16, weight: .semibold))
                Text("\(store.selectionLabel) - \(days.count) days")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            Spacer()
            HistoryStat(label: "Tracked spend", value: totalCost.asCurrency())
            HistoryStat(label: "Calls", value: totalCalls.asThousandsSeparated())
        }
        .padding(16)
    }

    private var columnHeader: some View {
        HStack(spacing: 12) {
            Text("Date").frame(width: 92, alignment: .leading)
            Text("Spend").frame(width: 82, alignment: .trailing)
            Text("Calls").frame(width: 60, alignment: .trailing)
            Text("Tokens").frame(width: 92, alignment: .trailing)
            Text("Top models").frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color.secondary.opacity(0.08))
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "clock.arrow.circlepath")
                .font(.system(size: 30))
                .foregroundStyle(.tertiary)
            Text("No history loaded")
                .font(.system(size: 13, weight: .semibold))
            Text("Refresh CodeBurn, then open History again.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct HistoryStat: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .trailing, spacing: 2) {
            Text(label)
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.codeMono(size: 12, weight: .semibold))
                .monospacedDigit()
        }
    }
}

private struct HistoryDayRow: View {
    let day: DailyHistoryEntry

    var body: some View {
        HStack(spacing: 12) {
            Text(day.date)
                .font(.codeMono(size: 11))
                .frame(width: 92, alignment: .leading)
            Text(day.cost.asCompactCurrency())
                .font(.codeMono(size: 11, weight: .semibold))
                .frame(width: 82, alignment: .trailing)
            Text(day.calls.asThousandsSeparated())
                .font(.codeMono(size: 11))
                .frame(width: 60, alignment: .trailing)
            Text(compactTokens(day.inputTokens + day.outputTokens))
                .font(.codeMono(size: 11))
                .frame(width: 92, alignment: .trailing)
            Text(topModels)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    private var topModels: String {
        let names = day.topModels.prefix(3).map(\.name)
        return names.isEmpty ? "No model breakdown" : names.joined(separator: ", ")
    }

    private func compactTokens(_ n: Int) -> String {
        let d = Double(n)
        if d >= 1_000_000_000 { return String(format: "%.1fB", d / 1_000_000_000) }
        if d >= 1_000_000 { return String(format: "%.1fM", d / 1_000_000) }
        if d >= 1_000 { return String(format: "%.0fK", d / 1_000) }
        return "\(n)"
    }
}
