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

    /// Shared body with ZaiSubscriptionService via ZaiPlanQuotaDecoder; only
    /// the error vocabulary differs between the two adapters.
    static func decode(_ data: Data) throws -> QuotaSummary {
        do {
            return try ZaiPlanQuotaDecoder.decode(data)
        } catch let error as ZaiPlanQuotaDecoder.DecodeError {
            switch error {
            case .authenticationRejected: throw FetchError.authenticationRejected
            case .parseFailure: throw FetchError.parseFailure
            }
        }
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

    /// Each Local Storage string carries a one-byte flag: 0x01 marks one-byte
    /// (Latin-1) characters, 0x00 marks UTF-16LE — a recorded journal shows
    /// the z.ai login stored the first way. The whole file is read in both
    /// byte views so a key can be found in either.
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

}
