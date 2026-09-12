import Foundation
import Testing
@testable import CodeBurnMenubar

private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

private func grant(_ id: String, type: String? = "weekly", granted: Date? = t0) -> CodexUsage.ResetCredits.Grant {
    .init(id: id, resetType: type, grantedAt: granted)
}

private func credits(
    _ grants: [CodexUsage.ResetCredits.Grant],
    available: Int? = nil,
    applicable: Int? = nil,
    nextExpiresAt: Date? = nil
) -> CodexUsage.ResetCredits {
    .init(
        availableCount: available ?? grants.count,
        applicableAvailableCount: applicable,
        grants: grants,
        nextExpiresAt: nextExpiresAt
    )
}

@Suite("Codex banked-reset detection")
struct CodexBankedResetDetectorTests {
    @Test("the first observation is a baseline, not news")
    func firstObservationIsBaseline() {
        let outcome = CodexBankedResetDetector.evaluate(
            observed: credits([grant("c1"), grant("c2")]),
            state: CodexBankedResetState(),
            now: t0
        )
        #expect(outcome.events.isEmpty)
        #expect(outcome.state.baselineAt == t0)
        #expect(outcome.state.credits.map(\.id) == ["c1", "c2"])
    }

    @Test("a credit seen for the first time after the baseline is an event")
    func newCreditFires() {
        let baseline = CodexBankedResetDetector.evaluate(
            observed: credits([grant("c1")]), state: CodexBankedResetState(), now: t0
        ).state
        let outcome = CodexBankedResetDetector.evaluate(
            observed: credits([grant("c1"), grant("c2", type: "5h")]), state: baseline, now: t0 + 60
        )
        #expect(outcome.events.map(\.id) == ["c2"])
        #expect(outcome.events.first?.resetType == "5h")
        #expect(outcome.state.credits.map(\.id).sorted() == ["c1", "c2"])
    }

    @Test("an unchanged inventory fires nothing and leaves the state untouched")
    func unchangedInventoryIsSilent() {
        let baseline = CodexBankedResetDetector.evaluate(
            observed: credits([grant("c1")]), state: CodexBankedResetState(), now: t0
        ).state
        let outcome = CodexBankedResetDetector.evaluate(
            observed: credits([grant("c1")]), state: baseline, now: t0 + 600
        )
        #expect(outcome.events.isEmpty)
        #expect(outcome.state == baseline)
    }

    @Test("a consumed credit is not an event, and cannot come back as one")
    func consumedCreditIsSilent() {
        var state = CodexBankedResetDetector.evaluate(
            observed: credits([grant("c1"), grant("c2")]), state: CodexBankedResetState(), now: t0
        ).state

        // c2 redeemed: it drops out of the available list entirely.
        let consumed = CodexBankedResetDetector.evaluate(
            observed: credits([grant("c1")]), state: state, now: t0 + 60
        )
        #expect(consumed.events.isEmpty)
        state = consumed.state

        // A payload that lists it again (a flicker, not a new grant) stays quiet.
        let reappears = CodexBankedResetDetector.evaluate(
            observed: credits([grant("c1"), grant("c2")]), state: state, now: t0 + 120
        )
        #expect(reappears.events.isEmpty)
    }

    @Test("a missing or malformed credits payload is no opinion, never an event")
    func malformedPayloadIsNoOpinion() {
        // Before any baseline: still no opinion, so the next real payload is the
        // baseline rather than a burst of notifications.
        let cold = CodexBankedResetDetector.evaluate(observed: nil, state: CodexBankedResetState(), now: t0)
        #expect(cold.events.isEmpty)
        #expect(cold.state == CodexBankedResetState())

        let baseline = CodexBankedResetDetector.evaluate(
            observed: credits([grant("c1")]), state: CodexBankedResetState(), now: t0
        ).state
        let warm = CodexBankedResetDetector.evaluate(observed: nil, state: baseline, now: t0 + 60)
        #expect(warm.events.isEmpty)
        #expect(warm.state == baseline)
    }

