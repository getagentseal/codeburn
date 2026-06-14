import Foundation
import Security

/// Owns the lifecycle of Claude OAuth credentials, mirroring CodexBar's pattern:
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
///   3. **In-memory + file cache** so back-to-back reads in the same refresh
///      cycle don't re-hit the source, and we keep serving the last good token
///      across launches.
enum ClaudeCredentialStore {
    private static let bootstrapCompletedKey = "codeburn.claude.bootstrapCompleted"
    private static let inMemoryTTL: TimeInterval = 5 * 60
    private static let proactiveRefreshMargin: TimeInterval = 5 * 60

    private static let claudeKeychainService = "Claude Code-credentials"
    private static let credentialsRelativePath = ".claude/.credentials.json"
    private static let maxCredentialBytes = 64 * 1024

    /// Legacy local cache file. New writes use the macOS Keychain; this path is
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
        case noRefreshToken
        case sourceTokenStale            // CLI hasn't rotated yet; transient, not a re-auth

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
            case .noRefreshToken:
                return "No refresh token available; reconnect required."
            case .sourceTokenStale:
                return "Waiting for the Claude CLI to refresh its token."
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
        try? writeOurCache(record: live)
        return live
    }

    private static func readClaudeSourceSilently() -> CredentialRecord? {
        if let fromFile = try? readClaudeFile() { return fromFile }
        if let fromKeychain = try? readClaudeKeychain(allowUI: false) { return fromKeychain }
        return nil
    }

    static func subscriptionTier() throws -> String? {
        try currentRecord()?.rateLimitTier
    }

    // MARK: - Bootstrap source

    private static func readClaudeSource() throws -> CredentialRecord {
        if let fromFile = try? readClaudeFile() { return fromFile }
        if let fromKeychain = try readClaudeKeychain(allowUI: true) { return fromKeychain }
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
        let data = try SafeFile.read(from: url.path, maxBytes: maxCredentialBytes)
        guard let record = try? JSONDecoder().decode(CredentialRecord.self, from: data) else { return nil }
        return record
    }

    private static func writeOurCache(record: CredentialRecord) throws {
        try writeOurFileCache(record: record)
    }

    private static func writeOurFileCache(record: CredentialRecord) throws {
        let url = cacheFileURL()
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(record)
        try data.write(to: url, options: [.atomic, .completeFileProtection])
    }

    private static func deleteOurCache() {
        try? FileManager.default.removeItem(at: cacheFileURL())
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
