import Foundation
import Testing
@testable import CodeBurnMenubar

private actor ProfileRequests {
    var quota: [String] = []
    var today: [String] = []
    var explicit: [Bool] = []
    var parked: CheckedContinuation<Void, Never>?
    func fetch(_ id: String, explicit value: Bool, pause: Bool = false) async {
        quota.append(id)
        explicit.append(value)
        if pause { await withCheckedContinuation { parked = $0 } }
    }
    func readToday(_ id: String) { today.append(id) }
    func release() { parked?.resume(); parked = nil }
    var waiting: Bool { parked != nil }
}

private func profilePayload(_ id: String?) -> MenubarPayload {
    let empty = MenubarPayload.empty
    return MenubarPayload(generated: "fixture", current: empty.current,
        optimize: empty.optimize, history: empty.history, combined: nil,
        claudeConfigs: ClaudeConfigSelector(selectedId: id, options: []))
}

@Suite("Claude profile refresh", .serialized)
@MainActor
struct ClaudeProfileRefreshTests {
    private func makeStore(_ requests: ProfileRequests) -> AppStore {
        let store = AppStore()
        store.claudeProfilesMode = { .separate }
        store.claudeProfilesDiscoverer = {
            [CapacityDockClaudeProfile(id: "first", label: "Work", path: "/fixture/work"),
             CapacityDockClaudeProfile(id: "second", label: "Other", path: "/fixture/other")]
        }
        store.claudeProfileQuotaFetcher = { profile, explicit in
            await requests.fetch(profile.id, explicit: explicit)
            return nil
        }
        store.claudeProfileTodayFetcher = { id in
            await requests.readToday(id)
            return profilePayload(id)
        }
        return store
    }

    private func waitUntilParked(_ requests: ProfileRequests) async -> Bool {
        for _ in 0..<1_000 {
            if await requests.waiting { return true }
            await Task.yield()
        }
        return false
    }

    @Test("Combined discovers identities without API calls or per-profile CLI parses")
    func combinedDoesNoExtraWork() async {
        let requests = ProfileRequests()
        let store = makeStore(requests)
        store.claudeProfilesMode = { .combined }
        #expect(await store.refreshClaudeProfiles())
        #expect(store.capacityDockClaudeProfiles.count == 2)
        #expect(await requests.quota.isEmpty)
        #expect(await requests.today.isEmpty)
    }

    @Test("Separate reads each source once and only explicit actions permit Keychain access")
    func separateReadsOwnSources() async {
        let requests = ProfileRequests()
        let store = makeStore(requests)
        #expect(await store.refreshClaudeProfiles(userInitiated: true))
        #expect(await requests.quota == ["first", "second"])
        #expect(await requests.today == ["first", "second"])
        #expect(await requests.explicit == [true, true])
        #expect(Set(store.claudeProfileTodayPayloads.keys) == Set(["first", "second"]))
    }

    @Test("overlapping refreshes share one profile batch")
    func concurrentRefreshIsSingleFlight() async {
        let requests = ProfileRequests()
        let store = makeStore(requests)
        store.claudeProfileQuotaFetcher = { profile, explicit in
            await requests.fetch(profile.id, explicit: explicit, pause: profile.id == "first")
            return nil
        }
        let first = Task { await store.refreshClaudeProfiles() }
        #expect(await waitUntilParked(requests))
        let second = Task { await store.refreshClaudeProfiles() }
        for _ in 0..<20 { await Task.yield() }
        await requests.release()
        #expect(await first.value)
        #expect(await second.value)
        #expect(await requests.quota == ["first", "second"])
        #expect(await requests.explicit == [false, false])
    }

    @Test("switching to Combined discards an in-flight profile response")
    func modeChangeDropsLateResponse() async {
        let requests = ProfileRequests()
        let store = makeStore(requests)
        store.claudeProfileQuotaFetcher = { profile, explicit in
            await requests.fetch(profile.id, explicit: explicit, pause: true)
            return nil
        }
        let task = Task { await store.refreshClaudeProfiles() }
        #expect(await waitUntilParked(requests))
        store.claudeProfilesMode = { .combined }
        await requests.release()
        #expect(await task.value == false)
        #expect(store.claudeProfileLoadStates.isEmpty)
        #expect(await requests.today.isEmpty)
    }

    @Test("401 on a secondary login makes the shared Claude cadence report failure")
    func authenticationFailureReachesSharedBackoff() async throws {
        let requests = ProfileRequests()
        let store = makeStore(requests)
        let usage = try ClaudeSubscriptionService.parseUsage(
            Data(#"{"five_hour":{"utilization":20}}"#.utf8), rawTier: nil)
        store.claudeQuotaBootstrapChecker = { true }
        store.claudeQuotaFetcher = { usage }
        store.claudeProfileQuotaFetcher = { profile, explicit in
            await requests.fetch(profile.id, explicit: explicit)
            throw ClaudeSubscriptionService.FetchError.credential(.sourceTokenStale)
        }
        #expect(await store.refreshSubscriptionReportingSuccess() == false)
        #expect(store.subscription == usage)
        #expect(await requests.quota == ["first"])
        #expect(await requests.today.isEmpty)
        if case .transientFailure? = store.claudeProfileLoadStates["first"] {
            // The rejected login is visible while the caller backs off.
        } else {
            #expect(false, "Expected a transient credential failure")
        }
    }

    @Test("Today rejects whole-machine payloads from a CLI that ignores a source filter")
    func unknownSourceCannotShowWholeMachineToday() async {
        let requests = ProfileRequests()
        let store = makeStore(requests)
        store.claudeProfileTodayPayloads["first"] = MenubarPayload.empty.current
        store.claudeProfileTodayFetcher = { _ in profilePayload(nil) }
        #expect(await store.refreshClaudeProfiles() == false)
        #expect(store.claudeProfileTodayPayloads.isEmpty)
    }
}
