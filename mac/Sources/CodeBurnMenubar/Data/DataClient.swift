import Foundation

/// Upper bound on payload + stderr bytes read from the CLI. Real payloads top out near 500 KB
/// (365 days of history with dozens of models); anything larger is pathological and truncating
/// prevents unbounded memory growth. Hard timeout guards against a hung CLI keeping Process and
/// Pipe file descriptors pinned forever.
private let maxPayloadBytes = 20 * 1024 * 1024
private let maxStderrBytes = 256 * 1024
private let maxDecodeStdoutPreviewBytes = 4 * 1024
private let spawnTimeoutSeconds: UInt64 = 45
private let maxConcurrentSpawns = 6

enum DataClientError: Error {
    case spawn(String)
    case nonZeroExit(code: Int32, stderr: String)
    case decode(Error, stdoutPreview: String, stderr: String, stdoutBytes: Int)
    case timeout
    case outputTooLarge
}

/// Runs the CLI via argv (no shell interpretation). See `CodeburnCLI` for why we never route
/// commands through `/bin/zsh -c` anymore.
struct DataClient {
    static func fetch(period: Period, day: String? = nil, days: Set<String> = [], provider: ProviderFilter, includeOptimize: Bool) async throws -> MenubarPayload {
        var subcommand = [
            "status",
            "--format", "menubar-json",
            "--provider", provider.cliArg,
        ]
        if days.count > 1 {
            subcommand.append(contentsOf: ["--days", days.sorted().joined(separator: ",")])
        } else if let day {
            subcommand.append(contentsOf: ["--day", day])
        } else if let d = days.first {
            subcommand.append(contentsOf: ["--day", d])
        } else {
            subcommand.append(contentsOf: ["--period", period.cliArg])
        }
        if !includeOptimize {
            subcommand.append("--no-optimize")
        }

        let result = try await runCLI(subcommand: subcommand)
        guard result.exitCode == 0 else {
            throw DataClientError.nonZeroExit(code: result.exitCode, stderr: result.stderr)
        }
        do {
            return try JSONDecoder().decode(MenubarPayload.self, from: result.stdout)
        } catch {
            throw DataClientError.decode(
                error,
                stdoutPreview: decodeFailureStdoutPreview(from: result.stdout),
                stderr: result.stderr,
                stdoutBytes: result.stdout.count
            )
        }
    }

    struct ProcessResult {
        let stdout: Data
        let stderr: String
        let exitCode: Int32
    }

    /// Caps concurrent CLI spawns so a wake-burst of refreshes can't fan out into
    /// dozens of node processes at once.
    private static let spawnLimiter = AsyncSemaphore(maxConcurrentSpawns)

    private static func runCLI(subcommand: [String]) async throws -> ProcessResult {
        await spawnLimiter.acquire()
        defer { Task { await spawnLimiter.release() } }
        let process = CodeburnCLI.makeProcess(subcommand: subcommand)
        return try await runProcess(process,
                                    timeoutSeconds: spawnTimeoutSeconds,
                                    label: subcommand.joined(separator: " "))
    }

    /// Runs an already-configured process to completion, draining its output and
    /// enforcing a hard timeout.
    ///
    /// CRITICAL: nothing here may block a worker thread waiting for the process.
    /// `process.waitUntilExit()` is a blocking syscall. An earlier fix moved it
    /// onto a global(qos:.utility) queue with the timeout on that SAME queue — but
    /// under sustained load every utility worker ended up blocked in waitUntilExit,
    /// so the timeout could never be scheduled to kill them and the menubar wedged
    /// on "Loading…" forever (confirmed via sample: threads parked in
    /// waitUntilExit, timeout never firing). Instead we await
    /// `process.terminationHandler`, which fires on a Foundation-managed queue and
    /// blocks nothing, so the timeout always has a free thread to fire on.
    static func runProcess(_ process: Process,
                           timeoutSeconds: UInt64,
                           label: String) async throws -> ProcessResult {
        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe

        // Bridge the process exit to an async signal set up BEFORE run(), so the
        // exit can never be missed and the wait never blocks a worker thread.
        let exitSignal = ProcessExitSignal()
        process.terminationHandler = { _ in exitSignal.fulfill() }

        do {
            try process.run()
        } catch {
            throw DataClientError.spawn(error.localizedDescription)
        }

        let timeoutTimer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        timeoutTimer.schedule(deadline: .now() + .seconds(Int(timeoutSeconds)))
        timeoutTimer.setEventHandler {
            if process.isRunning {
                NSLog("CodeBurn: CLI subprocess timed out after %llus for %@ — terminating",
                      timeoutSeconds, label)
                terminateWithEscalation(process)
            }
        }
        timeoutTimer.resume()
        defer { timeoutTimer.cancel() }

        let outHandle = outPipe.fileHandleForReading
        let errHandle = errPipe.fileHandleForReading
        let (out, err) = await withTaskCancellationHandler {
            async let stdoutData = drain(outHandle, limit: maxPayloadBytes)
            async let stderrData = drain(errHandle, limit: maxStderrBytes)
            return await (stdoutData, stderrData)
        } onCancel: {
            terminateWithEscalation(process)
        }
        try? outHandle.close()
        try? errHandle.close()
        // Wait for exit via terminationHandler, never by parking a worker thread
        // in waitUntilExit (see the doc comment above for why that wedged).
        await exitSignal.wait()

        if out.count >= maxPayloadBytes {
            throw DataClientError.outputTooLarge
        }

        let stderrString = String(data: err, encoding: .utf8) ?? ""
        return ProcessResult(stdout: out, stderr: stderrString, exitCode: process.terminationStatus)
    }

