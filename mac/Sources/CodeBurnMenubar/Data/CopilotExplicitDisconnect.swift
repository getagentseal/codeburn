import Foundation

/// Persisted opt-out for live quota tracking after an explicit Disconnect.
/// Credentials stay untouched; this flag only stops automatic discovery from
/// bringing quota tracking back on the next refresh or relaunch, until the user
/// connects again. Absent key is false, so first-use autodiscovery is unchanged.
enum ProviderExplicitDisconnect {
    static func defaultsKey(_ providerID: String) -> String {
        "codeburn.\(providerID).explicitlyDisconnected"
    }

    static func isSet(_ providerID: String, defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: defaultsKey(providerID))
    }

    static func mark(_ providerID: String, defaults: UserDefaults = .standard) {
        defaults.set(true, forKey: defaultsKey(providerID))
    }

    static func clear(_ providerID: String, defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: defaultsKey(providerID))
    }
}

enum CopilotExplicitDisconnect {
    static let defaultsKey = ProviderExplicitDisconnect.defaultsKey("copilot")

    static func isSet(defaults: UserDefaults = .standard) -> Bool {
        ProviderExplicitDisconnect.isSet("copilot", defaults: defaults)
    }

    static func mark(defaults: UserDefaults = .standard) {
        ProviderExplicitDisconnect.mark("copilot", defaults: defaults)
    }

    static func clear(defaults: UserDefaults = .standard) {
        ProviderExplicitDisconnect.clear("copilot", defaults: defaults)
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
