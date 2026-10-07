import XCTest
@testable import CodeBurnMenubar

/// Fixture-driven tests for the native ClinePass quota adapter.
/// The public HTTP contract is GET /api/v1/users/me/plan/usage-limits with a
/// bearer API key. All network goes through the injected transport; tests
/// never touch Keychain or the live API.
@MainActor
final class ClinePassQuotaTests: XCTestCase {

    private final class RequestRecorder: @unchecked Sendable {
        private(set) var requests: [URLRequest] = []
        func record(_ request: URLRequest) { requests.append(request) }
    }

    nonisolated private static let syntheticKey = "synthetic-clinepass-test-key"

    nonisolated private static let successBody = """
    {
      "success": true,
      "data": {
        "limits": [
          {"type": "five_hour", "percentUsed": 13.5, "resetsAt": "2026-08-29T05:00:00Z"},
          {"type": "weekly", "percentUsed": 42, "resetsAt": "2026-09-05T00:00:00Z"},
          {"type": "monthly", "percentUsed": 7, "resetsAt": "2026-09-23T08:00:00Z"}
        ]
      }
    }
    """

    nonisolated private static func httpResponse(_ request: URLRequest, status: Int) -> HTTPURLResponse {
        HTTPURLResponse(
            url: request.url ?? URL(string: "https://api.cline.bot/api/v1/users/me/plan/usage-limits")!,
            statusCode: status,
            httpVersion: nil,
            headerFields: nil
        )!
    }

