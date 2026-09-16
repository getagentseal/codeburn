import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Quota summary headline")
struct QuotaSummaryHeadlineTests {
    @Test("the weekly billing window drives the glance value even when a shorter window is busier")
    func choosesWeeklyWindow() {
        let reset = Date(timeIntervalSince1970: 1_800_000_000)
        let weekly = QuotaSummary.Window(label: "Weekly", percent: 0.21, resetsAt: reset)
        let session = QuotaSummary.Window(label: "Current session", percent: 0.73, resetsAt: reset)
        let summary = QuotaSummary(
            providerFilter: .claude,
            connection: .connected,
            primary: weekly,
            details: [session, weekly],
            planLabel: "Max",
            footerLines: []
        )

        #expect(summary.headlineWindow == weekly)
    }

    @Test("weekly wins over a higher-percent monthly window")
    func weeklyOutranksMonthly() {
        let monthly = QuotaSummary.Window(label: "Monthly", percent: 0.88, resetsAt: nil)
        let weekly = QuotaSummary.Window(label: "This week", percent: 0.12, resetsAt: nil)
        let summary = QuotaSummary(
            providerFilter: .claude,
            connection: .connected,
            primary: nil,
            details: [monthly, weekly],
            planLabel: nil,
            footerLines: []
        )

        #expect(summary.headlineWindow == weekly)
    }

    @Test("falls back to the busiest window when no billing label is present")
    func fallsBackToBusiestWindow() {
        let session = QuotaSummary.Window(label: "Current session", percent: 0.73, resetsAt: nil)
        let daily = QuotaSummary.Window(label: "Today", percent: 0.4, resetsAt: nil)
        let summary = QuotaSummary(
            providerFilter: .claude,
            connection: .connected,
            primary: nil,
            details: [daily, session],
            planLabel: nil,
            footerLines: []
        )

        #expect(summary.headlineWindow == session)
    }

    @Test("primary remains a fallback when details are absent")
    func fallsBackToPrimary() {
        let primary = QuotaSummary.Window(label: "Weekly", percent: 0.52, resetsAt: nil)
        let summary = QuotaSummary(
            providerFilter: .codex,
            connection: .stale,
            primary: primary,
            details: [],
            planLabel: nil,
            footerLines: []
        )

        #expect(summary.headlineWindow == primary)
    }

    @Test("unknown data remains unknown instead of becoming zero percent")
    func unknownRemainsNil() {
        let summary = QuotaSummary(
            providerFilter: .codex,
            connection: .disconnected,
            primary: nil,
            details: [],
            planLabel: nil,
            footerLines: []
        )

        #expect(summary.headlineWindow == nil)
    }

    @Test("severity steps at the 0.50 / 0.75 / 0.90 band boundaries")
    func severityBoundaries() {
        #expect(QuotaSummary.severity(for: 0.59) == .normal)
        #expect(QuotaSummary.severity(for: 0.60) == .warning)
        #expect(QuotaSummary.severity(for: 0.69) == .warning)
        #expect(QuotaSummary.severity(for: 0.70) == .critical)
        #expect(QuotaSummary.severity(for: 0.94) == .critical)
        #expect(QuotaSummary.severity(for: 0.95) == .danger)
    }
}
