import Foundation

/// Owns the Codex (ChatGPT-mode) OAuth credential lifecycle. Mirrors
/// ClaudeCredentialStore but reads from ~/.codex/auth.json — Codex CLI
/// already stores its tokens as plaintext JSON in the home directory, so
/// no keychain prompt is involved on bootstrap. After the user clicks
/// Connect we cache a copy under ~/Library/Application Support/CodeBurn so
/// we keep using rotated tokens after refresh.
enum CodexCredentialStore {
    private static let bootstrapCompletedKey = "codeburn.codex.bootstrapCompleted"
    private static let inMemoryTTL: TimeInterval = 5 * 60
    private static let proactiveRefreshMargin: TimeInterval = 5 * 60

    private static let oauthClientID = "app_EMoamEEZ73f0CkXaXp7hrann"
    private static let refreshURL = URL(string: "https://auth.openai.com/oauth/token")!
    private static let codexAuthPath = ".codex/auth.json"
    private static let maxCredentialBytes = 64 * 1024

    private static let cacheFilename = "codex-credentials.v1.json"

    private static let lock = NSLock()
    private nonisolated(unsafe) static var memoryCache: CachedRecord?

    struct CachedRecord {
        let record: CredentialRecord
        let cachedAt: Date

        var isFresh: Bool { Date().timeIntervalSince(cachedAt) < CodexCredentialStore.inMemoryTTL }
    }

    struct CredentialRecord: Codable, Equatable {
        let accessToken: String
        let refreshToken: String
        let idToken: String?
        let accountId: String?
        let expiresAt: Date?
    }

    enum StoreError: Error, LocalizedError {
        case bootstrapNoSource
        case bootstrapDecodeFailed
        case bootstrapNotChatGPT     // user is on API-key mode; we need ChatGPT mode for quota
        case fileWriteFailed(String)
        case refreshHTTPError(Int, String?)
        case refreshNetworkError(Error)
        case refreshDecodeFailed
        case noRefreshToken

        var errorDescription: String? {
            switch self {
            case .bootstrapNoSource:
                return "No Codex credentials found at ~/.codex/auth.json. Run `codex` to sign in."
            case .bootstrapDecodeFailed:
                return "Codex credentials are malformed."
            case .bootstrapNotChatGPT:
                return "Codex is in API-key mode; live quota tracking is only available for ChatGPT subscriptions."
            case let .fileWriteFailed(message):
                return "Could not write to local cache: \(message)"
            case let .refreshHTTPError(code, body):
                return "Codex token refresh failed (HTTP \(code))\(body.map { ": \($0)" } ?? "")"
            case let .refreshNetworkError(err):
                return "Codex token refresh network error: \(err.localizedDescription)"
            case .refreshDecodeFailed:
                return "Codex token refresh response was malformed."
            case .noRefreshToken:
                return "No refresh token available; reconnect required."
            }
        }

        /// True when the user must take action: rerun `codex` to re-authenticate
        /// or switch from API-key to ChatGPT mode. Drives the red Reconnect path.
        var isTerminal: Bool {
            if case let .refreshHTTPError(code, body) = self, code >= 400, code < 500 {
                let lower = body?.lowercased() ?? ""
                if lower.contains("refresh_token_expired") ||
                    lower.contains("refresh_token_reused") ||
                    lower.contains("refresh_token_invalidated") ||
                    lower.contains("invalid_grant")
                {
                    return true
                }
                return true
            }
            switch self {
            case .noRefreshToken, .bootstrapNotChatGPT, .bootstrapNoSource: return true
            default: return false
            }
        }
    }

    // MARK: - Bootstrap state

    static var isBootstrapCompleted: Bool {
        get { UserDefaults.standard.bool(forKey: bootstrapCompletedKey) }
        set { UserDefaults.standard.set(newValue, forKey: bootstrapCompletedKey) }
    }

    static func resetBootstrap() {
        lock.withLock { memoryCache = nil }
        deleteOurCache()
        isBootstrapCompleted = false
    }

    // MARK: - Public API

    @discardableResult
    static func bootstrap() throws -> CredentialRecord {
        let record = try readCodexAuth()
        try writeOurCache(record: record)
        isBootstrapCompleted = true
        cacheInMemory(record)
        return record
    }

    static func currentRecord() throws -> CredentialRecord? {
        guard isBootstrapCompleted else { return nil }
        if let cached = lock.withLock({ memoryCache }), cached.isFresh {
            return cached.record
        }
        if let stored = try readOurCache() {
            cacheInMemory(stored)
            return stored
        }
        isBootstrapCompleted = false
        return nil
    }

    static func freshAccessToken() async throws -> String? {
        guard let record = try currentRecord() else { return nil }
        if let expiresAt = record.expiresAt, expiresAt.timeIntervalSinceNow < proactiveRefreshMargin {
            let updated = try await refreshAndPersist(record: record)
            return updated.accessToken
        }
        return record.accessToken
    }

