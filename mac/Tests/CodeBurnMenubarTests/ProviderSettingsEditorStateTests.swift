import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Provider settings editor state")
struct ProviderSettingsEditorStateTests {
    @Test("switching providers replaces a draft secret with the destination provider's stored credential")
    func switchingProvidersDoesNotLeakDraftSecret() {
        var editor = ProviderSettingsEditorState.load(
            providerID: "clinepass",
            stored: CapacityDockProviderCredential(sourceMode: "api", apiKey: "synthetic-clinepass-key")
        )
        editor.credential.apiKey = "synthetic-unsaved-clinepass-key"
        editor.localError = "temporary"

        editor.applyProviderChange(
            to: "opencodego",
            stored: CapacityDockProviderCredential()
        )
        #expect(editor.providerID == "opencodego")
        #expect(editor.credential == CapacityDockProviderCredential())
        #expect(editor.savedCredential == CapacityDockProviderCredential())
        #expect(editor.localError == nil)
    }

    @Test("reloading the same provider keeps an unsaved draft")
    func sameProviderReloadKeepsDraft() {
        var editor = ProviderSettingsEditorState.load(
            providerID: "clinepass",
            stored: CapacityDockProviderCredential()
        )
        editor.credential.apiKey = "synthetic-unsaved-clinepass-key"

        editor.applyProviderChange(
            to: "clinepass",
            stored: CapacityDockProviderCredential()
        )

        #expect(editor.credential.apiKey == "synthetic-unsaved-clinepass-key")
    }

    @Test("switching onto a provider with a stored credential loads that credential")
    func destinationStoredCredentialReplacesDraft() {
        var editor = ProviderSettingsEditorState.load(
            providerID: "clinepass",
            stored: CapacityDockProviderCredential(sourceMode: "api", apiKey: "synthetic-clinepass-key")
        )
        editor.credential.apiKey = "synthetic-unsaved-clinepass-key"

        let stored = CapacityDockProviderCredential(sourceMode: "api", apiKey: "synthetic-opencodego-key")
        editor.applyProviderChange(to: "opencodego", stored: stored)

        #expect(editor.credential == stored)
        #expect(editor.savedCredential == stored)
    }

    @Test("a late Keychain result cannot populate a newly selected provider")
    func staleAsyncCredentialResultIsIgnored() {
        var editor = ProviderSettingsEditorState.load(
            providerID: "clinepass",
            stored: CapacityDockProviderCredential()
        )
        editor.beginLoading(providerID: "opencodego")

        editor.applyLoadedCredential(
            CapacityDockProviderCredential(
                sourceMode: "api",
                apiKey: "synthetic-stale-clinepass-key"
            ),
            for: "clinepass"
        )

        #expect(editor.providerID == "opencodego")
        #expect(editor.credential == CapacityDockProviderCredential())
        #expect(editor.savedCredential == CapacityDockProviderCredential())
    }

    @Test("the current provider accepts its own asynchronous Keychain result")
    func currentAsyncCredentialResultIsApplied() {
        var editor = ProviderSettingsEditorState.load(
            providerID: "",
            stored: CapacityDockProviderCredential()
        )
        editor.beginLoading(providerID: "clinepass")
        let stored = CapacityDockProviderCredential(
            sourceMode: "api",
            apiKey: "synthetic-clinepass-key"
        )

        editor.applyLoadedCredential(stored, for: "clinepass")

        #expect(editor.credential == stored)
        #expect(editor.savedCredential == stored)
    }

    @Test("a stalled Keychain operation times out without blocking the caller")
    func stalledCredentialOperationTimesOut() async {
        let semaphore = DispatchSemaphore(value: 0)
        defer { semaphore.signal() }

        do {
            let _: Int = try await CapacityDockProviderCredentialStore.performAsync(
                timeout: 0.05
            ) {
                semaphore.wait()
                return 1
            }
            Issue.record("Expected the stalled credential operation to time out")
        } catch let error as CapacityDockProviderCredentialStoreError {
            #expect(error == .timedOut)
        } catch {
            Issue.record("Unexpected timeout error: \(error)")
        }
    }

    @Test("presence writes allow a synchronous UserDefaults callback to read presence")
    func presenceWritesDoNotDeadlockSwiftUICallbacks() async throws {
        let suiteName = "CodeBurnMenubarTests.PresenceReentry.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        let defaultsBox = SendableUserDefaults(defaults)
        let callbackFinished = LockedCompletionFlag()
        let writeFinished = LockedCompletionFlag()
        let observer = NotificationCenter.default.addObserver(
            forName: UserDefaults.didChangeNotification,
            object: defaults,
            queue: nil
        ) { _ in
            _ = CapacityDockProviderCredentialPresence.contains("kimi", defaults: defaultsBox.value)
            callbackFinished.setCompleted()
        }
        defer {
            NotificationCenter.default.removeObserver(observer)
            TestDefaults.forget(suiteName)
        }

        DispatchQueue.global(qos: .userInitiated).async {
            CapacityDockProviderCredentialPresence.set(true, for: "kimi", defaults: defaultsBox.value)
            writeFinished.setCompleted()
        }
        // A deadlocked write never completes, so the bound only needs to be
        // generous enough that a loaded CI runner cannot fake one.
        for _ in 0..<500 where !writeFinished.isCompleted {
            try await Task.sleep(for: .milliseconds(10))
        }

        #expect(callbackFinished.isCompleted)
        #expect(writeFinished.isCompleted)
    }

    @Test("credential mutations await their real Keychain completion")
    func credentialMutationsDoNotTimeOutInTheBackground() async throws {
        let semaphore = DispatchSemaphore(value: 0)
        let completion = LockedCompletionFlag()
        let task = Task {
            try await CapacityDockProviderCredentialStore.performBlocking {
                semaphore.wait()
                completion.setCompleted()
                return 7
            }
        }

        try await Task.sleep(for: .milliseconds(70))
        #expect(!completion.isCompleted)
        semaphore.signal()
        #expect(try await task.value == 7)
        #expect(completion.isCompleted)
    }
}

private final class SendableUserDefaults: @unchecked Sendable {
    let value: UserDefaults
    init(_ value: UserDefaults) { self.value = value }
}

private final class LockedCompletionFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var completed = false

    var isCompleted: Bool {
        lock.withLock { completed }
    }

    func setCompleted() {
        lock.withLock { completed = true }
    }
}
