import Foundation
import Security
import Testing
@testable import CodeBurnMenubar

/// The ONLY test that touches a real Keychain. Everything else in the suite runs
/// against `InMemoryKeychainCredentialCache`.
///
/// It writes to a throwaway service name (`…menubar.selftest.oauth.v1`) that no
/// build ever reads, never touches the Claude/Codex production items, and deletes
/// what it created. A plain `swift test` never touches the real Keychain at all:
/// these tests run only with `CODEBURN_TEST_REAL_KEYCHAIN=1` set. Under that flag,
/// if the login Keychain is locked or unavailable — headless CI, SSH session, no
/// login Keychain — the whole suite is SKIPPED rather than failed; look for
/// "live Keychain unavailable" in the output to tell a skip from a pass.
@Suite("Live Keychain adapter", .serialized)
struct LiveKeychainCredentialCacheTests {
    private static let service = "org.agentseal.codeburn.menubar.selftest.oauth.v1"
    private static let account = "selftest"

    private static let realKeychainTestsRequested =
        ProcessInfo.processInfo.environment["CODEBURN_TEST_REAL_KEYCHAIN"] == "1"

    /// True when this machine can round-trip a generic password right now.
    /// Never probes the real Keychain unless explicitly opted into.
    private static let isAvailable: Bool = {
        guard realKeychainTestsRequested else { return false }
        let live = LiveKeychainCredentialCache()
        do {
            try live.upsert(service: service, account: account, data: Data("probe".utf8))
            _ = try live.read(service: service, account: account)
            try live.delete(service: service, account: account)
            return true
        } catch {
            try? live.delete(service: service, account: account)
            return false
        }
    }()

    @Test("live adapter round-trips write → read → update → delete")
    func liveRoundTrip() throws {
        guard Self.isAvailable else {
            print("SKIP: live Keychain unavailable or CODEBURN_TEST_REAL_KEYCHAIN not set")
            return
        }
        let live = LiveKeychainCredentialCache()
        defer { try? live.delete(service: Self.service, account: Self.account) }

        #expect(try live.read(service: Self.service, account: Self.account) == nil)

        try live.upsert(service: Self.service, account: Self.account, data: Data(#"{"v":1}"#.utf8))
        let first = try #require(try live.read(service: Self.service, account: Self.account))
        #expect(String(data: first, encoding: .utf8) == #"{"v":1}"#)

        // upsert must update in place, not duplicate.
        try live.upsert(service: Self.service, account: Self.account, data: Data(#"{"v":2}"#.utf8))
        let second = try #require(try live.read(service: Self.service, account: Self.account))
        #expect(String(data: second, encoding: .utf8) == #"{"v":2}"#)

        try live.delete(service: Self.service, account: Self.account)
        #expect(try live.read(service: Self.service, account: Self.account) == nil)
        // Deleting an absent item is success, so disconnect stays idempotent.
        #expect(throws: Never.self) {
            try live.delete(service: Self.service, account: Self.account)
        }
    }

    /// Documents the measured behaviour that motivates the pre-flight lock check.
    /// The locked-keychain case itself is deliberately NOT exercised at runtime:
    /// reproducing it requires a keychain operation that raises a password panel
    /// on the tester's screen. Measured once by hand on macOS 15 against a
    /// throwaway keychain: with the keychain locked, `SecItemCopyMatching` blocks
    /// on an unlock panel even when the query carries
    /// `kSecUseAuthenticationUI: …Fail` or a non-interactive `LAContext` — both
    /// govern the data-protection keychain, not file-keychain unlocking. Skipping
    /// the read while locked is therefore the only reliable suppression.
    @Test("unavailable statuses are classified as transient, not as a missing item")
    func unavailableClassification() {
        #expect(KeychainCredentialCacheError.isUnavailable(errSecInteractionNotAllowed))
        #expect(KeychainCredentialCacheError.isUnavailable(errSecAuthFailed))
        #expect(KeychainCredentialCacheError.isUnavailable(errSecUserCanceled))
        #expect(KeychainCredentialCacheError.isUnavailable(errSecInteractionRequired))
        // errSecItemNotFound is a real miss and must never be treated as transient.
        #expect(!KeychainCredentialCacheError.isUnavailable(errSecItemNotFound))
        #expect(!KeychainCredentialCacheError.isUnavailable(errSecDecode))
    }

    @Test("live reads never block on an interactive prompt")
    func liveReadIsNonInteractive() throws {
        guard Self.isAvailable else {
            print("SKIP: live Keychain unavailable or CODEBURN_TEST_REAL_KEYCHAIN not set")
            return
        }
        let live = LiveKeychainCredentialCache()
        defer { try? live.delete(service: Self.service, account: Self.account) }
        try live.upsert(service: Self.service, account: Self.account, data: Data("x".utf8))

        // The read carries a non-interactive LAContext, so it either returns or
        // fails fast. A prompt would park this call until a human dismissed it.
        let start = Date()
        _ = try? live.read(service: Self.service, account: Self.account)
        #expect(Date().timeIntervalSince(start) < 5)
    }
}
