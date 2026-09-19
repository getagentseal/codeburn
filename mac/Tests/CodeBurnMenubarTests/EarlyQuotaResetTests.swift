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

// MARK: - Review fixes (#1339): anchoring, spend caps, stable identity

@Test("A successor schedule meaningfully EARLIER than the old one is a flip-flop, not a reset")
func backwardsSuccessorStaysSilent() throws {
    // A replica briefly serving a cycle whose reset sits before the one we
    // already stored is the flip-flop the announcement dedupe also guards; the
    // detector itself stays silent on it rather than feeding it forward.
    let previous = EarlyQuotaResetReading(
        percent: 80,
        resetsAt: now.addingTimeInterval(eighteenHours),
        observedAt: now.addingTimeInterval(-300)
    )
    let current = EarlyQuotaResetReading(
        percent: 0,
        resetsAt: now.addingTimeInterval(eighteenHours).addingTimeInterval(-3 * 3600),
        observedAt: now
    )
    #expect(EarlyQuotaResetDetector.detect(previous: previous, current: current, context: context()) == nil)
}

@Test("A rolling window re-anchoring across a fetch gap is excluded by the duration contract, not detected")
func rollingTrackerNeedsTheContract() throws {
    // The pair is genuinely indistinguishable from a cut-short cycle (see the
    // detector's type doc): reset moved forward by the observation gap, percent
    // fell across the boundary. The guard is that the ADAPTER passes
    // windowSeconds only for cycles it can vouch are fixed — so with no
    // vouched duration, the detector has no opinion at all.
    let gap: TimeInterval = 30 * 60
    let previous = EarlyQuotaResetReading(
        percent: 70,
        resetsAt: now.addingTimeInterval(-gap).addingTimeInterval(week),
        observedAt: now.addingTimeInterval(-gap)
    )
    let current = EarlyQuotaResetReading(
        percent: 5,
        resetsAt: now.addingTimeInterval(week),
        observedAt: now
    )
    #expect(EarlyQuotaResetDetector.detect(previous: previous, current: current, context: context(windowSeconds: nil)) == nil)
}

@Test("Sub-tolerance creep of the reset time is not a new cycle")
func creepingResetStaysSilent() throws {
    // A fixed window's vendor jitters `resets_at` by seconds between fetches;
    // only a move past the skew tolerance can begin signal 1.
    let previous = EarlyQuotaResetReading(
        percent: 60,
        resetsAt: now.addingTimeInterval(week),
        observedAt: now.addingTimeInterval(-300)
    )
    let current = EarlyQuotaResetReading(
        percent: 2,
        resetsAt: now.addingTimeInterval(week + 45),
        observedAt: now
    )
    // Jump is under the tolerance, so the reading falls through to signal 2's
    // ratio test — which this percent collapse satisfies, so it reports the
    // usage-dropped form, never reset-moved-forward.
    let event = try #require(EarlyQuotaResetDetector.detect(previous: previous, current: current, context: context()))
    #expect(event.signal == .usageDropped)
}

@Test("A Codex spend-cap increase is not a goodwill reset even when the ratio collapses")
func spendCapIncreaseStaysSilent() throws {
    // Limit raised 100 -> 1000 credits; usage ROSE 90 -> 95; the ratio fell
    // 90% -> 9.5%, satisfying both the 40-point drop and the ≤10% landing of
    // signal 2. The absolute figures say the vendor gave capacity by raising
    // the cap, not by clearing the counter, so it stays silent.
    let previous = EarlyQuotaResetReading(
        percent: 90, resetsAt: now.addingTimeInterval(week), observedAt: now.addingTimeInterval(-300), usedUnits: 90
    )
    let current = EarlyQuotaResetReading(
        percent: 9.5, resetsAt: now.addingTimeInterval(week), observedAt: now, usedUnits: 95
    )
    #expect(EarlyQuotaResetDetector.detect(previous: previous, current: current, context: context()) == nil)
}

