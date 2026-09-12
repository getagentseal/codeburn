import Foundation

/// Pure display-decision helpers for the Copilot quota surfaces.
///
/// Copilot tokens are read straight from whichever signed-in client already
/// holds one, with no refresh path, so a revoked token sits in
/// `.terminalFailure` until the user signs in again. Like Kimi and
/// Gemini, the always-visible surfaces keep showing the last good snapshot
/// with a quiet caption instead of flapping to a reconnect screen; the
/// reconnect screen is reserved for the no-data case, where there is
/// genuinely nothing to show.
///
/// Explicit Disconnect is different from missing credentials: the store keeps
/// `.notBootstrapped` while credentials stay on disk. Plan, Settings, and
/// Capacity Dock nil-quota copy therefore take the persisted opt-out flag and
/// must not claim the token is gone.
enum CopilotQuotaPresentation {
    /// Which Plan-tab subview to render, given the load state and whether a
    /// last-known snapshot exists.
    enum PlanContent: Equatable {
        case noCredentials
        /// Explicit Disconnect: quota tracking is off, credentials untouched.
        case disconnected
        case loading
        case failed
        case transientFailed
        case reconnect(reason: String?)
        /// Render the loaded usage bars. `idle` is true when the login has
        /// gone terminal but a snapshot is still on hand — the caller stamps a
        /// quiet "sign in again" caption instead of hiding the data.
        case usage(idle: Bool)
    }

    static let noCredentialsPlanTitle = "No Copilot credentials found"
    static let noCredentialsPlanMessage =
        "Sign in via an editor's Copilot plugin first. Then click Try Again."
    static let disconnectedPlanTitle = "Copilot quota tracking disconnected"
    static let disconnectedPlanMessage =
        "Your Copilot credentials are untouched. Click Connect to resume."
    static let noCredentialsSettingsDetail =
        "Usage tracking still works. For live quota, sign in with the Copilot CLI or gh auth login, or paste a token below, then click Connect."
    static let disconnectedSettingsDetail =
        "Quota tracking disconnected. Credentials are untouched. Click Connect to resume."

    static func planContent(
        loadState: SubscriptionLoadState,
        hasUsage: Bool,
        explicitlyDisconnected: Bool = false
    ) -> PlanContent {
        switch loadState {
        case .notBootstrapped:
            return explicitlyDisconnected ? .disconnected : .noCredentials
        case .noCredentials:
            return .noCredentials
        case .dormant, .bootstrapping:
            return .loading
        case .loading, .loaded:
            return hasUsage ? .usage(idle: false) : .loading
        case .failed:
            return .failed
        case .transientFailure:
            return hasUsage ? .usage(idle: false) : .transientFailed
        case .terminalFailure(let reason):
            return hasUsage ? .usage(idle: true) : .reconnect(reason: reason)
        }
    }

    /// Settings connection-row detail for a loaded snapshot. It always names
    /// the host that answered, so a GitHub Enterprise Cloud tenant can see its
    /// own `api.<tenant>.ghe.com` endpoint rather than a dotcom claim (#1286).
    static func connectedSettingsDetail(plan: String?, apiHost: String) -> String {
        let host = apiHost.isEmpty ? CopilotHostEndpoint.defaultAPIHost : apiHost
        guard let plan, !plan.isEmpty else { return "Live quota tracked from \(host)." }
        return "Plan: \(plan). Live quota tracked from \(host)."
    }

    static func settingsNotConnectedDetail(explicitlyDisconnected: Bool) -> String {
        explicitlyDisconnected ? disconnectedSettingsDetail : noCredentialsSettingsDetail
    }

    /// Snapshot age past which a loaded view stamps an "as of <time>" caption,
    /// so a bar can never silently masquerade as current.
    static let stalenessThreshold: TimeInterval = 10 * 60

    static func isStale(fetchedAt: Date, now: Date = Date()) -> Bool {
        now.timeIntervalSince(fetchedAt) > stalenessThreshold
    }
}
