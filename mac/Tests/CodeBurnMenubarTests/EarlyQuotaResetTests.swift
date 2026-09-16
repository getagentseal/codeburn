import Foundation
import Testing
@testable import CodeBurnMenubar

private let now = Date(timeIntervalSince1970: 1_800_000_000)
private let week: TimeInterval = 7 * 24 * 3600
private let eighteenHours: TimeInterval = 18 * 3600
private let fiveHours: TimeInterval = 5 * 3600
private let weekSeconds = 7 * 24 * 3600

private func reading(
    percent: Double,
    resetsIn: TimeInterval,
    observedAgo: TimeInterval = 0
) -> EarlyQuotaResetReading {
    EarlyQuotaResetReading(
        percent: percent,
        resetsAt: now.addingTimeInterval(resetsIn),
        observedAt: now.addingTimeInterval(-observedAgo)
    )
}

private func context(
    windowSeconds: Int? = weekSeconds,
    previousPlanLabel: String? = "Max 20x",
    currentPlanLabel: String? = "Max 20x",
    baselineIsTrusted: Bool = true
) -> EarlyQuotaResetDetector.Context {
    EarlyQuotaResetDetector.Context(
        providerID: "claude",
        providerName: "Claude",
        windowKey: "seven_day",
        windowName: "weekly limit",
        windowSeconds: windowSeconds,
        previousPlanLabel: previousPlanLabel,
        currentPlanLabel: currentPlanLabel,
        baselineIsTrusted: baselineIsTrusted
    )
}

/// The stored cycle still has 18 hours to run.
private let beforeEarlyReset = reading(percent: 80, resetsIn: 18 * 3600, observedAgo: 300)
/// A new cycle, anchored a full window after the previous look at the old one.
private let afterEarlyReset = reading(percent: 0, resetsIn: week)