@Test("A real cleared counter falls in absolute units too and still fires")
func clearedCounterStillFiresWithUnits() throws {
    let previous = EarlyQuotaResetReading(
        percent: 80, resetsAt: now.addingTimeInterval(week), observedAt: now.addingTimeInterval(-300), usedUnits: 800
    )
    let current = EarlyQuotaResetReading(
        percent: 2, resetsAt: now.addingTimeInterval(week), observedAt: now, usedUnits: 20
    )
    let event = try #require(EarlyQuotaResetDetector.detect(previous: previous, current: current, context: context()))
    #expect(event.signal == .usageDropped)
}

@Test("Percent-only providers keep the ratio test (Claude has no absolute units)")
func percentOnlyDropStillFires() throws {
    let previous = EarlyQuotaResetReading(
        percent: 80, resetsAt: now.addingTimeInterval(week), observedAt: now.addingTimeInterval(-300)
    )
    let current = EarlyQuotaResetReading(
        percent: 2, resetsAt: now.addingTimeInterval(week), observedAt: now
    )
    let event = try #require(EarlyQuotaResetDetector.detect(previous: previous, current: current, context: context()))
    #expect(event.signal == .usageDropped)
}

@Test("A window keyed from a localized or state-suffixed display label is keyed by its storage label instead")
func storageLabelStabilizesTheKey() {
    // The Codex credit row's display label localizes and appends "· limit
    // reached"; both the reached and unreached, English and translated forms
    // must resolve to ONE storage identity via storageLabel.
    let displayVariants = [
        "Monthly usage limit",
        "Monthly usage limit · limit reached",
        "每月使用限额",
        "每月使用限额 · 已达上限",
    ]
    let keys = Set(displayVariants.map { EarlyQuotaResetFormat.windowKey(forLabel: $0) })
    // Slugs of the display forms disagree (the old behavior: four baselines,
    // two of them shared between languages); the adapter passes storageLabel
    // so the caller never slugifies any of these.
    #expect(keys.count > 1)
    #expect(EarlyQuotaResetFormat.windowKey(forLabel: "Monthly usage limit") == "monthly_usage_limit")
}

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

// MARK: - Codex, not just Claude

/// One provider's identity for the same weekly window, so the guards below run
/// unchanged against Claude and Codex. Codex's window has no key of its own:
/// unlike Claude's it is identified by its display label.
struct EarlyResetProviderCase: Sendable, CustomStringConvertible {
    let providerID: String
    let providerName: String
    let windowKey: String
    let windowName: String
    let planLabel: String

    var description: String { providerName }
}

private let claudeCase = EarlyResetProviderCase(
    providerID: "claude",
    providerName: "Claude",
    windowKey: "seven_day",
    windowName: "weekly limit",
    planLabel: "Max 20x"
)

private let codexCase = EarlyResetProviderCase(
    providerID: "codex",
    providerName: "Codex",
    windowKey: EarlyQuotaResetFormat.windowKey(forLabel: "Weekly"),
    windowName: EarlyQuotaResetFormat.windowName(forLabel: "Weekly"),
    planLabel: "Plus"
)

private let everyProviderCase = [claudeCase, codexCase]

private func context(
    _ provider: EarlyResetProviderCase,
    windowSeconds: Int? = weekSeconds,
    previousPlanLabel: String? = nil,
    currentPlanLabel: String? = nil,
    baselineIsTrusted: Bool = true
) -> EarlyQuotaResetDetector.Context {
    EarlyQuotaResetDetector.Context(
        providerID: provider.providerID,
        providerName: provider.providerName,
        windowKey: provider.windowKey,
        windowName: provider.windowName,
        windowSeconds: windowSeconds,
        previousPlanLabel: previousPlanLabel ?? provider.planLabel,
        currentPlanLabel: currentPlanLabel ?? provider.planLabel,
        baselineIsTrusted: baselineIsTrusted
    )
}

