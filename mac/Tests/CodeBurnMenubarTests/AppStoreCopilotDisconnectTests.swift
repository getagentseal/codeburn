import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("AppStore Copilot explicit disconnect")
@MainActor
struct AppStoreCopilotDisconnectTests {
    @Test("explicit disconnect blocks the next refresh fetch")
    func disconnectThenRefreshDoesNotFetch() async throws {
        try await withIsolatedCopilotStore(hasCredential: true) { store, fetch, defaults in
            #expect(store.copilotLoadState == .dormant)

            store.disconnectCopilot()

            #expect(store.copilotLoadState == .notBootstrapped)
            #expect(store.copilotUsage == nil)
            #expect(CopilotExplicitDisconnect.isSet(defaults: defaults))

            let fetched = await store.refreshCopilotReportingSuccess()

            #expect(fetched == false)
            #expect(await fetch.recordedCount() == 0)
            #expect(store.copilotLoadState == .notBootstrapped)
            #expect(store.copilotUsage == nil)
        }
    }

    @Test("relaunch honors persisted Copilot opt-out")
    func relaunchRemainsDisconnected() async throws {
        try await withIsolatedCopilotStore(hasCredential: true) { store, fetch, defaults in
            store.disconnectCopilot()
            #expect(CopilotExplicitDisconnect.isSet(defaults: defaults))

            let relaunched = AppStore(copilotQuotaRuntime: CopilotQuotaRuntime(
                hasCredential: { true },
                refresh: { await fetch.next() },
                disconnectService: {},
                defaults: defaults
            ))

            #expect(relaunched.copilotLoadState == .notBootstrapped)

            let fetched = await relaunched.refreshCopilotReportingSuccess()

            #expect(fetched == false)
            #expect(await fetch.recordedCount() == 0)
            #expect(relaunched.copilotLoadState == .notBootstrapped)
            #expect(relaunched.copilotUsage == nil)
        }
    }

    @Test("explicit reconnect clears opt-out and fetches")
    func explicitReconnectResumes() async throws {
        try await withIsolatedCopilotStore(hasCredential: true) { store, fetch, defaults in
            store.disconnectCopilot()
            #expect(CopilotExplicitDisconnect.isSet(defaults: defaults))

            await store.connectCopilot()

            #expect(!CopilotExplicitDisconnect.isSet(defaults: defaults))
            #expect(await fetch.recordedCount() == 1)
            #expect(store.copilotLoadState == .loaded)
            #expect(store.copilotUsage?.plan == "Individual")
        }
    }

    @Test("first-use with credentials still auto-discovers")
    func firstUseAutodiscoveryFetches() async throws {
        try await withIsolatedCopilotStore(hasCredential: true) { store, fetch, defaults in
            #expect(!CopilotExplicitDisconnect.isSet(defaults: defaults))
            #expect(store.copilotLoadState == .dormant)

            let fetched = await store.refreshCopilotReportingSuccess()

            #expect(fetched == true)
            #expect(await fetch.recordedCount() == 1)
            #expect(store.copilotLoadState == .loaded)
            #expect(!CopilotExplicitDisconnect.isSet(defaults: defaults))
        }
    }

    @Test("first-use without credentials does not fetch")
    func firstUseWithoutCredentialsStaysIdle() async throws {
        try await withIsolatedCopilotStore(hasCredential: false) { store, fetch, defaults in
            #expect(store.copilotLoadState == .notBootstrapped)
            #expect(!CopilotExplicitDisconnect.isSet(defaults: defaults))

            let fetched = await store.refreshCopilotReportingSuccess()

            #expect(fetched == false)
            #expect(await fetch.recordedCount() == 0)
            #expect(store.copilotLoadState == .notBootstrapped)
        }
    }

    @Test("disconnect discards an in-flight Copilot fetch")
    func inFlightFetchCannotResurrectAfterDisconnect() async throws {
        try await withIsolatedCopilotStore(hasCredential: true) { store, fetch, defaults in
            await fetch.setParkNext(true)
            let refresh = Task { await store.refreshCopilotReportingSuccess() }
            try #require(await fetch.waitUntilParked())

            store.disconnectCopilot()
            await fetch.open()
            let fetched = await refresh.value

            #expect(fetched == false)
            #expect(store.copilotLoadState == .notBootstrapped)
            #expect(store.copilotUsage == nil)
            #expect(CopilotExplicitDisconnect.isSet(defaults: defaults))
        }
    }

    @Test("automatic bootstrap does not clear persisted opt-out")
    func automaticBootstrapLeavesOptOut() async throws {
        try await withIsolatedCopilotStore(hasCredential: true) { store, fetch, defaults in
            store.disconnectCopilot()
            await store.bootstrapCopilot()

            #expect(CopilotExplicitDisconnect.isSet(defaults: defaults))
            #expect(await fetch.recordedCount() == 0)
            #expect(store.copilotLoadState == .notBootstrapped)
        }
    }

    @Test("disconnect wins over an in-flight explicit connect")
    func disconnectWinsOverPendingConnect() async throws {
        try await withIsolatedCopilotStore(hasCredential: true) { store, fetch, defaults in
            store.disconnectCopilot()
            await fetch.setParkNext(true)
            let connect = Task { await store.connectCopilot() }
            try #require(await fetch.waitUntilParked())

            store.disconnectCopilot()
            await fetch.open()
            await connect.value

            #expect(CopilotExplicitDisconnect.isSet(defaults: defaults))
            #expect(store.copilotLoadState == .notBootstrapped)
            #expect(store.copilotUsage == nil)
        }
    }
}

@MainActor
private func withIsolatedCopilotStore(
    hasCredential: Bool,
    _ body: @MainActor (AppStore, CopilotFetchStub, UserDefaults) async throws -> Void
) async throws {
    let suiteName = "codeburn.copilot.disconnect.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suiteName))
    defaults.removePersistentDomain(forName: suiteName)
    defer { defaults.removePersistentDomain(forName: suiteName) }

    let fetch = CopilotFetchStub()
    let store = AppStore(copilotQuotaRuntime: CopilotQuotaRuntime(
        hasCredential: { hasCredential },
        refresh: { await fetch.next() },
        disconnectService: {},
        defaults: defaults
    ))
    try await body(store, fetch, defaults)
}

private actor CopilotFetchStub {
    private(set) var count = 0
    private var parkNext = false
    private var parked: CheckedContinuation<Void, Never>?
    private var isParked = false

    func recordedCount() -> Int { count }

    func setParkNext(_ value: Bool) {
        parkNext = value
    }

    func next() async -> CopilotUsage {
        count += 1
        if parkNext {
            parkNext = false
            isParked = true
            await withCheckedContinuation { parked = $0 }
        }
        return CopilotUsage(
            details: [
                CopilotUsage.Window(label: "Premium requests", usedPercent: 30, resetsAt: nil)
            ],
            plan: "Individual",
            fetchedAt: Date(timeIntervalSince1970: 1_786_000_000)
        )
    }

    func waitUntilParked() async -> Bool {
        let deadline = ContinuousClock.now + .seconds(2)
        while !isParked {
            if ContinuousClock.now >= deadline { return false }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return true
    }

    func open() {
        parked?.resume()
        parked = nil
        isParked = false
    }
}
