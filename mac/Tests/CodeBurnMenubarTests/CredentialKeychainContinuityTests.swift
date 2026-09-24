import Foundation
import Testing
@testable import CodeBurnMenubar

private final class SendableUserDefaults: @unchecked Sendable {
    let value: UserDefaults

    init(_ value: UserDefaults) {
        self.value = value
    }
}

/// Implementation-continuity tests for option-3 evidence bar.
/// Uses only InMemory/Controllable Keychain backends and temp Application Support —
/// never the operator login Keychain or live credential files.
@Suite("Credential Keychain implementation continuity", .serialized)
struct CredentialKeychainContinuityTests {
    private let accessSentinel = "cb-cont-access-sentinel"
    private let refreshSentinel = "cb-cont-refresh-sentinel"
    private let idSentinel = "cb-cont-id-sentinel"
    private let accountSentinel = "cb-cont-account-sentinel"

    private struct Harness {
        let root: URL
        let support: URL
        let defaults: UserDefaults
        let suiteName: String
        let fakeKeychain: InMemoryKeychainCredentialCache
    }

    private func withHarness(
        _ body: (Harness) throws -> Void
    ) throws {
        CredentialStoreTestIsolation.lock.lock()
        defer { CredentialStoreTestIsolation.lock.unlock() }

        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("codeburn-0b-cont-\(UUID().uuidString)", isDirectory: true)
        let support = root.appendingPathComponent("Application Support", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        let suiteName = "codeburn.0b.cont.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        TestDefaults.forget(suiteName)
        let fake = InMemoryKeychainCredentialCache()

        ClaudeCredentialStore.resetTestSeams()
        CodexCredentialStore.resetTestSeams()
        ClaudeCredentialStore.applicationSupportDirectoryOverride = support
        CodexCredentialStore.applicationSupportDirectoryOverride = support
        ClaudeCredentialStore.homeDirectoryOverride = root
        CodexCredentialStore.homeDirectoryOverride = root
        ClaudeCredentialStore.userDefaultsOverride = defaults
        CodexCredentialStore.userDefaultsOverride = defaults
        ClaudeCredentialStore.keychainCache = fake
        CodexCredentialStore.keychainCache = fake
        CapacityDockProviderCredentialStore.keychainCache = fake
        CapacityDockProviderCredentialStore.userDefaults = defaults

        defer {
            ClaudeCredentialStore.resetTestSeams()
            CodexCredentialStore.resetTestSeams()
            CapacityDockProviderCredentialStore.keychainCache = LiveKeychainCredentialCache()
            CapacityDockProviderCredentialStore.userDefaults = .standard
            TestDefaults.forget(suiteName)
            try? FileManager.default.removeItem(at: root)
        }

        try body(Harness(root: root, support: support, defaults: defaults, suiteName: suiteName, fakeKeychain: fake))
    }

    private func posixMode(at url: URL) -> mode_t? {
        var info = stat()
        guard lstat(url.path, &info) == 0 else { return nil }
        return info.st_mode & 0o777
    }

    private func writeLegacyClaude0644(record: ClaudeCredentialStore.CredentialRecord) throws {
        let url = ClaudeCredentialStore.cacheFileURL()
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(record)
        try data.write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: url.path)
    }

