import Foundation

/// Orchestrates "given a credential record, fetch live quota from Anthropic
/// and surface a result the UI can render". All token persistence lives in
/// `ClaudeCredentialStore`; the only state this service holds is the
/// 429 backoff window for the usage endpoint.
enum ClaudeSubscriptionService {
    private static let usageURL = URL(string: "https://api.anthropic.com/api/oauth/usage")!
    private static let betaHeader = "oauth-2025-04-20"
    private static let userAgent = "claude-code/2.1.0"
    private static let usageBlockedUntilKey = "codeburn.claude.usage.blockedUntil"

    enum FetchError: Error, LocalizedError {
        case notBootstrapped
        case bootstrapFailed(ClaudeCredentialStore.StoreError)
        case rateLimited(retryAt: Date)
        case usageHTTPError(Int, String?)
        case usageDecodeFailed
        case network(Error)
        case credential(ClaudeCredentialStore.StoreError)

        var errorDescription: String? {
            switch self {
            case .notBootstrapped:
                return "Connect Claude in the Plan tab to start tracking quota."
            case let .bootstrapFailed(err):
                return err.errorDescription
            case let .rateLimited(retryAt):
                let f = RelativeDateTimeFormatter()
                f.unitsStyle = .short
                return "Anthropic rate-limited the quota endpoint. Retrying \(f.localizedString(for: retryAt, relativeTo: Date()))."
            case let .usageHTTPError(code, body):
                return "Quota fetch failed (HTTP \(code))\(body.map { ": \($0)" } ?? "")"
            case .usageDecodeFailed:
                return "Quota response was malformed."
            case let .network(err):
                return "Network error: \(err.localizedDescription)"
            case let .credential(err):
                return err.errorDescription
            }
        }

        /// True when the user must take action (re-run claude/login or click
        /// Reconnect). Drives the red "Reconnect" UI path.
        var isTerminal: Bool {
            if case let .credential(err) = self { return err.isTerminal }
            if case let .bootstrapFailed(err) = self { return err.isTerminal }
            return false
        }

        var rateLimitRetryAt: Date? {
            if case let .rateLimited(retryAt) = self { return retryAt }
            return nil
        }
    }

    // MARK: - Public API

    /// User-initiated. Reads Claude's keychain (PROMPTS), copies to our keychain,
    /// then fetches usage. Idempotent — safe to call again to "reconnect".
    static func bootstrap() async throws -> SubscriptionUsage {
        // Honour the same 429 backoff that refreshIfBootstrapped respects.
        // Without this, a user spamming Reconnect during a sustained
        // rate-limit window hammers Anthropic on every click — exactly the
        // pattern that escalates the backoff.
        if let until = usageBlockedUntil(), until > Date() {
            throw FetchError.rateLimited(retryAt: until)
        }
        let record: ClaudeCredentialStore.CredentialRecord
        do {
            record = try ClaudeCredentialStore.bootstrap()
        } catch let err as ClaudeCredentialStore.StoreError {
            throw FetchError.bootstrapFailed(err)
        }
        return try await fetchWithRecord(initial: record)
    }

    /// Background refresh. Never prompts. Returns nil if not yet bootstrapped.
    static func refreshIfBootstrapped() async throws -> SubscriptionUsage? {
        guard ClaudeCredentialStore.isBootstrapCompleted else {
            return nil
        }

        // Honour an outstanding rate-limit window — we recorded a 429 recently
        // and Anthropic told us when to come back.
        if let until = usageBlockedUntil(), until > Date() {
            throw FetchError.rateLimited(retryAt: until)
        }

        do {
            let token = try await ClaudeCredentialStore.freshAccessToken()
            guard let token else { throw FetchError.notBootstrapped }
            return try await fetch(token: token, allowOne401Recovery: true)
        } catch let err as ClaudeCredentialStore.StoreError {
            throw FetchError.credential(err)
        } catch let err as FetchError {
            throw err
        }
    }

    /// Reset everything — used on user-initiated disconnect.
    static func disconnect() {
        ClaudeCredentialStore.resetBootstrap()
        clearUsageBlock()
    }

    // MARK: - Internal

