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
        #expect(event.noticeText == "Weekly limit reset 18h early")
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
        #expect(event.noticeText == "Weekly usage cleared, 18h before reset")
        for text in [event.notificationTitle, event.notificationBody, event.noticeText, event.noticeHelpText] {
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
            // Literal twelve hours: reading the constant back would pin nothing.
            let twelveHours: TimeInterval = 12 * 3600
            #expect(monitor.visibleEvent(
                providerID: "claude", now: now.addingTimeInterval(twelveHours - 60)
            ) != nil)
            #expect(monitor.visibleEvent(
                providerID: "claude", now: now.addingTimeInterval(twelveHours + 60)
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

// MARK: - Every provider, not just Claude

/// One provider's identity for the same weekly window, so the guards below run
/// unchanged against Claude and Codex. Codex's window has no key of its own:
/// like every provider but Claude it is identified by its display label.
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

@Suite("Early quota reset detection, every provider")
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
        for text in [dropped.notificationTitle, dropped.notificationBody,
                     dropped.noticeText, dropped.noticeHelpText] {
            #expect(!text.contains("reset early"))
        }
    }

    @Test("Every false-positive guard holds for every provider", arguments: everyProviderCase)
    func guardsHold(_ provider: EarlyResetProviderCase) {
        func silent(
            _ previous: EarlyQuotaResetReading?,
            _ current: EarlyQuotaResetReading?,
            _ ctx: EarlyQuotaResetDetector.Context,
            _ what: Comment
        ) {
            #expect(
                EarlyQuotaResetDetector.detect(previous: previous, current: current, context: ctx) == nil,
                what
            )
        }
        let base = context(provider)

        // A scheduled reset, which is the common case and the one that must
        // never speak.
        silent(reading(percent: 96, resetsIn: -60, observedAgo: 300),
               reading(percent: 0, resetsIn: week), base, "scheduled reset")
        // A plan change gives capacity back legitimately.
        silent(beforeEarlyReset, afterEarlyReset,
               context(provider, previousPlanLabel: "Pro"), "plan change")
        // Clock and data skew, in all four shapes.
        silent(beforeEarlyReset, reading(percent: 0, resetsIn: -3600), base, "reset in the past")
        silent(beforeEarlyReset, reading(percent: 0, resetsIn: week + 2 * 3600), base, "reset beyond a window")
        silent(reading(percent: 80, resetsIn: eighteenHours, observedAgo: -600),
               afterEarlyReset, base, "clock went backwards")
        silent(reading(percent: 80, resetsIn: week + 2 * 3600, observedAgo: 300),
               afterEarlyReset, base, "stored reset beyond a window")
        // A window that came, went, or has never been seen before.
        silent(nil, afterEarlyReset, base, "no baseline")
        silent(beforeEarlyReset, nil, base, "window absent this fetch")
        // The far side of a gap.
        silent(beforeEarlyReset, afterEarlyReset,
               context(provider, baselineIsTrusted: false), "untrusted baseline")
        // A baseline this build cannot reason about.
        for percent in [150.0, -1.0, Double.nan] {
            silent(EarlyQuotaResetReading(
                percent: percent,
                resetsAt: now.addingTimeInterval(eighteenHours),
                observedAt: now.addingTimeInterval(-300)
            ), afterEarlyReset, base, "malformed baseline")
        }
        // No validated duration: no opinion. This is what keeps the providers
        // whose adapters carry no window length silent.
        silent(beforeEarlyReset, afterEarlyReset,
               context(provider, windowSeconds: nil), "unknown duration")
        // Rounding noise, and a fall that does not land near empty.
        silent(reading(percent: 80, resetsIn: eighteenHours, observedAgo: 300),
               reading(percent: 79, resetsIn: eighteenHours), base, "rounding noise")
        silent(reading(percent: 95, resetsIn: eighteenHours, observedAgo: 300),
               reading(percent: 40, resetsIn: eighteenHours), base, "partial drop")
        silent(reading(percent: 20, resetsIn: eighteenHours, observedAgo: 300),
               reading(percent: 8, resetsIn: eighteenHours), base, "small drop to near-empty")
        // A stored reset further out than one window, on signal 2's shape.
        silent(reading(percent: 92, resetsIn: week + 1000, observedAgo: 300),
               reading(percent: 1, resetsIn: week + 500), base, "stale baseline")
        // A rolling window's reset time creeping forward, and a jump that lands
        // short of a cycle boundary.
        silent(reading(percent: 80, resetsIn: eighteenHours, observedAgo: 300),
               reading(percent: 0, resetsIn: eighteenHours + 1800), base, "rolling creep")
        silent(reading(percent: 80, resetsIn: eighteenHours, observedAgo: 300),
               reading(percent: 0, resetsIn: 4 * 24 * 3600), base, "partial window jump")
        // A reset time moving backwards, and a new cycle that gives nothing back.
        silent(reading(percent: 80, resetsIn: 30 * 3600, observedAgo: 300),
               reading(percent: 0, resetsIn: eighteenHours), base, "backwards reset")
        silent(reading(percent: 0, resetsIn: eighteenHours, observedAgo: 300),
               afterEarlyReset, base, "nothing given back")
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
        #expect(event.noticeText == "Monthly usage cleared, 18h before reset")
    }

    @Test("Every dock provider's display name reads as a sentence")
    func displayNamesReadWell() {
        for provider in CapacityDockPreferences.supportedProviders
        where provider.catalogEntry.hasLiveCodeBurnQuotaAdapter {
            let event = EarlyQuotaResetEvent(
                providerID: provider.rawValue,
                providerName: provider.displayName,
                windowKey: "weekly",
                windowName: "weekly limit",
                signal: .resetMovedForward,
                scheduledResetAt: now.addingTimeInterval(eighteenHours),
                detectedAt: now,
                percentBefore: 80,
                percentAfter: 0
            )
            #expect(event.notificationBody
                == "\(provider.displayName)'s weekly limit reset 18h early. You're back to 100%.")
            // No empty or trailing-space name can reach the copy.
            #expect(!provider.displayName.isEmpty)
            #expect(provider.displayName.trimmingCharacters(in: .whitespaces) == provider.displayName)
        }
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
            // Codex's band stays empty, and its baseline is untouched.
            #expect(monitor.visibleEvent(providerID: "codex", now: now) == nil)

            // Codex resets an hour later, off its own baseline, and is announced
            // in its own name. Claude's band is not replaced.
            let codexEvent = await monitor.record(
                providerID: "codex", providerName: "Codex", planLabel: "Max 20x",
                baselineIsTrusted: true,
                observations: [providerObservation("codex", afterEarlyReset)],
                now: now
            )
            #expect(codexEvent?.providerID == "codex")
            #expect(notifier.posts.count == 2)
            #expect(notifier.posts.last?.title == "Codex quota reset early")
            #expect(monitor.visibleEvent(providerID: "claude", now: now)?.providerID == "claude")
            #expect(monitor.visibleEvent(providerID: "codex", now: now)?.providerID == "codex")

            // And forgetting one leaves the other standing.
            monitor.forget(providerID: "claude")
            #expect(monitor.visibleEvent(providerID: "claude", now: now) == nil)
            #expect(monitor.visibleEvent(providerID: "codex", now: now) != nil)
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
    /// exact defaults key, that #1329 shipped: no cycle ledger, no latest event.
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

    @Test("The cycle ledger keeps one entry per cycle, so any provider can have a pattern")
    func ledgerFeedsTheHistorySummary() async throws {
        try await withIsolatedMonitor { monitor, _, _ in
            // Four weekly cycles, each landing 18h early, each seen by several
            // fetches with a jittered reset timestamp.
            var resetsAt = now
            for _ in 0..<4 {
                for fetch in 0..<3 {
                    let jitter = TimeInterval(fetch) * 30
                    await monitor.record(
                        providerID: "codex", providerName: "Codex", planLabel: "Plus",
                        baselineIsTrusted: true,
                        observations: [providerObservation("codex", EarlyQuotaResetReading(
                            percent: 10,
                            resetsAt: resetsAt.addingTimeInterval(jitter),
                            observedAt: resetsAt.addingTimeInterval(-week + TimeInterval(fetch))
                        ))],
                        now: resetsAt.addingTimeInterval(-week + TimeInterval(fetch))
                    )
                }
                resetsAt = resetsAt.addingTimeInterval(week - eighteenHours)
            }
            let cycles = monitor.observedResets(providerID: "codex", windowKey: "weekly")
            #expect(cycles.count == 4)

            let summary = try #require(EarlyQuotaResetHistory.summarize(
                cycleResets: cycles,
                windowKey: "weekly",
                windowName: "weekly limit",
                windowSeconds: weekSeconds
            ))
            #expect(summary.earlyResets == 3)
            #expect(summary.observedResets == 3)
            #expect(summary.caption == "Last 3 weekly resets came ~18h early")
            // Claude's ledger is its own, and empty here.
            #expect(monitor.observedResets(providerID: "claude", windowKey: "seven_day").isEmpty)
        }
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

