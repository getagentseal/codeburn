import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Usage data change guard")
struct UsageDataChangeGuardTests {
    private let now = Date(timeIntervalSince1970: 1_000_000)

    @Test("fresh snapshot skips")
    func freshSnapshotSkips() {
        let snapshot = makeSnapshot(10)
        #expect(UsageDataChangeGuard.shouldSkip(
            current: snapshot,
            lastSuccessful: snapshot,
            lastSuccessAt: now,
            now: now,
            force: false
        ))
    }

    @Test("stale snapshot does not skip")
    func staleSnapshotDoesNotSkip() {
        #expect(!UsageDataChangeGuard.shouldSkip(
            current: makeSnapshot(20),
            lastSuccessful: makeSnapshot(10),
            lastSuccessAt: now,
            now: now,
            force: false
        ))
    }

    @Test("first run does not skip")
    func firstRunDoesNotSkip() {
        #expect(!UsageDataChangeGuard.shouldSkip(
            current: makeSnapshot(10),
            lastSuccessful: nil,
            lastSuccessAt: nil,
            now: now,
            force: false
        ))
    }

    @Test("force refresh bypasses fresh snapshot")
    func forceRefreshBypassesFreshSnapshot() {
        let snapshot = makeSnapshot(10)
        #expect(!UsageDataChangeGuard.shouldSkip(
            current: snapshot,
            lastSuccessful: snapshot,
            lastSuccessAt: now,
            now: now,
            force: true
        ))
    }

    @Test("unchanged snapshot stops skipping after the backstop interval")
    func backstopForcesRefreshAfterMaxSkipInterval() {
        let snapshot = makeSnapshot(10)
        let justInside = now.addingTimeInterval(UsageDataChangeGuard.maxSkipIntervalSeconds - 1)
        let atBoundary = now.addingTimeInterval(UsageDataChangeGuard.maxSkipIntervalSeconds)
        #expect(UsageDataChangeGuard.shouldSkip(
            current: snapshot,
            lastSuccessful: snapshot,
            lastSuccessAt: now,
            now: justInside,
            force: false
        ))
        #expect(!UsageDataChangeGuard.shouldSkip(
            current: snapshot,
            lastSuccessful: snapshot,
            lastSuccessAt: now,
            now: atBoundary,
            force: false
        ))
    }

    private func makeSnapshot(_ seconds: TimeInterval) -> UsageDataSnapshot {
        UsageDataSnapshot(modificationDates: ["provider-root": Date(timeIntervalSince1970: seconds)])
    }
}
