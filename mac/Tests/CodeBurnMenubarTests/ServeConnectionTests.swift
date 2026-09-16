import Darwin
import Foundation
import Testing
@testable import CodeBurnMenubar

private let ignoredSIGPIPEHandlerBits = unsafeBitCast(SIG_IGN, to: UInt.self)
private let coldTimeoutNanoseconds: UInt64 = 10 * 60 * 1_000_000_000
private let warmTimeoutNanoseconds: UInt64 = 45 * 1_000_000_000
private let terminationGraceNanoseconds: UInt64 = 5 * 1_000_000_000

private func currentSIGPIPEHandlerBits() -> UInt {
    var action = sigaction()
    _ = sigaction(SIGPIPE, nil, &action)
    return unsafeBitCast(action.__sigaction_u.__sa_handler, to: UInt.self)
}

private actor TimeoutRecorder {
    private var values: [UInt64] = []

    func recordAndSleep(_ nanoseconds: UInt64) async throws {
        values.append(nanoseconds)
        // Cold timers stay pending until the fake child replies and the
        // connection cancels them. The warm timer returns immediately to exercise
        // the timeout path without a real one-minute wait.
        if nanoseconds == warmTimeoutNanoseconds { return }
        try await Task.sleep(nanoseconds: 5 * 1_000_000_000)
    }

    func recordAndWait(_ nanoseconds: UInt64) async throws {
        values.append(nanoseconds)
        // This recorder verifies timeout selection without firing the timeout.
        // The response must deterministically win, then cancel this sleeper.
        try await Task.sleep(nanoseconds: 5 * 1_000_000_000)
    }

    func snapshot() -> [UInt64] { values }
}

private actor FallbackRecorder {
    private var calls = 0

    func record() { calls += 1 }
    func snapshot() -> Int { calls }
}

/// A cancellation-aware timeout clock that tests can advance explicitly. This
/// keeps the regression independent of the production ten-minute cold budget.
private actor ManualTimeoutClock {
    private struct Waiter {
        let nanoseconds: UInt64
        let continuation: CheckedContinuation<Void, Error>
    }

    private var nextToken = 0
    private var waiters: [Int: Waiter] = [:]
    private var recorded: [UInt64] = []
    private var fired = 0

    func sleep(_ nanoseconds: UInt64) async throws {
        let token = nextToken
        nextToken += 1
        recorded.append(nanoseconds)
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                if Task.isCancelled {
                    continuation.resume(throwing: CancellationError())
                } else {
                    waiters[token] = Waiter(nanoseconds: nanoseconds, continuation: continuation)
                }
            }
        } onCancel: {
            Task { await self.cancel(token) }
        }
    }

    func snapshot() -> [UInt64] {
        waiters.keys.sorted().compactMap { waiters[$0]?.nanoseconds }
    }

    func history() -> [UInt64] { recorded }

    /// How many timeouts this clock has let fire.
    func firedCount() -> Int { fired }

    func fireOldest() {
        guard let token = waiters.keys.min(), let waiter = waiters.removeValue(forKey: token) else { return }
        fired += 1
        waiter.continuation.resume()
    }

    private func cancel(_ token: Int) {
        guard let waiter = waiters.removeValue(forKey: token) else { return }
        waiter.continuation.resume(throwing: CancellationError())
    }
}

private final class QualityOfServiceRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [QualityOfService] = []

    func record(_ value: QualityOfService) {
        lock.lock()
        values.append(value)
        lock.unlock()
    }

    func snapshot() -> [QualityOfService] {
        lock.lock()
        defer { lock.unlock() }
        return values
    }
}

private final class ProcessQueue: @unchecked Sendable {
    private let lock = NSLock()
    private var processes: [Process]

    init(_ processes: [Process]) {
        self.processes = processes
    }

    func take(qualityOfService: QualityOfService) -> Process {
        lock.lock()
        let child = processes.removeFirst()
        lock.unlock()
        child.qualityOfService = qualityOfService
        return child
    }

    var remainingCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return processes.count
    }
}

/// Real-time bound on waiting for an event. It is a hang guard for a
/// regression, never the assertion: every fixture that relies on it either
/// blocks until the test releases it or never finishes on its own, so a runner
/// starved by concurrently scheduled suites makes the wait longer without
/// changing the outcome (#1333).
private let hangGuardNanoseconds: UInt64 = 30 * 1_000_000_000

/// Polls a condition the test can only observe from outside the process, such
/// as a file a fixture child writes, until it holds or the hang guard expires.
private func eventually(_ condition: () async throws -> Bool) async rethrows -> Bool {
    let deadline = DispatchTime.now().uptimeNanoseconds + hangGuardNanoseconds
    while DispatchTime.now().uptimeNanoseconds < deadline {
        if try await condition() { return true }
        try? await Task.sleep(nanoseconds: 10_000_000)
    }
    return try await condition()
}

/// Awaits `operation`. If it is still pending when the hang guard expires,
/// `onExpiry` releases whatever it is blocked on, so a regression fails the
/// assertions that follow instead of hanging the test run.
private func withHangGuard<T>(
    onExpiry: @escaping @Sendable () async -> Void,
    _ operation: () async throws -> T
) async rethrows -> T {
    let expiry = Task {
        do {
            try await Task.sleep(nanoseconds: hangGuardNanoseconds)
        } catch {
            return
        }
        await onExpiry()
    }
    defer { expiry.cancel() }
    return try await operation()
}

@Suite("ServeConnection", .serialized)
struct ServeConnectionTests {
    @Test("the resident child starts at user-initiated QoS")
    func residentChildUsesInteractiveQoS() async {
        let recorder = QualityOfServiceRecorder()
        let connection = ServeConnection { _, qualityOfService in
            recorder.record(qualityOfService)
            let child = Process()
            child.executableURL = URL(fileURLWithPath: "/bin/sh")
            child.arguments = ["-c", "while IFS= read -r line; do :; done"]
            child.qualityOfService = qualityOfService
            return child
        }

        await connection.ensureStarted()

        #expect(recorder.snapshot() == [.userInitiated])
        await connection.shutdown()
    }

