import Foundation

/// User-entered overrides for a provider. Passive local/browser/CLI discovery
/// never gets copied here; this record exists only after an explicit Save.
struct CapacityDockProviderCredential: Codable, Equatable, Sendable {
    var sourceMode: String = ProviderReferenceSourceMode.automatic.rawValue
    var apiKey: String = ""

    var resolvedSourceMode: ProviderReferenceSourceMode {
        ProviderReferenceSourceMode(rawValue: sourceMode) ?? .automatic
    }

    var isEmpty: Bool {
        apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && resolvedSourceMode == .automatic
    }

    /// Sanitized override values that a fetch adapter can project into its own
    /// provider-specific config. The adapter owns that mapping; this record stays
    /// CodeBurn-owned and provider-scoped by Keychain account.
    var sanitizedOverride: CapacityDockProviderCredentialOverride {
        CapacityDockProviderCredentialOverride(
            sourceMode: resolvedSourceMode,
            apiKey: cleaned(apiKey)
        )
    }

    private func cleaned(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

struct CapacityDockProviderCredentialOverride: Equatable, Sendable {
    var sourceMode: ProviderReferenceSourceMode
    var apiKey: String?
}

enum CapacityDockProviderCredentialStoreError: LocalizedError, Equatable {
    case timedOut

    var errorDescription: String? {
        L("Keychain did not respond. Unlock your login keychain, then reopen this provider or re-enter its credential.")
    }
}

/// Bridges a *read* from blocking Security.framework into async UI work without
/// making the caller wait forever. Classic login-keychain IPC has no
/// cancellation API, so only idempotent reads use this timeout gate. Mutations
/// await their real completion and can therefore never report failure while a
/// late write or delete is still able to change state in the background.
private final class CredentialContinuationGate<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, Error>?

    init(_ continuation: CheckedContinuation<Value, Error>) {
        self.continuation = continuation
    }

    func resume(with result: Result<Value, Error>) {
        lock.lock()
        guard let continuation else {
            lock.unlock()
            return
        }
        self.continuation = nil
        lock.unlock()
        continuation.resume(with: result)
    }
}

enum CapacityDockProviderCredentialStore {
    static let service = "org.agentseal.codeburn.menubar.provider.v1"
    nonisolated(unsafe) static var keychainCache: any KeychainCredentialCaching = LiveKeychainCredentialCache()
    nonisolated(unsafe) static var userDefaults = UserDefaults.standard

    static func load(for providerID: String) throws -> CapacityDockProviderCredential {
        guard let data = try keychainCache.read(service: service, account: providerID) else {
            CapacityDockProviderCredentialPresence.set(false, for: providerID, defaults: userDefaults)
            return CapacityDockProviderCredential()
        }
        let credential = try JSONDecoder().decode(CapacityDockProviderCredential.self, from: data)
        CapacityDockProviderCredentialPresence.set(
            !credential.isEmpty,
            for: providerID,
            defaults: userDefaults
        )
        return credential
    }

    static func save(_ credential: CapacityDockProviderCredential, for providerID: String) throws {
        if credential.isEmpty {
            try keychainCache.delete(service: service, account: providerID)
            CapacityDockProviderCredentialPresence.set(false, for: providerID, defaults: userDefaults)
            return
        }
        let data = try JSONEncoder().encode(credential)
        try keychainCache.upsert(service: service, account: providerID, data: data)
        CapacityDockProviderCredentialPresence.set(true, for: providerID, defaults: userDefaults)
    }

    static func remove(for providerID: String) throws {
        try keychainCache.delete(service: service, account: providerID)
        CapacityDockProviderCredentialPresence.set(false, for: providerID, defaults: userDefaults)
    }

    /// Keychain IPC can wait on securityd even when authentication UI is
    /// suppressed. Keep that work off the main actor so opening Settings,
    /// changing providers, and dock connection actions remain responsive.
    static func loadAsync(
        for providerID: String,
        timeout: TimeInterval = 2.5
    ) async throws -> CapacityDockProviderCredential {
        try await performAsync(timeout: timeout) {
            try load(for: providerID)
        }
    }

