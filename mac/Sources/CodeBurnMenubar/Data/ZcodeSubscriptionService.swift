import Foundation

/// Live ZCode (z.ai coding plan) quota from the same usage endpoint the ZCode
/// app's embedded coding-plan browser calls. Reuses the z.ai OAuth token from
/// the ZCode app's Local Storage journal, or a ZCODE_DATA_DIR override. This
/// adapter never persists or logs the token. The stored JWT carries no expiry
/// claim, so only the endpoint's business code (401/403 on HTTP 200) proves
/// the login expired — only the ZCode app can mint a new one.
enum ZcodeSubscriptionService {
    static let usageURL = URL(string: "https://api.z.ai/api/monitor/usage/quota/limit")!
    private static let timeoutSeconds: TimeInterval = 15
    private static let storageKey = "oauth:zai:access_token"
    /// Journals are small; anything huge is not a Local Storage log.
    private static let maxJournalBytes = 16 * 1024 * 1024

    enum FetchError: Error, Equatable, LocalizedError, Sendable {
        case noCredentials
        case authenticationRejected
        case rateLimited
        case providerUnavailable
        case parseFailure
        case network

        enum Classification: Equatable, Sendable {
            case terminalAuth
            case transient
            case parseFailure
        }

        var classification: Classification {
            switch self {
            case .noCredentials, .authenticationRejected: .terminalAuth
            case .rateLimited, .providerUnavailable, .network: .transient
            case .parseFailure: .parseFailure
            }
        }

        var errorDescription: String? {
            switch self {
            case .noCredentials:
                "Sign in to the ZCode app, then click Retry."
            case .authenticationRejected:
                "Z.ai rejected this ZCode login. Sign in to the ZCode app again."
            case .rateLimited:
                "Z.ai rate-limited the quota request."
            case .providerUnavailable:
                "Z.ai is temporarily unavailable."
            case .parseFailure:
                "Z.ai returned an unrecognized quota response."
            case .network:
                "Network error fetching ZCode quota."
            }
        }
    }

    struct Deps: Sendable {
        var loadToken: @Sendable () throws -> String?
        var fetch: @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)

