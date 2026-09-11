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
}