    static func saveAsync(
        _ credential: CapacityDockProviderCredential,
        for providerID: String
    ) async throws {
        try await performBlocking {
            try save(credential, for: providerID)
        }
    }

    static func removeAsync(for providerID: String) async throws {
        try await performBlocking {
            try remove(for: providerID)
        }
    }

    static func performBlocking<Value: Sendable>(
        operation: @escaping @Sendable () throws -> Value
    ) async throws -> Value {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(with: Result { try operation() })
            }
        }
    }

    static func performAsync<Value: Sendable>(
        timeout: TimeInterval = 2.5,
        operation: @escaping @Sendable () throws -> Value
    ) async throws -> Value {
        try await withCheckedThrowingContinuation { continuation in
            let gate = CredentialContinuationGate(continuation)
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    gate.resume(with: .success(try operation()))
                } catch {
                    gate.resume(with: .failure(error))
                }
            }
            DispatchQueue.global(qos: .userInitiated).asyncAfter(
                deadline: .now() + max(0.05, timeout)
            ) {
                gate.resume(with: .failure(CapacityDockProviderCredentialStoreError.timedOut))
            }
        }
    }
}

/// Non-secret index used only to keep credentialed providers manageable in
/// General Settings without synchronously querying Keychain while SwiftUI
/// renders. Values are stable provider IDs; credentials remain solely in their
/// provider-scoped Keychain accounts. A successful Keychain read repairs this
/// index, and a missing item or explicit delete removes it.
enum CapacityDockProviderCredentialPresence {
    static let key = "CodeBurnCapacityDockCredentialProviderIDs"
    private static let lock = NSLock()

    static func providerIDs(defaults: UserDefaults = .standard) -> Set<String> {
        lock.lock()
        defer { lock.unlock() }
        return providerIDsWithoutLock(defaults: defaults)
    }

    private static func providerIDsWithoutLock(defaults: UserDefaults) -> Set<String> {
        let known = Set(CapacityDockPreferences.supportedProviders.map(\.id))
        return Set(defaults.stringArray(forKey: key) ?? []).intersection(known)
    }

    static func contains(_ providerID: String, defaults: UserDefaults = .standard) -> Bool {
        providerIDs(defaults: defaults).contains(providerID)
    }

    static func set(
        _ present: Bool,
        for providerID: String,
        defaults: UserDefaults = .standard
    ) {
        guard CapacityDockProvider(rawValue: providerID) != nil else { return }
        let update = {
            let ordered = lock.withLock {
                var identifiers = providerIDsWithoutLock(defaults: defaults)
                if present {
                    identifiers.insert(providerID)
                } else {
                    identifiers.remove(providerID)
                }
                return CapacityDockPreferences.supportedProviders
                    .map(\.id)
                    .filter(identifiers.contains)
            }

            // UserDefaults notifies SwiftUI synchronously. Never hold our lock
            // while doing that: SwiftUI may re-read provider presence inline.
            defaults.set(ordered, forKey: key)
            NotificationCenter.default.post(
                name: .capacityDockCredentialPresenceDidChange,
                object: nil
            )
        }
        // The lock only covers the compute above; releasing it before the
        // defaults write is what breaks the reentrancy deadlock. What keeps the
        // read-modify-write atomic across concurrent callers is that every
        // mutation runs serialized on the main queue, so this must stay a
        // synchronous hop: switching it to async reintroduces lost updates and
        // breaks read-after-write (see CredentialKeychainContinuityTests).
        if Thread.isMainThread {
            update()
        } else {
            DispatchQueue.main.sync(execute: update)
        }
    }
}

extension Notification.Name {
    static let capacityDockCredentialPresenceDidChange = Notification.Name(
        "com.codeburn.capacityDockCredentialPresenceDidChange"
    )
}
