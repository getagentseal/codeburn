import SwiftUI

/// Backs the `Settings` scene reachable via Cmd-, from the menubar app. Currently exposes
/// the privacy toggle for the Anthropic subscription sync. Mirrors the existing
/// `CodeBurnDisableSubscriptionFetch` UserDefaults key so the documented `defaults write`
/// override stays equivalent to the UI control.
struct SettingsView: View {
    /// Persisted as the *negative* (disable) flag so existing users who have already run
    /// `defaults write org.agentseal.codeburn-menubar CodeBurnDisableSubscriptionFetch -bool true`
    /// see the toggle in the correct OFF position on first open. The Toggle's binding is
    /// inverted so the on-screen label can read positively ("Sync Anthropic plan usage").
    @AppStorage("CodeBurnDisableSubscriptionFetch") private var subscriptionFetchDisabled = false

    var body: some View {
        TabView {
            Form {
                Section {
                    Toggle("Sync Anthropic plan usage", isOn: Binding(
                        get: { !subscriptionFetchDisabled },
                        set: { subscriptionFetchDisabled = !$0 }
                    ))
                } header: {
                    Text("Privacy")
                } footer: {
                    Text("When on, CodeBurn reads your Claude OAuth credentials from ~/.claude/.credentials.json (or the macOS Keychain) and queries platform.claude.com and api.anthropic.com to display your subscription usage in the Plan pill. When off, no credentials are read and no requests are sent. Equivalent to `defaults write org.agentseal.codeburn-menubar CodeBurnDisableSubscriptionFetch -bool true`.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            .formStyle(.grouped)
            .tabItem { Label("Privacy", systemImage: "lock.shield") }
        }
        .frame(width: 460, height: 220)
    }
}
