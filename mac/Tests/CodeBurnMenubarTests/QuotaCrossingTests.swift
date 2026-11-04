import Foundation
import Testing
@testable import CodeBurnMenubar

private let resetsAt = Date(timeIntervalSince1970: 1_800_000_000)

private func window(
    _ percent: Double?,
    provider: String = "Claude",
    label: String = "Weekly",
    resetsAt: Date? = resetsAt
) -> QuotaCrossingWindow {
    QuotaCrossingWindow(providerName: provider, label: label, percent: percent, resetsAt: resetsAt)
}

@Suite("Quota crossing detection")
struct QuotaCrossingDetectorTests {
    @Test("A window under 80% says nothing")
    func belowThresholdIsSilent() {
        let result = QuotaCrossingDetector.evaluate(windows: [window(79.9)], fired: [])
        #expect(result.events.isEmpty)
        #expect(result.fired.isEmpty)
    }

    @Test("Crossing 80% fires once, and not again on the next fetch")
    func warningFiresOnce() {
        let first = QuotaCrossingDetector.evaluate(windows: [window(81)], fired: [])
        #expect(first.events.count == 1)
        #expect(first.events[0].level == .warning)
        #expect(first.events[0].notificationTitle == "Claude · Weekly at 80%")

        let second = QuotaCrossingDetector.evaluate(windows: [window(85)], fired: first.fired)
        #expect(second.events.isEmpty)
        #expect(second.fired == first.fired)
    }

    @Test("100% fires even when 80% was never observed, and never fires twice")
    func limitFiresWithoutAWarning() {
        let first = QuotaCrossingDetector.evaluate(windows: [window(100)], fired: [])
        #expect(first.events.count == 1)
        #expect(first.events[0].level == .limit)
        #expect(first.events[0].notificationTitle == "Claude · Weekly limit reached")

        let second = QuotaCrossingDetector.evaluate(windows: [window(100)], fired: first.fired)
        #expect(second.events.isEmpty)
    }

    @Test("A window that crossed 80% still announces the limit")
    func warningThenLimit() {
        let warning = QuotaCrossingDetector.evaluate(windows: [window(82)], fired: [])
        let limit = QuotaCrossingDetector.evaluate(windows: [window(100)], fired: warning.fired)
        #expect(limit.events.map(\.level) == [.limit])
    }

    @Test("A new reset instant re-arms both thresholds")
    func resetReArms() {
        let first = QuotaCrossingDetector.evaluate(windows: [window(90)], fired: [])
        let nextCycle = window(90, resetsAt: resetsAt.addingTimeInterval(7 * 24 * 3600))
        let second = QuotaCrossingDetector.evaluate(windows: [nextCycle], fired: first.fired)
        #expect(second.events.map(\.level) == [.warning])
        // The old cycle's entry is dropped rather than kept forever.
        #expect(second.fired.count == 1)
    }

    @Test("Reset jitter of a couple of seconds stays one cycle")
    func resetJitterIsOneCycle() {
        let first = QuotaCrossingDetector.evaluate(windows: [window(81)], fired: [])
        let jittered = window(81, resetsAt: resetsAt.addingTimeInterval(2))
        let second = QuotaCrossingDetector.evaluate(windows: [jittered], fired: first.fired)
        let back = QuotaCrossingDetector.evaluate(windows: [window(81)], fired: second.fired)
        #expect(first.events.count == 1)
        #expect(second.events.isEmpty)
        #expect(back.events.isEmpty)
    }

    @Test("A window missing from this fetch keeps what it has already fired")
    func absenceIsNotAReset() {
        let first = QuotaCrossingDetector.evaluate(windows: [window(90)], fired: [])
        let elsewhere = QuotaCrossingDetector.evaluate(
            windows: [window(10, provider: "Codex", label: "5-hour")],
            fired: first.fired
        )
        let back = QuotaCrossingDetector.evaluate(windows: [window(90)], fired: elsewhere.fired)
        #expect(back.events.isEmpty)
    }

    @Test("Each provider window is judged on its own")
    func providersAreIndependent() {
        let result = QuotaCrossingDetector.evaluate(
            windows: [window(85), window(100, provider: "Codex", label: "5-hour"), window(12, label: "Weekly · Opus")],
            fired: []
        )
        #expect(result.events.count == 2)
        #expect(result.events.contains { $0.providerName == "Codex" && $0.level == .limit })
    }

    @Test("A window that will run out before it resets says so once per cycle")
    func runsOutFiresOncePerCycle() {
        var early = window(50)
        early.runsOutAt = resetsAt.addingTimeInterval(-3600)
        let first = QuotaCrossingDetector.evaluate(windows: [early], fired: [])
        #expect(first.events.map(\.level) == [.runsOut])
        #expect(first.events[0].notificationTitle == "Claude Weekly runs out at \(QuotaPace.clockLabel(resetsAt.addingTimeInterval(-3600)))")
        #expect(first.events[0].notificationBody == "At this pace. Resets \(QuotaPace.clockLabel(resetsAt)).")

        early.runsOutAt = resetsAt.addingTimeInterval(-7200)
        let second = QuotaCrossingDetector.evaluate(windows: [early], fired: first.fired)
        #expect(second.events.isEmpty)

        var nextCycle = window(50, resetsAt: resetsAt.addingTimeInterval(7 * 24 * 3600))
        nextCycle.runsOutAt = resetsAt
        let third = QuotaCrossingDetector.evaluate(windows: [nextCycle], fired: second.fired)
        #expect(third.events.map(\.level) == [.runsOut])
    }

