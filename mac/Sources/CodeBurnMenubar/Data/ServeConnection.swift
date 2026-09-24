import Darwin
import Foundation

/// A resident `codeburn serve --stdio` child, held so payload fetches skip the
/// per-spawn cost (node boot + a 100MB+ session-cache parse on large corpora,
/// seconds per fetch at the CLI level). Requests are JSON lines `{id, args}`;
/// replies are `{id, ok, output}`. Mirrors the desktop app's client contract:
///
/// - Only `status` payload queries route here; anything else spawns as before.
/// - The first real status request is also the warm-up. It may be written
///   before the child announces READY; the pipe buffers it until serve reads
///   stdin, avoiding a second one-shot process that parses the same cache.
/// - Transport/protocol failures fall back to the spawn path for that call;
///   resource-policy failures remain terminal. Three child deaths disable
///   serve for this app run.
/// - The child's stdin closing (app quit, even SIGKILL) ends the server loop
///   on the CLI side, so no orphan survives the menubar.
/// - A child with nothing to do for `idleSeconds` retires and gives its memory
///   back; the next request respawns it lazily through `ensureStarted()`.
actor ServeConnection {
    static let shared = ServeConnection()

    typealias ProcessFactory = ([String], QualityOfService) -> Process
    typealias TimeoutSleep = @Sendable (UInt64) async throws -> Void

    private struct QueuedRequest {
        let token: Int
        let args: [String]
        let continuation: CheckedContinuation<Data, Error>
    }

    private struct ActiveRequest {
        let token: Int
        let id: Int
        let args: [String]
        let child: Process
    }

    private var process: Process?
    private var stdinHandle: FileHandle?
    /// Permanent refusal (explicit shutdown, or a binary that cannot be spawned
    /// at all). Distinct from a spent death budget, which recovers with time.
    private var disabled = false
    private var lastDeathAt: Date?
    private var nextId = 1
    private var nextRequestToken = 1
    private var queuedRequests: [QueuedRequest] = []
    private var activeRequest: ActiveRequest?
    private var pending: [Int: CheckedContinuation<Data, Error>] = [:]
    private var requestTimeouts: [Int: Task<Void, Never>] = [:]
    private var requestCeilings: [Int: Task<Void, Never>] = [:]
    /// Silence window of the in-flight request, so any frame carrying its id can
    /// re-arm the same budget. See `CLIWatchdog`.
    private var requestSilence: [Int: UInt64] = [:]
    private var timeoutOwners: [Int: Process] = [:]
    private var responseBytes: [Int: Int] = [:]
    private var deaths = 0
    private var buffer = Data()
    private var receivedTerminalResponse = false
    private var outputTasks: [ObjectIdentifier: Task<Void, Never>] = [:]
    private var terminationTasks: [ObjectIdentifier: Task<Void, Never>] = [:]
    /// At most one armed idle-retire timer. Re-armed after every quiet moment,
    /// cancelled the instant a request is admitted.
    private var idleTask: Task<Void, Never>?
    private let makeProcess: ProcessFactory
    private let timeoutSleep: TimeoutSleep
    private let terminationGraceSleep: TimeoutSleep
    private let idleSleep: TimeoutSleep
    private let idleSeconds: Double
    private let responseLimitBytes: Int
    private let pidFile: URL

    private static let maxDeaths = 3
    static let maxResponseBytes = 16 * 1024 * 1024
    private static let stdoutReadChunkBytes = 64 * 1024
    private static let terminationGraceNanoseconds = nanoseconds(CLIWatchdog.killGraceSeconds)
    /// Absolute backstop per request: a child that heartbeats forever without
    /// ever answering is still reaped.
    private static let requestCeilingNanoseconds = nanoseconds(CLIWatchdog.ceilingSeconds)
    /// The death budget is spent by a transient cause as easily as a permanent
    /// one (a cold-cache pile-up spends all three in a minute). Let a later tick
    /// try again instead of leaving the resident dead for the whole app run.
    private static let deathBudgetResetSeconds: TimeInterval = 300
    /// Quiet period after which the resident is retired and its ~1GB RSS given
    /// back; the next request respawns it through `ensureStarted()`.
    ///
    /// Deliberately much longer than the slowest background tick (300s, and
    /// `UsageDataChangeGuard` can skip ticks for up to 5 minutes). At a shorter
    /// window every background tick during a coding session would be a cold
    /// respawn — ~1.7s and ~2.5 CPU-seconds each — which trades energy for
    /// memory. At 900s ticks keep the child warm while work is happening (the worst
    /// gap between real requests is about 600s in Low Power Mode) and it
    /// only goes away once the user has genuinely stopped.
    static let defaultIdleSeconds: Double = 900
    /// Calibration knob for a signed build: 0 or negative keeps the child
    /// resident forever (the pre-retire behavior).
    static let idleSecondsDefaultsKey = "CodeBurnServeIdleSeconds"

    static func configuredIdleSeconds() -> Double {
        let defaults = UserDefaults.standard
        guard defaults.object(forKey: idleSecondsDefaultsKey) != nil else { return defaultIdleSeconds }
        return defaults.double(forKey: idleSecondsDefaultsKey)
    }

    private static func nanoseconds(_ seconds: Double) -> UInt64 {
        UInt64(seconds * 1_000_000_000)
    }

    struct ServeUnavailable: Error {}
    enum FailureReason: Sendable, Equatable {
        case generic
        case outputTooLarge
    }
    struct ServeRequestFailed: Error, Sendable {
        let message: String
        let reason: FailureReason

        init(message: String, reason: FailureReason = .generic) {
            self.message = message
            self.reason = reason
        }
    }

    init(
        // First so tests, which all pass `makeProcess`, cannot silently inherit
        // the real user cache directory.
        pidFile: URL = ServeOrphanReaper.pidFileURL(),
        makeProcess: @escaping ProcessFactory = CodeburnCLI.makeProcess,
        timeoutSleep: @escaping TimeoutSleep = { nanoseconds in
            try await Task<Never, Never>.sleep(nanoseconds: nanoseconds)
        },
        terminationGraceSleep: @escaping TimeoutSleep = { nanoseconds in
            try await Task<Never, Never>.sleep(nanoseconds: nanoseconds)
        },
        responseLimitBytes: Int = ServeConnection.maxResponseBytes,
        idleSeconds: Double = ServeConnection.configuredIdleSeconds(),
        idleSleep: @escaping TimeoutSleep = { nanoseconds in
            try await Task<Never, Never>.sleep(nanoseconds: nanoseconds)
        }
    ) {
        self.pidFile = pidFile
        self.makeProcess = makeProcess
        self.timeoutSleep = timeoutSleep
        self.terminationGraceSleep = terminationGraceSleep
        self.idleSeconds = idleSeconds
        self.idleSleep = idleSleep
        precondition(responseLimitBytes > 0)
        self.responseLimitBytes = responseLimitBytes
    }

    static func isEligible(_ subcommand: [String]) -> Bool {
        subcommand.first == "status"
    }

    /// Kick the child off (idempotent). Called from app startup and again by
    /// the first request in case the startup task has not run yet.
    ///
    /// Re-entry: a spent death budget is a cooldown, not a life sentence. The
    /// budget's job is to stop a crash loop from spawning a child per tick; once
    /// `deathBudgetResetSeconds` have passed with no new death, the next tick
    /// gets a fresh budget instead of leaving every fetch on the one-shot path
    /// for the rest of the app run.
    func ensureStarted() {
        guard !disabled, process == nil else { return }
        if deaths >= Self.maxDeaths {
            guard let lastDeathAt,
                  Date().timeIntervalSince(lastDeathAt) >= Self.deathBudgetResetSeconds else { return }
            deaths = 0
        }
        // Before adding a child, clear the one a crashed previous run (or an
        // earlier generation of this one) left behind. Idempotent: the recorded
        // pid is only signalled if it is still that exact serve command.
        ServeOrphanReaper.reap(at: pidFile)
        // This single resident serves both background and user-visible status
        // requests. Its cold hydration replaces the old interactive one-shot,
        // so keep the child at the same user-initiated QoS as visible fetches.
        let child = makeProcess(["serve", "--stdio"], .userInitiated)
        // Progress frames are what re-arm this connection's no-output watchdog
        // during a cold hydration; without them serve is silent for minutes.
        child.environment = CLIWatchdog.withProgressHeartbeat(child.environment)
        let stdinPipe = Pipe()
        let stdinWriter = stdinPipe.fileHandleForWriting
        // Suppress SIGPIPE only for this connection's write end. A process-wide
        // SIG_IGN leaks into unrelated libraries and children; F_SETNOSIGPIPE
        // keeps a closed child stdin on the normal throwable EPIPE path.
        guard Darwin.fcntl(stdinWriter.fileDescriptor, F_SETNOSIGPIPE, 1) == 0 else {
            disabled = true
            NSLog("CodeBurn: resident CLI disabled for this app run — could not suppress SIGPIPE on the child's stdin; every refresh now spawns a cold CLI")
            return
        }
        let stdoutPipe = Pipe()
        let stdoutReader = stdoutPipe.fileHandleForReading
        child.standardInput = stdinPipe
        child.standardOutput = stdoutPipe
        child.standardError = FileHandle.nullDevice
        do {
            try child.run()
        } catch {
            disabled = true // spawn path can't produce the binary either better than makeProcess did
            // Domain and code only: a Process launch error carries the path it
            // tried, and the unified log is not the place for it.
            let failure = error as NSError
            NSLog("CodeBurn: resident CLI disabled for this app run — the serve child failed to launch (%@ %ld); every refresh now spawns a cold CLI", failure.domain, failure.code)
            return
        }
        process = child
        stdinHandle = stdinWriter
        ServeChildRegistry.shared.add(child)
        // Record the argv WITHOUT the `/usr/bin/env --` prefix: that is the part
        // exec rewrites away before `ps` can see it. See serveCommandMatches.
        ServeOrphanReaper.record(
            at: pidFile,
            pid: child.processIdentifier,
            command: (child.arguments ?? []).drop(while: { $0 == "--" }).joined(separator: " ")
        )
        let generation = ObjectIdentifier(child)
        // One blocking reader owns this generation's stdout. It never reads a
        // second bounded chunk until the actor has consumed the first, giving
        // the 16 MiB protocol limit real backpressure instead of accumulating
        // an unbounded callback/AsyncStream backlog. EOF is observed only after
        // the pipe's final bytes, so child death cannot overtake a split reply.
        outputTasks[generation] = Task.detached { [weak self] in
            var bytes = [UInt8](repeating: 0, count: Self.stdoutReadChunkBytes)
            while !Task.isCancelled {
                let count = Darwin.read(stdoutReader.fileDescriptor, &bytes, bytes.count)
                if count > 0 {
                    guard let self else { break }
                    await self.consume(Data(bytes[0..<count]), from: child)
                } else if count == -1, errno == EINTR {
                    continue
                } else {
                    break
                }
            }
            await self?.outputStreamEnded(for: child)
            await self?.outputStreamFinished(for: child)
        }
        // Covers the eager start at app launch: a child nobody ever asks
        // anything of must still be able to go away.
        armIdleRetireIfQuiet()
    }

    /// Send the first real payload through the resident child. A request does
    /// not need to wait for the READY frame: stdin is safe to write as soon as
    /// Process.run() succeeds, and serve serializes it after initialization.
    func request(args: [String]) async throws -> Data {
        try Task.checkCancellation()
        ensureStarted()
        guard process != nil else { throw ServeUnavailable() }
        let token = nextRequestToken
        nextRequestToken += 1
        let response = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                queuedRequests.append(QueuedRequest(
                    token: token,
                    args: args,
                    continuation: continuation
                ))
                startNextRequestIfPossible()
            }
        } onCancel: {
            Task { await self.cancelRequest(token: token) }
        }
        try Task.checkCancellation()
        return response
    }

    func shutdown() {
        disabled = true
        deaths = Self.maxDeaths
        cancelIdleRetire()
        for task in terminationTasks.values { task.cancel() }
        terminationTasks.removeAll()
        cancelAllTimeouts()
        failAllRequests()
        try? stdinHandle?.close()
        process = nil
        stdinHandle = nil
        buffer = Data()
        receivedTerminalResponse = false
        // Deliberately harder than every other kill path, and covering RETIRED
        // generations too: quit has no budget to wait a SIGTERM grace out, and
        // the grace task dies with the app, so a child that defers SIGTERM (a
        // node process mid-synchronous-parse does) would outlive us. A refresh
        // lock left behind by SIGKILL self-heals through the next parse's
        // dead-pid takeover (src/cache-refresh-lock.ts).
        ServeChildRegistry.shared.reapAll()
    }

    /// Test seam: from outside, a retired generation and one that was never
    /// started look identical (no child), so the retire tests need this.
    var residentChildForTesting: Process? { process }

    // MARK: - internals

    private func startNextRequestIfPossible() {
        guard activeRequest == nil, !queuedRequests.isEmpty else { return }
        ensureStarted()
        guard let stdinHandle, let child = process else {
            failQueuedRequests(error: ServeUnavailable())
            return
        }
        // A Process can report not-running just before its termination callback
        // reaches the ordered event stream. Keep the request queued for that
        // event instead of writing to a generation which is already exiting.
        guard child.isRunning else { return }

        let request = queuedRequests.removeFirst()
        let id = nextId
        nextId += 1
        let line: Data
        do {
            line = try JSONSerialization.data(withJSONObject: ["id": id, "args": request.args])
        } catch {
            request.continuation.resume(throwing: error)
            startNextRequestIfPossible()
            return
        }

        // The previous response can resume its caller just before EOF reaches
        // this actor. Avoid admitting a successor to an already-reaped child;
        // the reader's ordered EOF path will start it on a replacement.
        guard child.isRunning else {
            queuedRequests.insert(request, at: 0)
            outputStreamEnded(for: child)
            return
        }

        // Select and arm the timeout only when this request becomes the sole
        // protocol request in flight. A queued request must not spend its own
        // budget while its predecessor is still hydrating or draining. The
        // budget bounds SILENCE: every frame carrying this id restarts it.
        let timeoutNanoseconds = Self.nanoseconds(CLIWatchdog.silenceWindow(warm: receivedTerminalResponse))
        cancelIdleRetire()
        activeRequest = ActiveRequest(
            token: request.token,
            id: id,
            args: request.args,
            child: child
        )
        pending[id] = request.continuation
        responseBytes[id] = 0
        do {
            try stdinHandle.write(contentsOf: line + Data("\n".utf8))
            armTimeout(id: id, child: child, nanoseconds: timeoutNanoseconds)
        } catch {
            // The previous terminal frame can resume its caller just before
            // EOF detaches that generation. Preserve this never-admitted
            // request and retry it on the replacement instead of surfacing a
            // transient EPIPE to the UI.
            pending.removeValue(forKey: id)
            responseBytes.removeValue(forKey: id)
            activeRequest = nil
            queuedRequests.insert(request, at: 0)
            outputStreamEnded(for: child)
        }
    }

    private func cancelRequest(token: Int) {
        if let index = queuedRequests.firstIndex(where: { $0.token == token }) {
            let request = queuedRequests.remove(at: index)
            request.continuation.resume(throwing: CancellationError())
            return
        }
        guard let activeRequest, activeRequest.token == token,
              let continuation = pending.removeValue(forKey: activeRequest.id) else { return }
        continuation.resume(throwing: CancellationError())
        // Caller cancellation abandons only this response. The serialized serve
        // child may still be doing the expensive first hydration, and killing it
        // here lets tab switches and UI watchdogs restart that work indefinitely.
        // Its independent request timeout remains armed: a command that never
        // returns is still reaped, so it cannot wedge every later serialized call.
    }

    private func armTimeout(id: Int, child: Process, nanoseconds: UInt64) {
        timeoutOwners[id] = child
        requestSilence[id] = nanoseconds
        armSilenceTimer(id: id, nanoseconds: nanoseconds)
        // Deliberately a real sleep, not `timeoutSleep`: the ceiling is a
        // 15-minute backstop behind the injected silence budget, and routing it
        // through the same seam would make every test's timeout ledger carry it.
        // Its arithmetic is covered by CLIWatchdog.verdict.
        requestCeilings[id] = Task.detached { [weak self] in
            do {
                try await Task<Never, Never>.sleep(nanoseconds: Self.requestCeilingNanoseconds)
            } catch {
                return
            }
            await self?.requestTimedOut(id: id)
        }
    }

    private func armSilenceTimer(id: Int, nanoseconds: UInt64) {
        let sleep = timeoutSleep
        requestTimeouts[id]?.cancel()
        requestTimeouts[id] = Task.detached { [weak self] in
            do {
                try await sleep(nanoseconds)
            } catch {
                return
            }
            await self?.requestTimedOut(id: id)
        }
    }

    /// Any frame carrying this request's id is proof of life: restart its
    /// watchdog so a long cold parse that heartbeats progress is never killed
    /// mid-flight. The absolute ceiling is untouched.
    private func touchRequest(id: Int) {
        guard let nanoseconds = requestSilence[id] else { return }
        armSilenceTimer(id: id, nanoseconds: nanoseconds)
    }

    private func requestTimedOut(id: Int) {
        guard let child = timeoutOwners.removeValue(forKey: id) else { return }
        requestTimeouts.removeValue(forKey: id)
        responseBytes.removeValue(forKey: id)
        if let continuation = pending.removeValue(forKey: id) {
            continuation.resume(throwing: ServeRequestFailed(message: "serve timeout"))
        }
        // The waiter may already have been abandoned by caller cancellation.
        // Timeout ownership is deliberately independent of that continuation:
        // kill only the exact generation that received the timed-out request.
        guard process === child else {
            if activeRequest?.id == id { activeRequest = nil }
            startNextRequestIfPossible()
            // Only a stale generation timed out; the live child survived this
            // failure and is now idle again.
            armIdleRetireIfQuiet()
            return
        }
        // Retire the timed-out generation synchronously. Its stdout may never
        // reach EOF (for example, a stuck child can ignore SIGTERM or a
        // descendant can retain the pipe), so waiting for the reader would also
        // spend every queued caller's timeout before it can even be admitted.
        retireCurrentGeneration()
        if activeRequest?.id == id { activeRequest = nil }
        cancelTimeouts(ownedBy: child)
        terminateTimedOutChild(child)
        // The waiter was removed above and cannot be requeued by stale EOF.
        // A queued read starts on a replacement immediately, subject to the
        // ordinary three-death budget.
        startNextRequestIfPossible()
    }

    private func cancelTimeout(id: Int) {
        timeoutOwners.removeValue(forKey: id)
        requestTimeouts.removeValue(forKey: id)?.cancel()
        requestCeilings.removeValue(forKey: id)?.cancel()
        requestSilence.removeValue(forKey: id)
        responseBytes.removeValue(forKey: id)
    }

    private func cancelTimeouts(ownedBy child: Process) {
        let ids = timeoutOwners.compactMap { id, owner in owner === child ? id : nil }
        for id in ids { cancelTimeout(id: id) }
    }

    private func cancelAllTimeouts() {
        for task in requestTimeouts.values { task.cancel() }
        requestTimeouts.removeAll()
        for task in requestCeilings.values { task.cancel() }
        requestCeilings.removeAll()
        requestSilence.removeAll()
        timeoutOwners.removeAll()
        responseBytes.removeAll()
    }

    /// Detach the current generation. Closing our end of its stdin is the app's
    /// half of "stdin closing ends the server loop": dropping the FileHandle is
    /// NOT enough, because the Pipe stays alive inside `child.standardInput` for
    /// as long as this generation's reader or termination task holds the
    /// Process, so the write end stays open and the retired child never sees
    /// EOF. That is how a retired-but-alive serve child becomes an orphan.
    private func retireCurrentGeneration(countsAsDeath: Bool = true) {
        try? stdinHandle?.close()
        process = nil
        stdinHandle = nil
        buffer = Data()
        receivedTerminalResponse = false
        guard countsAsDeath else { return }
        deaths += 1
        lastDeathAt = Date()
    }

    /// Hand the resident's memory back after `idleSeconds` of no work. Not a
    /// death: the budget and its cooldown are untouched, so retiring all day
    /// never costs the connection a life or delays a real crash's recovery.
    private func retireForIdle() {
        idleTask = nil
        guard activeRequest == nil, queuedRequests.isEmpty, let child = process else { return }
        retireCurrentGeneration(countsAsDeath: false)
        cancelTimeouts(ownedBy: child)
        flushThenTerminate(child)
    }

    /// Let a deliberately retired child exit on its own first. `retireCurrentGeneration`
    /// has just closed our end of its stdin, and EOF is what makes `serve --stdio`
    /// publish its coalesced shard window before exiting. SIGTERM in the same hop
    /// kills that flush: the CLI catches it only to unlink its cache lock and then
    /// re-raises (src/session-cache.ts). So wait out one grace and signal only a
    /// child that is still running — reusing `terminationTasks`, so `shutdown()`
    /// cancels this exactly like the termination grace it replaces and stays bounded.
    private func flushThenTerminate(_ child: Process) {
        guard child.isRunning else {
            ServeChildRegistry.shared.remove(child)
            return
        }
        let generation = ObjectIdentifier(child)
        let sleep = terminationGraceSleep
        terminationTasks[generation] = Task.detached { [weak self] in
            do {
                try await sleep(Self.terminationGraceNanoseconds)
            } catch {
                // Cancelled: either shutdown (which must not orphan a child that
                // is ignoring EOF) or the child already died and its stream
                // finished. Escalate either way; the isRunning guard inside makes
                // the dead-child case a no-op.
                await self?.forceKillAfterGrace(child)
                return
            }
            await self?.terminateAfterFlushGrace(child)
        }
    }

    private func terminateAfterFlushGrace(_ child: Process) {
        terminationTasks.removeValue(forKey: ObjectIdentifier(child))
        // Exited on its own inside the grace: it flushed, nothing left to signal.
        guard child.isRunning else {
            ServeChildRegistry.shared.remove(child)
            return
        }
        terminateTimedOutChild(child)
    }

    /// Re-arm the idle window after every moment the connection falls quiet.
    /// One task at a time; a sleeping Task costs nothing, a polling timer would.
    private func armIdleRetireIfQuiet() {
        cancelIdleRetire()
        guard idleSeconds > 0, !disabled, process != nil,
              activeRequest == nil, queuedRequests.isEmpty else { return }
        let sleep = idleSleep
        let nanoseconds = Self.nanoseconds(idleSeconds)
        idleTask = Task { [weak self] in
            do {
                try await sleep(nanoseconds)
            } catch {
                return
            }
            // A cancellation that lands after the sleep has already returned is
            // caught by retireForIdle's own quiet check, not here.
            await self?.retireForIdle()
        }
    }

    private func cancelIdleRetire() {
        idleTask?.cancel()
        idleTask = nil
    }

    private func outputStreamFinished(for child: Process) {
        outputTasks.removeValue(forKey: ObjectIdentifier(child))
        if !child.isRunning {
            terminationTasks.removeValue(forKey: ObjectIdentifier(child))?.cancel()
            ServeChildRegistry.shared.remove(child)
        }
    }

    private func terminateTimedOutChild(_ child: Process) {
        guard child.isRunning else { return }
        child.terminate()
        let generation = ObjectIdentifier(child)
        let sleep = terminationGraceSleep
        terminationTasks[generation] = Task.detached { [weak self] in
            do {
                try await sleep(Self.terminationGraceNanoseconds)
            } catch {
                // Cancellation means the owner stopped waiting: either shutdown
                // (which must not orphan a SIGTERM-ignoring generation) or the
                // child already died and the stream finished. Escalate either
                // way; the isRunning guard makes the dead-child case a no-op.
                await self?.forceKillAfterGrace(child)
                return
            }
            await self?.forceKillAfterGrace(child)
        }
    }

    private func forceKillAfterGrace(_ child: Process) {
        terminationTasks.removeValue(forKey: ObjectIdentifier(child))
        guard child.isRunning else {
            ServeChildRegistry.shared.remove(child)
            return
        }
        _ = Darwin.kill(child.processIdentifier, SIGKILL)
        ServeChildRegistry.shared.remove(child)
    }

    private func outputStreamEnded(for child: Process) {
        guard process === child else { return }
        // EOF/read failure is a transport death even if the process has not
        // reaped yet. Terminate that exact generation so a child which closed
        // stdout cannot survive after the actor starts its replacement, and
        // escalate: SIGTERM alone is deferred by a node child that is inside a
        // synchronous parse when it arrives.
        childDied(child)
        terminateTimedOutChild(child)
    }

    // Internal so the generation guard can be exercised deterministically by
    // tests without relying on Foundation callback scheduling at process exit.
    func consume(_ data: Data, from child: Process) {
        // A readability callback can already have queued its actor Task when the
        // old process exits. If a replacement starts first, those late bytes must
        // not repopulate the shared line buffer or mark the new child as warm.
        guard process === child else { return }
        var remaining = data[data.startIndex..<data.endIndex]
        while !remaining.isEmpty {
            if let newline = remaining.firstIndex(of: UInt8(ascii: "\n")) {
                let fragment = remaining[remaining.startIndex..<newline]
                guard fragment.count <= responseLimitBytes - buffer.count else {
                    outputOverflowed(child)
                    return
                }
                buffer.append(contentsOf: fragment)
                let lineData = buffer
                buffer = Data()
                consumeLine(lineData, from: child)
                guard process === child else { return }
                remaining = remaining[remaining.index(after: newline)..<remaining.endIndex]
            } else {
                guard remaining.count <= responseLimitBytes - buffer.count else {
                    outputOverflowed(child)
                    return
                }
                buffer.append(contentsOf: remaining)
                return
            }
        }
    }

    private func consumeLine(_ lineData: Data, from child: Process) {
        guard !lineData.isEmpty,
              let object = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any] else { return }
            if object["ready"] as? Bool == true {
                return
            }
            guard let id = object["id"] as? Int,
                  responseBytes[id] != nil else { return }
            // Desktop asks serve to stream cold-scan stderr as progress frames.
            // Menubar has no progress UI, but must leave the request pending
            // until the terminal response arrives if such a frame is emitted.
            if let progress = object["progress"] as? String {
                // Proof of life for a request still being worked on: restart its
                // silence window. A terminal frame does not need this - it
                // cancels the timers outright a few lines down.
                touchRequest(id: id)
                guard accountResponseBytes(Data(progress.utf8).count, id: id, child: child) else { return }
                return
            }
            let succeeded = object["ok"] as? Bool == true
            let payload = succeeded
                ? (object["output"] as? String)
                : (object["error"] as? String)
            if let payload {
                guard accountResponseBytes(Data(payload.utf8).count, id: id, child: child) else { return }
            }
            // A refused/failed command can finish before any cache hydration.
            // Only a successful terminal proves the resident is warm. Keep
            // this before the waiter lookup so a successful orphan response
            // still records the child as warm without resuming anything.
            if succeeded { receivedTerminalResponse = true }
            cancelTimeout(id: id)
            let continuation = pending.removeValue(forKey: id)
            if activeRequest?.id == id { activeRequest = nil }
            if let continuation {
                if succeeded, let output = object["output"] as? String {
                    continuation.resume(returning: Data(output.utf8))
                } else {
                    let message = object["error"] as? String ?? "serve request failed"
                    continuation.resume(throwing: ServeRequestFailed(message: message))
                }
            }
            // This also advances after an orphan terminal response whose caller
            // was cancelled: cancellation removes only the waiter, not the
            // active protocol lifecycle.
            startNextRequestIfPossible()
            armIdleRetireIfQuiet()
    }

    private func accountResponseBytes(_ count: Int, id: Int, child: Process) -> Bool {
        guard let current = responseBytes[id],
              count <= responseLimitBytes - current else {
            outputOverflowed(child)
            return false
        }
        responseBytes[id] = current + count
        return true
    }

    private func outputOverflowed(_ child: Process) {
        guard process === child else { return }
        // Detach this exact generation before terminating it. Its eventual exit
        // and any already-scheduled stdout callbacks are then stale and cannot
        // consume a second death or corrupt a replacement generation.
        retireCurrentGeneration()
        cancelTimeouts(ownedBy: child)
        failAllRequests(error: ServeRequestFailed(
            message: "serve output exceeded \(responseLimitBytes) bytes",
            reason: .outputTooLarge
        ))
        terminateTimedOutChild(child)
    }

    private func childDied(_ child: Process) {
        guard process === child else { return }
        retireCurrentGeneration()
        cancelTimeouts(ownedBy: child)
        if let activeRequest, activeRequest.child === child {
            if let continuation = pending.removeValue(forKey: activeRequest.id) {
                // Only read-only status requests enter this connection. If a
                // generation exits after admission but before its terminal
                // reply, retain the waiter and retry on the replacement rather
                // than racing it into a one-shot fallback. A timed-out or
                // cancelled waiter is already absent and is never retried.
                queuedRequests.insert(QueuedRequest(
                    token: activeRequest.token,
                    args: activeRequest.args,
                    continuation: continuation
                ), at: 0)
            }
            self.activeRequest = nil
        }
        // Requests which were never written survive an ordinary child crash.
        // They begin on a replacement only after this ordered death event.
        startNextRequestIfPossible()
    }

    private func failAllRequests(
        error: Error = ServeRequestFailed(message: "serve exited")
    ) {
        for (_, continuation) in pending {
            continuation.resume(throwing: error)
        }
        pending.removeAll()
        activeRequest = nil
        failQueuedRequests(error: error)
    }

    private func failQueuedRequests(error: Error) {
        let requests = queuedRequests
        queuedRequests.removeAll()
        for request in requests {
            request.continuation.resume(throwing: error)
        }
    }
}

