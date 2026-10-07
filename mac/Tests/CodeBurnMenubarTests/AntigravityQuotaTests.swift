import XCTest
@testable import CodeBurnMenubar

/// Fixture-driven tests for the Antigravity local-server quota flow, mirroring
/// app/electron/quota/antigravity.test.ts: process classification, summary /
/// legacy-status payload decoding, the ps → lsof → loopback-probe sequence
/// (TLS then HTTP, CSRF header only for app servers, GetUserStatus fallback
/// with planName), disconnected when nothing answers, and sanitized
/// diagnostics on unexpected discovery failure. All process and network
/// access goes through the injected Deps seams; nothing spawns real
/// processes or touches the network.
final class AntigravityQuotaTests: XCTestCase {

    private static let summaryPath = "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary"
    private static let statusPath = "/exa.language_server_pb.LanguageServerService/GetUserStatus"

    private static let appLine = "1234 /Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm --app_data_dir antigravity --csrf_token tok-123 --extension_server_port 54321"
    private static let ideLine = "1235 /Applications/Antigravity IDE.app/.../extensions/antigravity/bin/language_server --app_data_dir antigravity-ide --csrf_token ide-tok"
    private static let tokenlessAppLine = "1236 /usr/local/lib/language_server_macos --app_data_dir antigravity"
    private static let cliLine = "1237 /opt/homebrew/bin/agy serve"

    private static let now = Date(timeIntervalSince1970: 1_786_000_000)

    /// Records every loopback probe the service makes, in order.
    private final class CallRecorder: @unchecked Sendable {
        struct Call: Equatable {
            let port: Int
            let tls: Bool
            let path: String
            let csrf: String?
        }
        private(set) var calls: [Call] = []
        func record(port: Int, tls: Bool, path: String, csrf: String?) {
            calls.append(Call(port: port, tls: tls, path: path, csrf: csrf))
        }
    }

    private final class LogRecorder: @unchecked Sendable {
        private(set) var lines: [String] = []
        func record(_ line: String) { lines.append(line) }
    }

    private static func makeDeps(
        ps: String,
        lsof: String = "",
        psError: Error? = nil,
        recorder: CallRecorder,
        log: LogRecorder = LogRecorder(),
        respond: @escaping @Sendable (Int, Bool, String) -> (status: Int, text: String)?
    ) -> AntigravitySubscriptionService.Deps {
        AntigravitySubscriptionService.Deps(
            exec: { _, arguments in
                if arguments.first == "-ax" {
                    if let psError { throw psError }
                    return ps
                }
                return lsof
            },
            request: { port, tls, path, _, csrf in
                recorder.record(port: port, tls: tls, path: path, csrf: csrf)
                return respond(port, tls, path)
            },
            now: { Self.now },
            log: { log.record($0) }
        )
    }

    // MARK: - Process classification

    func testClassifiesAppLanguageServerWithCsrfAndFallbackPort() {
        let candidate = AntigravitySubscriptionService.classifyProcessLine(Self.appLine)
        XCTAssertEqual(candidate, AntigravitySubscriptionService.Candidate(pid: "1234", cli: false, csrf: "tok-123", extPort: 54321))
    }

    func testSkipsTokenlessAndIdeServersAcceptsTokenlessCli() {
        XCTAssertNil(AntigravitySubscriptionService.classifyProcessLine(Self.tokenlessAppLine))
        XCTAssertNil(AntigravitySubscriptionService.classifyProcessLine(Self.ideLine))
        let candidate = AntigravitySubscriptionService.classifyProcessLine(Self.cliLine)
        XCTAssertEqual(candidate?.pid, "1237")
        XCTAssertEqual(candidate?.cli, true)
        XCTAssertNil(candidate?.csrf)
    }

    func testIgnoresUnrelatedLanguageServersAndNonMatchingLines() {
        XCTAssertNil(AntigravitySubscriptionService.classifyProcessLine("999 /usr/bin/codeium_language_server --csrf_token x"))
        XCTAssertNil(AntigravitySubscriptionService.classifyProcessLine("998 vim /tmp/agy-notes.md"))
        XCTAssertNil(AntigravitySubscriptionService.classifyProcessLine("garbage line"))
    }

    // MARK: - Payload decoding