@Suite("Early quota reset detection")
struct EarlyQuotaResetDetectorTests {
    @Test("A reset time that jumps to a new cycle before the old one ended is an early reset")
    func resetTimeJumpIsDetected() throws {
        let event = try #require(EarlyQuotaResetDetector.detect(
            previous: beforeEarlyReset, current: afterEarlyReset, context: context()
        ))
        #expect(event.signal == .resetMovedForward)
        #expect(event.earlyBySeconds == eighteenHours)
        #expect(event.percentBefore == 80.0)
        #expect(event.percentAfter == 0.0)
        #expect(event.notificationBody == "Claude's weekly limit reset 18h early. You're back to 100%.")
    }

    @Test("Usage emptying while the reset time stands still is an early reset")
    func percentDropIsDetected() throws {
        let event = try #require(EarlyQuotaResetDetector.detect(
            previous: reading(percent: 92, resetsIn: eighteenHours, observedAgo: 300),
            current: reading(percent: 1, resetsIn: eighteenHours),
            context: context()
        ))
        #expect(event.signal == .usageDropped)
        #expect(event.earlyBySeconds == eighteenHours)
        // The reset time stood still, so this copy must not promise a new cycle.
        #expect(event.notificationTitle == "Claude quota cleared early")
        #expect(event.notificationBody
            == "Claude cleared your weekly usage 18h before its reset. You're back to 99%.")
        for text in [event.notificationTitle, event.notificationBody] {
            #expect(!text.contains("reset early"))
        }
    }

    @Test("Both signals describe the same cut-short cycle, so they coalesce to one identity")
    func signalsShareAnIdentity() {
        let jumped = EarlyQuotaResetDetector.detect(
            previous: beforeEarlyReset, current: afterEarlyReset, context: context()
        )
        let dropped = EarlyQuotaResetDetector.detect(
            previous: beforeEarlyReset,
            current: reading(percent: 1, resetsIn: 18 * 3600),
            context: context()
        )
        #expect(jumped?.identity == dropped?.identity)
    }

    // MARK: - Must not false-positive

    @Test("A normal scheduled reset stays silent")
    func scheduledResetIsSilent() {
        // The stored cycle's reset has passed: this is the common case.
        let event = EarlyQuotaResetDetector.detect(
            previous: reading(percent: 96, resetsIn: -60, observedAgo: 300),
            current: reading(percent: 0, resetsIn: week),
            context: context()
        )
        #expect(event == nil)
    }

    @Test("A plan change stays silent")
    func planChangeIsSilent() {
        let event = EarlyQuotaResetDetector.detect(
            previous: beforeEarlyReset,
            current: afterEarlyReset,
            context: context(previousPlanLabel: "Pro", currentPlanLabel: "Max 20x")
        )
        #expect(event == nil)
    }

    @Test("Clock skew stays silent")
    func clockSkewIsSilent() {
        // A reset already in the past.
        #expect(EarlyQuotaResetDetector.detect(
            previous: beforeEarlyReset,
            current: reading(percent: 0, resetsIn: -3600),
            context: context()
        ) == nil)
        // A reset further out than one whole window.
        #expect(EarlyQuotaResetDetector.detect(
            previous: beforeEarlyReset,
            current: reading(percent: 0, resetsIn: week + 2 * 3600),
            context: context()
        ) == nil)
        // The clock went backwards between the two fetches.
        #expect(EarlyQuotaResetDetector.detect(
            previous: reading(percent: 80, resetsIn: 18 * 3600, observedAgo: -600),
            current: afterEarlyReset,
            context: context()
        ) == nil)
        // A stored reset further out than a window is stale or skewed state.
        #expect(EarlyQuotaResetDetector.detect(
            previous: reading(percent: 80, resetsIn: week + 2 * 3600, observedAgo: 300),
            current: afterEarlyReset,
            context: context()
        ) == nil)
    }

    @Test("A window appearing or disappearing between fetches stays silent")
    func windowComingAndGoingIsSilent() {
        #expect(EarlyQuotaResetDetector.detect(
            previous: nil, current: afterEarlyReset, context: context()
        ) == nil)
        #expect(EarlyQuotaResetDetector.detect(
            previous: beforeEarlyReset, current: nil, context: context()
        ) == nil)
    }

    @Test("The first ever observation of a window stays silent")
    func firstObservationIsSilent() {
        #expect(EarlyQuotaResetDetector.detect(
            previous: nil, current: afterEarlyReset, context: context()
        ) == nil)
    }

    @Test("A provider reconnecting after a failure stays silent")
    func reconnectIsSilent() {
        let event = EarlyQuotaResetDetector.detect(
            previous: beforeEarlyReset,
            current: afterEarlyReset,
            context: context(baselineIsTrusted: false)
        )
        #expect(event == nil)
        #expect(SubscriptionLoadState.terminalFailure(reason: nil).earlyResetBaselineIsTrusted == false)
        #expect(SubscriptionLoadState.bootstrapping.earlyResetBaselineIsTrusted == false)
        #expect(SubscriptionLoadState.noCredentials.earlyResetBaselineIsTrusted == false)
        #expect(SubscriptionLoadState.notBootstrapped.earlyResetBaselineIsTrusted == false)
        #expect(SubscriptionLoadState.loaded.earlyResetBaselineIsTrusted)
        #expect(SubscriptionLoadState.dormant.earlyResetBaselineIsTrusted)
    }

    @Test("A malformed stored snapshot is no opinion, never an event")
    func malformedBaselineIsSilent() {
        for percent in [150.0, -1.0, Double.nan] {
            #expect(EarlyQuotaResetDetector.detect(
                previous: EarlyQuotaResetReading(
                    percent: percent,
                    resetsAt: now.addingTimeInterval(18 * 3600),
                    observedAt: now.addingTimeInterval(-300)
                ),
                current: afterEarlyReset,
                context: context()
            ) == nil)
        }
    }

    @Test("A window with no validated duration stays silent")
    func unknownDurationIsSilent() {
        #expect(EarlyQuotaResetDetector.detect(
            previous: beforeEarlyReset, current: afterEarlyReset, context: context(windowSeconds: nil)
        ) == nil)
    }

    @Test("Rounding noise and partial drops are not a reset")
    func smallMovesAreSilent() {
        // A percent that dips by rounding.
        #expect(EarlyQuotaResetDetector.detect(
            previous: reading(percent: 80, resetsIn: 18 * 3600, observedAgo: 300),
            current: reading(percent: 79, resetsIn: 18 * 3600),
            context: context()
        ) == nil)
        // A big fall that does not land near empty: not "your capacity is back".
        #expect(EarlyQuotaResetDetector.detect(
            previous: reading(percent: 95, resetsIn: 18 * 3600, observedAgo: 300),
            current: reading(percent: 40, resetsIn: 18 * 3600),
            context: context()
        ) == nil)
    }

    @Test("A stored reset further out than one whole window is skew, on either signal")
    func staleBaselineIsSilent() {
        // Signal 2's shape: the reset time effectively holds still and usage
        // empties, with the current reset just inside the horizon while the
        // stored one sits beyond it. A baseline that claims this cycle is due
        // further out than the window is long cannot say when it was due at all.
        #expect(EarlyQuotaResetDetector.detect(
            previous: reading(percent: 92, resetsIn: week + 1000, observedAgo: 300),
            current: reading(percent: 1, resetsIn: week + 500),
            context: context()
        ) == nil)
        // And the plain case: a current reset beyond one whole window.
        #expect(EarlyQuotaResetDetector.detect(
            previous: reading(percent: 92, resetsIn: week + 2 * 3600, observedAgo: 300),
            current: reading(percent: 1, resetsIn: week + 2 * 3600),
            context: context()
        ) == nil)
    }

    @Test("A small drop to near-empty is noise, not a reset")
    func smallDropToNearEmptyIsSilent() {
        // A lightly-used window shedding a few points (rolling decay, a vendor
        // recount) lands near empty without any capacity having been given back.
        #expect(EarlyQuotaResetDetector.detect(
            previous: reading(percent: 20, resetsIn: 18 * 3600, observedAgo: 300),
            current: reading(percent: 8, resetsIn: 18 * 3600),
            context: context()
        ) == nil)
    }

    @Test("A reset time that only creeps forward is not a new cycle")
    func rollingCreepIsSilent() {
        // A rolling window's reset time advances with the clock; the new value is
        // nowhere near a full window after the previous observation.
        #expect(EarlyQuotaResetDetector.detect(
            previous: reading(percent: 80, resetsIn: 18 * 3600, observedAgo: 300),
            current: reading(percent: 0, resetsIn: 18 * 3600 + 1800),
            context: context()
        ) == nil)
    }

    @Test("The lead rounds to the unit it prints")
    func leadRounds() {
        // 1h57m is nearer two hours than one; truncating read it as "1h".
        #expect(EarlyQuotaResetFormat.lead(seconds: 7020) == "2h")
        #expect(EarlyQuotaResetFormat.lead(seconds: 18 * 3600) == "18h")
        #expect(EarlyQuotaResetFormat.lead(seconds: 2 * 86400 + 12 * 3600 + 47 * 60) == "2d 13h")
        #expect(EarlyQuotaResetFormat.lead(seconds: 35 * 60) == "35m")
        #expect(EarlyQuotaResetFormat.lead(seconds: 2 * 86400) == "2d")
    }

    @Test("A reset time that jumps less than a window is not a new cycle")
    func partialWindowJumpIsSilent() {
        // Four days on from a weekly cycle we last saw moments ago is nowhere
        // near a full window after that look, so it is not a cycle boundary
        // however far the reset time moved.
        #expect(EarlyQuotaResetDetector.detect(
            previous: reading(percent: 80, resetsIn: 18 * 3600, observedAgo: 300),
            current: reading(percent: 0, resetsIn: 4 * 24 * 3600),
            context: context()
        ) == nil)
    }

    @Test("A reset time moving backwards is neither signal")
    func backwardsResetIsSilent() {
        #expect(EarlyQuotaResetDetector.detect(
            previous: reading(percent: 80, resetsIn: 30 * 3600, observedAgo: 300),
            current: reading(percent: 0, resetsIn: 18 * 3600),
            context: context()
        ) == nil)
    }

    @Test("A new cycle that gives nothing back is not announced")
    func noCapacityReturnedIsSilent() {
        #expect(EarlyQuotaResetDetector.detect(
            previous: reading(percent: 0, resetsIn: 18 * 3600, observedAgo: 300),
            current: afterEarlyReset,
            context: context()
        ) == nil)
    }
}

