import CoreGraphics

/// Where the Settings window opens. Pure geometry so the decision can be tested
/// without a screen: the window itself only supplies its size, the frame it
/// last saved, and today's screens.
enum SettingsWindowPlacement {
    /// A saved frame is honoured only while the window would still sit entirely
    /// on one of today's screens — a frame from a display that is gone, or one
    /// saved when the window was smaller, re-centers on the active screen.
    static func origin(
        savedFrame: CGRect?,
        size: CGSize,
        activeVisibleFrame: CGRect,
        screenVisibleFrames: [CGRect]
    ) -> CGPoint {
        if let savedFrame {
            let proposed = CGRect(origin: savedFrame.origin, size: size)
            if screenVisibleFrames.contains(where: { $0.contains(proposed) }) {
                return proposed.origin
            }
        }
        // A window bigger than the screen cannot be centered and stay visible,
        // so its top-left corner wins: the titlebar stays reachable.
        return CGPoint(
            x: activeVisibleFrame.minX + max(0, (activeVisibleFrame.width - size.width) / 2),
            y: activeVisibleFrame.maxY - size.height - max(0, (activeVisibleFrame.height - size.height) / 2)
        )
    }
}