    @Test("A run-out at or after the reset, or a full window, says nothing")
    func runsOutNeedsTimeLeft() {
        var lasts = window(50)
        lasts.runsOutAt = resetsAt
        var full = window(100, label: "5-hour")
        full.runsOutAt = resetsAt.addingTimeInterval(-3600)
        let result = QuotaCrossingDetector.evaluate(windows: [lasts, full], fired: [])
        #expect(result.events.map(\.level) == [.limit])
    }

    @Test("The warning fires at the chosen threshold")
    func warningThresholdIsConfigurable() {
        #expect(QuotaCrossingDetector.evaluate(windows: [window(75)], fired: []).events.isEmpty)
        let lower = QuotaCrossingDetector.evaluate(windows: [window(75)], fired: [], warningPercent: 70)
        #expect(lower.events.map(\.notificationTitle) == ["Claude · Weekly at 70%"])
        #expect(QuotaCrossingDetector.evaluate(windows: [window(85)], fired: [], warningPercent: 90).events.isEmpty)
    }

    @Test("A window with no reported percent is no opinion")
    func missingPercentIsSilent() {
        let result = QuotaCrossingDetector.evaluate(
            windows: [window(nil), window(.nan, label: "Weekly · Opus")],
            fired: []
        )
        #expect(result.events.isEmpty)
    }
}

@Suite("Quota crossing notifications")
@MainActor
struct QuotaCrossingMonitorTests {
    @Test("A crossing posts once and asks for authorization only then")
    func postsOnce() async throws {
        try await withMonitor { monitor, notifier, _ in
            await monitor.record(windows: [window(50)])
            #expect(notifier.posts.isEmpty)
            #expect(notifier.authorizationRequests == 0)

            await monitor.record(windows: [window(82)])
            #expect(notifier.posts.map(\.title) == ["Claude · Weekly at 80%"])
            #expect(notifier.authorizationRequests == 1)

            await monitor.record(windows: [window(84)])
            #expect(notifier.posts.count == 1)
        }
    }

    @Test("The fired set survives a relaunch")
    func firedSetPersists() async throws {
        try await withMonitor { monitor, notifier, defaults in
            await monitor.record(windows: [window(100)])
            #expect(notifier.posts.count == 1)

            let relaunched = QuotaCrossingMonitor(defaults: defaults, makeNotifier: { notifier })
            await relaunched.record(windows: [window(100)])
            #expect(notifier.posts.count == 1)
        }
    }

    @Test("With the toggle off nothing is posted")
    func toggleOffIsSilent() async throws {
        try await withMonitor { monitor, notifier, defaults in
            defaults.set(false, forKey: QuotaCrossingPreference.defaultsKey)
            await monitor.record(windows: [window(100)])
            #expect(notifier.posts.isEmpty)
            #expect(notifier.authorizationRequests == 0)
        }
    }

    @Test("The threshold comes from the stored preference, 80 when unset")
    func thresholdPreference() async throws {
        try await withMonitor { monitor, notifier, defaults in
            #expect(QuotaCrossingPreference.warningPercent(defaults: defaults) == 80)
            defaults.set(90, forKey: QuotaCrossingPreference.warningPercentKey)
            await monitor.record(windows: [window(85)])
            #expect(notifier.posts.isEmpty)

            await monitor.record(windows: [window(91)])
            #expect(notifier.posts.map(\.title) == ["Claude · Weekly at 90%"])
        }
    }

    @Test("A denied authorization posts nothing and does not re-announce later")
    func deniedAuthorizationStaysQuiet() async throws {
        try await withMonitor { monitor, notifier, _ in
            notifier.authorized = false
            await monitor.record(windows: [window(100)])
            #expect(notifier.posts.isEmpty)

            notifier.authorized = true
            await monitor.record(windows: [window(100)])
            #expect(notifier.posts.isEmpty)
        }
    }
}

@MainActor
private func withMonitor(
    testName: String = #function,
    _ body: @MainActor (QuotaCrossingMonitor, RecordingCrossingNotifier, UserDefaults) async throws -> Void
) async throws {
    let (defaults, suiteName) = TestDefaults.make("codeburn.quota.crossing.\(testName)")
    defer { TestDefaults.forget(suiteName) }

    let notifier = RecordingCrossingNotifier()
    let monitor = QuotaCrossingMonitor(defaults: defaults, makeNotifier: { notifier })
    try await body(monitor, notifier, defaults)
}

@MainActor
private final class RecordingCrossingNotifier: UpdateNotifier {
    var authorized = true
    var authorizationRequests = 0
    var posts: [(title: String, body: String, identifier: String)] = []

    func requestAuthorizationIfNeeded() async -> Bool {
        authorizationRequests += 1
        return authorized
    }

    func post(title: String, body: String, identifier: String) {
        posts.append((title, body, identifier))
    }
}