@Suite("Early quota reset notifications")
@MainActor
struct EarlyQuotaResetMonitorTests {
    @Test("An early reset notifies once, naming the provider and the lead")
    func notifiesOnce() async throws {
        try await withIsolatedMonitor { monitor, notifier, _ in
            await seedBaseline(monitor)
            let event = await monitor.record(
                providerID: "claude",
                providerName: "Claude",
                planLabel: "Max 20x",
                baselineIsTrusted: true,
                observations: [weeklyObservation(afterEarlyReset)],
                now: now
            )
            #expect(event?.signal == .resetMovedForward)
            #expect(notifier.posts.count == 1)
            #expect(notifier.posts.first?.title == "Claude quota reset early")
            #expect(notifier.posts.first?.body == "Claude's weekly limit reset 18h early. You're back to 100%.")
        }
    }

    @Test("Several windows resetting in one fetch are one notification, named after the longest")
    func coalescesAcrossWindows() async throws {
        try await withIsolatedMonitor { monitor, notifier, _ in
            await monitor.record(
                providerID: "claude", providerName: "Claude", planLabel: "Max 20x",
                baselineIsTrusted: true,
                observations: [
                    weeklyObservation(beforeEarlyReset),
                    fiveHourObservation(reading(percent: 70, resetsIn: 3 * 3600, observedAgo: 300)),
                ],
                now: now.addingTimeInterval(-300)
            )
            let event = await monitor.record(
                providerID: "claude", providerName: "Claude", planLabel: "Max 20x",
                baselineIsTrusted: true,
                observations: [
                    weeklyObservation(afterEarlyReset),
                    fiveHourObservation(reading(percent: 0, resetsIn: fiveHours)),
                ],
                now: now
            )
            #expect(notifier.posts.count == 1)
            #expect(event?.windowKey == "seven_day")
        }
    }