@Suite("Early quota reset detection, Claude and Codex")
struct EarlyQuotaResetProviderScopeTests {
    @Test("Both signals fire for any provider and name it", arguments: everyProviderCase)
    func bothSignalsFire(_ provider: EarlyResetProviderCase) throws {
        let jumped = try #require(EarlyQuotaResetDetector.detect(
            previous: beforeEarlyReset, current: afterEarlyReset, context: context(provider)
        ))
        #expect(jumped.providerID == provider.providerID)
        #expect(jumped.signal == .resetMovedForward)
        #expect(jumped.earlyBySeconds == eighteenHours)
        #expect(jumped.notificationTitle == "\(provider.providerName) quota reset early")
        #expect(jumped.notificationBody
            == "\(provider.providerName)'s weekly limit reset 18h early. You're back to 100%.")

        let dropped = try #require(EarlyQuotaResetDetector.detect(
            previous: reading(percent: 92, resetsIn: eighteenHours, observedAgo: 300),
            current: reading(percent: 1, resetsIn: eighteenHours),
            context: context(provider)
        ))
        #expect(dropped.providerID == provider.providerID)
        #expect(dropped.signal == .usageDropped)
        #expect(dropped.notificationTitle == "\(provider.providerName) quota cleared early")
        #expect(dropped.notificationBody
            == "\(provider.providerName) cleared your weekly usage 18h before its reset. "
            + "You're back to 99%.")
        for text in [dropped.notificationTitle, dropped.notificationBody] {
            #expect(!text.contains("reset early"))
        }
    }

    @Test("A window named only by its display label gets a stable key and readable copy")
    func labelDerivedNaming() throws {
        #expect(EarlyQuotaResetFormat.windowKey(forLabel: "Weekly") == "weekly")
        #expect(EarlyQuotaResetFormat.windowKey(forLabel: "5-hour") == "5_hour")
        #expect(EarlyQuotaResetFormat.windowKey(forLabel: "GPT-5.3-Codex-Spark · Weekly")
            == "gpt_5_3_codex_spark_weekly")
        // Sibling rows must not collide, or one would overwrite the other's
        // baseline inside the same provider record.
        let keys = ["Weekly", "5-hour", "Monthly usage limit", "Auto", "API"]
            .map(EarlyQuotaResetFormat.windowKey(forLabel:))
        #expect(Set(keys).count == keys.count)

        #expect(EarlyQuotaResetFormat.windowName(forLabel: "Weekly") == "weekly limit")
        #expect(EarlyQuotaResetFormat.windowName(forLabel: "5-hour") == "5-hour limit")
        // A label that already names what it caps keeps its own noun, and the
        // usage phrasing must not double it into "monthly usage usage".
        #expect(EarlyQuotaResetFormat.windowName(forLabel: "Monthly usage limit")
            == "monthly usage limit")
        let event = try #require(EarlyQuotaResetDetector.detect(
            previous: reading(percent: 92, resetsIn: eighteenHours, observedAgo: 300),
            current: reading(percent: 1, resetsIn: eighteenHours),
            context: EarlyQuotaResetDetector.Context(
                providerID: "codex",
                providerName: "Codex",
                windowKey: EarlyQuotaResetFormat.windowKey(forLabel: "Monthly usage limit"),
                windowName: EarlyQuotaResetFormat.windowName(forLabel: "Monthly usage limit"),
                windowSeconds: 30 * 24 * 3600,
                previousPlanLabel: "Plus",
                currentPlanLabel: "Plus",
                baselineIsTrusted: true
            )
        ))
        #expect(event.notificationBody
            == "Codex cleared your monthly usage 18h before its reset. You're back to 99%.")
    }
}

