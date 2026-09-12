import Foundation
import Testing
@testable import CodeBurnMenubar

/// Fixtures for the Capacity Dock pace caption. These drive the production
/// `QuotaPacePresentation` path that the window columns render, not helper
/// arithmetic: every assertion names the exact caption string the view will
/// draw, which is also what pins the fraction/percent unit crossing.
private struct Fixture {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let week = 7 * 24 * 3600
    let fiveHours = 5 * 3600

    /// resetsAt such that `fraction` of the window has elapsed at `now`.
    func resets(afterElapsedFraction fraction: Double, windowSeconds: Int) -> Date {
        now.addingTimeInterval(TimeInterval(windowSeconds) * (1 - fraction))
    }

    func window(
        _ label: String,
        _ percent: Double,
        resetsAt: Date,
        windowSeconds: Int
    ) -> QuotaSummary.Window {
        QuotaSummary.Window(
            label: label,
            percent: percent,
            resetsAt: resetsAt,
            windowSeconds: windowSeconds,
            fetchedAt: now
        )
    }

    func line(
        percent: Double,
        elapsedFraction: Double,
        windowSeconds: Int,
        connection: QuotaSummary.Connection = .connected
    ) -> QuotaPacePresentation.Line? {
        QuotaPacePresentation.line(
            for: window("Weekly", percent, resetsAt: resets(afterElapsedFraction: elapsedFraction, windowSeconds: windowSeconds), windowSeconds: windowSeconds),
            connection: connection,
            now: now
        )
    }
}

@Suite("Capacity Dock quota pace caption")
struct CapacityDockPacePresentationTests {
    private let f = Fixture()

    @Test("A window fraction is consumed as percent, not as a raw 0..1 value")
    func fractionBecomesPercent() {
        // 0.5 fraction at halfway through the week is 50% used — on pace.
        // Read as a raw 0..1 value it would be 0.5% used, which projects to 1%
        // at reset; the help text is where that number is still visible.
        let line = f.line(percent: 0.5, elapsedFraction: 0.5, windowSeconds: f.week)
        #expect(line?.kind == .estimate)
        #expect(line?.text == "Lasts until reset")
        #expect(line?.helpText.contains("Projected 100% used by the reset") == true)
        #expect(line?.tone == .neutral)
    }

    @Test("Ahead of pace with a projected overflow names an exhaustion ETA from now")
    func deficitProjectsEarlyExhaustion() {
        // used 60%, expected 40% -> projected 150%; the limit is hit 44h 48m
        // from `now`, while the reset itself is still 4d 4h away.
        let line = f.line(percent: 0.6, elapsedFraction: 0.4, windowSeconds: f.week)
        #expect(line?.kind == .estimate)
        #expect(line?.text == "Runs out in 1d 20h")
        #expect(line?.tone == .warning)
        #expect(!(line?.text.contains("early") ?? false))
    }

    @Test("The ETA is now-to-limit, which differs from now-to-reset")
    func etaIsNowToLimitNotLeadBeforeReset() {
        let hitsLimitAt = f.now.addingTimeInterval(44 * 3600 + 48 * 60) // 44h 48m
        let resetsAt = f.resets(afterElapsedFraction: 0.4, windowSeconds: f.week)
        let nowToLimit = QuotaPacePresentation.countdownLabel(from: f.now, to: hitsLimitAt)
        let nowToReset = QuotaPacePresentation.countdownLabel(from: f.now, to: resetsAt)
        // The two intervals differ, so the caption must state the ETA from now,
        // not a "lead before reset" that would come out as reset-minus-limit.
        #expect(nowToLimit == "1d 20h")
        #expect(nowToReset == "4d 4h")
        #expect(nowToLimit != nowToReset)
    }

    @Test("Behind pace stays in reserve with a projection, no alarm")
    func reserveStaysNeutral() {
        let line = f.line(percent: 0.2, elapsedFraction: 0.5, windowSeconds: f.week)
        #expect(line?.text == "Lasts until reset")
        #expect(line?.helpText.contains("30% of the window still in reserve") == true)
        #expect(line?.tone == .neutral)
    }

