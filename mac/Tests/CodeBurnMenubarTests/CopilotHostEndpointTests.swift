import XCTest
@testable import CodeBurnMenubar

/// Pure endpoint derivation and host selection for Copilot credentials
/// (issue #1286): dotcom keeps `api.github.com`, a GitHub Enterprise Cloud
/// tenant gets `api.<tenant>.ghe.com`, and anything else is refused rather
/// than sent to dotcom.
final class CopilotHostEndpointTests: XCTestCase {

    // MARK: - Endpoint derivation

    func testDotcomAndHostlessSourcesUseTheDotcomAPIHost() {
        XCTAssertEqual(CopilotHostEndpoint.apiHost(for: "github.com"), "api.github.com")
        // apps.json keyed by app name, env vars, gh and the pasted token carry
        // no host at all.
        XCTAssertEqual(CopilotHostEndpoint.apiHost(for: nil), "api.github.com")
        XCTAssertEqual(CopilotHostEndpoint.apiHost(for: "   "), "api.github.com")
        XCTAssertEqual(
            CopilotHostEndpoint.usageURL(for: "github.com")?.absoluteString,
            "https://api.github.com/copilot_internal/user")
        XCTAssertEqual(
            CopilotHostEndpoint.usageURL(for: nil)?.absoluteString,
            "https://api.github.com/copilot_internal/user")
    }

    func testEnterpriseCloudTenantUsesItsOwnAPIHost() {
        XCTAssertEqual(CopilotHostEndpoint.apiHost(for: "acme.ghe.com"), "api.acme.ghe.com")
        XCTAssertEqual(
            CopilotHostEndpoint.usageURL(for: "acme.ghe.com")?.absoluteString,
            "https://api.acme.ghe.com/copilot_internal/user")
        // A host already written as the API host is not double-prefixed.
        XCTAssertEqual(CopilotHostEndpoint.apiHost(for: "api.acme.ghe.com"), "api.acme.ghe.com")
    }

    func testHostSpellingsFromDifferentClientsNormalizeToTheSameEndpoint() {
        for spelling in ["ACME.ghe.com", " acme.ghe.com ", "https://acme.ghe.com", "https://acme.ghe.com/", "acme.ghe.com:443"] {
            XCTAssertEqual(
                CopilotHostEndpoint.apiHost(for: spelling), "api.acme.ghe.com",
                "unexpected endpoint for \(spelling)")
        }
    }

    /// A self-hosted GitHub Enterprise Server install is not addressed by this
    /// build, and guessing dotcom would send an enterprise credential to the
    /// wrong endpoint.
    func testUnknownHostHasNoDerivableEndpoint() {
        XCTAssertNil(CopilotHostEndpoint.apiHost(for: "github.acme-corp.net"))
        XCTAssertNil(CopilotHostEndpoint.usageURL(for: "github.acme-corp.net"))
        // A bare suffix is not a tenant.
        XCTAssertNil(CopilotHostEndpoint.apiHost(for: "ghe.com"))
    }

    /// A credential-file key is untrusted text. A URL delimiter inside it
    /// passes the `.ghe.com` suffix check but builds a URL pointing somewhere
    /// else entirely, so the Authorization header would reach that host.
    func testHostWithAURLDelimiterIsRefusedRatherThanRedirectingTheRequest() {
        for crafted in ["evil.com?.ghe.com", "evil.com#.ghe.com", "github.com#.ghe.com",
                        #"evil.com\.ghe.com"#, "a b.ghe.com", "evil%2e.ghe.com"] {
            XCTAssertNil(CopilotHostEndpoint.apiHost(for: crafted), "accepted \(crafted)")
            XCTAssertNil(CopilotHostEndpoint.usageURL(for: crafted), "accepted \(crafted)")
        }
        // The same input before the fix resolved to a host of its own choosing.
        XCTAssertEqual(
            URL(string: "https://api.evil.com?.ghe.com/copilot_internal/user")?.host, "api.evil.com")
    }

    // MARK: - Host selection

    func testNoHostsSelectsNothing() {
        XCTAssertNil(CopilotHostEndpoint.preferredHost(among: []))
    }

