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
        // Fixed cycle lengths from the payload's unit/count enum — the metadata
        // the early-reset monitor's windowSeconds contract needs (#1339).
        #expect(summary.details.map(\.windowSeconds) == [5 * 3600, 7 * 24 * 3600])
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

        // Byte-faithful to a recorded ZCode journal (redacted hexdump in the
        // #1347 review thread): origin, NUL, the 0x01 one-byte-string flag,
        // the key name, then the value frame — varint length (the recorded
        // 1,403-byte login encodes as fb 0a, neither a token character), the
        // same 0x01 flag, and the value's Latin-1 bytes.
        var journal = Data("https://zcode.z.ai".utf8)
        journal.append(contentsOf: [0x00, 0x01])
        journal.append(Data("oauth:zai:access_token".utf8))
        journal.append(contentsOf: [0xfb, 0x0a, 0x01])
        journal.append(Data("eyJhbGciOiJodHRwOi8vd3d3LnczLm9yZy8ifQ synthetic-trailer".utf8))
        try journal.write(to: leveldb.appendingPathComponent("000003.log"))

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

        func frame(_ value: String) -> Data {
            // The recorded framing; see readsZCodeAppLogin above.
            var data = Data("https://zcode.z.ai\u{00}\u{01}oauth:zai:access_token".utf8)
            data.append(contentsOf: [0xfb, 0x0a, 0x01])
            data.append(Data(value.utf8))
            return data
        }
        try frame("older-token-padding-aaaaaaaa").write(to: leveldb.appendingPathComponent("000001.log"))
        try frame("newer-token-padding-bbbbbbbb").write(to: leveldb.appendingPathComponent("000004.log"))
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
                resetsAt: Date(timeIntervalSince1970: 1_800_000_000),
                windowSeconds: 5 * 3600
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
