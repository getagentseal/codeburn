import Foundation
import Security

/// Owns the lifecycle of Claude OAuth credentials end-to-end. Replaces
/// SubscriptionClient + SubscriptionRefreshGate with a model that mirrors
/// CodexBar's proven pattern:
///
///   1. **Bootstrap is user-initiated.** The first read of Claude's keychain
///      entry — which triggers a macOS keychain prompt — only happens when
///      the user clicks "Connect" in the Plan tab. The menubar does not
///      touch Claude's keychain on launch.
///
///   2. **We persist refreshed tokens.** When Anthropic returns a new access
///      token (or a rotated refresh token) we write it back to our own keychain
///      item. The next fetch uses it directly — one API call per cycle, not
///      three. This was the root cause of "connect once, never updates": the
///      previous code refreshed on every tick because the new token was
///      thrown away.
///
///   3. **Our own keychain item, not Claude's.** We bootstrap from Claude's
///      entry once, then maintain `com.codeburn.menubar.claude.oauth.v1` in
///      the user's keychain. Subsequent reads do not prompt because we own
///      that item's ACL.
///
///   4. **In-memory cache (5 min)** so back-to-back reads in the same refresh
///      cycle don't even hit the keychain.
enum ClaudeCredentialStore {
    private static let bootstrapCompletedKey = "codeburn.claude.bootstrapCompleted"
    private static let inMemoryTTL: TimeInterval = 5 * 60
    private static let proactiveRefreshMargin: TimeInterval = 5 * 60

    private static let oauthClientID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
    private static let refreshURL = URL(string: "https://platform.claude.com/v1/oauth/token")!

    private static let claudeKeychainService = "Claude Code-credentials"
    private static let credentialsRelativePath = ".claude/.credentials.json"
    private static let maxCredentialBytes = 64 * 1024

    /// Local cache file. Stored under Application Support with 0600 permissions
    /// so only the current user can read it. We deliberately do NOT use the
    /// macOS Keychain for our own cache: keychain ACLs are bound to the binary
    /// code signature, so reading our own item triggers a prompt every time the
    /// binary changes (debug rebuilds, app updates with re-signing). Putting the
    /// cache in a plain file means the only Keychain prompt our user ever sees
    /// is the initial Connect read of Claude Code's own keychain entry.
    /// Threat model: same as ~/.claude/.credentials.json (also plaintext).
    private static let cacheFilename = "claude-credentials.v1.json"

    private static let lock = NSLock()
    private nonisolated(unsafe) static var memoryCache: CachedRecord?

    struct CachedRecord {
        let record: CredentialRecord
        let cachedAt: Date

        var isFresh: Bool { Date().timeIntervalSince(cachedAt) < ClaudeCredentialStore.inMemoryTTL }
    }

    struct CredentialRecord: Codable, Equatable {
        let accessToken: String
        let refreshToken: String?
        let expiresAt: Date?
        let rateLimitTier: String?
    }

    enum StoreError: Error, LocalizedError {
        case bootstrapNoSource           // neither file nor Claude keychain has credentials
        case bootstrapDecodeFailed
        case keychainWriteFailed(OSStatus)
        case keychainReadFailed(OSStatus)
        case refreshHTTPError(Int, String?)
        case refreshNetworkError(Error)
        case refreshDecodeFailed
        case noRefreshToken

        var errorDescription: String? {
            switch self {
            case .bootstrapNoSource:
                return "No Claude credentials found. Sign in with `claude` first."
            case .bootstrapDecodeFailed:
                return "Claude credentials are malformed."
            case let .keychainWriteFailed(status):
                return "Could not write to keychain (status \(status))."
            case let .keychainReadFailed(status):
                return "Could not read from keychain (status \(status))."
            case let .refreshHTTPError(code, body):
                return "Token refresh failed (HTTP \(code))\(body.map { ": \($0)" } ?? "")"
            case let .refreshNetworkError(err):
                return "Token refresh network error: \(err.localizedDescription)"
            case .refreshDecodeFailed:
                return "Token refresh response was malformed."
            case .noRefreshToken:
                return "No refresh token available; reconnect required."
            }
        }

        /// True when the failure means the user must re-authenticate (re-run
        /// `claude` or click Reconnect). Used by the UI to distinguish between
        /// "try again later" and "you must act".
        var isTerminal: Bool {
            if case let .refreshHTTPError(code, body) = self, code >= 400, code < 500 {
                let lower = body?.lowercased() ?? ""
                if lower.contains("invalid_grant") || lower.contains("invalid_client") || lower.contains("invalid_token") {
                    return true
                }
                return true   // 4xx other than rate-limiting is terminal too
            }
            if case .noRefreshToken = self { return true }
            return false
        }
    }

    // MARK: - Bootstrap state

