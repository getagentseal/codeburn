import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Capacity Dock interaction state")
struct CapacityDockInteractionStateTests {
    @Test("rail exit stays expanded until the collapse grace period completes")
    func railHoverLifecycle() {
        var state = CapacityDockInteractionState()

        state.setRailHovered(true)
        #expect(state.isExpanded)
        #expect(!state.canCollapse)

        state.beginRailExitGrace()
        #expect(state.isExpanded)
        #expect(!state.canCollapse)

        state.completeCollapseGrace()
        #expect(!state.isExpanded)
        #expect(state.canCollapse)
    }

    @Test("detail hover bridges the pointer gap after leaving the rail")
    func detailHoverKeepsExpanded() {
        var state = CapacityDockInteractionState()
        state.setRailHovered(true)
        state.setDetailHovered(true)
        state.beginRailExitGrace()
        state.completeCollapseGrace()

        #expect(state.isExpanded)
        #expect(!state.canCollapse)

        state.setDetailHovered(false)
        #expect(state.canCollapse)
    }

    @Test("pin survives hover exit and toggles off")
    func pinLifecycle() {
        var state = CapacityDockInteractionState()

        state.togglePinned()
        state.beginRailExitGrace()
        state.completeCollapseGrace()
        #expect(state.isExpanded)
        #expect(state.isPinned)

        state.togglePinned()
        #expect(!state.isExpanded)
        #expect(state.canCollapse)
    }

    @Test("outside click and Escape fully dismiss pinned interaction")
    func dismissesPinnedState() {
        var state = CapacityDockInteractionState(isRailHovered: true, isDetailHovered: true, isPinned: true)

        state.dismiss()
        #expect(state == CapacityDockInteractionState())

        state.togglePinned()
        let handled = state.handleEscape()
        #expect(handled)
        #expect(state == CapacityDockInteractionState())
        let handledAgain = state.handleEscape()
        #expect(!handledAgain)
    }

    @Test("dragging suppresses hover transitions without changing pin state")
    func draggingSuppressesHover() {
        var state = CapacityDockInteractionState(isRailHovered: true, isPinned: true)

        state.beginDragging()
        #expect(state.isDragging)
        #expect(state.isPinned)
        #expect(state.isExpanded)
        #expect(!state.acceptsHoverTransitions)

        state.endDragging()
        #expect(!state.isDragging)
        #expect(state.acceptsHoverTransitions)
        #expect(state.isPinned)
    }

    @Test("dragging during collapse grace keeps the current rail geometry stable")
    func draggingPreservesCollapseGrace() {
        var state = CapacityDockInteractionState(isRailHovered: true)
        state.beginRailExitGrace()
        #expect(state.isExpanded)

        state.beginDragging()
        #expect(state.isExpanded)
        #expect(state.isCollapseGraceActive)
    }
}

/// `settleActiveDrag()` runs on every language change, because a change rebuilds
/// the rail's SwiftUI view and so destroys a `DragGesture` in flight before it
/// can report its end. The overwhelmingly common case is no drag at all, and
/// that one must not disturb the dock. Driving a real drag needs a rail panel
/// and a screen, so the mid-drag path itself is verified by hand.
@Suite("Capacity Dock drag settling")
struct CapacityDockDragSettlingTests {
    @MainActor
    @Test("settling when no drag is in flight changes nothing")
    func settlingIdleDockIsANoOp() {
        let name = "CodeBurnMenubarTests.DragSettle.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { TestDefaults.forget(name) }

        let controller = CapacityDockController(store: AppStore(), defaults: defaults)
        controller.settleActiveDrag()
        controller.settleActiveDrag()
    }
}
