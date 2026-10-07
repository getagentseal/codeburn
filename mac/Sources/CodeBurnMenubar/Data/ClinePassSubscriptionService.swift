import Foundation

/// Live ClinePass quota from the public usage-limits HTTP contract.
/// GET https://api.cline.bot/api/v1/users/me/plan/usage-limits with a bearer
/// token: the caller's saved key, else CLINEPASS_API_KEY / CLINE_API_KEY, else
/// the session the Cline CLI keeps in ~/.cline/data/settings/providers.json.
/// That file is only read, never refreshed or written. Never reads Keychain.
enum ClinePassSubscriptionService {
    static let usageURL = URL(string: "https://api.cline.bot/api/v1/users/me/plan/usage-limits")!
    private static let timeoutSeconds: TimeInterval = 15

    enum FetchError: Error, Equatable, LocalizedError, Sendable {
        case noCredentials
        case authenticationRejected
        case signInExpired
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
            case .noCredentials, .authenticationRejected:
                return .terminalAuth
            // Running cline refreshes the session file this only reads, so the
            // next scheduled read picks it up; keep the last quota until then.
            case .signInExpired, .rateLimited, .providerUnavailable, .network:
                return .transient
            case .parseFailure:
                return .parseFailure
            }
        }

        var isTerminal: Bool { classification == .terminalAuth }

        var errorDescription: String? {
            switch self {
            case .noCredentials:
                return "Sign in with Cline, or enter a ClinePass API key, then click Retry."
            case .authenticationRejected:
                return "ClinePass rejected this API key."
            case .signInExpired:
                return "Cline sign-in expired. Run cline to refresh it."
            case .rateLimited:
                return "ClinePass rate-limited the quota request."
            case .providerUnavailable:
                return "ClinePass is temporarily unavailable."
            case .parseFailure:
                return "ClinePass quota response was malformed."
            case .network:
                return "Network error fetching ClinePass quota."
            }
        }
    }

    struct Credential: Equatable, Sendable {
        let token: String
        let isOAuth: Bool
        let expiresAt: Date?
    }

    struct Deps: Sendable {
        var fetch: @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)
        var loadAmbientCredential: @Sendable () -> Credential?
        var now: @Sendable () -> Date

        static let live = Deps(
            fetch: { request in
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let http = response as? HTTPURLResponse else {
                    throw FetchError.network
                }
                return (data, http)
            },
            loadAmbientCredential: { ambientCredential(environment: ProcessInfo.processInfo.environment) },
            now: { Date() }
        )
    }

    static func ambientCredential(environment: [String: String]) -> Credential? {
        for name in ["CLINEPASS_API_KEY", "CLINE_API_KEY"] {
            if let key = cleaned(environment[name]) {
                return Credential(token: key, isOAuth: false, expiresAt: nil)
            }
        }
        guard let data = try? Data(contentsOf: providersFileURL(environment: environment)) else { return nil }
        return fileCredential(data)
    }

    /// Cline's own lookup order: a settings file override, then a data dir, then a Cline dir.
    static func providersFileURL(
        environment: [String: String],
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> URL {
        func path(_ name: String) -> URL? {
            guard let value = cleaned(environment[name]) else { return nil }
            if value == "~" { return home }
            if value.hasPrefix("~/") { return home.appendingPathComponent(String(value.dropFirst(2))) }
            return URL(fileURLWithPath: value)
        }
        if let file = path("CLINE_PROVIDER_SETTINGS_PATH") { return file }
        let dataDir = path("CLINE_DATA_DIR")
            ?? (path("CLINE_DIR") ?? home.appendingPathComponent(".cline")).appendingPathComponent("data")
        return dataDir.appendingPathComponent("settings/providers.json")
    }

    /// Matches Cline's getApiKey: the OAuth access token wins over keys kept in the same entry.
    static func fileCredential(_ data: Data) -> Credential? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let providers = root["providers"] as? [String: Any],
              let cline = providers["cline"] as? [String: Any],
              let settings = cline["settings"] as? [String: Any] else { return nil }
        let auth = settings["auth"] as? [String: Any]
        if let access = cleaned(auth?["accessToken"] as? String) {
            let expiresAt = (auth?["expiresAt"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue / 1000) }
            return Credential(
                token: access.hasPrefix("workos:") ? access : "workos:\(access)",
                isOAuth: true,
                expiresAt: expiresAt
            )
        }
        guard let key = cleaned(settings["apiKey"] as? String) ?? cleaned(auth?["apiKey"] as? String) else {
            return nil
        }
        return Credential(token: key, isOAuth: false, expiresAt: nil)
    }

    private static func cleaned(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }

    @MainActor
    static func refresh(apiKey: String?, deps: Deps = .live) async throws -> QuotaSummary {
        let credential: Credential
        if let key = cleaned(apiKey) {
            credential = Credential(token: key, isOAuth: false, expiresAt: nil)
        } else {
            let load = deps.loadAmbientCredential
            guard let ambient = await Task.detached(operation: { load() }).value else {
                throw FetchError.noCredentials
            }
            credential = ambient
        }
        if credential.isOAuth, let expiresAt = credential.expiresAt, expiresAt <= deps.now() {
            throw FetchError.signInExpired
        }

        var request = URLRequest(url: usageURL)
        request.httpMethod = "GET"
        request.timeoutInterval = timeoutSeconds
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "Authorization")

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
        case 200:
            break
        case 401, 403:
            throw credential.isOAuth ? FetchError.signInExpired : FetchError.authenticationRejected
        case 429:
            throw FetchError.rateLimited
        case 500...599:
            throw FetchError.providerUnavailable
        default:
            throw FetchError.parseFailure
        }

        return try decode(data)
    }

    static func decode(_ data: Data) throws -> QuotaSummary {
        let parsed: Any
        do {
            parsed = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw FetchError.parseFailure
        }
        guard let root = parsed as? [String: Any] else {
            throw FetchError.parseFailure
        }
        guard let success = root["success"] as? Bool else {
            throw FetchError.parseFailure
        }
        guard success else {
            throw FetchError.parseFailure
        }
        guard let dataObject = root["data"] as? [String: Any] else {
            throw FetchError.parseFailure
        }
        guard let limits = dataObject["limits"] as? [Any] else {
            throw FetchError.parseFailure
        }

        var fiveHour: QuotaSummary.Window?
        var weekly: QuotaSummary.Window?
        var monthly: QuotaSummary.Window?

        for raw in limits {
            guard let limit = raw as? [String: Any] else {
                throw FetchError.parseFailure
            }
            guard let type = limit["type"] as? String else {
                throw FetchError.parseFailure
            }
            let label: String
            switch type {
            case "five_hour": label = "5-hour"
            case "weekly": label = "Weekly"
            case "monthly": label = "Monthly"
            default: continue
            }
            guard let percentUsed = jsonNumber(limit["percentUsed"]) else {
                throw FetchError.parseFailure
            }
            let percent = min(1, max(0, percentUsed / 100))
            let resetsAt: Date?
            if let rawReset = limit["resetsAt"], !(rawReset is NSNull) {
                guard let stamp = rawReset as? String, let date = parseReset(stamp) else {
                    throw FetchError.parseFailure
                }
                resetsAt = date
            } else {
                resetsAt = nil
            }
            let window = QuotaSummary.Window(label: label, percent: percent, resetsAt: resetsAt)
            switch type {
            case "five_hour": fiveHour = window
            case "weekly": weekly = window
            case "monthly": monthly = window
            default: break
            }
        }

        let details = [fiveHour, weekly, monthly].compactMap { $0 }
        guard !details.isEmpty else {
            throw FetchError.parseFailure
        }
        return QuotaSummary(
            providerFilter: .all,
            connection: .connected,
            primary: weekly ?? fiveHour ?? monthly,
            details: details,
            planLabel: nil,
            footerLines: []
        )
    }

    private static func jsonNumber(_ value: Any?) -> Double? {
        if let value = value as? Double { return value }
        if let value = value as? Int { return Double(value) }
        if let value = value as? NSNumber { return value.doubleValue }
        return nil
    }

    private static func parseReset(_ raw: String) -> Date? {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = iso.date(from: raw) { return date }
        iso.formatOptions = [.withInternetDateTime]
        return iso.date(from: raw)
    }
}
