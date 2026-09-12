import Foundation
import Testing
@testable import CodeBurnMenubar

private let quotaFreshnessNow = Date(timeIntervalSince1970: 1_900_000_000)

private func claudeUsage(fetchedAt: Date) -> SubscriptionUsage {
    SubscriptionUsage(
        tier: .pro,
        rawTier: "pro",
        fiveHourPercent: 40,
        fiveHourResetsAt: quotaFreshnessNow.addingTimeInterval(4 * 3600),
        sevenDayPercent: 20,
        sevenDayResetsAt: quotaFreshnessNow.addingTimeInterval(6 * 24 * 3600),
        sevenDayOpusPercent: nil,
        sevenDayOpusResetsAt: nil,
        sevenDaySonnetPercent: nil,
        sevenDaySonnetResetsAt: nil,
        scopedWeekly: [],
        fetchedAt: fetchedAt
    )
}

private func codexUsage(fetchedAt: Date) -> CodexUsage {
    CodexUsage(
        plan: .plus,
        primary: CodexUsage.Window(
            usedPercent: 40,
            resetsAt: quotaFreshnessNow.addingTimeInterval(4 * 3600),
            limitWindowSeconds: 5 * 3600
        ),
        secondary: nil,
        additionalLimits: [],
        creditsBalance: nil,
        hasCredits: false,
        creditsUnlimited: false,
        creditLimit: nil,
        resetCredits: nil,
        fetchedAt: fetchedAt
    )
}

private actor CodexRefreshGate {
    private var waiters: [CheckedContinuation<CodexUsage?, Error>] = []
    private var isClosed = false

    var waiterCount: Int { waiters.count }

    func wait() async throws -> CodexUsage? {
        if isClosed { return nil }
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<CodexUsage?, Error>) in
            if isClosed {
                continuation.resume(returning: nil)
            } else {
                waiters.append(continuation)
            }
        }
    }

    func release(_ result: Result<CodexUsage?, Error>) {
        guard !waiters.isEmpty else { return }
        waiters.removeFirst().resume(with: result)
    }

    func releaseAll() {
        while !waiters.isEmpty {
            waiters.removeFirst().resume(returning: nil)
        }
    }

    func close() {
        isClosed = true
        releaseAll()
    }
}

private func waitForWaiterCount(_ gate: CodexRefreshGate, _ expected: Int) async -> Bool {
    // A full SwiftPM run schedules this suite alongside credential and process
    // tests that can briefly occupy the main actor. Give the controlled fetch
    // a bounded scheduler window instead of relying on a tiny yield count.
    for _ in 0..<1_000 {
        if await gate.waiterCount == expected { return true }
        try? await Task.sleep(for: .milliseconds(1))
    }
    return await gate.waiterCount == expected
}

