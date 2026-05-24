import SwiftUI

struct PeriodSegmentedControl: View {
    @Environment(AppStore.self) private var store
    @State private var showingCalendar = false

    var body: some View {
        VStack(spacing: 6) {
            HStack(spacing: 1) {
                ForEach(Period.allCases) { period in
                    let isActive = !store.isDayMode && store.selectedPeriod == period
                    Button {
                        store.switchTo(period: period)
                    } label: {
                        Text(period.rawValue)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(isActive ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 4)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .background(
                        RoundedRectangle(cornerRadius: 5)
                            .fill(isActive ? Color(NSColor.windowBackgroundColor).opacity(0.85) : .clear)
                            .shadow(color: .black.opacity(isActive ? 0.06 : 0), radius: 1, y: 0.5)
                    )
                }
            }
            .padding(2)
            .background(
                RoundedRectangle(cornerRadius: 7)
                    .fill(Color.secondary.opacity(0.08))
            )

            HStack(spacing: 8) {
                Button {
                    showingCalendar.toggle()
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "calendar")
                            .font(.system(size: 10.5, weight: .semibold))
                            .foregroundStyle(store.isDayMode ? Theme.brandAccent : .secondary)
                        Text(dayButtonTitle)
                            .font(.system(size: 11.5, weight: .semibold))
                            .lineLimit(1)
                            .minimumScaleFactor(0.85)
                            .foregroundStyle(.primary)
                        Spacer(minLength: 0)
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 28)
                    .padding(.horizontal, 9)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(store.isDayMode ? Color(NSColor.windowBackgroundColor).opacity(0.85) : Color.secondary.opacity(0.08))
                        .shadow(color: .black.opacity(store.isDayMode ? 0.06 : 0), radius: 1, y: 0.5)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(store.isDayMode ? Theme.brandAccent.opacity(0.22) : Color.clear, lineWidth: 1)
                )
                .popover(isPresented: $showingCalendar, arrowEdge: .bottom) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Review day")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 10)
                            .padding(.top, 8)
                        DatePicker(
                            "",
                            selection: selectedDayBinding,
                            in: Date.distantPast...Date(),
                            displayedComponents: .date
                        )
                        .labelsHidden()
                        .datePickerStyle(.graphical)
                        .frame(width: 270)
                        .padding(.horizontal, 8)
                        .padding(.bottom, 8)
                    }
                }

                Button("Today") {
                    store.switchTo(day: Date())
                }
                .font(.system(size: 11, weight: .medium))
                .buttonStyle(.plain)
                .foregroundStyle(.primary)
                .padding(.horizontal, 9)
                .frame(width: 72, height: 28)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(Color.secondary.opacity(0.10))
                )
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
