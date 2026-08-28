import ServiceManagement

enum LoginItemMigrationState: String, Equatable {
    case registered
    case disabled
    case notRegistered = "not-registered"
    case unknown
}

enum LoginItemRegistrationPolicy {
    static func shouldRegister(
        status: SMAppService.Status,
        wasPreviouslyRegistered: Bool
    ) -> Bool {
        switch status {
        case .enabled, .requiresApproval:
            return false
        case .notRegistered, .notFound:
            // Once registration has succeeded, .notRegistered represents the
            // user's later choice in System Settings. Never fight that choice.
            return !wasPreviouslyRegistered
        @unknown default:
            return false
        }
    }

    static func migrationState(
        status: SMAppService.Status,
        wasPreviouslyRegistered: Bool
    ) -> LoginItemMigrationState {
        switch status {
        case .enabled:
            return .registered
        case .requiresApproval:
            // Apple uses requiresApproval both while first approval is pending
            // and after previously-granted consent is revoked. Released builds
            // wrote the registration marker before approval, so the legacy
            // marker plus no enabled observation is irreducibly ambiguous.
            // Fail closed: never re-register a replacement identity if that
            // could override the user's explicit System Settings choice.
            return .disabled
        case .notRegistered, .notFound:
            return wasPreviouslyRegistered ? .disabled : .notRegistered
        @unknown default:
            return .unknown
        }
    }

    static func shouldRecordRegistration(
        status: SMAppService.Status,
        wasPreviouslyRegistered: Bool
    ) -> Bool {
        status == .enabled || wasPreviouslyRegistered
    }

}
