import Foundation

/// Mirror of ClaudeSubscriptionService for Codex (ChatGPT-mode). Hits
/// /backend-api/wham/usage with the bearer token from CodexCredentialStore,
/// applies an independent 429 backoff, and surfaces terminal vs transient
/// failures to the UI.
enum CodexSubscriptionService {
    private static let usageURL = URL(string: "https://chatgpt.com/backend-api/wham/usage")!
    private static let usageBlockedUntilKey = "codeburn.codex.usage.blockedUntil"

    enum FetchError: Error, LocalizedError {
        case notBootstrapped
        case bootstrapFailed(CodexCredentialStore.StoreError)
        case rateLimited(retryAt: Date)
        case usageHTTPError(Int, String?)
        case usageDecodeFailed
        case network(Error)
        case credential(CodexCredentialStore.StoreError)

        var errorDescription: String? {
            switch self {
            case .notBootstrapped:
                return "Connect Codex in Settings to start tracking quota."
            case let .bootstrapFailed(err): return err.errorDescription
            case let .rateLimited(retryAt):
                let f = RelativeDateTimeFormatter()
                f.unitsStyle = .short
                return "ChatGPT rate-limited the quota endpoint. Retrying \(f.localizedString(for: retryAt, relativeTo: Date()))."
            case let .usageHTTPError(code, body):
                return "Codex quota fetch failed (HTTP \(code))\(body.map { ": \($0)" } ?? "")"
            case .usageDecodeFailed: return "Codex quota response was malformed."
            case let .network(err): return "Network error: \(err.localizedDescription)"
            case let .credential(err): return err.errorDescription
            }
        }

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

    static func bootstrap() async throws -> CodexUsage {
        // Honour the same 429 backoff that refreshIfBootstrapped respects.
        // A user clicking Reconnect during a sustained ChatGPT rate-limit
        // window would otherwise re-hit /wham/usage on every click and keep
        // the backoff window pegged.
        if let until = usageBlockedUntil(), until > Date() {
            throw FetchError.rateLimited(retryAt: until)
        }
        let record: CodexCredentialStore.CredentialRecord
        do {
            record = try CodexCredentialStore.bootstrap()
        } catch let err as CodexCredentialStore.StoreError {
            throw FetchError.bootstrapFailed(err)
        }
        return try await fetchWithToken(record.accessToken, allowOne401Recovery: true)
    }

    static func refreshIfBootstrapped() async throws -> CodexUsage? {
        guard CodexCredentialStore.isBootstrapCompleted else { return nil }
        if let until = usageBlockedUntil(), until > Date() {
            throw FetchError.rateLimited(retryAt: until)
        }
        do {
            let token = try await CodexCredentialStore.freshAccessToken()
            guard let token else { throw FetchError.notBootstrapped }
            return try await fetchWithToken(token, allowOne401Recovery: true)
        } catch let err as CodexCredentialStore.StoreError {
            throw FetchError.credential(err)
        }
    }

    static func disconnect() {
        CodexCredentialStore.resetBootstrap()
        clearUsageBlock()
    }

