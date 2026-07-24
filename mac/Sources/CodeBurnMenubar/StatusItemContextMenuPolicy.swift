import AppKit
import Foundation

/// Pure policy for the status-item right-click menu (#802).
///
/// Keeps the event-mask, debounce, and presentation choices out of AppDelegate
/// so they can be unit-tested without spinning up an NSStatusItem. The bugs this
/// encodes:
///
/// 1. **Flash** — presenting on `rightMouseDown` lets the matching `rightMouseUp`
///    dismiss the menu immediately. Monitor (and legacy action) use mouse-*up*.
/// 2. **Jump/scroll** — manual `NSMenu.popUp(at:in:)` tracks poorly while the
///    cursor still sits on the status item above the menu. Attach via
///    `statusItem.menu` + `performClick` instead.
/// 3. **Double-present** — on macOS ≤26 both the button action and the global
///    monitor can fire for one click; debounce collapses them.
enum StatusItemContextMenuPolicy {
    /// Global-monitor / action event. Must be mouse-up (see flash note above).
    static let presentEventMask: NSEvent.EventTypeMask = .rightMouseUp

    /// Minimum gap between presents. Covers the dual-path race on macOS ≤26.
    static let presentDebounceSeconds: TimeInterval = 0.3

    /// How the menu is shown once a present is accepted.
    enum Presentation: Equatable {
        /// Assign `statusItem.menu` then `button.performClick`. AppKit positions
        /// and tracks the menu under the status item. Clear menu in menuDidClose.
        case statusItemMenu
        /// Manual `NSMenu.popUp(at:in:)`. Causes scroll-chevron jump on mouse move
        /// when the cursor starts above the menu. Kept only as a named anti-pattern
        /// so tests can lock that we do *not* use it.
        case manualPopUp
    }

    static let presentation: Presentation = .statusItemMenu

    /// Returns true and advances `lastPresentedAt` when a new present is allowed.
    static func acceptPresent(
        now: Date,
        lastPresentedAt: inout Date,
        debounce: TimeInterval = presentDebounceSeconds
    ) -> Bool {
        guard now.timeIntervalSince(lastPresentedAt) > debounce else { return false }
        lastPresentedAt = now
        return true
    }
}
