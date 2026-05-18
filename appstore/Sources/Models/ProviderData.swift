import Foundation

struct ProviderData: Identifiable, Sendable {
    let id = UUID()
    let name: String
    var sessions: [ParsedSession]

    var totalCost: Double { sessions.reduce(0) { $0 + $1.cost } }
    var totalCalls: Int { sessions.reduce(0) { $0 + $1.calls } }

    init(name: String, sessions: [ParsedSession] = []) {
        self.name = name
        self.sessions = sessions
    }
}

struct ParsedSession: Identifiable, Sendable {
    let id: String
    let project: String
    let provider: String
    let startDate: Date
    let calls: Int
    let cost: Double
    let inputTokens: Int
    let outputTokens: Int
    let cacheReadTokens: Int
    let cacheWriteTokens: Int
    let model: String
    let turns: [ParsedTurn]
}

struct ParsedTurn: Sendable {
    let timestamp: Date
    let model: String
    let inputTokens: Int
    let outputTokens: Int
    let cacheReadTokens: Int
    let cacheWriteTokens: Int
    let cost: Double
    let toolCalls: [String]
}

extension SessionStore.Period {
    var dateRange: ClosedRange<Date> {
        let now = Date()
        let calendar = Calendar.current
        let startOfToday = calendar.startOfDay(for: now)

        let start: Date = switch self {
        case .today: startOfToday
        case .week: calendar.date(byAdding: .day, value: -7, to: startOfToday)!
        case .month: calendar.date(byAdding: .day, value: -30, to: startOfToday)!
        case .threeMonths: calendar.date(byAdding: .month, value: -3, to: startOfToday)!
        case .sixMonths: calendar.date(byAdding: .month, value: -6, to: startOfToday)!
        }
        return start...now
    }

    var fileCutoff: Date {
        let calendar = Calendar.current
        let startOfToday = calendar.startOfDay(for: Date())
        return switch self {
        case .today: calendar.date(byAdding: .day, value: -1, to: startOfToday)!
        case .week: calendar.date(byAdding: .day, value: -8, to: startOfToday)!
        case .month: calendar.date(byAdding: .day, value: -31, to: startOfToday)!
        case .threeMonths: calendar.date(byAdding: .month, value: -3, to: calendar.date(byAdding: .day, value: -1, to: startOfToday)!)!
        case .sixMonths: calendar.date(byAdding: .month, value: -6, to: calendar.date(byAdding: .day, value: -1, to: startOfToday)!)!
        }
    }
}
