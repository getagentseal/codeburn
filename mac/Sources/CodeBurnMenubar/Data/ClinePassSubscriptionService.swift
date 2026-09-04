import Foundation

/// Live ClinePass quota from the public usage-limits HTTP contract.
/// GET https://api.cline.bot/api/v1/users/me/plan/usage-limits with a bearer
/// API key. The caller supplies the key; this adapter never reads Keychain.
enum ClinePassSubscriptionService {
    static let usageURL = URL(string: "https://api.cline.bot/api/v1/users/me/plan/usage-limits")!
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
                return L("Enter a ClinePass API key or token, then press Save & Connect.")
            case .authenticationRejected:
                return L("ClinePass rejected this API key.")
            case .rateLimited:
                return L("ClinePass rate-limited the quota request.")
            case .providerUnavailable:
                return L("ClinePass is temporarily unavailable.")
            case .parseFailure:
                return L("ClinePass quota response was malformed.")
            case .network:
                return L("Network error fetching ClinePass quota.")
            }
        }
    }

    struct Deps: Sendable {
        var fetch: @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)

        static let live = Deps(
            fetch: { request in
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let http = response as? HTTPURLResponse else {
                    throw FetchError.network
                }
                return (data, http)
            }
        )
    }

    @MainActor
    static func refresh(apiKey: String, deps: Deps = .live) async throws -> QuotaSummary {
        let trimmed = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw FetchError.noCredentials }

        var request = URLRequest(url: usageURL)
        request.httpMethod = "GET"
        request.timeoutInterval = timeoutSeconds
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(trimmed)", forHTTPHeaderField: "Authorization")

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
            throw FetchError.authenticationRejected
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
            case "five_hour": label = L("5-hour")
            case "weekly": label = L("Weekly")
            case "monthly": label = L("Monthly")
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