    private func writeLegacyCodex0644(record: CodexCredentialStore.CredentialRecord) throws {
        let url = CodexCredentialStore.cacheFileURL()
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(record)
        try data.write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: url.path)
    }

    // MARK: - Continuity lifecycle

    @Test("local provider sources bootstrap without creating CodeBurn Keychain copies")
    func sourceFirstBootstrapAvoidsPrivateKeychainCopies() throws {
        try withHarness { harness in
            let claudeURL = harness.root.appendingPathComponent(".claude/.credentials.json")
            try FileManager.default.createDirectory(
                at: claudeURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            let claudeBlob: [String: Any] = [
                "claudeAiOauth": [
                    "accessToken": accessSentinel,
                    "refreshToken": refreshSentinel,
                    "expiresAt": 1_900_000_000_000,
                    "rateLimitTier": "default",
                ],
            ]
            try JSONSerialization.data(withJSONObject: claudeBlob).write(to: claudeURL)

            let codexURL = harness.root.appendingPathComponent(".codex/auth.json")
            try FileManager.default.createDirectory(
                at: codexURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            let codexBlob: [String: Any] = [
                "auth_mode": "chatgpt",
                "tokens": [
                    "access_token": accessSentinel,
                    "refresh_token": refreshSentinel,
                    "id_token": idSentinel,
                    "account_id": accountSentinel,
                ],
                "last_refresh": "2026-08-28T10:00:00Z",
            ]
            try JSONSerialization.data(withJSONObject: codexBlob).write(to: codexURL)

            #expect(CodexCredentialStore.hasCredentialSource)
            #expect(try ClaudeCredentialStore.bootstrap().accessToken == accessSentinel)
            #expect(try CodexCredentialStore.bootstrap().accessToken == accessSentinel)
            #expect(harness.fakeKeychain.upsertCount == 0)
        }
    }

    @Test("provider overrides are isolated by provider ID")
    func providerOverridesAreIsolatedByProviderID() throws {
        try withHarness { harness in
            let clinePass = CapacityDockProviderCredential(
                sourceMode: ProviderReferenceSourceMode.api.rawValue,
                apiKey: "synthetic-clinepass-key"
            )
            let openCodeGo = CapacityDockProviderCredential(
                sourceMode: ProviderReferenceSourceMode.api.rawValue,
                apiKey: "synthetic-opencodego-key"
            )

            try CapacityDockProviderCredentialStore.save(clinePass, for: "clinepass")
            try CapacityDockProviderCredentialStore.save(openCodeGo, for: "opencodego")

            #expect(CapacityDockProviderCredentialPresence.providerIDs(defaults: harness.defaults) == [
                "clinepass", "opencodego",
            ])
            #expect(try CapacityDockProviderCredentialStore.load(for: "clinepass") == clinePass)
            #expect(try CapacityDockProviderCredentialStore.load(for: "opencodego") == openCodeGo)

            try CapacityDockProviderCredentialStore.remove(for: "clinepass")
            #expect(CapacityDockProviderCredentialPresence.providerIDs(defaults: harness.defaults) == [
                "opencodego",
            ])
            #expect(try CapacityDockProviderCredentialStore.load(for: "clinepass").isEmpty)
            #expect(try CapacityDockProviderCredentialStore.load(for: "opencodego") == openCodeGo)
        }
    }

    @Test("concurrent provider-presence updates do not lose identifiers")
    func providerPresenceUpdatesAreAtomic() async {
        let suiteName = "codeburn.capacity-dock-presence.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        let defaultsBox = SendableUserDefaults(defaults)
        TestDefaults.forget(suiteName)
        defer { TestDefaults.forget(suiteName) }
        let providerIDs = Array(CapacityDockPreferences.supportedProviders.prefix(24).map(\.id))

        await withTaskGroup(of: Void.self) { group in
            for providerID in providerIDs {
                group.addTask {
                    CapacityDockProviderCredentialPresence.set(
                        true,
                        for: providerID,
                        defaults: defaultsBox.value
                    )
                }
            }
        }

        #expect(CapacityDockProviderCredentialPresence.providerIDs(defaults: defaults) == Set(providerIDs))
    }

    @Test("ClinePass override survives a credential-store restart")
    func clinePassOverrideSurvivesRestart() throws {
        try withHarness { harness in
            let initial = CapacityDockProviderCredential(
                sourceMode: ProviderReferenceSourceMode.api.rawValue,
                apiKey: "synthetic-clinepass-restart-key"
            )
            try CapacityDockProviderCredentialStore.save(initial, for: "clinepass")

            // Simulate a new process: discard the store instance while retaining
            // the bytes that the login Keychain would preserve across launch.
            CapacityDockProviderCredentialStore.keychainCache = harness.fakeKeychain.cloneStorage()

            let afterRestart = try CapacityDockProviderCredentialStore.load(for: "clinepass")
            #expect(afterRestart == initial)
            #expect(afterRestart.resolvedSourceMode == .api)
            #expect(afterRestart.sanitizedOverride.apiKey == "synthetic-clinepass-restart-key")
        }
    }

    @Test("Claude write → simulated restart → read → update → delete")
    func claudeWriteRestartReadUpdateDelete() throws {
        try withHarness { harness in
            let initial = ClaudeCredentialStore.CredentialRecord(
                accessToken: accessSentinel,
                refreshToken: refreshSentinel,
                expiresAt: Date(timeIntervalSince1970: 1_900_000_000),
                rateLimitTier: "default"
            )
            try ClaudeCredentialStore.writeOurCache(record: initial)
            ClaudeCredentialStore.isBootstrapCompleted = true

            #expect(!FileManager.default.fileExists(atPath: ClaudeCredentialStore.cacheFileURL().path))
            let keys = harness.fakeKeychain.storedKeys(
                service: ClaudeCredentialStore.ourKeychainService,
                account: ClaudeCredentialStore.ourKeychainAccount
            )
            #expect(keys?.contains("refreshToken") != true)
            #expect(keys?.contains("accessToken") == true)

            // Simulated process restart: drop memory, keep Keychain bytes.
            ClaudeCredentialStore.clearMemoryCacheForTesting()
            let afterRestart = try #require(try ClaudeCredentialStore.currentRecord())
            #expect(afterRestart.accessToken == accessSentinel)
            #expect(afterRestart.refreshToken == nil)

            let updated = ClaudeCredentialStore.CredentialRecord(
                accessToken: accessSentinel + "-rotated",
                refreshToken: refreshSentinel,
                expiresAt: Date(timeIntervalSince1970: 1_900_000_100),
                rateLimitTier: "default"
            )
            try ClaudeCredentialStore.writeOurCache(record: updated)
            ClaudeCredentialStore.clearMemoryCacheForTesting()
            let afterUpdate = try #require(try ClaudeCredentialStore.currentRecord())
            #expect(afterUpdate.accessToken == accessSentinel + "-rotated")

            let deleteResult = ClaudeCredentialStore.resetBootstrap()
            #expect(deleteResult.isSuccess)
            let afterDelete = try harness.fakeKeychain.read(
                service: ClaudeCredentialStore.ourKeychainService,
                account: ClaudeCredentialStore.ourKeychainAccount
            )
            #expect(afterDelete == nil)
            let afterDisconnect = try ClaudeCredentialStore.currentRecord()
            #expect(afterDisconnect == nil)
        }
    }

    @Test("Codex write → simulated restart → read → update → delete")
    func codexWriteRestartReadUpdateDelete() throws {
        try withHarness { harness in
            let initial = CodexCredentialStore.CredentialRecord(
                accessToken: accessSentinel,
                refreshToken: refreshSentinel,
                idToken: idSentinel,
                accountId: accountSentinel,
                expiresAt: nil,
                lastRefresh: Date(timeIntervalSince1970: 1_700_000_000)
            )
            try CodexCredentialStore.writeOurCache(record: initial)
            CodexCredentialStore.isBootstrapCompleted = true

            #expect(!FileManager.default.fileExists(atPath: CodexCredentialStore.cacheFileURL().path))
            let keys = harness.fakeKeychain.storedKeys(
                service: CodexCredentialStore.ourKeychainService,
                account: CodexCredentialStore.ourKeychainAccount
            )
            for required in ["accessToken", "refreshToken", "idToken", "accountId", "lastRefresh"] {
                #expect(keys?.contains(required) == true)
            }

            CodexCredentialStore.clearMemoryCacheForTesting()
            // Without ~/.codex/auth.json, currentRecord falls through to Keychain cache.
            let afterRestart = try #require(try CodexCredentialStore.currentRecord())
            #expect(afterRestart.accessToken == accessSentinel)
            #expect(afterRestart.refreshToken == refreshSentinel)

            let updated = CodexCredentialStore.CredentialRecord(
                accessToken: accessSentinel + "-rotated",
                refreshToken: refreshSentinel + "-rotated",
                idToken: idSentinel,
                accountId: accountSentinel,
                expiresAt: nil,
                lastRefresh: Date(timeIntervalSince1970: 1_700_000_800)
            )
            try CodexCredentialStore.writeOurCache(record: updated)
            CodexCredentialStore.clearMemoryCacheForTesting()
            let afterUpdate = try #require(try CodexCredentialStore.currentRecord())
            #expect(afterUpdate.accessToken == accessSentinel + "-rotated")
            #expect(afterUpdate.refreshToken == refreshSentinel + "-rotated")

            let deleteResult = CodexCredentialStore.resetBootstrap()
            #expect(deleteResult.isSuccess)
            let afterDisconnect = try CodexCredentialStore.currentRecord()
            #expect(afterDisconnect == nil)
        }
    }

    // MARK: - Migration

    @Test("successful Claude legacy 0644 migration unlinks JSON and omits refreshToken")
    func claudeSuccessfulLegacyMigration() throws {
        try withHarness { harness in
            let legacy = ClaudeCredentialStore.CredentialRecord(
                accessToken: accessSentinel,
                refreshToken: refreshSentinel,
                expiresAt: Date(timeIntervalSince1970: 1_900_000_000),
                rateLimitTier: "default"
            )
            try writeLegacyClaude0644(record: legacy)
            #expect(posixMode(at: ClaudeCredentialStore.cacheFileURL()) == 0o644)

            ClaudeCredentialStore.isBootstrapCompleted = true
            let migrated = try #require(try ClaudeCredentialStore.currentRecord())
            #expect(migrated.accessToken == accessSentinel)
            #expect(migrated.refreshToken == nil)
            #expect(!FileManager.default.fileExists(atPath: ClaudeCredentialStore.cacheFileURL().path))
            #expect(harness.fakeKeychain.upsertCount >= 1)
            let keys = harness.fakeKeychain.storedKeys(
                service: ClaudeCredentialStore.ourKeychainService,
                account: ClaudeCredentialStore.ourKeychainAccount
            )
            #expect(keys?.contains("refreshToken") != true)
        }
    }

    @Test("failed Claude Keychain upsert leaves secured legacy file")
    func claudeFailedMigrationKeepsLegacy() throws {
        try withHarness { harness in
            let controllable = ControllableKeychainCredentialCache(inner: harness.fakeKeychain)
            controllable.failUpsert = true
            ClaudeCredentialStore.keychainCache = controllable

            let legacy = ClaudeCredentialStore.CredentialRecord(
                accessToken: accessSentinel,
                refreshToken: refreshSentinel,
                expiresAt: Date(timeIntervalSince1970: 1_900_000_000),
                rateLimitTier: "default"
            )
            try writeLegacyClaude0644(record: legacy)
            ClaudeCredentialStore.isBootstrapCompleted = true

            let record = try #require(try ClaudeCredentialStore.currentRecord())
            #expect(record.accessToken == accessSentinel)
            #expect(FileManager.default.fileExists(atPath: ClaudeCredentialStore.cacheFileURL().path))
            #expect(posixMode(at: ClaudeCredentialStore.cacheFileURL()) == 0o600)
            #expect(harness.fakeKeychain.upsertCount == 0)
        }
    }

    @Test("successful Codex legacy migration unlinks JSON and keeps rotation fields")
    func codexSuccessfulLegacyMigration() throws {
        try withHarness { harness in
            let legacy = CodexCredentialStore.CredentialRecord(
                accessToken: accessSentinel,
                refreshToken: refreshSentinel,
                idToken: idSentinel,
                accountId: accountSentinel,
                expiresAt: nil,
                lastRefresh: Date(timeIntervalSince1970: 1_700_000_000)
            )
            try writeLegacyCodex0644(record: legacy)
            CodexCredentialStore.isBootstrapCompleted = true

            let migrated = try #require(try CodexCredentialStore.currentRecord())
            #expect(migrated.refreshToken == refreshSentinel)
            #expect(!FileManager.default.fileExists(atPath: CodexCredentialStore.cacheFileURL().path))
            let keys = harness.fakeKeychain.storedKeys(
                service: CodexCredentialStore.ourKeychainService,
                account: CodexCredentialStore.ourKeychainAccount
            )
            #expect(keys?.contains("refreshToken") == true)
            #expect(keys?.contains("lastRefresh") == true)
        }
    }

    @Test("symlink legacy Claude file is refused and left in place")
    func claudeSymlinkLegacyRefused() throws {
        try withHarness { _ in
            let codeburnDir = ClaudeCredentialStore.cacheFileURL().deletingLastPathComponent()
            try FileManager.default.createDirectory(at: codeburnDir, withIntermediateDirectories: true)
            let target = codeburnDir.appendingPathComponent("not-a-cred.txt")
            try Data("x".utf8).write(to: target)
            let link = ClaudeCredentialStore.cacheFileURL()
            try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)

            ClaudeCredentialStore.isBootstrapCompleted = true
            let afterSymlink = try ClaudeCredentialStore.currentRecord()
            #expect(afterSymlink == nil)
            #expect(FileManager.default.fileExists(atPath: link.path))
        }
    }

    // MARK: - Disconnect / reinstall

    @Test("disconnect not-found is success; delete failure is observable")
    func disconnectIdempotentAndPartialFailure() throws {
        try withHarness { harness in
            let empty = ClaudeCredentialStore.resetBootstrap()
            #expect(empty.isSuccess)

            try ClaudeCredentialStore.writeOurCache(record: .init(
                accessToken: accessSentinel,
                refreshToken: refreshSentinel,
                expiresAt: nil,
                rateLimitTier: nil
            ))
            ClaudeCredentialStore.isBootstrapCompleted = true
            let controllable = ControllableKeychainCredentialCache(inner: harness.fakeKeychain)
            controllable.failDelete = true
            ClaudeCredentialStore.keychainCache = controllable

            let failed = ClaudeCredentialStore.resetBootstrap()
            #expect(!failed.isSuccess)
            #expect(failed.keychainDeletedOrAbsent == false)
            #expect(ClaudeCredentialStore.lastCacheDeleteResult?.isSuccess == false)
            #expect(ClaudeCredentialStore.isBootstrapCompleted == true)
        }
    }

    @Test("failed unlink after verified Keychain repairs leftover JSON to 0600")
    func failedUnlinkRepairsLegacyMode() throws {
        try withHarness { _ in
            let record = ClaudeCredentialStore.CredentialRecord(
                accessToken: accessSentinel,
                refreshToken: refreshSentinel,
                expiresAt: Date(timeIntervalSince1970: 1_900_000_000),
                rateLimitTier: "default"
            )
            try ClaudeCredentialStore.writeOurCache(record: record)
            try writeLegacyClaude0644(record: record)
            ClaudeCredentialStore.isBootstrapCompleted = true
            ClaudeCredentialStore.unlinkLegacyOverride = { _ in
                throw POSIXError(.EPERM)
            }
            ClaudeCredentialStore.clearMemoryCacheForTesting()
            _ = try ClaudeCredentialStore.currentRecord()
            #expect(FileManager.default.fileExists(atPath: ClaudeCredentialStore.cacheFileURL().path))
            #expect(posixMode(at: ClaudeCredentialStore.cacheFileURL()) == 0o600)

            // No sticky flag: the next read retries the unlink on its own.
            ClaudeCredentialStore.unlinkLegacyOverride = nil
            ClaudeCredentialStore.clearMemoryCacheForTesting()
            _ = try ClaudeCredentialStore.currentRecord()
            #expect(!FileManager.default.fileExists(atPath: ClaudeCredentialStore.cacheFileURL().path))
        }
    }

    @Test("failed tighten after failed unlink keeps leftover in place")
    func failedTightenLeavesRetrySignal() throws {
        try withHarness { _ in
            let record = ClaudeCredentialStore.CredentialRecord(
                accessToken: accessSentinel,
                refreshToken: refreshSentinel,
                expiresAt: Date(timeIntervalSince1970: 1_900_000_000),
                rateLimitTier: "default"
            )
            try ClaudeCredentialStore.writeOurCache(record: record)
            try writeLegacyClaude0644(record: record)
            ClaudeCredentialStore.isBootstrapCompleted = true
            ClaudeCredentialStore.unlinkLegacyOverride = { _ in throw POSIXError(.EPERM) }
            ClaudeCredentialStore.tightenLegacyOverride = { _ in throw POSIXError(.EPERM) }
            ClaudeCredentialStore.clearMemoryCacheForTesting()
            _ = try ClaudeCredentialStore.currentRecord()
            #expect(FileManager.default.fileExists(atPath: ClaudeCredentialStore.cacheFileURL().path))
        }
    }

    @Test("legacy-only disconnect failure keeps bootstrap so retry stays")
    func legacyOnlyDisconnectKeepsBootstrap() throws {
        try withHarness { _ in
            try ClaudeCredentialStore.writeOurCache(record: .init(
                accessToken: accessSentinel,
                refreshToken: refreshSentinel,
                expiresAt: nil,
                rateLimitTier: nil
            ))
            try writeLegacyClaude0644(record: .init(
                accessToken: accessSentinel,
                refreshToken: refreshSentinel,
                expiresAt: nil,
                rateLimitTier: nil
            ))
            ClaudeCredentialStore.isBootstrapCompleted = true
            ClaudeCredentialStore.unlinkLegacyOverride = { _ in throw POSIXError(.EPERM) }
            let failed = ClaudeCredentialStore.resetBootstrap()
            #expect(failed.keychainDeletedOrAbsent == true)
            #expect(failed.legacyDeletedOrAbsent == false)
            #expect(failed.isSuccess == false)
            #expect(ClaudeCredentialStore.isBootstrapCompleted == true)
        }
    }

    @Test("reinstall with empty Keychain and no legacy clears bootstrap on read")
    func reinstallMissingCacheClearsBootstrap() throws {
        try withHarness { _ in
            ClaudeCredentialStore.isBootstrapCompleted = true
            let missing = try ClaudeCredentialStore.currentRecord()
            #expect(missing == nil)
            #expect(ClaudeCredentialStore.isBootstrapCompleted == false)
        }
    }

    // MARK: - Locked / denied Keychain

    @Test("unavailable Keychain read is a miss, not a disconnect")
    func unavailableKeychainKeepsBootstrap() throws {
        try withHarness { harness in
            try ClaudeCredentialStore.writeOurCache(record: .init(
                accessToken: accessSentinel,
                refreshToken: refreshSentinel,
                expiresAt: Date(timeIntervalSince1970: 1_900_000_000),
                rateLimitTier: "default"
            ))
            ClaudeCredentialStore.isBootstrapCompleted = true

            let controllable = ControllableKeychainCredentialCache(inner: harness.fakeKeychain)
            controllable.failRead = true
            controllable.readStatus = errSecInteractionNotAllowed  // -25308
            ClaudeCredentialStore.keychainCache = controllable
            ClaudeCredentialStore.clearMemoryCacheForTesting()

            // Must not throw and must not clear bootstrap: a locked keychain is
            // "can't look right now", not "the user disconnected".
            #expect(try ClaudeCredentialStore.currentRecord() == nil)
            #expect(ClaudeCredentialStore.isBootstrapCompleted == true)
        }
    }

    @Test("a genuine read failure still surfaces as an error")
    func nonUnavailableReadStillThrows() throws {
        try withHarness { harness in
            ClaudeCredentialStore.isBootstrapCompleted = true
            let controllable = ControllableKeychainCredentialCache(inner: harness.fakeKeychain)
            controllable.failRead = true
            controllable.readStatus = errSecDecode
            ClaudeCredentialStore.keychainCache = controllable
            ClaudeCredentialStore.clearMemoryCacheForTesting()

            #expect(throws: KeychainCredentialCacheError.self) {
                _ = try ClaudeCredentialStore.currentRecord()
            }
        }
    }

    @Test("Keychain errors render a readable message, not a struct dump")
    func keychainErrorMessageIsReadable() {
        let unavailable = KeychainCredentialCacheError.unavailable(
            service: ClaudeCredentialStore.ourKeychainService,
            status: errSecInteractionNotAllowed
        )
        let text = unavailable.localizedDescription
        #expect(text.contains("Keychain unavailable"))
        // AppStore renders errors via localizedDescription; a struct dump would
        // read "unavailable(service:" and leak the raw item name.
        #expect(!text.contains("unavailable(service:"))
        #expect(!text.contains(ClaudeCredentialStore.ourKeychainService))
    }

    // MARK: - Recency between Keychain item and legacy file

    @Test("newer legacy file beats an older Keychain item and is then unlinked")
    func newerLegacyFileWins() throws {
        try withHarness { harness in
            // Keychain item from an old build: already expired.
            try ClaudeCredentialStore.writeOurCache(record: .init(
                accessToken: "cb-stale-keychain-token",
                refreshToken: nil,
                expiresAt: Date(timeIntervalSince1970: 1_700_000_000),
                rateLimitTier: "default"
            ))
            // Legacy file written far later by the pre-migration build.
            try writeLegacyClaude0644(record: .init(
                accessToken: accessSentinel,
                refreshToken: refreshSentinel,
                expiresAt: Date(timeIntervalSince1970: 1_900_000_000),
                rateLimitTier: "default"
            ))
            ClaudeCredentialStore.isBootstrapCompleted = true
            ClaudeCredentialStore.clearMemoryCacheForTesting()

            let record = try #require(try ClaudeCredentialStore.currentRecord())
            #expect(record.accessToken == accessSentinel)
            #expect(record.refreshToken == nil)
            #expect(!FileManager.default.fileExists(atPath: ClaudeCredentialStore.cacheFileURL().path))
            let keys = harness.fakeKeychain.storedKeys(
                service: ClaudeCredentialStore.ourKeychainService,
                account: ClaudeCredentialStore.ourKeychainAccount
            )
            #expect(keys?.contains("refreshToken") != true)
        }
    }

    @Test("older legacy file loses to a newer Keychain item and is unlinked")
    func olderLegacyFileLoses() throws {
        try withHarness { _ in
            try ClaudeCredentialStore.writeOurCache(record: .init(
                accessToken: accessSentinel,
                refreshToken: nil,
                expiresAt: Date(timeIntervalSince1970: 1_900_000_000),
                rateLimitTier: "default"
            ))
            try writeLegacyClaude0644(record: .init(
                accessToken: "cb-stale-file-token",
                refreshToken: refreshSentinel,
                expiresAt: Date(timeIntervalSince1970: 1_700_000_000),
                rateLimitTier: "default"
            ))
            ClaudeCredentialStore.isBootstrapCompleted = true
            ClaudeCredentialStore.clearMemoryCacheForTesting()

            let record = try #require(try ClaudeCredentialStore.currentRecord())
            #expect(record.accessToken == accessSentinel)
            #expect(!FileManager.default.fileExists(atPath: ClaudeCredentialStore.cacheFileURL().path))
        }
    }

    @Test("Codex prefers the legacy file with the later lastRefresh")
    func codexNewerLegacyFileWins() throws {
        try withHarness { _ in
            try CodexCredentialStore.writeOurCache(record: .init(
                accessToken: "cb-stale-codex-access",
                refreshToken: "cb-stale-codex-refresh",
                idToken: nil,
                accountId: accountSentinel,
                expiresAt: nil,
                lastRefresh: Date(timeIntervalSince1970: 1_700_000_000)
            ))
            try writeLegacyCodex0644(record: .init(
                accessToken: accessSentinel,
                refreshToken: refreshSentinel,
                idToken: idSentinel,
                accountId: accountSentinel,
                expiresAt: nil,
                lastRefresh: Date(timeIntervalSince1970: 1_800_000_000)
            ))
            CodexCredentialStore.isBootstrapCompleted = true
            CodexCredentialStore.clearMemoryCacheForTesting()

            let record = try #require(try CodexCredentialStore.currentRecord())
            #expect(record.refreshToken == refreshSentinel)
            #expect(!FileManager.default.fileExists(atPath: CodexCredentialStore.cacheFileURL().path))
        }
    }

    @Test("corrupt Keychain plus valid legacy repairs the CodeBurn item")
    func corruptKeychainRepairedFromLegacy() throws {
        try withHarness { harness in
            try harness.fakeKeychain.upsert(
                service: ClaudeCredentialStore.ourKeychainService,
                account: ClaudeCredentialStore.ourKeychainAccount,
                data: Data("%not-json%".utf8)
            )
            let legacy = ClaudeCredentialStore.CredentialRecord(
                accessToken: accessSentinel,
                refreshToken: refreshSentinel,
                expiresAt: Date(timeIntervalSince1970: 1_900_000_000),
                rateLimitTier: "default"
            )
            try writeLegacyClaude0644(record: legacy)
            ClaudeCredentialStore.isBootstrapCompleted = true

            let repaired = try #require(try ClaudeCredentialStore.currentRecord())
            #expect(repaired.accessToken == accessSentinel)
            #expect(repaired.refreshToken == nil)
            #expect(!FileManager.default.fileExists(atPath: ClaudeCredentialStore.cacheFileURL().path))
            let object = harness.fakeKeychain.storedJSONObject(
                service: ClaudeCredentialStore.ourKeychainService,
                account: ClaudeCredentialStore.ourKeychainAccount
            )
            #expect(object?.keys.contains("refreshToken") != true)
        }
    }
}