@Suite("Capacity Dock quota freshness", .serialized)
@MainActor
struct QuotaFreshnessTests {
    @Test("freshness accepts the established ten-minute boundary and rejects older or future samples")
    func freshnessBoundary() {
        let boundary = quotaFreshnessNow.addingTimeInterval(-QuotaSummary.freshnessThreshold)
        #expect(QuotaSummary.isFresh(fetchedAt: boundary, now: quotaFreshnessNow))
        #expect(!QuotaSummary.isFresh(
            fetchedAt: boundary.addingTimeInterval(-0.1),
            now: quotaFreshnessNow
        ))
        #expect(!QuotaSummary.isFresh(
            fetchedAt: quotaFreshnessNow.addingTimeInterval(1),
            now: quotaFreshnessNow
        ))
        #expect(!QuotaSummary.isFresh(fetchedAt: nil, now: quotaFreshnessNow))
    }

    @Test("window metadata preserves sample age for the pace presentation")
    func windowCarriesFreshness() {
        let fetchedAt = quotaFreshnessNow.addingTimeInterval(-60)
        let window = QuotaSummary.Window(
            label: "Weekly",
            percent: 0.4,
            resetsAt: quotaFreshnessNow.addingTimeInterval(6 * 24 * 3600),
            windowSeconds: 7 * 24 * 3600,
            fetchedAt: fetchedAt
        )
        #expect(window.isFresh(at: quotaFreshnessNow))
        #expect(!window.isFresh(at: quotaFreshnessNow.addingTimeInterval(QuotaSummary.freshnessThreshold + 1)))
        #expect(!QuotaSummary.Window(
            label: "Legacy",
            percent: 0.4,
            resetsAt: window.resetsAt,
            windowSeconds: window.windowSeconds
        ).isFresh(at: quotaFreshnessNow))
    }

    @Test("Claude loaded data becomes stale when its sample ages past the pace horizon")
    func staleClaudeSummaryDoesNotLookConnected() {
        let store = AppStore()
        let now = Date()
        let fetchedAt = now.addingTimeInterval(-QuotaSummary.freshnessThreshold - 1)
        store.subscription = claudeUsage(fetchedAt: fetchedAt)
        store.subscriptionLoadState = .loaded

        let summary = store.quotaSummary(for: .claude)
        #expect(summary?.connection == .stale)
        #expect(summary?.details.first?.fetchedAt == fetchedAt)
        #expect(summary?.details.first?.isFresh(at: now) == false)
    }

    @Test("Codex loaded data becomes stale when its sample ages past the pace horizon")
    func staleCodexSummaryDoesNotLookConnected() {
        let store = AppStore()
        let now = Date()
        let fetchedAt = now.addingTimeInterval(-QuotaSummary.freshnessThreshold - 1)
        store.codexUsage = codexUsage(fetchedAt: fetchedAt)
        store.codexLoadState = .loaded

        let summary = store.quotaSummary(for: .codex)
        #expect(summary?.connection == .stale)
        #expect(summary?.details.first?.fetchedAt == fetchedAt)
        #expect(summary?.details.first?.isFresh(at: now) == false)
    }

    @Test("fresh loaded samples remain connected")
    func freshSummariesRemainConnected() {
        let store = AppStore()
        store.subscription = claudeUsage(fetchedAt: Date())
        store.subscriptionLoadState = .loaded
        #expect(store.quotaSummary(for: .claude)?.connection == .connected)

        store.codexUsage = codexUsage(fetchedAt: Date())
        store.codexLoadState = .loaded
        #expect(store.quotaSummary(for: .codex)?.connection == .connected)
    }

    @Test("overlapping refreshes keep the newer loading state until it finishes")
    func overlappingRefreshesDoNotRestoreAnOlderState() async {
        let gate = CodexRefreshGate()
        let store = AppStore()
        store.codexUsage = codexUsage(fetchedAt: Date())
        store.codexLoadState = .loaded
        store.codexQuotaBootstrapChecker = { true }
        store.codexQuotaFetcher = { try await gate.wait() }

        let first = Task { await store.refreshCodexReportingSuccess() }
        guard await waitForWaiterCount(gate, 1) else {
            await gate.close()
            _ = await first.value
            #expect(Bool(false), "first refresh did not enter the controlled fetch")
            return
        }
        #expect(store.codexLoadState == .loading)

        let second = Task { await store.refreshCodexReportingSuccess() }
        guard await waitForWaiterCount(gate, 2) else {
            await gate.close()
            _ = await first.value
            _ = await second.value
            #expect(Bool(false), "second refresh did not enter the controlled fetch")
            return
        }

        // The superseded request must not restore `.loaded` while request 2 is
        // still waiting. The current request's nil result restores the state
        // that was present before the refresh pair began.
        await gate.release(.success(nil))
        #expect(await first.value == false)
        #expect(store.codexLoadState == .loading)
        await gate.release(.success(nil))
        #expect(await second.value == false)
        #expect(store.codexLoadState == .loaded)
        await gate.close()
    }

    @Test("a cancelled refresh restores the prior state instead of reporting failure")
    func cancelledRefreshRestoresPriorState() async {
        let store = AppStore()
        store.codexUsage = codexUsage(fetchedAt: Date())
        store.codexLoadState = .loaded
        store.codexQuotaBootstrapChecker = { true }
        store.codexQuotaFetcher = { throw CancellationError() }

        #expect(await store.refreshCodexReportingSuccess() == false)
        #expect(store.codexLoadState == .loaded)
    }
}
