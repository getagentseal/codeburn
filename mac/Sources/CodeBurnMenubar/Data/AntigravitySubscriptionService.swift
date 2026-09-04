import Foundation

/// Live quota snapshot for Antigravity. The local language server reports
/// per-group quota buckets (summary payload) or flat per-model rows (legacy
/// GetUserStatus payload) as fractions REMAINING; windows render percent
/// USED, so `usedPercent` is the inverted value. `details` is sorted
/// most-constrained first so `primary` is the window that throttles soonest.
struct AntigravityUsage: Sendable, Equatable {
    struct Window: Sendable, Equatable {
        /// "Group · Bucket" (summary) or model name (legacy status payload).
        let label: String
        let usedPercent: Double   // 0.0 ... 100.0
        /// Only the legacy status payload carries reset times.
        let resetsAt: Date?
    }

    /// Per-group/per-model windows, most-constrained first.
    let details: [Window]
    var primary: Window? { details.first }
    /// Plan label from the legacy GetUserStatus payload (summary payloads
    /// carry none).
    let plan: String?
    let fetchedAt: Date
}

/// Live Antigravity quota from LOCAL surfaces only — the Antigravity app's own
/// language server or a signed-in `agy` CLI's embedded server, derived from
/// observed Antigravity client traffic. This protocol is internal
/// and experimental). No Google OAuth fallback: when no local server answers,
/// the provider reports disconnected and the UI shows its Connect affordance.
///
/// Endpoints (loopback only, Connect-RPC JSON):
/// - POST https://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary
///     (preferred; falls back to)
/// - POST https://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/GetUserStatus
///
/// Discovery uses `ps` to find candidate processes (app language
/// servers need their `--csrf_token`; the `agy` CLI needs none), then `lsof`
/// lists each pid's listening TCP ports. Local HTTPS uses a self-signed cert,
/// so TLS verification is relaxed ONLY for the 127.0.0.1 loopback probes —
/// see LoopbackTrustDelegate.
enum AntigravitySubscriptionService {
    private static let summaryPath = "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary"
    private static let statusPath = "/exa.language_server_pb.LanguageServerService/GetUserStatus"
    private static let localTimeoutSeconds: TimeInterval = 3

    enum FetchError: Error, LocalizedError {
        /// No running language server answered any port probe. This is the
        /// routine "app not running" state, not an error — the UI shows the
        /// Connect affordance.
        case disconnected
        /// Unexpected discovery failure (e.g. `ps` blew up). Transient: the
        /// next cadence tick retries.
        case network(Error)

        var errorDescription: String? {
            switch self {
            case .disconnected:
                return L("No running Antigravity language server found. Start the Antigravity app, then click Reconnect.")
            case let .network(err):
                return L("Local probe failed: \(err.localizedDescription)")
            }
        }
    }

    // MARK: - Injectable seams (tests drive fixtures through these)

    struct Deps: Sendable {
        /// Runs a local discovery tool and returns stdout. Live: `ps`/`lsof`
        /// via Process.
        var exec: @Sendable (_ executable: String, _ arguments: [String]) async throws -> String
        /// POSTs the Connect-RPC probe to 127.0.0.1:<port>. Nil means
        /// timeout / transport error — the probe simply moves on.
        var request: @Sendable (_ port: Int, _ tls: Bool, _ path: String, _ body: String, _ csrf: String?) async -> (status: Int, text: String)?
        var now: @Sendable () -> Date
        /// Log sink for sanitized diagnostics; tests capture it.
        var log: @Sendable (String) -> Void

        static let live = Deps(
            exec: { executable, arguments in
                let process = Process()
                process.executableURL = URL(fileURLWithPath: executable)
                process.arguments = arguments
                let result = try await DataClient.runProcess(
                    process,
                    timeoutSeconds: 10,
                    label: "antigravity \(executable.components(separatedBy: "/").last ?? executable)"
                )
                return String(decoding: result.stdout, as: UTF8.self)
            },
            request: { port, tls, path, body, csrf in
                guard let url = URL(string: "\(tls ? "https" : "http")://127.0.0.1:\(port)\(path)") else { return nil }
                var request = URLRequest(url: url)
                request.httpMethod = "POST"
                request.timeoutInterval = localTimeoutSeconds
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.setValue("1", forHTTPHeaderField: "Connect-Protocol-Version")
                if let csrf {
                    request.setValue(csrf, forHTTPHeaderField: "X-Codeium-Csrf-Token")
                }
                request.httpBody = Data(body.utf8)
                do {
                    let (data, response) = try await AntigravitySubscriptionService.loopbackSession.data(for: request)
                    guard let http = response as? HTTPURLResponse else { return nil }
                    return (http.statusCode, String(decoding: data, as: UTF8.self))
                } catch {
                    return nil
                }
            },
            now: { Date() },
            log: { NSLog("%@", $0) }
        )
    }

