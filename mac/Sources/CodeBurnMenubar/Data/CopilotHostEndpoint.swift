import Foundation

/// Which GitHub host a discovered Copilot credential belongs to, and the
/// Copilot quota endpoint that host answers on.
///
/// GitHub Enterprise Cloud with data residency puts an enterprise on its own
/// hostname (`<tenant>.ghe.com`), whose API lives at `api.<tenant>.ghe.com`. A
/// token minted there is not a dotcom token, so the endpoint has to follow the
/// credential's host instead of being hardcoded, and a host this build does
/// not know how to address must fail rather than fall back: sending an
/// enterprise credential to `api.github.com` would both leak it to the wrong
/// endpoint and report "temporarily unavailable" forever (#1286).
///
/// Self-hosted GitHub Enterprise Server (`https://<host>/api/v3/...`) is
/// deliberately out of scope here: nothing in CodeBurn reads or documents a
/// GHES install today, and guessing that shape for any unrecognized host would
/// send credentials to a host we never verified serves this endpoint.
enum CopilotHostEndpoint {
    /// Assumed for every credential source that carries no host of its own
    /// (`apps.json` entries keyed by app name, the environment variables,
    /// `gh auth token`, and a token pasted into Settings).
    static let defaultHost = "github.com"
    static let defaultAPIHost = "api.github.com"
    /// GitHub Enterprise Cloud with data residency.
    static let enterpriseCloudSuffix = ".ghe.com"
    private static let usagePath = "/copilot_internal/user"

    /// Bare lowercased hostname. Tolerates surrounding whitespace, a scheme, a
    /// trailing slash or path, and a port, because `hosts.json` keys are
    /// written by several different clients. nil when nothing usable is left.
    static func normalize(_ raw: String?) -> String? {
        guard var host = raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !host.isEmpty else {
            return nil
        }
        if let schemeEnd = host.range(of: "://") { host = String(host[schemeEnd.upperBound...]) }
        if let slash = host.firstIndex(of: "/") { host = String(host[..<slash]) }
        if let at = host.lastIndex(of: "@") { host = String(host[host.index(after: at)...]) }
        if let colon = host.firstIndex(of: ":") { host = String(host[..<colon]) }
        return host.isEmpty ? nil : host
    }

    /// The API host that serves Copilot quota for a credential's GitHub host,
    /// or nil for a host this build cannot address. A nil `host` means the
    /// source carried none, which is dotcom.
    static func apiHost(for host: String?) -> String? {
        guard let host = normalize(host) else { return defaultAPIHost }
        guard isHostname(host) else { return nil }
        if host == defaultHost || host == defaultAPIHost { return defaultAPIHost }
        // `api.<tenant>.ghe.com` is already the API host; a bare tenant host
        // gains the `api.` label.
        if host.hasSuffix(enterpriseCloudSuffix), host.count > enterpriseCloudSuffix.count {
            return host.hasPrefix("api.") ? host : "api." + host
        }
        return nil
    }

    /// A URL delimiter that survives normalization would move the request off
    /// the host the suffix check approved: `evil.com?.ghe.com` ends in
    /// `.ghe.com` but builds a URL whose host is `api.evil.com`, which would
    /// then receive the Authorization header.
    private static func isHostname(_ host: String) -> Bool {
        host.unicodeScalars.allSatisfy {
            ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "." || $0 == "-"
        }
    }

    /// The quota endpoint for a credential's host, or nil when the host is not
    /// one this build knows how to reach.
    static func usageURL(for host: String?) -> URL? {
        guard let apiHost = apiHost(for: host) else { return nil }
        return URL(string: "https://\(apiHost)\(usagePath)")
    }

    /// Picks the host to query out of the hosts a credential file lists. A nil
    /// entry stands for a source with no host of its own, i.e. dotcom.
    ///
    /// A single entry is unambiguous and is used as-is, even when it is a host
    /// this build cannot address, so the failure names the host the user
    /// actually signed in to rather than silently trying dotcom. With several
    /// entries dotcom wins, because that is what every non-enterprise client
    /// writes; otherwise the first `.ghe.com` tenant in sorted order, so the
    /// pick is stable from one read to the next.
    static func preferredHost(among hosts: [String?]) -> String? {
        let normalized = hosts.map { normalize($0) ?? defaultHost }
        guard let first = normalized.first else { return nil }
        if normalized.count == 1 { return first }
        if normalized.contains(defaultHost) { return defaultHost }
        let enterprise = normalized.filter { $0.hasSuffix(enterpriseCloudSuffix) }.sorted()
        return enterprise.first ?? normalized.sorted().first
    }
}
