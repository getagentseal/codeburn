import Foundation

/// Live quota snapshot for a Kimi Code subscription, returned by
/// GET https://api.kimi.com/coding/v1/usages. Shape mirrors what
/// steipete/CodexBar consumes: a top-level `usage` envelope plus a
/// `limits` array of additional rate-limit windows. Numeric fields are
/// decoded leniently (String or Int/Double) because the API has shipped
/// both.
struct KimiUsage: Sendable, Equatable {
    struct Window: Sendable, Equatable {
        let label: String
        let limit: Double
        let used: Double
        let remaining: Double?
        let resetsAt: Date?

        var usedPercent: Double {   // 0.0 ... 100.0
            guard limit > 0 else { return 0 }
            return min(100, max(0, used / limit * 100))
        }
    }

    /// The top-level `usage` envelope — treated as the primary window.
    let primary: Window?
    /// Additional windows from the `limits` array (e.g. 5-hour rate limit).
    let details: [Window]
    /// Membership tier from user.membership.level (e.g. "Intermediate").
    let plan: String?
    /// Max parallel sessions from parallel.limit, when reported.
    let parallelLimit: Int?
    let fetchedAt: Date
}

/// Mirror of CodexSubscriptionService for Kimi Code. Reads the CLI's
/// credential file directly (~/.kimi-code/credentials/kimi-code.json) —
/// no keychain bootstrap, no OAuth refresh. Tokens are short-lived
/// (~15 min) and only the Kimi CLI refreshes them, so an expired token is
/// a terminal state: the UI tells the user to run the CLI once.
enum KimiSubscriptionService {
    private static let usageURL = URL(string: "https://api.kimi.com/coding/v1/usages")!
    private static let usageBlockedUntilKey = "codeburn.kimi.usage.blockedUntil"

    enum FetchError: Error, LocalizedError {
        case noCredentials
        case tokenExpired
        case rateLimited(retryAt: Date)
        case usageHTTPError(Int, String?)
        case usageDecodeFailed
        case network(Error)

        var errorDescription: String? {
            switch self {
            case .noCredentials:
                return "No Kimi Code credentials found. Sign in with the Kimi CLI first."
            case .tokenExpired:
                return "Kimi Code login expired. Run the Kimi CLI once to refresh, then try again."
            case let .rateLimited(retryAt):
                let f = RelativeDateTimeFormatter()
                f.unitsStyle = .short
                return "Kimi rate-limited the quota endpoint. Retrying \(f.localizedString(for: retryAt, relativeTo: Date()))."
            case let .usageHTTPError(code, body):
                return "Kimi quota fetch failed (HTTP \(code))\(body.map { ": \($0)" } ?? "")"
            case .usageDecodeFailed: return "Kimi quota response was malformed."
            case let .network(err): return "Network error: \(err.localizedDescription)"
            }
        }

        var isTerminal: Bool {
            if case .tokenExpired = self { return true }
            if case .noCredentials = self { return true }
            return false
        }

        var rateLimitRetryAt: Date? {
            if case let .rateLimited(retryAt) = self { return retryAt }
            return nil
        }
    }

    // MARK: - Credential file

    private struct CredentialFile: Decodable {
        let accessToken: String
        let expiresAt: Double

        enum CodingKeys: String, CodingKey {
            case accessToken = "access_token"
            case expiresAt = "expires_at"
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            accessToken = try c.decode(String.self, forKey: .accessToken)
            // Tolerate Int / Double / String epoch-seconds.
            if let n = try? c.decode(Double.self, forKey: .expiresAt) {
                expiresAt = n
            } else if let s = try? c.decode(String.self, forKey: .expiresAt), let n = Double(s) {
                expiresAt = n
            } else {
                throw DecodingError.dataCorruptedError(forKey: .expiresAt, in: c, debugDescription: "expires_at missing or not numeric")
            }
        }
    }

    private static var credentialsURL: URL {
        let home = ProcessInfo.processInfo.environment["KIMI_CODE_HOME"]
            ?? NSHomeDirectory() + "/.kimi-code"
        return URL(fileURLWithPath: home + "/credentials/kimi-code.json")
    }

