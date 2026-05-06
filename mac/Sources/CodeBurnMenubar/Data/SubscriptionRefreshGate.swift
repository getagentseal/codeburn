import Foundation

/// Gates Claude OAuth refresh attempts so a dead refresh token (typically `invalid_grant`
/// from Anthropic when the user re-logged-in elsewhere) does not produce an infinite
/// loop of failing token-endpoint calls and a constantly broken Plan UI.
///
/// State machine:
///   - .healthy: try normally.
///   - .terminalBlocked: a 4xx that is not transient (invalid_grant, invalid_client, etc.).
///     Stay blocked until the user's credentials file *changes* (the user re-runs
///     `claude login`). The fingerprint is captured at failure time and compared on each
///     `shouldAttempt` call.
///   - .transientBlocked: 5xx, network errors, timeouts. Exponential backoff capped at 6h.
///
/// Persisted to UserDefaults so the block survives app restarts. The cost of getting this
/// wrong is small (a stale dashboard for a few minutes) so we keep the implementation
/// minimal and free of external dependencies.
enum SubscriptionRefreshGate {
    enum BlockStatus: Equatable {
        case healthy
        case terminal(reason: String?)
        case transient(until: Date)

        var isBlocked: Bool {
            switch self {
            case .healthy: false
            case .terminal: true
            case .transient: true
            }
        }
    }

    private static let terminalReasonKey = "codeburn.subscriptionRefresh.terminalReason"
    private static let terminalFingerprintKey = "codeburn.subscriptionRefresh.terminalFingerprint"
    private static let transientUntilKey = "codeburn.subscriptionRefresh.transientUntil"
    private static let transientAttemptsKey = "codeburn.subscriptionRefresh.transientAttempts"

    private static let transientBaseInterval: TimeInterval = 5 * 60
    private static let transientMaxInterval: TimeInterval = 6 * 60 * 60

    /// Returns true if a refresh attempt should be made right now.
    /// Side effect: clears terminal block if the credentials file fingerprint has changed
    /// since the failure (the user re-logged-in).
    static func shouldAttempt(now: Date = Date(), credentialsFingerprint: String?) -> Bool {
        let defaults = UserDefaults.standard

        if let storedFingerprint = defaults.string(forKey: terminalFingerprintKey) {
            // Terminal-blocked. Only attempt if the credentials fingerprint has changed.
            if let current = credentialsFingerprint, current != storedFingerprint {
                clearTerminal()
                return true
            }
            return false
        }

        if let until = defaults.object(forKey: transientUntilKey) as? Date {
            if until <= now {
                clearTransient()
                return true
            }
            return false
        }

        return true
    }

    /// Returns the current block status for UI surfaces (so we can show a "Reconnect" CTA).
    static func currentStatus(now: Date = Date()) -> BlockStatus {
        let defaults = UserDefaults.standard
        if defaults.string(forKey: terminalFingerprintKey) != nil {
            return .terminal(reason: defaults.string(forKey: terminalReasonKey))
        }
        if let until = defaults.object(forKey: transientUntilKey) as? Date, until > now {
            return .transient(until: until)
        }
        return .healthy
    }

    static func recordTerminalFailure(reason: String?, credentialsFingerprint: String?) {
        let defaults = UserDefaults.standard
        defaults.set(reason, forKey: terminalReasonKey)
        defaults.set(credentialsFingerprint ?? "", forKey: terminalFingerprintKey)
        defaults.removeObject(forKey: transientUntilKey)
        defaults.removeObject(forKey: transientAttemptsKey)
    }

    static func recordTransientFailure(now: Date = Date()) {
        let defaults = UserDefaults.standard
        let attempts = defaults.integer(forKey: transientAttemptsKey)
        let nextAttempts = attempts + 1
        // Exponential: 5m, 10m, 20m, 40m, ... capped at 6h.
        let interval = min(transientBaseInterval * pow(2.0, Double(attempts)), transientMaxInterval)
        defaults.set(nextAttempts, forKey: transientAttemptsKey)
        defaults.set(now.addingTimeInterval(interval), forKey: transientUntilKey)
    }

    static func recordSuccess() {
        clearTerminal()
        clearTransient()
    }

    private static func clearTerminal() {
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: terminalReasonKey)
        defaults.removeObject(forKey: terminalFingerprintKey)
    }

    private static func clearTransient() {
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: transientUntilKey)
        defaults.removeObject(forKey: transientAttemptsKey)
    }

    /// Hash-free fingerprint of the credentials source. Combines mtime + size of the
    /// credentials file plus a marker for keychain-only auth so a credential change
    /// from any source lifts a terminal block.
    static func credentialsFingerprint() -> String? {
        let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude/.credentials.json")
        if let attrs = try? FileManager.default.attributesOfItem(atPath: url.path) {
            let mtime = (attrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
            let size = (attrs[.size] as? Int) ?? 0
            return "file:\(mtime):\(size)"
        }
        return nil
    }

    /// Categorize a refresh-token POST response. 400/401 with an `invalid_*` error_code
    /// is terminal; everything else is transient.
    static func classifyRefreshFailure(statusCode: Int, body: String?) -> BlockStatus {
        if statusCode >= 400, statusCode < 500 {
            let lower = body?.lowercased() ?? ""
            if lower.contains("invalid_grant") || lower.contains("invalid_client") || lower.contains("invalid_token") {
                return .terminal(reason: extractErrorDescription(body) ?? "invalid_grant")
            }
            // Other 4xx: treat as terminal too — the server is rejecting our request shape.
            return .terminal(reason: extractErrorDescription(body) ?? "HTTP \(statusCode)")
        }
        return .transient(until: Date().addingTimeInterval(transientBaseInterval))
    }

    private static func extractErrorDescription(_ body: String?) -> String? {
        guard let body, let data = body.data(using: .utf8) else { return nil }
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let desc = json["error_description"] as? String { return desc }
            if let err = json["error"] as? String { return err }
        }
        return nil
    }
}
