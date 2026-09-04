import Foundation
import Security

/// Owns the lifecycle of Claude OAuth credentials:
///
///   1. **Bootstrap is user-initiated.** The first read of Claude's keychain
///      entry — which triggers a macOS keychain prompt — only happens when
///      the user clicks "Connect" in the Plan tab. The menubar does not
///      touch Claude's keychain on launch.
///
///   2. **The Claude CLI owns the grant; we never refresh it ourselves.**
///      Claude's refresh token is single-use and rotates on every refresh, and
///      the CLI is refreshing the same grant. If the menubar spent that token
///      it would invalidate the CLI's own login. So on expiry/401 we re-read
///      the CLI's store for a token it has already rotated rather than calling
///      the refresh endpoint. If the CLI hasn't rotated yet we report a
///      transient staleness (`sourceTokenStale`) and recover on its next use.
///
///   3. **Source-first + in-memory cache.** Background reads prefer Claude's
///      current file / Apple-signed `security` path, so CodeBurn does not create
///      another Keychain item or ask to unlock one per provider. The historical
///      CodeBurn Keychain item remains a read-only continuity fallback.
enum ClaudeCredentialStore {
    private static let bootstrapCompletedKey = "codeburn.claude.bootstrapCompleted"
    private static let inMemoryTTL: TimeInterval = 5 * 60
    private static let proactiveRefreshMargin: TimeInterval = 5 * 60

    private static let claudeKeychainService = "Claude Code-credentials"
    private static let credentialsRelativePath = ".claude/.credentials.json"
    private static let maxCredentialBytes = 64 * 1024

    /// Legacy local cache file under Application Support. Migration to the
    /// CodeBurn-namespaced Keychain item is staged behind an injectable seam.
    private static let cacheFilename = "claude-credentials.v1.json"

    static let ourKeychainService = CodeBurnKeychainIdentity.claudeService
    static let ourKeychainAccount = CodeBurnKeychainIdentity.account

    private static let lock = NSLock()
    private nonisolated(unsafe) static var memoryCache: CachedRecord?

    // MARK: - Injectable seams (tests + staged Keychain migration)

    /// Override Application Support root. Nil uses the real user domain.
    nonisolated(unsafe) static var applicationSupportDirectoryOverride: URL?
    /// Override home for Claude CLI credential discovery. Nil uses the real home.
    nonisolated(unsafe) static var homeDirectoryOverride: URL?
    /// Override defaults used for bootstrap flags.
    nonisolated(unsafe) static var userDefaultsOverride: UserDefaults?
    /// Keychain backend. Production uses Live; tests inject InMemory.
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
        case noRefreshToken
        case sourceTokenStale            // CLI hasn't rotated yet; transient, not a re-auth

        var errorDescription: String? {
            switch self {
            case .bootstrapNoSource:
                return L("No Claude credentials found. Sign in with `claude` first.")
            case .bootstrapDecodeFailed:
                return L("Claude credentials are malformed.")
            case let .keychainWriteFailed(status):
                return L("Could not write to keychain (status \(Int(status))).")
            case let .keychainReadFailed(status):
                return L("Could not read from keychain (status \(Int(status))).")
            case .noRefreshToken:
                return L("No refresh token available; reconnect required.")
            case .sourceTokenStale:
                return L("Waiting for the Claude CLI to refresh its token.")
            }
        }

