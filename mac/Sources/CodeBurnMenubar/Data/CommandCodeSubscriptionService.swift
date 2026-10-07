import Foundation

/// Live Command Code quota from its billing endpoints, with the API key the
/// Command Code CLI keeps in ~/.commandcode/auth.json (read-only, never logged).
/// GET /alpha/billing/credits carries the 5-hour and weekly windows as USD
/// credits used of a cap (resetAt epoch ms, 0 while no window is open) plus
/// the remaining credits; GET /alpha/billing/subscriptions carries the plan id.
/// Mirrors src/quota/commandcode.ts.
enum CommandCodeSubscriptionService {
    static let creditsURL = URL(string: "https://api.commandcode.ai/alpha/billing/credits")!
    static let subscriptionsURL = URL(string: "https://api.commandcode.ai/alpha/billing/subscriptions")!
    private static let timeoutSeconds: TimeInterval = 15

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
                "Sign in with the Command Code CLI, then click Retry."
            case .authenticationRejected:
                "Command Code session expired. Sign in with the Command Code CLI again."
            case .rateLimited:
                "Command Code rate-limited the quota request."
            case .providerUnavailable:
                "Command Code is temporarily unavailable."
            case .parseFailure:
                "Command Code quota response was malformed."
            case .network:
                "Network error fetching Command Code quota."
            }
        }
    }

    struct Deps: Sendable {
        var loadAPIKey: @Sendable () -> String?
        var fetch: @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)

        static let live = Deps(
            loadAPIKey: {
                let override = ProcessInfo.processInfo.environment["CODEBURN_COMMANDCODE_DIR"] ?? ""
                let root = override.isEmpty
                    ? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".commandcode")
                    : URL(fileURLWithPath: override)
                return apiKey(fromAuthFile: root.appendingPathComponent("auth.json"))
            },
            fetch: { request in
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let http = response as? HTTPURLResponse else { throw FetchError.network }
                return (data, http)
            }
        )
    }

    static func apiKey(fromAuthFile url: URL) -> String? {
        guard let data = try? Data(contentsOf: url),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let key = (root["apiKey"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !key.isEmpty else { return nil }
        return key
    }

    @MainActor
    static func refresh(deps: Deps = .live) async throws -> QuotaSummary {
        let loadAPIKey = deps.loadAPIKey
        guard let key = await Task.detached(operation: { loadAPIKey() }).value else {
            throw FetchError.noCredentials
        }

        func request(_ url: URL) -> URLRequest {
            var request = URLRequest(url: url)
            request.httpMethod = "GET"
            request.timeoutInterval = timeoutSeconds
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
            // The API refuses requests without a User-Agent it recognizes.
            request.setValue("CodeBurn", forHTTPHeaderField: "User-Agent")
            return request
        }

        let fetch = deps.fetch
        async let subscription = try? fetch(request(subscriptionsURL))
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await fetch(request(creditsURL))
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

        var planID: String?
        if let (body, http) = await subscription, http.statusCode == 200,
           let root = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
            planID = (root["data"] as? [String: Any])?["planId"] as? String
        }
        return try decode(data, planID: planID)
    }

    static func decode(_ data: Data, planID: String? = nil) throws -> QuotaSummary {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw FetchError.parseFailure
        }
        let limits = root["windowLimits"] as? [String: Any] ?? [:]
        let fiveHour = window("5-hour", limits["fiveHour"])
        let weekly = window("Weekly", limits["weekly"])
        let details = [fiveHour, weekly].compactMap { $0 }
        guard !details.isEmpty else { throw FetchError.parseFailure }
        return QuotaSummary(
            providerFilter: .all,
            connection: .connected,
            primary: weekly ?? fiveHour,
            details: details,
            planLabel: planLabel(planID),
            footerLines: creditsLine(root["credits"]).map { [$0] } ?? []
        )
    }

    /// "individual-go-v1" -> "Go". Unknown shapes pass through unchanged.
    static func planLabel(_ planID: String?) -> String? {
        guard var core = planID?.trimmingCharacters(in: .whitespacesAndNewlines), !core.isEmpty else { return nil }
        if core.hasPrefix("individual-") { core.removeFirst("individual-".count) }
        if let range = core.range(of: "-v[0-9]+$", options: .regularExpression) { core.removeSubrange(range) }
        return core.prefix(1).uppercased() + core.dropFirst()
    }

    private static func window(_ label: String, _ raw: Any?) -> QuotaSummary.Window? {
        guard let row = raw as? [String: Any],
              let used = number(row["used"]),
              let cap = number(row["cap"]), cap > 0 else { return nil }
        let resetAt = number(row["resetAt"]) ?? 0
        return QuotaSummary.Window(
            label: label,
            percent: min(1, max(0, used / cap)),
            resetsAt: resetAt > 0 ? Date(timeIntervalSince1970: resetAt / 1000) : nil
        )
    }

    private static func creditsLine(_ raw: Any?) -> String? {
        guard let credits = raw as? [String: Any] else { return nil }
        let parts = [("monthlyCredits", "monthly"), ("purchasedCredits", "purchased"), ("freeCredits", "free")]
            .compactMap { key, name in number(credits[key]).map { (name, $0) } }
        guard !parts.isEmpty else { return nil }
        let shown = parts.filter { $0.1 > 0 }
        guard !shown.isEmpty else { return "Credits left: $0.00" }
        return "Credits left: " + shown.map { String(format: "$%.2f %@", $0.1, $0.0) }.joined(separator: ", ")
    }

    private static func number(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let double = number.doubleValue
        return double.isFinite ? double : nil
    }
}
