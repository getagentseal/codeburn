import XCTest
@testable import CodeBurnMenubar

/// Fixture-driven tests for the GitHub Copilot quota flow, mirroring
/// app/electron/quota/copilot.test.ts: hosts.json / apps.json credential
/// selection, exact plugin headers, 401 re-read semantics, Retry-After
/// backoff, error classification, and the remaining→used percent decode.
/// All network and file access goes through the injected Deps seams; nothing
/// touches the real credential files or network.
final class CopilotQuotaTests: XCTestCase {

    /// Records every request the service makes, in order.
    private final class RequestRecorder: @unchecked Sendable {
        private(set) var requests: [URLRequest] = []
        func record(_ request: URLRequest) { requests.append(request) }
    }

    private static let now = Date(timeIntervalSince1970: 1_786_000_000)

    private static let hosts = """
    {"github.com":{"user":"octocat","oauth_token":"gho_test-secret"}}
    """

    private static let usageBody = """
    {"copilot_plan":"individual","quota_snapshots":{
      "premium_interactions":{"percent_remaining":70},
      "chat":{"percent_remaining":100}
    }}
    """

    private static func httpResponse(_ request: URLRequest, status: Int, headers: [String: String] = [:]) -> HTTPURLResponse {
        HTTPURLResponse(
            url: request.url ?? URL(string: "https://api.github.com")!,
            statusCode: status,
            httpVersion: nil,
            headerFields: headers
        )!
    }

    private static func okJson(_ request: URLRequest, _ body: String) -> (Data, HTTPURLResponse) {
        (body.data(using: .utf8)!, httpResponse(request, status: 200))
    }

    private static func makeDeps(
        hosts: String?,
        apps: String? = nil,
        config: String? = nil,
        settings: String? = nil,
        environment: [String: String] = [:],
        ghToken: String? = nil,
        ghHostsYAML: String? = nil,
        savedToken: String? = nil,
        savedHost: String? = nil,
        recorder: RequestRecorder,
        readFile: (@Sendable (URL) -> Data?)? = nil,
        now: (@Sendable () -> Date)? = nil,
        onGhProbe: (@Sendable () -> Void)? = nil,
        respond: @escaping @Sendable (URLRequest) -> (Data, HTTPURLResponse)
    ) -> CopilotSubscriptionService.Deps {
        CopilotSubscriptionService.Deps(
            fetch: { request in
                recorder.record(request)
                return respond(request)
            },
            readFile: readFile ?? { url in
                switch url.lastPathComponent {
                case "hosts.json": return hosts?.data(using: .utf8)
                case "apps.json": return apps?.data(using: .utf8)
                case "config.json": return config?.data(using: .utf8)
                case "settings.json": return settings?.data(using: .utf8)
                case "hosts.yml": return ghHostsYAML?.data(using: .utf8)
                default: return nil
                }
            },
            hostsURL: URL(fileURLWithPath: "/tmp/codeburn-tests/.config/github-copilot/hosts.json"),
            appsURL: URL(fileURLWithPath: "/tmp/codeburn-tests/.config/github-copilot/apps.json"),
            copilotDirURL: URL(fileURLWithPath: "/tmp/codeburn-tests/.copilot"),
            ghHostsURL: URL(fileURLWithPath: "/tmp/codeburn-tests/.config/gh/hosts.yml"),
            environment: { environment[$0] },
            ghAuthToken: {
                onGhProbe?()
                return ghToken
            },
            savedCredential: { savedToken.map { CopilotCredential(token: $0, host: savedHost) } },
            now: now ?? { Self.now }
        )
    }

    override func setUp() {
        super.setUp()
        // The `gh` answer is cached process-wide.
        CopilotSubscriptionService.resetProbeCache()
    }

    private func authorization(_ recorder: RequestRecorder) -> String? {
        recorder.requests.first?.value(forHTTPHeaderField: "Authorization")
    }

    private func expectNoCredentials(
        _ deps: CopilotSubscriptionService.Deps,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        do {
            _ = try await CopilotSubscriptionService.refresh(deps: deps)
            XCTFail("expected noCredentials", file: file, line: line)
        } catch let error as CopilotSubscriptionService.FetchError {
            guard case .noCredentials = error else {
                return XCTFail("expected noCredentials, got \(error)", file: file, line: line)
            }
        } catch {
            XCTFail("unexpected error: \(error)", file: file, line: line)
        }
    }

    // MARK: - Decode