    func testASingleHostIsUsedAsIsIncludingAnUnsupportedOne() {
        XCTAssertEqual(CopilotHostEndpoint.preferredHost(among: ["acme.ghe.com"]), "acme.ghe.com")
        XCTAssertEqual(CopilotHostEndpoint.preferredHost(among: ["github.com"]), "github.com")
        XCTAssertEqual(CopilotHostEndpoint.preferredHost(among: [nil]), "github.com")
        // Reported as-is so the failure can name the host the user signed in to.
        XCTAssertEqual(
            CopilotHostEndpoint.preferredHost(among: ["github.acme-corp.net"]), "github.acme-corp.net")
    }

    func testDotcomWinsWhenSeveralHostsArePresent() {
        XCTAssertEqual(
            CopilotHostEndpoint.preferredHost(among: ["acme.ghe.com", "github.com"]), "github.com")
        XCTAssertEqual(
            CopilotHostEndpoint.preferredHost(among: ["acme.ghe.com", nil]), "github.com")
    }

    func testSeveralEnterpriseHostsPickTheFirstInSortedOrderForAStablePick() {
        XCTAssertEqual(
            CopilotHostEndpoint.preferredHost(among: ["zeta.ghe.com", "acme.ghe.com"]), "acme.ghe.com")
        XCTAssertEqual(
            CopilotHostEndpoint.preferredHost(among: ["acme.ghe.com", "zeta.ghe.com"]), "acme.ghe.com")
        // An enterprise-cloud tenant beats a host we cannot address at all.
        XCTAssertEqual(
            CopilotHostEndpoint.preferredHost(among: ["github.acme-corp.net", "acme.ghe.com"]), "acme.ghe.com")
    }

    // MARK: - `gh` hosts.yml (#1306)

    func testGhConfigHostsAreItsTopLevelKeys() {
        let yaml = """
        github.com:
            users:
                octocat:
                    oauth_token: gho_dotcom
            git_protocol: https
            user: octocat
        acme.ghe.com:
            user: octocat
        """
        XCTAssertEqual(CopilotHostEndpoint.hostsFromGhConfig(yaml), ["github.com", "acme.ghe.com"])
    }

    /// Only column-zero keys are hosts. Anything indented belongs to a host's
    /// block, and reading one as a host would send the token somewhere else.
    func testGhConfigIgnoresNestedKeysCommentsAndBlankLines() {
        let yaml = "# written by gh\r\n---\r\nacme.ghe.com:\r\n    users:\r\n        octocat:\r\n            oauth_token: gho_x\r\n\r\n"
        XCTAssertEqual(CopilotHostEndpoint.hostsFromGhConfig(yaml), ["acme.ghe.com"])
        XCTAssertTrue(CopilotHostEndpoint.hostsFromGhConfig("").isEmpty)
        XCTAssertTrue(CopilotHostEndpoint.hostsFromGhConfig("    oauth_token: gho_x\n").isEmpty)
        // Quoted keys and duplicate spellings collapse to one host.
        XCTAssertEqual(
            CopilotHostEndpoint.hostsFromGhConfig("\"ACME.ghe.com\":\n    user: a\nacme.ghe.com:\n    user: b\n"),
            ["acme.ghe.com"])
    }

    /// Mirrors how gh itself resolves the host `gh auth token` reads: GH_HOST
    /// first, then the single configured host, then dotcom.
    func testGhHostPrefersGHHostThenTheConfiguredLogin() {
        XCTAssertEqual(
            CopilotHostEndpoint.ghHost(environmentHost: "acme.ghe.com", hostsConfig: "github.com:\n    user: a\n"),
            "acme.ghe.com")
        XCTAssertEqual(
            CopilotHostEndpoint.ghHost(environmentHost: nil, hostsConfig: "acme.ghe.com:\n    user: a\n"),
            "acme.ghe.com")
        // Several logins: dotcom wins, which is also what gh falls back to.
        XCTAssertEqual(
            CopilotHostEndpoint.ghHost(
                environmentHost: nil,
                hostsConfig: "acme.ghe.com:\n    user: a\ngithub.com:\n    user: b\n"),
            "github.com")
        // No file and no variable is a hostless rung, i.e. dotcom.
        XCTAssertNil(CopilotHostEndpoint.ghHost(environmentHost: nil, hostsConfig: nil))
        XCTAssertNil(CopilotHostEndpoint.ghHost(environmentHost: "  ", hostsConfig: "# empty\n"))
    }

