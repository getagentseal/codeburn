import Foundation
import Testing
@testable import CodeBurnMenubar

/// Red receipt for 0B: current plaintext writers must fail these assertions.
/// Disposable sentinels only — never log or expect raw secret values in receipts.
@Suite("Credential Keychain cache red", .serialized)
struct CredentialKeychainCacheRedTests {
    private let accessSentinel = "cb-red-access-sentinel"
    private let refreshSentinel = "cb-red-refresh-sentinel"
    private let idSentinel = "cb-red-id-sentinel"
    private let accountSentinel = "cb-red-account-sentinel"

    private func withIsolatedSeams(
        _ body: (URL, InMemoryKeychainCredentialCache) throws -> Void
    ) throws {
        CredentialStoreTestIsolation.lock.lock()
        defer { CredentialStoreTestIsolation.lock.unlock() }

        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("codeburn-0b-red-\(UUID().uuidString)", isDirectory: true)
        let support = root.appendingPathComponent("Application Support", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        let suiteName = "codeburn.0b.red.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        TestDefaults.forget(suiteName)

        let fakeKeychain = InMemoryKeychainCredentialCache()
        ClaudeCredentialStore.resetTestSeams()
        CodexCredentialStore.resetTestSeams()
        ClaudeCredentialStore.applicationSupportDirectoryOverride = support
        CodexCredentialStore.applicationSupportDirectoryOverride = support
        ClaudeCredentialStore.userDefaultsOverride = defaults
        CodexCredentialStore.userDefaultsOverride = defaults
        ClaudeCredentialStore.keychainCache = fakeKeychain
        CodexCredentialStore.keychainCache = fakeKeychain

        defer {
            ClaudeCredentialStore.resetTestSeams()
            CodexCredentialStore.resetTestSeams()
            TestDefaults.forget(suiteName)
            try? FileManager.default.removeItem(at: root)
        }

        try body(support, fakeKeychain)
    }

    private func posixMode(at url: URL) -> mode_t? {
        var info = stat()
        guard lstat(url.path, &info) == 0 else { return nil }
        return info.st_mode & 0o777
    }

    private func jsonKeys(at url: URL) throws -> [String] {
        let data = try Data(contentsOf: url)
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        return object.keys.sorted()
    }

    @Test("Claude writeOurCache leaves no JSON and stores Keychain payload without refreshToken")
    func claudeWriteUsesKeychainWithoutRefreshToken() throws {
        try withIsolatedSeams { support, fakeKeychain in
            let record = ClaudeCredentialStore.CredentialRecord(
                accessToken: accessSentinel,
                refreshToken: refreshSentinel,
                expiresAt: Date(timeIntervalSince1970: 1_900_000_000),
                rateLimitTier: "default"
            )

            try ClaudeCredentialStore.writeOurCache(record: record)

            let legacyURL = ClaudeCredentialStore.cacheFileURL()
            let legacyExists = FileManager.default.fileExists(atPath: legacyURL.path)
            let mode = legacyExists ? posixMode(at: legacyURL) : nil
            let fileKeys = legacyExists ? try jsonKeys(at: legacyURL) : []
            let keychainKeys = fakeKeychain.storedKeys(
                service: ClaudeCredentialStore.ourKeychainService,
                account: ClaudeCredentialStore.ourKeychainAccount
            )
            let keychainObject = fakeKeychain.storedJSONObject(
                service: ClaudeCredentialStore.ourKeychainService,
                account: ClaudeCredentialStore.ourKeychainAccount
            )
            let hasRefreshKey = keychainObject?.keys.contains("refreshToken") == true
            let refreshValueMatches = (keychainObject?["refreshToken"] as? String) == refreshSentinel

            // Intended green behavior (must fail against current plaintext writer):
            #expect(!legacyExists, "legacy Claude JSON must not be created under Application Support")
            #expect(fakeKeychain.upsertCount >= 1, "fake Keychain must receive a Claude upsert")
            #expect(keychainKeys != nil, "Claude Keychain payload must exist")
            #expect(!(keychainKeys?.contains("refreshToken") ?? false), "Claude Keychain keys must omit refreshToken")
            #expect(!hasRefreshKey && !refreshValueMatches, "Claude Keychain must not persist refreshToken")

            // Red diagnostic (keys + mode only; never fixture values):
            if legacyExists {
                Issue.record(
                    Comment(rawValue: "RED Claude legacy present mode=\(String(mode.map { String($0, radix: 8) } ?? "nil")) keys=\(fileKeys.joined(separator: ","))")
                )
            }
            if fakeKeychain.upsertCount == 0 {
                Issue.record(Comment(rawValue: "RED Claude Keychain upsertCount=0"))
            }
            _ = support
        }
    }

    @Test("Codex writeOurCache leaves no JSON and stores Keychain rotation fields")
    func codexWriteUsesKeychainWithRotationFields() throws {
        try withIsolatedSeams { support, fakeKeychain in
            let record = CodexCredentialStore.CredentialRecord(
                accessToken: accessSentinel,
                refreshToken: refreshSentinel,
                idToken: idSentinel,
                accountId: accountSentinel,
                expiresAt: Date(timeIntervalSince1970: 1_900_000_100),
                lastRefresh: Date(timeIntervalSince1970: 1_700_000_000)
            )

            try CodexCredentialStore.writeOurCache(record: record)

            let legacyURL = CodexCredentialStore.cacheFileURL()
            let legacyExists = FileManager.default.fileExists(atPath: legacyURL.path)
            let mode = legacyExists ? posixMode(at: legacyURL) : nil
            let fileKeys = legacyExists ? try jsonKeys(at: legacyURL) : []
            let keychainKeys = fakeKeychain.storedKeys(
                service: CodexCredentialStore.ourKeychainService,
                account: CodexCredentialStore.ourKeychainAccount
            )

            let required = ["accessToken", "refreshToken", "idToken", "accountId", "lastRefresh"]
            let missingRequired = required.filter { !(keychainKeys?.contains($0) ?? false) }

            #expect(!legacyExists, "legacy Codex JSON must not be created under Application Support")
            #expect(fakeKeychain.upsertCount >= 1, "fake Keychain must receive a Codex upsert")
            #expect(keychainKeys != nil, "Codex Keychain payload must exist")
            #expect(missingRequired.isEmpty, "Codex Keychain must retain rotation fields")

            if legacyExists {
                Issue.record(
                    Comment(rawValue: "RED Codex legacy present mode=\(String(mode.map { String($0, radix: 8) } ?? "nil")) keys=\(fileKeys.joined(separator: ","))")
                )
            }
            if fakeKeychain.upsertCount == 0 {
                Issue.record(Comment(rawValue: "RED Codex Keychain upsertCount=0"))
            }
            _ = support
        }
    }
}