    @Test("a failed fetch between two identical payloads does not re-fire")
    func reconnectDoesNotRefire() {
        var state = CodexBankedResetDetector.evaluate(
            observed: credits([grant("c1")]), state: CodexBankedResetState(), now: t0
        ).state
        state = CodexBankedResetDetector.evaluate(
            observed: credits([grant("c1"), grant("c2")]), state: state, now: t0 + 60
        ).state
        // Endpoint fails, then recovers with the same inventory.
        state = CodexBankedResetDetector.evaluate(observed: nil, state: state, now: t0 + 120).state
        let reconnected = CodexBankedResetDetector.evaluate(
            observed: credits([grant("c1"), grant("c2")]), state: state, now: t0 + 180
        )
        #expect(reconnected.events.isEmpty)
    }

    @Test("a credit with no id and no granted_at never reaches the detector")
    func unidentifiableCreditsAreNotGrants() {
        // The parser is what drops them; this pins the contract the detector
        // relies on rather than re-implementing it.
        let payload = #"""
        {"credits": [{"status": "available", "reset_type": "weekly"}], "available_count": 1}
        """#
        let parsed = CodexSubscriptionService.parseResetCredits(data: Data(payload.utf8), now: t0)
        #expect(parsed?.availableCount == 1)
        #expect(parsed?.grants.isEmpty == true)
        let outcome = CodexBankedResetDetector.evaluate(
            observed: parsed,
            state: CodexBankedResetState(baselineAt: t0, credits: []),
            now: t0
        )
        #expect(outcome.events.isEmpty)
    }

    @Test("a credit gone for longer than the retention window is forgotten")
    func staleIdsArePruned() {
        let state = CodexBankedResetDetector.evaluate(
            observed: credits([grant("c1"), grant("c2")]), state: CodexBankedResetState(), now: t0
        ).state
        let later = t0 + CodexBankedResetDetector.retentionSeconds + 60
        let outcome = CodexBankedResetDetector.evaluate(
            observed: credits([grant("c1")]), state: state, now: later
        )
        #expect(outcome.state.credits.map(\.id) == ["c1"])
    }
}

@Suite("Codex banked-reset wording")
struct CodexBankedResetPresentationTests {
    @Test("the detail line names the count and the most recent grant")
    func detailLine() {
        let line = CodexBankedResetPresentation.detail(
            credits([grant("c1", granted: t0 - 7_200), grant("c2", type: "weekly", granted: t0 - 600)]),
            now: t0
        )
        #expect(line == "2 available · latest weekly reset granted 10m ago")
    }

    @Test("the usable count is only stated when it disagrees with the headline")
    func usableCountOnlyWhenDifferent() {
        let same = CodexBankedResetPresentation.detail(
            credits([grant("c1", granted: nil)], applicable: 1), now: t0
        )
        #expect(same == "1 available")
        let differs = CodexBankedResetPresentation.detail(
            credits([grant("c1", granted: nil), grant("c2", granted: nil)], applicable: 1), now: t0
        )
        #expect(differs == "2 available · 1 usable now")
    }

    @Test("the expiry #724 surfaces is kept, in the shared compact form")
    func expiryClauseSurvives() {
        let line = CodexBankedResetPresentation.line(
            credits([grant("c1", granted: t0 - 86_400)], nextExpiresAt: t0 + 57_600),
            now: t0
        )
        #expect(line == "Limit resets · 1 available · latest weekly reset granted 1d ago · next expires in 16h")
    }

    @Test("nothing held means no row at all")
    func zeroHidesTheRow() {
        #expect(CodexBankedResetPresentation.detail(credits([], available: 0), now: t0) == nil)
        #expect(CodexBankedResetPresentation.line(credits([], available: 0), now: t0) == nil)
    }

    @Test("an absent reset_type degrades to the bare noun")
    func missingResetType() {
        #expect(CodexBankedResetPresentation.resetTypeLabel(nil) == "limit reset")
        #expect(CodexBankedResetPresentation.resetTypeLabel("  ") == "limit reset")
        #expect(CodexBankedResetPresentation.resetTypeLabel("Weekly") == "weekly reset")
        #expect(CodexBankedResetPresentation.resetTypeLabel("five_hour") == "five hour reset")
    }

    @Test("compact ages read the same on both sides of the port")
    func compactAges() {
        #expect(CodexBankedResetPresentation.compactAge(of: t0, now: t0) == "just now")
        #expect(CodexBankedResetPresentation.compactAge(of: t0 - 59, now: t0) == "just now")
        #expect(CodexBankedResetPresentation.compactAge(of: t0 - 60, now: t0) == "1m ago")
        #expect(CodexBankedResetPresentation.compactAge(of: t0 - 7_200, now: t0) == "2h ago")
        #expect(CodexBankedResetPresentation.compactAge(of: t0 - 3 * 86_400, now: t0) == "3d ago")
        #expect(CodexBankedResetPresentation.compactAge(of: t0 + 30, now: t0) == "in under a minute")
        #expect(CodexBankedResetPresentation.compactAge(of: t0 + 7_200, now: t0) == "in 2h")
        #expect(CodexBankedResetPresentation.compactAge(of: t0 + 2 * 86_400, now: t0) == "in 2d")
    }

    @Test("the notice says what landed, when, and how many are usable")
    func noticeCopy() {
        let copy = CodexBankedResetPresentation.notice(
            for: grant("c2", granted: t0 - 120),
            credits: credits([grant("c1", granted: t0 - 86_400), grant("c2", granted: t0 - 120)], applicable: 1),
            now: t0
        )
        #expect(copy.title == "Codex banked a limit reset")
        #expect(copy.body == "A weekly reset was added to your account 2m ago. You have 1 available to use.")
    }

    @Test("a grant timestamped in the future is worded as landing, not as granted")
    func futureGrantWording() {
        // No observed payload distinguishes granted-but-not-yet-usable; this is
        // the defensive reading of a `granted_at` ahead of our clock, so the
        // notice cannot say a reset arrived two hours before it did.
        let copy = CodexBankedResetPresentation.notice(
            for: grant("c1", granted: t0 + 7_200),
            credits: credits([grant("c1", granted: t0 + 7_200)]),
            now: t0
        )
        #expect(copy.body == "A weekly reset lands in 2h. You have 1 available to use.")
    }

    @Test("a grant with no timestamp still announces what it is")
    func untimedGrantWording() {
        let copy = CodexBankedResetPresentation.notice(
            for: grant("c1", type: nil, granted: nil),
            credits: credits([grant("c1", type: nil, granted: nil)]),
            now: t0
        )
        #expect(copy.body == "A limit reset was added to your account. You have 1 available to use.")
    }
}

@Suite("Codex banked-reset announcer")
@MainActor
struct CodexBankedResetAnnouncerTests {
    @Test("a new credit posts exactly once, however often we refresh")
    func announcesOncePerCredit() async throws {
        try await withAnnouncer { announcer, notifier, _, _ in
            await announcer.observe(credits([grant("c1")]), now: t0)
            #expect(notifier.posts.isEmpty)                    // baseline

            await announcer.observe(credits([grant("c1"), grant("c2")]), now: t0 + 60)
            await announcer.observe(credits([grant("c1"), grant("c2")]), now: t0 + 120)
            #expect(notifier.posts.count == 1)
            #expect(notifier.posts.first?.title == "Codex banked a limit reset")
        }
    }

    @Test("two credits granted at once post one notice each")
    func onePostPerCredit() async throws {
        try await withAnnouncer { announcer, notifier, _, _ in
            await announcer.observe(credits([grant("c1")]), now: t0)
            await announcer.observe(credits([grant("c1"), grant("c2"), grant("c3")]), now: t0 + 60)
            #expect(notifier.posts.count == 2)
            #expect(Set(notifier.posts.map(\.identifier))
                == ["CodexBankedReset.c2", "CodexBankedReset.c3"])
        }
    }

    @Test("a relaunch over the same persisted state does not repeat the notice")
    func relaunchDoesNotRepeat() async throws {
        try await withAnnouncer { announcer, notifier, defaults, store in
            await announcer.observe(credits([grant("c1")]), now: t0)
            await announcer.observe(credits([grant("c1"), grant("c2")]), now: t0 + 60)
            #expect(notifier.posts.count == 1)

            let relaunched = CodexBankedResetAnnouncer(
                defaults: defaults, store: store, makeNotifier: { notifier }
            )
            await relaunched.observe(credits([grant("c1"), grant("c2")]), now: t0 + 3_600)
            #expect(notifier.posts.count == 1)
        }
    }

    @Test("a failed fetch does not re-fire on reconnect")
    func reconnectDoesNotRepeat() async throws {
        try await withAnnouncer { announcer, notifier, _, _ in
            await announcer.observe(credits([grant("c1")]), now: t0)
            await announcer.observe(credits([grant("c1"), grant("c2")]), now: t0 + 60)
            await announcer.observe(nil, now: t0 + 120)
            await announcer.observe(credits([grant("c1"), grant("c2")]), now: t0 + 180)
            #expect(notifier.posts.count == 1)
        }
    }

    @Test("a malformed payload posts nothing and never asks for authorization")
    func malformedPayloadIsSilent() async throws {
        try await withAnnouncer { announcer, notifier, _, _ in
            await announcer.observe(nil, now: t0)
            #expect(notifier.posts.isEmpty)
            #expect(notifier.authorizationRequests == 0)
        }
    }

    @Test("a consumed credit posts nothing")
    func consumedCreditIsSilent() async throws {
        try await withAnnouncer { announcer, notifier, _, _ in
            await announcer.observe(credits([grant("c1"), grant("c2")]), now: t0)
            await announcer.observe(credits([grant("c1")]), now: t0 + 60)
            #expect(notifier.posts.isEmpty)
        }
    }

    @Test("the toggle off stays silent, and does not release a backlog later")
    func toggleOffStaysSilent() async throws {
        try await withAnnouncer { announcer, notifier, defaults, _ in
            await announcer.observe(credits([grant("c1")]), now: t0)
            defaults.set(false, forKey: CodexBankedResetNotificationPreference.defaultsKey)

            await announcer.observe(credits([grant("c1"), grant("c2")]), now: t0 + 60)
            #expect(notifier.posts.isEmpty)
            #expect(notifier.authorizationRequests == 0)

            defaults.set(true, forKey: CodexBankedResetNotificationPreference.defaultsKey)
            await announcer.observe(credits([grant("c1"), grant("c2")]), now: t0 + 120)
            #expect(notifier.posts.isEmpty)
        }
    }

    @Test("denied authorization posts nothing")
    func deniedAuthorizationPostsNothing() async throws {
        try await withAnnouncer { announcer, notifier, _, _ in
            notifier.authorized = false
            await announcer.observe(credits([grant("c1")]), now: t0)
            await announcer.observe(credits([grant("c1"), grant("c2")]), now: t0 + 60)
            #expect(notifier.posts.isEmpty)
            #expect(notifier.authorizationRequests == 1)
        }
    }

    @Test("the notice never carries the credit id in its text")
    func noticeBodyHasNoIdentifier() async throws {
        try await withAnnouncer { announcer, notifier, _, _ in
            await announcer.observe(credits([grant("first-credit")]), now: t0)
            await announcer.observe(
                credits([grant("first-credit"), grant("acct-9f3-second")]), now: t0 + 60
            )
            let post = try #require(notifier.posts.first)
            #expect(!post.title.contains("acct-9f3-second"))
            #expect(!post.body.contains("acct-9f3-second"))
        }
    }
}

@MainActor
private func withAnnouncer(
    _ body: @MainActor (
        CodexBankedResetAnnouncer,
        RecordingBankedResetNotifier,
        UserDefaults,
        MemoryBankedResetStore
    ) async throws -> Void
) async throws {
    let suiteName = "codeburn.codex.bankedResets.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suiteName))
    defaults.removePersistentDomain(forName: suiteName)
    defer { defaults.removePersistentDomain(forName: suiteName) }

    let notifier = RecordingBankedResetNotifier()
    let store = MemoryBankedResetStore()
    let announcer = CodexBankedResetAnnouncer(
        defaults: defaults, store: store, makeNotifier: { notifier }
    )
    try await body(announcer, notifier, defaults, store)
}

/// Stands in for the on-disk store; a second announcer over the same instance is
/// what "relaunch" means here.
private final class MemoryBankedResetStore: CodexBankedResetStateStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var state = CodexBankedResetState()

    func load() async -> CodexBankedResetState { lock.withLock { state } }
    func save(_ state: CodexBankedResetState) async { lock.withLock { self.state = state } }
}

@MainActor
private final class RecordingBankedResetNotifier: UpdateNotifier {
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
