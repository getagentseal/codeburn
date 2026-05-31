import SwiftUI

struct PeriodSegmentedControl: View {
    @Environment(AppStore.self) private var store
    @State private var showingCalendar = false

    var body: some View {
        HStack(spacing: 1) {
            ForEach(Period.allCases) { period in
                let isActive = !store.isDayMode && store.selectedPeriod == period
                Button {
                    showingCalendar.toggle()
                } label: {
                    Text(period.rawValue)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(isActive ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 4)
                        .contentShape(Rectangle())
                }
                .frame(maxWidth: .infinity)
                .buttonStyle(.plain)
                .background(
                    RoundedRectangle(cornerRadius: 5)
                        .fill(isActive ? Color(NSColor.windowBackgroundColor).opacity(0.85) : .clear)
                        .shadow(color: .black.opacity(isActive ? 0.06 : 0), radius: 1, y: 0.5)
                )
            }

            Button {
                showingCalendar.toggle()
            } label: {
                Image(systemName: "calendar")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(store.isDayMode ? Theme.brandAccent : .secondary)
                    .frame(width: 28)
                    .padding(.vertical, 4)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .background(
                RoundedRectangle(cornerRadius: 5)
                    .fill(store.isDayMode ? Color(NSColor.windowBackgroundColor).opacity(0.85) : .clear)
                    .shadow(color: .black.opacity(store.isDayMode ? 0.06 : 0), radius: 1, y: 0.5)
            )
            .popover(isPresented: $showingCalendar, arrowEdge: .bottom) {
                CalendarPopover(isPresented: $showingCalendar)
                    .environment(store)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 10)
    }

    private var selectedDayBinding: Binding<Date> {
        Binding(
            get: {
                store.selectedDayDate ??
                    Calendar.current.startOfDay(for: Calendar.current.date(byAdding: .day, value: -1, to: Date()) ?? Date())
            },
            set: {
                store.switchTo(day: $0)
                showingCalendar = false
            }
        )
    }

    private var dayButtonTitle: String {
        let date = store.selectedDayDate ??
            Calendar.current.startOfDay(for: Calendar.current.date(byAdding: .day, value: -1, to: Date()) ?? Date())
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d, yyyy"
        return formatter.string(from: date)
    }
}

private struct CalendarPopover: View {
    @Environment(AppStore.self) private var store
    @Binding var isPresented: Bool
    @State private var displayMonth = Date()
    @State private var pending: Set<String> = []

    private let calendar = Calendar.current
    private let weekdays = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]
    private let cellSize: CGFloat = 30

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button { shiftMonth(-1) } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.secondary)
                        .frame(width: 24, height: 24)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                Spacer()