@Suite("Early quota reset, provider isolation and stored state")
@MainActor
struct EarlyQuotaResetProviderStateTests {
    @Test("An early reset on one provider never moves another's state")
    func providersAreIsolated() async throws {
        try await withIsolatedMonitor { monitor, notifier, _ in
            // Both providers see the same pre-reset window.
            for id in ["claude", "codex"] {
                await monitor.record(
                    providerID: id, providerName: id == "claude" ? "Claude" : "Codex",
                    planLabel: "Max 20x", baselineIsTrusted: true,
                    observations: [providerObservation(id, beforeEarlyReset)],
                    now: now.addingTimeInterval(-300)
                )
            }
            // Only Claude resets early.
            let claudeEvent = await monitor.record(
                providerID: "claude", providerName: "Claude", planLabel: "Max 20x",
                baselineIsTrusted: true,
                observations: [providerObservation("claude", afterEarlyReset)],
                now: now
            )
            #expect(claudeEvent?.providerID == "claude")
            #expect(notifier.posts.count == 1)
            #expect(notifier.posts.first?.title == "Claude quota reset early")

            // Codex resets too, off its own untouched baseline, and is announced
            // in its own name.
            let codexEvent = await monitor.record(
                providerID: "codex", providerName: "Codex", planLabel: "Max 20x",
                baselineIsTrusted: true,
                observations: [providerObservation("codex", afterEarlyReset)],
                now: now
            )
            #expect(codexEvent?.providerID == "codex")
            #expect(notifier.posts.count == 2)
            #expect(notifier.posts.last?.title == "Codex quota reset early")
        }
    }

    @Test("A Codex reset announced once is not announced again")
    func codexDedupeHolds() async throws {
        try await withIsolatedMonitor { monitor, notifier, defaults in
            await monitor.record(
                providerID: "codex", providerName: "Codex", planLabel: "Plus",
                baselineIsTrusted: true,
                observations: [providerObservation("codex", beforeEarlyReset)],
                now: now.addingTimeInterval(-300)
            )
            await monitor.record(
                providerID: "codex", providerName: "Codex", planLabel: "Plus",
                baselineIsTrusted: true,
                observations: [providerObservation("codex", afterEarlyReset)],
                now: now
            )
            #expect(notifier.posts.count == 1)

            let relaunched = EarlyQuotaResetMonitor(defaults: defaults, makeNotifier: { notifier })
            await relaunched.record(
                providerID: "codex", providerName: "Codex", planLabel: "Plus",
                baselineIsTrusted: true,
                observations: [providerObservation("codex", reading(percent: 80, resetsIn: eighteenHours - 600))],
                now: now.addingTimeInterval(600)
            )
            await relaunched.record(
                providerID: "codex", providerName: "Codex", planLabel: "Plus",
                baselineIsTrusted: true,
                observations: [providerObservation("codex", reading(percent: 0, resetsIn: week))],
                now: now.addingTimeInterval(1200)
            )
            #expect(notifier.posts.count == 1)
        }
    }

    @Test("A Claude record written by the build that shipped this feature still counts")
    func storedClaudeRecordIsCompatible() async throws {
        // Announced already: the update must not re-notify.
        #expect(try await legacyRecordPostCount(announced: true) == 0)
        // The same record with nothing announced does post. Without this the
        // silence above would also be produced by a record the monitor can no
        // longer find or decode, which is exactly the regression to catch.
        #expect(try await legacyRecordPostCount(announced: false) == 1)
    }

