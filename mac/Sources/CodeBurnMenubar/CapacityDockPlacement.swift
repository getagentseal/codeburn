import CoreGraphics

enum CapacityDockExpansionAnchor: Equatable, Sendable {
    case start
    case end
}

struct CapacityDockAttachmentCandidate: Equatable, Sendable {
    let edge: CapacityDockEdge
    let progress: CGFloat
}

/// Pure geometry for a rail that can flare into any display edge or detach into
/// a freely positioned floating widget.
enum CapacityDockPlacement {
    static let floatingInset: CGFloat = 12
    static let verticalInset: CGFloat = 12
    static let defaultTopOffset: CGFloat = 156
    static let detailGap: CGFloat = 10
    static let detailInset: CGFloat = 8
    static let dockSnapDistance: CGFloat = 44

    static func screenIndex(containing point: CGPoint, frames: [CGRect]) -> Int? {
        frames.firstIndex { $0.contains(point) }
    }

    static func railFrame(
        screenFrame: CGRect,
        visibleFrame: CGRect,
        size: CGSize,
        dockedEdge: CapacityDockEdge?,
        normalizedHorizontalOffset: Double?,
        normalizedTopOffset: Double?,
        anchoredTop: CGFloat? = nil,
        anchoredLeading: CGFloat? = nil,
        anchoredAxisCoordinate: CGFloat? = nil,
        expansionAnchor: CapacityDockExpansionAnchor = .start
    ) -> CGRect {
        let fittedSize = CGSize(
            width: min(size.width, max(0, screenFrame.width - floatingInset * 2)),
            height: min(size.height, max(0, screenFrame.height - verticalInset * 2))
        )
        let highestTop = visibleFrame.maxY - verticalInset
        let lowestTop = visibleFrame.minY + verticalInset + fittedSize.height
        let travel = max(0, highestTop - lowestTop)

        let leading: CGFloat
        switch dockedEdge {
        case .right:
            leading = screenFrame.maxX - fittedSize.width
        case .left:
            leading = screenFrame.minX
        case .top, .bottom, nil:
            let lowestLeading = visibleFrame.minX + floatingInset
            let highestLeading = max(
                lowestLeading,
                visibleFrame.maxX - floatingInset - fittedSize.width
            )
            if let anchoredLeading {
                leading = min(max(anchoredLeading, lowestLeading), highestLeading)
            } else if let anchoredAxisCoordinate {
                let candidate = expansionAnchor == .start
                    ? anchoredAxisCoordinate
                    : anchoredAxisCoordinate - fittedSize.width
                leading = min(max(candidate, lowestLeading), highestLeading)
            } else if let normalizedHorizontalOffset {
                let normalized = min(max(CGFloat(normalizedHorizontalOffset), 0), 1)
                leading = lowestLeading + (highestLeading - lowestLeading) * normalized
            } else if dockedEdge == .top || dockedEdge == .bottom {
                leading = lowestLeading + (highestLeading - lowestLeading) * 0.5
            } else {
                leading = highestLeading
            }
        }

        let top: CGFloat
        switch dockedEdge {
        case .top:
            // Sit flush against the physical top edge (the notch/menu-bar band),
            // like the system notch, so the concave shoulders neck into the very
            // top of the screen with no gap below the menu bar.
            top = screenFrame.maxY
        case .bottom:
            top = screenFrame.minY + fittedSize.height
        case .left, .right, nil:
            if let anchoredTop {
                top = min(max(anchoredTop, lowestTop), highestTop)
            } else if let anchoredAxisCoordinate {
                let candidate = expansionAnchor == .start
                    ? anchoredAxisCoordinate
                    : anchoredAxisCoordinate + fittedSize.height
                top = min(max(candidate, lowestTop), highestTop)
            } else if let normalizedTopOffset {
                let normalized = min(max(CGFloat(normalizedTopOffset), 0), 1)
                top = highestTop - travel * normalized
            } else {
                top = min(max(visibleFrame.maxY - defaultTopOffset, lowestTop), highestTop)
            }
        }

        return CGRect(
            x: leading,
            y: top - fittedSize.height,
            width: fittedSize.width,
            height: fittedSize.height
        )
    }

    /// Auto-hide: slide a docked rail beyond its screen edge so only `peek`
    /// points remain visible as a hover target.
    static func tuckedFrame(_ frame: CGRect, edge: CapacityDockEdge, peek: CGFloat) -> CGRect {
        var result = frame
        switch edge {
        case .right: result.origin.x += max(0, frame.width - peek)
        case .left: result.origin.x -= max(0, frame.width - peek)
        case .top: result.origin.y += max(0, frame.height - peek)
        case .bottom: result.origin.y -= max(0, frame.height - peek)
        }
        return result
    }

