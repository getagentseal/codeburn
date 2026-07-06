import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Codex terminal failure classification")
struct CodexTerminalFailureTests {
    @Test("expired refresh token (4xx) is terminal")
    func expiredRefreshTokenIsTerminal() {
        let err = CodexCredentialStore.StoreError.refreshHTTPError(400, "invalid_grant: refresh_token_expired")
        #expect(err.isTerminal)
    }

    @Test("missing refresh token is terminal")
    func missingRefreshTokenIsTerminal() {
        #expect(CodexCredentialStore.StoreError.noRefreshToken.isTerminal)
    }

    @Test("a 5xx refresh error is not terminal")
    func serverErrorIsNotTerminal() {
        let err = CodexCredentialStore.StoreError.refreshHTTPError(503, "service unavailable")
        #expect(!err.isTerminal)
    }

    @Test("a network error is not terminal")
    func networkErrorIsNotTerminal() {
        let err = CodexCredentialStore.StoreError.refreshNetworkError(URLError(.timedOut))
        #expect(!err.isTerminal)
    }

    @Test("FetchError wrapping a terminal credential error is terminal")
    func fetchErrorPropagatesTerminal() {
        let store = CodexCredentialStore.StoreError.refreshHTTPError(401, "invalid_grant")
        let fetch = CodexSubscriptionService.FetchError.credential(store)
        #expect(fetch.isTerminal)
    }
}
