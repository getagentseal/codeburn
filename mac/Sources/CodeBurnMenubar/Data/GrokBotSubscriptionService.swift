import Foundation

/// Live Grok Bot weekly allowance, read from the same Cursor dashboard call the
/// desktop app makes for its own "Weekly usage" reading.
///
/// The credential is the Cursor IDE's own access token, which
/// `CursorAppSessionStore` already reads read-only; Grok Bot keeps its own copy
/// of the same session in Electron safe storage, which CodeBurn never decrypts.
/// So this is Grok Bot's reading only while the Cursor app is signed into the
/// account Grok Bot uses — with Cursor signed out the row reports the same
/// signed-out state the Cursor row does.
enum GrokBotSubscriptionService {
    static let usageURL = URL(
        string: "https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus"
    )!
    static let appBundleName = "Grok Bot.app"
    private static let timeoutSeconds: TimeInterval = 15

    /// The app ships as a normal drag-install, so either Applications folder
    /// counts; `~/.grokbot` is its data root, which survives a moved bundle.
    static func isInstalled(
        home: URL = FileManager.default.homeDirectoryForCurrentUser,
        systemApplications: URL = URL(fileURLWithPath: "/Applications", isDirectory: true)
    ) -> Bool {
        [
            systemApplications.appendingPathComponent(appBundleName, isDirectory: true),
            home.appendingPathComponent("Applications/\(appBundleName)", isDirectory: true),
            home.appendingPathComponent(".grokbot", isDirectory: true),
        ].contains { FileManager.default.fileExists(atPath: $0.path) }
    }

    enum FetchError: Error, Equatable, LocalizedError, Sendable {
        case notInstalled
        case noCredentials
        case authenticationRejected
        case appDataUnreadable
        case noIncludedAllowance
        case pooledAllowance
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
            case .notInstalled, .noCredentials, .authenticationRejected,
                 .noIncludedAllowance, .pooledAllowance:
                .terminalAuth
            case .appDataUnreadable, .rateLimited, .providerUnavailable, .network:
                .transient
            case .parseFailure:
                .parseFailure
            }
        }

        var errorDescription: String? {
            switch self {
            case .notInstalled:
                L("Grok Bot is not installed. Install the Grok Bot app, then click Retry.")
            case .noCredentials:
                L("Sign in to the Cursor app with the account Grok Bot uses, then click Retry.")
            case .authenticationRejected:
                L("Cursor rejected the current app session. Sign in again, then click Retry.")
            case .appDataUnreadable:
                L("Could not read the Cursor app's local session data. Quit and reopen Cursor, then click Retry.")
            case .noIncludedAllowance:
                L("This account has no included Grok Bot allowance.")
            case .pooledAllowance:
                L("Grok Bot usage is drawn from a pooled enterprise allowance, which has no per-account reading.")
            case .rateLimited:
                L("Cursor rate-limited the quota request.")
            case .providerUnavailable:
                L("Grok Bot quota is temporarily unavailable.")
            case .parseFailure:
                L("Cursor returned an unrecognized Grok Bot quota response.")
            case .network:
                L("Network error fetching Grok Bot quota.")
            }
        }
    }

    struct Deps: Sendable {
        var isInstalled: @Sendable () -> Bool
        var loadAccessToken: @Sendable () throws -> String?
        var fetch: @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)

        static let live = Deps(
            isInstalled: { GrokBotSubscriptionService.isInstalled() },
            loadAccessToken: {
                try CursorAppSessionStore().loadAccessToken()
            },
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
    static func refresh(deps: Deps = .live) async throws -> QuotaSummary {
        guard deps.isInstalled() else { throw FetchError.notInstalled }

        let accessToken: String
        do {
            // Synchronous SQLite with a busy timeout: keep it off the main
            // actor so a lock held by Cursor cannot stall the UI.
            let loadAccessToken = deps.loadAccessToken
            let raw = try await Task.detached { try loadAccessToken() }.value
            guard let loaded = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !loaded.isEmpty else {
                throw FetchError.noCredentials
            }
            accessToken = loaded
        } catch let error as FetchError {
            throw error
        } catch {
            throw FetchError.appDataUnreadable
        }

        var request = URLRequest(url: usageURL)
        request.httpMethod = "POST"
        request.timeoutInterval = timeoutSeconds
        request.httpBody = Data("{}".utf8)
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("1", forHTTPHeaderField: "connect-protocol-version")
        request.setValue("CodeBurn", forHTTPHeaderField: "User-Agent")

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
        case 200...299:
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
        let status: UsageStatus
        do {
            status = try JSONDecoder().decode(UsageStatus.self, from: data)
        } catch {
            throw FetchError.parseFailure
        }
        // Both refusals mirror the app itself, which shows no reading rather
        // than a zero the account cannot act on.
        if status.usesPooledEnterpriseAllowance == true { throw FetchError.pooledAllowance }
        if status.hasNonZeroIncludedLimit == false { throw FetchError.noIncludedAllowance }

        guard let raw = status.usagePercent, raw.isFinite, raw >= 0 else {
            throw FetchError.parseFailure
        }
        // No window length: the reset timestamps are seven days apart, but the
        // percentage is a capacity reading rather than a metered window, so the
        // early-reset monitor must stay quiet about it (#1339).
        let window = QuotaSummary.Window(
            label: "Weekly usage",
            percent: min(1, raw / 100),
            resetsAt: parseDate(status.nextResetTimestampUtc)
        )
        return QuotaSummary(
            providerFilter: .all,
            connection: .connected,
            primary: window,
            details: [window],
            planLabel: normalizedPlan(status.grokPlanLabel),
            footerLines: ["Source: Cursor dashboard (the account the Cursor app is signed into)"]
        )
    }

    private struct UsageStatus: Decodable {
        let usagePercent: Double?
        let nextResetTimestampUtc: String?
        let hasNonZeroIncludedLimit: Bool?
        let usesPooledEnterpriseAllowance: Bool?
        let grokPlanLabel: String?
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
        return value
    }
}