    static func normalizedHorizontalOffset(
        railFrame: CGRect,
        visibleFrame: CGRect
    ) -> Double {
        let lowestLeading = visibleFrame.minX + floatingInset
        let highestLeading = max(
            lowestLeading,
            visibleFrame.maxX - floatingInset - railFrame.width
        )
        let travel = highestLeading - lowestLeading
        guard travel > 0 else { return 0 }
        return Double(min(max((railFrame.minX - lowestLeading) / travel, 0), 1))
    }

    /// Uses stable AppKit screen coordinates so moving the panel cannot alter
    /// the gesture's own coordinate space and feed jitter back into the drag.
    static func pointerAnchoredDragFrame(
        startFrame: CGRect,
        startPointer: CGPoint,
        currentPointer: CGPoint,
        size: CGSize
    ) -> CGRect {
        let anchorX = startFrame.width > 0
            ? min(max((startPointer.x - startFrame.minX) / startFrame.width, 0), 1)
            : 0.5
        let anchorY = startFrame.height > 0
            ? min(max((startPointer.y - startFrame.minY) / startFrame.height, 0), 1)
            : 0.5
        return CGRect(
            x: currentPointer.x - anchorX * size.width,
            y: currentPointer.y - anchorY * size.height,
            width: size.width,
            height: size.height
        )
    }

    static func nearestDockEdge(
        railFrame: CGRect,
        screenFrame: CGRect,
        visibleFrame: CGRect
    ) -> CapacityDockEdge? {
        let distances: [(CapacityDockEdge, CGFloat)] = [
            (.left, abs(railFrame.minX - screenFrame.minX)),
            (.right, abs(screenFrame.maxX - railFrame.maxX)),
            (.top, max(0, visibleFrame.maxY - railFrame.maxY)),
            (.bottom, abs(railFrame.minY - screenFrame.minY)),
        ]
        return distances
            .filter { $0.1 <= dockSnapDistance }
            .min { $0.1 < $1.1 }?
            .0
    }

    static func attachmentCandidate(
        railFrame: CGRect,
        screenFrame: CGRect,
        visibleFrame: CGRect
    ) -> CapacityDockAttachmentCandidate? {
        let distances: [(CapacityDockEdge, CGFloat)] = [
            (.left, abs(railFrame.minX - screenFrame.minX)),
            (.right, abs(screenFrame.maxX - railFrame.maxX)),
            (.top, max(0, visibleFrame.maxY - railFrame.maxY)),
            (.bottom, abs(railFrame.minY - screenFrame.minY)),
        ]
        guard let nearest = distances.min(by: { $0.1 < $1.1 }),
              nearest.1 <= dockSnapDistance else { return nil }
        let progress = 1 - nearest.1 / dockSnapDistance
        return CapacityDockAttachmentCandidate(
            edge: nearest.0,
            progress: min(max(progress, 0), 1)
        )
    }

    static func expansionAnchor(
        railFrame: CGRect,
        visibleFrame: CGRect,
        edge: CapacityDockEdge
    ) -> CapacityDockExpansionAnchor {
        if edge.isVertical {
            let roomBelow = railFrame.minY - visibleFrame.minY
            let roomAbove = visibleFrame.maxY - railFrame.maxY
            return roomBelow >= roomAbove ? .start : .end
        }
        let roomTowardStart = railFrame.minX - visibleFrame.minX
        let roomTowardEnd = visibleFrame.maxX - railFrame.maxX
        return roomTowardEnd >= roomTowardStart ? .start : .end
    }

    static func clampedDragFrame(
        _ frame: CGRect,
        screenFrame: CGRect,
        visibleFrame: CGRect
    ) -> CGRect {
        let candidate = attachmentCandidate(
            railFrame: frame,
            screenFrame: screenFrame,
            visibleFrame: visibleFrame
        )
        var result = frame
        let horizontalBounds = switch candidate?.edge {
        case .left, .right: screenFrame
        case .top, .bottom, nil: visibleFrame
        }
        let verticalBounds = switch candidate?.edge {
        case .bottom: screenFrame
        case .left, .right, .top, nil: visibleFrame
        }
        let lowestLeading = horizontalBounds.minX
        let highestLeading = max(lowestLeading, horizontalBounds.maxX - result.width)
        result.origin.x = min(max(result.minX, lowestLeading), highestLeading)
        let lowestBottom = verticalBounds.minY
        let highestBottom = max(lowestBottom, verticalBounds.maxY - result.height)
        result.origin.y = min(max(result.minY, lowestBottom), highestBottom)
        return result
    }

