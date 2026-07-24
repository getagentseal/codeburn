import AppKit
import XCTest
@testable import CodeBurnMenubar

/// Locks the right-click menu policy that fixed flash + scroll-jump (#802).
/// Does not drive a real NSStatusItem — that needs manual/AppKit integration.
final class StatusItemContextMenuPolicyTests: XCTestCase {
    func testPresentEventMaskIsRightMouseUpNotDown() {
        // Presenting on mouse-down lets the matching up dismiss the menu (flash).
        XCTAssertEqual(
            StatusItemContextMenuPolicy.presentEventMask,
            NSEvent.EventTypeMask.rightMouseUp
        )
        XCTAssertNotEqual(
            StatusItemContextMenuPolicy.presentEventMask,
            NSEvent.EventTypeMask.rightMouseDown
        )
        // Mask must include up and must not include down (single-bit masks here).
        XCTAssertTrue(StatusItemContextMenuPolicy.presentEventMask.contains(.rightMouseUp))
        XCTAssertFalse(StatusItemContextMenuPolicy.presentEventMask.contains(.rightMouseDown))
    }

    func testPresentationUsesStatusItemMenuNotManualPopUp() {
        // Manual popUp tracks against a point while the cursor sits on the status
        // item above the menu → scroll chevron / Today-row jump on mouse move.
        XCTAssertEqual(
            StatusItemContextMenuPolicy.presentation,
            .statusItemMenu
        )
        XCTAssertNotEqual(
            StatusItemContextMenuPolicy.presentation,
            .manualPopUp
        )
    }

    func testDebounceAcceptsFirstPresent() {
        var last = Date.distantPast
        let now = Date(timeIntervalSince1970: 1_000)
        XCTAssertTrue(
            StatusItemContextMenuPolicy.acceptPresent(now: now, lastPresentedAt: &last)
        )
        XCTAssertEqual(last, now)
    }

    func testDebounceRejectsWithinWindow() {
        let t0 = Date(timeIntervalSince1970: 1_000)
        var last = t0
        // Just inside the 0.3s window
        let t1 = t0.addingTimeInterval(0.299)
        XCTAssertFalse(
            StatusItemContextMenuPolicy.acceptPresent(now: t1, lastPresentedAt: &last)
        )
        XCTAssertEqual(last, t0, "reject must not advance lastPresentedAt")
    }

    func testDebounceAcceptsAfterWindow() {
        let t0 = Date(timeIntervalSince1970: 1_000)
        var last = t0
        let t1 = t0.addingTimeInterval(StatusItemContextMenuPolicy.presentDebounceSeconds + 0.001)
        XCTAssertTrue(
            StatusItemContextMenuPolicy.acceptPresent(now: t1, lastPresentedAt: &last)
        )
        XCTAssertEqual(last, t1)
    }

    func testDebounceBoundaryIsStrictlyGreaterThan() {
        // Gate uses `>` not `>=`: exactly debounce seconds later is still rejected.
        let t0 = Date(timeIntervalSince1970: 1_000)
        var last = t0
        let exact = t0.addingTimeInterval(StatusItemContextMenuPolicy.presentDebounceSeconds)
        XCTAssertFalse(
            StatusItemContextMenuPolicy.acceptPresent(now: exact, lastPresentedAt: &last)
        )
        XCTAssertEqual(last, t0)
    }

    func testCustomDebounceOverride() {
        var last = Date(timeIntervalSince1970: 0)
        let now = Date(timeIntervalSince1970: 0.5)
        XCTAssertFalse(
            StatusItemContextMenuPolicy.acceptPresent(now: now, lastPresentedAt: &last, debounce: 1.0)
        )
        XCTAssertTrue(
            StatusItemContextMenuPolicy.acceptPresent(now: now, lastPresentedAt: &last, debounce: 0.4)
        )
    }
}
