import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Quota refresh decision")
struct QuotaRefreshDecisionTests {
    private let now = Date(timeIntervalSince1970: 1_000_000)

    @Test("skipped unchanged payload still asks for quota")
    func skippedPayloadStillRefreshesQuota() {
        #expect(QuotaRefreshDecision.needsQuotaOnlyTick(
            payloadRefreshDue: true,
            payloadSkippedUnchanged: true
        ))
    }

    @Test("payload that actually ran carries its own quota half")
    func ranPayloadDoesNotDoubleRefresh() {
        #expect(!QuotaRefreshDecision.needsQuotaOnlyTick(
            payloadRefreshDue: true,
            payloadSkippedUnchanged: false
        ))
    }

    @Test("tick with no payload work due asks for nothing")
    func idleTickAsksForNothing() {
        #expect(!QuotaRefreshDecision.needsQuotaOnlyTick(
            payloadRefreshDue: false,
            payloadSkippedUnchanged: false
        ))
    }

    @Test("cadence not elapsed means no fetch")
    func cadenceNotElapsedIsNotDue() {
        #expect(!QuotaRefreshDecision.isDue(
            force: false,
            autoRefreshAllowed: true,
            lastAttemptAt: now.addingTimeInterval(-299),
            now: now,
            threshold: 300
        ))
    }

    @Test("cadence elapsed means fetch")
    func cadenceElapsedIsDue() {
        #expect(QuotaRefreshDecision.isDue(
            force: false,
            autoRefreshAllowed: true,
            lastAttemptAt: now.addingTimeInterval(-300),
            now: now,
            threshold: 300
        ))
    }

    @Test("never fetched is due")
    func neverFetchedIsDue() {
        #expect(QuotaRefreshDecision.isDue(
            force: false,
            autoRefreshAllowed: true,
            lastAttemptAt: nil,
            now: now,
            threshold: 300
        ))
    }

    @Test("manual cadence never auto fetches")
    func manualNeverAutoFetches() {
        #expect(!QuotaRefreshDecision.isDue(
            force: false,
            autoRefreshAllowed: false,
            lastAttemptAt: nil,
            now: now,
            threshold: 300
        ))
    }

    @Test("force ignores cadence and manual mode")
    func forceIgnoresCadence() {
        #expect(QuotaRefreshDecision.isDue(
            force: true,
            autoRefreshAllowed: false,
            lastAttemptAt: now,
            now: now,
            threshold: 300
        ))
    }
}