    /// TLS trust override scoped to the loopback probes ONLY: the Antigravity
    /// language server serves a self-signed cert, so a server-trust challenge
    /// from 127.0.0.1 is accepted as presented. Every other host (this
    /// session is never pointed at one) and every non-server-trust challenge
    /// gets default handling — TLS is never relaxed off-loopback.
    private final class LoopbackTrustDelegate: NSObject, URLSessionDelegate, @unchecked Sendable {
        func urlSession(
            _ session: URLSession,
            didReceive challenge: URLAuthenticationChallenge,
            completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
        ) {
            let space = challenge.protectionSpace
            guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust,
                  space.host == "127.0.0.1",
                  let trust = space.serverTrust else {
                completionHandler(.performDefaultHandling, nil)
                return
            }
            completionHandler(.useCredential, URLCredential(trust: trust))
        }
    }

    private static let loopbackSession = URLSession(
        configuration: .ephemeral,
        delegate: LoopbackTrustDelegate(),
        delegateQueue: nil
    )

    // MARK: - Process discovery

    /// Process kinds distinguish the app language server from standalone processes.
    /// server carries richer quota data than the IDE variant, so IDE matches
    /// are skipped; a CLI (`agy`) match is accepted because its tokenless
    /// server exposes the same summary payload.
    struct Candidate: Sendable, Equatable {
        let pid: String
        let cli: Bool
        let csrf: String?
        /// `--extension_server_port` fallback, probed when lsof misses it.
        let extPort: Int?
    }

    private static let languageServerPattern = #"language[_-]server(_macos)?(_arm)?"#
    private static let ideMarkerPattern = #"(?i)antigravity[-_]ide"#
    private static let cliMarkerPattern = #"(?i)antigravity[-_]cli"#
    private static let agyBinaryPattern = #"(^|/|\s)agy(\s|$)"#
    private static let appMarkerPattern = #"(?i)--app_data_dir[= ]"?antigravity(?![\w-])|/antigravity/"#

    private static func matches(_ pattern: String, in line: String) -> Bool {
        line.range(of: pattern, options: .regularExpression) != nil
    }