    static var hasCredential: Bool {
        FileManager.default.fileExists(atPath: credentialsURL.path)
    }

    /// Returns the access token only when it is still fresh (60s skew).
    /// Throws noCredentials / tokenExpired otherwise.
    private static func freshToken() throws -> String {
        guard let data = FileManager.default.contents(atPath: credentialsURL.path),
              let cred = try? JSONDecoder().decode(CredentialFile.self, from: data),
              !cred.accessToken.isEmpty else {
            throw FetchError.noCredentials
        }
        guard cred.expiresAt > Date().timeIntervalSince1970 + 60 else {
            throw FetchError.tokenExpired
        }
        return cred.accessToken
    }

    private static func deviceId() -> String? {
        let home = ProcessInfo.processInfo.environment["KIMI_CODE_HOME"]
            ?? NSHomeDirectory() + "/.kimi-code"
        guard let data = FileManager.default.contents(atPath: home + "/device_id"),
              let id = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !id.isEmpty else { return nil }
        return id
    }

    // MARK: - Fetch

    static func refresh() async throws -> KimiUsage {
        if let until = usageBlockedUntil(), until > Date() {
            throw FetchError.rateLimited(retryAt: until)
        }
        let token = try freshToken()

        var request = URLRequest(url: usageURL)
        request.httpMethod = "GET"
        request.timeoutInterval = 30
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("CodeBurn", forHTTPHeaderField: "User-Agent")
        // Kimi server expects these platform headers (same as CodexBar sends).
        request.setValue("kimi_code_cli", forHTTPHeaderField: "X-Msh-Platform")
        if let deviceId = deviceId() {
            request.setValue(deviceId, forHTTPHeaderField: "X-Msh-Device-Id")
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
                return try parseUsage(data: data)
            } catch {
                // Never log the body — account data readable via `log stream`.
                NSLog("CodeBurn: kimi usage decode failed: %@", String(describing: error))
                throw FetchError.usageDecodeFailed
            }
        case 401, 403:
            // We don't self-refresh; surface as terminal so the UI prompts
            // the user to run the CLI.
            throw FetchError.tokenExpired
        case 429:
            let retryAfter = parseRetryAfterHeader(http.value(forHTTPHeaderField: "Retry-After"))
            let until = recordUsageRateLimit(retryAfterSeconds: retryAfter)
            throw FetchError.rateLimited(retryAt: until)
        default:
            throw FetchError.usageHTTPError(http.statusCode, String(data: data, encoding: .utf8))
        }
    }

    // MARK: - Decode (internal so tests can drive fixtures)

    private struct LenientDouble: Decodable {
        let value: Double?
        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if let n = try? c.decode(Double.self) { value = n }
            else if let s = try? c.decode(String.self) { value = Double(s) }
            else { value = nil }
        }
    }

    private struct UsageEnvelopeDTO: Decodable {
        let limit: LenientDouble?
        let used: LenientDouble?
        let remaining: LenientDouble?
        let resetTime: LenientString?
        let resetAt: LenientString?
        let reset_time: LenientString?
        let reset_at: LenientString?

        var resetsAtRaw: String? {
            resetTime?.value ?? resetAt?.value ?? reset_time?.value ?? reset_at?.value
        }
    }

    /// Reset timestamps are normally ISO-8601 strings, but decode numbers
    /// tolerantly too (epoch seconds) so a schema drift can't fail the whole
    /// response. A plain String? would throw on a JSON number.
    private struct LenientString: Decodable {
        let value: String?
        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if let s = try? c.decode(String.self) { value = s }
            else if let n = try? c.decode(Double.self) { value = String(n) }
            else { value = nil }
        }
    }

    private struct LimitDTO: Decodable {
        let window: WindowDTO?
        let detail: UsageEnvelopeDTO?

        struct WindowDTO: Decodable {
            let duration: LenientDouble?
            let timeUnit: String?
        }
    }

    private struct ResponseDTO: Decodable {
        let usage: UsageEnvelopeDTO?
        let limits: [LimitDTO]?
        let user: UserDTO?
        let parallel: ParallelDTO?

        struct UserDTO: Decodable {
            let membership: MembershipDTO?
            struct MembershipDTO: Decodable {
                let level: String?
            }
        }
        struct ParallelDTO: Decodable {
            let limit: LenientDouble?
        }
    }

    static func parseUsage(data: Data, now: Date = Date()) throws -> KimiUsage {
        let root = try JSONDecoder().decode(ResponseDTO.self, from: data)
        // The top-level usage envelope is the account's weekly quota (its
        // reset lands ~7 days out), so label it like Claude's weekly window.
        let primary = makeWindow(label: "Weekly", dto: root.usage)
        let details: [KimiUsage.Window] = (root.limits ?? []).compactMap { limit in
            guard let dto = limit.detail else { return nil }
            let label = windowLabel(duration: limit.window?.duration?.value, timeUnit: limit.window?.timeUnit)
            return makeWindow(label: label, dto: dto)
        }
        guard primary != nil || !details.isEmpty else {
            throw FetchError.usageDecodeFailed
        }
        return KimiUsage(
            primary: primary,
            details: details,
            plan: planName(from: root.user?.membership?.level),
            parallelLimit: root.parallel?.limit?.value.map { Int($0) },
            fetchedAt: now
        )
    }

    /// "LEVEL_INTERMEDIATE" → "Intermediate". Unknown / missing → nil so the
    /// UI falls back to the plain "Kimi Code" label.
    private static func planName(from level: String?) -> String? {
        guard var raw = level, !raw.isEmpty else { return nil }
        if raw.hasPrefix("LEVEL_") { raw = String(raw.dropFirst("LEVEL_".count)) }
        return raw.replacingOccurrences(of: "_", with: " ").capitalized
    }

    private static func makeWindow(label: String, dto: UsageEnvelopeDTO?) -> KimiUsage.Window? {
        guard let dto, let limit = dto.limit?.value, limit > 0 else { return nil }
        // Rate-limit windows report only limit + remaining — derive used.
        let used = dto.used?.value ?? max(0, limit - (dto.remaining?.value ?? limit))
        return KimiUsage.Window(
            label: label,
            limit: limit,
            used: used,
            remaining: dto.remaining?.value,
            resetsAt: dto.resetsAtRaw.flatMap(parseResetTime)
        )
    }

    /// Window size → human label. The API sends enum-style units
    /// ("TIME_UNIT_MINUTE", duration 300) as well as plain ones ("hour"),
    /// so normalize first; sub-hour durations roll up to hours when exact.
    private static func windowLabel(duration: Double?, timeUnit: String?) -> String {
        guard let duration, let rawUnit = timeUnit else { return "Rate Limit" }
        var unit = rawUnit.lowercased()
        if unit.hasPrefix("time_unit_") { unit = String(unit.dropFirst("time_unit_".count)) }
        var d = duration
        // Roll up exact sub-day durations: 300 minutes → 5 hours.
        if unit == "minute" || unit == "minutes", d.truncatingRemainder(dividingBy: 60) == 0, d >= 60 {
            d /= 60; unit = "hour"
        }
        let i = Int(d)
        switch unit {
        case "minute", "minutes": return i == 1 ? "Minutely" : "\(i)-min"
        case "hour", "hours":   return i == 1 ? "Hourly" : "\(i)-hour"
        case "day", "days":
            if i == 1 { return "Daily" }
            if i == 7 { return "Weekly" }
            return "\(i)-day"
        case "week", "weeks":   return i == 1 ? "Weekly" : "\(i)-week"
        case "month", "months": return i == 1 ? "Monthly" : "\(i)-month"
        default:                return "\(i) \(unit)"
        }
    }

    /// resetTime arrives as ISO-8601 (fractional seconds optional) or epoch seconds.
    private static func parseResetTime(_ raw: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: raw) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let date = plain.date(from: raw) { return date }
        if let epoch = Double(raw) { return Date(timeIntervalSince1970: epoch) }
        return nil
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
