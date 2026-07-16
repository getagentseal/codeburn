import Foundation

/// User-configurable cadence for the usage payload refresh loop (#647).
/// `auto` keeps the adaptive default: 30s while active, backed off on battery,
/// in Low Power Mode, and while the displays sleep. `manual = 0` never
/// auto-spawns; usage refreshes only on popover open, Refresh Now, and first
/// launch. Stored as raw seconds in UserDefaults (auto = -1), mirroring
/// SubscriptionRefreshCadence.
enum UsageRefreshCadence: Int, CaseIterable, Identifiable {
    case auto = -1
    case manual = 0
    case oneMinute = 60
    case fiveMinutes = 300
    case fifteenMinutes = 900

    var id: Int { rawValue }

    var label: String {
        switch self {
        case .auto: return "Auto (30s, less on battery)"
        case .manual: return "Manual"
        case .oneMinute: return "1 minute"
        case .fiveMinutes: return "5 minutes"
        case .fifteenMinutes: return "15 minutes"
        }
    }

    static let defaultsKey = "CodeBurnMenubarRefreshSeconds"
    static let `default`: UsageRefreshCadence = .auto

    static var current: UsageRefreshCadence {
        get {
            // integer(forKey:) returns 0 for a missing key, which aliases
            // `manual`; probe object(forKey:) to seed the default instead.
            if UserDefaults.standard.object(forKey: defaultsKey) == nil {
                return .default
            }
            return UsageRefreshCadence(rawValue: UserDefaults.standard.integer(forKey: defaultsKey)) ?? .default
        }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: defaultsKey) }
    }
}