    private static func flagValue(line: String, flag: String) -> String? {
        let pattern = NSRegularExpression.escapedPattern(for: flag) + #"[= ](\S+)"#
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)),
              let range = Range(match.range(at: 1), in: line) else { return nil }
        return String(line[range])
    }

    static func classifyProcessLine(_ line: String) -> Candidate? {
        let isServer = matches(languageServerPattern, in: line)
        let isCli = !isServer && (matches(cliMarkerPattern, in: line) || matches(agyBinaryPattern, in: line))
        guard isServer || isCli else { return nil }
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard let pidRange = trimmed.range(of: #"^\d+"#, options: .regularExpression) else { return nil }
        let pid = String(trimmed[pidRange])
        // A tokenless desktop language-server match is skipped so a later,
        // valid server can be found; the CLI exposes no CSRF flag and needs
        // none. IDE language servers are excluded too — their payloads lack
        // the weekly groups.
        if !isCli && (!matches(appMarkerPattern, in: line) || matches(ideMarkerPattern, in: line)) { return nil }
        let csrf = flagValue(line: line, flag: "--csrf_token")
        if !isCli && csrf == nil { return nil }
        let extPort = flagValue(line: line, flag: "--extension_server_port").flatMap(Int.init)
        return Candidate(pid: pid, cli: isCli, csrf: csrf, extPort: extPort.flatMap { $0 > 0 ? $0 : nil })
    }

    private static func discoverCandidates(deps: Deps) async throws -> [Candidate] {
        let stdout = try await deps.exec("/bin/ps", ["-ax", "-o", "pid=,command="])
        var seen = Set<String>()
        var candidates: [Candidate] = []
        for line in stdout.split(separator: "\n") {
            guard let candidate = classifyProcessLine(String(line)), !seen.contains(candidate.pid) else { continue }
            seen.insert(candidate.pid)
            candidates.append(candidate)
        }
        // The app source ranks above the CLI: richer quota data beats
        // availability. Swift's sort is stable, so discovery order survives
        // within each group.
        return candidates.sorted { ($0.cli ? 1 : 0) < ($1.cli ? 1 : 0) }
    }

    private static func listeningPorts(deps: Deps, pid: String) async -> [Int] {
        guard let stdout = try? await deps.exec("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", pid]),
              let regex = try? NSRegularExpression(pattern: #":(\d+)\s"#) else { return [] }
        var seen = Set<Int>()
        var ports: [Int] = []
        let range = NSRange(stdout.startIndex..., in: stdout)
        for match in regex.matches(in: stdout, range: range) {
            guard let portRange = Range(match.range(at: 1), in: stdout),
                  let port = Int(stdout[portRange]), port > 0, !seen.contains(port) else { continue }
            seen.insert(port)
            ports.append(port)
        }
        return ports
    }

    // MARK: - Decode (internal so tests can drive fixtures)

    /// Preferred payload: two named quota groups of model buckets.
    static func decodeSummary(_ body: Any?) -> [AntigravityUsage.Window] {
        guard let root = body as? [String: Any] else { return [] }
        // Current Connect-RPC servers wrap the payload in `response`; older
        // app/CLI builds returned the fields at the top level.
        let data = root["response"] as? [String: Any] ?? root
        var windows: [AntigravityUsage.Window] = []
        for group in data["groups"] as? [Any] ?? [] {
            guard let group = group as? [String: Any] else { continue }
            let groupName = group["displayName"] as? String ?? ""
            for bucket in group["buckets"] as? [Any] ?? [] {
                guard let bucket = bucket as? [String: Any] else { continue }
                let bucketName = (bucket["displayName"] as? String) ?? (bucket["bucketId"] as? String) ?? ""
                let name = [groupName, bucketName].filter { !$0.isEmpty }.joined(separator: " · ")
                if name.isEmpty { continue }
                let remaining = bucket["remainingFraction"]
                    ?? (bucket["remaining"] as? [String: Any])?["remainingFraction"]
                if let window = makeWindow(
                    label: name,
                    remainingFraction: remaining,
                    resetTime: bucket["resetTime"])
                {
                    windows.append(window)
                }
            }
        }
        return windows
    }

    /// Legacy payload: flat per-model quota rows under GetUserStatus.
    static func decodeStatus(_ body: Any?) -> [AntigravityUsage.Window] {
        guard let data = body as? [String: Any],
              let userStatus = data["userStatus"] as? [String: Any],
              let configData = userStatus["cascadeModelConfigData"] as? [String: Any] else { return [] }
        var windows: [AntigravityUsage.Window] = []
        for config in configData["clientModelConfigs"] as? [Any] ?? [] {
            guard let config = config as? [String: Any],
                  let name = firstNonBlankString([
                      config["label"],
                      config["modelName"],
                      config["modelId"],
                      (config["modelOrAlias"] as? [String: Any])?["model"],
                  ])
            else { continue }
            let quota = config["quotaInfo"] as? [String: Any]
            if let window = makeWindow(label: name, remainingFraction: quota?["remainingFraction"], resetTime: quota?["resetTime"]) {
                windows.append(window)
            }
        }
        return windows
    }

    /// planName may sit at the top level, under userStatus, or (legacy) as
    /// account_plan; the first non-blank string wins.
    static func planFromStatus(_ body: Any?) -> String? {
        guard let data = body as? [String: Any] else { return nil }
        let response = data["response"] as? [String: Any]
        let userStatus = (data["userStatus"] as? [String: Any])
            ?? (response?["userStatus"] as? [String: Any])
        let planStatus = userStatus?["planStatus"] as? [String: Any]
        let planInfo = planStatus?["planInfo"] as? [String: Any]
        let userTier = userStatus?["userTier"] as? [String: Any]
        let candidates = [
            data["planName"],
            response?["planName"],
            userStatus?["planName"],
            userTier?["name"],
            planInfo?["planDisplayName"],
            planInfo?["displayName"],
            planInfo?["planName"],
            planInfo?["productName"],
            planInfo?["planShortName"],
            data["account_plan"],
        ]
        return firstNonBlankString(candidates)
    }

    private static func firstNonBlankString(_ values: [Any?]) -> String? {
        for value in values {
            guard let raw = value as? String else { continue }
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed }
        }
        return nil
    }

    private static func makeWindow(label: String, remainingFraction: Any?, resetTime: Any?) -> AntigravityUsage.Window? {
        guard let remaining = number(remainingFraction) else { return nil }
        let used = min(100, max(0, (1 - remaining) * 100))
        return AntigravityUsage.Window(
            label: presentationLabel(label),
            usedPercent: used,
            resetsAt: resetDate(resetTime)
        )
    }

    /// Windows always render percent USED. Raw Antigravity bucket names can
    /// still say remaining, so rewrite that copy to match the inverted value.
    private static func presentationLabel(_ label: String) -> String {
        let pattern = #"(?i)\bremaining\b"#
        return label.replacingOccurrences(
            of: pattern,
            with: "used",
            options: .regularExpression
        )
    }

    /// JSON numbers only — booleans bridge to NSNumber and must not parse.
    private static func number(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let double = number.doubleValue
        return double.isFinite ? double : nil
    }

    /// Reset times arrive as epoch seconds (epoch ms past 1e12) or ISO strings.
    private static func resetDate(_ value: Any?) -> Date? {
        if let epoch = number(value) {
            return Date(timeIntervalSince1970: epoch > 1e12 ? epoch / 1000 : epoch)
        }
        if let raw = value as? String {
            let fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = fractional.date(from: raw) { return date }
            let plain = ISO8601DateFormatter()
            plain.formatOptions = [.withInternetDateTime]
            return plain.date(from: raw)
        }
        return nil
    }

    private static func parseJson(_ text: String) -> Any? {
        try? JSONSerialization.jsonObject(with: Data(text.utf8))
    }

    // MARK: - Probe + fetch

    private static func probePort(
        deps: Deps,
        port: Int,
        csrf: String?
    ) async -> (windows: [AntigravityUsage.Window], plan: String?)? {
        let body = "{}"
        for tls in [true, false] {
            if let summary = await deps.request(port, tls, summaryPath, body, csrf), summary.status == 200 {
                let windows = decodeSummary(parseJson(summary.text))
                if !windows.isEmpty { return (windows, nil) }
            }
            if let status = await deps.request(port, tls, statusPath, body, csrf), status.status == 200 {
                let parsed = parseJson(status.text)
                let windows = decodeStatus(parsed)
                if !windows.isEmpty { return (windows, planFromStatus(parsed)) }
            }
        }
        return nil
    }

    static func refresh(deps: Deps = .live) async throws -> AntigravityUsage {
        do {
            let candidates = try await discoverCandidates(deps: deps)
            if candidates.isEmpty { throw FetchError.disconnected }
            for candidate in candidates {
                var ports = await listeningPorts(deps: deps, pid: candidate.pid)
                if let extPort = candidate.extPort, !ports.contains(extPort) {
                    ports.append(extPort)
                }
                for port in ports {
                    if let found = await probePort(deps: deps, port: port, csrf: candidate.csrf) {
                        let windows = found.windows.sorted { $0.usedPercent > $1.usedPercent }
                        return AntigravityUsage(details: windows, plan: found.plan, fetchedAt: deps.now())
                    }
                }
            }
            throw FetchError.disconnected
        } catch let error as FetchError {
            throw error
        } catch {
            deps.log("Antigravity quota unavailable: \(sanitizeForLog(error.localizedDescription))")
            throw FetchError.network(error)
        }
    }

    /// Strip control characters and any token-shaped substrings from error
    /// strings before they land in NSLog — a `ps` failure message can quote
    /// arbitrary command lines. Mirrors the Electron side's sanitizeError.
    static func sanitizeForLog(_ raw: String) -> String {
        var cleaned = raw.replacingOccurrences(of: "\u{0000}", with: "")
        let patterns = [
            #"(?i)Bearer\s+[^\s,;"']+"#,
            #"(?i)sk-ant-[A-Za-z0-9_-]+"#,
            #"(?i)sk-[A-Za-z0-9_-]+"#,
            // Google (ya29.) and GitHub (gho_/ghu_/ghp_) OAuth token shapes.
            #"ya29\.[A-Za-z0-9._-]+"#,
            #"gh[opusr]_[A-Za-z0-9_]+"#,
            #"eyJ[A-Za-z0-9._-]+"#,
        ]
        for pattern in patterns {
            cleaned = cleaned.replacingOccurrences(of: pattern, with: "[REDACTED]", options: .regularExpression)
        }
        if cleaned.count > 240 { cleaned = String(cleaned.prefix(240)) }
        return cleaned
    }
}