    static func normalizedTopOffset(
        railFrame: CGRect,
        visibleFrame: CGRect
    ) -> Double {
        let highestTop = visibleFrame.maxY - verticalInset
        let lowestTop = visibleFrame.minY + verticalInset + railFrame.height
        let travel = max(0, highestTop - lowestTop)
        guard travel > 0 else { return 0 }
        return Double(min(max((highestTop - railFrame.maxY) / travel, 0), 1))
    }

    static func detailFrame(
        size: CGSize,
        railFrame: CGRect,
        providerRowMidY: CGFloat,
        visibleFrame: CGRect,
        side: CapacityDockEdge
    ) -> CGRect {
        let fittedSize = CGSize(
            width: min(size.width, max(0, visibleFrame.width - detailInset * 2)),
            height: min(size.height, max(0, visibleFrame.height - detailInset * 2))
        )
        let desired: CGRect
        switch side {
        case .left:
            desired = CGRect(
                x: railFrame.minX - detailGap - fittedSize.width,
                y: providerRowMidY - fittedSize.height / 2,
                width: fittedSize.width,
                height: fittedSize.height
            )
        case .right:
            desired = CGRect(
                x: railFrame.maxX + detailGap,
                y: providerRowMidY - fittedSize.height / 2,
                width: fittedSize.width,
                height: fittedSize.height
            )
        case .top:
            desired = CGRect(
                x: providerRowMidY - fittedSize.width / 2,
                y: railFrame.maxY + detailGap,
                width: fittedSize.width,
                height: fittedSize.height
            )
        case .bottom:
            desired = CGRect(
                x: providerRowMidY - fittedSize.width / 2,
                y: railFrame.minY - detailGap - fittedSize.height,
                width: fittedSize.width,
                height: fittedSize.height
            )
        }
        return clampedFrame(
            desired,
            to: visibleFrame,
            inset: detailInset
        )
    }

    private static func clampedFrame(
        _ frame: CGRect,
        to visibleFrame: CGRect,
        inset: CGFloat
    ) -> CGRect {
        let availableWidth = max(0, visibleFrame.width - inset * 2)
        let availableHeight = max(0, visibleFrame.height - inset * 2)
        let width = min(frame.width, availableWidth)
        let height = min(frame.height, availableHeight)
        let minX = visibleFrame.minX + inset
        let maxX = max(minX, visibleFrame.maxX - inset - width)
        let minY = visibleFrame.minY + inset
        let maxY = max(minY, visibleFrame.maxY - inset - height)
        return CGRect(
            x: min(max(frame.minX, minX), maxX),
            y: min(max(frame.minY, minY), maxY),
            width: width,
            height: height
        )
    }

    /// Inverse of the controller's row-midpoint layout: which provider row band
    /// contains a pointer, given its along-axis distance from the anchor-side
    /// content start (padding already subtracted). Returns nil in the spacing
    /// gaps and outside the row run.
    static func providerRowIndex(
        alongOffset: CGFloat,
        rowHeight: CGFloat,
        rowSpacing: CGFloat,
        rowCount: Int,
        expansionAnchor: CapacityDockExpansionAnchor
    ) -> Int? {
        guard rowCount > 0, rowHeight > 0, alongOffset >= 0 else { return nil }
        let period = rowHeight + rowSpacing
        let slot = Int(alongOffset / period)
        guard slot < rowCount,
              alongOffset - CGFloat(slot) * period <= rowHeight else { return nil }
        return expansionAnchor == .start ? slot : rowCount - 1 - slot
    }

    static func preferredDetailSide(
        railFrame: CGRect,
        visibleFrame: CGRect,
        dockedEdge: CapacityDockEdge?,
        preferredEdge: CapacityDockEdge? = nil
    ) -> CapacityDockEdge {
        if let dockedEdge { return dockedEdge.opposite }
        let roomLeft = railFrame.minX - visibleFrame.minX
        let roomRight = visibleFrame.maxX - railFrame.maxX
        let roomBelow = railFrame.minY - visibleFrame.minY
        let roomAbove = visibleFrame.maxY - railFrame.maxY

        // A detached rail retains the vertical/horizontal orientation of the
        // edge it came from, but its card follows the room at its *current*
        // position. This prevents a bottom-docked rail dragged near the top (or
        // a right-docked rail dragged to the left) from opening through the
        // screen edge and being clamped to an apparently unrelated location.
        if let preferredEdge {
            if preferredEdge.isVertical {
                return roomRight >= roomLeft ? .right : .left
            }
            return roomAbove >= roomBelow ? .top : .bottom
        }
        if max(roomLeft, roomRight) >= max(roomBelow, roomAbove) {
            return roomRight >= roomLeft ? .right : .left
        }
        return roomAbove >= roomBelow ? .top : .bottom
    }
}
