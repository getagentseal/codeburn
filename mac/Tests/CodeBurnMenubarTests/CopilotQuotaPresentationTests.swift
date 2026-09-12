import Foundation
import Testing
@testable import CodeBurnMenubar

/// Copilot tokens are read-only with no refresh path, so `.terminalFailure`
/// means the user must sign in via an editor's Copilot plugin again. These
/// tests pin the display decision: a terminal login with a snapshot on hand
/// must keep showing the bars (with a quiet idle caption), and only the
/// no-data case falls through to the reconnect screen. Explicit Disconnect
/// is a separate no-data path: credentials remain, so copy must not claim
/// they are missing.
@Suite("Copilot quota presentation")
struct CopilotQuotaPresentationTests {
    typealias Presentation = CopilotQuotaPresentation

    @Test("terminal failure with a snapshot keeps the usage bars, flagged idle")
    func terminalWithUsageShowsIdleUsage() {
        let content = Presentation.planContent(loadState: .terminalFailure(reason: "expired"), hasUsage: true)
        #expect(content == .usage(idle: true))
    }

    @Test("terminal failure with no snapshot falls through to reconnect")
    func terminalWithoutUsageShowsReconnect() {
        let content = Presentation.planContent(loadState: .terminalFailure(reason: "expired"), hasUsage: false)
        #expect(content == .reconnect(reason: "expired"))
    }

    @Test("loaded with a snapshot shows usage without the idle caption")
    func loadedShowsPlainUsage() {
        #expect(Presentation.planContent(loadState: .loaded, hasUsage: true) == .usage(idle: false))
    }

    @Test("transient failure keeps the last snapshot, else shows the retry screen")
    func transientFailureFallsBackToUsage() {
        #expect(Presentation.planContent(loadState: .transientFailure(retryAt: nil), hasUsage: true) == .usage(idle: false))
        #expect(Presentation.planContent(loadState: .transientFailure(retryAt: nil), hasUsage: false) == .transientFailed)
    }

    @Test("absent-flag first use and real noCredentials keep the sign-in copy")
    func credentialStatesRouteToNoCredentials() {
        #expect(Presentation.planContent(loadState: .notBootstrapped, hasUsage: false) == .noCredentials)
        #expect(Presentation.planContent(loadState: .notBootstrapped, hasUsage: false, explicitlyDisconnected: false) == .noCredentials)
        #expect(Presentation.planContent(loadState: .noCredentials, hasUsage: false) == .noCredentials)
        #expect(Presentation.planContent(loadState: .noCredentials, hasUsage: false, explicitlyDisconnected: true) == .noCredentials)
        #expect(Presentation.noCredentialsPlanTitle == "No Copilot credentials found")
        #expect(Presentation.noCredentialsPlanMessage.contains("Sign in via an editor's Copilot plugin first"))
        #expect(Presentation.settingsNotConnectedDetail(explicitlyDisconnected: false) == Presentation.noCredentialsSettingsDetail)
        #expect(Presentation.noCredentialsSettingsDetail.contains("sign in"))
    }

    @Test("explicit disconnect copy differs from first-use; clearing the flag restores first-use")
    func explicitDisconnectDiffersFromFirstUseAndClears() throws {
        let suiteName = "codeburn.copilot.presentation.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(!CopilotExplicitDisconnect.isSet(defaults: defaults))
        let firstUse = Presentation.planContent(
            loadState: .notBootstrapped,
            hasUsage: false,
            explicitlyDisconnected: CopilotExplicitDisconnect.isSet(defaults: defaults)
        )
        #expect(firstUse == .noCredentials)

        CopilotExplicitDisconnect.mark(defaults: defaults)
        #expect(CopilotExplicitDisconnect.isSet(defaults: defaults))
        let disconnected = Presentation.planContent(
            loadState: .notBootstrapped,
            hasUsage: false,
            explicitlyDisconnected: CopilotExplicitDisconnect.isSet(defaults: defaults)
        )
        #expect(disconnected == .disconnected)
        #expect(disconnected != firstUse)
        #expect(Presentation.disconnectedPlanTitle != Presentation.noCredentialsPlanTitle)
        #expect(!Presentation.disconnectedPlanTitle.localizedCaseInsensitiveContains("no copilot credentials"))
        #expect(!Presentation.disconnectedPlanMessage.localizedCaseInsensitiveContains("sign in"))
        #expect(Presentation.disconnectedPlanMessage.localizedCaseInsensitiveContains("untouched"))
        #expect(Presentation.disconnectedPlanMessage.localizedCaseInsensitiveContains("connect"))
        let settings = Presentation.settingsNotConnectedDetail(explicitlyDisconnected: true)
        #expect(settings == Presentation.disconnectedSettingsDetail)
        #expect(settings != Presentation.noCredentialsSettingsDetail)
        #expect(!settings.localizedCaseInsensitiveContains("sign in"))
        #expect(settings.localizedCaseInsensitiveContains("untouched"))
        #expect(settings.localizedCaseInsensitiveContains("connect"))

        CopilotExplicitDisconnect.clear(defaults: defaults)
        #expect(!CopilotExplicitDisconnect.isSet(defaults: defaults))
        #expect(
            Presentation.planContent(
                loadState: .notBootstrapped,
                hasUsage: false,
                explicitlyDisconnected: CopilotExplicitDisconnect.isSet(defaults: defaults)
            ) == .noCredentials
        )
        #expect(Presentation.settingsNotConnectedDetail(explicitlyDisconnected: false) == Presentation.noCredentialsSettingsDetail)
    }

    @Test("the connected detail names the host that answered")
    func connectedDetailNamesTheHost() {
        #expect(
            Presentation.connectedSettingsDetail(plan: "Enterprise", apiHost: "api.acme.ghe.com")
                == "Plan: Enterprise. Live quota tracked from api.acme.ghe.com.")
        #expect(
            Presentation.connectedSettingsDetail(plan: nil, apiHost: "api.github.com")
                == "Live quota tracked from api.github.com.")
        #expect(
            Presentation.connectedSettingsDetail(plan: "Pro", apiHost: "")
                == "Plan: Pro. Live quota tracked from api.github.com.")
    }

    @Test("a fresh snapshot is not stamped stale")
    func freshSnapshotIsNotStale() {
        let now = Date()
        let fetchedAt = now.addingTimeInterval(-60) // 1 min old
        #expect(Presentation.isStale(fetchedAt: fetchedAt, now: now) == false)
    }

    @Test("a snapshot older than the threshold is stamped stale")
    func oldSnapshotIsStale() {
        let now = Date()
        let fetchedAt = now.addingTimeInterval(-11 * 60) // 11 min old
        #expect(Presentation.isStale(fetchedAt: fetchedAt, now: now) == true)
    }
}
