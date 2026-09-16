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
    _ body: @MainActor (QuotaCrossingMonitor, RecordingCrossingNotifier, UserDefaults) async throws -> Void
) async throws {
    let suiteName = "codeburn.quota.crossing.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suiteName))
    defaults.removePersistentDomain(forName: suiteName)
    defer { defaults.removePersistentDomain(forName: suiteName) }

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