/// Best-effort reap of a serve child orphaned by a previous run: a crash leaves
/// no one to close the child's stdin and no `applicationWillTerminate` to reap
/// it. Port of `reapOrphanServe` in app/electron/cli.ts (#1096).
enum ServeOrphanReaper {
    static func pidFileURL() -> URL {
        URL(fileURLWithPath: CodeBurnCacheDirectory.resolve())
            .appendingPathComponent("menubar-serve.pid", isDirectory: false)
    }

    static func record(at url: URL = pidFileURL(), pid: pid_t, command: String) {
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let body = ["pid": Int(pid), "cmd": command] as [String: Any]
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return }
        try? data.write(to: url) // reaping is best-effort
    }

    /// Reads the pid recorded by the previous run and — because pids are
    /// recycled — signals it only after `ps` confirms the process is still that
    /// exact serve child. SIGTERM, never SIGKILL: the orphan may be holding the
    /// cache refresh lock and can release it on the way out.
    static func reap(at url: URL = pidFileURL()) {
        defer { try? FileManager.default.removeItem(at: url) }
        guard let data = try? Data(contentsOf: url),
              let record = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let pid = record["pid"] as? Int,
              let cmd = record["cmd"] as? String,
              pid > 1, pid != Int(ProcessInfo.processInfo.processIdentifier),
              cmd.hasSuffix(serveArgvSuffix),
              serveCommandMatches(recorded: cmd, observed: commandLine(of: pid_t(pid)))
        else { return }
        _ = Darwin.kill(pid_t(pid), SIGTERM)
    }

    /// The tail every `codeburn serve` argv ends with. A record that does not
    /// carry it was not written for a serve child and is never signalled.
    static let serveArgvSuffix = "serve --stdio"

    /// Suffix match on the full recorded argv, not a keyword sniff: any looser
    /// test signals whatever unrelated process inherited the pid.
    ///
    /// Electron can compare exactly because it spawns its own binary. We spawn
    /// through `/usr/bin/env`, and the CLI is a shebang script, so by the time
    /// `ps` sees the process the argv has been rewritten twice: `env -- <cli>
    /// serve --stdio` becomes `node <cli> serve --stdio`. The interpreter
    /// prefix is the only part that varies, so the recorded `<cli> serve
    /// --stdio` has to match as a suffix rather than in full.
    static func serveCommandMatches(recorded: String, observed: String?) -> Bool {
        guard let observed else { return false }
        let normalize = { (value: String) -> String in
            value.split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\n" || $0 == "\"" })
                .joined(separator: " ")
        }
        let wanted = normalize(recorded)
        return !wanted.isEmpty && normalize(observed).hasSuffix(wanted)
    }

    /// `-ww` defeats ps's width truncation; the pid is an integer before it is
    /// passed, and the call never goes through a shell.
    private static func commandLine(of pid: pid_t) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/ps")
        process.arguments = ["-ww", "-o", "command=", "-p", String(pid)]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return nil }
        // readToEnd returns at EOF, which is this short-lived child exiting; no
        // waitUntilExit, which would park the calling thread (see DataClient).
        let data = (try? pipe.fileHandleForReading.readToEnd()) ?? nil
        let text = String(data: data ?? Data(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return text.isEmpty ? nil : text
    }
}

/// Every serve child this app run has started and not yet seen exit, readable
/// WITHOUT an actor hop.
///
/// `applicationWillTerminate` runs `Task { await shutdown() }`, and the app can
/// exit before that task is ever scheduled — so the actor's own reaping is not
/// reachable on the path that matters most. This registry is, and a Process that
/// still reports `isRunning` has not been waited on, so its pid is still ours
/// and cannot have been recycled under us.
final class ServeChildRegistry: @unchecked Sendable {
    static let shared = ServeChildRegistry()

    private let lock = NSLock()
    private var children: [ObjectIdentifier: Process] = [:]

    func add(_ child: Process) {
        lock.lock()
        children[ObjectIdentifier(child)] = child
        lock.unlock()
    }

    func remove(_ child: Process) {
        lock.lock()
        children.removeValue(forKey: ObjectIdentifier(child))
        lock.unlock()
    }

    func reapAll() {
        lock.lock()
        let all = Array(children.values)
        children.removeAll()
        lock.unlock()
        for child in all where child.isRunning {
            _ = Darwin.kill(child.processIdentifier, SIGKILL)
        }
    }
}
