import Foundation

/// Live Command Code (`cmd`) plan quota from the account the CLI keeps signed in
/// on this machine.
///
/// The credential is the CLI's own `~/.commandcode/auth.json` (a `user_…` API
/// key). Two reads on https://api.commandcode.ai:
///   GET /alpha/billing/credits        → windowLimits.fiveHour / .weekly
///   GET /alpha/billing/subscriptions  → the plan name
/// Both need a User-Agent (the edge rejects requests without one) and the key as
/// a bearer token. Nothing leaves the machine but those two requests.
enum CommandCodeSubscriptionService {
    static let baseURL = URL(string: "https://api.commandcode.ai")!
    static let creditsPath = "/alpha/billing/credits"
    static let subscriptionsPath = "/alpha/billing/subscriptions"
    private static let timeoutSeconds: TimeInterval = 15
    private static let userAgent = "codeburn-menubar"

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
            case .noCredentials, .authenticationRejected:
                return .terminalAuth
            case .rateLimited, .providerUnavailable, .network:
                return .transient
            case .parseFailure:
                return .parseFailure
            }
        }

        var isTerminal: Bool { classification == .terminalAuth }

        var errorDescription: String? {
            switch self {
            case .noCredentials:
                return "Run `cmd login` to sign in to Command Code, then click Reconnect."
            case .authenticationRejected:
                return "Command Code rejected the stored login. Run `cmd login` again."
            case .rateLimited:
                return "Command Code rate-limited the quota request."
            case .providerUnavailable:
                return "Command Code is temporarily unavailable."
            case .parseFailure:
                return "Command Code quota response was malformed."
            case .network:
                return "Network error fetching Command Code quota."
            }
        }
    }

    struct Deps: Sendable {
        var authFileURL: URL
        var fetch: @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)

        static let live = Deps(
            authFileURL: FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".commandcode/auth.json"),
            fetch: { request in
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let http = response as? HTTPURLResponse else {
                    throw FetchError.network
                }
                return (data, http)
            }
        )
    }

    /// The `user_…` API key from the CLI's own auth file, or nil when the tool is
    /// not signed in on this machine.
    static func storedAPIKey(authFileURL: URL) -> String? {
        guard let data = try? Data(contentsOf: authFileURL),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let key = root["apiKey"] as? String else {
            return nil
        }
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    @MainActor
    static func refresh(deps: Deps = .live) async throws -> QuotaSummary {
        guard let apiKey = storedAPIKey(authFileURL: deps.authFileURL) else {
            throw FetchError.noCredentials
        }

        let creditsData = try await get(creditsPath, apiKey: apiKey, deps: deps)
        let summary = try decodeCredits(creditsData)

        // The plan name is a nice-to-have: a failure here must not blank the windows.
        let planLabel = (try? await get(subscriptionsPath, apiKey: apiKey, deps: deps))
            .flatMap(decodePlanLabel)

        return QuotaSummary(
            providerFilter: .commandCode,
            connection: .connected,
            primary: summary.primary,
            details: summary.details,
            planLabel: planLabel ?? summary.planLabel,
            footerLines: summary.footerLines
        )
    }

    private static func get(_ path: String, apiKey: String, deps: Deps) async throws -> Data {
        guard let url = URL(string: path, relativeTo: baseURL) else { throw FetchError.network }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = timeoutSeconds
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")

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
            return data
        case 401, 403:
            throw FetchError.authenticationRejected
        case 429:
            throw FetchError.rateLimited
        case 500...599:
            throw FetchError.providerUnavailable
        default:
            throw FetchError.parseFailure
        }
    }

    struct DecodedCredits {
        let primary: QuotaSummary.Window?
        let details: [QuotaSummary.Window]
        let planLabel: String?
        let footerLines: [String]
    }

    /// `{"credits":{...},"windowLimits":{"fiveHour":{"used":…,"cap":…,"resetAt":ms},"weekly":{…}}}`
    static func decodeCredits(_ data: Data) throws -> DecodedCredits {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw FetchError.parseFailure
        }
        guard let limits = root["windowLimits"] as? [String: Any] else {
            throw FetchError.parseFailure
        }

        let fiveHour = window(limits["fiveHour"], label: "5-hour", windowSeconds: 5 * 3600)
        let weekly = window(limits["weekly"], label: "Weekly", windowSeconds: 7 * 24 * 3600)
        let details = [fiveHour, weekly].compactMap { $0 }
        guard !details.isEmpty else {
            throw FetchError.parseFailure
        }

        var footerLines: [String] = []
        if let credits = root["credits"] as? [String: Any] {
            let monthly = jsonNumber(credits["monthlyCredits"]) ?? 0
            let purchased = jsonNumber(credits["purchasedCredits"]) ?? 0
            let free = jsonNumber(credits["freeCredits"]) ?? 0
            let remaining = monthly + purchased + free
            footerLines.append(String(format: "%.1f credits remaining this cycle", remaining))
        }

        return DecodedCredits(
            primary: weekly ?? fiveHour,
            details: details,
            planLabel: nil,
            footerLines: footerLines
        )
    }

    private static func window(_ raw: Any?, label: String, windowSeconds: Int) -> QuotaSummary.Window? {
        guard let object = raw as? [String: Any] else { return nil }
        guard let cap = jsonNumber(object["cap"]), cap > 0 else { return nil }
        let used = jsonNumber(object["used"]) ?? 0
        let percent = min(1, max(0, used / cap))
        let resetsAt = jsonNumber(object["resetAt"]).map { Date(timeIntervalSince1970: $0 / 1000) }
        return QuotaSummary.Window(
            label: label,
            percent: percent,
            resetsAt: resetsAt,
            windowSeconds: windowSeconds,
            fetchedAt: Date(),
            usedUnits: used
        )
    }

    static func decodePlanLabel(_ data: Data) -> String? {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let plan = root["data"] as? [String: Any],
              let planId = plan["planId"] as? String else {
            return nil
        }
        return friendlyPlanName(planId)
    }

    /// Turns the subscription SKU id into the product name the user knows.
    static func friendlyPlanName(_ planId: String) -> String? {
        let id = planId.lowercased()
        guard !id.isEmpty else { return nil }
        if id.contains("goat") { return "GOAT" }
        if id.contains("max") { return "Max" }
        if id.contains("pro") { return "Pro" }
        if id.contains("go") { return "Go" }
        return planId
    }

    private static func jsonNumber(_ value: Any?) -> Double? {
        if let value = value as? Double { return value }
        if let value = value as? Int { return Double(value) }
        if let value = value as? NSNumber { return value.doubleValue }
        return nil
    }
}
