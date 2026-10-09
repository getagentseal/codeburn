import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Capacity Dock connection action")
struct CapacityDockConnectionActionTests {
    @Test("missing or disconnected quota offers a direct Connect action")
    func connectAction() {
        #expect(CapacityDockConnectionAction.resolve(quota: nil) == .connect)
        #expect(CapacityDockConnectionAction.resolve(quota: summary(connection: .disconnected)) == .connect)
    }

    @Test("terminal provider failure offers Reconnect")
    func reconnectAction() {
        let quota = summary(connection: .terminalFailure(reason: "Sign in again."))
        #expect(CapacityDockConnectionAction.resolve(quota: quota) == .reconnect)
    }

    @Test("API-only providers route the dock action to credential entry")
    func apiCredentialActionTitle() {
        let provider = CapacityDockProvider(rawValue: "openrouter")!
        #expect(CapacityDockConnectionAction.reconnect.title(for: provider) == "Add API Key")
        #expect(ProviderConnectionGuidance.dockInstruction(for: provider) ==
            "Add an API key or token in Provider Settings.")
    }

    @Test("ClinePass reconnects through the Cline sign-in, with a key as the alternative")
    func clinePassActionTitle() {
        let provider = CapacityDockProvider(rawValue: "clinepass")!
        #expect(CapacityDockConnectionAction.reconnect.title(for: provider) == CapacityDockConnectionAction.reconnect.title)
        #expect(ProviderConnectionGuidance.dockInstruction(for: provider) ==
            "Sign in with Cline, or enter a ClinePass API key below, then click Retry.")
    }

    @Test("active and automatically recovering states do not offer a connection action")
    func noActionWhileActive() {
        let states: [QuotaSummary.Connection] = [
            .connected,
            .loading,
            .stale,
            .transientFailure,
        ]
        for state in states {
            #expect(CapacityDockConnectionAction.resolve(quota: summary(connection: state)) == nil)
        }
    }

    @Test("an explicit Connect executes one user-initiated refresh operation")
    func explicitConnectInteraction() async throws {
        let counter = RefreshCounter()
        let value = try await CapacityDockProviderRefreshInteraction.userInitiated {
            await counter.increment()
            return 42
        }
        let refreshCount = await counter.value

        #expect(value == 42)
        #expect(refreshCount == 1)
    }

    private func summary(connection: QuotaSummary.Connection) -> QuotaSummary {
        QuotaSummary(
            providerFilter: .codex,
            connection: connection,
            primary: nil,
            details: [],
            planLabel: nil,
            footerLines: []
        )
    }

    private actor RefreshCounter {
        private(set) var value = 0
        func increment() { value += 1 }
    }
}