    /// Each new host source is untrusted text of its own. A crafted value
    /// still has to reach `apiHost` as-is and be refused there, rather than
    /// being laundered into a host the suffix check would approve.
    func testCraftedHostFromEachNewSourceIsRefusedBeforeAURLIsBuilt() {
        let crafted = "evil.com?.ghe.com"
        // gh's hosts.yml
        XCTAssertEqual(CopilotHostEndpoint.hostsFromGhConfig("\(crafted):\n    user: a\n"), [crafted])
        XCTAssertEqual(
            CopilotHostEndpoint.ghHost(environmentHost: nil, hostsConfig: "\(crafted):\n    user: a\n"), crafted)
        // GH_HOST
        XCTAssertEqual(CopilotHostEndpoint.ghHost(environmentHost: crafted, hostsConfig: nil), crafted)
        // …and every one of them fails closed at the single choke point.
        XCTAssertNil(CopilotHostEndpoint.apiHost(for: crafted))
        XCTAssertNil(CopilotHostEndpoint.usageURL(for: crafted))
        // The pasted-token field refuses it before it is ever stored.
        XCTAssertNotNil(CopilotQuotaPresentation.pastedHostRejection(crafted))
        XCTAssertNotNil(CopilotQuotaPresentation.pastedHostRejection("github.acme-corp.net"))
        XCTAssertNil(CopilotQuotaPresentation.pastedHostRejection("acme.ghe.com"))
        XCTAssertNil(CopilotQuotaPresentation.pastedHostRejection("  "))
    }

    func testGhHostsFileURLFollowsGhsOwnConfigDirOrder() {
        XCTAssertEqual(
            CopilotHostEndpoint.ghHostsFileURL(
                environment: ["GH_CONFIG_DIR": "/opt/ghcfg", "XDG_CONFIG_HOME": "/xdg"],
                homeDirectory: "/Users/dev").path,
            "/opt/ghcfg/hosts.yml")
        XCTAssertEqual(
            CopilotHostEndpoint.ghHostsFileURL(
                environment: ["XDG_CONFIG_HOME": "/xdg"], homeDirectory: "/Users/dev").path,
            "/xdg/gh/hosts.yml")
        XCTAssertEqual(
            CopilotHostEndpoint.ghHostsFileURL(environment: ["GH_CONFIG_DIR": "  "], homeDirectory: "/Users/dev").path,
            "/Users/dev/.config/gh/hosts.yml")
    }

    // MARK: - Pasted-token host storage

    /// The host rides in the same Keychain record as the token, and that
    /// record has to keep decoding for every credential saved before the field
    /// existed — for every provider, not just Copilot.
    func testCredentialRecordDecodesWithAndWithoutTheHostField() throws {
        let legacy = #"{"sourceMode":"api","apiKey":"synthetic"}"#.data(using: .utf8)!
        let decodedLegacy = try JSONDecoder().decode(CapacityDockProviderCredential.self, from: legacy)
        XCTAssertEqual(decodedLegacy.apiKey, "synthetic")
        XCTAssertEqual(decodedLegacy.host, "")
        XCTAssertNil(decodedLegacy.sanitizedOverride.host)

        let current = CapacityDockProviderCredential(apiKey: "synthetic", host: "acme.ghe.com")
        let roundTripped = try JSONDecoder().decode(
            CapacityDockProviderCredential.self, from: try JSONEncoder().encode(current))
        XCTAssertEqual(roundTripped, current)
        XCTAssertEqual(roundTripped.sanitizedOverride.host, "acme.ghe.com")
        // A host with no token is not a credential.
        XCTAssertTrue(CapacityDockProviderCredential(host: "acme.ghe.com").isEmpty)
    }

    // MARK: - Dormant Settings detail

    func testDormantDetailNamesNoHostUntilOneHasAnswered() {
        XCTAssertEqual(
            CopilotQuotaPresentation.dormantSettingsDetail(apiHost: nil),
            "Tap Load Quota to fetch live usage from GitHub.")
        XCTAssertEqual(
            CopilotQuotaPresentation.dormantSettingsDetail(apiHost: "api.github.com"),
            "Tap Load Quota to fetch live usage from GitHub.")
        XCTAssertEqual(
            CopilotQuotaPresentation.dormantSettingsDetail(apiHost: "api.acme.ghe.com"),
            "Tap Load Quota to fetch live usage from api.acme.ghe.com.")
    }
}