    func testDecodeSnakeCaseSnapshotsIntoUsedWindowsWithPlanLabel() throws {
        let usage = try CopilotSubscriptionService.decodeUsage(
            data: Self.usageBody.data(using: .utf8)!, now: Self.now)
        XCTAssertEqual(usage.plan, "Individual")
        XCTAssertEqual(usage.details.map(\.label), ["Premium requests", "Chat"])
        XCTAssertEqual(usage.details.map(\.usedPercent), [30, 0])
        XCTAssertEqual(usage.primary?.label, "Premium requests")
        XCTAssertEqual(usage.primary?.usedPercent ?? -1, 30, accuracy: 0.001)
        XCTAssertNil(usage.primary?.resetsAt)
    }

    func testDecodeCamelCasePromotesChatWhenPremiumIsAbsent() throws {
        let body = #"{"copilotPlan":"business","quotaSnapshots":{"chat":{"percentRemaining":55}}}"#
        let usage = try CopilotSubscriptionService.decodeUsage(
            data: body.data(using: .utf8)!, now: Self.now)
        XCTAssertEqual(usage.plan, "Business")
        XCTAssertEqual(usage.primary?.label, "Chat")
        XCTAssertEqual(usage.primary?.usedPercent ?? -1, 45, accuracy: 0.001)
    }

    func testDecodeSkipsZeroEntitlementAndUnlimitedWindows() throws {
        // A Free/Individual plan reports premium_interactions with entitlement
        // 0 and 0% remaining, which must not render as 100% used.
        let body = #"{"copilot_plan":"individual","quota_snapshots":{"premium_interactions":{"entitlement":0,"remaining":0,"percent_remaining":0.0,"unlimited":false},"chat":{"entitlement":200,"remaining":190,"percent_remaining":95.0,"unlimited":false},"completions":{"entitlement":2000,"remaining":2000,"percent_remaining":100.0,"unlimited":true}}}"#
        let usage = try CopilotSubscriptionService.decodeUsage(
            data: body.data(using: .utf8)!, now: Self.now)
        XCTAssertEqual(usage.details.map(\.label), ["Chat"])
        XCTAssertEqual(usage.primary?.label, "Chat")
        XCTAssertEqual(usage.primary?.usedPercent ?? -1, 5, accuracy: 0.001)
    }

    func testDecodeSurvivesMalformedSnapshots() throws {
        let body = #"{"quota_snapshots":{"chat":"garbage"},"extra":true}"#
        let usage = try CopilotSubscriptionService.decodeUsage(
            data: body.data(using: .utf8)!, now: Self.now)
        XCTAssertNil(usage.primary)
        XCTAssertEqual(usage.details, [])
    }

