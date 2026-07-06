import Foundation
import Testing
@testable import CodeBurnMenubar

private let heatmapNow: Date = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    return calendar.date(from: DateComponents(year: 2026, month: 6, day: 3, hour: 12))!
}()

private let heatmapCalendar: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    return calendar
}()

private let heatmapFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd"
    formatter.timeZone = TimeZone(secondsFromGMT: 0)!
    return formatter
}()

private func historyEntry(
    _ date: String,
    cost: Double,
    calls: Int = 1,
    inputTokens: Int = 100,
    outputTokens: Int = 20
) -> DailyHistoryEntry {
    DailyHistoryEntry(
        date: date,
        cost: cost,
        savingsUSD: 0,
        calls: calls,
        inputTokens: inputTokens,
        outputTokens: outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        topModels: []
    )
}

@Suite("Contribution heatmap")
struct ContributionHeatmapTests {
    @Test("builds Monday-start weeks ending with the current week")
    func buildsMondayStartWeeks() {
        let weeks = buildContributionWeeks(
            from: [historyEntry("2026-06-03", cost: 10)],
            weekCount: 2,
            now: heatmapNow,
            calendar: heatmapCalendar,
            formatter: heatmapFormatter
        )

        #expect(weeks.map(\.startDate) == ["2026-05-25", "2026-06-01"])
        #expect(weeks.allSatisfy { $0.days.count == 7 })
        #expect(weeks[1].days[0].date == "2026-06-01")
        #expect(weeks[1].days[2].date == "2026-06-03")
        #expect(weeks[1].days[2].isToday)
    }

    @Test("marks future cells after today")
    func marksFutureCells() {
        let weeks = buildContributionWeeks(
            from: [
                historyEntry("2026-06-03", cost: 10),
                historyEntry("2026-06-04", cost: 99),
            ],
            weekCount: 1,
            now: heatmapNow,
            calendar: heatmapCalendar,
            formatter: heatmapFormatter
        )

        let currentWeek = weeks[0].days
        #expect(currentWeek[2].date == "2026-06-03")
        #expect(currentWeek[2].cost == 10)
        #expect(!currentWeek[2].isFuture)
        #expect(currentWeek[3].date == "2026-06-04")
        #expect(currentWeek[3].cost == 0)
        #expect(currentWeek[3].isFuture)
    }

    @Test("maps costs to four nonzero intensity levels")
    func mapsIntensityLevels() {
        #expect(contributionLevel(value: 0, maxValue: 100) == 0)
        #expect(contributionLevel(value: 10, maxValue: 100) == 1)
        #expect(contributionLevel(value: 25, maxValue: 100) == 2)
        #expect(contributionLevel(value: 50, maxValue: 100) == 3)
        #expect(contributionLevel(value: 75, maxValue: 100) == 4)
        #expect(contributionLevel(value: 100, maxValue: 100) == 4)
    }

    @MainActor
    @Test("computes total, active days, average, and current streak")
    func computesStats() {
        let weeks = buildContributionWeeks(
            from: [
                historyEntry("2026-06-01", cost: 3),
                historyEntry("2026-06-02", cost: 0),
                historyEntry("2026-06-03", cost: 9),
            ],
            weekCount: 1,
            now: heatmapNow,
            calendar: heatmapCalendar,
            formatter: heatmapFormatter
        )

        let stats = computeContributionStats(weeks: weeks)
        #expect(stats.total == 12)
        #expect(stats.activeDays == 2)
        #expect(stats.avgActive == 6)
        #expect(stats.currentStreak == 1)
        #expect(stats.peakLabel.contains("Jun 3"))
    }
}
