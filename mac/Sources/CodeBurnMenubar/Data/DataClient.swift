import Foundation

/// Upper bound on payload + stderr bytes read from the CLI. Real payloads top out near 500 KB
/// (365 days of history with dozens of models); anything larger is pathological and truncating
/// prevents unbounded memory growth. Hard timeout guards against a hung CLI keeping Process and
/// Pipe file descriptors pinned forever.
private let maxPayloadBytes = 20 * 1024 * 1024
private let maxStderrBytes = 256 * 1024
private let spawnTimeoutSeconds: UInt64 = 60

/// Per-array caps enforced AFTER JSON decoding. The 20 MB byte cap above bounds total memory
/// but a single 20 MB payload could still carry millions of entries in one array and force the
/// decoder to allocate an oversized Swift array. These caps reject payloads whose shape does
/// not match what the CLI legitimately produces, so a malicious or buggy CLI cannot amplify
/// allocations beyond the product's real working set.
private let maxDailyHistoryEntries = 400        // >1 year of daily history
private let maxActivityEntries = 64
private let maxModelEntries = 64
private let maxProviderEntries = 64
private let maxFindingEntries = 64
private let maxDailyTopModelEntries = 64

enum DataClientError: Error {
    case spawn(String)
    case nonZeroExit(code: Int32, stderr: String)
    case decode(Error)
    case timeout
    case outputTooLarge
    case payloadFieldTooLarge(field: String, count: Int, max: Int)
}

/// Runs the CLI via argv (no shell interpretation). See `CodeburnCLI` for why we never route
/// commands through `/bin/zsh -c` anymore.
struct DataClient {
    static func fetch(period: Period, includeOptimize: Bool) async throws -> MenubarPayload {
        var subcommand = [
            "status",
            "--format", "menubar-json",
            "--period", period.cliArg,
        ]
        if !includeOptimize {
            subcommand.append("--no-optimize")
        }

        let result = try await runCLI(subcommand: subcommand)
        guard result.exitCode == 0 else {
            throw DataClientError.nonZeroExit(code: result.exitCode, stderr: result.stderr)
        }
        let payload: MenubarPayload
        do {
            payload = try JSONDecoder().decode(MenubarPayload.self, from: result.stdout)
        } catch {
            throw DataClientError.decode(error)
        }
        try validatePayloadBounds(payload)
        return payload
    }

    /// Rejects a decoded payload whose array fields exceed the expected working-set sizes.
    /// Throws `.payloadFieldTooLarge` with the offending field name so diagnostics stay
    /// informative without leaking any payload contents.
    static func validatePayloadBounds(_ payload: MenubarPayload) throws {
        try enforce("history.daily", payload.history.daily.count, max: maxDailyHistoryEntries)
        try enforce("current.topActivities", payload.current.topActivities.count, max: maxActivityEntries)
        try enforce("current.topModels", payload.current.topModels.count, max: maxModelEntries)
        try enforce("current.providers", payload.current.providers.count, max: maxProviderEntries)
        try enforce("optimize.topFindings", payload.optimize.topFindings.count, max: maxFindingEntries)
        for (index, entry) in payload.history.daily.enumerated() {
            try enforce("history.daily[\(index)].topModels", entry.topModels.count, max: maxDailyTopModelEntries)
        }
    }

    private static func enforce(_ field: String, _ count: Int, max: Int) throws {
        if count > max {
            throw DataClientError.payloadFieldTooLarge(field: field, count: count, max: max)
        }
    }

    private struct ProcessResult {
        let stdout: Data
        let stderr: String
        let exitCode: Int32
    }

    private static func runCLI(subcommand: [String]) async throws -> ProcessResult {
        let process = CodeburnCLI.makeProcess(subcommand: subcommand)

        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe

        do {
            try process.run()
        } catch {
            throw DataClientError.spawn(error.localizedDescription)
        }

        // Drain both pipes concurrently so a large stderr can't deadlock stdout (the child
        // blocks on write once the pipe buffer fills). `drain` also enforces a byte cap.
        async let stdoutData = drain(outPipe.fileHandleForReading, limit: maxPayloadBytes)
        async let stderrData = drain(errPipe.fileHandleForReading, limit: maxStderrBytes)

        // Wall-clock timeout: if the CLI hangs (parser stuck, disk stall), kill it.
        let timeoutTask = Task.detached(priority: .utility) {
            try? await Task.sleep(nanoseconds: spawnTimeoutSeconds * 1_000_000_000)
            if process.isRunning {
                process.terminate()
            }
        }
        defer { timeoutTask.cancel() }

        let (out, err) = await (stdoutData, stderrData)
        process.waitUntilExit()

        if out.count >= maxPayloadBytes {
            throw DataClientError.outputTooLarge
        }

        let stderrString = String(data: err, encoding: .utf8) ?? ""
        return ProcessResult(stdout: out, stderr: stderrString, exitCode: process.terminationStatus)
    }

    /// Pulls bytes off a pipe until EOF or `limit`. Intentionally uses `availableData`, which
    /// returns empty on EOF -- no blocking once the child exits.
    private static func drain(_ handle: FileHandle, limit: Int) async -> Data {
        await Task.detached(priority: .utility) {
            var buffer = Data()
            while buffer.count < limit {
                let chunk = handle.availableData
                if chunk.isEmpty { break }
                let remaining = limit - buffer.count
                if chunk.count > remaining {
                    buffer.append(chunk.prefix(remaining))
                    break
                }
                buffer.append(chunk)
            }
            return buffer
        }.value
    }
}