@Suite("Early quota reset wiring, non-Claude providers")
@MainActor
struct EarlyQuotaResetWiringTests {
    /// Grok stands in for every provider fetched through the CodeBurn-owned
    /// adapter: the detector only ever saw Claude's refresh, so a reset on one
    /// of these was silent however plainly the adapter reported it.
    @Test("A dock provider's early reset is detected, banded and named after it")
    func dockProviderGetsItsOwnEvent() async throws {
        let suiteName = "codeburn.quota.earlyReset.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let notifier = RecordingEarlyResetNotifier()
        let store = AppStore()
        store.earlyQuotaResetMonitor = EarlyQuotaResetMonitor(
            defaults: defaults,
            makeNotifier: { notifier }
        )
        store.capacityDockCredentialLoader = { _ in CapacityDockProviderCredential() }

        let provider = try #require(CapacityDockProvider(rawValue: "grok"))
        // Fetch one: the window still has 18 hours to run. Fetch two: a new
        // weekly cycle, anchored a full window after the first look.
        let responses = [
            Self.summary(percent: 0.8, resetsIn: 18 * 3600),
            Self.summary(percent: 0, resetsIn: week),
        ]
        let index = Counter()
        store.capacityDockProviderQuotaService = CapacityDockProviderQuotaService(dependencies: .init(
            refreshClinePass: { _ in Self.summary(percent: 0, resetsIn: week) },
            refreshCursor: { Self.summary(percent: 0, resetsIn: week) },
            refreshGrok: { responses[await index.next()] },
            refreshZai: { _ in Self.summary(percent: 0, resetsIn: week) }
        ))

        await store.refreshCapacityDockProvider(provider)
        #expect(notifier.posts.isEmpty)
        await store.refreshCapacityDockProvider(provider)

        #expect(notifier.posts.count == 1)
        #expect(notifier.posts.first?.title == "Grok quota reset early")
        let band = try #require(store.capacityDockEarlyResetNotice(for: provider))
        #expect(band.providerID == "grok")
        #expect(band.noticeText == "Weekly limit reset 18h early")
        // Claude's band and captions are untouched by another provider's reset.
        #expect(store.capacityDockEarlyResetNotice(for: CapacityDockProvider.claude) == nil)
        #expect(store.earlyResetHistoryCaptions(for: CapacityDockProvider.claude).isEmpty)
    }