    func testDecodeSummaryJoinsGroupsIntoWindows() {
        let body: [String: Any] = [
            "groups": [
                [
                    "displayName": "Gemini Models",
                    "buckets": [
                        ["displayName": "Weekly limit", "remaining": ["remainingFraction": 0.8]] as [String: Any],
                        ["displayName": "Five hour limit", "remaining": ["remainingFraction": 0.25]] as [String: Any],
                        ["displayName": "No fraction row"] as [String: Any],
                    ],
                ] as [String: Any],
                ["displayName": "Claude and GPT models", "buckets": [["bucketId": "claude_weekly", "remaining": ["remainingFraction": 1]] as [String: Any]]] as [String: Any],
            ],
        ]
        let windows = AntigravitySubscriptionService.decodeSummary(body)
        XCTAssertEqual(windows.map(\.label), ["Gemini Models · Weekly limit", "Gemini Models · Five hour limit", "Claude and GPT models · claude_weekly"])
        XCTAssertEqual(windows[1].usedPercent, 75, accuracy: 0.001)
        XCTAssertEqual(windows[2].usedPercent, 0, accuracy: 0.001)
    }

    func testDecodeSummaryRewritesRemainingQuotaCopyToUsedPercent() {
        let body: [String: Any] = [
            "groups": [
                [
                    "displayName": "Gemini Models",
                    "buckets": [
                        [
                            "displayName": "Weekly quota remaining",
                            "remaining": ["remainingFraction": 1],
                        ] as [String: Any],
                    ],
                ] as [String: Any],
            ],
        ]

        let windows = AntigravitySubscriptionService.decodeSummary(body)

        XCTAssertEqual(windows.map(\.label), ["Gemini Models · Weekly quota used"])
        XCTAssertEqual(windows.first?.usedPercent ?? -1, 0, accuracy: 0.001)
    }

    func testDecodeSummaryAcceptsCurrentConnectResponseShape() {
        let body: [String: Any] = [
            "response": [
                "groups": [
                    [
                        "displayName": "Gemini Models",
                        "buckets": [
                            [
                                "bucketId": "gemini-weekly",
                                "displayName": "Weekly Limit",
                                "remainingFraction": 0.958,
                                "resetTime": "2026-09-04T12:05:10Z",
                            ] as [String: Any],
                        ],
                    ] as [String: Any],
                ],
            ] as [String: Any],
        ]

        let windows = AntigravitySubscriptionService.decodeSummary(body)

        XCTAssertEqual(windows.map(\.label), ["Gemini Models · Weekly Limit"])
        XCTAssertEqual(windows.first?.usedPercent ?? -1, 4.2, accuracy: 0.001)
        XCTAssertNotNil(windows.first?.resetsAt)
    }

    func testDecodeStatusReadsLegacyRowsWithResetTimes() {
        let body: [String: Any] = [
            "userStatus": [
                "cascadeModelConfigData": [
                    "clientModelConfigs": [
                        ["modelName": "gemini-2.5-pro", "quotaInfo": ["remainingFraction": 0.5, "resetTime": 1_800_000_000] as [String: Any]] as [String: Any],
                        ["modelName": "claude-sonnet-4", "quotaInfo": ["remainingFraction": 0.9, "resetTime": "2026-07-12T00:00:00Z"] as [String: Any]] as [String: Any],
                        ["modelName": "no-quota-model"] as [String: Any],
                    ],
                ] as [String: Any],
            ] as [String: Any],
        ]
        let windows = AntigravitySubscriptionService.decodeStatus(body)
        XCTAssertEqual(windows.map(\.label), ["gemini-2.5-pro", "claude-sonnet-4"])
        XCTAssertEqual(windows[0].usedPercent, 50, accuracy: 0.001)
        XCTAssertEqual(windows[0].resetsAt, Date(timeIntervalSince1970: 1_800_000_000))
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        XCTAssertEqual(windows[1].resetsAt, iso.date(from: "2026-07-12T00:00:00Z"))
    }

