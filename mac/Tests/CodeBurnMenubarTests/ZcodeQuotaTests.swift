import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("ZCode quota")
@MainActor
struct ZcodeQuotaTests {
    private final class RequestRecorder: @unchecked Sendable {
        private(set) var requests: [URLRequest] = []
        func record(_ request: URLRequest) { requests.append(request) }
    }

    nonisolated private static let successBody = """
    {
      "code": 200,
      "data": {
        "level": "pro",
        "limits": [
          {"type":"CREDIT_LIMIT","unit":3,"number":5,"usage":12000,"currentValue":360,"percentage":3,"nextResetTime":1800000000000},
          {"type":"CREDIT_LIMIT","unit":6,"number":1,"usage":60000,"currentValue":10800,"percentage":18,"nextResetTime":1800500000000}
        ]
      }
    }
    """

    nonisolated private static func response(_ request: URLRequest, status: Int) -> HTTPURLResponse {
        HTTPURLResponse(
            url: request.url ?? ZcodeSubscriptionService.usageURL,
            statusCode: status,
            httpVersion: nil,
            headerFields: nil
        )!
    }

    private static func deps(
        recorder: RequestRecorder,
        status: Int = 200,
        body: String = successBody,
        token: String? = "synthetic-zcode-test-token"
    ) -> ZcodeSubscriptionService.Deps {
        ZcodeSubscriptionService.Deps(
            loadToken: { token },
            fetch: { request in
                recorder.record(request)
                return (Data(body.utf8), response(request, status: status))
            }
        )
    }

    @Test("current credit windows travel as a bearer token")
    func currentCreditWindows() async throws {
        let recorder = RequestRecorder()
        let summary = try await ZcodeSubscriptionService.refresh(deps: Self.deps(recorder: recorder))

        #expect(summary.connection == .connected)
        #expect(summary.planLabel == "Pro")
        #expect(summary.details.map(\.label) == ["5-hour", "Weekly"])
        #expect(summary.details.map(\.percent) == [0.03, 0.18])
        #expect(summary.primary?.label == "Weekly")
        #expect(summary.details[0].resetsAt == Date(timeIntervalSince1970: 1_800_000_000))
        #expect(summary.details[1].resetsAt == Date(timeIntervalSince1970: 1_800_500_000))
        #expect(summary.footerLines == ["Source: Z.ai Coding Plan"])

        let request = try #require(recorder.requests.first)
        #expect(request.httpMethod == "GET")
        #expect(request.url == ZcodeSubscriptionService.usageURL)
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic-zcode-test-token")
    }

    @Test("a missing ZCode app login is terminal, not a fetch")
    func missingLoginNeverFetches() async throws {
        let recorder = RequestRecorder()
        do {
            _ = try await ZcodeSubscriptionService.refresh(deps: Self.deps(recorder: recorder, token: nil))
            Issue.record("Expected a missing login to fail")
        } catch let error as ZcodeSubscriptionService.FetchError {
            #expect(error == .noCredentials)
        }
        #expect(recorder.requests.isEmpty)
    }

