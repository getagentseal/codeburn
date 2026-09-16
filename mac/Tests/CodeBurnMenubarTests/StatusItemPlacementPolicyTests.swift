import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Status item placement policy")
struct StatusItemPlacementPolicyTests {
    private let screen = CGRect(x: 0, y: 0, width: 1_440, height: 900)

    @Test("recognizes the Tahoe parked frame reported in issue 1148")
    func recognizesParkedFrame() {
        let parked = CGRect(x: 1_418, y: 878, width: 22, height: 22)

        #expect(StatusItemPlacementPolicy.isParked(
            itemFrame: parked,
            screenFrame: screen,
            statusBarThickness: 30
        ))
    }

    @Test("does not disturb a healthy rightmost item")
    func preservesHealthyRightmostItem() {
        let healthy = CGRect(x: 1_410, y: 870, width: 30, height: 30)

        #expect(!StatusItemPlacementPolicy.isParked(
            itemFrame: healthy,
            screenFrame: screen,
            statusBarThickness: 30
        ))
    }

    @Test("does not mistake a short item away from the corner for parked")
    func preservesShortPlacedItem() {
        let placed = CGRect(x: 900, y: 878, width: 22, height: 22)

        #expect(!StatusItemPlacementPolicy.isParked(
            itemFrame: placed,
            screenFrame: screen,
            statusBarThickness: 30
        ))
    }

    @Test("waits for the pointer to reveal an auto-hidden menu bar")
    func recognizesRevealGesture() {
        #expect(StatusItemPlacementPolicy.isMenuBarRevealLocation(
            CGPoint(x: 720, y: 899),
            screenFrame: screen
        ))
        #expect(StatusItemPlacementPolicy.isMenuBarRevealLocation(
            CGPoint(x: 720, y: 900),
            screenFrame: screen
        ))
        #expect(StatusItemPlacementPolicy.isMenuBarRevealLocation(
            CGPoint(x: 720, y: 902),
            screenFrame: screen
        ))
        #expect(!StatusItemPlacementPolicy.isMenuBarRevealLocation(
            CGPoint(x: 720, y: 880),
            screenFrame: screen
        ))
        #expect(!StatusItemPlacementPolicy.isMenuBarRevealLocation(
            CGPoint(x: 1_500, y: 900),
            screenFrame: screen
        ))
    }

    @Test("uses pointer location for an auto-hidden menu bar")
    func autoHiddenRevealSignal() {
        #expect(!StatusItemPlacementPolicy.isMenuBarRevealed(
            pointer: CGPoint(x: 720, y: 500),
            screenFrame: screen,
            screenVisibleFrame: screen
        ))
        #expect(StatusItemPlacementPolicy.isMenuBarRevealed(
            pointer: CGPoint(x: 720, y: 900),
            screenFrame: screen,
            screenVisibleFrame: screen
        ))
    }

    @Test("recognizes a menu bar that occupies the visible frame")
    func alwaysVisibleMenuBarSignal() {
        let visibleFrame = CGRect(x: 0, y: 0, width: 1_440, height: 870)
        #expect(StatusItemPlacementPolicy.isMenuBarRevealed(
            pointer: CGPoint(x: 720, y: 500),
            screenFrame: screen,
            screenVisibleFrame: visibleFrame
        ))
    }

    @Test("realization lag does not consume the reveal")
    func realizationLagPreservesReveal() {
        var recovery = StatusItemPlacementRecoveryCoordinator()
        #expect(recovery.action(for: .parked, isMenuBarRevealed: true, revealHasSettled: false) == .settleBeforePulse)
        #expect(recovery.action(for: .unrealized, isMenuBarRevealed: false, revealHasSettled: true) == .poll)
        #expect(recovery.pulseCount == 0)
        #expect(recovery.action(for: .parked, isMenuBarRevealed: true, revealHasSettled: false) == .settleBeforePulse)
        #expect(recovery.action(for: .parked, isMenuBarRevealed: true, revealHasSettled: true) == .pulse(1))
    }

    @Test("requires a hide and distinct reveal after an actual pulse")
    func retryRequiresDistinctReveal() {
        var recovery = StatusItemPlacementRecoveryCoordinator()
        #expect(recovery.action(for: .parked, isMenuBarRevealed: true, revealHasSettled: true) == .pulse(1))
        #expect(recovery.action(for: .parked, isMenuBarRevealed: true, revealHasSettled: false) == .waitForReveal)
        #expect(recovery.action(for: .parked, isMenuBarRevealed: false, revealHasSettled: false) == .waitForReveal)
        #expect(recovery.action(for: .parked, isMenuBarRevealed: true, revealHasSettled: false) == .settleBeforePulse)
        #expect(recovery.action(for: .parked, isMenuBarRevealed: true, revealHasSettled: true) == .pulse(2))
    }

    @Test("never emits more than three pulses")
    func boundsPulseCount() {
        var recovery = StatusItemPlacementRecoveryCoordinator(maximumPulseCount: 3)
        for attempt in 1...3 {
            #expect(recovery.action(for: .parked, isMenuBarRevealed: true, revealHasSettled: true) == .pulse(attempt))
            _ = recovery.action(for: .parked, isMenuBarRevealed: false, revealHasSettled: false)
        }
        #expect(recovery.action(for: .parked, isMenuBarRevealed: true, revealHasSettled: true) == .stopExhausted)
        #expect(recovery.pulseCount == 3)
    }

    @Test("restores visibility when the pulse sleep is cancelled")
    @MainActor
    func cancellationRestoresVisibility() async {
        var visibleStates: [Bool] = []
        await StatusItemVisibilityPulse.run(
            setVisible: { visibleStates.append($0) },
            sleep: { _ in throw CancellationError() }
        )
        #expect(visibleStates == [false, true])
    }

    @Test("a persistent menu bar does not strand the remaining pulses")
    func persistentMenuBarKeepsRetrying() {
        var recovery = StatusItemPlacementRecoveryCoordinator()
        for attempt in 1...3 {
            #expect(recovery.action(
                for: .parked,
                isMenuBarRevealed: true,
                revealHasSettled: true,
                menuBarAutoHides: false
            ) == .pulse(attempt))
        }
        #expect(recovery.action(
            for: .parked,
            isMenuBarRevealed: true,
            revealHasSettled: true,
            menuBarAutoHides: false
        ) == .stopExhausted)
    }

    @Test("classifies the menu bar by whether it shrinks the visible frame")
    func detectsAutoHiddenMenuBar() {
        #expect(StatusItemPlacementPolicy.menuBarAutoHides(
            screenFrame: screen,
            screenVisibleFrame: screen
        ))
        #expect(!StatusItemPlacementPolicy.menuBarAutoHides(
            screenFrame: screen,
            screenVisibleFrame: CGRect(x: 0, y: 0, width: 1_440, height: 870)
        ))
    }

    @Test("keeps a stable autosave identity across launches")
    func stableAutosaveIdentity() {
        #expect(StatusItemPlacementPolicy.autosaveName == "CodeBurnMenubar.MainStatusItem")
    }
}