    private static func fetchWithToken(_ token: String, allowOne401Recovery: Bool) async throws -> CodexUsage {
        var request = URLRequest(url: usageURL)
        request.httpMethod = "GET"
        request.timeoutInterval = 30
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("CodeBurn", forHTTPHeaderField: "User-Agent")
        // chatgpt.com routes the rate_limit envelope per ChatGPT account. Without
        // this header the response often comes back as a guest-shape document
        // missing rate_limit entirely, which our decoder then fails on.
        if let accountId = try? CodexCredentialStore.currentRecord()?.accountId, !accountId.isEmpty {
            request.setValue(accountId, forHTTPHeaderField: "ChatGPT-Account-Id")
        }

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
                return try decodeUsage(data: data)
            } catch {
                // Do not log the response body — it's user-account data from
                // chatgpt.com and is readable by other local users via
                // `log stream`. The decode error type alone is enough to
                // bisect schema drift if needed.
                NSLog("CodeBurn: codex usage decode failed: %@", String(describing: error))
                throw FetchError.usageDecodeFailed
            }
        case 401:
            if allowOne401Recovery {
                let newToken = try await CodexCredentialStore.refreshAfter401()
                return try await fetchWithToken(newToken, allowOne401Recovery: false)
            }
            throw FetchError.usageHTTPError(401, String(data: data, encoding: .utf8))
        case 429:
            // Honour the RFC Retry-After header when present — ChatGPT's quota
            // endpoint sometimes sets it to a window shorter than our 5-min
            // floor, and ignoring it forced users to wait longer than the
            // server actually wanted.
            let retryAfter = parseRetryAfterHeader(http.value(forHTTPHeaderField: "Retry-After"))
            let until = recordUsageRateLimit(retryAfterSeconds: retryAfter)
            throw FetchError.rateLimited(retryAt: until)
        default:
            throw FetchError.usageHTTPError(http.statusCode, String(data: data, encoding: .utf8))
        }
    }

    private struct UsageDTO: Decodable {
        let plan_type: String?
        let rate_limit: RateLimit?
        let additional_rate_limits: [AdditionalLimitDTO]?
        let credits: Credits?

        struct RateLimit: Decodable {
            let primary_window: WindowDTO?
            let secondary_window: WindowDTO?
        }
        struct AdditionalLimitDTO: Decodable {
            let limit_name: String?
            let rate_limit: RateLimit?
        }
        struct WindowDTO: Decodable {
            let used_percent: Double?
            let reset_at: Int?
            let limit_window_seconds: Int?
        }
        // chatgpt.com sometimes serializes balance as a Double ("balance": 0.0)
        // and other times as a String ("balance": "0.00"). Mirror CodexBar's
        // resilient decode so a schema drift on either shape doesn't blow up
        // the whole quota fetch.
        struct Credits: Decodable {
            let balance: Double?
            enum CodingKeys: String, CodingKey { case balance }
            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                if let n = try? c.decode(Double.self, forKey: .balance) {
                    balance = n
                } else if let s = try? c.decode(String.self, forKey: .balance), let n = Double(s) {
                    balance = n
                } else {
                    balance = nil
                }
            }
        }
    }

    private static func decodeUsage(data: Data) throws -> CodexUsage {
        let root = try JSONDecoder().decode(UsageDTO.self, from: data)
        let additional: [CodexUsage.AdditionalLimit] = (root.additional_rate_limits ?? []).compactMap { dto in
            guard let name = dto.limit_name, !name.isEmpty else { return nil }
            return CodexUsage.AdditionalLimit(
                name: name,
                primary: makeWindow(dto.rate_limit?.primary_window),
                secondary: makeWindow(dto.rate_limit?.secondary_window)
            )
        }
        return CodexUsage(
            plan: CodexUsage.planType(from: root.plan_type),
            primary: makeWindow(root.rate_limit?.primary_window),
            secondary: makeWindow(root.rate_limit?.secondary_window),
            additionalLimits: additional,
            creditsBalance: root.credits?.balance,
            fetchedAt: Date()
        )
    }

    private static func makeWindow(_ dto: UsageDTO.WindowDTO?) -> CodexUsage.Window? {
        guard let dto, let used = dto.used_percent, let windowSeconds = dto.limit_window_seconds else {
            return nil
        }
        let resetsAt = dto.reset_at.map { Date(timeIntervalSince1970: TimeInterval($0)) }
        return CodexUsage.Window(usedPercent: used, resetsAt: resetsAt, limitWindowSeconds: windowSeconds)
    }

    // MARK: - 429 backoff

    private static func usageBlockedUntil() -> Date? {
        UserDefaults.standard.object(forKey: usageBlockedUntilKey) as? Date
    }

    private static func clearUsageBlock() {
        UserDefaults.standard.removeObject(forKey: usageBlockedUntilKey)
    }

    @discardableResult
    /// RFC 7231 says Retry-After is either a delta-seconds or an HTTP-date.
    /// chatgpt.com appears to send delta-seconds today; we still parse both
    /// shapes defensively so a future change to HTTP-date doesn't drop us
    /// onto the silent 5-minute floor.
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
}