    @Test("recovers the z.ai token from a ZCode Local Storage journal")
    func readsZCodeAppLogin() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("codeburn-zcode-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let leveldb = root
            .appendingPathComponent("session/Partitions/zcode-coding-plan", isDirectory: true)
            .appendingPathComponent("Local Storage", isDirectory: true)
            .appendingPathComponent("leveldb", isDirectory: true)
        try FileManager.default.createDirectory(at: leveldb, withIntermediateDirectories: true)

        // Chromium's journal framing: key bytes, a varint length plus string
        // marker gap (here a NUL and a 0x01), then the value bytes.
        let journal = "oauth:zai:access_token\u{00}\u{01}eyJhbGciOiJodHRwOi8vd3d3LnczLm9yZy8ifQ synthetic-trailer"
        try Data(journal.utf8).write(to: leveldb.appendingPathComponent("000003.log"))

        #expect(
            ZcodeSubscriptionService.accessToken(fromZCodeDataRoot: root)
                == "eyJhbGciOiJodHRwOi8vd3d3LnczLm9yZy8ifQ"
        )
    }

    @Test("the newest journal write wins and non-journals are ignored")
    func newestJournalWriteWins() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("codeburn-zcode-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let leveldb = root
            .appendingPathComponent("session/Partitions/zcode-coding-plan", isDirectory: true)
            .appendingPathComponent("Local Storage", isDirectory: true)
            .appendingPathComponent("leveldb", isDirectory: true)
        try FileManager.default.createDirectory(at: leveldb, withIntermediateDirectories: true)

        let older = "oauth:zai:access_token\u{00}\u{01}older-token-padding-aaaaaaaa"
        let newer = "oauth:zai:access_token\u{00}\u{01}newer-token-padding-bbbbbbbb"
        try Data(older.utf8).write(to: leveldb.appendingPathComponent("000001.log"))
        try Data(newer.utf8).write(to: leveldb.appendingPathComponent("000004.log"))
        try Data("COMPRESSED".utf8).write(to: leveldb.appendingPathComponent("000005.ldb"))

        #expect(
            ZcodeSubscriptionService.accessToken(fromZCodeDataRoot: root)
                == "newer-token-padding-bbbbbbbb"
        )
    }

    @Test("no ZCode app data is the same as never signed in")
    func missingAppDataYieldsNoToken() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("codeburn-zcode-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        #expect(ZcodeSubscriptionService.accessToken(fromZCodeDataRoot: root) == nil)
    }

    @Test("legacy string windows and derived percentages remain supported")
    func legacyTokenWindow() throws {
        let summary = try ZcodeSubscriptionService.decode(Data("""
        {"data":{"limits":[
          {"type":"TOKENS_LIMIT","unit":"3","number":"5","usage":"2000","currentValue":"500","nextResetTime":"1800000000"}
        ]}}
        """.utf8))

        #expect(summary.details == [
            QuotaSummary.Window(
                label: "5-hour",
                percent: 0.25,
                resetsAt: Date(timeIntervalSince1970: 1_800_000_000)
            ),
        ])
    }

    @Test("HTTP failures keep terminal and retryable classifications")
    func failureClassification() async throws {
        for (status, expected) in [
            (401, ZcodeSubscriptionService.FetchError.authenticationRejected),
            (403, .authenticationRejected),
            (429, .rateLimited),
            (503, .providerUnavailable),
        ] {
            let recorder = RequestRecorder()
            do {
                _ = try await ZcodeSubscriptionService.refresh(
                    deps: Self.deps(recorder: recorder, status: status)
                )
                Issue.record("Expected HTTP \(status) to fail")
            } catch let error as ZcodeSubscriptionService.FetchError {
                #expect(error == expected)
            }
        }
    }

    @Test("HTTP 200 body authentication failures are terminal")
    func bodyAuthenticationFailure() async throws {
        for code in [401, 403] {
            let recorder = RequestRecorder()
            let body = #"{"code":\#(code),"msg":"token expired or incorrect","success":false}"#
            do {
                _ = try await ZcodeSubscriptionService.refresh(
                    deps: Self.deps(recorder: recorder, body: body)
                )
                Issue.record("Expected body code \(code) to reject authentication")
            } catch let error as ZcodeSubscriptionService.FetchError {
                #expect(error == .authenticationRejected)
            }
        }
    }

    @Test("malformed or empty quota fails")
    func malformedQuota() throws {
        for body in [
            "not json",
            #"{"code":500,"success":false}"#,
            #"{"data":{}}"#,
            #"{"data":{"limits":[]}}"#,
            #"{"data":{"limits":[{"type":"CREDIT_LIMIT","unit":3,"number":5}]}}"#,
        ] {
            do {
                _ = try ZcodeSubscriptionService.decode(Data(body.utf8))
                Issue.record("Expected malformed quota to fail")
            } catch let error as ZcodeSubscriptionService.FetchError {
                #expect(error == .parseFailure)
            }
        }
    }
}
