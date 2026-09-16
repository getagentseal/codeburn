import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Capacity Dock provider quota registry")
@MainActor
struct CapacityDockProviderQuotaServiceTests {
    /// Dependencies has no live defaults, so every test names each adapter.
    /// Adapters the test does not exercise fail loudly if dispatched.
    nonisolated private static let unusedCursor: @Sendable () async throws -> QuotaSummary = {
        Issue.record("Wrong adapter dispatched")
        return Self.summary()
    }
    nonisolated private static let unusedGrok: @Sendable () async throws -> QuotaSummary = {
        Issue.record("Wrong adapter dispatched")
        return Self.summary()
    }
    nonisolated private static let unusedGrokBot: @Sendable () async throws -> QuotaSummary = {
        Issue.record("Wrong adapter dispatched")
        return Self.summary()
    }
    nonisolated private static let unusedZai: @Sendable (String?) async throws -> QuotaSummary = { _ in
        Issue.record("Wrong adapter dispatched")
        return Self.summary()
    }

    @Test("ClinePass dispatches with only its provider-scoped API key")
    func dispatchesClinePass() async throws {
        let capture = SecretCapture()
        let expected = Self.summary(percent: 0.42)
        let service = CapacityDockProviderQuotaService(dependencies: .init(
            refreshClinePass: { apiKey in
                await capture.record(apiKey)
                return expected
            },
            refreshCursor: Self.unusedCursor,
            refreshGrok: Self.unusedGrok,
            refreshGrokBot: Self.unusedGrokBot,
            refreshZai: Self.unusedZai
        ))
        let provider = try #require(CapacityDockProvider(rawValue: "clinepass"))
        let credential = CapacityDockProviderCredential(
            sourceMode: "api",
            apiKey: "  synthetic-clinepass-key  "
        )

        let result = try await service.fetch(provider: provider, credential: credential)
        let capturedKeys = await capture.values

        #expect(result == expected)
        #expect(capturedKeys == ["synthetic-clinepass-key"])
    }

    @Test("Z.ai dispatches with only its provider-scoped API key")
    func dispatchesZai() async throws {
        let capture = SecretCapture()
        let expected = Self.summary(percent: 0.18)
        let service = CapacityDockProviderQuotaService(dependencies: .init(
            refreshClinePass: { _ in
                Issue.record("Wrong adapter dispatched")
                return Self.summary()
            },
            refreshCursor: Self.unusedCursor,
            refreshGrok: Self.unusedGrok,
            refreshGrokBot: Self.unusedGrokBot,
            refreshZai: { apiKey in
                if let apiKey { await capture.record(apiKey) }
                return expected
            }
        ))
        let provider = try #require(CapacityDockProvider(rawValue: "zai"))

        let result = try await service.fetch(
            provider: provider,
            credential: CapacityDockProviderCredential(sourceMode: "api", apiKey: "  synthetic-zai-key  ")
        )

        let capturedKeys = await capture.values
        #expect(result == expected)
        #expect(capturedKeys == ["synthetic-zai-key"])
    }

    @Test("Cursor dispatches through passive local-session discovery")
    func dispatchesCursor() async throws {
        let expected = Self.summary(percent: 0.37)
        let service = CapacityDockProviderQuotaService(dependencies: .init(
            refreshClinePass: { _ in
                Issue.record("Wrong adapter dispatched")
                return Self.summary()
            },
            refreshCursor: { expected },
            refreshGrok: Self.unusedGrok,
            refreshGrokBot: Self.unusedGrokBot,
            refreshZai: Self.unusedZai
        ))
        let provider = try #require(CapacityDockProvider(rawValue: "cursor"))

        let result = try await service.fetch(
            provider: provider,
            credential: CapacityDockProviderCredential()
        )

        #expect(result == expected)
    }