    @Test("A window younger than 3% elapsed gets no estimate")
    func earlyWindowIsSilent() {
        #expect(f.line(percent: 0.5, elapsedFraction: 0.01, windowSeconds: f.week) == nil)
    }

    @Test("No usage yet reads as a zero projection, not as zero-signal")
    func noUsageYet() {
        let line = f.line(percent: 0.0, elapsedFraction: 0.5, windowSeconds: f.week)
        #expect(line?.text == "Lasts until reset")
        #expect(line?.helpText.contains("Projected 0% used by the reset") == true)
        #expect(line?.tone == .neutral)
    }

    @Test("A fully used window is exhausted, and a past reset is stale")
    func exhaustedState() {
        let reached = f.line(percent: 1.0, elapsedFraction: 0.5, windowSeconds: f.week)
        #expect(reached?.kind == .exhausted)
        #expect(reached?.text == "Limit reached")
        #expect(reached?.tone == .danger)
        let window = f.window(
            "Weekly", 1.0,
            resetsAt: f.now.addingTimeInterval(-100),
            windowSeconds: f.week
        )
        #expect(QuotaPacePresentation.line(for: window, connection: .connected, now: f.now) == nil)
    }

    @Test("Short windows show stage only, never a burst ETA")
    func shortWindowSuppressesETA() {
        let line = f.line(percent: 0.9, elapsedFraction: 0.5, windowSeconds: f.fiveHours)
        #expect(line?.kind == .estimate)
        #expect(line?.text == "40% in deficit")
        #expect(line?.tone == .warning)
        // Neither the long-window verdict nor an ETA may appear here.
        #expect(!(line?.text.contains("Runs out") ?? false))
        #expect(!(line?.text.contains("until reset") ?? false))
    }

    @Test("Stale, failed and disconnected data get nothing")
    func nonConnectedDataIsSilent() {
        for connection: QuotaSummary.Connection in [.stale, .loading, .transientFailure, .disconnected] {
            #expect(f.line(percent: 0.6, elapsedFraction: 0.4, windowSeconds: f.week, connection: connection) == nil)
        }
    }

    @Test("An old connected sample gets no pace caption")
    func oldConnectedSampleIsSilent() {
        let old = f.window(
            "Weekly",
            0.6,
            resetsAt: f.resets(afterElapsedFraction: 0.4, windowSeconds: f.week),
            windowSeconds: f.week
        )
        let stale = QuotaSummary.Window(
            label: old.label,
            percent: old.percent,
            resetsAt: old.resetsAt,
            windowSeconds: old.windowSeconds,
            fetchedAt: f.now.addingTimeInterval(-QuotaSummary.freshnessThreshold - 1)
        )
        #expect(QuotaPacePresentation.line(for: stale, connection: .connected, now: f.now) == nil)
    }

    @Test("Negative, over-one, non-finite and missing metadata get nothing")
    func invalidInputsAreSilent() {
        // A negative fraction must be rejected, not clamped into a healthy 0%.
        #expect(f.line(percent: -0.1, elapsedFraction: 0.5, windowSeconds: f.week) == nil)
        // Over 100% is not a "limit reached" signal — it is a broken sample.
        #expect(f.line(percent: 1.2, elapsedFraction: 0.5, windowSeconds: f.week) == nil)
        #expect(f.line(percent: .nan, elapsedFraction: 0.5, windowSeconds: f.week) == nil)
        #expect(f.line(percent: .infinity, elapsedFraction: 0.5, windowSeconds: f.week) == nil)
        #expect(f.line(percent: 0.5, elapsedFraction: 0.5, windowSeconds: 0) == nil)
        #expect(f.line(percent: 0.5, elapsedFraction: 0.5, windowSeconds: -100) == nil)

        let noDuration = QuotaSummary.Window(
            label: "Weekly",
            percent: 0.5,
            resetsAt: f.resets(afterElapsedFraction: 0.5, windowSeconds: f.week),
            windowSeconds: nil,
            fetchedAt: f.now
        )
        #expect(QuotaPacePresentation.line(for: noDuration, connection: .connected, now: f.now) == nil)

        let noReset = QuotaSummary.Window(
            label: "Weekly",
            percent: 0.5,
            resetsAt: nil,
            windowSeconds: f.week,
            fetchedAt: f.now
        )
        #expect(QuotaPacePresentation.line(for: noReset, connection: .connected, now: f.now) == nil)
    }

