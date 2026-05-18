import Foundation
import Testing
@testable import CodeBurnMenubar

private let quotaNow = Date(timeIntervalSince1970: 1_800_000_000)
private let resetAt = Date(timeIntervalSince1970: 1_800_010_000)

private func quota(
    provider: ProviderFilter = .claude,
    connection: QuotaSummary.Connection = .connected,
    windows: [QuotaSummary.Window]
) -> QuotaSummary {
    QuotaSummary(
        providerFilter: provider,
        connection: connection,
        primary: windows.first,
        details: windows,
        planLabel: nil,
        footerLines: []
    )
}

@Suite("QuotaNotificationDecider")
struct QuotaNotificationDeciderTests {
    @Test("does not emit below 80 percent")
    func noAlertBelowThreshold() {
        let summary = quota(windows: [
            .init(label: "Weekly", percent: 0.79, resetsAt: resetAt),
        ])

        let events = QuotaNotificationDecider.events(for: [summary], notifiedKeys: [], now: quotaNow)

        #expect(events.isEmpty)
    }

    @Test("emits 80 percent event once per provider window reset")
    func emitsEightyOnce() {
        let summary = quota(windows: [
            .init(label: "Weekly", percent: 0.82, resetsAt: resetAt),
        ])

        let events = QuotaNotificationDecider.events(for: [summary], notifiedKeys: [], now: quotaNow)

        #expect(events.count == 1)
        #expect(events[0].provider == "Claude")
        #expect(events[0].threshold == 80)
        #expect(events[0].percent == 82)

        let suppressed = QuotaNotificationDecider.events(
            for: [summary],
            notifiedKeys: Set(events[0].keysToMark),
            now: quotaNow
        )
        #expect(suppressed.isEmpty)
    }

    @Test("jumps directly to 100 percent and marks lower thresholds too")
    func jumpToHundredMarksLowerThresholds() {
        let summary = quota(provider: .codex, windows: [
            .init(label: "5-hour", percent: 1.04, resetsAt: resetAt),
        ])

        let events = QuotaNotificationDecider.events(for: [summary], notifiedKeys: [], now: quotaNow)

        #expect(events.count == 1)
        #expect(events[0].provider == "Codex")
        #expect(events[0].threshold == 100)
        #expect(events[0].keysToMark.count == 2)

        let suppressed = QuotaNotificationDecider.events(
            for: [summary],
            notifiedKeys: Set(events[0].keysToMark),
            now: quotaNow
        )
        #expect(suppressed.isEmpty)
    }

    @Test("emits 100 percent after an earlier 80 percent alert")
    func hundredAfterEighty() {
        let weekly = QuotaSummary.Window(label: "Weekly", percent: 1.0, resetsAt: resetAt)
        let eightyKey = QuotaNotificationDecider.dedupeKey(
            provider: ProviderFilter.claude.cliArg,
            window: weekly,
            threshold: 80,
            now: quotaNow
        )
        let summary = quota(windows: [weekly])

        let events = QuotaNotificationDecider.events(for: [summary], notifiedKeys: [eightyKey], now: quotaNow)

        #expect(events.count == 1)
        #expect(events[0].threshold == 100)
    }

    @Test("emits each crossed quota window for a provider")
    func eachCrossedWindowEmits() {
        let summary = quota(windows: [
            .init(label: "5-hour", percent: 0.81, resetsAt: resetAt),
            .init(label: "Weekly", percent: 0.96, resetsAt: resetAt),
        ])

        let events = QuotaNotificationDecider.events(for: [summary], notifiedKeys: [], now: quotaNow)

        #expect(events.count == 2)
        #expect(events.map(\.windowLabel) == ["5-hour", "Weekly"])
        #expect(events.map(\.threshold) == [80, 80])
    }

    @Test("notified worst window does not suppress newly crossed sibling windows")
    func notifiedWorstWindowDoesNotSuppressSiblings() {
        let fiveHour = QuotaSummary.Window(label: "5-hour", percent: 1.0, resetsAt: resetAt)
        let weekly = QuotaSummary.Window(label: "Weekly", percent: 0.85, resetsAt: resetAt)
        let notified = Set([80, 100].map {
            QuotaNotificationDecider.dedupeKey(
                provider: ProviderFilter.claude.cliArg,
                window: fiveHour,
                threshold: $0,
                now: quotaNow
            )
        })
        let summary = quota(windows: [fiveHour, weekly])

        let events = QuotaNotificationDecider.events(for: [summary], notifiedKeys: notified, now: quotaNow)

        #expect(events.count == 1)
        #expect(events[0].windowLabel == "Weekly")
        #expect(events[0].threshold == 80)
    }

    @Test("skips non-finite quota percentages")
    func skipsNonFinitePercentages() {
        let summary = quota(windows: [
            .init(label: "Bad", percent: .nan, resetsAt: resetAt),
            .init(label: "Also Bad", percent: .infinity, resetsAt: resetAt),
            .init(label: "Good", percent: 0.82, resetsAt: resetAt),
        ])

        let events = QuotaNotificationDecider.events(for: [summary], notifiedKeys: [], now: quotaNow)

        #expect(events.count == 1)
        #expect(events[0].windowLabel == "Good")
    }

    @Test("skips disconnected, loading, stale, and failure providers")
    func skipsUnavailableStates() {
        let window = QuotaSummary.Window(label: "Weekly", percent: 1.2, resetsAt: resetAt)
        let summaries = [
            quota(connection: .disconnected, windows: [window]),
            quota(connection: .loading, windows: [window]),
            quota(connection: .stale, windows: [window]),
            quota(connection: .transientFailure, windows: [window]),
            quota(connection: .terminalFailure(reason: "Reconnect"), windows: [window]),
        ]

        let events = QuotaNotificationDecider.events(for: summaries, notifiedKeys: [], now: quotaNow)

        #expect(events.isEmpty)
    }

    @Test("uses local calendar day when no reset timestamp is available")
    func nilResetUsesCalendarDay() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let window = QuotaSummary.Window(label: "Daily", percent: 0.8, resetsAt: nil)

        let key = QuotaNotificationDecider.dedupeKey(
            provider: "codex",
            window: window,
            threshold: 80,
            now: quotaNow,
            calendar: calendar
        )

        #expect(key.hasSuffix(".d2027-01-15"))
    }

    @Test("keeps same-day reset windows distinct")
    func sameDayResetWindowsAreDistinct() {
        let first = QuotaSummary.Window(
            label: "5-hour",
            percent: 0.8,
            resetsAt: Date(timeIntervalSince1970: 1_800_010_000)
        )
        let second = QuotaSummary.Window(
            label: "5-hour",
            percent: 0.8,
            resetsAt: Date(timeIntervalSince1970: 1_800_020_000)
        )

        let firstKey = QuotaNotificationDecider.dedupeKey(
            provider: "claude",
            window: first,
            threshold: 80,
            now: quotaNow
        )
        let secondKey = QuotaNotificationDecider.dedupeKey(
            provider: "claude",
            window: second,
            threshold: 80,
            now: quotaNow
        )

        #expect(firstKey != secondKey)
    }
}