    private static func terminateWithEscalation(_ process: Process) {
        guard process.isRunning else { return }
        process.terminate()
        let pid = process.processIdentifier
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 0.5) {
            if process.isRunning { kill(pid, SIGKILL) }
        }
    }

    private static func drain(_ handle: FileHandle, limit: Int) async -> Data {
        let fd = handle.fileDescriptor
        let flags = Darwin.fcntl(fd, F_GETFL)
        if flags >= 0 {
            _ = Darwin.fcntl(fd, F_SETFL, flags | O_NONBLOCK)
        } else {
            NSLog("CodeBurn: fcntl F_GETFL failed on fd %d, drain may block", fd)
        }

        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 65_536)

        while buffer.count < limit && !Task.isCancelled {
            let toRead = min(chunk.count, limit - buffer.count)
            let n = chunk.withUnsafeMutableBufferPointer { ptr in
                Darwin.read(fd, ptr.baseAddress!, toRead)
            }
            if n > 0 {
                buffer.append(contentsOf: chunk.prefix(n))
            } else if n == 0 {
                break
            } else if errno == EAGAIN || errno == EWOULDBLOCK {
                try? await Task.sleep(nanoseconds: 5_000_000)
            } else if errno == EINTR {
                continue
            } else {
                NSLog("CodeBurn: drain read() failed on fd %d: errno %d", fd, errno)
                break
            }
        }
        return buffer
    }

    static func decodeFailureStdoutPreview(from stdout: Data) -> String {
        let preview = stdout.prefix(maxDecodeStdoutPreviewBytes)
        return String(decoding: preview, as: UTF8.self)
    }
}

extension DataClientError: CustomStringConvertible {
    var description: String {
        switch self {
        case .spawn(let message):
            return "spawn(\(String(reflecting: message)))"
        case .nonZeroExit(let code, let stderr):
            return "nonZeroExit(code: \(code), stderr: \(String(reflecting: stderr)))"
        case .decode(let error, let stdoutPreview, let stderr, let stdoutBytes):
            return "decode(\(error); stdoutPreview(first \(stdoutPreview.utf8.count) of \(stdoutBytes) bytes): \(String(reflecting: stdoutPreview)); stderr: \(String(reflecting: stderr)))"
        case .timeout:
            return "timeout"
        case .outputTooLarge:
            return "outputTooLarge"
        }
    }
}

/// One-shot async signal that bridges `Process.terminationHandler` (invoked on a
/// Foundation-internal queue) to an awaiting task without blocking a worker
/// thread. Safe against fulfill-before-wait.
final class ProcessExitSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var fulfilled = false
    private var continuation: CheckedContinuation<Void, Never>?

    func fulfill() {
        lock.lock()
        if fulfilled { lock.unlock(); return }
        fulfilled = true
        let cont = continuation
        continuation = nil
        lock.unlock()
        cont?.resume()
    }

    func wait() async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            lock.lock()
            if fulfilled {
                lock.unlock()
                cont.resume()
            } else {
                continuation = cont
                lock.unlock()
            }
        }
    }
}

/// Minimal actor-based async semaphore. Caps concurrency without blocking a
/// thread (unlike DispatchSemaphore.wait()).
actor AsyncSemaphore {
    private var available: Int
    private var waiters: [CheckedContinuation<Void, Never>] = []

    init(_ count: Int) { available = count }

    func acquire() async {
        if available > 0 {
            available -= 1
            return
        }
        await withCheckedContinuation { waiters.append($0) }
    }

    func release() {
        if waiters.isEmpty {
            available += 1
        } else {
            waiters.removeFirst().resume()
        }
    }
}