    private static func fetchWithRecord(initial record: ClaudeCredentialStore.CredentialRecord) async throws -> SubscriptionUsage {
        do {
            return try await fetch(token: record.accessToken, allowOne401Recovery: true)
        } catch let err as FetchError {
            throw err
        } catch let err as ClaudeCredentialStore.StoreError {
            throw FetchError.credential(err)
        }
    }

    private static func fetch(token: String, allowOne401Recovery: Bool) async throws -> SubscriptionUsage {
        var request = URLRequest(url: usageURL)
        request.httpMethod = "GET"
        request.timeoutInterval = 30
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(betaHeader, forHTTPHeaderField: "anthropic-beta")
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw FetchError.network(error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw FetchError.usageHTTPError(-1, nil)
        }

        switch http.statusCode {
        case 200:
            clearUsageBlock()
            do {
                let decoded = try JSONDecoder().decode(UsageResponse.self, from: data)
                let tier = try ClaudeCredentialStore.subscriptionTier()
                return mapResponse(decoded, rawTier: tier)
            } catch {
                throw FetchError.usageDecodeFailed
            }
        case 401:
            if allowOne401Recovery {
                let newToken = try await ClaudeCredentialStore.refreshAfter401()
                return try await fetch(token: newToken, allowOne401Recovery: false)
            }
            throw FetchError.usageHTTPError(401, String(data: data, encoding: .utf8))
        case 429:
            let body = String(data: data, encoding: .utf8)
            let retryAfter = parseRetryAfter(body: body)
            let until = recordUsageRateLimit(retryAfterSeconds: retryAfter)
            throw FetchError.rateLimited(retryAt: until)
        default:
            throw FetchError.usageHTTPError(http.statusCode, String(data: data, encoding: .utf8))
        }
    }

    // MARK: - 429 backoff

    private static func usageBlockedUntil() -> Date? {
        UserDefaults.standard.object(forKey: usageBlockedUntilKey) as? Date
    }

    private static func clearUsageBlock() {
        UserDefaults.standard.removeObject(forKey: usageBlockedUntilKey)
    }

    @discardableResult
    private static func recordUsageRateLimit(retryAfterSeconds: Int?) -> Date {
        let seconds = max(retryAfterSeconds ?? 300, 60)
        let until = Date().addingTimeInterval(TimeInterval(seconds))
        UserDefaults.standard.set(until, forKey: usageBlockedUntilKey)
        return until
    }

    private static func parseRetryAfter(body: String?) -> Int? {
        guard let body, let data = body.data(using: .utf8) else { return nil }
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let n = json["retry_after"] as? Int { return n }
            if let s = json["retry_after"] as? String, let n = Int(s) { return n }
        }
        return nil
    }

    // MARK: - Response mapping

    private struct UsageResponse: Decodable {
        let fiveHour: Window?
        let sevenDay: Window?
        let sevenDayOpus: Window?
        let sevenDaySonnet: Window?

        enum CodingKeys: String, CodingKey {
            case fiveHour = "five_hour"
            case sevenDay = "seven_day"
            case sevenDayOpus = "seven_day_opus"
            case sevenDaySonnet = "seven_day_sonnet"
        }
    }

    private struct Window: Decodable {
        let utilization: Double?
        let resetsAt: String?
        enum CodingKeys: String, CodingKey {
            case utilization
            case resetsAt = "resets_at"
        }
    }

    private static func mapResponse(_ r: UsageResponse, rawTier: String?) -> SubscriptionUsage {
        SubscriptionUsage(
            tier: SubscriptionUsage.tier(from: rawTier),
            rawTier: rawTier,
            fiveHourPercent: r.fiveHour?.utilization,
            fiveHourResetsAt: parseDate(r.fiveHour?.resetsAt),
            sevenDayPercent: r.sevenDay?.utilization,
            sevenDayResetsAt: parseDate(r.sevenDay?.resetsAt),
            sevenDayOpusPercent: r.sevenDayOpus?.utilization,
            sevenDayOpusResetsAt: parseDate(r.sevenDayOpus?.resetsAt),
            sevenDaySonnetPercent: r.sevenDaySonnet?.utilization,
            sevenDaySonnetResetsAt: parseDate(r.sevenDaySonnet?.resetsAt),
            fetchedAt: Date()
        )
    }

    private static func parseDate(_ s: String?) -> Date? {
        guard let s, !s.isEmpty else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }
}
