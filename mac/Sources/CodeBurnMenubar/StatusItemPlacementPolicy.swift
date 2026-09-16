import AppKit

/// Conservative policy for the Tahoe status-item parking failure in #1148.
///
/// A narrow geometry match matters: menu bar items can legitimately be short
/// or near a display edge. The poisoned state reported in #1148 combines all
/// three signals — legacy 22pt height, flush with the display's right edge,
/// and parked in the top menu-bar band.
enum StatusItemPlacementPolicy {
    static let autosaveName: NSStatusItem.AutosaveName = "CodeBurnMenubar.MainStatusItem"

    static func isParked(
        itemFrame: CGRect,
        screenFrame: CGRect,
        statusBarThickness: CGFloat
    ) -> Bool {
        guard !itemFrame.isEmpty,
              !screenFrame.isEmpty,
              statusBarThickness > 0 else { return false }

        let geometryTolerance: CGFloat = 1
        let legacyHeight = itemFrame.height + geometryTolerance < statusBarThickness
        let flushWithRightEdge = abs(itemFrame.maxX - screenFrame.maxX) <= geometryTolerance
        let inTopBand = itemFrame.maxY >= screenFrame.maxY - max(statusBarThickness, itemFrame.height)
        return legacyHeight && flushWithRightEdge && inTopBand
    }

    static func isMenuBarRevealLocation(
        _ location: CGPoint,
        screenFrame: CGRect,
        activationBand: CGFloat = 4,
        edgeOvershoot: CGFloat = 2
    ) -> Bool {
        guard activationBand > 0,
              edgeOvershoot >= 0,
              location.x >= screenFrame.minX,
              location.x <= screenFrame.maxX else { return false }
        return location.y >= screenFrame.maxY - activationBand
            && location.y <= screenFrame.maxY + edgeOvershoot
    }

    /// An auto-hidden bar overlays the screen, so it never shrinks the visible
    /// frame; a persistent bar always does.
    static func menuBarAutoHides(screenFrame: CGRect, screenVisibleFrame: CGRect) -> Bool {
        let geometryTolerance: CGFloat = 1
        return screenVisibleFrame.maxY >= screenFrame.maxY - geometryTolerance
    }

    static func isMenuBarRevealed(
        pointer: CGPoint,
        screenFrame: CGRect,
        screenVisibleFrame: CGRect
    ) -> Bool {
        if !menuBarAutoHides(screenFrame: screenFrame, screenVisibleFrame: screenVisibleFrame) {
            return true
        }
        return isMenuBarRevealLocation(pointer, screenFrame: screenFrame)
    }
}

enum StatusItemPlacementRecoveryGeometry: Equatable {
    case unrealized
    case healthy
    case parked
}

enum StatusItemPlacementRecoveryAction: Equatable {
    case stopHealthy
    case poll
    case waitForReveal
    case settleBeforePulse
    case pulse(Int)
    case stopExhausted
}

/// Pure state machine for the AppKit recovery loop. A reveal is consumed only
/// when a pulse is actually issued; realization lag must not waste the user's
/// one reveal gesture. After a failed pulse on an auto-hidden bar, a hide
/// followed by a distinct reveal is required before another attempt. A
/// persistent menu bar never hides, so that gate would strand the retries.
struct StatusItemPlacementRecoveryCoordinator {
    private(set) var pulseCount = 0
    private var requiresHideBeforeNextPulse = false
    let maximumPulseCount: Int

    init(maximumPulseCount: Int = 3) {
        self.maximumPulseCount = maximumPulseCount
    }

    mutating func action(
        for geometry: StatusItemPlacementRecoveryGeometry,
        isMenuBarRevealed: Bool,
        revealHasSettled: Bool,
        menuBarAutoHides: Bool = true
    ) -> StatusItemPlacementRecoveryAction {
        if geometry == .healthy {
            return .stopHealthy
        }
        guard geometry != .unrealized else {
            return .poll
        }
        guard pulseCount < maximumPulseCount else {
            return .stopExhausted
        }

        if requiresHideBeforeNextPulse {
            if !isMenuBarRevealed {
                requiresHideBeforeNextPulse = false
            }
            return .waitForReveal
        }
        guard isMenuBarRevealed else {
            return .waitForReveal
        }
        guard revealHasSettled else {
            return .settleBeforePulse
        }

        pulseCount += 1
        requiresHideBeforeNextPulse = menuBarAutoHides
        return .pulse(pulseCount)
    }
}

@MainActor
enum StatusItemVisibilityPulse {
    static func run(
        setVisible: (Bool) -> Void,
        sleep: (Duration) async throws -> Void = { duration in
            try await Task.sleep(for: duration)
        }
    ) async {
        setVisible(false)
        // A cancelled sleep throws immediately. Visibility is restored before
        // the caller observes cancellation or returns.
        try? await sleep(.milliseconds(50))
        setVisible(true)
    }
}
