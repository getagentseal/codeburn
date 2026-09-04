import Foundation
import Security

/// Owns the Codex (ChatGPT-mode) OAuth credential lifecycle. Mirrors
/// ClaudeCredentialStore but reads from ~/.codex/auth.json — Codex CLI
/// already stores its tokens as owner-only JSON in the home directory. That
/// file remains authoritative: CodeBurn does not create another provider-
/// specific Keychain item or require a separate Connect ceremony.
enum CodexCredentialStore {
    private static let bootstrapCompletedKey = "codeburn.codex.bootstrapCompleted"
    private static let inMemoryTTL: TimeInterval = 5 * 60
    // Codex refresh tokens are single-use and rotate on every refresh. The CLI
    // owns the grant via ~/.codex/auth.json; we only refresh ourselves when its
    // last_refresh is older than this, mirroring the Codex CLI's own cadence.
    // Refreshing more eagerly races the CLI and burns its rotating token.
    private static let staleRefreshInterval: TimeInterval = 8 * 24 * 60 * 60

    private static let oauthClientID = "app_EMoamEEZ73f0CkXaXp7hrann"
    private static let refreshURL = URL(string: "https://auth.openai.com/oauth/token")!
    private static let codexAuthPath = ".codex/auth.json"
    private static let maxCredentialBytes = 64 * 1024

    private static let cacheFilename = "codex-credentials.v1.json"

    static let ourKeychainService = CodeBurnKeychainIdentity.codexService
    static let ourKeychainAccount = CodeBurnKeychainIdentity.account

    private static let lock = NSLock()
    private nonisolated(unsafe) static var memoryCache: CachedRecord?

    // MARK: - Injectable seams (tests + staged Keychain migration)

    nonisolated(unsafe) static var applicationSupportDirectoryOverride: URL?
    nonisolated(unsafe) static var homeDirectoryOverride: URL?
    nonisolated(unsafe) static var userDefaultsOverride: UserDefaults?
    nonisolated(unsafe) static var keychainCache: any KeychainCredentialCaching = LiveKeychainCredentialCache()

    static func resetTestSeams() {
        applicationSupportDirectoryOverride = nil
        homeDirectoryOverride = nil
        userDefaultsOverride = nil
        keychainCache = LiveKeychainCredentialCache()
        lastCacheDeleteResult = nil
        unlinkLegacyOverride = nil
        tightenLegacyOverride = nil
        lock.withLock { memoryCache = nil }
    }

    private static var defaults: UserDefaults {
        userDefaultsOverride ?? .standard
    }

    private static var homeDirectory: URL {
        homeDirectoryOverride ?? FileManager.default.homeDirectoryForCurrentUser
    }

