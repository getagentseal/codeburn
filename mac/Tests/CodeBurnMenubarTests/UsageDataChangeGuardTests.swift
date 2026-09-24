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

    /// Warp's own database sits in a group container behind the "access data from
    /// other apps" consent, where a stat blocks rather than fails, so the default
    /// location is never watched. A path the person named themselves is.
    @Test("WARP_DB_PATH is watched when set, and nothing Warp-shaped when it is not")
    func warpIsWatchedOnlyWhenExplicitlyConfigured() throws {
        let home = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("CodeBurnMenubarTests.\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let database = home.appendingPathComponent("warp.sqlite")
        try Data().write(to: database)

        // Named so the guard never falls through to the real config on this Mac.
        let environment = ["CLAUDE_CONFIG_DIR": home.path]

        let unset = UsageDataChangeGuard.snapshot(environment: environment, homeDirectory: home.path)
        #expect(!unset.modificationDates.keys.contains { $0.contains("Group Containers") })
        #expect(unset.modificationDates[database.path] == nil)

        let set = UsageDataChangeGuard.snapshot(
            environment: environment.merging(["WARP_DB_PATH": database.path]) { _, new in new },
            homeDirectory: home.path
        )
        #expect(set.modificationDates[database.path] != nil)
        #expect(!set.modificationDates.keys.contains { $0.contains("Group Containers") })
    }

    private func makeSnapshot(_ seconds: TimeInterval) -> UsageDataSnapshot {
        UsageDataSnapshot(modificationDates: ["provider-root": Date(timeIntervalSince1970: seconds)])
    }
}
