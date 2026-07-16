import Foundation
import IOKit.ps

/// Decides how often the background refresh loop may spawn CLI fetches. The
/// 30s timer keeps firing (cheap); this throttles the expensive part - each
/// fetch is a full Node process at 100%+ CPU for seconds (#647). With the
/// popover closed nobody is looking at anything but the status figure, so on
/// battery or in Low Power Mode the spawn cadence backs off. Opening the
/// popover always refreshes immediately via refreshPayloadForPopoverOpen, so
/// the backoff never shows a user stale data they are actually looking at.
enum RefreshCadence {
    static let activeSeconds: TimeInterval = 30
    static let batteryIdleSeconds: TimeInterval = 150
    static let lowPowerIdleSeconds: TimeInterval = 300

    /// nil means "never auto-spawn" (manual mode): usage refreshes only on
    /// popover open, Refresh Now, and first launch.
    static func interval(
        mode: UsageRefreshCadence,
        popoverOpen: Bool,
        onBattery: Bool,
        lowPowerMode: Bool
    ) -> TimeInterval? {
        switch mode {
        case .manual:
            return nil
        case .auto:
            if popoverOpen { return activeSeconds }
            if lowPowerMode { return lowPowerIdleSeconds }
            if onBattery { return batteryIdleSeconds }
            return activeSeconds
        case .oneMinute, .fiveMinutes, .fifteenMinutes:
            // A fixed user-chosen cadence, except an open popover always gets
            // the active cadence: the user is looking at the numbers.
            return popoverOpen
                ? min(activeSeconds, TimeInterval(mode.rawValue))
                : TimeInterval(mode.rawValue)
        }
    }
}

enum PowerSource {
    static func isOnBattery() -> Bool {
        // Copy function -> retained; Get function -> borrowed (unretained).
        guard let snapshot = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let type = IOPSGetProvidingPowerSourceType(snapshot)?.takeUnretainedValue() as String?
        else { return false }
        return type == kIOPMBatteryPowerKey
    }
}