    @Test("The same event is not announced again after a relaunch or a vendor flip-flop")
    func doesNotRepeatAcrossRelaunch() async throws {
        try await withIsolatedMonitor { monitor, notifier, defaults in
            await seedBaseline(monitor)
            await monitor.record(
                providerID: "claude", providerName: "Claude", planLabel: "Max 20x",
                baselineIsTrusted: true,
                observations: [weeklyObservation(afterEarlyReset)],
                now: now
            )
            #expect(notifier.posts.count == 1)

            // Relaunch over the same defaults, and the vendor briefly serves the
            // old cycle again before the new one.
            let relaunched = EarlyQuotaResetMonitor(defaults: defaults, makeNotifier: { notifier })
            await relaunched.record(
                providerID: "claude", providerName: "Claude", planLabel: "Max 20x",
                baselineIsTrusted: true,
                observations: [weeklyObservation(reading(percent: 80, resetsIn: 18 * 3600 - 600))],
                now: now.addingTimeInterval(600)
            )
            await relaunched.record(
                providerID: "claude", providerName: "Claude", planLabel: "Max 20x",
                baselineIsTrusted: true,
                observations: [weeklyObservation(reading(percent: 0, resetsIn: week))],
                now: now.addingTimeInterval(1200)
            )
            #expect(notifier.posts.count == 1)
        }
    }

    @Test("Toggle off posts nothing and never asks for authorization")
    func toggleOffStaysSilent() async throws {
        try await withIsolatedMonitor { monitor, notifier, defaults in
            defaults.set(false, forKey: EarlyQuotaResetPreference.defaultsKey)
            await seedBaseline(monitor)
            let event = await monitor.record(
                providerID: "claude", providerName: "Claude", planLabel: "Max 20x",
                baselineIsTrusted: true,
                observations: [weeklyObservation(afterEarlyReset)],
                now: now
            )
            #expect(event != nil)
            #expect(notifier.posts.isEmpty)
            #expect(notifier.authorizationRequests == 0)
        }
    }