    func testDecodeTitleCasesUnknownPlanTiers() throws {
        let educators = try CopilotSubscriptionService.decodeUsage(
            data: #"{"copilot_plan":"for_educators"}"#.data(using: .utf8)!, now: Self.now)
        XCTAssertEqual(educators.plan, "Educators")
        let future = try CopilotSubscriptionService.decodeUsage(
            data: #"{"copilot_plan":"some_future_tier"}"#.data(using: .utf8)!, now: Self.now)
        XCTAssertEqual(future.plan, "Some Future Tier")
        let missing = try CopilotSubscriptionService.decodeUsage(
            data: #"{}"#.data(using: .utf8)!, now: Self.now)
        XCTAssertNil(missing.plan)
    }

    // MARK: - Credential files

    func testNoCredentialsNeverFetches() async {
        let recorder = RequestRecorder()
        let deps = Self.makeDeps(hosts: nil, recorder: recorder) { request in
            Self.okJson(request, Self.usageBody)
        }
        do {
            _ = try await CopilotSubscriptionService.refresh(deps: deps)
            XCTFail("expected noCredentials")
        } catch let error as CopilotSubscriptionService.FetchError {
            guard case .noCredentials = error else {
                return XCTFail("expected noCredentials, got \(error)")
            }
            XCTAssertTrue(error.isTerminal)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
        XCTAssertTrue(recorder.requests.isEmpty)
    }

    func testHostsJsonPreferredOverAppsJsonWithExactPluginHeaders() async throws {
        let recorder = RequestRecorder()
        let deps = Self.makeDeps(
            hosts: Self.hosts,
            apps: #"{"Some App":{"oauth_token":"gho_wrong"}}"#,
            recorder: recorder
        ) { request in
            Self.okJson(request, Self.usageBody)
        }
        let usage = try await CopilotSubscriptionService.refresh(deps: deps)
        XCTAssertEqual(usage.plan, "Individual")
        XCTAssertEqual(usage.apiHost, "api.github.com")
        XCTAssertEqual(recorder.requests.count, 1)
        let request = recorder.requests[0]
        XCTAssertEqual(request.url?.absoluteString, "https://api.github.com/copilot_internal/user")
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "token gho_test-secret")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Editor-Version"), "vscode/1.96.2")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Editor-Plugin-Version"), "copilot-chat/0.26.7")
        XCTAssertEqual(request.value(forHTTPHeaderField: "User-Agent"), "GitHubCopilotChat/0.26.7")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Github-Api-Version"), "2025-04-01")
    }

    func testFallsBackToAppsJsonWhenHostsJsonHasNoToken() async throws {
        let recorder = RequestRecorder()
        let deps = Self.makeDeps(
            hosts: "{}",
            apps: #"{"Visual Studio Code":{"oauth_token":"ghu_apps-token"}}"#,
            recorder: recorder
        ) { request in
            Self.okJson(request, Self.usageBody)
        }
        _ = try await CopilotSubscriptionService.refresh(deps: deps)
        XCTAssertEqual(recorder.requests.count, 1)
        XCTAssertEqual(
            recorder.requests[0].value(forHTTPHeaderField: "Authorization"),
            "token ghu_apps-token")
    }

    func testMalformedHostsJsonFallsThroughToAppsJson() async throws {
        let recorder = RequestRecorder()
        let deps = Self.makeDeps(
            hosts: "not json {",
            apps: #"{"Visual Studio Code":{"oauth_token":"ghu_apps-token"}}"#,
            recorder: recorder
        ) { request in
            Self.okJson(request, Self.usageBody)
        }
        _ = try await CopilotSubscriptionService.refresh(deps: deps)
        XCTAssertEqual(
            recorder.requests[0].value(forHTTPHeaderField: "Authorization"),
            "token ghu_apps-token")
    }

    // MARK: - 401 re-read

    func testUnauthorizedRereadsOnceAndAdoptsRotatedToken() async throws {
        final class ReadCounter: @unchecked Sendable {
            var reads = 0
        }
        let counter = ReadCounter()
        let recorder = RequestRecorder()
        let deps = Self.makeDeps(hosts: nil, recorder: recorder, readFile: { _ in
            counter.reads += 1
            let token = counter.reads == 1 ? "gho_stale" : "gho_rotated"
            return #"{"github.com":{"oauth_token":"\#(token)"}}"#.data(using: .utf8)
        }) { request in
            if request.value(forHTTPHeaderField: "Authorization") == "token gho_rotated" {
                return Self.okJson(request, Self.usageBody)
            }
            return (Data(), Self.httpResponse(request, status: 401))
        }
        let usage = try await CopilotSubscriptionService.refresh(deps: deps)
        XCTAssertEqual(usage.plan, "Individual")
        XCTAssertEqual(recorder.requests.count, 2)
    }

    func testUnauthorizedWithUnchangedTokenIsTransientWithoutRetry() async {
        let recorder = RequestRecorder()
        let deps = Self.makeDeps(hosts: Self.hosts, recorder: recorder) { request in
            (Data(), Self.httpResponse(request, status: 401))
        }
        do {
            _ = try await CopilotSubscriptionService.refresh(deps: deps)
            XCTFail("expected tokenRejected")
        } catch let error as CopilotSubscriptionService.FetchError {
            guard case .tokenRejected = error else {
                return XCTFail("expected tokenRejected, got \(error)")
            }
            XCTAssertFalse(error.isTerminal)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
        // One probe only: re-reading found the same token, so a retry is pointless.
        XCTAssertEqual(recorder.requests.count, 1)
    }

    // MARK: - Error classification

    func testRateLimitedUsesRetryAfterHeader() async {
        defer { CopilotSubscriptionService.disconnect() }
        let recorder = RequestRecorder()
        let deps = Self.makeDeps(hosts: Self.hosts, recorder: recorder) { request in
            (Data(), Self.httpResponse(request, status: 429, headers: ["Retry-After": "75"]))
        }
        do {
            _ = try await CopilotSubscriptionService.refresh(deps: deps)
            XCTFail("expected rateLimited")
        } catch let error as CopilotSubscriptionService.FetchError {
            guard case let .rateLimited(retryAt) = error else {
                return XCTFail("expected rateLimited, got \(error)")
            }
            XCTAssertEqual(retryAt.timeIntervalSinceNow, 75, accuracy: 10)
            XCTAssertFalse(error.isTerminal)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testServerErrorIsTransientAndClientErrorIsTerminal() async {
        let serverRecorder = RequestRecorder()
        let serverError = Self.makeDeps(hosts: Self.hosts, recorder: serverRecorder) { request in
            (Data(), Self.httpResponse(request, status: 503))
        }
        do {
            _ = try await CopilotSubscriptionService.refresh(deps: serverError)
            XCTFail("expected usageHTTPError")
        } catch let error as CopilotSubscriptionService.FetchError {
            guard case .usageHTTPError(503) = error else {
                return XCTFail("expected 503, got \(error)")
            }
            XCTAssertFalse(error.isTerminal)
        } catch {
            XCTFail("unexpected error: \(error)")
        }

        let clientRecorder = RequestRecorder()
        let clientError = Self.makeDeps(hosts: Self.hosts, recorder: clientRecorder) { request in
            (Data(), Self.httpResponse(request, status: 404))
        }
        do {
            _ = try await CopilotSubscriptionService.refresh(deps: clientError)
            XCTFail("expected usageHTTPError")
        } catch let error as CopilotSubscriptionService.FetchError {
            guard case .usageHTTPError(404) = error else {
                return XCTFail("expected 404, got \(error)")
            }
            XCTAssertTrue(error.isTerminal)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    // MARK: - Discovery chain (issue #1198)



    func testCopilotCLIConfigJSONIsUsedWhenLegacyFilesAreAbsent() async throws {
        let recorder = RequestRecorder()
        let deps = Self.makeDeps(
            hosts: nil,
            config: #"{"loggedInUsers":["octocat"],"github_token":"ghp_config-token"}"#,
            recorder: recorder
        ) { request in
            Self.okJson(request, Self.usageBody)
        }
        _ = try await CopilotSubscriptionService.refresh(deps: deps)
        XCTAssertEqual(authorization(recorder), "token ghp_config-token")
    }

    func testSettingsJSONIsReadWhenConfigJSONHasNoToken() async throws {
        let recorder = RequestRecorder()
        let deps = Self.makeDeps(
            hosts: nil,
            config: #"{"storeTokenPlaintext":false,"installedPlugins":[]}"#,
            settings: #"{"auth":{"token":"gho_settings-token"}}"#,
            recorder: recorder
        ) { request in
            Self.okJson(request, Self.usageBody)
        }
        _ = try await CopilotSubscriptionService.refresh(deps: deps)
        XCTAssertEqual(authorization(recorder), "token gho_settings-token")
    }

    /// A refresh token is not a credential for this endpoint, so a file that
    /// holds only one must read as absent.
    func testRefreshTokenIsNotMistakenForAnAccessToken() async {
        let recorder = RequestRecorder()
        let deps = Self.makeDeps(
            hosts: nil,
            config: #"{"refresh":"ghr_refresh-only"}"#,
            recorder: recorder
        ) { request in
            Self.okJson(request, Self.usageBody)
        }
        await expectNoCredentials(deps)
        XCTAssertTrue(recorder.requests.isEmpty)
    }

    func testEnvironmentTokensAreHonouredInCopilotCLIOrder() async throws {
        let recorder = RequestRecorder()
        let deps = Self.makeDeps(
            hosts: nil,
            environment: [
                "COPILOT_GITHUB_TOKEN": "gho_copilot-env",
                "GH_TOKEN": "gho_gh-env",
                "GITHUB_TOKEN": "gho_github-env",
            ],
            recorder: recorder
        ) { request in
            Self.okJson(request, Self.usageBody)
        }
        _ = try await CopilotSubscriptionService.refresh(deps: deps)
        XCTAssertEqual(authorization(recorder), "token gho_copilot-env")

        let fallback = RequestRecorder()
        let ghOnly = Self.makeDeps(
            hosts: nil,
            environment: ["GITHUB_TOKEN": "gho_github-env"],
            recorder: fallback
        ) { request in
            Self.okJson(request, Self.usageBody)
        }
        CopilotSubscriptionService.resetProbeCache()
        _ = try await CopilotSubscriptionService.refresh(deps: ghOnly)
        XCTAssertEqual(authorization(fallback), "token gho_github-env")
    }

    func testGhCLITokenIsUsedWhenNothingElseIsPresent() async throws {
        let recorder = RequestRecorder()
        let deps = Self.makeDeps(hosts: nil, ghToken: "gho_gh-cli", recorder: recorder) { request in
            Self.okJson(request, Self.usageBody)
        }
        _ = try await CopilotSubscriptionService.refresh(deps: deps)
        XCTAssertEqual(authorization(recorder), "token gho_gh-cli")
    }

    func testMissingGhCLIFallsThroughToThePastedToken() async throws {
        let recorder = RequestRecorder()
        let deps = Self.makeDeps(
            hosts: nil,
            ghToken: nil,
            savedToken: "github_pat_pasted",
            recorder: recorder
        ) { request in
            Self.okJson(request, Self.usageBody)
        }
        _ = try await CopilotSubscriptionService.refresh(deps: deps)
        XCTAssertEqual(authorization(recorder), "token github_pat_pasted")
    }

    // MARK: - Host-carrying rungs (#1306)

    /// An enterprise PAT exported as GH_TOKEN went to api.github.com and came
    /// back 401. GH_HOST sits next to it in the same environment and names the
    /// host the token belongs to.
    func testEnvironmentTokenFollowsGHHost() async throws {
        let recorder = RequestRecorder()
        let deps = Self.makeDeps(
            hosts: nil,
            environment: ["GH_TOKEN": "gho_env-tenant", "GH_HOST": "acme.ghe.com"],
            recorder: recorder
        ) { request in
            Self.okJson(request, Self.usageBody)
        }
        let usage = try await CopilotSubscriptionService.refresh(deps: deps)
        XCTAssertEqual(
            recorder.requests.first?.url?.absoluteString,
            "https://api.acme.ghe.com/copilot_internal/user")
        XCTAssertEqual(authorization(recorder), "token gho_env-tenant")
        XCTAssertEqual(usage.apiHost, "api.acme.ghe.com")
    }

    func testEnvironmentTokenWithoutGHHostStaysOnDotcom() async throws {
        let recorder = RequestRecorder()
        let deps = Self.makeDeps(
            hosts: nil,
            environment: ["GITHUB_TOKEN": "gho_env-dotcom"],
            recorder: recorder
        ) { request in
            Self.okJson(request, Self.usageBody)
        }
        _ = try await CopilotSubscriptionService.refresh(deps: deps)
        XCTAssertEqual(
            recorder.requests.first?.url?.absoluteString,
            "https://api.github.com/copilot_internal/user")
    }

    /// `gh auth login --hostname <tenant>.ghe.com` writes that host into gh's
    /// own hosts.yml; the token `gh auth token` hands back belongs to it.
    func testGhTokenFollowsTheHostInGhHostsYML() async throws {
        let recorder = RequestRecorder()
        let deps = Self.makeDeps(
            hosts: nil,
            ghToken: "gho_gh-tenant",
            ghHostsYAML: """
            acme.ghe.com:
                users:
                    octocat:
                        oauth_token: gho_gh-tenant
                git_protocol: https
            """,
            recorder: recorder
        ) { request in
            Self.okJson(request, Self.usageBody)
        }
        let usage = try await CopilotSubscriptionService.refresh(deps: deps)
        XCTAssertEqual(
            recorder.requests.first?.url?.absoluteString,
            "https://api.acme.ghe.com/copilot_internal/user")
        XCTAssertEqual(authorization(recorder), "token gho_gh-tenant")
        XCTAssertEqual(usage.apiHost, "api.acme.ghe.com")
    }

    /// gh resolves `gh auth token` against GH_HOST first, so we must too, and
    /// a hosts.yml listing dotcom as well keeps the pick on dotcom.
    func testGhHostEnvironmentOverridesTheConfigFileAndDotcomWinsAmongSeveral() async throws {
        let overridden = RequestRecorder()
        let deps = Self.makeDeps(
            hosts: nil,
            environment: ["GH_HOST": "acme.ghe.com"],
            ghToken: "gho_gh-tenant",
            ghHostsYAML: "github.com:\n    user: octocat\n",
            recorder: overridden
        ) { request in
            Self.okJson(request, Self.usageBody)
        }
        _ = try await CopilotSubscriptionService.refresh(deps: deps)
        XCTAssertEqual(
            overridden.requests.first?.url?.absoluteString,
            "https://api.acme.ghe.com/copilot_internal/user")

        CopilotSubscriptionService.resetProbeCache()
        let several = RequestRecorder()
        let bothHosts = Self.makeDeps(
            hosts: nil,
            ghToken: "gho_gh-dotcom",
            ghHostsYAML: "acme.ghe.com:\n    user: octocat\ngithub.com:\n    user: octocat\n",
            recorder: several
        ) { request in
            Self.okJson(request, Self.usageBody)
        }
        _ = try await CopilotSubscriptionService.refresh(deps: bothHosts)
        XCTAssertEqual(
            several.requests.first?.url?.absoluteString,
            "https://api.github.com/copilot_internal/user")
    }

    func testGhTokenWithNoHostsFileStaysOnDotcom() async throws {
        let recorder = RequestRecorder()
        let deps = Self.makeDeps(hosts: nil, ghToken: "gho_gh-cli", recorder: recorder) { request in
            Self.okJson(request, Self.usageBody)
        }
        _ = try await CopilotSubscriptionService.refresh(deps: deps)
        XCTAssertEqual(
            recorder.requests.first?.url?.absoluteString,
            "https://api.github.com/copilot_internal/user")
    }

    func testPastedTokenFollowsTheHostSavedBesideIt() async throws {
        let recorder = RequestRecorder()
        let deps = Self.makeDeps(
            hosts: nil,
            savedToken: "github_pat_tenant",
            savedHost: "acme.ghe.com",
            recorder: recorder
        ) { request in
            Self.okJson(request, Self.usageBody)
        }
        let usage = try await CopilotSubscriptionService.refresh(deps: deps)
        XCTAssertEqual(
            recorder.requests.first?.url?.absoluteString,
            "https://api.acme.ghe.com/copilot_internal/user")
        XCTAssertEqual(authorization(recorder), "token github_pat_tenant")
        XCTAssertEqual(usage.apiHost, "api.acme.ghe.com")
    }

    /// GH_HOST, gh's hosts.yml and the pasted host are three new untrusted
    /// inputs. A crafted value passes the `.ghe.com` suffix check but would
    /// build a URL pointing at a host of its own choosing, so each one has to
    /// fail closed with no request at all.
    func testHostileHostFromAnyNewSourceFailsClosedWithoutARequest() async {
        let crafted = "evil.com?.ghe.com"
        let sources: [(String, CopilotSubscriptionService.Deps, RequestRecorder)] = {
            var cases: [(String, CopilotSubscriptionService.Deps, RequestRecorder)] = []
            let envRecorder = RequestRecorder()
            cases.append(("GH_HOST", Self.makeDeps(
                hosts: nil,
                environment: ["GH_TOKEN": "gho_env", "GH_HOST": crafted],
                recorder: envRecorder
            ) { request in Self.okJson(request, Self.usageBody) }, envRecorder))
            let ghRecorder = RequestRecorder()
            cases.append(("hosts.yml", Self.makeDeps(
                hosts: nil,
                ghToken: "gho_gh",
                ghHostsYAML: "\(crafted):\n    user: octocat\n",
                recorder: ghRecorder
            ) { request in Self.okJson(request, Self.usageBody) }, ghRecorder))
            let pastedRecorder = RequestRecorder()
            cases.append(("pasted host", Self.makeDeps(
                hosts: nil,
                savedToken: "github_pat_pasted",
                savedHost: crafted,
                recorder: pastedRecorder
            ) { request in Self.okJson(request, Self.usageBody) }, pastedRecorder))
            return cases
        }()

        for (source, deps, recorder) in sources {
            CopilotSubscriptionService.resetProbeCache()
            do {
                _ = try await CopilotSubscriptionService.refresh(deps: deps)
                XCTFail("\(source): expected unsupportedHost")
            } catch let error as CopilotSubscriptionService.FetchError {
                guard case let .unsupportedHost(host) = error else {
                    return XCTFail("\(source): expected unsupportedHost, got \(error)")
                }
                XCTAssertEqual(host, crafted)
                XCTAssertTrue(error.isTerminal)
            } catch {
                XCTFail("\(source): unexpected error: \(error)")
            }
            XCTAssertTrue(recorder.requests.isEmpty, "\(source): built a request")
        }
    }

    func testEveryRungAbsentStillReportsNoCredentialsWithoutFetching() async {
        let recorder = RequestRecorder()
        let deps = Self.makeDeps(
            hosts: nil,
            config: "{}",
            settings: "not json {",
            recorder: recorder
        ) { request in
            Self.okJson(request, Self.usageBody)
        }
        await expectNoCredentials(deps)
        XCTAssertTrue(recorder.requests.isEmpty)
    }

    /// Precedence over the whole chain: with every rung populated, the legacy
    /// plugin file still wins, then ~/.copilot, then env, then gh, then the
    /// pasted token.
    func testDiscoveryPrecedenceOrder() async throws {
        let rungs: [(String, [String: String])] = [
            ("gho_hosts", [:]),
            ("gho_config", ["drop": "hosts"]),
            ("gho_settings", ["drop": "config"]),
            ("gho_env", ["drop": "settings"]),
            ("gho_gh", ["drop": "env"]),
            ("gho_saved", ["drop": "gh"]),
        ]
        var dropped: Set<String> = []
        for (expected, step) in rungs {
            if let drop = step["drop"] { dropped.insert(drop) }
            let recorder = RequestRecorder()
            CopilotSubscriptionService.resetProbeCache()
            let deps = Self.makeDeps(
                hosts: dropped.contains("hosts") ? nil : #"{"github.com":{"oauth_token":"gho_hosts"}}"#,
                config: dropped.contains("config") ? nil : #"{"token":"gho_config"}"#,
                settings: dropped.contains("settings") ? nil : #"{"token":"gho_settings"}"#,
                environment: dropped.contains("env") ? [:] : ["COPILOT_GITHUB_TOKEN": "gho_env"],
                ghToken: dropped.contains("gh") ? nil : "gho_gh",
                savedToken: "gho_saved",
                recorder: recorder
            ) { request in
                Self.okJson(request, Self.usageBody)
            }
            _ = try await CopilotSubscriptionService.refresh(deps: deps)
            XCTAssertEqual(authorization(recorder), "token \(expected)")
        }
    }

    /// `gh auth token` is a process spawn, so repeated reads inside the TTL
    /// must reuse the answer, and a read past it must probe again.
    func testGhProbeIsCachedUntilTheTTLExpires() async throws {
        final class Clock: @unchecked Sendable {
            var probes = 0
            var now = CopilotQuotaTests.now
        }
        let clock = Clock()
        let recorder = RequestRecorder()
        let deps = Self.makeDeps(
            hosts: nil,
            ghToken: "gho_gh-cli",
            recorder: recorder,
            now: { clock.now },
            onGhProbe: { clock.probes += 1 }
        ) { request in
            Self.okJson(request, Self.usageBody)
        }
        _ = try await CopilotSubscriptionService.refresh(deps: deps)
        _ = try await CopilotSubscriptionService.refresh(deps: deps)
        XCTAssertEqual(clock.probes, 1)

        clock.now = Self.now.addingTimeInterval(CopilotSubscriptionService.probeCacheTTL + 1)
        _ = try await CopilotSubscriptionService.refresh(deps: deps)
        XCTAssertEqual(clock.probes, 2)
    }

    func testNoCredentialsMessageOffersEveryConnectionRoute() {
        let message = CopilotSubscriptionService.FetchError.noCredentials.localizedDescription
        XCTAssertEqual(
            message,
            "No GitHub Copilot credentials found. Usage tracking still works. "
                + "To show live quota, sign in with the Copilot CLI, run gh auth login, "
                + "or paste a GitHub token in Settings.")
        XCTAssertFalse(message.contains("—"))
    }

    func testMalformedSuccessBodyDegradesInsteadOfCrashing() async {
        let recorder = RequestRecorder()
        let deps = Self.makeDeps(hosts: Self.hosts, recorder: recorder) { request in
            ("not json {".data(using: .utf8)!, Self.httpResponse(request, status: 200))
        }
        do {
            _ = try await CopilotSubscriptionService.refresh(deps: deps)
            XCTFail("expected usageDecodeFailed")
        } catch let error as CopilotSubscriptionService.FetchError {
            guard case .usageDecodeFailed = error else {
                return XCTFail("expected usageDecodeFailed, got \(error)")
            }
            XCTAssertFalse(error.isTerminal)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    // MARK: - Enterprise Cloud hosts (issue #1286)

    /// A data-residency enterprise signs in on `<tenant>.ghe.com`, whose API
    /// host is the only one that honours the token.
    func testTenantHostIsQueriedOnItsOwnAPIHost() async throws {
        let recorder = RequestRecorder()
        let deps = Self.makeDeps(
            hosts: #"{"acme.ghe.com":{"user":"octocat","oauth_token":"gho_tenant"}}"#,
            recorder: recorder
        ) { request in
            Self.okJson(request, Self.usageBody)
        }
        let usage = try await CopilotSubscriptionService.refresh(deps: deps)
        XCTAssertEqual(usage.apiHost, "api.acme.ghe.com")
        XCTAssertEqual(recorder.requests.count, 1)
        XCTAssertEqual(
            recorder.requests[0].url?.absoluteString,
            "https://api.acme.ghe.com/copilot_internal/user")
        XCTAssertEqual(
            recorder.requests[0].value(forHTTPHeaderField: "Authorization"), "token gho_tenant")
    }

    /// With both hosts signed in, dotcom wins and the enterprise token is
    /// never the one sent.
    func testDotcomWinsOverATenantAndTheTenantTokenIsNotSent() async throws {
        let recorder = RequestRecorder()
        let deps = Self.makeDeps(
            hosts: #"{"acme.ghe.com":{"oauth_token":"gho_tenant"},"github.com":{"oauth_token":"gho_dotcom"}}"#,
            recorder: recorder
        ) { request in
            Self.okJson(request, Self.usageBody)
        }
        let usage = try await CopilotSubscriptionService.refresh(deps: deps)
        XCTAssertEqual(usage.apiHost, "api.github.com")
        XCTAssertEqual(
            recorder.requests[0].url?.absoluteString,
            "https://api.github.com/copilot_internal/user")
        XCTAssertEqual(authorization(recorder), "token gho_dotcom")
    }

    /// The token and the host must come from the same entry: a dotcom key with
    /// no token must not lend its host to the tenant's credential.
    func testTenantEntryWinsWhenTheDotcomEntryHasNoToken() async throws {
        let recorder = RequestRecorder()
        let deps = Self.makeDeps(
            hosts: #"{"github.com":{"user":"octocat"},"acme.ghe.com":{"oauth_token":"gho_tenant"}}"#,
            recorder: recorder
        ) { request in
            Self.okJson(request, Self.usageBody)
        }
        _ = try await CopilotSubscriptionService.refresh(deps: deps)
        XCTAssertEqual(
            recorder.requests[0].url?.absoluteString,
            "https://api.acme.ghe.com/copilot_internal/user")
        XCTAssertEqual(authorization(recorder), "token gho_tenant")
    }

    /// apps.json keys are `<host>:<app id>` on the newer plugins, so the host
    /// is carried there too.
    func testAppsJsonHostPrefixedKeyIsQueriedOnTheTenantAPIHost() async throws {
        let recorder = RequestRecorder()
        let deps = Self.makeDeps(
            hosts: "{}",
            apps: #"{"acme.ghe.com:Iv1.b507a08c87ecfe98":{"oauth_token":"gho_apps-tenant"}}"#,
            recorder: recorder
        ) { request in
            Self.okJson(request, Self.usageBody)
        }
        _ = try await CopilotSubscriptionService.refresh(deps: deps)
        XCTAssertEqual(
            recorder.requests[0].url?.absoluteString,
            "https://api.acme.ghe.com/copilot_internal/user")
        XCTAssertEqual(authorization(recorder), "token gho_apps-tenant")
    }

    /// An app-name key carries no host, so dotcom stays the assumption.
    func testAppsJsonAppNameKeyStillQueriesDotcom() async throws {
        let recorder = RequestRecorder()
        let deps = Self.makeDeps(
            hosts: "{}",
            apps: #"{"Visual Studio Code":{"oauth_token":"ghu_apps-token"}}"#,
            recorder: recorder
        ) { request in
            Self.okJson(request, Self.usageBody)
        }
        _ = try await CopilotSubscriptionService.refresh(deps: deps)
        XCTAssertEqual(
            recorder.requests[0].url?.absoluteString,
            "https://api.github.com/copilot_internal/user")
    }

    /// A host this build cannot address (a self-hosted GHES install) fails
    /// naming the host instead of sending the credential to dotcom.
    func testUnsupportedHostFailsWithoutFetching() async {
        let recorder = RequestRecorder()
        let deps = Self.makeDeps(
            hosts: #"{"github.acme-corp.net":{"oauth_token":"gho_ghes"}}"#,
            recorder: recorder
        ) { request in
            Self.okJson(request, Self.usageBody)
        }
        do {
            _ = try await CopilotSubscriptionService.refresh(deps: deps)
            XCTFail("expected unsupportedHost")
        } catch let error as CopilotSubscriptionService.FetchError {
            guard case let .unsupportedHost(host) = error else {
                return XCTFail("expected unsupportedHost, got \(error)")
            }
            XCTAssertEqual(host, "github.acme-corp.net")
            XCTAssertTrue(error.isTerminal)
            XCTAssertEqual(
                error.localizedDescription,
                "Copilot quota is not available for the GitHub host github.acme-corp.net. "
                    + "CodeBurn can read github.com and GitHub Enterprise Cloud (*.ghe.com) hosts.")
        } catch {
            XCTFail("unexpected error: \(error)")
        }
        XCTAssertTrue(recorder.requests.isEmpty)
    }

    /// An unreachable tenant is the case the issue reported as a bare
    /// "Temporarily unavailable", so the message has to name the host tried.
    func testUnreachableTenantHostNamesTheHostInTheError() async {
        let recorder = RequestRecorder()
        let deps = CopilotSubscriptionService.Deps(
            fetch: { request in
                recorder.record(request)
                throw URLError(.cannotFindHost)
            },
            readFile: { url in
                url.lastPathComponent == "hosts.json"
                    ? #"{"acme.ghe.com":{"oauth_token":"gho_tenant"}}"#.data(using: .utf8)
                    : nil
            },
            hostsURL: URL(fileURLWithPath: "/tmp/codeburn-tests/.config/github-copilot/hosts.json"),
            appsURL: URL(fileURLWithPath: "/tmp/codeburn-tests/.config/github-copilot/apps.json"),
            copilotDirURL: URL(fileURLWithPath: "/tmp/codeburn-tests/.copilot"),
            ghHostsURL: URL(fileURLWithPath: "/tmp/codeburn-tests/.config/gh/hosts.yml"),
            environment: { _ in nil },
            ghAuthToken: { nil },
            savedCredential: { nil },
            now: { Self.now }
        )
        do {
            _ = try await CopilotSubscriptionService.refresh(deps: deps)
            XCTFail("expected network error")
        } catch let error as CopilotSubscriptionService.FetchError {
            guard case let .network(_, host) = error else {
                return XCTFail("expected network, got \(error)")
            }
            XCTAssertEqual(host, "api.acme.ghe.com")
            XCTAssertTrue(error.localizedDescription.contains("api.acme.ghe.com"))
            XCTAssertFalse(error.isTerminal)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
        XCTAssertEqual(recorder.requests.count, 1)
    }
}
