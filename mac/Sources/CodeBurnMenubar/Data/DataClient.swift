import Foundation

/// Upper bound on payload + stderr bytes read from the CLI. Real payloads top out near 500 KB
/// (365 days of history with dozens of models); anything larger is pathological and truncating
/// prevents unbounded memory growth. Hard timeout guards against a hung CLI keeping Process and
/// Pipe file descriptors pinned forever.
private let maxPayloadBytes = 20 * 1024 * 1024
private let maxStderrBytes = 256 * 1024
private let spawnTimeoutSeconds: UInt64 = 45

enum DataClientError: Error {
    case spawn(String)
    case nonZeroExit(code: Int32, stderr: String)
    case decode(Error)
    case timeout
    case outputTooLarge
}

/// Runs the CLI via argv (no shell interpretation). See `CodeburnCLI` for why we never route
/// commands through `/bin/zsh -c` anymore.
struct DataClient {
    static func fetch(period: Period, day: String?, provider: ProviderFilter, includeOptimize: Bool) async throws -> MenubarPayload {
        var subcommand = [
            "status",
            "--format", "menubar-json",
            "--provider", provider.cliArg,
        ]
        if let day {
            subcommand.append(contentsOf: ["--day", day])
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
            throw DataClientError.decode(error)
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

        let timeoutTask = Task.detached(priority: .utility) {
            try? await Task.sleep(nanoseconds: spawnTimeoutSeconds * 1_000_000_000)
            if process.isRunning {
                NSLog("CodeBurn: CLI subprocess timed out after %llus for %@ — terminating",
                      spawnTimeoutSeconds, subcommand.joined(separator: " "))
                terminateWithEscalation(process)
            }
        }
        defer { timeoutTask.cancel() }

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
        process.waitUntilExit()

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
}