    static var hasCredentialSource: Bool {
        FileManager.default.fileExists(
            atPath: homeDirectory.appendingPathComponent(codexAuthPath).path
        )
    }

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
        let lastRefresh: Date?
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
                return L("No Codex credentials found at ~/.codex/auth.json. Run `codex` to sign in.")
            case .bootstrapDecodeFailed:
                return L("Codex credentials are malformed.")
            case .bootstrapNotChatGPT:
                return L("Codex is in API-key mode; live quota tracking is only available for ChatGPT subscriptions.")
            case let .fileWriteFailed(message):
                return L("Could not write to local cache: \(message)")
            case let .refreshHTTPError(code, body):
                let suffix = body.map { ": \($0)" } ?? ""
                return L("Codex token refresh failed (HTTP \(code))\(suffix)")
            case let .refreshNetworkError(err):
                return L("Codex token refresh network error: \(err.localizedDescription)")
            case .refreshDecodeFailed:
                return L("Codex token refresh response was malformed.")
            case .noRefreshToken:
                return L("No refresh token available; reconnect required.")
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
        get { defaults.bool(forKey: bootstrapCompletedKey) }
        set { defaults.set(newValue, forKey: bootstrapCompletedKey) }
    }

    static func resetBootstrap() -> CacheDeleteResult {
        lock.withLock { memoryCache = nil }
        let result = deleteOurCache()
        lastCacheDeleteResult = result
        if result.isSuccess {
            isBootstrapCompleted = false
        }
        return result
    }

    struct CacheDeleteResult: Equatable {
        var keychainDeletedOrAbsent: Bool
        var legacyDeletedOrAbsent: Bool
        var isSuccess: Bool { keychainDeletedOrAbsent && legacyDeletedOrAbsent }
    }

    nonisolated(unsafe) static var lastCacheDeleteResult: CacheDeleteResult?
    nonisolated(unsafe) static var unlinkLegacyOverride: ((URL) throws -> Void)?
    nonisolated(unsafe) static var tightenLegacyOverride: ((URL) throws -> Void)?


    // MARK: - Public API

    @discardableResult
    static func bootstrap() throws -> CredentialRecord {
        let record = try readCodexAuth()
        isBootstrapCompleted = true
        cacheInMemory(record)
        return record
    }

    static func currentRecord() throws -> CredentialRecord? {
        guard isBootstrapCompleted else { return nil }
        // The Codex CLI's auth.json is the source of truth. Read it fresh each
        // call so we always serve the CLI's current token rather than racing it
        // with a stale private copy. The historical CodeBurn Keychain cache is
        // read only as a continuity fallback when the file is briefly unreadable.
        if let live = try? readCodexAuth() {
            cacheInMemory(live)
            return live
        }
        if let cached = lock.withLock({ memoryCache }), cached.isFresh {
            return cached.record
        }
        let fetched: CredentialRecord?
        do {
            fetched = try readOurCache()
        } catch let err as KeychainCredentialCacheError {
            // Locked/denied keychain: serve the last known token rather than
            // reporting the grant as missing.
            if case .unavailable = err {
                return lock.withLock { memoryCache }?.record
            }
            throw err
        }
        if let stored = fetched {
            cacheInMemory(stored)
            return stored
        }
        return nil
    }

    static func freshAccessToken() async throws -> String? {
        guard let record = try currentRecord() else { return nil }
        if needsRefresh(record) {
            let updated = try await refreshAndPersist(record: record)
            return updated.accessToken
        }
        return record.accessToken
    }

    static func refreshAfter401(failedToken: String) async throws -> String {
        // Source of truth first: the CLI may have already rotated the token out
        // from under us. Re-read auth.json before spending our single-use refresh
        // token, which would race the CLI and can invalidate its login.
        if let live = try? readCodexAuth(), live.accessToken != failedToken {
            cacheInMemory(live)
            return live.accessToken
        }
        guard let record = try currentRecord() else { throw StoreError.noRefreshToken }
        let updated = try await refreshAndPersist(record: record)
        return updated.accessToken
    }

    private static func needsRefresh(_ record: CredentialRecord) -> Bool {
        guard let last = record.lastRefresh else { return true }
        return Date().timeIntervalSince(last) > staleRefreshInterval
    }

    // MARK: - Bootstrap source: ~/.codex/auth.json

    private static func readCodexAuth() throws -> CredentialRecord {
        let url = homeDirectory.appendingPathComponent(codexAuthPath)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw StoreError.bootstrapNoSource
        }
        let data = try SafeFile.read(from: url.path, maxBytes: maxCredentialBytes)
        struct Root: Decodable {
            let auth_mode: String?
            let tokens: Tokens?
            let last_refresh: String?
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
                expiresAt: nil,   // Codex CLI does not record expiresAt in auth.json
                lastRefresh: root.last_refresh.flatMap(parseISO8601)
            )
        } catch let err as StoreError {
            throw err
        } catch {
            throw StoreError.bootstrapDecodeFailed
        }
    }

    private static func parseISO8601(_ s: String) -> Date? {
        // auth.json records fractional seconds (e.g. ...:12.010758Z); the plain
        // ISO8601 formatter rejects those, so try the fractional variant first.
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = withFraction.date(from: s) { return d }
        return ISO8601DateFormatter().date(from: s)
    }

    // MARK: - Write rotated tokens back to ~/.codex/auth.json

    /// Atomic read-modify-write of auth.json that preserves every other top-level
    /// key (OPENAI_API_KEY, auth_mode, ...) and only rewrites the tokens dict and
    /// last_refresh. Keeps the CLI and the menubar on the same rotated grant.
    private static func writeBackToCodexAuth(record: CredentialRecord) {
        let url = homeDirectory.appendingPathComponent(codexAuthPath)
        var json: [String: Any] = [:]
        if let data = try? SafeFile.read(from: url.path, maxBytes: maxCredentialBytes),
           let existing = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            json = existing
        }
        var tokens: [String: Any] = [
            "access_token": record.accessToken,
            "refresh_token": record.refreshToken,
        ]
        if let idToken = record.idToken { tokens["id_token"] = idToken }
        if let accountId = record.accountId { tokens["account_id"] = accountId }
        json["tokens"] = tokens
        let stamp = ISO8601DateFormatter()
        stamp.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        json["last_refresh"] = stamp.string(from: record.lastRefresh ?? Date())
        guard let out = try? JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys]) else {
            return
        }
        try? SafeFile.write(out, to: url.path, mode: 0o600)
    }

    // MARK: - Local cache (injectable Application Support + Keychain seam)

    static func cacheFileURL() -> URL {
        let support = applicationSupportDirectoryOverride
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? homeDirectory.appendingPathComponent("Library/Application Support")
        return support
            .appendingPathComponent("CodeBurn", isDirectory: true)
            .appendingPathComponent(cacheFilename)
    }

    /// Production-used write path. Persists rotation fields to the CodeBurn
    /// Keychain item. After verified read-back, unlinks any legacy JSON.
    static func writeOurCache(record: CredentialRecord) throws {
        let data = try JSONEncoder().encode(record)
        try keychainCache.upsert(
            service: ourKeychainService,
            account: ourKeychainAccount,
            data: data
        )
        guard let readBack = try keychainCache.read(service: ourKeychainService, account: ourKeychainAccount),
              let roundTrip = try? JSONDecoder().decode(CredentialRecord.self, from: readBack),
              roundTrip.accessToken == record.accessToken,
              roundTrip.refreshToken == record.refreshToken,
              roundTrip.idToken == record.idToken,
              roundTrip.accountId == record.accountId
        else {
            throw StoreError.fileWriteFailed(L("keychain read-back mismatch"))
        }
        tryUnlinkLegacyAfterVerifiedKeychain()
    }

    /// Serializes migrate + unlink across processes so two menubar instances (or the
    /// CLI) cannot race on the same legacy file. Only `SafeFile.Error` from acquiring
    /// the lock is tolerated — `readOurCacheLocked` never lets one escape, because
    /// `readLegacyFile` swallows its own read failures.
    private static func readOurCache() throws -> CredentialRecord? {
        do {
            return try SafeFile.withExclusiveLock(at: cacheFileURL().path + ".lock") {
                try readOurCacheLocked()
            }
        } catch is SafeFile.Error {
            return try readOurCacheLocked()
        }
    }

    private static func readOurCacheLocked() throws -> CredentialRecord? {
        if let data = try keychainCache.read(service: ourKeychainService, account: ourKeychainAccount),
           let record = try? JSONDecoder().decode(CredentialRecord.self, from: data) {
            // Only reached when auth.json is unreadable, but the Keychain item can
            // still be older than the legacy file — and serving a spent rotating
            // refresh token here ends in a terminal invalid_grant. Prefer the
            // later `lastRefresh` before unlinking anything.
            if let fresher = legacyRecordIfNewer(than: record) {
                try? writeOurCache(record: fresher)
                return fresher
            }
            tryUnlinkLegacyAfterVerifiedKeychain()
            return record
        }
        return try migrateLegacyFileIfPresent()
    }

    /// Returns the legacy file's record when it refreshed strictly later than
    /// `record`; nil when absent, unreadable, or not newer.
    private static func legacyRecordIfNewer(than record: CredentialRecord) -> CredentialRecord? {
        guard let legacy = readLegacyFile() else { return nil }
        guard let legacyRefresh = legacy.lastRefresh else { return nil }
        guard let currentRefresh = record.lastRefresh else { return legacy }
        return legacyRefresh > currentRefresh ? legacy : nil
    }

    /// Secure-read + decode the legacy JSON. Returns nil on symlink / ownership /
    /// chmod / decode failure, leaving the file in place.
    private static func readLegacyFile() -> CredentialRecord? {
        let url = cacheFileURL()
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        guard let data = try? SafeFile.readAfterSecuringPermissions(
            from: url.path,
            maxBytes: maxCredentialBytes
        ) else { return nil }
        return try? JSONDecoder().decode(CredentialRecord.self, from: data)
    }

    private static func migrateLegacyFileIfPresent() throws -> CredentialRecord? {
        guard let decoded = readLegacyFile() else { return nil }
        // Keychain write/read-back failure leaves the repaired 0600 legacy file
        // in place; the next read retries the migration.
        try? writeOurCache(record: decoded)
        return decoded
    }

    /// Unlink the redundant legacy JSON. Called on every successful cache read,
    /// so a failure here is retried on the next read without a sticky flag.
    private static func tryUnlinkLegacyAfterVerifiedKeychain() {
        let url = cacheFileURL()
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        do {
            if let unlinkLegacyOverride {
                try unlinkLegacyOverride(url)
            } else {
                try FileManager.default.removeItem(at: url)
            }
        } catch {
            // Could not remove it — at least make sure it is not world-readable.
            if let tightenLegacyOverride {
                try? tightenLegacyOverride(url)
            } else {
                try? SafeFile.tightenToOwnerReadWrite(at: url.path)
            }
        }
    }

    @discardableResult
    private static func deleteOurCache() -> CacheDeleteResult {
        var keychainOK = true
        do {
            try keychainCache.delete(service: ourKeychainService, account: ourKeychainAccount)
        } catch {
            keychainOK = false
        }

        var legacyOK = true
        let url = cacheFileURL()
        if FileManager.default.fileExists(atPath: url.path) {
            do {
                if let unlinkLegacyOverride {
                    try unlinkLegacyOverride(url)
                } else {
                    try FileManager.default.removeItem(at: url)
                }
            } catch {
                legacyOK = false
            }
        }
        return CacheDeleteResult(
            keychainDeletedOrAbsent: keychainOK,
            legacyDeletedOrAbsent: legacyOK
        )
    }

    static func clearMemoryCacheForTesting() {
        lock.withLock { memoryCache = nil }
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
            // A 4xx here usually means the CLI already rotated the shared grant
            // out from under us (single-use refresh token). Re-read the source:
            // if it now holds a different token, the CLI healed it and we adopt
            // that instead of surfacing a terminal "disconnected".
            if http.statusCode >= 400, http.statusCode < 500,
               let live = try? readCodexAuth(), live.refreshToken != record.refreshToken {
                cacheInMemory(live)
                return live
            }
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
            expiresAt: decoded.expires_in.map { Date().addingTimeInterval(TimeInterval($0)) } ?? record.expiresAt,
            lastRefresh: Date()
        )
        cacheInMemory(updated)
        // Write the rotated grant back to the CLI's authoritative store so the
        // CLI and CodeBurn continue sharing one login.
        writeBackToCodexAuth(record: updated)
        return updated
    }
}
