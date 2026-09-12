import Foundation
import Testing
@testable import CodeBurnMenubar

private let now = Date(timeIntervalSince1970: 1_800_000_000)
private let week: TimeInterval = 7 * 24 * 3600
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
    func resetTimeJumpIsDetected() {
        let event = EarlyQuotaResetDetector.detect(
            previous: beforeEarlyReset, current: afterEarlyReset, context: context()
        )
        #expect(event?.signal == .resetMovedForward)
        #expect(event?.earlyBySeconds == 18 * 3600)
        #expect(event?.percentBefore == 80)
        #expect(event?.percentAfter == 0)
        #expect(event?.notificationBody == "Claude's weekly limit reset 18h early. You're back to 100%.")
        #expect(event?.noticeText == "Weekly limit reset 18h early")
    }

    @Test("Usage emptying while the reset time stands still is an early reset")
    func percentDropIsDetected() {
        let event = EarlyQuotaResetDetector.detect(
            previous: reading(percent: 92, resetsIn: 18 * 3600, observedAgo: 300),
            current: reading(percent: 1, resetsIn: 18 * 3600),
            context: context()
        )
        #expect(event?.signal == .usageDropped)
        #expect(event?.earlyBySeconds == 18 * 3600)
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

@Suite("Early quota reset history")
struct EarlyQuotaResetHistoryTests {
    private func snapshots(resetOffsets: [TimeInterval], windowKey: String = "seven_day") -> [SubscriptionSnapshot] {
        resetOffsets.map { offset in
            SubscriptionSnapshot(
                windowKey: windowKey,
                percent: 50,
                resetsAt: now.addingTimeInterval(offset),
                capturedAt: now.addingTimeInterval(offset - 3600),
                effectiveTokens: nil
            )
        }
    }

    @Test("Three consecutive weekly cycles that each landed 18h early read as a pattern")
    func consistentEarlyResets() {
        let early: TimeInterval = 18 * 3600
        // Each cycle ends a window after the previous reset, minus the lead.
        var offsets: [TimeInterval] = [-3 * week]
        for _ in 0..<3 { offsets.append(offsets.last! + week - early) }
        let summary = EarlyQuotaResetHistory.summarize(
            snapshots: snapshots(resetOffsets: offsets),
            windowKey: "seven_day",
            windowName: "weekly limit",
            windowSeconds: weekSeconds
        )
        #expect(summary?.earlyResets == 3)
        #expect(summary?.observedResets == 3)
        #expect(summary?.typicalEarlyBySeconds == early)
        #expect(summary?.caption == "Last 3 weekly resets came ~18h early")
    }

    @Test("Cycles that ran to schedule produce no summary")
    func onScheduleResetsHaveNoPattern() {
        let offsets: [TimeInterval] = [-3 * week, -2 * week, -week, 0]
        #expect(EarlyQuotaResetHistory.summarize(
            snapshots: snapshots(resetOffsets: offsets),
            windowKey: "seven_day",
            windowName: "weekly limit",
            windowSeconds: weekSeconds
        ) == nil)
    }

    @Test("A mixed record says how many of the observed resets were early")
    func mixedRecord() {
        let early: TimeInterval = 12 * 3600
        let offsets: [TimeInterval] = [
            -3 * week,
            -3 * week + week - early,
            -3 * week + 2 * week - early,
            -3 * week + 3 * week - early * 2,
        ]
        let summary = EarlyQuotaResetHistory.summarize(
            snapshots: snapshots(resetOffsets: offsets),
            windowKey: "seven_day",
            windowName: "weekly limit",
            windowSeconds: weekSeconds
        )
        #expect(summary?.observedResets == 3)
        #expect(summary?.earlyResets == 2)
        #expect(summary?.caption == "2 of the last 3 weekly resets came ~12h early")
    }

    @Test("Short windows get no pattern, the same discipline the pace ETA uses")
    func shortWindowsHaveNoPattern() {
        let offsets: [TimeInterval] = [0, fiveHours - 2 * 3600, 2 * (fiveHours - 2 * 3600)]
        #expect(EarlyQuotaResetHistory.summarize(
            snapshots: snapshots(resetOffsets: offsets, windowKey: "five_hour"),
            windowKey: "five_hour",
            windowName: "5-hour limit",
            windowSeconds: 5 * 3600
        ) == nil)
    }

    @Test("A single observed cycle is not a pattern")
    func oneCycleHasNoPattern() {
        #expect(EarlyQuotaResetHistory.summarize(
            snapshots: snapshots(resetOffsets: [0]),
            windowKey: "seven_day",
            windowName: "weekly limit",
            windowSeconds: weekSeconds
        ) == nil)
    }

    @Test("Cycles the store never saw are not read as timing evidence")
    func unobservedCyclesAreSkipped() {
        // A gap of three windows: the app was closed. That pair says nothing.
        #expect(EarlyQuotaResetHistory.summarize(
            snapshots: snapshots(resetOffsets: [-4 * week, -week]),
            windowKey: "seven_day",
            windowName: "weekly limit",
            windowSeconds: weekSeconds
        ) == nil)
    }

    @Test("A gap in the record is not counted among the resets the summary speaks for")
    func unobservedCyclesAreNotCounted() {
        let early: TimeInterval = 18 * 3600
        let first = -5 * week
        // Three windows pass unobserved, then one cycle that landed early.
        let resumed = first + 3 * week
        let summary = EarlyQuotaResetHistory.summarize(
            snapshots: snapshots(resetOffsets: [first, resumed, resumed + week - early]),
            windowKey: "seven_day",
            windowName: "weekly limit",
            windowSeconds: weekSeconds
        )
        #expect(summary?.observedResets == 1)
        #expect(summary?.earlyResets == 1)
        #expect(summary?.caption == "Last weekly reset came ~18h early")
    }

    @Test("Jittered reset timestamps inside one cycle collapse to that cycle")
    func jitterIsCollapsed() {
        let early: TimeInterval = 18 * 3600
        let first = -2 * week
        let second = first + week - early
        let offsets: [TimeInterval] = [first, first + 90, second, second + 120]
        let summary = EarlyQuotaResetHistory.summarize(
            snapshots: snapshots(resetOffsets: offsets),
            windowKey: "seven_day",
            windowName: "weekly limit",
            windowSeconds: weekSeconds
        )
        #expect(summary?.observedResets == 1)
        #expect(summary?.earlyResets == 1)
        #expect(summary?.caption == "Last weekly reset came ~18h early")
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

    @Test("Toggle off posts nothing and never asks for authorization, but the dock still shows it")
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
            #expect(monitor.visibleEvent(providerID: "claude", now: now) != nil)
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
            #expect(monitor.visibleEvent(providerID: "claude", now: now) == nil)
        }
    }

    @Test("The dock band is bounded in time")
    func noticeExpires() async throws {
        try await withIsolatedMonitor { monitor, _, _ in
            await seedBaseline(monitor)
            await monitor.record(
                providerID: "claude", providerName: "Claude", planLabel: "Max 20x",
                baselineIsTrusted: true,
                observations: [weeklyObservation(afterEarlyReset)],
                now: now
            )
            let stillVisible = EarlyQuotaResetNotice.visibleSeconds - 60
            #expect(monitor.visibleEvent(providerID: "claude", now: now.addingTimeInterval(stillVisible)) != nil)
            #expect(monitor.visibleEvent(
                providerID: "claude",
                now: now.addingTimeInterval(EarlyQuotaResetNotice.visibleSeconds + 60)
            ) == nil)
        }
    }
}

@Suite("Capacity Dock early reset band")
struct EarlyQuotaResetDockTests {
    @Test("The band is a notice the computed panel height reserves")
    func bandIsReserved() {
        let quota = QuotaSummary(
            providerFilter: .claude,
            connection: .connected,
            primary: nil,
            details: [QuotaSummary.Window(label: "Weekly", percent: 0.2, resetsAt: now)],
            planLabel: "Max 20x",
            footerLines: []
        )
        func height(_ hasBand: Bool) -> CGFloat {
            CapacityDockMetrics.detailHeight(
                quota: quota,
                sessionCount: 1,
                hasToday: true,
                tailEdge: .right,
                scale: 1,
                hasEarlyResetNotice: hasBand
            )
        }
        #expect(height(true) == height(false) + CapacityDockGlance.noticeHeight)
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