    func testDecodeStatusAcceptsCurrentModelAndPlanShape() {
        let body: [String: Any] = [
            "userStatus": [
                "userTier": ["name": "Google AI Pro"],
                "cascadeModelConfigData": [
                    "clientModelConfigs": [
                        [
                            "label": "Gemini 3.6 Flash (Medium)",
                            "modelId": "gemini-3.6-flash-medium",
                            "modelOrAlias": ["model": "gemini-3.6-flash"],
                            "quotaInfo": [
                                "remainingFraction": 0.76,
                                "resetTime": "2026-09-04T12:05:10Z",
                            ] as [String: Any],
                        ] as [String: Any],
                    ],
                ] as [String: Any],
            ] as [String: Any],
        ]

        let windows = AntigravitySubscriptionService.decodeStatus(body)

        XCTAssertEqual(windows.map(\.label), ["Gemini 3.6 Flash (Medium)"])
        XCTAssertEqual(windows.first?.usedPercent ?? -1, 24, accuracy: 0.001)
        XCTAssertEqual(AntigravitySubscriptionService.planFromStatus(body), "Google AI Pro")
    }

    func testDecodeGarbagePayloadsYieldsNoWindows() {
        XCTAssertEqual(AntigravitySubscriptionService.decodeSummary(nil), [])
        XCTAssertEqual(AntigravitySubscriptionService.decodeStatus(["userStatus": [:]]), [])
    }

    // MARK: - Local probe

