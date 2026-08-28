import ServiceManagement
import Testing
@testable import CodeBurnMenubar

@Suite("Login item registration policy")
struct LoginItemRegistrationPolicyTests {
    @Test("registers once without overriding a later user disable")
    func respectsStatusAndRegistrationHistory() {
        #expect(!LoginItemRegistrationPolicy.shouldRegister(status: .enabled, wasPreviouslyRegistered: false))
        #expect(!LoginItemRegistrationPolicy.shouldRegister(status: .requiresApproval, wasPreviouslyRegistered: false))
        #expect(LoginItemRegistrationPolicy.shouldRegister(status: .notRegistered, wasPreviouslyRegistered: false))
        #expect(LoginItemRegistrationPolicy.shouldRegister(status: .notFound, wasPreviouslyRegistered: false))
        #expect(!LoginItemRegistrationPolicy.shouldRegister(status: .notRegistered, wasPreviouslyRegistered: true))
        #expect(!LoginItemRegistrationPolicy.shouldRegister(status: .notFound, wasPreviouslyRegistered: true))
    }

    @Test("classifies revoked approval as disabled during identity migration")
    func migrationStatePreservesConsent() {
        #expect(LoginItemRegistrationPolicy.migrationState(
            status: .enabled,
            wasPreviouslyRegistered: true
        ) == .registered)
        #expect(LoginItemRegistrationPolicy.migrationState(
            status: .requiresApproval,
            wasPreviouslyRegistered: true
        ) == .disabled)
        #expect(LoginItemRegistrationPolicy.migrationState(
            status: .requiresApproval,
            wasPreviouslyRegistered: false
        ) == .disabled)
        #expect(LoginItemRegistrationPolicy.migrationState(
            status: .notRegistered,
            wasPreviouslyRegistered: true
        ) == .disabled)
        #expect(LoginItemRegistrationPolicy.migrationState(
            status: .notRegistered,
            wasPreviouslyRegistered: false
        ) == .notRegistered)
        #expect(LoginItemRegistrationPolicy.shouldRecordRegistration(
            status: .enabled,
            wasPreviouslyRegistered: false
        ))
        #expect(!LoginItemRegistrationPolicy.shouldRecordRegistration(
            status: .requiresApproval,
            wasPreviouslyRegistered: false
        ))
        #expect(LoginItemRegistrationPolicy.shouldRecordRegistration(
            status: .requiresApproval,
            wasPreviouslyRegistered: true
        ))
    }
}
