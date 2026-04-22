import Foundation
import Security

private let credentialsRelativePath = ".claude/.credentials.json"
private let keychainService = "Claude Code-credentials"
private let oauthClientID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
private let refreshURL = URL(string: "https://platform.claude.com/v1/oauth/token")!
private let usageURL = URL(string: "https://api.anthropic.com/api/oauth/usage")!
private let betaHeader = "oauth-2025-04-20"
private let userAgent = "claude-code/2.1.0"
private let requestTimeout: TimeInterval = 30

private let maxCredentialBytes = 64 * 1024

enum SubscriptionError: Error, LocalizedError {
    case noCredentials
    case credentialsInvalid
    case refreshFailed(Int, String?)
    case usageFetchFailed(Int, String?)
    case decodeFailed(Error)

    var errorDescription: String? {
        switch self {
        case .noCredentials: "No Claude OAuth credentials found"
        case .credentialsInvalid: "Claude OAuth credentials malformed"
        case let .refreshFailed(code, body): "Token refresh failed (\(code))\(body.map { ": \($0)" } ?? "")"
        case let .usageFetchFailed(code, body): "Usage fetch failed (\(code))\(body.map { ": \($0)" } ?? "")"
        case let .decodeFailed(err): "Decode failed: \(err.localizedDescription)"
        }
    }
}

struct SubscriptionClient {
    static func fetch() async throws -> SubscriptionUsage {
        let creds = try loadCredentials()

        // Try the usage call with the existing token first. Only refresh on 401.
        do {
            let response = try await fetchUsage(token: creds.accessToken)
            return mapResponse(response, rawTier: creds.rateLimitTier)
        } catch SubscriptionError.usageFetchFailed(401, _) {
            guard let refreshToken = creds.refreshToken, !refreshToken.isEmpty else {
                throw SubscriptionError.usageFetchFailed(401, "no refresh token available")
            }
            let newToken = try await refreshAccessToken(refreshToken: refreshToken)
            let response = try await fetchUsage(token: newToken)
            return mapResponse(response, rawTier: creds.rateLimitTier)
        }
    }

    // MARK: - Credentials

    private static func loadCredentials() throws -> StoredCredentials {
        if let data = try readFileCredentials() {
            return try parseCredentials(data: sanitizeKeychainData(data))
        }
        if let creds = try readKeychainCredentials() {
            return creds
        }
        throw SubscriptionError.noCredentials
    }

    private static func readFileCredentials() throws -> Data? {
        let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(credentialsRelativePath)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        // SafeFile refuses to follow symlinks and caps the read, so a 6 GB /dev/urandom
        // masquerading as the creds file can't blow up the app.
        return try SafeFile.read(from: url.path, maxBytes: maxCredentialBytes)
    }