    /// Runs one fetch against a state record written in the shape, and under the
    /// exact defaults key, that #1329 shipped.
    private func legacyRecordPostCount(announced: Bool) async throws -> Int {
        var count = 0
        try await withIsolatedMonitor { monitor, notifier, defaults in
            let scheduled = Int(now.addingTimeInterval(eighteenHours).timeIntervalSince1970)
            let observed = Int(now.addingTimeInterval(-300).timeIntervalSince1970)
            let announcedList = announced ? "[\(scheduled)]" : "[]"
            let legacy = """
            {"planLabel":"Max 20x",\
            "windows":{"seven_day":{"percent":80,\
            "resetsAt":\(scheduled),"observedAt":\(observed)}},\
            "announced":{"seven_day":\(announcedList)}}
            """
            // Spelled out, not built from the constant: a changed key must fail
            // this rather than silently take the record with it.
            defaults.set(Data(legacy.utf8), forKey: "codeburn.quota.earlyReset.state.claude")

            await monitor.record(
                providerID: "claude", providerName: "Claude", planLabel: "Max 20x",
                baselineIsTrusted: true,
                observations: [weeklyObservation(afterEarlyReset)],
                now: now
            )
            count = notifier.posts.count
        }
        return count
    }
}

private func providerObservation(
    _ providerID: String,
    _ reading: EarlyQuotaResetReading?
) -> EarlyQuotaResetMonitor.Observation {
    EarlyQuotaResetMonitor.Observation(
        windowKey: providerID == "claude" ? "seven_day" : "weekly",
        windowName: "weekly limit",
        windowSeconds: weekSeconds,
        reading: reading
    )
}

@Suite("Early quota reset wiring, Codex")
@MainActor
struct EarlyQuotaResetCodexWiringTests {
    @Test("A Codex weekly window reset early is announced in Codex's name")
    func codexRefreshAnnounces() async throws {
        try await withCodexStore { store, notifier in
            store.codexQuotaFetcher = { Self.usage(percent: 80, resetsIn: 18 * 3600) }
            #expect(await store.refreshCodexReportingSuccess())
            #expect(notifier.posts.isEmpty)

            store.codexQuotaFetcher = { Self.usage(percent: 0, resetsIn: week) }
            #expect(await store.refreshCodexReportingSuccess())
            #expect(notifier.posts.count == 1)
            #expect(notifier.posts.first?.title == "Codex quota reset early")
            #expect(notifier.posts.first?.body.hasPrefix("Codex's weekly limit reset 18h early.") == true)
        }
    }

    @Test("A Codex window with no validated duration stays silent")
    func codexWithoutDurationIsSilent() async throws {
        try await withCodexStore { store, notifier in
            // The same cleared counter as below, on a credit row whose adapter
            // could not vouch for a fixed cycle length.
            store.codexQuotaFetcher = {
                Self.usage(percent: nil, resetsIn: 18 * 3600, creditWindowSeconds: nil, credit: (used: 900, reached: false))
            }
            _ = await store.refreshCodexReportingSuccess()
            store.codexQuotaFetcher = {
                Self.usage(percent: nil, resetsIn: 18 * 3600, creditWindowSeconds: nil, credit: (used: 0, reached: false))
            }
            _ = await store.refreshCodexReportingSuccess()
            #expect(notifier.posts.isEmpty)
        }
    }

    @Test("The credit row keeps one baseline across the limit-reached boundary")
    func creditRowSurvivesLimitReached() async throws {
        try await withCodexStore { store, notifier in
            // At the limit the display label gains "· limit reached"; the
            // vendor then clears the counter with the reset time unchanged.
            store.codexQuotaFetcher = {
                Self.usage(percent: nil, resetsIn: 18 * 3600, credit: (used: 1000, reached: true))
            }
            _ = await store.refreshCodexReportingSuccess()
            store.codexQuotaFetcher = {
                Self.usage(percent: nil, resetsIn: 18 * 3600, credit: (used: 0, reached: false))
            }
            _ = await store.refreshCodexReportingSuccess()
            #expect(notifier.posts.count == 1)
            #expect(notifier.posts.first?.title == "Codex quota cleared early")
        }
    }

