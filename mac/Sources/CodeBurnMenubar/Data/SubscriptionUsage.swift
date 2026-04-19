import Foundation

struct SubscriptionUsage: Sendable, Equatable {
    let planDisplayName: String
    let usedUnits: Double
    let totalUnits: Double
    let resetsAt: Date?
    let isLow: Bool
    let unitLabel: String
    let fetchedAt: Date

    var usagePercent: Double {
        guard totalUnits > 0 else { return 0 }
        return (usedUnits / totalUnits) * 100
    }

    var remainingUnits: Double {
        max(0, totalUnits - usedUnits)
    }
}