                Text(monthYearLabel)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.primary)

                Spacer()

                Button { shiftMonth(1) } label: {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(canGoForward ? .secondary : Color.secondary.opacity(0.3))
                        .frame(width: 24, height: 24)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!canGoForward)
            }
            .padding(.horizontal, 10)
            .padding(.top, 10)
            .padding(.bottom, 6)

            HStack(spacing: 0) {
                ForEach(weekdays, id: \.self) { day in
                    Text(day)
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(.tertiary)
                        .frame(width: cellSize, height: 16)
                }
            }
            .padding(.bottom, 2)

            LazyVGrid(columns: Array(repeating: GridItem(.fixed(cellSize), spacing: 0), count: 7), spacing: 2) {
                ForEach(dayCells, id: \.id) { cell in
                    DayCellView(
                        cell: cell,
                        isSelected: pending.contains(cell.dateString),
                        isToday: cell.dateString == todayString,
                        isFuture: cell.dateString > todayString
                    ) {
                        toggleDay(cell.dateString)
                    }
                }
            }
            .padding(.horizontal, 6)

            HStack(spacing: 8) {
                if !pending.isEmpty {
                    Button("Clear") {
                        pending = []
                    }
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
                    .buttonStyle(.plain)
                }

                Spacer()

                Text(selectionSummary)
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)

                Spacer()

                Button {
                    if !pending.isEmpty {
                        store.switchTo(days: pending)
                    } else {
                        store.switchTo(period: store.selectedPeriod)
                    }
                    isPresented = false
                } label: {
                    Text("Done")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 5)
                        .background(
                            RoundedRectangle(cornerRadius: 5)
                                .fill(pending.isEmpty ? Color.secondary.opacity(0.3) : Theme.brandAccent)
                        )
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 10)
            .padding(.top, 8)
            .padding(.bottom, 10)
        }
        .frame(width: cellSize * 7 + 24)
        .onAppear {
            pending = store.selectedDays
            if let first = store.selectedDays.sorted().first,
               let date = AppStore.dayFormatter.date(from: first) {
                displayMonth = date
            }
        }
    }

    private var todayString: String {
        AppStore.dayString(from: Date())
    }

    private var monthYearLabel: String {
        let f = DateFormatter()
        f.dateFormat = "MMMM yyyy"
        return f.string(from: displayMonth)
    }

    private var canGoForward: Bool {
        let nextMonth = calendar.date(byAdding: .month, value: 1, to: displayMonth) ?? displayMonth
        return calendar.startOfDay(for: nextMonth) <= calendar.startOfDay(for: Date())
    }

    private var selectionSummary: String {
        if pending.isEmpty { return "Pick dates" }
        if pending.count == 1 { return "1 day" }
        return "\(pending.count) days"
    }

    private func shiftMonth(_ delta: Int) {
        if let next = calendar.date(byAdding: .month, value: delta, to: displayMonth) {
            displayMonth = next
        }
    }

    private func toggleDay(_ day: String) {
        guard day <= todayString else { return }
        if pending.contains(day) {
            pending.remove(day)
        } else {
            pending.insert(day)
        }
    }

    var dayCells: [DayCell] {
        let comps = calendar.dateComponents([.year, .month], from: displayMonth)
        guard let firstOfMonth = calendar.date(from: comps),
              let range = calendar.range(of: .day, in: .month, for: firstOfMonth) else { return [] }

        var weekdayOfFirst = calendar.component(.weekday, from: firstOfMonth) - 2
        if weekdayOfFirst < 0 { weekdayOfFirst += 7 }

        var cells: [DayCell] = []

        for offset in stride(from: -weekdayOfFirst, to: 0, by: 1) {
            if let date = calendar.date(byAdding: .day, value: offset, to: firstOfMonth) {
                let d = calendar.component(.day, from: date)
                cells.append(DayCell(id: "prev-\(offset)", day: d, dateString: AppStore.dayString(from: date), isCurrentMonth: false))
            }
        }

        for day in range {
            if let date = calendar.date(byAdding: .day, value: day - 1, to: firstOfMonth) {
                cells.append(DayCell(id: "cur-\(day)", day: day, dateString: AppStore.dayString(from: date), isCurrentMonth: true))
            }
        }

        let remainder = (7 - cells.count % 7) % 7
        if let lastOfMonth = calendar.date(byAdding: .day, value: range.count - 1, to: firstOfMonth) {
            for i in 1...max(remainder, 1) {
                if let date = calendar.date(byAdding: .day, value: i, to: lastOfMonth) {
                    let d = calendar.component(.day, from: date)
                    cells.append(DayCell(id: "next-\(i)", day: d, dateString: AppStore.dayString(from: date), isCurrentMonth: false))
                }
            }
        }
        if cells.count % 7 != 0 {
            cells = Array(cells.prefix(cells.count - cells.count % 7))
        }

        return cells
    }
}

private struct DayCell: Identifiable {
    let id: String
    let day: Int
    let dateString: String
    let isCurrentMonth: Bool
}

private struct DayCellView: View {
    let cell: DayCell
    let isSelected: Bool
    let isToday: Bool
    let isFuture: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text("\(cell.day)")
                .font(.system(size: 11, weight: isToday ? .bold : .regular))
                .foregroundStyle(foregroundColor)
                .frame(width: 28, height: 28)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(backgroundColor)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(isToday && !isSelected ? Theme.brandAccent.opacity(0.5) : .clear, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
        .disabled(isFuture)
    }

    private var foregroundColor: Color {
        if isFuture { return Color.secondary.opacity(0.25) }
        if isSelected { return .white }
        if !cell.isCurrentMonth { return Color.secondary.opacity(0.4) }
        if isToday { return Theme.brandAccent }
        return .primary
    }

    private var backgroundColor: Color {
        if isSelected { return Theme.brandAccent }
        return .clear
    }
}