    /// True once the user has explicitly connected (clicked Connect in the Plan
    /// tab AND we successfully read their credentials). Persists across launches.
    static var isBootstrapCompleted: Bool {
        get { UserDefaults.standard.bool(forKey: bootstrapCompletedKey) }
        set { UserDefaults.standard.set(newValue, forKey: bootstrapCompletedKey) }
    }

    /// Reset bootstrap state. Used when the user explicitly wants to disconnect
    /// or when the refresh token has been revoked terminally.
    static func resetBootstrap() {
        lock.withLock { memoryCache = nil }
        deleteOurCache()
        isBootstrapCompleted = false
    }

    // MARK: - Public API

    /// User-initiated entry point. Reads from Claude's source (PROMPTS for the
    /// keychain on first use), writes to our own keychain item, marks bootstrap
    /// as completed.
    @discardableResult
    static func bootstrap() throws -> CredentialRecord {
        let record = try readClaudeSource()
        try writeOurCache(record: record)
        isBootstrapCompleted = true
        cacheInMemory(record)
        return record
    }

    /// Silent read for background refresh cycles. Reads only from our cache /
    /// keychain item — never prompts. Returns nil if not bootstrapped.
    static func currentRecord() throws -> CredentialRecord? {
        guard isBootstrapCompleted else { return nil }
        // Honour the in-memory TTL: a stale cached record can mask a token
        // that another process (e.g. claude /login again) has just rotated
        // on disk. Re-read the file when the cache passes the TTL.
        if let cached = lock.withLock({ memoryCache }), cached.isFresh {
            return cached.record
        }
        if let stored = try readOurCache() {
            cacheInMemory(stored)
            return stored
        }
        // Bootstrap flag is set but our cache file is missing — most likely
        // a fresh install resetting state, or the user manually deleted the
        // file. Force re-bootstrap on next user action.
        isBootstrapCompleted = false
        return nil
    }

    /// Returns a token guaranteed to be either fresh or just-refreshed. If the
    /// current token expires within `proactiveRefreshMargin`, refreshes ahead
    /// of time and persists the new token.
    static func freshAccessToken() async throws -> String? {
        guard let record = try currentRecord() else { return nil }
        if let expiresAt = record.expiresAt, expiresAt.timeIntervalSinceNow < proactiveRefreshMargin {
            let updated = try await refreshAndPersist(record: record)
            return updated.accessToken
        }
        return record.accessToken
    }

    /// Called after an explicit 401. Refreshes, persists, returns the new token.
    static func refreshAfter401() async throws -> String {
        guard let record = try currentRecord() else { throw StoreError.noRefreshToken }
        let updated = try await refreshAndPersist(record: record)
        return updated.accessToken
    }

    static func subscriptionTier() throws -> String? {
        try currentRecord()?.rateLimitTier
    }

    // MARK: - Bootstrap source

    private static func readClaudeSource() throws -> CredentialRecord {
        if let fromFile = try? readClaudeFile() { return fromFile }
        if let fromKeychain = try readClaudeKeychain() { return fromKeychain }
        throw StoreError.bootstrapNoSource
    }

    private static func readClaudeFile() throws -> CredentialRecord? {
        let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(credentialsRelativePath)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let data = try SafeFile.read(from: url.path, maxBytes: maxCredentialBytes)
        return try parseClaudeBlob(data: sanitizeClaudeBlob(data))
    }

    /// Reads Claude's keychain credentials. The CLI has historically written
    /// entries under different account names — older versions used "agentseal"
    /// (a hardcoded company-style identifier) while Claude Code 2.1.x writes
    /// under `$USER` (NSUserName()). After a user re-runs `/login`, both
    /// entries can coexist and `SecItemCopyMatching` with kSecMatchLimitOne
    /// often returns the older stale one. We try the user-keyed entry first
    /// (the modern format), then fall back to the unscoped query for older
    /// installations.
    private static func readClaudeKeychain() throws -> CredentialRecord? {
        if let record = try readClaudeKeychain(account: NSUserName()) {
            return record
        }
        return try readClaudeKeychain(account: nil)
    }

