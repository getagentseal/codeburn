import Foundation
import SQLite3
import XCTest
@testable import CodeBurnMenubar

/// Fixture-driven coverage for CodeBurn's native Cursor quota adapter. Tests
/// use a synthetic JWT and temporary SQLite database; they never inspect the
/// operator's Cursor session or Keychain.
@MainActor
final class CursorQuotaTests: XCTestCase {
    private final class RequestRecorder: @unchecked Sendable {
        private(set) var requests: [URLRequest] = []
        func record(_ request: URLRequest) { requests.append(request) }
    }

    nonisolated private static let successBody = """
    {
      "billingCycleStart": "2026-08-01T00:00:00Z",
      "billingCycleEnd": "2026-09-01T00:00:00Z",
      "membershipType": "pro",
      "individualUsage": {
        "plan": {
          "enabled": true,
          "used": 850,
          "limit": 2000,
          "remaining": 1150,
          "autoPercentUsed": 20,
          "apiPercentUsed": 65,
          "totalPercentUsed": 42.5
        }
      }
    }
    """

    func testLocalCursorDatabaseIsReadWithoutWritingACodeBurnCredential() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("codeburn-cursor-auth-\(UUID().uuidString)", isDirectory: true)
        let databaseURL = root.appendingPathComponent("state.vscdb")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let token = Self.syntheticJWT()
        try Self.writeCursorDatabase(at: databaseURL, token: token)
        try FileManager.default.setAttributes([.posixPermissions: 0o444], ofItemAtPath: databaseURL.path)

        let loaded = try CursorAppSessionStore(databaseURL: databaseURL).loadAccessToken()

