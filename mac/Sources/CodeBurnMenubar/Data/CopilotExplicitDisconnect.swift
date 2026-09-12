import Foundation

/// Persisted opt-out for live Copilot quota tracking after an explicit
/// Disconnect. Credentials stay untouched; this flag only stops automatic
/// discovery from bringing quota tracking back on the next refresh or relaunch.
/// Absent key is false, so first-use autodiscovery is unchanged.
enum CopilotExplicitDisconnect {
    static let defaultsKey = "codeburn.copilot.explicitlyDisconnected"

    static func isSet(defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: defaultsKey)
    }

    static func mark(defaults: UserDefaults = .standard) {
        defaults.set(true, forKey: defaultsKey)
    }

    static func clear(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: defaultsKey)
    }
}

/// Injectable Copilot quota I/O for AppStore. Production uses `.live`;
/// tests pass an ephemeral UserDefaults suite and stubbed fetch/credential
/// checks so they never touch installed prefs, Keychain, or `gh`.
@MainActor
struct CopilotQuotaRuntime {
    var hasCredential: () -> Bool
    var refresh: @Sendable () async throws -> CopilotUsage
    var disconnectService: () -> Void
    var defaults: UserDefaults

    static let live = CopilotQuotaRuntime(
        hasCredential: { CopilotSubscriptionService.hasCredential },
        refresh: { try await CopilotSubscriptionService.refresh() },
        disconnectService: { CopilotSubscriptionService.disconnect() },
        defaults: .standard
    )
}