    static func refreshAfter401() async throws -> String {
        guard let record = try currentRecord() else { throw StoreError.noRefreshToken }
        let updated = try await refreshAndPersist(record: record)
        return updated.accessToken
    }

    // MARK: - Bootstrap source: ~/.codex/auth.json

    private static func readCodexAuth() throws -> CredentialRecord {
        let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(codexAuthPath)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw StoreError.bootstrapNoSource
        }
        let data = try SafeFile.read(from: url.path, maxBytes: maxCredentialBytes)
        struct Root: Decodable {
            let auth_mode: String?
            let tokens: Tokens?
        }
        struct Tokens: Decodable {
            let access_token: String?
            let refresh_token: String?
            let id_token: String?
            let account_id: String?
        }
        do {
            let root = try JSONDecoder().decode(Root.self, from: data)
            // Live quota is only meaningful for ChatGPT-mode auth. API-key users
            // have a different billing surface (/v1/usage) which we do not yet
            // implement here.
            guard root.auth_mode == "chatgpt" else {
                throw StoreError.bootstrapNotChatGPT
            }
            guard let tokens = root.tokens,
                  let access = tokens.access_token?.trimmingCharacters(in: .whitespacesAndNewlines),
                  let refresh = tokens.refresh_token?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !access.isEmpty, !refresh.isEmpty
            else {
                throw StoreError.bootstrapDecodeFailed
            }
            return CredentialRecord(
                accessToken: access,
                refreshToken: refresh,
                idToken: tokens.id_token,
                accountId: tokens.account_id,
                expiresAt: nil   // Codex CLI does not record expiresAt in auth.json
            )
        } catch let err as StoreError {
            throw err
        } catch {
            throw StoreError.bootstrapDecodeFailed
        }
    }

    // MARK: - Local cache file

    private static func cacheFileURL() -> URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        return support
            .appendingPathComponent("CodeBurn", isDirectory: true)
            .appendingPathComponent(cacheFilename)
    }

    private static func readOurCache() throws -> CredentialRecord? {
        let url = cacheFileURL()
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        // Symlink-defense + size cap (same hardening as ClaudeCredentialStore).
        let data = try SafeFile.read(from: url.path, maxBytes: maxCredentialBytes)
        return try? JSONDecoder().decode(CredentialRecord.self, from: data)
    }

    private static func writeOurCache(record: CredentialRecord) throws {
        let url = cacheFileURL()
        let data = try JSONEncoder().encode(record)
        do {
            // SafeFile.write opens the temp file with O_CREAT | O_EXCL | O_NOFOLLOW
            // and the explicit 0600 mode in a single syscall — no race window
            // where the file briefly exists at default umask, and no chance of
            // following a malicious symlink at the destination path.
            try SafeFile.write(data, to: url.path, mode: 0o600)
        } catch {
            throw StoreError.fileWriteFailed(String(describing: error))
        }
    }

    private static func deleteOurCache() {
        try? FileManager.default.removeItem(at: cacheFileURL())
    }

    private static func cacheInMemory(_ record: CredentialRecord) {
        lock.withLock { memoryCache = CachedRecord(record: record, cachedAt: Date()) }
    }

    // MARK: - Refresh

    private static func refreshAndPersist(record: CredentialRecord) async throws -> CredentialRecord {
        guard !record.refreshToken.isEmpty else { throw StoreError.noRefreshToken }

        var request = URLRequest(url: refreshURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: String] = [
            "client_id": oauthClientID,
            "grant_type": "refresh_token",
            "refresh_token": record.refreshToken,
            "scope": "openid profile email",
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw StoreError.refreshNetworkError(error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw StoreError.refreshHTTPError(-1, nil)
        }
        guard http.statusCode == 200 else {
            let body = String(data: data, encoding: .utf8)
            throw StoreError.refreshHTTPError(http.statusCode, body)
        }

        struct RefreshResponse: Decodable {
            let access_token: String
            let refresh_token: String?
            let id_token: String?
            let expires_in: Int?
        }
        guard let decoded = try? JSONDecoder().decode(RefreshResponse.self, from: data) else {
            throw StoreError.refreshDecodeFailed
        }

        let updated = CredentialRecord(
            accessToken: decoded.access_token,
            refreshToken: decoded.refresh_token ?? record.refreshToken,
            idToken: decoded.id_token ?? record.idToken,
            accountId: record.accountId,
            expiresAt: decoded.expires_in.map { Date().addingTimeInterval(TimeInterval($0)) } ?? record.expiresAt
        )
        cacheInMemory(updated)
        do {
            try writeOurCache(record: updated)
        } catch {
            NSLog("CodeBurn: codex cache write failed during refresh rotation: %@", String(describing: error))
        }
        return updated
    }
}