    private static func makeDeps(
        recorder: RequestRecorder,
        ambient: ClinePassSubscriptionService.Credential? = nil,
        respond: @escaping @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)
    ) -> ClinePassSubscriptionService.Deps {
        ClinePassSubscriptionService.Deps(
            fetch: { request in
                recorder.record(request)
                return try await respond(request)
            },
            loadAmbientCredential: { ambient },
            now: { Date(timeIntervalSince1970: 1_800_000_000) }
        )
    }

    private static func providersFile(_ settings: String) -> Data {
        #"{"providers":{"cline":{"settings":\#(settings)},"anthropic":{"settings":{"apiKey":"other"}}}}"#
            .data(using: .utf8)!
    }

    func testCredentialFilePrefersAccessTokenThenApiKeyThenAuthApiKey() {
        let oauth = ClinePassSubscriptionService.fileCredential(Self.providersFile(
            #"{"apiKey":"k1","auth":{"accessToken":"workos:tok","apiKey":"k2","expiresAt":1800000060000}}"#))
        XCTAssertEqual(oauth, .init(token: "workos:tok", isOAuth: true, expiresAt: Date(timeIntervalSince1970: 1_800_000_060)))
        XCTAssertEqual(
            ClinePassSubscriptionService.fileCredential(Self.providersFile(#"{"auth":{"accessToken":"bare"}}"#))?.token,
            "workos:bare")
        XCTAssertEqual(
            ClinePassSubscriptionService.fileCredential(Self.providersFile(#"{"apiKey":"k1","auth":{"apiKey":"k2"}}"#)),
            .init(token: "k1", isOAuth: false, expiresAt: nil))
        XCTAssertEqual(
            ClinePassSubscriptionService.fileCredential(Self.providersFile(#"{"auth":{"apiKey":"k2"}}"#))?.token, "k2")
        XCTAssertNil(ClinePassSubscriptionService.fileCredential(Self.providersFile(#"{"provider":"cline"}"#)))
    }

    func testProvidersFileFollowsClineOverrides() {
        let home = URL(fileURLWithPath: "/home/u")
        let path = { (env: [String: String]) in
            ClinePassSubscriptionService.providersFileURL(environment: env, home: home).path
        }
        XCTAssertEqual(path([:]), "/home/u/.cline/data/settings/providers.json")
        XCTAssertEqual(path(["CLINE_DIR": "~/c"]), "/home/u/c/data/settings/providers.json")
        XCTAssertEqual(path(["CLINE_DIR": "/c", "CLINE_DATA_DIR": "/d"]), "/d/settings/providers.json")
        XCTAssertEqual(path(["CLINE_DATA_DIR": "/d", "CLINE_PROVIDER_SETTINGS_PATH": "/f.json"]), "/f.json")
    }

    func testWithoutSavedKeyUsesTheClineSession() async throws {
        let recorder = RequestRecorder()
        let deps = Self.makeDeps(
            recorder: recorder,
            ambient: .init(token: "workos:session", isOAuth: true, expiresAt: Date(timeIntervalSince1970: 1_800_000_060))
        ) { request in
            (Self.successBody.data(using: .utf8)!, Self.httpResponse(request, status: 200))
        }
        _ = try await ClinePassSubscriptionService.refresh(apiKey: "  ", deps: deps)
        _ = try await ClinePassSubscriptionService.refresh(apiKey: Self.syntheticKey, deps: deps)
        XCTAssertEqual(
            recorder.requests.map { $0.value(forHTTPHeaderField: "Authorization") },
            ["Bearer workos:session", "Bearer \(Self.syntheticKey)"])
    }

    func testExpiredClineSessionStopsBeforeTheNetwork() async {
        let recorder = RequestRecorder()
        let deps = Self.makeDeps(
            recorder: recorder,
            ambient: .init(token: "workos:old", isOAuth: true, expiresAt: Date(timeIntervalSince1970: 1_799_999_999))
        ) { request in
            (Self.successBody.data(using: .utf8)!, Self.httpResponse(request, status: 200))
        }
        do {
            _ = try await ClinePassSubscriptionService.refresh(apiKey: nil, deps: deps)
            XCTFail("Expected an expired sign-in")
        } catch {
            XCTAssertEqual(error as? ClinePassSubscriptionService.FetchError, .signInExpired)
            XCTAssertEqual(error.localizedDescription, "Cline sign-in expired. Run cline to refresh it.")
            XCTAssertEqual((error as? ClinePassSubscriptionService.FetchError)?.classification, .transient)
        }
        XCTAssertTrue(recorder.requests.isEmpty)
    }

    func testRejectedClineSessionReadsAsExpiredAndMissingCredentialIsTerminal() async {
        let recorder = RequestRecorder()
        let rejected = Self.makeDeps(
            recorder: recorder,
            ambient: .init(token: "workos:revoked", isOAuth: true, expiresAt: nil)
        ) { request in
            (Data("{}".utf8), Self.httpResponse(request, status: 401))
        }
        do {
            _ = try await ClinePassSubscriptionService.refresh(apiKey: nil, deps: rejected)
            XCTFail("Expected an expired sign-in")
        } catch {
            XCTAssertEqual(error as? ClinePassSubscriptionService.FetchError, .signInExpired)
        }
        let none = Self.makeDeps(recorder: recorder) { request in
            (Data("{}".utf8), Self.httpResponse(request, status: 200))
        }
        do {
            _ = try await ClinePassSubscriptionService.refresh(apiKey: nil, deps: none)
            XCTFail("Expected missing credentials")
        } catch {
            XCTAssertEqual(error as? ClinePassSubscriptionService.FetchError, .noCredentials)
        }
    }

    func testSuccessfulPayloadMapsFiveHourWeeklyAndMonthlyWindows() async throws {
        let recorder = RequestRecorder()
        let deps = Self.makeDeps(recorder: recorder) { request in
            (Self.successBody.data(using: .utf8)!, Self.httpResponse(request, status: 200))
        }

        let summary = try await ClinePassSubscriptionService.refresh(
            apiKey: Self.syntheticKey,
            deps: deps
        )

        XCTAssertEqual(summary.connection, .connected)
        XCTAssertEqual(summary.details.map(\.label), ["5-hour", "Weekly", "Monthly"])
        XCTAssertEqual(summary.details.map(\.percent), [0.135, 0.42, 0.07])
        XCTAssertEqual(summary.primary?.label, "Weekly")
        XCTAssertEqual(summary.primary?.percent ?? -1, 0.42, accuracy: 0.0001)
        XCTAssertEqual(summary.details[0].resetsAt, Date(timeIntervalSince1970: 1_787_979_600))
        XCTAssertEqual(summary.details[1].resetsAt, Date(timeIntervalSince1970: 1_788_566_400))
        XCTAssertEqual(summary.details[2].resetsAt, Date(timeIntervalSince1970: 1_790_150_400))
        XCTAssertEqual(recorder.requests.count, 1)
        let request = recorder.requests[0]
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(
            request.url?.absoluteString,
            "https://api.cline.bot/api/v1/users/me/plan/usage-limits")
        XCTAssertEqual(
            request.value(forHTTPHeaderField: "Authorization"),
            "Bearer \(Self.syntheticKey)")
    }

    func testAuthenticationResponsesAreTerminal() async throws {
        for status in [401, 403] {
            let recorder = RequestRecorder()
            let deps = Self.makeDeps(recorder: recorder) { request in
                (Data(), Self.httpResponse(request, status: status))
            }

            do {
                _ = try await ClinePassSubscriptionService.refresh(apiKey: Self.syntheticKey, deps: deps)
                XCTFail("Expected HTTP \(status) to reject authentication")
            } catch let error as ClinePassSubscriptionService.FetchError {
                XCTAssertEqual(error, .authenticationRejected)
                XCTAssertEqual(error.classification, .terminalAuth)
            }
        }
    }

    func testRateLimitIsTransient() async throws {
        let recorder = RequestRecorder()
        let deps = Self.makeDeps(recorder: recorder) { request in
            (Data(), Self.httpResponse(request, status: 429))
        }

        do {
            _ = try await ClinePassSubscriptionService.refresh(apiKey: Self.syntheticKey, deps: deps)
            XCTFail("Expected a rate-limit failure")
        } catch let error as ClinePassSubscriptionService.FetchError {
            XCTAssertEqual(error, .rateLimited)
            XCTAssertEqual(error.classification, .transient)
        }
    }

    func testMalformedSuccessPayloadsAreParseFailures() async throws {
        let malformedBodies = [
            "not json",
            #"{"success":false}"#,
            #"{"success":true,"data":{}}"#,
            #"{"success":true,"data":{"limits":[]}}"#,
            #"{"success":true,"data":{"limits":[{"type":"unknown","percentUsed":12}]}}"#,
            #"{"success":true,"data":{"limits":[{"type":"weekly"}]}}"#,
        ]

        for body in malformedBodies {
            let recorder = RequestRecorder()
            let deps = Self.makeDeps(recorder: recorder) { request in
                (Data(body.utf8), Self.httpResponse(request, status: 200))
            }

            do {
                _ = try await ClinePassSubscriptionService.refresh(apiKey: Self.syntheticKey, deps: deps)
                XCTFail("Expected malformed payload to fail")
            } catch let error as ClinePassSubscriptionService.FetchError {
                XCTAssertEqual(error, .parseFailure)
                XCTAssertEqual(error.classification, .parseFailure)
            }
        }
    }
}
