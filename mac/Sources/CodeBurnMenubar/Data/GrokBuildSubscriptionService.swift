import Foundation

/// Read-only access to the login that Grok Build owns in `$GROK_HOME/auth.json`.
/// CodeBurn keeps the bearer in memory only and never copies it into Keychain,
/// UserDefaults, logs, or its support directory.
enum GrokBuildCredentialStore {
    struct Credential: Equatable, Sendable {
        let accessToken: String
        let authMode: String?
        let expiresAt: Date?

        func isExpired(at date: Date) -> Bool {
            guard let expiresAt else { return false }
            return expiresAt <= date
        }
    }

    enum ReadError: Error, Equatable {
        case malformed
        case missingToken
    }

    private struct Entry: Decodable {
        let key: String?
        let authMode: String?
        let expiresAt: String?

        enum CodingKeys: String, CodingKey {
            case key
            case authMode = "auth_mode"
            case expiresAt = "expires_at"
        }
    }

    static func load(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) throws -> Credential? {
        let grokHome: URL
        if let configured = cleaned(environment["GROK_HOME"]) {
            grokHome = URL(
                fileURLWithPath: (configured as NSString).expandingTildeInPath,
                isDirectory: true
            )
        } else {
            grokHome = home.appendingPathComponent(".grok", isDirectory: true)
        }
        let authURL = grokHome.appendingPathComponent("auth.json", isDirectory: false)
        guard FileManager.default.fileExists(atPath: authURL.path) else { return nil }
        return try decode(SafeFile.read(from: authURL.path, maxBytes: 128 * 1024))
    }

    static func decode(_ data: Data) throws -> Credential {
        let entries: [String: Entry]
        do {
            entries = try JSONDecoder().decode([String: Entry].self, from: data)
        } catch {
            throw ReadError.malformed
        }

        let usable = entries.compactMap { scope, entry -> (scope: String, entry: Entry, token: String)? in
            guard let token = cleaned(entry.key) else { return nil }
            return (scope, entry, token)
        }
        let selected = usable.sorted { lhs, rhs in
            let lhsRank = credentialRank(scope: lhs.scope)
            let rhsRank = credentialRank(scope: rhs.scope)
            return lhsRank == rhsRank ? lhs.scope < rhs.scope : lhsRank < rhsRank
        }.first
        guard let selected else { throw ReadError.missingToken }

        return Credential(
            accessToken: selected.token,
            authMode: cleaned(selected.entry.authMode),
            expiresAt: parseDate(selected.entry.expiresAt)
        )
    }

    private static func credentialRank(scope: String) -> Int {
        if scope.hasPrefix("https://auth.x.ai::") { return 0 }
        if scope.contains("/sign-in") { return 1 }
        return 2
    }

    private static func cleaned(_ raw: String?) -> String? {
        guard let value = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else { return nil }
        return value
    }

    private static func parseDate(_ raw: String?) -> Date? {
        guard let raw = cleaned(raw) else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: raw) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: raw)
    }
}

/// Live Grok Build subscription usage obtained with the OAuth login already
/// managed by the Grok CLI. Requests use an ephemeral, cookie-free session and
/// the bearer is released after each refresh.
enum GrokBuildSubscriptionService {
    static let billingURL = URL(string: "https://cli-chat-proxy.grok.com/v1/billing?format=credits")!
    static let settingsURL = URL(string: "https://cli-chat-proxy.grok.com/v1/settings")!
    private static let timeoutSeconds: TimeInterval = 15