    @Test("Tapping an early-reset notice does not install an update")
    func notificationIsNotAnUpdateNotice() async throws {
        // The notification delegate installs an update for any tap whose
        // identifier carries UpdateChecker's prefix, and every poster shares
        // that delegate. Ours must not look like a release notice.
        try await withIsolatedMonitor { monitor, notifier, _ in
            await seedBaseline(monitor)
            await monitor.record(
                providerID: "claude", providerName: "Claude", planLabel: "Max 20x",
                baselineIsTrusted: true,
                observations: [weeklyObservation(afterEarlyReset)],
                now: now
            )
            let identifier = try #require(notifier.posts.first?.identifier)
            #expect(identifier.hasPrefix("EarlyQuotaReset."))
            #expect(!identifier.hasPrefix(UpdateChecker.notificationIdentifierPrefix))
        }
    }

    @Test("Denied authorization posts nothing")
    func deniedAuthorizationPostsNothing() async throws {
        try await withIsolatedMonitor { monitor, notifier, _ in
            notifier.authorized = false
            await seedBaseline(monitor)
            await monitor.record(
                providerID: "claude", providerName: "Claude", planLabel: "Max 20x",
                baselineIsTrusted: true,
                observations: [weeklyObservation(afterEarlyReset)],
                now: now
            )
            #expect(notifier.posts.isEmpty)
            #expect(notifier.authorizationRequests == 1)
        }
    }

    @Test("The first fetch only seeds a baseline")
    func firstFetchIsSilent() async throws {
        try await withIsolatedMonitor { monitor, notifier, _ in
            let event = await monitor.record(
                providerID: "claude", providerName: "Claude", planLabel: "Max 20x",
                baselineIsTrusted: true,
                observations: [weeklyObservation(afterEarlyReset)],
                now: now
            )
            #expect(event == nil)
            #expect(notifier.posts.isEmpty)
        }
    }

    @Test("Disconnecting drops the baseline so a reconnect cannot fire on stale state")
    func forgetClearsState() async throws {
        try await withIsolatedMonitor { monitor, notifier, _ in
            await seedBaseline(monitor)
            monitor.forget(providerID: "claude")
            await monitor.record(
                providerID: "claude", providerName: "Claude", planLabel: "Max 20x",
                baselineIsTrusted: true,
                observations: [weeklyObservation(afterEarlyReset)],
                now: now
            )
            #expect(notifier.posts.isEmpty)
        }
    }

}

// MARK: - Helpers

private func weeklyObservation(_ reading: EarlyQuotaResetReading?) -> EarlyQuotaResetMonitor.Observation {
    EarlyQuotaResetMonitor.Observation(
        windowKey: "seven_day",
        windowName: "weekly limit",
        windowSeconds: weekSeconds,
        reading: reading
    )
}

private func fiveHourObservation(_ reading: EarlyQuotaResetReading?) -> EarlyQuotaResetMonitor.Observation {
    EarlyQuotaResetMonitor.Observation(
        windowKey: "five_hour",
        windowName: "5-hour limit",
        windowSeconds: 5 * 3600,
        reading: reading
    )
}

@MainActor
private func seedBaseline(_ monitor: EarlyQuotaResetMonitor) async {
    await monitor.record(
        providerID: "claude",
        providerName: "Claude",
        planLabel: "Max 20x",
        baselineIsTrusted: true,
        observations: [weeklyObservation(beforeEarlyReset)],
        now: now.addingTimeInterval(-300)
    )
}

@MainActor
private func withIsolatedMonitor(
    _ body: @MainActor (EarlyQuotaResetMonitor, RecordingEarlyResetNotifier, UserDefaults) async throws -> Void
) async throws {
    let suiteName = "codeburn.quota.earlyReset.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suiteName))
    defaults.removePersistentDomain(forName: suiteName)
    defer { defaults.removePersistentDomain(forName: suiteName) }

    let notifier = RecordingEarlyResetNotifier()
    let monitor = EarlyQuotaResetMonitor(defaults: defaults, makeNotifier: { notifier })
    try await body(monitor, notifier, defaults)
}

@MainActor
private final class RecordingEarlyResetNotifier: UpdateNotifier {
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
