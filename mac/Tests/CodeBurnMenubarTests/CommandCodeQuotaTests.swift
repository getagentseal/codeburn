import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Command Code quota")
@MainActor
struct CommandCodeQuotaTests {
    private final class RequestRecorder: @unchecked Sendable {
        private(set) var requests: [URLRequest] = []
        func record(_ request: URLRequest) { requests.append(request) }
    }

    nonisolated private static let creditsBody = """
    {"credits":{"monthlyCredits":3.9706645399,"purchasedCredits":0,"freeCredits":0},
     "windowLimits":{"limited":true,"exceeded":"weekly",
       "fiveHour":{"used":0.75,"cap":3,"exceeded":false,"resetAt":0},
       "weekly":{"used":6.0293354601,"cap":6,"exceeded":true,"resetAt":1791653049551}}}
    """
    nonisolated private static let subscriptionBody = #"{"success":true,"data":{"status":"active","planId":"individual-go-v1"}}"#

    nonisolated private static func response(_ request: URLRequest, _ status: Int) -> HTTPURLResponse {
        HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
    }

    private static func deps(
        key: String? = "synthetic-commandcode-key",
        recorder: RequestRecorder = RequestRecorder(),
        respond: @escaping @Sendable (URLRequest) throws -> (Data, HTTPURLResponse)
    ) -> CommandCodeSubscriptionService.Deps {
        CommandCodeSubscriptionService.Deps(
            loadAPIKey: { key },
            fetch: { request in
                recorder.record(request)
                return try respond(request)
            }
        )
    }

    @Test("maps both windows, the plan and the remaining credits")
    func decodesLiveShape() async throws {
        let recorder = RequestRecorder()
        let summary = try await CommandCodeSubscriptionService.refresh(deps: Self.deps(recorder: recorder) { request in
            let body = request.url == CommandCodeSubscriptionService.creditsURL ? Self.creditsBody : Self.subscriptionBody
            return (Data(body.utf8), Self.response(request, 200))
        })
        #expect(summary.details.map(\.label) == ["5-hour", "Weekly"])
        #expect(summary.details.map(\.percent) == [0.25, 1])
        #expect(summary.details[0].resetsAt == nil)
        #expect(summary.details[1].resetsAt == Date(timeIntervalSince1970: 1_791_653_049.551))
        #expect(summary.primary?.label == "Weekly")
        #expect(summary.planLabel == "Go")
        #expect(summary.footerLines == ["Credits left: $3.97 monthly"])
        #expect(recorder.requests.count == 2)
        for request in recorder.requests {
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic-commandcode-key")
            #expect(request.value(forHTTPHeaderField: "User-Agent") == "CodeBurn")
        }
    }

    @Test("a failed subscription call only drops the plan label")
    func subscriptionFailureKeepsWindows() async throws {
        let summary = try await CommandCodeSubscriptionService.refresh(deps: Self.deps { request in
            request.url == CommandCodeSubscriptionService.creditsURL
                ? (Data(Self.creditsBody.utf8), Self.response(request, 200))
                : (Data("{}".utf8), Self.response(request, 500))
        })
        #expect(summary.planLabel == nil)
        #expect(summary.details.count == 2)
    }

    @Test("missing key, rejected key and bad bodies map to their errors")
    func errors() async {
        let noKey = Self.deps(key: nil) { _ in
            Issue.record("must not fetch without a key")
            throw URLError(.badURL)
        }
        await #expect(throws: CommandCodeSubscriptionService.FetchError.noCredentials) {
            try await CommandCodeSubscriptionService.refresh(deps: noKey)
        }
        let cases: [(Int, String, CommandCodeSubscriptionService.FetchError)] = [
            (401, "{}", .authenticationRejected),
            (429, "{}", .rateLimited),
            (503, "{}", .providerUnavailable),
            (200, #"{"windowLimits":{}}"#, .parseFailure),
        ]
        for (status, body, expected) in cases {
            await #expect(throws: expected) {
                try await CommandCodeSubscriptionService.refresh(deps: Self.deps { request in
                    (Data(body.utf8), Self.response(request, status))
                })
            }
        }
        await #expect(throws: CommandCodeSubscriptionService.FetchError.network) {
            try await CommandCodeSubscriptionService.refresh(deps: Self.deps { _ in throw URLError(.notConnectedToInternet) })
        }
    }

    @Test("plan labels and the auth file")
    func planLabelAndAuthFile() throws {
        #expect(CommandCodeSubscriptionService.planLabel("individual-pro-v1") == "Pro")
        #expect(CommandCodeSubscriptionService.planLabel("") == nil)
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("cc-auth-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: file) }
        try Data(#"{"apiKey":" synthetic ","userName":"x"}"#.utf8).write(to: file)
        #expect(CommandCodeSubscriptionService.apiKey(fromAuthFile: file) == "synthetic")
        #expect(CommandCodeSubscriptionService.apiKey(fromAuthFile: file.appendingPathExtension("missing")) == nil)
    }
}