        static let live = Deps(
            loadToken: {
                let environment = ProcessInfo.processInfo.environment
                let override = environment["ZCODE_DATA_DIR"]?
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let root = override.isEmpty
                    ? FileManager.default.homeDirectoryForCurrentUser
                        .appendingPathComponent("Library/Application Support/ZCode", isDirectory: true)
                    : URL(fileURLWithPath: override, isDirectory: true)
                return accessToken(fromZCodeDataRoot: root)
            },
            fetch: { request in
                let configuration = URLSessionConfiguration.ephemeral
                configuration.httpCookieStorage = nil
                configuration.httpShouldSetCookies = false
                configuration.urlCache = nil
                configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
                let session = URLSession(configuration: configuration)
                defer { session.invalidateAndCancel() }
                let (data, response) = try await session.data(for: request)
                guard let http = response as? HTTPURLResponse else { throw FetchError.network }
                return (data, http)
            }
        )
    }

    @MainActor
    static func refresh(deps: Deps = .live) async throws -> QuotaSummary {
        let loadToken = deps.loadToken
        guard let token = try await Task.detached { try loadToken() }.value,
              !token.isEmpty else { throw FetchError.noCredentials }

        var request = URLRequest(url: usageURL)
        request.httpMethod = "GET"
        request.timeoutInterval = timeoutSeconds
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("en-US,en", forHTTPHeaderField: "Accept-Language")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("CodeBurn", forHTTPHeaderField: "User-Agent")

        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await deps.fetch(request)
        } catch let error as FetchError {
            throw error
        } catch {
            throw FetchError.network
        }

        switch response.statusCode {
        case 200: break
        case 401, 403: throw FetchError.authenticationRejected
        case 429: throw FetchError.rateLimited
        case 500...599: throw FetchError.providerUnavailable
        default: throw FetchError.parseFailure
        }

        return try decode(data)
    }

    static func decode(_ data: Data) throws -> QuotaSummary {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw FetchError.parseFailure
        }
        let bodyCode = jsonNumber(root["code"]).map(Int.init)
        if bodyCode == 401 || bodyCode == 403 { throw FetchError.authenticationRejected }
        if root["success"] as? Bool == false { throw FetchError.parseFailure }

        let payload = (root["data"] as? [String: Any]) ?? root
        guard let limits = payload["limits"] as? [Any] else { throw FetchError.parseFailure }

        var fiveHour: QuotaSummary.Window?
        var weekly: QuotaSummary.Window?

        for raw in limits {
            guard let limit = raw as? [String: Any],
                  let type = limit["type"] as? String,
                  type == "CREDIT_LIMIT" || type == "TOKENS_LIMIT",
                  let unit = jsonNumber(limit["unit"]),
                  let count = jsonNumber(limit["number"]) else { continue }

            let label: String
            if unit == 3, count == 5 {
                label = "5-hour"
            } else if unit == 6, count == 1 {
                label = "Weekly"
            } else {
                continue
            }

            var usedPercent = jsonNumber(limit["percentage"])
            if usedPercent == nil,
               let current = jsonNumber(limit["currentValue"]),
               let total = jsonNumber(limit["usage"]), total > 0 {
                usedPercent = current / total * 100
            }
            guard let usedPercent else { continue }

            let window = QuotaSummary.Window(
                label: label,
                percent: min(1, max(0, usedPercent / 100)),
                resetsAt: parseReset(limit["nextResetTime"])
            )
            if label == "Weekly" { weekly = window } else { fiveHour = window }
        }

        let details = [fiveHour, weekly].compactMap { $0 }
        guard !details.isEmpty else { throw FetchError.parseFailure }
        return QuotaSummary(
            providerFilter: .all,
            connection: .connected,
            primary: weekly ?? fiveHour,
            details: details,
            planLabel: planLabel(payload["level"]),
            footerLines: ["Source: Z.ai Coding Plan"]
        )
    }

    /// Scans the coding-plan webview's Chromium Local Storage journals for the
    /// z.ai OAuth token. Read-only; `nil` when no journal holds the login —
    /// the same state as never signed in.
    static func accessToken(fromZCodeDataRoot root: URL) -> String? {
        let leveldb = root
            .appendingPathComponent("session/Partitions/zcode-coding-plan", isDirectory: true)
            .appendingPathComponent("Local Storage", isDirectory: true)
            .appendingPathComponent("leveldb", isDirectory: true)
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: leveldb.path) else {
            return nil
        }
        // Journal names are zero-padded counters, so descending name order is
        // newest-first; once a journal is compacted into an .ldb its records
        // move there (compressed, invisible to this scan) and the .log goes.
        for name in names.filter({ $0.hasSuffix(".log") }).sorted().reversed() {
            let url = leveldb.appendingPathComponent(name)
            guard let data = try? Data(contentsOf: url),
                  !data.isEmpty, data.count <= maxJournalBytes else { continue }
            for text in journalReadings(data) {
                if let token = tokenAfterStorageKey(in: text) { return token }
            }
        }
        return nil
    }

    /// Chromium stores Local Storage strings as raw bytes (a Latin-1 marker)
    /// or UTF-16; try both readings a key can hide in.
    private static func journalReadings(_ data: Data) -> [String] {
        var readings: [String] = []
        if let latin = String(data: data, encoding: .isoLatin1) { readings.append(latin) }
        if data.count % 2 == 0, let utf16 = String(data: data, encoding: .utf16LittleEndian) {
            readings.append(utf16)
        }
        return readings
    }

    /// The last write of the key wins, matching how the journal replays. The
    /// gap after the key is a leveldb varint length plus Chromium's string
    /// marker — control or high-bit bytes, never token characters.
    private static func tokenAfterStorageKey(in text: String) -> String? {
        let pattern = storageKey + "[\\x00-\\x20\\x7f-\\xff]{0,16}([A-Za-z0-9_\\-.=+/]{24,})"
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        var token: String?
        for match in regex.matches(in: text, range: range) {
            guard let capture = Range(match.range(at: 1), in: text) else { continue }
            token = String(text[capture])
        }
        return token
    }

    private static func jsonNumber(_ value: Any?) -> Double? {
        if let value = value as? Double, value.isFinite { return value }
        if let value = value as? NSNumber { return value.doubleValue }
        if let value = value as? String, let number = Double(value), number.isFinite { return number }
        return nil
    }

    private static func parseReset(_ value: Any?) -> Date? {
        if let number = jsonNumber(value) {
            let seconds = number < 1_000_000_000_000 ? number : number / 1000
            return seconds.isFinite ? Date(timeIntervalSince1970: seconds) : nil
        }
        guard let value = value as? String else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    private static func planLabel(_ value: Any?) -> String? {
        guard let value = value as? String else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return trimmed.replacingOccurrences(of: "_", with: " ").lowercased().capitalized
    }
}
