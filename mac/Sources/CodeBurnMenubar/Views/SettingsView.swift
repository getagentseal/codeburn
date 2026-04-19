import SwiftUI

struct SettingsView: View {
    @AppStorage("CodeBurnDisableSubscriptionFetch") private var subscriptionFetchDisabled = false

    var body: some View {
        TabView {
            Form {
                Section {
                    Toggle("Sync Augment plan usage", isOn: Binding(
                        get: { !subscriptionFetchDisabled },
                        set: { subscriptionFetchDisabled = !$0 }
                    ))
                } header: {
                    Text("Privacy")
                } footer: {
                    Text("When on, CodeBurn reads your Augment session from ~/.augment/session.json and queries the Augment API to display your credit usage in the Plan pill. When off, no session data is read and no requests are sent. Equivalent to `defaults write org.agentseal.codeburn-menubar CodeBurnDisableSubscriptionFetch -bool true`.")
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