        /// True when the failure means the user must re-authenticate (re-run
        /// `claude` or click Reconnect). Used by the UI to distinguish between
        /// "try again later" and "you must act". `sourceTokenStale` is the CLI
        /// not having rotated yet — transient, recovers on its next use.
        var isTerminal: Bool {
            if case .noRefreshToken = self { return true }
            return false
        }
    }

    // MARK: - Bootstrap state

    /// True once the user has explicitly connected (clicked Connect in the Plan
    /// tab AND we successfully read their credentials). Persists across launches.
    static var isBootstrapCompleted: Bool {
        get { defaults.bool(forKey: bootstrapCompletedKey) }
        set { defaults.set(newValue, forKey: bootstrapCompletedKey) }
    }

    /// Reset bootstrap state. Used when the user explicitly wants to disconnect
    /// or when the refresh token has been revoked terminally. Deletion failures
    /// are recorded on `lastCacheDeleteResult` — callers must not claim the
    /// local copy is gone when `isSuccess` is false.
    @discardableResult
    static func resetBootstrap() -> CacheDeleteResult {
        lock.withLock { memoryCache = nil }
        let result = deleteOurCache()
        lastCacheDeleteResult = result
        // A failed Keychain delete must not pretend the provider is disconnected.
        // Clearing the flag hides Disconnect and orphans the remaining item.
        if result.isSuccess {
            isBootstrapCompleted = false
        }
        return result
    }

    /// Outcome of deleting CodeBurn-owned Claude cache material.
    struct CacheDeleteResult: Equatable {
        var keychainDeletedOrAbsent: Bool
        var legacyDeletedOrAbsent: Bool
        var isSuccess: Bool { keychainDeletedOrAbsent && legacyDeletedOrAbsent }
    }

    /// Last disconnect/cleanup result. Nil until the first delete attempt.
    nonisolated(unsafe) static var lastCacheDeleteResult: CacheDeleteResult?

    /// Test seam: force legacy unlink to throw so we can assert the 0600 repair.
    nonisolated(unsafe) static var unlinkLegacyOverride: ((URL) throws -> Void)?
    nonisolated(unsafe) static var tightenLegacyOverride: ((URL) throws -> Void)?


    // MARK: - Public API

    /// User-initiated entry point. Reads from Claude's source (PROMPTS for the
    /// keychain on first use), writes to our own keychain item, marks bootstrap
    /// as completed.
    @discardableResult
    static func bootstrap() throws -> CredentialRecord {
        let record = try readClaudeSource()
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
        // Claude's own store is authoritative and the silent reader is the
        // prompt-free path. Prefer it before touching the
        // historical CodeBurn-owned Keychain cache.
        if let live = readClaudeSourceSilently() {
            cacheInMemory(live)
            return live
        }
        let fetched: CredentialRecord?
        do {
            fetched = try readOurCache()
        } catch let err as KeychainCredentialCacheError {
            // A locked/denied keychain means "can't look right now", not "the
            // item is gone". Serve the last known token and leave the bootstrap
            // flag alone so we don't silently disconnect the user.
            if case .unavailable = err {
                return lock.withLock { memoryCache }?.record
            }
            throw err
        }
        if let stored = fetched {
            cacheInMemory(stored)
            return stored
        }
        // Bootstrap flag is set but our cache file is missing — most likely
        // a fresh install resetting state, or the user manually deleted the
        // file. Force re-bootstrap on next user action.
        isBootstrapCompleted = false
        return nil
    }

    /// Returns the current token, adopting a fresher one from the CLI's store if
    /// ours is near expiry. Never spends the refresh token — see the type doc.
    static func freshAccessToken() async throws -> String? {
        guard let record = try currentRecord() else { return nil }
        if let expiresAt = record.expiresAt, expiresAt.timeIntervalSinceNow < proactiveRefreshMargin {
            if let live = adoptFresherSource(than: record) {
                return live.accessToken
            }
        }
        return record.accessToken
    }

    /// Called after an explicit 401. Delegates to the CLI: re-reads its store
    /// (silently, no prompt) for a token it has already rotated. If none is
    /// available yet, throws the transient `sourceTokenStale` rather than
    /// spending the shared refresh token, which would break the CLI's login.
    static func refreshAfter401() async throws -> String {
        guard let record = try currentRecord() else { throw StoreError.noRefreshToken }
        if let live = adoptFresherSource(than: record) {
            return live.accessToken
        }
        throw StoreError.sourceTokenStale
    }

    /// Re-reads Claude's own store (file, then keychain with a no-UI query) and
    /// adopts it when it holds a different access token than `record` — i.e. the
    /// CLI rotated since we last read. Returns nil when nothing fresher exists.
    private static func adoptFresherSource(than record: CredentialRecord) -> CredentialRecord? {
        guard let live = readClaudeSourceSilently(), live.accessToken != record.accessToken else {
            return nil
        }
        cacheInMemory(live)
        return live
    }

    private static func readClaudeSourceSilently() -> CredentialRecord? {
        if let fromFile = try? readClaudeFile() { return fromFile }
        // An overridden home is an isolation boundary (tests and explicit
        // sandboxed probes). Falling through here would read the operator's
        // login Keychain when the isolated fixture has no Claude file.
        guard homeDirectoryOverride == nil else { return nil }
        if let fromKeychain = try? readClaudeKeychain(allowUI: false) { return fromKeychain }
        return nil
    }

    static func subscriptionTier() throws -> String? {
        try currentRecord()?.rateLimitTier
    }

    // MARK: - Bootstrap source

    private static func readClaudeSource() throws -> CredentialRecord {
        if let silent = readClaudeSourceSilently() { return silent }
        guard homeDirectoryOverride == nil else { throw StoreError.bootstrapNoSource }
        if let fromKeychain = try readClaudeKeychain(allowUI: true) { return fromKeychain }
        throw StoreError.bootstrapNoSource
    }

    private static func readClaudeFile() throws -> CredentialRecord? {
        let url = homeDirectory.appendingPathComponent(credentialsRelativePath)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let data = try SafeFile.read(from: url.path, maxBytes: maxCredentialBytes)
        return try parseClaudeBlob(data: sanitizeClaudeBlob(data))
    }

    /// Reads Claude's keychain credentials. The CLI has historically written
    /// entries under different account names — older versions used "agentseal"
    /// (a hardcoded company-style identifier) while Claude Code 2.1.x writes
    /// under `$USER` (NSUserName()). After a user re-runs `/login`, both
    /// entries can coexist and a service-only lookup often returns the older
    /// stale one. We try the user-keyed entry first (the modern format), then
    /// fall back to the unscoped query for older installations.
    ///
    /// Silent background reads go through the `security` CLI rather than the
    /// Security framework. The Apple-signed `security` binary sits in the
    /// keychain item's `apple-tool:` partition, so it never raises the
    /// partition-list prompt. The framework API does — and re-prompts every
    /// time Claude Code rotates its credential and resets the item's partition
    /// list, dropping our app from the allowed set (issue #490). Only the
    /// user-initiated bootstrap still reads through the framework, where a
    /// single consent prompt is expected.
    private static func readClaudeKeychain(allowUI: Bool) throws -> CredentialRecord? {
        if !allowUI {
            return readClaudeKeychainSilently(account: NSUserName())
                ?? readClaudeKeychainSilently(account: nil)
        }
        if let record = try readClaudeKeychainPrompting(account: NSUserName()) {
            return record
        }
        return try readClaudeKeychainPrompting(account: nil)
    }

    private static func readClaudeKeychainPrompting(account: String?) throws -> CredentialRecord? {
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

    /// Reads Claude's keychain entry via `/usr/bin/security`, which never raises
    /// the partition-list prompt. Returns nil on any failure so the caller falls
    /// back to the cached token.
    private static func readClaudeKeychainSilently(account: String?) -> CredentialRecord? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        var args = ["find-generic-password", "-s", claudeKeychainService]
        if let account { args += ["-a", account] }
        args.append("-w")
        process.arguments = args

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return nil }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return try? parseClaudeBlob(data: sanitizeClaudeBlob(data))
        } catch {
            return nil
        }
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

    // MARK: - Local cache (injectable Application Support + Keychain seam)

    static func cacheFileURL() -> URL {
        let support = applicationSupportDirectoryOverride
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? homeDirectory.appendingPathComponent("Library/Application Support")
        return support
            .appendingPathComponent("CodeBurn", isDirectory: true)
            .appendingPathComponent(cacheFilename)
    }

    /// Production-used write path. Persists to the CodeBurn-namespaced Keychain
    /// item. Claude never stores a refresh token in this cache. After a verified
    /// Keychain read-back, any legacy JSON is unlinked (not "securely erased").
    static func writeOurCache(record: CredentialRecord) throws {
        let persisted = encodePersisted(record)
        let data = try JSONEncoder().encode(persisted)
        try keychainCache.upsert(
            service: ourKeychainService,
            account: ourKeychainAccount,
            data: data
        )
        try verifyKeychainMatches(persisted)
        tryUnlinkLegacyAfterVerifiedKeychain()
    }

    /// Cache shape stored in Keychain — intentionally omits refreshToken.
    struct PersistedCacheRecord: Codable, Equatable {
        let accessToken: String
        let expiresAt: Date?
        let rateLimitTier: String?
    }

    private static func encodePersisted(_ record: CredentialRecord) -> PersistedCacheRecord {
        PersistedCacheRecord(
            accessToken: record.accessToken,
            expiresAt: record.expiresAt,
            rateLimitTier: record.rateLimitTier
        )
    }

    private static func decodePersisted(_ data: Data) -> CredentialRecord? {
        if let persisted = try? JSONDecoder().decode(PersistedCacheRecord.self, from: data) {
            return CredentialRecord(
                accessToken: persisted.accessToken,
                refreshToken: nil,
                expiresAt: persisted.expiresAt,
                rateLimitTier: persisted.rateLimitTier
            )
        }
        // Historical blobs may still include refreshToken; drop it on read.
        if let legacy = try? JSONDecoder().decode(CredentialRecord.self, from: data) {
            return CredentialRecord(
                accessToken: legacy.accessToken,
                refreshToken: nil,
                expiresAt: legacy.expiresAt,
                rateLimitTier: legacy.rateLimitTier
            )
        }
        return nil
    }

    private static func verifyKeychainMatches(_ expected: PersistedCacheRecord) throws {
        guard let data = try keychainCache.read(service: ourKeychainService, account: ourKeychainAccount),
              let roundTrip = decodePersisted(data),
              encodePersisted(roundTrip) == expected
        else {
            throw StoreError.keychainWriteFailed(-1)
        }
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
           let record = decodePersisted(data) {
            // The Keychain item can predate the legacy file by a long way — this
            // service name has been in use since May 2026, so an upgrading install
            // can hold a months-old item beside a file the old build wrote today.
            // Adopt whichever expires later before unlinking anything.
            if let fresher = legacyRecordIfNewer(than: record) {
                try? writeOurCache(record: fresher)
                return fresher
            }
            // Rewrite historical Claude blobs once without refreshToken.
            if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               object.keys.contains("refreshToken") {
                try? writeOurCache(record: record)
            } else {
                tryUnlinkLegacyAfterVerifiedKeychain()
            }
            return record
        }

        return try migrateLegacyFileIfPresent()
    }

    /// Reads the legacy file only to compare recency. Returns it when it expires
    /// strictly later than `record`; nil when absent, unreadable, or not newer.
    private static func legacyRecordIfNewer(than record: CredentialRecord) -> CredentialRecord? {
        guard let legacy = readLegacyFile() else { return nil }
        guard let legacyExpiry = legacy.expiresAt else { return nil }
        guard let currentExpiry = record.expiresAt else { return legacy }
        return legacyExpiry > currentExpiry ? legacy : nil
    }

    /// Secure-read + decode the legacy JSON, dropping any refreshToken it holds.
    /// Returns nil on symlink / ownership / chmod / decode failure, leaving the
    /// file in place.
    private static func readLegacyFile() -> CredentialRecord? {
        let url = cacheFileURL()
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        guard let data = try? SafeFile.readAfterSecuringPermissions(
            from: url.path,
            maxBytes: maxCredentialBytes
        ) else { return nil }
        guard let decoded = try? JSONDecoder().decode(CredentialRecord.self, from: data) else {
            // Invalid data stays in place at 0600; do not delete.
            return nil
        }
        return CredentialRecord(
            accessToken: decoded.accessToken,
            refreshToken: nil,
            expiresAt: decoded.expiresAt,
            rateLimitTier: decoded.rateLimitTier
        )
    }

    /// Secure-read legacy JSON, upsert Keychain, verify read-back, then unlink.
    private static func migrateLegacyFileIfPresent() throws -> CredentialRecord? {
        guard let migrated = readLegacyFile() else { return nil }
        // Keychain write/read-back failure leaves the repaired 0600 legacy file
        // in place; the next read retries the migration.
        try? writeOurCache(record: migrated)
        return migrated
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

    /// Clears only the in-memory TTL cache (simulates process restart in tests).
    static func clearMemoryCacheForTesting() {
        lock.withLock { memoryCache = nil }
    }

    private static func cacheInMemory(_ record: CredentialRecord) {
        lock.withLock { memoryCache = CachedRecord(record: record, cachedAt: Date()) }
    }
}

private extension NSLock {
    func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock(); defer { unlock() }
        return try body()
    }
}
