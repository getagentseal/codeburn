import Foundation
import Testing
@testable import CodeBurnMenubar

private let utcCalendar: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0) ?? .current
    return calendar
}()

private let fixedNow = utcCalendar.date(from: DateComponents(year: 2026, month: 5, day: 24, hour: 12))!

private func monthEntries(startYear: Int, startMonth: Int, endYear: Int, endMonth: Int) -> [DailyHistoryEntry] {
    var entries: [DailyHistoryEntry] = []
    var year = startYear
    var month = startMonth
    var index = 0

    while year < endYear || (year == endYear && month <= endMonth) {
        entries.append(
            DailyHistoryEntry(
                date: String(format: "%04d-%02d-15", year, month),
                cost: 10 + Double(index),
                calls: 20 + index,
                inputTokens: 1_000 + index * 100,
                outputTokens: 250 + index * 25,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                topModels: []
            )
        )

        month += 1
        index += 1
        if month == 13 {
            month = 1
            year += 1
        }
    }

    return entries
}

@Suite("Lifetime trend cadence")
struct LifetimeTrendCadenceTests {
    @Test("uses monthly cadence through 24 months")
    func monthlyLifetimeCadence() {
        let summary = makeLifetimeTrendTestSummary(days: monthEntries(startYear: 2025, startMonth: 12, endYear: 2026, endMonth: 5), now: fixedNow)

        #expect(summary.windowLabel == "All time by month")
        #expect(summary.labels == ["Dec 2025", "Jan 2026", "Feb 2026", "Mar 2026", "Apr 2026", "May 2026"])
    }

    @Test("switches to quarterly cadence after 24 months")
    func quarterlyLifetimeCadence() {
        let summary = makeLifetimeTrendTestSummary(days: monthEntries(startYear: 2023, startMonth: 1, endYear: 2026, endMonth: 5), now: fixedNow)

        #expect(summary.windowLabel == "All time by quarter")
        #expect(summary.labels.count == 14)
        #expect(summary.labels.first == "Q1 2023")
        #expect(summary.labels.last == "Q2 2026")
    }

    @Test("switches to yearly cadence beyond 60 months")
    func yearlyLifetimeCadence() {
        let summary = makeLifetimeTrendTestSummary(days: monthEntries(startYear: 2020, startMonth: 1, endYear: 2026, endMonth: 5), now: fixedNow)

        #expect(summary.windowLabel == "All time by year")
        #expect(summary.labels == ["2020", "2021", "2022", "2023", "2024", "2025", "2026"])
    }
}