    @Test("Clock skew in either direction gets nothing")
    func clockSkewIsSilent() {
        let tooFar = f.window("Weekly", 0.5, resetsAt: f.now.addingTimeInterval(TimeInterval(f.week + 100)), windowSeconds: f.week)
        #expect(QuotaPacePresentation.line(for: tooFar, connection: .connected, now: f.now) == nil)
        let elapsed = f.window("Weekly", 0.5, resetsAt: f.now.addingTimeInterval(-1), windowSeconds: f.week)
        #expect(QuotaPacePresentation.line(for: elapsed, connection: .connected, now: f.now) == nil)
    }

    @Test("An impossible exhausted window (reset far past the duration) is rejected")
    func impossibleExhaustedIsSilent() {
        // 100% used, but the reset is thirty days out on a weekly window:
        // that is clock/data skew, not an actually-exhausted limit.
        let window = f.window("Weekly", 1.0, resetsAt: f.now.addingTimeInterval(30 * 24 * 3600), windowSeconds: f.week)
        #expect(QuotaPacePresentation.line(for: window, connection: .connected, now: f.now) == nil)
    }

    @Test("A non-finite reset timestamp is rejected before any branch")
    func nonFiniteResetIsSilent() {
        let window = f.window("Weekly", 1.0, resetsAt: Date(timeIntervalSinceReferenceDate: .infinity), windowSeconds: f.week)
        #expect(QuotaPacePresentation.line(for: window, connection: .connected, now: f.now) == nil)
    }

    @Test("A mislabeled duration is used as given, not re-inferred from the label")
    func durationIsUsedAsGiven() {
        let thirtyDays = 30 * 24 * 3600
        let window = f.window(
            "Weekly", 0.9,
            resetsAt: f.now.addingTimeInterval(2 * 24 * 3600),
            windowSeconds: thirtyDays
        )
        let line = QuotaPacePresentation.line(for: window, connection: .connected, now: f.now)
        #expect(line?.kind == .estimate)
        #expect(line?.text == "Lasts until reset")
        #expect(line?.helpText.contains("Projected 96% used by the reset") == true)
    }