    @Test("Grok dispatches through passive Grok Build login discovery")
    func dispatchesGrok() async throws {
        let expected = Self.summary(percent: 0.21)
        let service = CapacityDockProviderQuotaService(dependencies: .init(
            refreshClinePass: { _ in
                Issue.record("Wrong adapter dispatched")
                return Self.summary()
            },
            refreshCursor: Self.unusedCursor,
            refreshGrok: { expected },
            refreshGrokBot: Self.unusedGrokBot,
            refreshZai: Self.unusedZai
        ))
        let provider = try #require(CapacityDockProvider(rawValue: "grok"))

        let result = try await service.fetch(
            provider: provider,
            credential: CapacityDockProviderCredential()
        )

        #expect(result == expected)
    }

    @Test("Grok Bot dispatches through the Cursor app's own local session")
    func dispatchesGrokBot() async throws {
        let expected = Self.summary(percent: 0.99)
        let service = CapacityDockProviderQuotaService(dependencies: .init(
            refreshClinePass: { _ in
                Issue.record("Wrong adapter dispatched")
                return Self.summary()
            },
            refreshCursor: Self.unusedCursor,
            refreshGrok: Self.unusedGrok,
            refreshGrokBot: { expected },
            refreshZai: Self.unusedZai
        ))
        let provider = try #require(CapacityDockProvider(rawValue: "grokbot"))

        let result = try await service.fetch(
            provider: provider,
            credential: CapacityDockProviderCredential()
        )

        #expect(result == expected)
    }

    @Test("ClinePass requires its own saved API key")
    func requiresClinePassKey() async throws {
        let service = CapacityDockProviderQuotaService(dependencies: .init(
            refreshClinePass: { _ in
                Issue.record("Adapter must not run without a key")
                return Self.summary()
            },
            refreshCursor: Self.unusedCursor,
            refreshGrok: Self.unusedGrok,
            refreshGrokBot: Self.unusedGrokBot,
            refreshZai: Self.unusedZai
        ))
        let provider = try #require(CapacityDockProvider(rawValue: "clinepass"))

        await #expect(throws: CapacityDockProviderFetchFailure.self) {
            try await service.fetch(
                provider: provider,
                credential: CapacityDockProviderCredential(sourceMode: "api", apiKey: "  ")
            )
        }