    @Test("A per-model window that reset early to 0% is announced, not dropped for being empty")
    func additionalLimitResetAtZeroAnnounces() async throws {
        try await withCodexStore { store, notifier in
            store.codexQuotaFetcher = { Self.additionalLimitUsage(percent: 80, resetsIn: 18 * 3600) }
            #expect(await store.refreshCodexReportingSuccess())
            #expect(notifier.posts.isEmpty)

            // The window reset early and now sits at 0%. On main this reading is
            // filtered out before the detector sees it, so the reset is missed;
            // the detector must be handed the empty row so it fires once.
            store.codexQuotaFetcher = { Self.additionalLimitUsage(percent: 0, resetsIn: week) }
            #expect(await store.refreshCodexReportingSuccess())
            #expect(notifier.posts.count == 1)
            #expect(notifier.posts.first?.title == "Codex quota reset early")
        }
    }

    private func withCodexStore(
        _ body: @MainActor (AppStore, RecordingEarlyResetNotifier) async throws -> Void
    ) async throws {
        let suiteName = "codeburn.quota.earlyReset.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let notifier = RecordingEarlyResetNotifier()
        let store = AppStore()
        store.earlyQuotaResetMonitor = EarlyQuotaResetMonitor(defaults: defaults, makeNotifier: { notifier })
        store.codexBankedResetAnnouncer = CodexBankedResetAnnouncer(
            defaults: defaults,
            store: MemoryCodexBankedResetStore(),
            makeNotifier: { notifier }
        )
        store.codexLoadState = .loaded
        store.codexQuotaBootstrapChecker = { true }
        try await body(store, notifier)
    }

    /// A weekly rate window, or (with `percent: nil`) a credit-metered
    /// workspace whose only limit is the monthly allowance.
    nonisolated private static func usage(
        percent: Double?,
        resetsIn: TimeInterval,
        creditWindowSeconds: Int? = 30 * 24 * 3600,
        credit: (used: Double, reached: Bool)? = nil
    ) -> CodexUsage {
        let resetsAt = Date().addingTimeInterval(resetsIn)
        return CodexUsage(
            plan: .plus,
            primary: percent.map {
                CodexUsage.Window(
                    usedPercent: $0,
                    resetsAt: resetsAt,
                    limitWindowSeconds: 7 * 24 * 3600
                )
            },
            secondary: nil,
            additionalLimits: [],
            creditsBalance: nil,
            hasCredits: credit != nil,
            creditsUnlimited: false,
            creditLimit: credit.map {
                CodexUsage.CreditLimit(
                    used: $0.used,
                    limit: 1000,
                    usedPercent: $0.used / 10,
                    resetsAt: resetsAt,
                    windowSeconds: creditWindowSeconds,
                    reached: $0.reached
                )
            },
            resetCredits: nil,
            fetchedAt: Date()
        )
    }

    /// A workspace whose only limit is one per-model additional window (e.g.
    /// "GPT-5.3-Codex-Spark"), with no main rate window.
    nonisolated private static func additionalLimitUsage(
        percent: Double,
        resetsIn: TimeInterval
    ) -> CodexUsage {
        CodexUsage(
            plan: .plus,
            primary: nil,
            secondary: nil,
            additionalLimits: [
                CodexUsage.AdditionalLimit(
                    name: "GPT-5.3-Codex-Spark",
                    primary: CodexUsage.Window(
                        usedPercent: percent,
                        resetsAt: Date().addingTimeInterval(resetsIn),
                        limitWindowSeconds: 7 * 24 * 3600
                    ),
                    secondary: nil
                )
            ],
            creditsBalance: nil,
            hasCredits: false,
            creditsUnlimited: false,
            creditLimit: nil,
            resetCredits: nil,
            fetchedAt: Date()
        )
    }
}

private final class MemoryCodexBankedResetStore: CodexBankedResetStateStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var state = CodexBankedResetState()

    func load() async -> CodexBankedResetState { lock.withLock { state } }
    func save(_ state: CodexBankedResetState) async { lock.withLock { self.state = state } }
}