    @Test("cancelling a hung request returns promptly")
    func cancellationUnblocksPendingContinuation() async throws {
        let dir = NSTemporaryDirectory() + "serve-connection-cancel-test-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let requestMarker = dir + "/request-read"
        let clock = ManualTimeoutClock()

        // The child reads the request, then neither answers nor exits until its
        // stdin closes, and the request's timeout fires only when the test fires
        // it. Cancellation is the only event left that can resume the caller, so
        // "promptly" is asserted as "before the timeout", not as a wall-clock
        // budget a starved runner cannot keep (#1333). A child that exited on
        // its own would instead be retried on replacements until the death
        // budget surfaced ServeUnavailable.
        let connection = ServeConnection(
            makeProcess: { _, qualityOfService in
                let child = Process()
                child.executableURL = URL(fileURLWithPath: "/bin/sh")
                child.arguments = [
                    "-c", "IFS= read -r line; : > \"$1\"; while IFS= read -r line; do :; done",
                    "serve-fixture", requestMarker,
                ]
                child.qualityOfService = qualityOfService
                return child
            },
            timeoutSleep: { nanoseconds in
                try await clock.sleep(nanoseconds)
            }
        )

        let request = Task {
            try await connection.request(args: ["status", "--format", "menubar-json"])
        }
        let childReadRequest = await eventually { FileManager.default.fileExists(atPath: requestMarker) }
        #expect(childReadRequest)
        let timeoutArmed = await eventually { await clock.snapshot() == [coldTimeoutNanoseconds] }
        #expect(timeoutArmed)

        request.cancel()
        do {
            // Firing the timeout on expiry turns a connection that ignores
            // cancellation into a failed assertion below rather than a hang.
            _ = try await withHangGuard(onExpiry: { await clock.fireOldest() }) {
                try await request.value
            }
            #expect(Bool(false), "cancelled request unexpectedly succeeded")
        } catch {
            #expect(error is CancellationError)
        }
        #expect(await clock.firedCount() == 0)
        await connection.shutdown()
    }

    @Test("a request queued during cancelled hydration completes on the same child")
    func cancellationKeepsQueuedRequestOnResidentChild() async throws {
        let dir = NSTemporaryDirectory() + "serve-connection-cancel-overlap-test-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let pidsFile = dir + "/pids"
        let eventsFile = dir + "/events"
        let releaseMarker = dir + "/release-first"
        let clock = ManualTimeoutClock()

        let connection = ServeConnection(
            makeProcess: { _, qualityOfService in
                let child = Process()
                child.executableURL = URL(fileURLWithPath: "/bin/sh")
                child.arguments = ["-c", """
                    printf '%s\n' "$$" >> "$1"
                    IFS= read -r first
                    first_id=$(printf '%s' "$first" | sed -E 's/.*"id":([0-9]+).*/\\1/')
                    printf 'first-read\n' >> "$2"
                    while [ ! -f "$3" ]; do sleep 0.01; done
                    printf '{"id":%s,"ok":true,"output":"late-%s"}\n' "$first_id" "$first_id"
                    printf 'late-first\n' >> "$2"
                    IFS= read -r second
                    second_id=$(printf '%s' "$second" | sed -E 's/.*"id":([0-9]+).*/\\1/')
                    printf 'second-read\n' >> "$2"
                    printf '{"id":%s,"ok":true,"output":"live-%s"}\n' "$second_id" "$second_id"
                    printf 'second-replied\n' >> "$2"
                    """, "serve-fixture", pidsFile, eventsFile, releaseMarker]
                child.qualityOfService = qualityOfService
                return child
            },
            timeoutSleep: { nanoseconds in
                try await clock.sleep(nanoseconds)
            }
        )

        let first = Task {
            try await connection.request(args: ["status", "--request", "first"])
        }
        let firstRead = await eventually {
            ((try? String(contentsOfFile: eventsFile, encoding: .utf8)) ?? "").contains("first-read\n")
        }
        #expect(firstRead)
        #expect(try String(contentsOfFile: eventsFile, encoding: .utf8) == "first-read\n")
        // The timer is armed by a detached task, so it can register after the
        // child has already read the line.
        let coldTimeoutArmed = await eventually { await clock.history() == [coldTimeoutNanoseconds] }
        #expect(coldTimeoutArmed)

        first.cancel()
        do {
            _ = try await withHangGuard(onExpiry: {
                Issue.record("cancellation was not observed while the child was still hydrating")
                _ = FileManager.default.createFile(atPath: releaseMarker, contents: Data())
            }) {
                try await first.value
            }
            #expect(Bool(false), "cancelled request unexpectedly succeeded")
        } catch {
            #expect(error is CancellationError)
        }

        // Submit the next request while the child is still blocked hydrating
        // the cancelled first one. It stays client-side queued: neither its
        // stdin line nor its own timeout may begin yet. Nothing observable
        // happens while it waits, so this settle can only miss a regression,
        // never fail a correct run; the warm timeout asserted after the release
        // is the deterministic proof that its line was written only after the
        // late first reply.
        let second = Task {
            try await connection.request(args: ["status", "--request", "second"])
        }
        try await Task.sleep(nanoseconds: 100_000_000)
        #expect(await clock.history() == [coldTimeoutNanoseconds])
        #expect(try String(contentsOfFile: eventsFile, encoding: .utf8) == "first-read\n")

        _ = FileManager.default.createFile(atPath: releaseMarker, contents: Data())
        let secondPayload = try await withHangGuard(onExpiry: { await connection.shutdown() }) {
            try await second.value
        }

        #expect(String(decoding: secondPayload, as: UTF8.self) == "live-2")
        let warmTimeoutArmed = await eventually {
            await clock.history() == [coldTimeoutNanoseconds, warmTimeoutNanoseconds]
        }
        #expect(warmTimeoutArmed)
        let pids = try String(contentsOfFile: pidsFile, encoding: .utf8)
            .split(separator: "\n")
        #expect(pids.count == 1)
        // The child logs "second-replied" after writing the reply that resumed
        // `second`, so wait for the log rather than racing the child to it.
        let secondReplied = await eventually {
            ((try? String(contentsOfFile: eventsFile, encoding: .utf8)) ?? "").contains("second-replied\n")
        }
        #expect(secondReplied)
        let events = try String(contentsOfFile: eventsFile, encoding: .utf8)
            .split(separator: "\n")
        #expect(events == ["first-read", "late-first", "second-read", "second-replied"])
        await connection.shutdown()
    }

