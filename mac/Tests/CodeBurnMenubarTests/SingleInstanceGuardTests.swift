import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Single instance guard")
struct SingleInstanceGuardTests {
    private let now = Date(timeIntervalSince1970: 1_000_000)

    @Test("strictly older instances are retired, same-age and newer ones are not")
    func retiresOnlyOlder() {
        let pids = SingleInstanceGuard.pidsToTerminate(
            running: [
                (pid: 10, launchDate: now.addingTimeInterval(-60)),
                (pid: 11, launchDate: now),
                (pid: 12, launchDate: now.addingTimeInterval(60)),
                // No launch date reported: treated as older, since a copy that
                // predates ours is the only way to lose that field in practice.
                (pid: 13, launchDate: nil),
                (pid: 99, launchDate: now),
            ],
            ownPID: 99,
            ownLaunchDate: now
        )
        #expect(pids == [10, 13])
    }

    @Test("our own process is never retired, however its launch date reads")
    func neverRetiresSelf() {
        #expect(
            SingleInstanceGuard.pidsToTerminate(
                running: [(pid: 99, launchDate: now.addingTimeInterval(-60))],
                ownPID: 99,
                ownLaunchDate: now
            ).isEmpty
        )
    }

    @Test("two simultaneous launches cannot terminate each other")
    func simultaneousLaunchesSurvive() {
        let both: [(pid: pid_t, launchDate: Date?)] = [(pid: 1, launchDate: now), (pid: 2, launchDate: now)]
        #expect(SingleInstanceGuard.pidsToTerminate(running: both, ownPID: 1, ownLaunchDate: now).isEmpty)
        #expect(SingleInstanceGuard.pidsToTerminate(running: both, ownPID: 2, ownLaunchDate: now).isEmpty)
    }
}
