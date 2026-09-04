import Foundation

/// Live GLM Coding Plan quota from Z.ai's usage endpoint. Reuses an existing
/// Pi login when present, or a provider-scoped Keychain override. This adapter
/// never persists or logs the key.
enum ZaiSubscriptionService {
    static let usageURL = URL(string: "https://api.z.ai/api/monitor/usage/quota/limit")!
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
                L("Sign in to Z.ai with Pi, or enter a Coding Plan API key and press Save & Connect.")
            case .authenticationRejected:
                L("Z.ai rejected this API key.")
            case .rateLimited:
                L("Z.ai rate-limited the quota request.")
            case .providerUnavailable:
                L("Z.ai is temporarily unavailable.")
            case .parseFailure:
                L("Z.ai returned an unrecognized quota response.")
            case .network:
                L("Network error fetching Z.ai quota.")
            }
        }
    }

    struct Deps: Sendable {
        var loadAPIKey: @Sendable () throws -> String?
        var fetch: @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)

        static let live = Deps(
            loadAPIKey: { try loadPiAPIKey() },
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
    static func refresh(apiKey: String? = nil, deps: Deps = .live) async throws -> QuotaSummary {
        var key = apiKey?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if key.isEmpty {
            let loadAPIKey = deps.loadAPIKey
            key = try await Task.detached { try loadAPIKey() }.value ?? ""
        }
        guard !key.isEmpty else { throw FetchError.noCredentials }

        var request = URLRequest(url: usageURL)
        request.httpMethod = "GET"
        request.timeoutInterval = timeoutSeconds
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("en-US,en", forHTTPHeaderField: "Accept-Language")
        request.setValue(key, forHTTPHeaderField: "Authorization")
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

    static func decode(_ data: Data) throws -> QuotaSummary {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw FetchError.parseFailure
        }
        let bodyCode = jsonNumber(root["code"]).map(Int.init)
        if bodyCode == 401 || bodyCode == 403 { throw FetchError.authenticationRejected }
        if root["success"] as? Bool == false { throw FetchError.parseFailure }

        let payload = (root["data"] as? [String: Any]) ?? root
        guard let limits = payload["limits"] as? [Any] else { throw FetchError.parseFailure }

        var fiveHour: QuotaSummary.Window?
        var weekly: QuotaSummary.Window?

        for raw in limits {
            guard let limit = raw as? [String: Any],
                  let type = limit["type"] as? String,
                  type == "CREDIT_LIMIT" || type == "TOKENS_LIMIT",
                  let unit = jsonNumber(limit["unit"]),
                  let count = jsonNumber(limit["number"]) else { continue }

            let label: String
            let isWeekly: Bool
            if unit == 3, count == 5 {
                label = L("5-hour")
                isWeekly = false
            } else if unit == 6, count == 1 {
                label = L("Weekly")
                isWeekly = true
            } else {
                continue
            }

            var usedPercent = jsonNumber(limit["percentage"])
            if usedPercent == nil,
               let current = jsonNumber(limit["currentValue"]),
               let total = jsonNumber(limit["usage"]), total > 0 {
                usedPercent = current / total * 100
            }
            guard let usedPercent else { continue }

            let window = QuotaSummary.Window(
                label: label,
                percent: min(1, max(0, usedPercent / 100)),
                resetsAt: parseReset(limit["nextResetTime"])
            )
            if isWeekly { weekly = window } else { fiveHour = window }
        }

        let details = [fiveHour, weekly].compactMap { $0 }
        guard !details.isEmpty else { throw FetchError.parseFailure }
        return QuotaSummary(
            providerFilter: .all,
            connection: .connected,
            primary: weekly ?? fiveHour,
            details: details,
            planLabel: planLabel(payload["level"]),
            footerLines: ["Source: Z.ai Coding Plan"]
        )
    }

    static func loadPiAPIKey(
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) throws -> String? {
        let path = home
            .appendingPathComponent(".pi/agent/auth.json", isDirectory: false)
            .path
        guard FileManager.default.fileExists(atPath: path) else { return nil }
        let data = try SafeFile.read(from: path, maxBytes: 64 * 1024)
        guard let auth = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let entry = auth["zai"] as? [String: Any] else { return nil }
        let key = (entry["key"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return key?.isEmpty == false ? key : nil
    }

    private static func jsonNumber(_ value: Any?) -> Double? {
        if let value = value as? Double, value.isFinite { return value }
        if let value = value as? NSNumber { return value.doubleValue }
        if let value = value as? String, let number = Double(value), number.isFinite { return number }
        return nil
    }

    private static func parseReset(_ value: Any?) -> Date? {
        if let number = jsonNumber(value) {
            let seconds = number < 1_000_000_000_000 ? number : number / 1000
            return seconds.isFinite ? Date(timeIntervalSince1970: seconds) : nil
        }
        guard let value = value as? String else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    private static func planLabel(_ value: Any?) -> String? {
        guard let value = value as? String else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return trimmed.replacingOccurrences(of: "_", with: " ").lowercased().capitalized
    }
}