    private static func readKeychainCredentials() throws -> StoredCredentials? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecReturnData as String: true,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            NSLog("CodeBurn: keychain query failed status=\(status)")
            return nil
        }
        return try parseCredentials(data: sanitizeKeychainData(data))
    }

    /// Claude Code's keychain writer line-wraps long string values (newline + leading spaces)
    /// mid-token, producing JSON with literal control chars and stray spaces inside string
    /// values. Replace every newline (CR/LF) plus the run of spaces/tabs that follows it.
    /// Drops both the wrapping in tokens AND pretty-print indentation between fields (both
    /// produce valid, compact JSON afterward).
    private static func sanitizeKeychainData(_ data: Data) -> Data {
        guard var s = String(data: data, encoding: .utf8) else { return data }
        s = s.replacingOccurrences(of: "\r", with: "")
        let regex = try? NSRegularExpression(pattern: "\\n[ \\t]*", options: [])
        if let regex {
            let range = NSRange(s.startIndex..<s.endIndex, in: s)
            s = regex.stringByReplacingMatches(in: s, options: [], range: range, withTemplate: "")
        }
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return s.data(using: .utf8) ?? data
    }

    /// Decodes the credential JSON blob. Never logs the blob contents or any slice of it --
    /// even a partial access token reaching Console.app is a leak, and the byte-window
    /// diagnostic that used to live here could overlap the `accessToken` field bytes.
    private static func parseCredentials(data: Data) throws -> StoredCredentials {
        do {
            let root = try JSONDecoder().decode(CredentialsRoot.self, from: data)
            guard let oauth = root.claudeAiOauth else { throw SubscriptionError.credentialsInvalid }
            let token = oauth.accessToken?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !token.isEmpty else { throw SubscriptionError.credentialsInvalid }
            let expiresAt = oauth.expiresAt.map { Date(timeIntervalSince1970: $0 / 1000.0) }
            return StoredCredentials(
                accessToken: token,
                refreshToken: oauth.refreshToken,
                expiresAt: expiresAt,
                rateLimitTier: oauth.rateLimitTier
            )
        } catch let err as SubscriptionError {
            throw err
        } catch {
            throw SubscriptionError.decodeFailed(error)
        }
    }

    // MARK: - Refresh

    private static func refreshAccessToken(refreshToken: String) async throws -> String {
        var request = URLRequest(url: refreshURL)
        request.httpMethod = "POST"
        request.timeoutInterval = requestTimeout
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        var components = URLComponents()
        components.queryItems = [
            URLQueryItem(name: "grant_type", value: "refresh_token"),
            URLQueryItem(name: "refresh_token", value: refreshToken),
            URLQueryItem(name: "client_id", value: oauthClientID),
        ]
        request.httpBody = (components.percentEncodedQuery ?? "").data(using: .utf8)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw SubscriptionError.refreshFailed(-1, nil)
        }
        guard http.statusCode == 200 else {
            let body = String(data: data, encoding: .utf8)
            throw SubscriptionError.refreshFailed(http.statusCode, body)
        }
        do {
            let decoded = try JSONDecoder().decode(TokenRefreshResponse.self, from: data)
            return decoded.accessToken
        } catch {
            throw SubscriptionError.decodeFailed(error)
        }
    }

    // MARK: - Usage fetch

    private static func fetchUsage(token: String) async throws -> UsageResponse {
        var request = URLRequest(url: usageURL)
        request.httpMethod = "GET"
        request.timeoutInterval = requestTimeout
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(betaHeader, forHTTPHeaderField: "anthropic-beta")
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw SubscriptionError.usageFetchFailed(-1, nil)
        }
        guard http.statusCode == 200 else {
            let body = String(data: data, encoding: .utf8)
            throw SubscriptionError.usageFetchFailed(http.statusCode, body)
        }
        do {
            return try JSONDecoder().decode(UsageResponse.self, from: data)
        } catch {
            throw SubscriptionError.decodeFailed(error)
        }
    }

    // MARK: - Mapping

    private static func mapResponse(_ r: UsageResponse, rawTier: String?) -> SubscriptionUsage {
        SubscriptionUsage(
            tier: SubscriptionUsage.tier(from: rawTier),
            rawTier: rawTier,
            fiveHourPercent: r.fiveHour?.utilization,
            fiveHourResetsAt: parseDate(r.fiveHour?.resetsAt),
            sevenDayPercent: r.sevenDay?.utilization,
            sevenDayResetsAt: parseDate(r.sevenDay?.resetsAt),
            sevenDayOpusPercent: r.sevenDayOpus?.utilization,
            sevenDayOpusResetsAt: parseDate(r.sevenDayOpus?.resetsAt),
            sevenDaySonnetPercent: r.sevenDaySonnet?.utilization,
            sevenDaySonnetResetsAt: parseDate(r.sevenDaySonnet?.resetsAt),
            fetchedAt: Date()
        )
    }

    private static func parseDate(_ s: String?) -> Date? {
        guard let s, !s.isEmpty else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }
}

// MARK: - Internal models

private struct StoredCredentials {
    let accessToken: String
    let refreshToken: String?
    let expiresAt: Date?
    let rateLimitTier: String?
}

private struct CredentialsRoot: Decodable {
    let claudeAiOauth: OAuthBlock?
}

private struct OAuthBlock: Decodable {
    let accessToken: String?
    let refreshToken: String?
    let expiresAt: Double?
    let rateLimitTier: String?
}

private struct TokenRefreshResponse: Decodable {
    let accessToken: String
    let refreshToken: String?
    let expiresIn: Int?

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case expiresIn = "expires_in"
    }
}

private struct UsageResponse: Decodable {
    let fiveHour: Window?
    let sevenDay: Window?
    let sevenDayOpus: Window?
    let sevenDaySonnet: Window?

    enum CodingKeys: String, CodingKey {
        case fiveHour = "five_hour"
        case sevenDay = "seven_day"
        case sevenDayOpus = "seven_day_opus"
        case sevenDaySonnet = "seven_day_sonnet"
    }
}

private struct Window: Decodable {
    let utilization: Double?
    let resetsAt: String?

    enum CodingKeys: String, CodingKey {
        case utilization
        case resetsAt = "resets_at"
    }
}