    /// `QuotaSummary.Window` carries no duration for these adapters today, and a
    /// window with no validated duration is exactly what the detector refuses to
    /// have an opinion about.
    @Test("A provider whose windows carry no duration stays silent")
    func windowWithoutDurationIsSilent() async throws {
        let suiteName = "codeburn.quota.earlyReset.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let notifier = RecordingEarlyResetNotifier()
        let store = AppStore()
        store.earlyQuotaResetMonitor = EarlyQuotaResetMonitor(
            defaults: defaults,
            makeNotifier: { notifier }
        )
        store.capacityDockCredentialLoader = { _ in CapacityDockProviderCredential() }

        let provider = try #require(CapacityDockProvider(rawValue: "grok"))
        let responses = [
            Self.summary(percent: 0.8, resetsIn: 18 * 3600, windowSeconds: nil),
            Self.summary(percent: 0, resetsIn: week, windowSeconds: nil),
        ]
        let index = Counter()
        store.capacityDockProviderQuotaService = CapacityDockProviderQuotaService(dependencies: .init(
            refreshClinePass: { _ in Self.summary(percent: 0, resetsIn: week) },
            refreshCursor: { Self.summary(percent: 0, resetsIn: week) },
            refreshGrok: { responses[await index.next()] },
            refreshZai: { _ in Self.summary(percent: 0, resetsIn: week) }
        ))

        await store.refreshCapacityDockProvider(provider)
        await store.refreshCapacityDockProvider(provider)

        #expect(notifier.posts.isEmpty)
        #expect(store.capacityDockEarlyResetNotice(for: provider) == nil)
    }

    nonisolated private static func summary(
        percent: Double,
        resetsIn: TimeInterval,
        windowSeconds: Int? = 7 * 24 * 3600
    ) -> QuotaSummary {
        let window = QuotaSummary.Window(
            label: "Weekly",
            percent: percent,
            resetsAt: Date().addingTimeInterval(resetsIn),
            windowSeconds: windowSeconds,
            fetchedAt: Date()
        )
        return QuotaSummary(
            providerFilter: .grok,
            connection: .connected,
            primary: window,
            details: [window],
            planLabel: "Grok Build",
            footerLines: []
        )
    }
}

private actor Counter {
    private var value = 0
    func next() -> Int {
        defer { value += 1 }
        return value
    }
}
