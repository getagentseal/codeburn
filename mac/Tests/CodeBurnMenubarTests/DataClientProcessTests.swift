import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("DataClient process")
struct DataClientProcessTests {
    @Test("status argv local omits scope")
    func statusSubcommandLocalOmitsScope() {
        let args = DataClient.statusSubcommand(
            period: .today,
            provider: .claude,
            includeOptimize: false,
            scope: .local
        )

        #expect(!args.contains("--scope"))
        #expect(value(after: "--provider", in: args) == "claude")
        #expect(args.contains("--no-optimize"))
    }

    @Test("status argv combined adds scope and forces provider all")
    func statusSubcommandCombinedAddsScopeAndForcesAllProvider() {
        let args = DataClient.statusSubcommand(
            period: .today,
            provider: .codex,
            includeOptimize: true,
            scope: .combined
        )

        #expect(value(after: "--scope", in: args) == "combined")
        #expect(value(after: "--provider", in: args) == "all")
        #expect(!args.contains("--no-optimize"))
    }

    @Test("status argv combined multi-day coerces to local")
    func statusSubcommandCombinedMultiDayCoercesToLocal() {
        let args = DataClient.statusSubcommand(
            period: .today,
            days: ["2026-06-01", "2026-06-02"],
            provider: .codex,
            includeOptimize: false,
            scope: .combined
        )

        #expect(!args.contains("--scope"))
        #expect(value(after: "--provider", in: args) == "codex")
        #expect(value(after: "--days", in: args) == "2026-06-01,2026-06-02")
    }

    /// Concurrency + timeout smoke test: launch more hung subprocesses than
    /// there are cooperative threads, all at once, with a short timeout, and
    /// assert every call returns once the timeout kills its sleep.
    ///
    /// NOTE: this does NOT reproduce the production permanent deadlock (16/16
    /// cooperative threads parked in waitUntilExit). In a short-lived unit-test
    /// process libdispatch spins up replacement threads for blocked workers, so
    /// even the old blocking-on-the-pool code completes here. The real deadlock
    /// built up over ~2 days under the @MainActor refresh loop and is confirmed
    /// by the live `sample`, not by this test. Kept as a guard that the
    /// off-pool wait + timeout path stays correct under concurrency.
    @Test("concurrent timed-out processes all complete")
    func concurrentTimedOutProcessesAllComplete() {
        let count = ProcessInfo.processInfo.activeProcessorCount * 2 + 4
        let done = DispatchSemaphore(value: 0)

        Task {
            await withTaskGroup(of: Void.self) { group in
                for _ in 0..<count {
                    group.addTask {
                        let process = Process()
                        process.executableURL = URL(fileURLWithPath: "/bin/sleep")
                        process.arguments = ["30"]
                        _ = try? await DataClient.runProcess(process, timeoutSeconds: 1, label: "sleep 30")
                    }
                }
            }
            done.signal()
        }

        // Wait on the test thread (a real thread, not the cooperative pool) so
        // the deadlock is detectable even when the pool is fully starved.
        let outcome = done.wait(timeout: .now() + 15)
        #expect(outcome == .success, "runProcess deadlocked: \(count) concurrent CLIs starved the cooperative pool")
    }

    /// A decode failure surfaces the CLI's actual stdout/stderr so a stray banner
    /// on stdout (see #515) is self-diagnosing instead of an opaque "not valid JSON".
    @Test("decode failure surfaces output")
    func decodeFailureSurfacesOutput() {
        struct Boom: Error {}
        let failure = CLIDecodeFailure(
            underlying: Boom(),
            stdoutByteCount: 13,
            stdoutSnippet: "(node) banner",
            stderr: "warn: x"
        )
        let text = String(describing: failure)
        #expect(text.contains("(node) banner"), "should include the stdout snippet")
        #expect(text.contains("13 bytes"), "should include the stdout byte count")
        #expect(text.contains("warn: x"), "should include stderr")
    }

    /// Empty stdout is reported distinctly (the JSONDecoder-on-empty-Data case).
    @Test("decode failure with empty stdout")
    func decodeFailureWithEmptyStdout() {
        struct Boom: Error {}
        let failure = CLIDecodeFailure(underlying: Boom(), stdoutByteCount: 0, stdoutSnippet: "", stderr: "")
        let text = String(describing: failure)
        #expect(text.contains("0 bytes"))
        #expect(text.contains("<empty>"))
    }

    /// A normally-exiting process returns its real output and exit code through
    /// the off-pool wait path.
    @Test("process returns output and exit code")
    func processReturnsOutputAndExitCode() async throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/echo")
        process.arguments = ["hello"]
        let result = try await DataClient.runProcess(process, timeoutSeconds: 5, label: "echo hello")
        #expect(result.exitCode == 0)
        #expect(String(data: result.stdout, encoding: .utf8) == "hello\n")
    }

    /// Many NORMALLY-exiting processes, all at once, must every one complete
    /// through the terminationHandler wait path. Guards against the wait path
    /// leaking or wedging under concurrency (the production bug was the wait and
    /// its timeout sharing one queue that saturated under sustained load).
    @Test("many normal processes all complete")
    func manyNormalProcessesAllComplete() async {
        let count = 50
        let codes = await withTaskGroup(of: Int32?.self) { group -> [Int32?] in
            for _ in 0..<count {
                group.addTask {
                    let process = Process()
                    process.executableURL = URL(fileURLWithPath: "/bin/echo")
                    process.arguments = ["ok"]
                    return try? await DataClient.runProcess(process, timeoutSeconds: 5, label: "echo ok").exitCode
                }
            }
            var out: [Int32?] = []
            for await code in group { out.append(code) }
            return out
        }
        #expect(codes.count == count)
        #expect(codes.allSatisfy { $0 == 0 },
                "every concurrent process should exit 0 via the terminationHandler wait path")
    }

    /// The async semaphore never lets more than its count run concurrently.
    @Test("async semaphore caps concurrency")
    func asyncSemaphoreCapsConcurrency() async {
        let sem = AsyncSemaphore(2)
        let peak = PeakCounter()
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<12 {
                group.addTask {
                    await sem.acquire()
                    await peak.enter()
                    try? await Task.sleep(nanoseconds: 8_000_000)
                    await peak.leave()
                    await sem.release()
                }
            }
        }
        let observed = await peak.peak
        #expect(observed <= 2, "semaphore should cap concurrency at 2, saw \(observed)")
        #expect(observed > 0)
    }
}

private func value(after flag: String, in args: [String]) -> String? {
    guard let index = args.firstIndex(of: flag), args.indices.contains(index + 1) else {
        return nil
    }
    return args[index + 1]
}

private actor PeakCounter {
    private var current = 0
    private(set) var peak = 0
    func enter() { current += 1; peak = max(peak, current) }
    func leave() { current -= 1 }
}
