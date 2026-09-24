import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Single instance guard")
struct SingleInstanceGuardTests {
    private func decide(_ running: [(pid: pid_t, startedAt: UInt64?)], own: pid_t, startedAt: UInt64?) -> SingleInstanceGuard.Decision {
        SingleInstanceGuard.decide(running: running, ownPID: own, ownStartedAt: startedAt)
    }

    private func retires(_ decision: SingleInstanceGuard.Decision, _ pid: pid_t) -> Bool {
        guard case .retire(let pids) = decision else { return false }
        return pids.contains(pid)
    }

    @Test("the newest start retires every other copy")
    func newestRetiresTheRest() {
        let running: [(pid: pid_t, startedAt: UInt64?)] = [
            (pid: 10, startedAt: 100),
            (pid: 11, startedAt: 200),
            (pid: 99, startedAt: 300),
        ]
        #expect(decide(running, own: 99, startedAt: 300) == .retire([10, 11]))
    }

    @Test("a copy that started later wins, and this one stands down")
    func yieldsToNewer() {
        let running: [(pid: pid_t, startedAt: UInt64?)] = [(pid: 12, startedAt: 400), (pid: 99, startedAt: 300)]
        #expect(decide(running, own: 99, startedAt: 300) == .yieldToNewer)
    }

    @Test("our own process is never retired, however its start time reads")
    func neverRetiresSelf() {
        #expect(decide([(pid: 99, startedAt: 100)], own: 99, startedAt: 300) == .retire([]))
    }

    // pids are reused, so a pid that wrapped past kern.maxproc is lower than a copy that
    // started weeks earlier. The start time decides; the pid only breaks an exact tie.
    @Test("a lower pid that started later still wins")
    func pidOrderNeverOverridesStartTime() {
        let running: [(pid: pid_t, startedAt: UInt64?)] = [(pid: 90_000, startedAt: 100), (pid: 42, startedAt: 200)]
        #expect(decide(running, own: 42, startedAt: 200) == .retire([90_000]))
        #expect(decide(running, own: 90_000, startedAt: 100) == .yieldToNewer)
    }

    @Test("a peer the kernel will not place is neither retired nor able to outrank")
    func unplaceablePeerIsLeftAlone() {
        let running: [(pid: pid_t, startedAt: UInt64?)] = [(pid: 7, startedAt: nil), (pid: 99, startedAt: 300)]
        #expect(decide(running, own: 99, startedAt: 300) == .retire([]))
    }

    @Test("a copy that cannot place itself retires nobody and yields to nobody")
    func unplaceableSelfStandsStill() {
        let running: [(pid: pid_t, startedAt: UInt64?)] = [(pid: 7, startedAt: 100), (pid: 99, startedAt: nil)]
        #expect(decide(running, own: 99, startedAt: nil) == .retire([]))
    }

    // Two login items firing at once is how a user ends up with two flames.
    @Test("two starts in the same microsecond leave exactly one instance")
    func simultaneousLaunchesLeaveOne() {
        let both: [(pid: pid_t, startedAt: UInt64?)] = [(pid: 1, startedAt: 500), (pid: 2, startedAt: 500)]
        #expect(decide(both, own: 1, startedAt: 500) == .yieldToNewer)
        #expect(decide(both, own: 2, startedAt: 500) == .retire([1]))
    }

    // The one answer that is never allowed is both copies being told to go: that leaves no
    // menu bar at all. Run every pair the kernel can report — either start time readable or
    // not, either copy older, equal starts, and the pid order agreeing or disagreeing with
    // the start order (a reused pid) — from both sides, off the same shared observation.
    @Test("no pair of copies can both be told to go, and one always survives when both are placeable")
    func noPairEverLeavesZero() {
        let times: [UInt64?] = [nil, 100, 200]
        for (pidA, pidB) in [(pid_t(10), pid_t(20)), (pid_t(20), pid_t(10))] {
            for timeA in times {
                for timeB in times {
                    let running: [(pid: pid_t, startedAt: UInt64?)] = [
                        (pid: pidA, startedAt: timeA), (pid: pidB, startedAt: timeB),
                    ]
                    let a = decide(running, own: pidA, startedAt: timeA)
                    let b = decide(running, own: pidB, startedAt: timeB)
                    let aGoes = a == .yieldToNewer || retires(b, pidA)
                    let bGoes = b == .yieldToNewer || retires(a, pidB)
                    let cell = "pids \(pidA)/\(pidB), starts \(String(describing: timeA))/\(String(describing: timeB))"
                    #expect(!(aGoes && bGoes), "both copies quit: \(cell)")
                    if timeA != nil && timeB != nil {
                        #expect(aGoes != bGoes, "expected exactly one survivor: \(cell)")
                    }
                }
            }
        }
    }

    // The kernel answers for this process, and answers the same way twice.
    @Test("the kernel reports a start time for our own pid")
    func ownStartTimeIsReadable() {
        let pid = ProcessInfo.processInfo.processIdentifier
        let started = SingleInstanceGuard.kernelStartTime(pid: pid)
        #expect(started != nil)
        #expect(started == SingleInstanceGuard.kernelStartTime(pid: pid))
    }

    @Test("the kernel reports nothing for a pid that is not running")
    func unknownPIDHasNoStartTime() {
        #expect(SingleInstanceGuard.kernelStartTime(pid: pid_t.max) == nil)
    }
}