    @Test("a cancelled never-returning request retains a timeout owner and cannot wedge later work")
    func cancelledHungRequestIsEventuallyReaped() async throws {
        let dir = NSTemporaryDirectory() + "serve-connection-cancel-timeout-test-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let firstReadMarker = dir + "/first-read"
        let pidsFile = dir + "/pids"
        let clock = ManualTimeoutClock()
        let graceClock = ManualTimeoutClock()

        let stuckChild = Process()
        stuckChild.executableURL = URL(fileURLWithPath: "/bin/sh")
        stuckChild.arguments = ["-c", """
            trap '' TERM
            printf '%s\n' "$$" >> "$1"
            IFS= read -r line
            : > "$2"
            while :; do :; done
            """, "serve-fixture", pidsFile, firstReadMarker]

        let replacement = Process()
        replacement.executableURL = URL(fileURLWithPath: "/bin/sh")
        replacement.arguments = ["-c", """
            printf '%s\n' "$$" >> "$1"
            while IFS= read -r line; do
              id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
              printf '{"id":%s,"ok":true,"output":"replacement-%s"}\n' "$id" "$id"
            done
            """, "serve-fixture", pidsFile]

        let children = ProcessQueue([stuckChild, replacement])
        let connection = ServeConnection(
            makeProcess: { _, qualityOfService in
                children.take(qualityOfService: qualityOfService)
            },
            timeoutSleep: { nanoseconds in
                try await clock.sleep(nanoseconds)
            },
            terminationGraceSleep: { nanoseconds in
                try await graceClock.sleep(nanoseconds)
            }
        )
        defer {
            if stuckChild.isRunning { _ = Darwin.kill(stuckChild.processIdentifier, SIGKILL) }
        }

        let abandoned = Task {
            try await connection.request(args: ["status", "--request", "stuck"])
        }
        for _ in 0..<200 where !FileManager.default.fileExists(atPath: firstReadMarker) {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        #expect(FileManager.default.fileExists(atPath: firstReadMarker))
        #expect(await clock.snapshot() == [coldTimeoutNanoseconds])

        abandoned.cancel()
        do {
            _ = try await abandoned.value
            #expect(Bool(false), "cancelled request unexpectedly succeeded")
        } catch {
            #expect(error is CancellationError)
        }

        // The caller is gone, but the independently-owned cold timeout must
        // remain armed. This assertion is the red-before regression: the old
        // task-group race cancelled the only timeout along with the caller.
        #expect(await clock.snapshot() == [coldTimeoutNanoseconds])
        let successor = Task {
            try await connection.request(args: ["status", "--request", "after-cancel"])
        }
        try await Task.sleep(nanoseconds: 100_000_000)
        #expect(await clock.snapshot() == [coldTimeoutNanoseconds])
        #expect(children.remainingCount == 1)

        await clock.fireOldest()
        for _ in 0..<200 where children.remainingCount > 0 {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        let replacementStartedBeforeOldEOF = children.remainingCount == 0
        #expect(replacementStartedBeforeOldEOF)
        // Keep the red-before run finite: the old implementation waits for EOF
        // forever because this fixture deliberately ignores SIGTERM.
        if !replacementStartedBeforeOldEOF {
            _ = Darwin.kill(stuckChild.processIdentifier, SIGKILL)
            for _ in 0..<200 where children.remainingCount > 0 {
                try await Task.sleep(nanoseconds: 10_000_000)
            }
        }

        // The retired child ignores SIGTERM, yet its stale stdout remains open.
        // The queued successor must already run on a replacement; it cannot wait
        // for either old-generation EOF or the force-kill grace period.
        let payload = try await successor.value
        #expect(String(decoding: payload, as: UTF8.self) == "replacement-2")
        #expect(await clock.snapshot().isEmpty)
        #expect(await clock.history() == [coldTimeoutNanoseconds, coldTimeoutNanoseconds])
        #expect(await graceClock.snapshot() == [terminationGraceNanoseconds])
        #expect(stuckChild.isRunning)
        #expect(try String(contentsOfFile: pidsFile, encoding: .utf8).split(separator: "\n").count == 2)

        await graceClock.fireOldest()
        for _ in 0..<200 where stuckChild.isRunning {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        #expect(!stuckChild.isRunning)
        #expect(stuckChild.terminationReason == .uncaughtSignal)
        #expect(stuckChild.terminationStatus == SIGKILL)
        await connection.shutdown()
    }

    @Test("shutdown during the termination grace force-kills the SIGTERM-ignoring generation")
    func shutdownDuringGraceKillsStubbornChild() async throws {
        let dir = NSTemporaryDirectory() + "serve-connection-shutdown-grace-test-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let firstReadMarker = dir + "/first-read"
        let clock = ManualTimeoutClock()
        let graceClock = ManualTimeoutClock()

        let stuckChild = Process()
        stuckChild.executableURL = URL(fileURLWithPath: "/bin/sh")
        stuckChild.arguments = ["-c", """
            trap '' TERM
            IFS= read -r line
            : > "$1"
            while :; do :; done
            """, "serve-fixture", firstReadMarker]

        let children = ProcessQueue([stuckChild])
        let connection = ServeConnection(
            makeProcess: { _, qualityOfService in
                children.take(qualityOfService: qualityOfService)
            },
            timeoutSleep: { nanoseconds in
                try await clock.sleep(nanoseconds)
            },
            terminationGraceSleep: { nanoseconds in
                try await graceClock.sleep(nanoseconds)
            }
        )
        defer {
            if stuckChild.isRunning { _ = Darwin.kill(stuckChild.processIdentifier, SIGKILL) }
        }

        let request = Task {
            try await connection.request(args: ["status", "--request", "stuck"])
        }
        for _ in 0..<200 where !FileManager.default.fileExists(atPath: firstReadMarker) {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        #expect(FileManager.default.fileExists(atPath: firstReadMarker))
        #expect(await clock.snapshot() == [coldTimeoutNanoseconds])

        // Time out the request: the generation is retired and SIGTERM'd, and the
        // SIGKILL escalation parks on the injected grace clock.
        await clock.fireOldest()
        do {
            _ = try await request.value
            #expect(Bool(false), "timed-out request unexpectedly succeeded")
        } catch let error as ServeConnection.ServeRequestFailed {
            #expect(error.message == "serve timeout")
        }
        for _ in 0..<200 where await graceClock.snapshot().isEmpty {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        #expect(await graceClock.snapshot() == [terminationGraceNanoseconds])
        #expect(stuckChild.isRunning) // SIGTERM ignored; escalation still pending

        // Shutdown must not merely cancel the escalation. The retired generation
        // is already detached from `process`, so nothing else will reap it; the
        // grace task's cancellation path has to SIGKILL it or it outlives the app.
        await connection.shutdown()
        for _ in 0..<200 where stuckChild.isRunning {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        #expect(!stuckChild.isRunning)
        #expect(stuckChild.terminationReason == .uncaughtSignal)
        #expect(stuckChild.terminationStatus == SIGKILL)
    }

    @Test("timed-out generations consume one death each and stop at the resident budget")
    func timeoutDeathBudgetIsExact() async throws {
        let dir = NSTemporaryDirectory() + "serve-connection-timeout-budget-test-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let readsFile = dir + "/reads"
        let clock = ManualTimeoutClock()
        let processes = (0..<3).map { _ in
            let child = Process()
            child.executableURL = URL(fileURLWithPath: "/bin/sh")
            child.arguments = ["-c", """
                trap '' TERM
                IFS= read -r line
                printf r >> "$1"
                while :; do :; done
                """, "serve-fixture", readsFile]
            return child
        }
        let children = ProcessQueue(processes)
        let connection = ServeConnection(
            makeProcess: { _, qualityOfService in
                children.take(qualityOfService: qualityOfService)
            },
            timeoutSleep: { nanoseconds in
                try await clock.sleep(nanoseconds)
            },
            terminationGraceSleep: { _ in }
        )
        defer {
            for child in processes where child.isRunning {
                _ = Darwin.kill(child.processIdentifier, SIGKILL)
            }
        }

        for attempt in 0..<3 {
            let request = Task {
                try await connection.request(args: ["status", "--attempt", String(attempt)])
            }
            for _ in 0..<200 {
                let reads = (try? String(contentsOfFile: readsFile, encoding: .utf8).count) ?? 0
                if reads == attempt + 1, await clock.snapshot().count == 1 { break }
                try await Task.sleep(nanoseconds: 10_000_000)
            }
            #expect((try? String(contentsOfFile: readsFile, encoding: .utf8).count) == attempt + 1)
            await clock.fireOldest()
            do {
                _ = try await request.value
                Issue.record("timeout \(attempt) unexpectedly succeeded")
            } catch let error as ServeConnection.ServeRequestFailed {
                #expect(error.message == "serve timeout")
            }
        }

        #expect(children.remainingCount == 0)
        do {
            _ = try await connection.request(args: ["status", "--after-budget"])
            Issue.record("resident restarted after three timed-out generations")
        } catch {
            #expect(error is ServeConnection.ServeUnavailable)
        }
        for _ in 0..<200 where processes.contains(where: \.isRunning) {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        #expect(processes.allSatisfy { !$0.isRunning })
        #expect(processes.allSatisfy {
            $0.terminationReason == .uncaughtSignal && $0.terminationStatus == SIGKILL
        })
        await connection.shutdown()
    }

    @Test("external cancellations keep one child and safely discard late replies")
    func cancellationsKeepResidentChildAlive() async throws {
        let dir = NSTemporaryDirectory() + "serve-connection-cancel-reuse-test-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let pidsFile = dir + "/pids"
        let requestsFile = dir + "/requests"
        let lateRepliesFile = dir + "/late-replies"
        let clock = ManualTimeoutClock()

        // Ids 1-3 are answered only once the test has created release-<id>, so
        // the late reply cannot beat the cancellation it is meant to follow
        // (#1333).
        let connection = ServeConnection(
            makeProcess: { _, qualityOfService in
                let child = Process()
                child.executableURL = URL(fileURLWithPath: "/bin/sh")
                child.arguments = ["-c", """
                    printf '%s\n' "$$" >> "$1"
                    while IFS= read -r line; do
                      printf r >> "$2"
                      id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
                      if [ "$id" -le 3 ]; then
                        while [ ! -f "$4/release-$id" ]; do sleep 0.01; done
                        printf '{"id":%s,"ok":true,"output":"late-%s"}\n' "$id" "$id"
                        printf l >> "$3"
                      else
                        printf '{"id":%s,"ok":true,"output":"live-%s"}\n' "$id" "$id"
                      fi
                    done
                    """, "serve-fixture", pidsFile, requestsFile, lateRepliesFile, dir]
                child.qualityOfService = qualityOfService
                return child
            },
            timeoutSleep: { nanoseconds in
                try await clock.sleep(nanoseconds)
            }
        )

        for attempt in 0..<3 {
            let request = Task {
                try await connection.request(args: ["status", "--attempt", String(attempt)])
            }
            let requestRead = await eventually {
                ((try? String(contentsOfFile: requestsFile, encoding: .utf8))?.count ?? 0) >= attempt + 1
            }
            #expect(requestRead)
            let releaseMarker = dir + "/release-\(attempt + 1)"
            request.cancel()
            do {
                _ = try await withHangGuard(onExpiry: {
                    Issue.record("cancellation of attempt \(attempt) was not observed before its reply was released")
                    _ = FileManager.default.createFile(atPath: releaseMarker, contents: Data())
                }) {
                    try await request.value
                }
                #expect(Bool(false), "cancelled request unexpectedly succeeded")
            } catch {
                #expect(error is CancellationError)
            }

            // Only now does the fake child emit the orphaned response. It must
            // be ignored without double-resuming anything, and the same
            // resident child must remain available for the next id.
            _ = FileManager.default.createFile(atPath: releaseMarker, contents: Data())
            let lateReplyWritten = await eventually {
                ((try? String(contentsOfFile: lateRepliesFile, encoding: .utf8))?.count ?? 0) >= attempt + 1
            }
            #expect(lateReplyWritten)
            let replies = (try? String(contentsOfFile: lateRepliesFile, encoding: .utf8).count) ?? 0
            #expect(replies == attempt + 1)
        }

        let finalPayload = try await connection.request(args: ["status", "--attempt", "final"])
        #expect(String(decoding: finalPayload, as: UTF8.self) == "live-4")
        let pids = try String(contentsOfFile: pidsFile, encoding: .utf8)
            .split(separator: "\n")
        #expect(pids.count == 1)
        #expect(try String(contentsOfFile: requestsFile, encoding: .utf8) == "rrrr")
        #expect(try String(contentsOfFile: lateRepliesFile, encoding: .utf8) == "lll")
        await connection.shutdown()
    }

    @Test("cancelling a queued request never writes it or arms its timeout")
    func queuedCancellationNeverReachesChild() async throws {
        let dir = NSTemporaryDirectory() + "serve-connection-queued-cancel-test-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let requestsFile = dir + "/requests"
        let releaseMarker = dir + "/release"
        let recorder = TimeoutRecorder()

        let connection = ServeConnection(
            makeProcess: { _, qualityOfService in
                let child = Process()
                child.executableURL = URL(fileURLWithPath: "/bin/sh")
                child.arguments = ["-c", """
                    count=0
                    while IFS= read -r line; do
                      count=$((count + 1))
                      printf '%s\n' "$line" >> "$1"
                      if [ "$count" -eq 1 ]; then
                        while [ ! -f "$2" ]; do sleep 0.01; done
                      fi
                      id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
                      printf '{"id":%s,"ok":true,"output":"served-%s"}\n' "$id" "$id"
                    done
                    """, "serve-fixture", requestsFile, releaseMarker]
                child.qualityOfService = qualityOfService
                return child
            },
            timeoutSleep: { nanoseconds in
                try await recorder.recordAndWait(nanoseconds)
            }
        )

        let first = Task { try await connection.request(args: ["status", "first"]) }
        for _ in 0..<200 where !(FileManager.default.fileExists(atPath: requestsFile)) {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        let cancelled = Task { try await connection.request(args: ["status", "cancelled"]) }
        let third = Task { try await connection.request(args: ["status", "third"]) }
        try await Task.sleep(nanoseconds: 100_000_000)
        cancelled.cancel()
        do {
            _ = try await cancelled.value
            Issue.record("queued cancellation unexpectedly succeeded")
        } catch {
            #expect(error is CancellationError)
        }
        #expect(await recorder.snapshot() == [coldTimeoutNanoseconds])

        _ = FileManager.default.createFile(atPath: releaseMarker, contents: Data())
        #expect(String(decoding: try await first.value, as: UTF8.self) == "served-1")
        #expect(String(decoding: try await third.value, as: UTF8.self) == "served-2")
        let requests = try String(contentsOfFile: requestsFile, encoding: .utf8)
        #expect(requests.contains("first"))
        #expect(requests.contains("third"))
        #expect(!requests.contains("cancelled"))
        #expect(await recorder.snapshot() == [coldTimeoutNanoseconds, warmTimeoutNanoseconds])
        await connection.shutdown()
    }

    @Test("shutdown fails the active request and every client-side queued request")
    func shutdownDrainsClientQueue() async throws {
        let dir = NSTemporaryDirectory() + "serve-connection-shutdown-queue-test-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let requestMarker = dir + "/request-read"
        let recorder = TimeoutRecorder()
        let connection = ServeConnection(
            makeProcess: { _, qualityOfService in
                let child = Process()
                child.executableURL = URL(fileURLWithPath: "/bin/sh")
                child.arguments = ["-c", "IFS= read -r line; : > \"$1\"; sleep 5", "serve-fixture", requestMarker]
                child.qualityOfService = qualityOfService
                return child
            },
            timeoutSleep: { nanoseconds in
                try await recorder.recordAndWait(nanoseconds)
            }
        )

        let active = Task { try await connection.request(args: ["status", "active"]) }
        for _ in 0..<200 where !FileManager.default.fileExists(atPath: requestMarker) {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        let queued = Task { try await connection.request(args: ["status", "queued"]) }
        try await Task.sleep(nanoseconds: 100_000_000)
        #expect(await recorder.snapshot() == [coldTimeoutNanoseconds])
        await connection.shutdown()

        for request in [active, queued] {
            do {
                _ = try await request.value
                Issue.record("shutdown request unexpectedly succeeded")
            } catch {
                #expect(error is ServeConnection.ServeRequestFailed)
            }
        }
    }

    @Test("late stdout from a replaced child cannot corrupt or warm its replacement")
    func staleGenerationStdoutIsDiscarded() async throws {
        let oldChild = Process()
        oldChild.executableURL = URL(fileURLWithPath: "/bin/sh")
        oldChild.arguments = ["-c", "IFS= read -r line; sleep 0.1; exit 1"]

        let newChild = Process()
        newChild.executableURL = URL(fileURLWithPath: "/bin/sh")
        newChild.arguments = ["-c", """
            while IFS= read -r line; do
              id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
              printf '{"id":%s,"ok":true,"output":"new-%s"}\n' "$id" "$id"
            done
            """]

        let children = ProcessQueue([oldChild, newChild])
        let recorder = TimeoutRecorder()
        let connection = ServeConnection(
            makeProcess: { _, qualityOfService in
                children.take(qualityOfService: qualityOfService)
            },
            timeoutSleep: { nanoseconds in
                try await recorder.recordAndWait(nanoseconds)
            }
        )

        // The admitted read survives the old generation's crash and retries
        // on the replacement. Request id 1 belonged to the old child; the
        // replacement receives id 2.
        let retried = try await connection.request(args: ["status", "--generation", "old"])
        #expect(String(decoding: retried, as: UTF8.self) == "new-2")

        // Model both harmful trailing shapes after the replacement owns the
        // connection: a complete terminal would incorrectly select the warm
        // timeout, while a fragment would corrupt the replacement's first line.
        await connection.consume(
            Data("{\"id\":1,\"ok\":true,\"output\":\"late-old\"}\n".utf8),
            from: oldChild
        )
        await connection.consume(Data("{\"id\":1".utf8), from: oldChild)

        let payload = try await connection.request(args: ["status", "--generation", "new"])

        #expect(String(decoding: payload, as: UTF8.self) == "new-3")
        #expect(await recorder.snapshot() == [
            coldTimeoutNanoseconds,
            coldTimeoutNanoseconds,
            warmTimeoutNanoseconds,
        ])
        #expect(children.remainingCount == 0)
        await connection.shutdown()
    }

    @Test("queued requests arm their warm timeout only after cold hydration finishes")
    func coldAndWarmTimeoutSelection() async throws {
        let dir = NSTemporaryDirectory() + "serve-connection-timeout-test-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let releaseMarker = dir + "/release-cold-responses"
        let recorder = TimeoutRecorder()

        let connection = ServeConnection(
            makeProcess: { _, qualityOfService in
                let child = Process()
                child.executableURL = URL(fileURLWithPath: "/bin/sh")
                child.arguments = ["-c", """
                    IFS= read -r first
                    while [ ! -f "$1" ]; do sleep 0.01; done
                    for slot in first second third; do
                      if [ "$slot" = first ]; then line="$first"; else IFS= read -r line; fi
                      id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
                      printf '{"id":%s,"ok":true,"output":"served"}\\n' "$id"
                    done
                    """, "serve-fixture", releaseMarker]
                child.qualityOfService = qualityOfService
                return child
            },
            timeoutSleep: { nanoseconds in
                try await recorder.recordAndWait(nanoseconds)
            }
        )

        let first = Task { try await connection.request(args: ["status", "--request", "one"]) }
        let second = Task { try await connection.request(args: ["status", "--request", "two"]) }
        try await Task.sleep(nanoseconds: 100_000_000)
        #expect(await recorder.snapshot() == [coldTimeoutNanoseconds])

        _ = FileManager.default.createFile(atPath: releaseMarker, contents: Data())
        let firstPayload = try await first.value
        let secondPayload = try await second.value
        #expect(String(decoding: firstPayload, as: UTF8.self) == "served")
        #expect(String(decoding: secondPayload, as: UTF8.self) == "served")

        let thirdPayload = try await connection.request(args: ["status", "--request", "three"])
        #expect(String(decoding: thirdPayload, as: UTF8.self) == "served")
        let allSelections = await recorder.snapshot()
        #expect(allSelections == [
            coldTimeoutNanoseconds,
            warmTimeoutNanoseconds,
            warmTimeoutNanoseconds,
        ])
        await connection.shutdown()
    }

    @Test("a failed terminal response does not mark the resident child warm")
    func failedTerminalResponseKeepsColdTimeout() async throws {
        let recorder = TimeoutRecorder()
        let connection = ServeConnection(
            makeProcess: { _, qualityOfService in
                let child = Process()
                child.executableURL = URL(fileURLWithPath: "/bin/sh")
                child.arguments = ["-c", """
                    count=0
                    while IFS= read -r line; do
                      count=$((count + 1))
                      id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
                      if [ "$count" -eq 1 ]; then
                        printf '{"id":%s,"ok":false,"error":"cold failure"}\\n' "$id"
                      else
                        printf '{"id":%s,"ok":true,"output":"served-%s"}\\n' "$id" "$count"
                      fi
                    done
                    """]
                child.qualityOfService = qualityOfService
                return child
            },
            timeoutSleep: { nanoseconds in
                try await recorder.recordAndWait(nanoseconds)
            }
        )

        do {
            _ = try await connection.request(args: ["status", "--request", "failed"])
            #expect(Bool(false), "failed response unexpectedly succeeded")
        } catch {
            #expect(error is ServeConnection.ServeRequestFailed)
        }

        let second = try await connection.request(args: ["status", "--request", "cold-success"])
        let third = try await connection.request(args: ["status", "--request", "warm-success"])

        #expect(String(decoding: second, as: UTF8.self) == "served-2")
        #expect(String(decoding: third, as: UTF8.self) == "served-3")
        #expect(await recorder.snapshot() == [
            coldTimeoutNanoseconds,
            coldTimeoutNanoseconds,
            warmTimeoutNanoseconds,
        ])
        await connection.shutdown()
    }

    @Test("an actual stdout flood is bounded and the next generation stays healthy")
    func oversizedFrameTerminatesOnlyItsGeneration() async throws {
        let oldChild = Process()
        oldChild.executableURL = URL(fileURLWithPath: "/bin/sh")
        oldChild.arguments = ["-c", """
            IFS= read -r line
            dd if=/dev/zero bs=1024 count=1 2>/dev/null | tr '\\0' x
            sleep 5
            """]

        let replacement = Process()
        replacement.executableURL = URL(fileURLWithPath: "/bin/sh")
        replacement.arguments = ["-c", """
            IFS= read -r line
            id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
            printf '{"id":%s,"ok":true,"output":"replacement"}\\n' "$id"
            """]

        let children = ProcessQueue([oldChild, replacement])
        let recorder = TimeoutRecorder()
        let connection = ServeConnection(
            makeProcess: { _, qualityOfService in
                children.take(qualityOfService: qualityOfService)
            },
            timeoutSleep: { nanoseconds in
                try await recorder.recordAndWait(nanoseconds)
            },
            responseLimitBytes: 128
        )

        do {
            _ = try await connection.request(args: ["status", "--oversized"])
            #expect(Bool(false), "oversized resident frame unexpectedly succeeded")
        } catch let error as ServeConnection.ServeRequestFailed {
            #expect(error.reason == .outputTooLarge)
        }

        await connection.ensureStarted()
        let payload = try await connection.request(args: ["status", "--replacement"])
        #expect(String(decoding: payload, as: UTF8.self) == "replacement")
        #expect(children.remainingCount == 0)
        await connection.shutdown()
    }

    @Test("an unterminated frame and cumulative progress cannot bypass the resident limit")
    func partialAndCumulativeFramesAreBounded() async throws {
        for mode in ["partial", "progress"] {
            let child = Process()
            child.executableURL = URL(fileURLWithPath: "/bin/sh")
            child.arguments = ["-c", "IFS= read -r line; sleep 5"]
            let recorder = TimeoutRecorder()
            let connection = ServeConnection(
                makeProcess: { _, qualityOfService in
                    child.qualityOfService = qualityOfService
                    return child
                },
                timeoutSleep: { nanoseconds in
                    try await recorder.recordAndWait(nanoseconds)
                },
                responseLimitBytes: 128
            )
            let request = Task { try await connection.request(args: ["status", "--mode", mode]) }
            for _ in 0..<200 {
                if await recorder.snapshot().count == 1 { break }
                try await Task.sleep(nanoseconds: 10_000_000)
            }

            if mode == "partial" {
                await connection.consume(Data(repeating: UInt8(ascii: "x"), count: 129), from: child)
            } else {
                let progress = String(repeating: "p", count: 70)
                let frame = Data("{\"id\":1,\"progress\":\"\(progress)\"}\n".utf8)
                #expect(frame.count < 128)
                await connection.consume(frame, from: child)
                await connection.consume(frame, from: child)
            }

            do {
                _ = try await request.value
                #expect(Bool(false), "\(mode) overflow unexpectedly succeeded")
            } catch let error as ServeConnection.ServeRequestFailed {
                #expect(error.reason == .outputTooLarge)
            }
            await connection.shutdown()
        }
    }

    @Test("a cancelled request keeps its cumulative progress bound until the child finishes")
    func cancelledRequestStillBoundsOrphanProgress() async throws {
        let oldChild = Process()
        oldChild.executableURL = URL(fileURLWithPath: "/bin/sh")
        oldChild.arguments = ["-c", "IFS= read -r line; sleep 5"]

        let replacement = Process()
        replacement.executableURL = URL(fileURLWithPath: "/bin/sh")
        replacement.arguments = ["-c", """
            IFS= read -r line
            id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
            printf '{"id":%s,"ok":true,"output":"healthy"}\\n' "$id"
            """]

        let children = ProcessQueue([oldChild, replacement])
        let recorder = TimeoutRecorder()
        let connection = ServeConnection(
            makeProcess: { _, qualityOfService in
                children.take(qualityOfService: qualityOfService)
            },
            timeoutSleep: { nanoseconds in
                try await recorder.recordAndWait(nanoseconds)
            },
            responseLimitBytes: 128
        )

        let abandoned = Task { try await connection.request(args: ["status", "--abandoned"]) }
        for _ in 0..<200 {
            if await recorder.snapshot().count == 1 { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        abandoned.cancel()
        do {
            _ = try await abandoned.value
            Issue.record("cancelled request unexpectedly succeeded")
        } catch {
            #expect(error is CancellationError)
        }

        let progress = String(repeating: "p", count: 70)
        let frame = Data("{\"id\":1,\"progress\":\"\(progress)\"}\n".utf8)
        await connection.consume(frame, from: oldChild)
        await connection.consume(frame, from: oldChild)

        await connection.ensureStarted()
        #expect(children.remainingCount == 0)
        let payload = try await connection.request(args: ["status", "--replacement"])
        #expect(String(decoding: payload, as: UTF8.self) == "healthy")
        await connection.shutdown()
    }

    @Test("each overflow consumes exactly one resident death")
    func overflowDeathBudgetIsExact() async throws {
        let processes = (0..<3).map { _ in
            let child = Process()
            child.executableURL = URL(fileURLWithPath: "/bin/sh")
            child.arguments = ["-c", "IFS= read -r line; sleep 5"]
            return child
        }
        let children = ProcessQueue(processes)
        let recorder = TimeoutRecorder()
        let connection = ServeConnection(
            makeProcess: { _, qualityOfService in
                children.take(qualityOfService: qualityOfService)
            },
            timeoutSleep: { nanoseconds in
                try await recorder.recordAndWait(nanoseconds)
            },
            responseLimitBytes: 64
        )

        for attempt in 0..<3 {
            let request = Task { try await connection.request(args: ["status", "--attempt", "\(attempt)"]) }
            for _ in 0..<200 {
                if await recorder.snapshot().count == attempt + 1 { break }
                try await Task.sleep(nanoseconds: 10_000_000)
            }
            await connection.consume(Data(repeating: UInt8(ascii: "x"), count: 65), from: processes[attempt])
            do {
                _ = try await request.value
                Issue.record("overflow \(attempt) unexpectedly succeeded")
            } catch let error as ServeConnection.ServeRequestFailed {
                #expect(error.reason == .outputTooLarge)
            }
        }

        #expect(children.remainingCount == 0)
        do {
            _ = try await connection.request(args: ["status", "--after-budget"])
            Issue.record("resident restarted after exhausting its death budget")
        } catch {
            #expect(error is ServeConnection.ServeUnavailable)
        }
        await connection.shutdown()
    }

    @Test("output overflow is not eligible for a one-shot fallback")
    func outputOverflowIsTerminalForDataClient() async {
        let overflow = ServeConnection.ServeRequestFailed(
            message: "too large",
            reason: .outputTooLarge
        )
        let fallback = FallbackRecorder()
        do {
            _ = try await DataClient.runCLI(
                subcommand: ["status", "--format", "menubar-json"],
                serveRequest: { _ in throw overflow },
                spawnFallback: {
                    await fallback.record()
                    return DataClient.ProcessResult(stdout: Data(), stderr: "", exitCode: 0)
                }
            )
            Issue.record("output overflow unexpectedly fell back or succeeded")
        } catch DataClientError.outputTooLarge {
            // Expected: the one-shot closure must remain untouched.
        } catch {
            Issue.record("unexpected terminal error: \(error)")
        }
        #expect(await fallback.snapshot() == 0)

        let ordinary = ServeConnection.ServeRequestFailed(message: "serve exited")
        do {
            let result = try await DataClient.runCLI(
                subcommand: ["status", "--format", "menubar-json"],
                serveRequest: { _ in throw ordinary },
                spawnFallback: {
                    await fallback.record()
                    return DataClient.ProcessResult(stdout: Data("fallback".utf8), stderr: "", exitCode: 0)
                }
            )
            #expect(String(decoding: result.stdout, as: UTF8.self) == "fallback")
        } catch {
            Issue.record("ordinary serve failure did not use fallback: \(error)")
        }
        #expect(await fallback.snapshot() == 1)
    }

    @Test("a verified-fresh request can bypass the resident worker")
    func verifiedFreshRequestBypassesResident() async throws {
        let resident = FallbackRecorder()
        let fallback = FallbackRecorder()

        let result = try await DataClient.runCLI(
            subcommand: ["status", "--format", "menubar-json", "--provider", "hermes"],
            bypassResident: true,
            serveRequest: { _ in
                await resident.record()
                return Data("stale".utf8)
            },
            spawnFallback: {
                await fallback.record()
                return DataClient.ProcessResult(stdout: Data("fresh".utf8), stderr: "", exitCode: 0)
            }
        )

        #expect(String(decoding: result.stdout, as: UTF8.self) == "fresh")
        #expect(await resident.snapshot() == 0)
        #expect(await fallback.snapshot() == 1)
    }

    @Test("the first real request is the only cold-start query")
    func firstRequestIsTheWarmup() async throws {
        let dir = NSTemporaryDirectory() + "serve-connection-test-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let requestLog = dir + "/requests.log"

        let connection = ServeConnection { _, qualityOfService in
            let child = Process()
            child.executableURL = URL(fileURLWithPath: "/bin/sh")
            child.arguments = ["-c", """
                while IFS= read -r line; do
                  printf 'request\\n' >> "$1"
                  id=$(printf '%s' "$line" | sed -E 's/.*\"id\":([0-9]+).*/\\1/')
                  printf '{\"id\":%s,\"progress\":\"scanning\"}\\n' "$id"
                  printf '{\"id\":%s,\"ok\":true,\"output\":\"served\"}\\n' "$id"
                  # Emit READY after the terminal response. The client must
                  # register and complete the first real request without it.
                  printf '{\"ready\":true,\"pid\":1}\\n'
                done
                """, "serve-fixture", requestLog]
            child.qualityOfService = qualityOfService
            return child
        }

        await connection.ensureStarted()
        let payload = try await connection.request(args: ["status", "--format", "menubar-json"])

        #expect(String(decoding: payload, as: UTF8.self) == "served")
        let requests = try String(contentsOfFile: requestLog, encoding: .utf8)
            .split(separator: "\n")
        #expect(requests.count == 1)
        await connection.shutdown()
    }

    @Test("split terminal bytes are drained before child death and the next generation stays clean")
    func finalStdoutDrainPrecedesTermination() async throws {
        let first = Process()
        first.executableURL = URL(fileURLWithPath: "/bin/sh")
        first.arguments = ["-c", """
            IFS= read -r line
            id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
            printf '{"id":%s,"ok":true,' "$id"
            printf '"output":"final-drain"}\n'
            """]

        let replacement = Process()
        replacement.executableURL = URL(fileURLWithPath: "/bin/sh")
        replacement.arguments = ["-c", """
            while IFS= read -r line; do
              id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
              printf '{"id":%s,"ok":true,"output":"replacement"}\n' "$id"
            done
            """]

        let children = ProcessQueue([first, replacement])
        let connection = ServeConnection { _, qualityOfService in
            children.take(qualityOfService: qualityOfService)
        }

        let drained = try await connection.request(args: ["status", "drain"])
        #expect(String(decoding: drained, as: UTF8.self) == "final-drain")
        let next = try await connection.request(args: ["status", "next"])
        #expect(String(decoding: next, as: UTF8.self) == "replacement")
        #expect(children.remainingCount == 0)
        await connection.shutdown()
    }

    @Test("a child that closes stdin fails the request without terminating the app")
    func closedChildStdinDoesNotRaiseSIGPIPE() async throws {
        let dir = NSTemporaryDirectory() + "serve-connection-sigpipe-test-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let closedMarker = dir + "/stdin-closed"
        let sigpipeHandlerBefore = currentSIGPIPEHandlerBits()

        let connection = ServeConnection { _, qualityOfService in
            let child = Process()
            child.executableURL = URL(fileURLWithPath: "/bin/sh")
            child.arguments = ["-c", "exec 0<&-; : > \"$1\"; sleep 2", "serve-fixture", closedMarker]
            child.qualityOfService = qualityOfService
            return child
        }

        await connection.ensureStarted()
        #expect(currentSIGPIPEHandlerBits() == sigpipeHandlerBefore)
        #expect(currentSIGPIPEHandlerBits() != ignoredSIGPIPEHandlerBits)
        for _ in 0..<200 where !FileManager.default.fileExists(atPath: closedMarker) {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        #expect(FileManager.default.fileExists(atPath: closedMarker))

        var requestFailed = false
        do {
            _ = try await connection.request(args: ["status", "--format", "menubar-json"])
        } catch {
            requestFailed = true
        }
        #expect(requestFailed)
        await connection.shutdown()
    }
}
