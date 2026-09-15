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
                "Sign in to Z.ai with Pi, or enter a Coding Plan API key and press Save & Connect."
            case .authenticationRejected:
                "Z.ai rejected this API key."
            case .rateLimited:
                "Z.ai rate-limited the quota request."
            case .providerUnavailable:
                "Z.ai is temporarily unavailable."
            case .parseFailure:
                "Z.ai returned an unrecognized quota response."
            case .network:
                "Network error fetching Z.ai quota."
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

    /// Shared body with ZaiSubscriptionService via ZaiPlanQuotaDecoder; only
    /// the error vocabulary differs between the two adapters.
    static func decode(_ data: Data) throws -> QuotaSummary {
        do {
            return try ZaiPlanQuotaDecoder.decode(data)
        } catch let error as ZaiPlanQuotaDecoder.DecodeError {
            switch error {
            case .authenticationRejected: throw FetchError.authenticationRejected
            case .parseFailure: throw FetchError.parseFailure
            }
        }
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

}
