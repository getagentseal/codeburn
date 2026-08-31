import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Z.ai quota")
@MainActor
struct ZaiQuotaTests {
    private final class RequestRecorder: @unchecked Sendable {
        private(set) var requests: [URLRequest] = []
        func record(_ request: URLRequest) { requests.append(request) }
    }

    nonisolated private static let syntheticKey = "synthetic-zai-test-key"
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
            url: request.url ?? ZaiSubscriptionService.usageURL,
            statusCode: status,
            httpVersion: nil,
            headerFields: nil
        )!
    }

    private static func deps(
        recorder: RequestRecorder,
        status: Int = 200,
        body: String = successBody
    ) -> ZaiSubscriptionService.Deps {
        ZaiSubscriptionService.Deps(
            loadAPIKey: { nil },
            fetch: { request in
                recorder.record(request)
                return (Data(body.utf8), response(request, status: status))
            }
        )
    }

    @Test("current credit windows and raw authorization header")
    func currentCreditWindows() async throws {
        let recorder = RequestRecorder()
        let summary = try await ZaiSubscriptionService.refresh(
            apiKey: "  \(Self.syntheticKey)  ",
            deps: Self.deps(recorder: recorder)
        )

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
        #expect(request.url == ZaiSubscriptionService.usageURL)
        #expect(request.value(forHTTPHeaderField: "Authorization") == Self.syntheticKey)
    }

    @Test("reads an existing Pi Z.ai login without copying it")
    func readsPiLogin() throws {
        let home = FileManager.default.temporaryDirectory
            .appendingPathComponent("codeburn-zai-test-\(UUID().uuidString)", isDirectory: true)
        let authURL = home.appendingPathComponent(".pi/agent/auth.json", isDirectory: false)
        defer { try? FileManager.default.removeItem(at: home) }
        try FileManager.default.createDirectory(
            at: authURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data(#"{"zai":{"type":"api_key","key":" pi-zai-key "}}"#.utf8).write(to: authURL)

        #expect(try ZaiSubscriptionService.loadPiAPIKey(home: home) == "pi-zai-key")
    }

    @Test("legacy token windows and derived percentages remain supported")
    func legacyTokenWindow() throws {
        let summary = try ZaiSubscriptionService.decode(Data("""
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
            (401, ZaiSubscriptionService.FetchError.authenticationRejected),
            (403, .authenticationRejected),
            (429, .rateLimited),
            (503, .providerUnavailable),
        ] {
            let recorder = RequestRecorder()
            do {
                _ = try await ZaiSubscriptionService.refresh(
                    apiKey: Self.syntheticKey,
                    deps: Self.deps(recorder: recorder, status: status)
                )
                Issue.record("Expected HTTP \(status) to fail")
            } catch let error as ZaiSubscriptionService.FetchError {
                #expect(error == expected)
            }
        }
    }

    @Test("body-level rejections map to real errors, not parse failures")
    func bodyLevelRejection() throws {
        for (body, expected) in [
            (#"{"code":401,"msg":"token expired or incorrect","success":false}"#,
             ZaiSubscriptionService.FetchError.authenticationRejected),
            (#"{"code":403,"msg":"forbidden","success":false}"#, .authenticationRejected),
            (#"{"code":429,"msg":"slow down","success":false}"#, .rateLimited),
            (#"{"code":500,"msg":"boom","success":false}"#, .providerUnavailable),
        ] {
            do {
                _ = try ZaiSubscriptionService.decode(Data(body.utf8))
                Issue.record("Expected body-level rejection to fail")
            } catch let error as ZaiSubscriptionService.FetchError {
                #expect(error == expected)
            }
        }
    }

    @Test("malformed or empty quota fails")
    func malformedQuota() throws {
        for body in [
            "not json",
            #"{"data":{}}"#,
            #"{"data":{"limits":[]}}"#,
            #"{"data":{"limits":[{"type":"CREDIT_LIMIT","unit":3,"number":5}]}}"#,
        ] {
            do {
                _ = try ZaiSubscriptionService.decode(Data(body.utf8))
                Issue.record("Expected malformed quota to fail")
            } catch let error as ZaiSubscriptionService.FetchError {
                #expect(error == .parseFailure)
            }
        }
    }
}
