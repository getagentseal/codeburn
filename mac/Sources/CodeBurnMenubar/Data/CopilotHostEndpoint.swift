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
    /// Assumed for every credential source that still carries no host of its
    /// own: an `apps.json` entry keyed by app name, an environment token with
    /// no `GH_HOST`, a `gh` login this machine has no `hosts.yml` for, and a
    /// pasted token saved before the host field existed.
    static let defaultHost = "github.com"
    static let defaultAPIHost = "api.github.com"
    /// GitHub Enterprise Cloud with data residency.
    static let enterpriseCloudSuffix = ".ghe.com"
    /// The variable `gh` and the Copilot CLI read to target a host other than
    /// dotcom. It sits next to `GH_TOKEN` / `GITHUB_TOKEN` in the same
    /// environment, so the environment rung reads both (#1306).
    static let hostEnvironmentName = "GH_HOST"
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

    // MARK: - `gh` hosts (#1306)

    /// The GitHub hosts `gh` is logged in to, read out of its `hosts.yml`.
    ///
    /// That file is a mapping of host to per-host settings, so the hosts are
    /// exactly its top-level keys — the only lines that start in column zero.
    /// This is a key scan, not a YAML parser: nothing below the first level is
    /// read, and every key is passed on untrusted, to be validated where the
    /// URL is built.
    static func hostsFromGhConfig(_ text: String) -> [String] {
        var hosts: [String] = []
        // Split on `isNewline`, not on "\n": Swift reads CRLF as a single
        // grapheme, so splitting on "\n" leaves a CRLF file as one long line.
        for rawLine in text.split(whereSeparator: \.isNewline) {
            let line = String(rawLine)
            // Anything indented belongs to a host's block; `#` is a comment and
            // `-` starts a document marker or a sequence entry, neither of
            // which is a host.
            guard let first = line.first, !first.isWhitespace, first != "#", first != "-" else { continue }
            guard let colon = line.firstIndex(of: ":") else { continue }
            let key = line[..<colon]
                .trimmingCharacters(in: .whitespaces)
                .trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
            guard let host = normalize(key), !hosts.contains(host) else { continue }
            hosts.append(host)
        }
        return hosts
    }

    /// The host a `gh auth token` answer belongs to, or nil for dotcom.
    ///
    /// It mirrors how `gh` itself picks the host that command reads: `GH_HOST`
    /// wins, otherwise the single host in `hosts.yml`, otherwise dotcom — which
    /// is what `preferredHost(among:)` already computes. Where the two could
    /// disagree (several tenants and no dotcom entry) `gh` resolves to dotcom,
    /// finds no token there and yields nothing, so the rung never fires with a
    /// host the token does not belong to.
    ///
    /// Resolved from the config file rather than by spawning `gh auth status`:
    /// `gh` writes `hosts.yml` for every login, keyring-backed ones included,
    /// so a file read answers without a second subprocess.
    static func ghHost(environmentHost: String?, hostsConfig: String?) -> String? {
        if let host = normalize(environmentHost) { return host }
        guard let hostsConfig else { return nil }
        let hosts = hostsFromGhConfig(hostsConfig)
        guard !hosts.isEmpty else { return nil }
        return preferredHost(among: hosts.map { Optional($0) })
    }

    /// Where `gh` keeps `hosts.yml`: `GH_CONFIG_DIR` wins, then
    /// `XDG_CONFIG_HOME/gh`, then `~/.config/gh`, matching `gh`'s own order.
    static func ghHostsFileURL(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        homeDirectory: String = NSHomeDirectory()
    ) -> URL {
        func directory(_ name: String) -> String? {
            guard let value = environment[name]?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !value.isEmpty else { return nil }
            return value
        }
        if let configDir = directory("GH_CONFIG_DIR") {
            return URL(fileURLWithPath: configDir).appendingPathComponent("hosts.yml")
        }
        if let xdg = directory("XDG_CONFIG_HOME") {
            return URL(fileURLWithPath: xdg).appendingPathComponent("gh/hosts.yml")
        }
        return URL(fileURLWithPath: homeDirectory).appendingPathComponent(".config/gh/hosts.yml")
    }
}
