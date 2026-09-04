import Foundation

/// Marks the refresh as an explicit user action without granting hidden access
/// to browser cookies, another app's Keychain items, or copied provider code.
@MainActor
enum CapacityDockProviderRefreshInteraction {
    static func userInitiated<T>(
        operation: () async throws -> T
    ) async rethrows -> T {
        try await operation()
    }
}

/// CodeBurn-owned registry for Capacity Dock providers that are not served by
/// AppStore's six native quota paths. A provider is connectable only when an
/// adapter is explicitly registered here.
@MainActor
final class CapacityDockProviderQuotaService {
    struct Dependencies: Sendable {
        // No defaults here: only `.live` may reach the real adapters, so a
        // test can never silently read the local Cursor session or hit the
        // network by omitting a field.
        var refreshClinePass: @Sendable (String) async throws -> QuotaSummary
        var refreshCursor: @Sendable () async throws -> QuotaSummary
        var refreshGrok: @Sendable () async throws -> QuotaSummary
        var refreshZai: @Sendable (String?) async throws -> QuotaSummary

        static let live = Dependencies(
            refreshClinePass: { apiKey in
                try await ClinePassSubscriptionService.refresh(apiKey: apiKey)
            },
            refreshCursor: {
                try await CursorSubscriptionService.refresh()
            },
            refreshGrok: {
                try await GrokBuildSubscriptionService.refresh()
            },
            refreshZai: { apiKey in
                try await ZaiSubscriptionService.refresh(apiKey: apiKey)
            }
        )
    }

    static let shared = CapacityDockProviderQuotaService(dependencies: .live)

    private let dependencies: Dependencies

    init(dependencies: Dependencies) {
        self.dependencies = dependencies
    }

    func fetch(
        provider: CapacityDockProvider,
        credential: CapacityDockProviderCredential
    ) async throws -> QuotaSummary {
        switch provider.id {
        case "cursor":
            do {
                return try await dependencies.refreshCursor()
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                throw CapacityDockProviderFetchFailure(error: error)
            }
        case "grok":
            do {
                return try await dependencies.refreshGrok()
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                throw CapacityDockProviderFetchFailure(error: error)
            }
        case "clinepass":
            guard let apiKey = credential.sanitizedOverride.apiKey else {
                throw CapacityDockProviderFetchFailure(
                    message: ClinePassSubscriptionService.FetchError.noCredentials.localizedDescription,
                    disposition: .terminal
                )
            }
            do {
                return try await dependencies.refreshClinePass(apiKey)
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                throw CapacityDockProviderFetchFailure(error: error)
            }
        case "zai":
            do {
                return try await dependencies.refreshZai(credential.sanitizedOverride.apiKey)
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                throw CapacityDockProviderFetchFailure(error: error)
            }
        default:
            throw CapacityDockProviderFetchFailure(
                message: L("\(provider.displayName) does not have a CodeBurn live quota adapter yet. Remove it from the dock or choose a supported provider."),
                disposition: .terminal
            )
        }
    }
}

enum CapacityDockProviderFetchFailureDisposition: Equatable, Sendable {
    case terminal
    case transient
}

/// The only failure distinction the dock needs: user-actionable connection
/// failures versus failures that should preserve last-known quota and retry.
struct CapacityDockProviderFetchFailure: LocalizedError, Equatable, Sendable {
    let message: String
    let disposition: CapacityDockProviderFetchFailureDisposition

    init(message: String, disposition: CapacityDockProviderFetchFailureDisposition) {
        self.message = message
        self.disposition = disposition
    }

    init(error: Error) {
        message = error.localizedDescription
        disposition = Self.disposition(for: error)
    }

    var errorDescription: String? { message }

    static func disposition(for error: Error) -> CapacityDockProviderFetchFailureDisposition {
        if let failure = error as? CapacityDockProviderFetchFailure {
            return failure.disposition
        }
        if let error = error as? ClinePassSubscriptionService.FetchError {
            switch error.classification {
            case .terminalAuth:
                return .terminal
            case .transient, .parseFailure:
                return .transient
            }
        }
        if let error = error as? CursorSubscriptionService.FetchError {
            switch error.classification {
            case .terminalAuth:
                return .terminal
            case .transient, .parseFailure:
                return .transient
            }
        }
        if let error = error as? GrokBuildSubscriptionService.FetchError {
            switch error.classification {
            case .terminalAuth:
                return .terminal
            case .transient, .parseFailure:
                return .transient
            }
        }
        if let error = error as? ZaiSubscriptionService.FetchError {
            switch error.classification {
            case .terminalAuth:
                return .terminal
            case .transient, .parseFailure:
                return .transient
            }
        }
        if error is URLError {
            return .transient
        }
        // Unknown adapter failures are treated as temporary. They must never
        // erase a valid last-known connection merely because classification is
        // incomplete.
        return .transient
    }
}