        XCTAssertEqual(loaded, token)
    }

    func testExistingCursorAppSessionConnectsAndMapsMonthlyQuota() async throws {
        let recorder = RequestRecorder()
        let token = Self.syntheticJWT()
        let deps = CursorSubscriptionService.Deps(
            loadAccessToken: { token },
            fetch: { request in
                recorder.record(request)
                return (
                    Data(Self.successBody.utf8),
                    Self.httpResponse(request, status: 200)
                )
            }
        )

        let summary = try await CursorSubscriptionService.refresh(deps: deps)

        XCTAssertEqual(summary.connection, .connected)
        XCTAssertEqual(summary.providerFilter, .cursor)
        XCTAssertEqual(summary.primary?.label, "Monthly")
        XCTAssertEqual(summary.primary?.percent ?? -1, 0.425, accuracy: 0.0001)
        XCTAssertEqual(summary.details.map(\.label), ["Monthly", "Auto", "API"])
        XCTAssertEqual(summary.details.map(\.percent), [0.425, 0.2, 0.65])
        XCTAssertEqual(summary.planLabel, "Pro")
        XCTAssertEqual(summary.footerLines, ["Source: Cursor app"])
        XCTAssertEqual(recorder.requests.count, 1)
        XCTAssertEqual(recorder.requests[0].url?.absoluteString, "https://cursor.com/api/usage-summary")
        XCTAssertEqual(recorder.requests[0].httpMethod, "GET")
        XCTAssertNil(recorder.requests[0].value(forHTTPHeaderField: "Authorization"))
        XCTAssertTrue(
            recorder.requests[0].value(forHTTPHeaderField: "Cookie")?
                .hasPrefix("WorkosCursorSessionToken=user_123%3A%3A") == true
        )
    }

    func testMissingOrExpiredCursorSessionIsTerminal() async throws {
        let missing = CursorSubscriptionService.Deps(
            loadAccessToken: { nil },
            fetch: { request in
                XCTFail("Network must not run without a Cursor app session")
                return (Data(), Self.httpResponse(request, status: 500))
            }
        )
        await assertFetchError(.noCredentials, deps: missing)

        let expired = CursorSubscriptionService.Deps(
            loadAccessToken: { Self.syntheticJWT(expiresAt: Date(timeIntervalSinceNow: -60)) },
            fetch: { request in
                XCTFail("Network must not run with an expired Cursor app session")
                return (Data(), Self.httpResponse(request, status: 500))
            }
        )
        await assertFetchError(.expiredSession, deps: expired)
    }

    func testUnreadableLocalStoreIsReportedHonestlyWithoutNetwork() async throws {
        struct SyntheticStoreFailure: Error {}
        let deps = CursorSubscriptionService.Deps(
            loadAccessToken: { throw SyntheticStoreFailure() },
            fetch: { request in
                XCTFail("Network must not run when the local store is unreadable")
                return (Data(), Self.httpResponse(request, status: 500))
            }
        )
        await assertFetchError(.appDataUnreadable, deps: deps)
    }

    func testMonthlyFallbackSurfacesTheTighterPool() throws {
        let body = """
        {
          "membershipType": "pro",
          "individualUsage": {
            "plan": { "autoPercentUsed": 20, "apiPercentUsed": 65 }
          }
        }
        """

        let summary = try CursorSubscriptionService.decode(Data(body.utf8))

        XCTAssertEqual(summary.primary?.percent ?? -1, 0.65, accuracy: 0.0001)
    }

    func testEnterpriseTeamSeatConnectsOnTeamOnDemandMeter() throws {
        // Key-for-key the Enterprise payload reported in #1546; amounts are synthetic.
        let body = """
        {
          "billingCycleStart": "2026-09-01T00:00:00.000Z",
          "billingCycleEnd": "2026-10-01T00:00:00.000Z",
          "membershipType": "enterprise",
          "limitType": "team",
          "isUnlimited": false,
          "autoModelSelectedDisplayMessage": "You've used 0% of your included total usage",
          "namedModelSelectedDisplayMessage": "You've used 0% of your included API usage",
          "individualUsage": {
            "overall": { "enabled": false, "used": 0, "limit": null, "remaining": null }
          },
          "teamUsage": {
            "onDemand": { "enabled": true, "used": 2500.5, "limit": 10000, "remaining": 7499.5 }
          }
        }
        """

        let summary = try CursorSubscriptionService.decode(Data(body.utf8))

        XCTAssertEqual(summary.connection, .connected)
        XCTAssertEqual(summary.planLabel, "Enterprise")
        XCTAssertEqual(summary.primary?.label, "Team on-demand")
        XCTAssertEqual(summary.primary?.percent ?? -1, 0.25005, accuracy: 0.0001)
        XCTAssertEqual(summary.details.map(\.label), ["Team on-demand"])
    }

    func testTeamOnDemandMeterSitsBesideTheMonthlyWindow() throws {
        let body = """
        {
          "individualUsage": { "plan": { "totalPercentUsed": 10 } },
          "teamUsage": { "onDemand": { "enabled": true, "used": 1, "limit": 4 } }
        }
        """

        let summary = try CursorSubscriptionService.decode(Data(body.utf8))

        XCTAssertEqual(summary.primary?.label, "Monthly")
        XCTAssertEqual(summary.details.map(\.label), ["Monthly", "Team on-demand"])
        XCTAssertEqual(summary.details.map(\.percent), [0.1, 0.25])
    }

    func testCursorAuthenticationResponsesAreTerminal() async throws {
        for status in [401, 403] {
            let deps = CursorSubscriptionService.Deps(
                loadAccessToken: { Self.syntheticJWT() },
                fetch: { request in (Data(), Self.httpResponse(request, status: status)) }
            )
            await assertFetchError(.authenticationRejected, deps: deps)
        }
    }

    func testCursorRateLimitAndMalformedPayloadRemainRetryable() async throws {
        let rateLimited = CursorSubscriptionService.Deps(
            loadAccessToken: { Self.syntheticJWT() },
            fetch: { request in (Data(), Self.httpResponse(request, status: 429)) }
        )
        await assertFetchError(.rateLimited, deps: rateLimited)

        let malformed = CursorSubscriptionService.Deps(
            loadAccessToken: { Self.syntheticJWT() },
            fetch: { request in (Data("not-json".utf8), Self.httpResponse(request, status: 200)) }
        )
        await assertFetchError(.parseFailure, deps: malformed)
    }

    private func assertFetchError(
        _ expected: CursorSubscriptionService.FetchError,
        deps: CursorSubscriptionService.Deps
    ) async {
        do {
            _ = try await CursorSubscriptionService.refresh(deps: deps)
            XCTFail("Expected Cursor refresh to fail with \(expected)")
        } catch let error as CursorSubscriptionService.FetchError {
            XCTAssertEqual(error, expected)
        } catch {
            XCTFail("Unexpected error type: \(type(of: error))")
        }
    }

    nonisolated private static func syntheticJWT(
        expiresAt: Date = Date(timeIntervalSinceNow: 3_600)
    ) -> String {
        let header = base64URL(Data(#"{"alg":"none","typ":"JWT"}"#.utf8))
        let expiration = Int(expiresAt.timeIntervalSince1970)
        let payload = base64URL(Data(#"{"sub":"auth0|user_123","exp":\#(expiration)}"#.utf8))
        return "\(header).\(payload).synthetic-signature"
    }

    nonisolated private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    nonisolated private static func httpResponse(
        _ request: URLRequest,
        status: Int
    ) -> HTTPURLResponse {
        HTTPURLResponse(
            url: request.url ?? URL(string: "https://cursor.com/api/usage-summary")!,
            statusCode: status,
            httpVersion: nil,
            headerFields: nil
        )!
    }

    nonisolated private static func writeCursorDatabase(at url: URL, token: String) throws {
        var database: OpaquePointer?
        guard sqlite3_open(url.path, &database) == SQLITE_OK else {
            sqlite3_close(database)
            throw SQLiteFixtureError.open
        }
        defer { sqlite3_close(database) }
        guard sqlite3_exec(
            database,
            "CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
            nil,
            nil,
            nil
        ) == SQLITE_OK else { throw SQLiteFixtureError.create }

        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(
            database,
            "INSERT INTO ItemTable(key, value) VALUES (?, ?);",
            -1,
            &statement,
            nil
        ) == SQLITE_OK else { throw SQLiteFixtureError.prepare }
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_text(statement, 1, "cursorAuth/accessToken", -1, sqliteTransientForTests)
        sqlite3_bind_text(statement, 2, token, -1, sqliteTransientForTests)
        guard sqlite3_step(statement) == SQLITE_DONE else { throw SQLiteFixtureError.insert }
    }

    private enum SQLiteFixtureError: Error {
        case open
        case create
        case prepare
        case insert
    }
}

private let sqliteTransientForTests = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
