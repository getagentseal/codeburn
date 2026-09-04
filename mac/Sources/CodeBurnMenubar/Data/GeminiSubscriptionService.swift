import Foundation

/// Live quota snapshot for a Gemini (Code Assist) subscription. The API
/// reports per-model quota buckets; `details` is sorted most-constrained
/// first so `primary` is the window that will throttle the user soonest.
struct GeminiUsage: Sendable, Equatable {
    struct Window: Sendable, Equatable {
        /// Model id reported by the quota endpoint (e.g. "gemini-2.5-pro").
        let label: String
        let usedPercent: Double   // 0.0 ... 100.0
        let resetsAt: Date?
    }

    /// Per-model windows, most-constrained first.
    let details: [Window]
    var primary: Window? { details.first }
    /// Tier label derived from loadCodeAssist (Paid / Legacy / Workspace / Free).
    let plan: String?
    let fetchedAt: Date
}

/// Live Gemini quota via the OAuth-backed Code Assist APIs the Gemini CLI
/// itself calls (derived from the Google Code Assist client flow, which provides
/// the flow from the CLI's own traffic):
///
/// - POST .../v1internal:loadCodeAssist → tier (plan label) + quota project
/// - POST .../v1internal:retrieveUserQuota → per-model quota buckets
///
/// Credential: the Gemini CLI's own ~/.gemini/oauth_creds.json, read-only —
/// nothing is copied or written. Token refresh happens in memory only, and
/// only when the CLI's documented GEMINI_OAUTH_CLIENT_ID /
/// GEMINI_OAUTH_CLIENT_SECRET env overrides are set; without them an expired
/// token is terminal and the UI tells the user to run the Gemini CLI once.
enum GeminiSubscriptionService {
    private static let codeAssistEndpoint = "https://cloudcode-pa.googleapis.com/v1internal"
    private static let tokenEndpoint = "https://oauth2.googleapis.com/token"
    private static let usageBlockedUntilKey = "codeburn.gemini.usage.blockedUntil"

    enum FetchError: Error, LocalizedError {
        case noCredentials
        case tokenExpired
        /// Google retired Gemini CLI OAuth for this account tier.
        case accountTierRetired
        case rateLimited(retryAt: Date)
        case usageHTTPError(Int)
        case network(Error)

        var errorDescription: String? {
            switch self {
            case .noCredentials:
                return L("No Gemini credentials found. Sign in with the Gemini CLI first.")
            case .tokenExpired:
                return L("Gemini login expired. Run the Gemini CLI once to refresh, then try again.")
            case .accountTierRetired:
                return L("Google retired Gemini CLI OAuth for this account tier. Use Antigravity.")
            case let .rateLimited(retryAt):
                let f = RelativeDateTimeFormatter()
                f.unitsStyle = .short
                return L("Gemini rate-limited the quota endpoint. Retrying \(f.localizedString(for: retryAt, relativeTo: Date())).")
            case let .usageHTTPError(code):
                return L("Gemini quota fetch failed (HTTP \(code)).")
            case let .network(err):
                return L("Network error: \(err.localizedDescription)")
            }
        }

        var isTerminal: Bool {
            switch self {
            case .noCredentials, .tokenExpired, .accountTierRetired:
                return true
            case let .usageHTTPError(code):
                return (400..<500).contains(code)
            case .rateLimited, .network:
                return false
            }
        }

        var rateLimitRetryAt: Date? {
            if case let .rateLimited(retryAt) = self { return retryAt }
            return nil
        }
    }

    // MARK: - Injectable seams (tests drive fixtures through these)

    struct Deps: Sendable {
        var fetch: @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)
        /// Read-only credential file load. Never writes.
        var readFile: @Sendable (URL) -> Data?
        var credentialURL: URL
        var now: @Sendable () -> Date
        /// OAuth client credentials from the CLI's documented env overrides.
        var clientCredentials: @Sendable () -> (clientId: String, clientSecret: String)?

