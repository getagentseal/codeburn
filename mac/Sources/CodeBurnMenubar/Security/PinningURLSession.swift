import CommonCrypto
import Foundation

/// Opt-in certificate pinning for the two Anthropic hosts the menubar app talks to:
/// platform.claude.com (token refresh) and api.anthropic.com (usage fetch).
///
/// Default behaviour is unchanged: `UserDefaults.standard.array(forKey: pinnedHashesKey)`
/// is empty out of the box, so connections use the system trust store exactly as before.
/// A user who wants protection against a rogue root in their chain (corporate TLS inspector
/// they don't trust, a locally-installed MITM cert) populates the array with base64 SHA-256
/// hashes of the full DER-encoded certificate. The delegate then walks the presented chain
/// and accepts only when at least one cert's hash matches the allow-list.
///
/// Why hash the full certificate (leaf pinning) rather than just the SPKI: `SecKeyCopy-
/// ExternalRepresentation` does NOT return the SPKI structure (it returns algorithm-specific
/// raw key bytes), so hashing the key in Swift and hashing SPKI in openssl would produce
/// different digests. Hashing `SecCertificateCopyData` matches `openssl x509 -outform DER`
/// exactly and avoids brittle ASN.1 reconstruction. The trade-off: cert rotation forces a
/// hash update even when the key stays the same.
///
/// Why opt-in: the two endpoints rotate certs on their own schedule. A default-on pin would
/// silently break the app on rotation for every user. Opt-in lets security-conscious users
/// defend themselves without holding the rest of the product hostage to cert maintenance.
///
/// Hash extraction (paste one hash per endpoint into the array):
///   openssl s_client -connect api.anthropic.com:443 -servername api.anthropic.com </dev/null \
///     2>/dev/null | openssl x509 -outform DER | openssl dgst -sha256 -binary | base64
///
/// Enable with:
///   defaults write org.agentseal.codeburn-menubar CodeBurnPinnedSPKIHashes -array \
///     "<base64-hash-for-platform-claude-com>" "<base64-hash-for-api-anthropic-com>"
///
/// The defaults key name is kept as `CodeBurnPinnedSPKIHashes` for forward compatibility
/// with a future refactor that pins true SPKI; the hash semantics described above are what
/// the current implementation actually matches.
enum Pinning {
    static let pinnedHashesKey = "CodeBurnPinnedSPKIHashes"
    static let pinnedHosts: Set<String> = ["platform.claude.com", "api.anthropic.com"]

    /// Reads the opt-in allow-list from UserDefaults. Empty array means "no pinning".
    /// If the key is set to a non-array type (e.g. `defaults write ... -string`), log a single
    /// warning so a misconfigured user knows why pinning isn't taking effect, then fall back
    /// to the empty allow-list (fail-open, matching the opt-in contract).
    static func configuredHashes() -> Set<String> {
        let defaults = UserDefaults.standard
        if defaults.object(forKey: pinnedHashesKey) != nil,
           defaults.array(forKey: pinnedHashesKey) == nil {
            logTypeMismatchOnce()
            return []
        }
        let raw = defaults.array(forKey: pinnedHashesKey) as? [String] ?? []
        return Set(raw.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty })
    }

    /// Diagnostic-only. Fires at most once per process to keep the log quiet when the
    /// delegate is invoked on every TLS handshake.
    private static let typeMismatchLogger: Void = {
        NSLog("CodeBurn: \(Pinning.pinnedHashesKey) is set to a non-array type; ignoring. Use `defaults write ... -array ...` to enable pinning.")
    }()

    private static func logTypeMismatchOnce() {
        _ = typeMismatchLogger
    }
}

/// URLSessionDelegate that enforces SPKI pinning on the pinned hosts when the opt-in allow-list
/// is populated. Every other host (and every hop where the allow-list is empty) goes through
/// the default system-trust evaluation.
final class PinningURLSessionDelegate: NSObject, URLSessionDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let serverTrust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        let host = challenge.protectionSpace.host
        let pinnedHashes = Pinning.configuredHashes()

        // Short-circuit: non-pinned hosts OR no opt-in allow-list -> default handling.
        guard Pinning.pinnedHosts.contains(host), !pinnedHashes.isEmpty else {
            completionHandler(.performDefaultHandling, nil)
            return
        }

        // First: ensure the system chain is otherwise valid (expiry, signature, etc.). Pinning
        // augments default validation, it does not replace it.
        var error: CFError?
        let systemTrusted = SecTrustEvaluateWithError(serverTrust, &error)
        guard systemTrusted else {
            NSLog("CodeBurn: pinned host \(host) failed system trust evaluation: \(error?.localizedDescription ?? "unknown")")
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }

        // Then: compute SHA-256 of the DER-encoded certificate for every cert in the presented
        // chain and accept only when at least one matches the opt-in allow-list. See the file
        // header for why we hash the full cert rather than the SPKI.
        guard let chain = SecTrustCopyCertificateChain(serverTrust) as? [SecCertificate] else {
            NSLog("CodeBurn: could not read cert chain for pinned host \(host)")
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        for cert in chain {
            let derBytes = SecCertificateCopyData(cert) as Data
            let hash = Self.sha256Base64(derBytes)
            if pinnedHashes.contains(hash) {
                completionHandler(.useCredential, URLCredential(trust: serverTrust))
                return
            }
        }
        NSLog("CodeBurn: no certificate hash in the chain for \(host) matched the configured pins; rejecting")
        completionHandler(.cancelAuthenticationChallenge, nil)
    }

    private static func sha256Base64(_ data: Data) -> String {
        var digest = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        data.withUnsafeBytes { ptr in
            _ = CC_SHA256(ptr.baseAddress, CC_LONG(data.count), &digest)
        }
        return Data(digest).base64EncodedString()
    }
}

/// Shared `URLSession` for Anthropic calls. Pinning is always on the wire but only takes effect
/// when the UserDefaults allow-list is populated, so this session is safe to use everywhere.
/// Lazily initialised so non-networking code paths don't pay the setup cost.
enum PinningURLSession {
    static let shared: URLSession = {
        let config = URLSessionConfiguration.default
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        return URLSession(configuration: config, delegate: PinningURLSessionDelegate(), delegateQueue: nil)
    }()
}