    @Test("A monthly cycle whose label reads Weekly paces against the month, not 7 days")
    func grokBuildMonthlyCycleLabeledWeekly() {
        // Grok Build picks its window label from the distance to the reset, so
        // a monthly cycle sitting in the 4-12 day band is labeled "Weekly".
        // Deriving the length from that label — the round trip #1287 used —
        // paces a month's budget against 7 days.
        let month = 30 * 24 * 3600
        let resetsAt = f.now.addingTimeInterval(6 * 24 * 3600)   // inside the band
        let window = f.window("Weekly", 0.72, resetsAt: resetsAt, windowSeconds: month)

        // 24 of 30 days elapsed at 72% used projects to 90%: it lasts.
        let line = QuotaPacePresentation.line(for: window, connection: .connected, now: f.now)
        #expect(line?.text == "Lasts until reset")
        #expect(line?.tone == .neutral)
        #expect(line?.helpText.contains("30-day window") == true)

        // The same sample against the label-inferred 7-day window is 1 of 7
        // days elapsed, which projects past 500% and would print an alarming
        // run-out ETA on a healthy account. That is the reading the real
        // `windowSeconds` must never produce.
        let asWeekly = QuotaPace.evaluate(
            usedPercent: 72,
            resetsAt: resetsAt,
            windowSeconds: 7 * 24 * 3600,
            now: f.now
        )
        #expect(asWeekly?.willOverflow == true)
        #expect(line?.text != QuotaPacePresentation.caption(
            for: asWeekly!,
            windowSeconds: 7 * 24 * 3600,
            now: f.now
        ))

        // And with no duration metadata at all, the label stays a label: the
        // caption is silent rather than falling back to inferring "Weekly".
        let noDuration = QuotaSummary.Window(
            label: window.label,
            percent: window.percent,
            resetsAt: resetsAt,
            windowSeconds: nil,
            fetchedAt: f.now
        )
        #expect(QuotaPacePresentation.line(for: noDuration, connection: .connected, now: f.now) == nil)
    }

    @Test("Distinct scopes sharing a duration each keep their own caption")
    func distinctScopesAreNotSuppressed() {
        // A healthy aggregate Weekly and an exhausted Weekly · Opus share the
        // same 7-day duration; the healthy window must not hide the exhausted
        // one.
        let weekly = f.window("Weekly", 0.5, resetsAt: f.resets(afterElapsedFraction: 0.5, windowSeconds: f.week), windowSeconds: f.week)
        let opus = f.window("Weekly · Opus", 1.0, resetsAt: f.resets(afterElapsedFraction: 0.5, windowSeconds: f.week), windowSeconds: f.week)
        let lines = QuotaPacePresentation.lines(for: [weekly, opus], connection: .connected, now: f.now)
        #expect(lines[0]?.text == "Lasts until reset")
        #expect(lines[1]?.text == "Limit reached")
    }

    @Test("Same-duration windows with different reset dates both keep captions")
    func sameDurationDifferentResets() {
        let a = f.window("Limit A", 0.5, resetsAt: f.now.addingTimeInterval(3 * 24 * 3600), windowSeconds: f.week)
        let b = f.window("Limit B", 0.9, resetsAt: f.now.addingTimeInterval(2 * 24 * 3600), windowSeconds: f.week)
        let lines = QuotaPacePresentation.lines(for: [a, b], connection: .connected, now: f.now)
        #expect(lines[0] != nil)
        #expect(lines[1] != nil)
    }

    @Test("Only a genuinely identical duplicate window is suppressed")
    func exactDuplicatesAreSuppressed() {
        let resetsAt = f.resets(afterElapsedFraction: 0.5, windowSeconds: f.week)
        let a = f.window("Weekly", 0.5, resetsAt: resetsAt, windowSeconds: f.week)
        let duplicate = f.window("Weekly", 0.5, resetsAt: resetsAt, windowSeconds: f.week)
        let lines = QuotaPacePresentation.lines(for: [a, duplicate], connection: .connected, now: f.now)
        #expect(lines[0] != nil)
        #expect(lines[1] == nil)
    }

    @Test("The panel reserves a slot on metadata, independent of wall-clock time")
    func reservationIsMetadataOnly() {
        let resetsAt = f.now.addingTimeInterval(3 * 24 * 3600)
        let eligible = [QuotaSummary.Window(label: "Weekly", percent: 0.5, resetsAt: resetsAt, windowSeconds: f.week, fetchedAt: f.now)]
        let noDuration = [QuotaSummary.Window(label: "Weekly", percent: 0.5, resetsAt: resetsAt, fetchedAt: f.now)]
        let noReset = [QuotaSummary.Window(label: "Weekly", percent: 0.5, resetsAt: nil, windowSeconds: f.week, fetchedAt: f.now)]
        #expect(QuotaPacePresentation.reservesLine(for: eligible, connection: .connected))
        #expect(!QuotaPacePresentation.reservesLine(for: noDuration, connection: .connected))
        #expect(!QuotaPacePresentation.reservesLine(for: noReset, connection: .connected))
        #expect(!QuotaPacePresentation.reservesLine(for: eligible, connection: .stale))
    }
}
