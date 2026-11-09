import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Grok Bot subscription service")
@MainActor
struct GrokBotSubscriptionServiceTests {
    nonisolated private static func fractionalDate(_ raw: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: raw)
    }

    nonisolated private static func response(_ status: Int) -> HTTPURLResponse {
        HTTPURLResponse(
            url: GrokBotSubscriptionService.usageURL,
            statusCode: status,
            httpVersion: nil,
            headerFields: nil
        )!
    }

    nonisolated private static func deps(
        body: String,
        status: Int = 200,
        isInstalled: Bool = true,
        token: String? = "synthetic-cursor-token",
        record: RequestCapture? = nil
    ) -> GrokBotSubscriptionService.Deps {
        GrokBotSubscriptionService.Deps(
            isInstalled: { isInstalled },
            loadAccessToken: { token },
            fetch: { request in
                if let record { await record.record(request) }
                return (Data(body.utf8), response(status))
            }
        )
    }

    @Test("one POST with the Cursor session reports the weekly allowance")
    func decodesWeeklyUsage() async throws {
        let requests = RequestCapture()
        let result = try await GrokBotSubscriptionService.refresh(deps: Self.deps(
            body: #"""
            {"currentPeriodStart":"2026-09-13T14:56:21.487Z",
             "nextResetTimestampUtc":"2026-09-20T14:56:21.487Z",
             "usagePercent":98.542043,
             "hasAvailableUsage":true,
             "hasNonZeroIncludedLimit":true,
             "grokPlanLabel":"Grok Bot Plan"}
            """#,
            record: requests
        ))
        let captured = await requests.values

        #expect(result.connection == .connected)
        #expect(result.primary?.label == "Weekly usage")
        #expect(result.primary?.percent == 0.98542043)
        #expect(result.primary?.resetsAt == Self.fractionalDate("2026-09-20T14:56:21.487Z"))
        // #1339: no window length, so the early-reset monitor stays quiet.
        #expect(result.primary?.windowSeconds == nil)
        #expect(result.details.count == 1)
        #expect(result.planLabel == "Grok Bot Plan")
        #expect(result.footerLines == ["Source: Cursor dashboard (the account the Cursor app is signed into)"])

        #expect(captured.count == 1)
        let request = try #require(captured.first)
        #expect(request.url == GrokBotSubscriptionService.usageURL)
        #expect(request.httpMethod == "POST")
        #expect(request.httpBody == Data("{}".utf8))
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic-cursor-token")
        #expect(request.value(forHTTPHeaderField: "connect-protocol-version") == "1")
    }

    @Test("a payload without a percentage is not reported as zero")
    func rejectsMissingPercent() async {
        await #expect(throws: GrokBotSubscriptionService.FetchError.parseFailure) {
            try await GrokBotSubscriptionService.refresh(deps: Self.deps(
                body: #"{"nextResetTimestampUtc":"2026-09-20T14:56:21.487Z","hasNonZeroIncludedLimit":true}"#
            ))
        }
    }

    @Test("an account with no included allowance shows no reading")
    func reportsNoIncludedAllowance() async {
        await #expect(throws: GrokBotSubscriptionService.FetchError.noIncludedAllowance) {
            try await GrokBotSubscriptionService.refresh(deps: Self.deps(
                body: #"{"usagePercent":12.5,"hasNonZeroIncludedLimit":false}"#
            ))
        }
    }

    @Test("a pooled enterprise allowance has no per-account reading")
    func reportsPooledAllowance() async {
        await #expect(throws: GrokBotSubscriptionService.FetchError.pooledAllowance) {
            try await GrokBotSubscriptionService.refresh(deps: Self.deps(
                body: #"{"usagePercent":12.5,"hasNonZeroIncludedLimit":true,"usesPooledEnterpriseAllowance":true}"#
            ))
        }
    }

    @Test("a rejected Cursor session is terminal, not a retry")
    func rejectsUnauthorized() async {
        await #expect(throws: GrokBotSubscriptionService.FetchError.authenticationRejected) {
            try await GrokBotSubscriptionService.refresh(deps: Self.deps(body: "", status: 401))
        }
        #expect(GrokBotSubscriptionService.FetchError.authenticationRejected.classification == .terminalAuth)
    }

    @Test("a malformed body fails as a parse failure")
    func rejectsMalformedBody() async {
        await #expect(throws: GrokBotSubscriptionService.FetchError.parseFailure) {
            try await GrokBotSubscriptionService.refresh(deps: Self.deps(body: "not json"))
        }
        #expect(GrokBotSubscriptionService.FetchError.parseFailure.classification == .parseFailure)
    }

    @Test("a signed-out Cursor app reports the signed-out state, not a failure")
    func reportsMissingCursorSession() async {
        await #expect(throws: GrokBotSubscriptionService.FetchError.noCredentials) {
            try await GrokBotSubscriptionService.refresh(deps: Self.deps(body: "{}", token: "   "))
        }
    }

    @Test("nothing is read when Grok Bot is not installed")
    func skipsWhenNotInstalled() async {
        await #expect(throws: GrokBotSubscriptionService.FetchError.notInstalled) {
            try await GrokBotSubscriptionService.refresh(deps: GrokBotSubscriptionService.Deps(
                isInstalled: { false },
                loadAccessToken: {
                    Issue.record("Must not read the Cursor session when the app is absent")
                    return nil
                },
                fetch: { _ in
                    Issue.record("Must not reach the network when the app is absent")
                    return (Data(), Self.response(200))
                }
            ))
        }
    }

    @Test("installed detection accepts either Applications folder or the data root")
    func detectsInstallation() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("grokbot-install-\(UUID().uuidString)", isDirectory: true)
        let home = root.appendingPathComponent("home", isDirectory: true)
        let systemApplications = root.appendingPathComponent("Applications", isDirectory: true)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: systemApplications, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        func isInstalled() -> Bool {
            GrokBotSubscriptionService.isInstalled(home: home, systemApplications: systemApplications)
        }

        #expect(!isInstalled())

        let dataRoot = home.appendingPathComponent(".grokbot", isDirectory: true)
        try FileManager.default.createDirectory(at: dataRoot, withIntermediateDirectories: true)
        #expect(isInstalled())
        try FileManager.default.removeItem(at: dataRoot)

        let userBundle = home.appendingPathComponent("Applications/Grok Bot.app", isDirectory: true)
        try FileManager.default.createDirectory(at: userBundle, withIntermediateDirectories: true)
        #expect(isInstalled())
        try FileManager.default.removeItem(at: userBundle)

        let systemBundle = systemApplications.appendingPathComponent("Grok Bot.app", isDirectory: true)
        try FileManager.default.createDirectory(at: systemBundle, withIntermediateDirectories: true)
        #expect(isInstalled())
    }

    private actor RequestCapture {
        private(set) var values: [URLRequest] = []
        func record(_ request: URLRequest) { values.append(request) }
    }
}

private final class KeychainReads: @unchecked Sendable {
    private let lock = NSLock()
    private var reads = 0
    private let password: String?

    init(password: String?) { self.password = password }

    func read() -> String? {
        lock.withLock { reads += 1 }
        return password
    }

    var count: Int { lock.withLock { reads } }
}

/// Serialized: the one-read window in `CursorSafeStorage` is process-wide.
/// Fake Keychain and a test-only defaults suite; never the real ones.
@Suite("Grok Bot with a Cursor safe-storage session", .serialized)
@MainActor
struct GrokBotSafeStorageTests {
    private actor RequestCapture {
        private(set) var values: [URLRequest] = []
        func record(_ request: URLRequest) { values.append(request) }
    }

    nonisolated private static let password = "cursor-key-not-a-secret"

    nonisolated private static func deps(
        stored: String,
        suiteName: String,
        keychain: KeychainReads,
        record: RequestCapture
    ) -> GrokBotSubscriptionService.Deps {
        GrokBotSubscriptionService.Deps(
            isInstalled: { true },
            loadAccessToken: { stored },
            fetch: { request in
                await record.record(request)
                let response = HTTPURLResponse(
                    url: GrokBotSubscriptionService.usageURL, statusCode: 200, httpVersion: nil, headerFields: nil
                )!
                return (Data(#"{"usagePercent":30,"hasNonZeroIncludedLimit":true}"#.utf8), response)
            },
            unlock: { token, allowPrompt in
                try CursorSafeStorage.unlock(
                    token,
                    allowPrompt: allowPrompt,
                    defaults: TestDefaults.open(suiteName),
                    keychain: keychain.read
                )
            }
        )
    }

    @Test("a wrapped Cursor session is unlocked before the request")
    func unlocksBeforeTheRequest() async throws {
        let (_, suiteName) = TestDefaults.make("CodeBurnMenubarTests.GrokBot.\(#function)")
        defer { TestDefaults.forget(suiteName) }
        let stored = "cursor-safe-storage:v1:djEwWOtCQ9RSqI/bp3Cb+ehqZNzuvUmlpYA4EqgJuLmz/UY="
        let keychain = KeychainReads(password: Self.password)
        let requests = RequestCapture()

        let result = try await CapacityDockProviderRefreshInteraction.userInitiated {
            try await GrokBotSubscriptionService.refresh(deps: Self.deps(
                stored: stored, suiteName: suiteName, keychain: keychain, record: requests
            ))
        }
        let captured = await requests.values

        #expect(result.connection == .connected)
        #expect(captured.first?.value(forHTTPHeaderField: "Authorization") == "Bearer grokbot.unlock.signature")
        #expect(keychain.count == 1)
    }

    @Test("a locked keychain reports the Cursor locked message without a request")
    func lockedKeychainSkipsTheRequest() async throws {
        let (_, suiteName) = TestDefaults.make("CodeBurnMenubarTests.GrokBot.\(#function)")
        defer { TestDefaults.forget(suiteName) }
        let stored = "cursor-safe-storage:v1:djEwwcEvTGxG0eQsz8tltHi4nMFhfyawXN57+EQmOx9kp2c="
        let requests = RequestCapture()

        await #expect(throws: CursorSubscriptionService.FetchError.safeStorageLocked) {
            try await CapacityDockProviderRefreshInteraction.userInitiated {
                try await GrokBotSubscriptionService.refresh(deps: Self.deps(
                    stored: stored, suiteName: suiteName, keychain: KeychainReads(password: nil), record: requests
                ))
            }
        }
        let captured = await requests.values
        #expect(captured.isEmpty)
    }

    @Test("one user refresh reads the keychain once for Cursor and Grok Bot, a Deny included")
    func cursorAndGrokBotShareOneRead() async throws {
        let (defaults, suiteName) = TestDefaults.make("CodeBurnMenubarTests.GrokBot.\(#function)")
        defer { TestDefaults.forget(suiteName) }
        let requests = RequestCapture()

        let shared = "cursor-safe-storage:v1:djEwkOuI7I/ibOHkoPuEN9h3NuhddBfU0Ks47rbipX7Gl3I="
        let allowed = KeychainReads(password: Self.password)
        _ = try CursorSafeStorage.unlock(shared, allowPrompt: true, defaults: defaults, keychain: allowed.read)
        _ = try await CapacityDockProviderRefreshInteraction.userInitiated {
            try await GrokBotSubscriptionService.refresh(deps: Self.deps(
                stored: shared, suiteName: suiteName, keychain: allowed, record: requests
            ))
        }
        let captured = await requests.values
        #expect(allowed.count == 1)
        #expect(captured.first?.value(forHTTPHeaderField: "Authorization") == "Bearer grokbot.shared.signature")

        let denied = "cursor-safe-storage:v1:djEwlwr7B7sxKrGwF4YhlPPou9rEvdZQtIIdoejyoaqz+dY="
        let refused = KeychainReads(password: nil)
        #expect(throws: CursorSubscriptionService.FetchError.safeStorageLocked) {
            try CursorSafeStorage.unlock(denied, allowPrompt: true, defaults: defaults, keychain: refused.read)
        }
        await #expect(throws: CursorSubscriptionService.FetchError.safeStorageLocked) {
            try await CapacityDockProviderRefreshInteraction.userInitiated {
                try await GrokBotSubscriptionService.refresh(deps: Self.deps(
                    stored: denied, suiteName: suiteName, keychain: refused, record: requests
                ))
            }
        }
        #expect(refused.count == 1)
    }
}