    func testProbesAppServerOverLoopbackTlsFirstAndRendersMostConstrainedFirst() async throws {
        let recorder = CallRecorder()
        let deps = Self.makeDeps(
            ps: [Self.appLine, Self.cliLine].joined(separator: "\n"),
            lsof: "python 1234 user 12u IPv4 0x1 0t0 TCP 127.0.0.1:60123 (LISTEN)\n",
            recorder: recorder
        ) { _, tls, path in
            guard tls else { return nil }
            if path.contains("RetrieveUserQuotaSummary") {
                return (200, #"{"groups":[{"displayName":"Gemini Models","buckets":[{"displayName":"Weekly limit","remaining":{"remainingFraction":0.7}}]}]}"#)
            }
            return (200, "{}")
        }
        let usage = try await AntigravitySubscriptionService.refresh(deps: deps)
        XCTAssertEqual(usage.primary?.usedPercent ?? -1, 30, accuracy: 0.001)
        XCTAssertEqual(usage.primary?.label, "Gemini Models · Weekly limit")
        XCTAssertEqual(usage.fetchedAt, Self.now)
        XCTAssertTrue(recorder.calls.allSatisfy { $0.port == 60123 })
        XCTAssertEqual(
            recorder.calls.first,
            CallRecorder.Call(port: 60123, tls: true, path: Self.summaryPath, csrf: "tok-123")
        )
    }

    func testSendsNoCsrfHeaderForTheAgyCli() async throws {
        let recorder = CallRecorder()
        final class Counter: @unchecked Sendable { var value = 0 }
        let counter = Counter()
        let deps = Self.makeDeps(
            ps: Self.cliLine,
            lsof: "agy 1237 user 5u IPv4 0x1 0t0 TCP *:60555 (LISTEN)\n",
            recorder: recorder
        ) { _, _, _ in
            counter.value += 1
            return counter.value <= 2
                ? nil
                : (200, #"{"groups":[{"displayName":"Claude + GPT","buckets":[{"bucketId":"weekly","remaining":{"remainingFraction":0.1}}]}]}"#)
        }
        let usage = try await AntigravitySubscriptionService.refresh(deps: deps)
        XCTAssertEqual(usage.primary?.usedPercent ?? -1, 90, accuracy: 0.001)
        XCTAssertNil(usage.plan)
        XCTAssertNil(recorder.calls.first?.csrf)
    }

    func testLabelsSummaryWindowsWithUserTierNotPlanInfo() async throws {
        let recorder = CallRecorder()
        let deps = Self.makeDeps(
            ps: Self.cliLine,
            lsof: "agy 1237 user 5u IPv4 0x1 0t0 TCP *:60555 (LISTEN)\n",
            recorder: recorder
        ) { _, tls, path in
            guard tls else { return nil }
            if path.contains("RetrieveUserQuotaSummary") {
                return (200, #"{"response":{"groups":[{"displayName":"Gemini Models","buckets":[{"bucketId":"gemini-weekly","remainingFraction":0.4}]}]}}"#)
            }
            return (200, #"{"userStatus":{"userTier":{"id":"free-tier","name":"Antigravity Starter Quota"},"planStatus":{"planInfo":{"planName":"Pro"}}}}"#)
        }
        let usage = try await AntigravitySubscriptionService.refresh(deps: deps)
        XCTAssertEqual(usage.plan, "Antigravity Starter Quota")
        XCTAssertEqual(usage.primary?.usedPercent ?? -1, 60, accuracy: 0.001)
    }

    func testFallsBackToGetUserStatusAndLiftsPlanNameWhenSummaryHasNoWindows() async throws {
        let recorder = CallRecorder()
        let deps = Self.makeDeps(
            ps: Self.cliLine,
            lsof: "agy 1237 user 5u IPv4 0x1 0t0 TCP *:60555 (LISTEN)\n",
            recorder: recorder
        ) { _, tls, path in
            guard tls, path.contains("GetUserStatus") else { return nil }
            return (200, #"{"userStatus":{"planName":"AI Pro","cascadeModelConfigData":{"clientModelConfigs":[{"modelName":"gemini-2.5-pro","quotaInfo":{"remainingFraction":0.4}}]}}}"#)
        }
        let usage = try await AntigravitySubscriptionService.refresh(deps: deps)
        XCTAssertEqual(usage.plan, "AI Pro")
        XCTAssertEqual(usage.details.map(\.label), ["gemini-2.5-pro"])
    }

    func testDisconnectedWhenNothingLocalIsListening() async {
        let recorder = CallRecorder()
        let deps = Self.makeDeps(ps: "", recorder: recorder) { _, _, _ in
            (200, "{}")
        }
        do {
            _ = try await AntigravitySubscriptionService.refresh(deps: deps)
            XCTFail("expected disconnected")
        } catch let error as AntigravitySubscriptionService.FetchError {
            guard case .disconnected = error else {
                return XCTFail("expected disconnected, got \(error)")
            }
        } catch {
            XCTFail("unexpected error: \(error)")
        }
        XCTAssertTrue(recorder.calls.isEmpty)
    }

    func testDisconnectedWhenEveryPortProbeFails() async {
        let recorder = CallRecorder()
        let deps = Self.makeDeps(
            ps: Self.cliLine,
            lsof: "agy 1237 user 5u IPv4 0x1 0t0 TCP *:60555 (LISTEN)\n",
            recorder: recorder
        ) { _, _, _ in nil }
        do {
            _ = try await AntigravitySubscriptionService.refresh(deps: deps)
            XCTFail("expected disconnected")
        } catch let error as AntigravitySubscriptionService.FetchError {
            guard case .disconnected = error else {
                return XCTFail("expected disconnected, got \(error)")
            }
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testServerErrorStatusIsNotAnAnswerAndFallsThroughToDisconnected() async {
        let recorder = CallRecorder()
        let deps = Self.makeDeps(
            ps: Self.cliLine,
            lsof: "agy 1237 user 5u IPv4 0x1 0t0 TCP *:60555 (LISTEN)\n",
            recorder: recorder
        ) { _, _, _ in (500, #"{"error":"boom"}"#) }
        do {
            _ = try await AntigravitySubscriptionService.refresh(deps: deps)
            XCTFail("expected disconnected")
        } catch let error as AntigravitySubscriptionService.FetchError {
            guard case .disconnected = error else {
                return XCTFail("expected disconnected, got \(error)")
            }
        } catch {
            XCTFail("unexpected error: \(error)")
        }
        // Both endpoints, TLS then plain HTTP, all on the discovered port.
        XCTAssertEqual(recorder.calls.count, 4)
        XCTAssertTrue(recorder.calls.allSatisfy { $0.port == 60555 })
    }

    func testUnexpectedPsFailureIsTransientWithSanitizedDiagnostics() async {
        let log = LogRecorder()
        let psError = NSError(
            domain: "test",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "ps exploded Bearer sk-secret eyJabc.def\u{0}tail"]
        )
        let recorder = CallRecorder()
        let deps = Self.makeDeps(ps: "", psError: psError, recorder: recorder, log: log) { _, _, _ in nil }
        do {
            _ = try await AntigravitySubscriptionService.refresh(deps: deps)
            XCTFail("expected network error")
        } catch let error as AntigravitySubscriptionService.FetchError {
            guard case .network = error else {
                return XCTFail("expected network, got \(error)")
            }
        } catch {
            XCTFail("unexpected error: \(error)")
        }
        let logged = log.lines.joined(separator: " ")
        XCTAssertTrue(logged.contains("[REDACTED]"))
        XCTAssertFalse(logged.contains("sk-secret"))
        XCTAssertFalse(logged.contains("eyJabc"))
        XCTAssertFalse(logged.contains("\u{0}"))
    }
}
