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
