import CoreGraphics
import Testing
@testable import CodeBurnMenubar

/// Guards where the Settings window opens. The bug this suite pins: the window
/// was positioned before SwiftUI had sized it, so it grew off the bottom-right
/// corner of the screen and most of it could not be reached.
@Suite("Settings window placement")
struct SettingsWindowPlacementTests {

    /// A 1600x900 display with the menu bar taken off the top.
    static let screen = CGRect(x: 0, y: 0, width: 1600, height: 875)
    static let size = CGSize(width: 880, height: 620)

    static func origin(savedFrame: CGRect?, size: CGSize = size, screens: [CGRect] = [screen]) -> CGPoint {
        SettingsWindowPlacement.origin(
            savedFrame: savedFrame,
            size: size,
            activeVisibleFrame: screens[0],
            screenVisibleFrames: screens
        )
    }

    @Test("a first open centers on the active screen")
    func centersWithoutASavedFrame() {
        let origin = Self.origin(savedFrame: nil)
        #expect(origin == CGPoint(x: 360, y: 127.5))
        #expect(Self.screen.contains(CGRect(origin: origin, size: Self.size)))
    }

    @Test("a saved frame that still fits is honoured")
    func honoursAFullyVisibleSavedFrame() {
        let saved = CGRect(x: 120, y: 60, width: 880, height: 620)
        #expect(Self.origin(savedFrame: saved) == saved.origin)
    }

    @Test("a saved frame hanging off the screen re-centers")
    func recentersAPartlyOffScreenSavedFrame() {
        // What the owner saw: top-left at the middle of the screen, the rest of
        // the window below the bottom edge.
        let saved = CGRect(x: 800, y: -165, width: 880, height: 620)
        #expect(Self.origin(savedFrame: saved) == CGPoint(x: 360, y: 127.5))
    }

    @Test("a saved frame on a display that is gone re-centers")
    func recentersWhenTheSavedDisplayIsGone() {
        let saved = CGRect(x: 2000, y: 100, width: 880, height: 620)
        #expect(Self.origin(savedFrame: saved) == CGPoint(x: 360, y: 127.5))
    }

    @Test("a saved frame on a second display that is still attached is honoured")
    func honoursASavedFrameOnAnotherAttachedDisplay() {
        let second = CGRect(x: 1600, y: 0, width: 1920, height: 1055)
        let saved = CGRect(x: 2000, y: 100, width: 880, height: 620)
        #expect(Self.origin(savedFrame: saved, screens: [Self.screen, second]) == saved.origin)
    }

    @Test("a saved frame kept at its old size is re-measured against the window's size")
    func recentersASavedFrameThatNoLongerFitsAtTheCurrentSize() {
        // Saved when the window was 520x380 and still just inside the screen;
        // at 880x620 the same origin runs off the right edge.
        let saved = CGRect(x: 1000, y: 60, width: 520, height: 380)
        #expect(Self.origin(savedFrame: saved) == CGPoint(x: 360, y: 127.5))
    }

    @Test("a window larger than the screen keeps its title bar on screen")
    func clampsAWindowBiggerThanTheScreen() {
        let huge = CGSize(width: 2000, height: 1200)
        let origin = Self.origin(savedFrame: nil, size: huge)
        #expect(origin.x == Self.screen.minX)
        #expect(origin.y + huge.height == Self.screen.maxY, "the top edge sits at the top of the screen")
    }
}