        static let live = Deps(
            fetch: { request in
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let http = response as? HTTPURLResponse else {
                    throw FetchError.usageHTTPError(-1)
                }
                return (data, http)
            },
            readFile: { url in FileManager.default.contents(atPath: url.path) },
            credentialURL: URL(fileURLWithPath: NSHomeDirectory() + "/.gemini/oauth_creds.json"),
            now: { Date() },
            clientCredentials: {
                let env = ProcessInfo.processInfo.environment
                guard let id = env["GEMINI_OAUTH_CLIENT_ID"], !id.isEmpty,
                      let secret = env["GEMINI_OAUTH_CLIENT_SECRET"], !secret.isEmpty else { return nil }
                return (id, secret)
            }
        )
    }

    // MARK: - Credential file

    private struct Credential {
        var accessToken: String
        let refreshToken: String?
        let idToken: String?
        /// Epoch milliseconds, as the Gemini CLI writes it. nil = never stale.
        let expiryDate: Double?

        static func parse(_ data: Data) -> Credential? {
            guard let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let token = raw["access_token"] as? String, !token.isEmpty else { return nil }
            let expiry: Double?
            if let n = raw["expiry_date"] as? Double {
                expiry = n
            } else if let n = raw["expiry_date"] as? Int {
                expiry = Double(n)
            } else {
                expiry = nil
            }
            return Credential(
                accessToken: token,
                refreshToken: raw["refresh_token"] as? String,
                idToken: raw["id_token"] as? String,
                expiryDate: expiry
            )
        }
    }

    private static var defaultCredentialURL: URL { Deps.live.credentialURL }

    static var hasCredential: Bool {
        FileManager.default.fileExists(atPath: defaultCredentialURL.path)
    }

    private static func readCredential(deps: Deps) throws -> Credential {
        guard let data = deps.readFile(deps.credentialURL),
              let credential = Credential.parse(data) else {
            throw FetchError.noCredentials
        }
        return credential
    }

    // MARK: - Fetch

    static func refresh(deps: Deps = .live) async throws -> GeminiUsage {
        if let until = usageBlockedUntil(), until > deps.now() {
            throw FetchError.rateLimited(retryAt: until)
        }
        var credential = try readCredential(deps: deps)

        // The CLI considers a token stale 5 minutes before expiry.
        if let expiry = credential.expiryDate,
           expiry - deps.now().timeIntervalSince1970 * 1000 <= 5 * 60_000 {
            guard let client = deps.clientCredentials(), credential.refreshToken != nil else {
                // No refresh path: the Gemini CLI owns this file, so the user
                // must run it once to mint a fresh token.
                throw FetchError.tokenExpired
            }
            if let refreshed = try await refreshAccessToken(credential: credential, client: client, deps: deps) {
                credential.accessToken = refreshed
            }
            // A failed refresh keeps the stale token; a 401 below degrades it.
        }

        var (assistData, assistResponse) = try await send(
            postRequest(token: credential.accessToken, path: "loadCodeAssist",
                        body: ["metadata": ["ideType": "GEMINI_CLI", "pluginType": "GEMINI"]]),
            deps: deps
        )
        if assistResponse.statusCode == 401 {
            // The CLI may have refreshed the file while we ran; retry once
            // with a newly-written token, otherwise the login is dead.
            let reread = try readCredential(deps: deps)
            guard reread.accessToken != credential.accessToken else {
                throw FetchError.tokenExpired
            }
            credential = reread
            (assistData, assistResponse) = try await send(
                postRequest(token: credential.accessToken, path: "loadCodeAssist",
                            body: ["metadata": ["ideType": "GEMINI_CLI", "pluginType": "GEMINI"]]),
                deps: deps
            )
        }
        if assistResponse.statusCode == 429 {
            throw FetchError.rateLimited(retryAt: recordUsageRateLimit(
                retryAfterSeconds: parseRetryAfterHeader(assistResponse.value(forHTTPHeaderField: "Retry-After"))))
        }
        // Retired-tier sentinels ride inside the JSON error body of a non-200
        // response, so parse before branching on status.
        let assist = (try? JSONSerialization.jsonObject(with: assistData)) as? [String: Any] ?? [:]
        if isTierRetired(assist) {
            throw FetchError.accountTierRetired
        }
        guard (200..<300).contains(assistResponse.statusCode) else {
            throw FetchError.usageHTTPError(assistResponse.statusCode)
        }

        let project = (assist["cloudaicompanionProject"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let (quotaData, quotaResponse) = try await send(
            postRequest(token: credential.accessToken, path: "retrieveUserQuota",
                        body: project.map { ["project": $0] } ?? [:]),
            deps: deps
        )
        if quotaResponse.statusCode == 429 {
            throw FetchError.rateLimited(retryAt: recordUsageRateLimit(
                retryAfterSeconds: parseRetryAfterHeader(quotaResponse.value(forHTTPHeaderField: "Retry-After"))))
        }
        guard (200..<300).contains(quotaResponse.statusCode) else {
            throw FetchError.usageHTTPError(quotaResponse.statusCode)
        }
        return decodeUsage(data: quotaData, plan: tierLabel(assist: assist, credential: credential), now: deps.now())
    }

    private static func postRequest(token: String, path: String, body: [String: Any]) -> URLRequest {
        var request = URLRequest(url: URL(string: "\(codeAssistEndpoint):\(path)")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("CodeBurn", forHTTPHeaderField: "User-Agent")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        return request
    }

    private static func send(_ request: URLRequest, deps: Deps) async throws -> (Data, HTTPURLResponse) {
        do {
            return try await deps.fetch(request)
        } catch let error as FetchError {
            throw error
        } catch {
            throw FetchError.network(error)
        }
    }

    /// In-memory refresh through Google OAuth. Returns nil on a non-200 so
    /// the caller can degrade via the stale token's 401 path.
    private static func refreshAccessToken(
        credential: Credential,
        client: (clientId: String, clientSecret: String),
        deps: Deps
    ) async throws -> String? {
        guard let refreshToken = credential.refreshToken else { return nil }
        var request = URLRequest(url: URL(string: tokenEndpoint)!)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = [
            "client_id=\(client.clientId)",
            "client_secret=\(client.clientSecret)",
            "refresh_token=\(refreshToken)",
            "grant_type=refresh_token",
        ].joined(separator: "&").data(using: .utf8)
        let (data, response) = try await send(request, deps: deps)
        guard (200..<300).contains(response.statusCode),
              let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = body["access_token"] as? String, !token.isEmpty else { return nil }
        return token
    }

    // MARK: - Decode (internal so tests can drive fixtures)

    static func decodeUsage(data: Data, plan: String?, now: Date = Date()) -> GeminiUsage {
        let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let buckets = root["buckets"] as? [[String: Any]] ?? []
        let windows = buckets.compactMap(window(from:)).sorted { $0.usedPercent > $1.usedPercent }
        return GeminiUsage(details: windows, plan: plan, fetchedAt: now)
    }

    private static func window(from bucket: [String: Any]) -> GeminiUsage.Window? {
        guard let modelId = bucket["modelId"] as? String, !modelId.isEmpty,
              let remaining = bucket["remainingFraction"] as? Double, remaining.isFinite else { return nil }
        let clamped = min(1, max(0, remaining))
        let resetsAt = (bucket["resetTime"] as? String).flatMap(parseResetTime)
        return GeminiUsage.Window(label: modelId, usedPercent: (1 - clamped) * 100, resetsAt: resetsAt)
    }

    /// paidTier wins whenever present; otherwise whatever tier the account sits on.
    private static func tierLabel(assist: [String: Any], credential: Credential) -> String? {
        let paid = (assist["paidTier"] as? [String: Any])?["name"] as? String
        let current = assist["currentTier"] as? [String: Any]
        guard let raw = paid ?? (current?["name"] as? String) ?? (current?["id"] as? String) else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return nil }
        let lower = trimmed.lowercased()
        if lower == "standard-tier" { return L("Paid") }
        if lower == "legacy-tier" { return L("Legacy") }
        if lower.contains("free") {
            return workspaceClaim(idToken: credential.idToken) ? L("Workspace") : L("Free")
        }
        return trimmed
    }

    /// The `hd` claim (hosted domain) separates Google Workspace logins from
    /// personal ones, matching the provider's tier labeling.
    private static func workspaceClaim(idToken: String?) -> Bool {
        guard let idToken else { return false }
        let parts = idToken.split(separator: ".")
        guard parts.count > 1 else { return false }
        var base64 = String(parts[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while base64.count % 4 != 0 { base64.append("=") }
        guard let data = Data(base64Encoded: base64),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let hd = json["hd"] as? String else { return false }
        return !hd.isEmpty
    }

    /// Google flags retired consumer tiers with these sentinels instead of
    /// ordinary errors.
    private static func isTierRetired(_ body: [String: Any]) -> Bool {
        guard let error = body["error"] as? [String: Any] else { return false }
        let status = error["status"] as? String ?? ""
        let message = error["message"] as? String ?? ""
        return status == "UNSUPPORTED_CLIENT" || message.contains("IneligibleTierError")
    }

    private static func parseResetTime(_ raw: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: raw) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: raw)
    }

    // MARK: - 429 backoff

    private static func usageBlockedUntil() -> Date? {
        UserDefaults.standard.object(forKey: usageBlockedUntilKey) as? Date
    }

    private static func clearUsageBlock() {
        UserDefaults.standard.removeObject(forKey: usageBlockedUntilKey)
    }

    private static func parseRetryAfterHeader(_ value: String?) -> Int? {
        guard let value = value?.trimmingCharacters(in: .whitespaces), !value.isEmpty else { return nil }
        if let seconds = Int(value), seconds >= 0 { return seconds }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(secondsFromGMT: 0)
        f.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        if let date = f.date(from: value) {
            return max(0, Int(date.timeIntervalSinceNow))
        }
        return nil
    }

    private static func recordUsageRateLimit(retryAfterSeconds: Int?) -> Date {
        let seconds = max(retryAfterSeconds ?? 300, 60)
        let until = Date().addingTimeInterval(TimeInterval(seconds))
        UserDefaults.standard.set(until, forKey: usageBlockedUntilKey)
        return until
    }

    static func disconnect() {
        clearUsageBlock()
    }
}