    private static func readClaudeKeychain(account: String?) throws -> CredentialRecord? {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: claudeKeychainService,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecReturnData as String: true,
        ]
        if let account { query[kSecAttrAccount as String] = account }
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw StoreError.keychainReadFailed(status)
        }
        return try parseClaudeBlob(data: sanitizeClaudeBlob(data))
    }

    /// Claude Code's keychain writer line-wraps long values (newline + leading
    /// spaces) mid-token, producing JSON with literal control chars inside string
    /// values. Strip those plus pretty-print indentation between fields so the
    /// JSON parser succeeds.
    private static func sanitizeClaudeBlob(_ data: Data) -> Data {
        guard var s = String(data: data, encoding: .utf8) else { return data }
        s = s.replacingOccurrences(of: "\r", with: "")
        if let regex = try? NSRegularExpression(pattern: "\\n[ \\t]*", options: []) {
            let range = NSRange(s.startIndex..<s.endIndex, in: s)
            s = regex.stringByReplacingMatches(in: s, options: [], range: range, withTemplate: "")
        }
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return s.data(using: .utf8) ?? data
    }

    private static func parseClaudeBlob(data: Data) throws -> CredentialRecord {
        struct Root: Decodable { let claudeAiOauth: OAuth? }
        struct OAuth: Decodable {
            let accessToken: String?
            let refreshToken: String?
            let expiresAt: Double?
            let rateLimitTier: String?
        }
        do {
            let root = try JSONDecoder().decode(Root.self, from: data)
            guard let oauth = root.claudeAiOauth,
                  let token = oauth.accessToken?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !token.isEmpty
            else { throw StoreError.bootstrapDecodeFailed }
            return CredentialRecord(
                accessToken: token,
                refreshToken: oauth.refreshToken,
                expiresAt: oauth.expiresAt.map { Date(timeIntervalSince1970: $0 / 1000.0) },
                rateLimitTier: oauth.rateLimitTier
            )
        } catch {
            throw StoreError.bootstrapDecodeFailed
        }
    }

    // MARK: - Local cache file (no keychain involvement)

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
        // Route through SafeFile.read so we lstat for symlinks before opening
        // and bound the read with maxCredentialBytes. Without this, an
        // attacker who can plant a symlink in ~/Library/Application Support/
        // CodeBurn/ between disconnect and reconnect could redirect our read
        // to /dev/zero (unbounded memory) or another file the user owns.
        let data = try SafeFile.read(from: url.path, maxBytes: maxCredentialBytes)
        return try? JSONDecoder().decode(CredentialRecord.self, from: data)
    }

    private static func writeOurCache(record: CredentialRecord) throws {
        let url = cacheFileURL()
        let data = try JSONEncoder().encode(record)
        // SafeFile.write opens the temp file with O_CREAT | O_EXCL | O_NOFOLLOW
        // and the explicit 0600 mode in a single syscall — no race window
        // where the file briefly exists at default umask, and no chance of
        // following a malicious symlink at the destination path. Also creates
        // the parent dir at 0700.
        try SafeFile.write(data, to: url.path, mode: 0o600)
    }

    private static func deleteOurCache() {
        try? FileManager.default.removeItem(at: cacheFileURL())
    }

    private static func cacheInMemory(_ record: CredentialRecord) {
        lock.withLock { memoryCache = CachedRecord(record: record, cachedAt: Date()) }
    }

    // MARK: - Refresh

    private static func refreshAndPersist(record: CredentialRecord) async throws -> CredentialRecord {
        guard let refreshToken = record.refreshToken, !refreshToken.isEmpty else {
            throw StoreError.noRefreshToken
        }

        var request = URLRequest(url: refreshURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        var components = URLComponents()
        components.queryItems = [
            URLQueryItem(name: "grant_type", value: "refresh_token"),
            URLQueryItem(name: "refresh_token", value: refreshToken),
            URLQueryItem(name: "client_id", value: oauthClientID),
        ]
        request.httpBody = (components.percentEncodedQuery ?? "").data(using: .utf8)

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
            let accessToken: String
            let refreshToken: String?
            let expiresIn: Int?
            enum CodingKeys: String, CodingKey {
                case accessToken = "access_token"
                case refreshToken = "refresh_token"
                case expiresIn = "expires_in"
            }
        }
        guard let decoded = try? JSONDecoder().decode(RefreshResponse.self, from: data) else {
            throw StoreError.refreshDecodeFailed
        }

        // Anthropic may rotate the refresh token. If it did, the OLD one is
        // already invalid server-side — discarding the new one would lock
        // the user out permanently. So we cache the new record in memory
        // BEFORE attempting the keychain write, and if the write fails we
        // still return the new record (memory cache will serve subsequent
        // calls inside the 5-min TTL while we keep retrying the persist).
        let updated = CredentialRecord(
            accessToken: decoded.accessToken,
            refreshToken: decoded.refreshToken ?? record.refreshToken,
            expiresAt: decoded.expiresIn.map { Date().addingTimeInterval(TimeInterval($0)) } ?? record.expiresAt,
            rateLimitTier: record.rateLimitTier
        )
        cacheInMemory(updated)
        do {
            try writeOurCache(record: updated)
        } catch {
            // Best effort — surface to logs but do not abandon the rotated
            // token. Next refresh will retry persistence; UI will continue
            // working from the in-memory cache.
            NSLog("CodeBurn: cache write failed during refresh rotation: %@", String(describing: error))
        }
        return updated
    }
}

private extension NSLock {
    func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock(); defer { unlock() }
        return try body()
    }
}
