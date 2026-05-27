import Foundation

enum UsageRefreshCadence: Int, CaseIterable, Identifiable {
    case manual = 0
    case thirtySeconds = 30
    case oneMinute = 60
    case twoMinutes = 120
    case fiveMinutes = 300
    case fifteenMinutes = 900

    var id: Int { rawValue }

    var label: String {
        switch self {
        case .manual: return "Manual"
        case .thirtySeconds: return "30 seconds"
        case .oneMinute: return "1 minute"
        case .twoMinutes: return "2 minutes"
        case .fiveMinutes: return "5 minutes"
        case .fifteenMinutes: return "15 minutes"
        }
    }

    var seconds: TimeInterval? {
        self == .manual ? nil : TimeInterval(rawValue)
    }

    var cacheTTLSeconds: TimeInterval {
        seconds ?? .greatestFiniteMagnitude
    }

    static let defaultsKey = "codeburn.menubar.refreshCadenceSeconds"
    static let `default`: UsageRefreshCadence = .thirtySeconds

    static var current: UsageRefreshCadence {
        get {
            guard UserDefaults.standard.object(forKey: defaultsKey) != nil else {
                return .default
            }
            return UsageRefreshCadence(rawValue: UserDefaults.standard.integer(forKey: defaultsKey)) ?? .default
        }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: defaultsKey) }
    }
}

enum QuotaDisplayMode: String, CaseIterable, Identifiable {
    case used
    case remaining

    var id: String { rawValue }

    var label: String {
        switch self {
        case .used: return "Used"
        case .remaining: return "Left"
        }
    }

    static let defaultsKey = "codeburn.quota.displayMode"
    static let `default`: QuotaDisplayMode = .used

    static var current: QuotaDisplayMode {
        get {
            guard let raw = UserDefaults.standard.string(forKey: defaultsKey) else {
                return .default
            }
            return QuotaDisplayMode(rawValue: raw) ?? .default
        }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: defaultsKey) }
    }
}

struct QuotaWarningEvent: Identifiable, Equatable {
    let id: String
    let title: String
    let body: String
    let severity: QuotaSummary.Severity
}

enum PrivacyRedactor {
    private static let emailPattern = try! NSRegularExpression(
        pattern: #"([A-Z0-9._%+\-])[A-Z0-9._%+\-]*@([A-Z0-9.\-]+\.[A-Z]{2,})"#,
        options: [.caseInsensitive]
    )

    static func redact(_ value: String, enabled: Bool) -> String {
        guard enabled, !value.isEmpty else { return value }
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        return emailPattern.stringByReplacingMatches(
            in: value,
            options: [],
            range: range,
            withTemplate: maskedEmailTemplate
        )
    }

    private static var maskedEmailTemplate: String {
        "$1***@$2"
    }
}