    enum FetchError: Error, Equatable, LocalizedError, Sendable {
        case noCredentials
        case expiredSession
        case credentialDataUnreadable
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
            case .noCredentials, .expiredSession, .credentialDataUnreadable, .authenticationRejected:
                .terminalAuth
            case .rateLimited, .providerUnavailable, .network:
                .transient
            case .parseFailure:
                .parseFailure
            }
        }

        var errorDescription: String? {
            switch self {
            case .noCredentials:
                L("Run `grok login`, then click Retry.")
            case .expiredSession:
                L("The Grok Build login has expired. Run `grok login`, then click Retry.")
            case .credentialDataUnreadable:
                L("Could not read Grok Build's local login. Run `grok login` again, then click Retry.")
            case .authenticationRejected:
                L("Grok rejected the current Grok Build login. Run `grok login`, then click Retry.")
            case .rateLimited:
                L("Grok rate-limited the quota request.")
            case .providerUnavailable:
                L("Grok quota is temporarily unavailable.")
            case .parseFailure:
                L("Grok returned an unrecognized quota response.")
            case .network:
                L("Network error fetching Grok quota.")
            }
        }
    }

    struct Deps: Sendable {
        var loadCredential: @Sendable () throws -> GrokBuildCredentialStore.Credential?
        var fetch: @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)

        static let live = Deps(
            loadCredential: { try GrokBuildCredentialStore.load() },
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
    static func refresh(deps: Deps = .live, now: Date = Date()) async throws -> QuotaSummary {
        let loadCredential = deps.loadCredential
        let credential: GrokBuildCredentialStore.Credential
        do {
            guard let loaded = try await Task.detached(operation: loadCredential).value else {
                throw FetchError.noCredentials
            }
            credential = loaded
        } catch let error as FetchError {
            throw error
        } catch let error as GrokBuildCredentialStore.ReadError {
            switch error {
            case .missingToken: throw FetchError.noCredentials
            case .malformed: throw FetchError.credentialDataUnreadable
            }
        } catch {
            throw FetchError.credentialDataUnreadable
        }
        guard !credential.isExpired(at: now) else { throw FetchError.expiredSession }

        let billingData = try await fetchRequired(
            url: billingURL,
            credential: credential,
            deps: deps
        )
        let billing = try decodeBilling(billingData, now: now)
        let settingsPlan = try await fetchPlan(credential: credential, deps: deps)
        let plan = normalizedPlan(settingsPlan) ?? normalizedPlan(billing.subscriptionTier)
        let window = billing.usedPercent.map { percent in
            QuotaSummary.Window(
                label: windowLabel(resetsAt: billing.resetsAt, now: now),
                percent: percent,
                resetsAt: billing.resetsAt
            )
        }
        return QuotaSummary(
            providerFilter: .grok,
            connection: .connected,
            primary: window,
            details: window.map { [$0] } ?? [],
            planLabel: plan,
            footerLines: ["Source: Grok Build"]
        )
    }

    private struct BillingSnapshot {
        let usedPercent: Double?
        let resetsAt: Date?
        let subscriptionTier: String?
    }

    private struct BillingEnvelope: Decodable {
        let config: BillingConfig?
        let subscriptionTier: String?
    }

    private struct BillingConfig: Decodable {
        let creditUsagePercent: Double?
        let currentPeriod: CurrentPeriod?
        let billingPeriodEnd: String?
        let onDemandCap: Amount?
        let onDemandUsed: Amount?
        let used: Amount?
        let monthlyLimit: Amount?
        let subscriptionTier: String?
        let isUnifiedBillingUser: Bool?
    }

    private struct CurrentPeriod: Decodable {
        let start: String?
        let end: String?
    }
    private struct Amount: Decodable { let val: Double? }
    private struct SettingsEnvelope: Decodable {
        let subscriptionTierDisplay: String?

        enum CodingKeys: String, CodingKey {
            case subscriptionTierDisplay = "subscription_tier_display"
        }
    }

    private static func decodeBilling(_ data: Data, now: Date) throws -> BillingSnapshot {
        let envelope: BillingEnvelope
        do {
            envelope = try JSONDecoder().decode(BillingEnvelope.self, from: data)
        } catch {
            throw FetchError.parseFailure
        }
        guard let config = envelope.config else { throw FetchError.parseFailure }

        let rawPercent: Double?
        if let percent = config.creditUsagePercent, percent.isFinite {
            rawPercent = percent
        } else if let used = config.onDemandUsed?.val,
                  let cap = config.onDemandCap?.val,
                  used.isFinite, cap.isFinite, used >= 0, cap > 0 {
            rawPercent = used / cap * 100
        } else if let used = config.used?.val,
                  let cap = config.monthlyLimit?.val,
                  used.isFinite, cap.isFinite, used >= 0, cap > 0 {
            rawPercent = used / cap * 100
        } else if isActiveBillingPeriod(config.currentPeriod, now: now) {
            // Grok's web client and proto3 both treat an omitted
            // creditUsagePercent as 0 during an active window. After a weekly
            // reset the field is simply absent — that is 0% used, not unknown.
            rawPercent = 0
        } else {
            rawPercent = nil
        }

        let reset = parseDate(config.currentPeriod?.end ?? config.billingPeriodEnd)
        if rawPercent == nil, reset == nil, config.isUnifiedBillingUser != true {
            throw FetchError.parseFailure
        }

        return BillingSnapshot(
            usedPercent: rawPercent.map { min(1, max(0, $0 / 100)) },
            resetsAt: reset,
            subscriptionTier: config.subscriptionTier ?? envelope.subscriptionTier
        )
    }

    private static func isActiveBillingPeriod(_ period: CurrentPeriod?, now: Date) -> Bool {
        guard let end = parseDate(period?.end), end > now else { return false }
        if let start = parseDate(period?.start) {
            return start <= now
        }
        return true
    }

    private static func fetchRequired(
        url: URL,
        credential: GrokBuildCredentialStore.Credential,
        deps: Deps
    ) async throws -> Data {
        let request = authorizedRequest(url: url, credential: credential)
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await deps.fetch(request)
        } catch let error as FetchError {
            throw error
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw FetchError.network
        }
        switch response.statusCode {
        case 200: return data
        case 401, 403: throw FetchError.authenticationRejected
        case 429: throw FetchError.rateLimited
        case 500...599: throw FetchError.providerUnavailable
        default: throw FetchError.parseFailure
        }
    }

    private static func fetchPlan(
        credential: GrokBuildCredentialStore.Credential,
        deps: Deps
    ) async throws -> String? {
        let request = authorizedRequest(url: settingsURL, credential: credential)
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await deps.fetch(request)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            return nil
        }
        guard response.statusCode == 200,
              let settings = try? JSONDecoder().decode(SettingsEnvelope.self, from: data) else { return nil }
        return settings.subscriptionTierDisplay
    }

    private static func authorizedRequest(
        url: URL,
        credential: GrokBuildCredentialStore.Credential
    ) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = timeoutSeconds
        request.setValue("Bearer \(credential.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("xai-grok-cli", forHTTPHeaderField: "x-xai-token-auth")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("CodeBurn", forHTTPHeaderField: "User-Agent")
        return request
    }

    private static func parseDate(_ raw: String?) -> Date? {
        guard let raw, !raw.isEmpty else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: raw) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: raw)
    }

    private static func normalizedPlan(_ raw: String?) -> String? {
        guard let value = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else { return nil }
        switch value.lowercased().filter(\.isLetter) {
        case "supergrokheavy", "heavy": return "SuperGrok Heavy"
        case "supergrok": return "SuperGrok"
        default: return value
        }
    }

    private static func windowLabel(resetsAt: Date?, now: Date) -> String {
        guard let resetsAt else { return L("Credits") }
        let days = Int((resetsAt.timeIntervalSince(now) / 86_400).rounded())
        if (4...12).contains(days) { return L("Weekly") }
        if (20...45).contains(days) { return L("Monthly") }
        return L("Credits")
    }
}