        do {
            _ = try await service.fetch(
                provider: provider,
                credential: CapacityDockProviderCredential(sourceMode: "api", apiKey: "")
            )
            Issue.record("Expected a terminal missing-key failure")
        } catch let failure as CapacityDockProviderFetchFailure {
            #expect(failure.disposition == .terminal)
            #expect(failure.message == "Enter a ClinePass API key or token, then press Save & Connect.")
        }
    }

    @Test("unsupported catalog providers fail truthfully and terminally")
    func rejectsUnsupportedProvider() async throws {
        let service = CapacityDockProviderQuotaService(dependencies: .init(
            refreshClinePass: { _ in
                Issue.record("Wrong adapter dispatched")
                return Self.summary()
            },
            refreshCursor: Self.unusedCursor,
            refreshGrok: Self.unusedGrok,
            refreshGrokBot: Self.unusedGrokBot,
            refreshZai: Self.unusedZai
        ))
        let provider = try #require(CapacityDockProvider(rawValue: "openrouter"))

        do {
            _ = try await service.fetch(
                provider: provider,
                credential: CapacityDockProviderCredential(sourceMode: "api", apiKey: "synthetic")
            )
            Issue.record("Expected an unsupported-provider failure")
        } catch let failure as CapacityDockProviderFetchFailure {
            #expect(failure.disposition == .terminal)
            #expect(failure.message ==
                "OpenRouter does not have a CodeBurn live quota adapter yet. Remove it from the dock or choose a supported provider.")
        }
    }

    @Test("adapter authentication failures are terminal")
    func classifiesAuthenticationFailure() async throws {
        let service = CapacityDockProviderQuotaService(dependencies: .init(
            refreshClinePass: { _ in throw ClinePassSubscriptionService.FetchError.authenticationRejected },
            refreshCursor: Self.unusedCursor,
            refreshGrok: Self.unusedGrok,
            refreshGrokBot: Self.unusedGrokBot,
            refreshZai: Self.unusedZai
        ))
        let provider = try #require(CapacityDockProvider(rawValue: "clinepass"))

        do {
            _ = try await service.fetch(
                provider: provider,
                credential: CapacityDockProviderCredential(sourceMode: "api", apiKey: "synthetic")
            )
            Issue.record("Expected an authentication failure")
        } catch let failure as CapacityDockProviderFetchFailure {
            #expect(failure.disposition == .terminal)
            #expect(failure.message == "ClinePass rejected this API key.")
        }
    }

    @Test("adapter rate limits and malformed responses remain retryable")
    func classifiesTransientFailures() async throws {
        let provider = try #require(CapacityDockProvider(rawValue: "clinepass"))
        let errors: [ClinePassSubscriptionService.FetchError] = [.rateLimited, .parseFailure]

        for error in errors {
            let service = CapacityDockProviderQuotaService(dependencies: .init(
                refreshClinePass: { _ in throw error },
                refreshCursor: Self.unusedCursor,
                refreshGrok: Self.unusedGrok,
                refreshGrokBot: Self.unusedGrokBot,
                refreshZai: Self.unusedZai
            ))
            do {
                _ = try await service.fetch(
                    provider: provider,
                    credential: CapacityDockProviderCredential(sourceMode: "api", apiKey: "synthetic")
                )
                Issue.record("Expected \(error) to fail")
            } catch let failure as CapacityDockProviderFetchFailure {
                #expect(failure.disposition == .transient)
                #expect(failure.message == error.localizedDescription)
            }
        }
        #expect(CapacityDockProviderFetchFailure.disposition(
            for: URLError(.timedOut)
        ) == .transient)
    }

    @Test("Grok login failures stop retries while quota outages preserve the connection")
    func classifiesGrokFailures() async throws {
        let provider = try #require(CapacityDockProvider(rawValue: "grok"))
        let cases: [(GrokBuildSubscriptionService.FetchError, CapacityDockProviderFetchFailureDisposition)] = [
            (.noCredentials, .terminal),
            (.authenticationRejected, .terminal),
            (.rateLimited, .transient),
            (.providerUnavailable, .transient),
            (.parseFailure, .transient),
        ]

        for (error, expectedDisposition) in cases {
            let service = CapacityDockProviderQuotaService(dependencies: .init(
                refreshClinePass: { _ in
                    Issue.record("Wrong adapter dispatched")
                    return Self.summary()
                },
                refreshCursor: Self.unusedCursor,
                refreshGrok: { throw error },
                refreshGrokBot: Self.unusedGrokBot,
                refreshZai: Self.unusedZai
            ))
            do {
                _ = try await service.fetch(
                    provider: provider,
                    credential: CapacityDockProviderCredential()
                )
                Issue.record("Expected \(error) to fail")
            } catch let failure as CapacityDockProviderFetchFailure {
                #expect(failure.disposition == expectedDisposition)
                #expect(failure.message == error.localizedDescription)
            }
        }
    }

    @Test("disconnect invalidates an in-flight provider refresh")
    func disconnectWinsOverInFlightRefresh() async throws {
        let provider = try #require(CapacityDockProvider(rawValue: "clinepass"))
        let gate = AdapterGate()
        let store = AppStore()
        store.capacityDockCredentialLoader = { _ in
            CapacityDockProviderCredential(sourceMode: "api", apiKey: "synthetic")
        }
        store.capacityDockCredentialRemover = { _ in }
        store.capacityDockProviderDeselector = { _ in }
        store.capacityDockProviderQuotaService = CapacityDockProviderQuotaService(dependencies: .init(
            refreshClinePass: { _ in
                await gate.pause()
                return Self.summary(percent: 0.73)
            },
            refreshCursor: Self.unusedCursor,
            refreshGrok: Self.unusedGrok,
            refreshGrokBot: Self.unusedGrokBot,
            refreshZai: Self.unusedZai
        ))

        let refresh = Task { await store.refreshCapacityDockProvider(provider) }
        await gate.waitUntilPaused()
        try await store.disconnectCapacityDockProvider(provider)
        await gate.open()
        await refresh.value

        #expect(store.capacityDockProviderSummaries[provider.id] == nil)
        #expect(!store.capacityDockProvidersLoading.contains(provider.id))
    }

    @Test("failed credential deletion preserves connection state and surfaces the error")
    func failedDisconnectDoesNotPretendToSucceed() async throws {
        let provider = try #require(CapacityDockProvider(rawValue: "clinepass"))
        let store = AppStore()
        let known = Self.summary(percent: 0.42)
        store.capacityDockProviderSummaries[provider.id] = known
        store.capacityDockCredentialRemover = { _ in throw SyntheticDeleteFailure() }
        store.capacityDockProviderDeselector = { _ in
            Issue.record("A failed disconnect must not edit the dock selection")
        }

        await #expect(throws: SyntheticDeleteFailure.self) {
            try await store.disconnectCapacityDockProvider(provider)
        }

        #expect(store.capacityDockProviderSummaries[provider.id] == known)
        #expect(!store.capacityDockProvidersLoading.contains(provider.id))
    }

    @Test("disconnect removes the provider from the persisted dock selection")
    func disconnectDeselectsFromDock() async throws {
        let provider = try #require(CapacityDockProvider(rawValue: "cursor"))
        let store = AppStore()
        store.capacityDockCredentialRemover = { _ in }
        var deselected: [CapacityDockProvider] = []
        store.capacityDockProviderDeselector = { deselected.append($0) }

        try await store.disconnectCapacityDockProvider(provider)

        #expect(deselected == [provider])
    }

    @Test("removeProvider drops only the target and keeps manual selection unlatched")
    func removeProviderPersistence() throws {
        let defaults = try #require(UserDefaults(
            suiteName: "CodeBurnMenubarTests.CapacityDockRemove.\(UUID().uuidString)"
        ))
        let cursor = try #require(CapacityDockProvider(rawValue: "cursor"))
        defaults.set(["codex", "cursor"], forKey: CapacityDockPreferences.selectedProvidersKey)
        defaults.set("cursor", forKey: CapacityDockPreferences.preferredProviderKey)

        CapacityDockPreferences.removeProvider(cursor, defaults: defaults)

        let snapshot = CapacityDockPreferences.load(defaults: defaults)
        #expect(snapshot.selectedProviders == [.codex])
        #expect(snapshot.preferredProvider == .codex)
        #expect(!defaults.bool(forKey: CapacityDockPreferences.manualSelectionKey))

        // Removing a provider that is not selected must not rewrite anything.
        CapacityDockPreferences.removeProvider(cursor, defaults: defaults)
        #expect(CapacityDockPreferences.load(defaults: defaults).selectedProviders == [.codex])
    }

    private actor SecretCapture {
        private(set) var values: [String] = []
        func record(_ value: String) { values.append(value) }
    }

    private actor AdapterGate {
        private var isPaused = false
        private var continuation: CheckedContinuation<Void, Never>?

        func pause() async {
            isPaused = true
            await withCheckedContinuation { continuation = $0 }
        }

        func waitUntilPaused() async {
            while !isPaused { await Task.yield() }
        }

        func open() {
            continuation?.resume()
            continuation = nil
        }
    }

    private struct SyntheticDeleteFailure: Error, Equatable {}

    nonisolated private static func summary(percent: Double = 0) -> QuotaSummary {
        let window = QuotaSummary.Window(label: "Weekly", percent: percent, resetsAt: nil)
        return QuotaSummary(
            providerFilter: .all,
            connection: .connected,
            primary: window,
            details: [window],
            planLabel: nil,
            footerLines: []
        )
    }
}
