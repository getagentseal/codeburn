import Foundation

struct RefreshBackoff {
    let stallThreshold: Int
    let initialDelay: TimeInterval
    let maximumDelay: TimeInterval

    private(set) var consecutiveStalls = 0
    private(set) var pausedUntil: Date?

    init(stallThreshold: Int = 3, initialDelay: TimeInterval = 30, maximumDelay: TimeInterval = 300) {
        self.stallThreshold = stallThreshold
        self.initialDelay = initialDelay
        self.maximumDelay = maximumDelay
    }

    mutating func recordStall(now: Date = Date()) -> Date? {
        consecutiveStalls += 1
        guard consecutiveStalls >= stallThreshold else { return nil }

        let exponent = max(0, consecutiveStalls - stallThreshold)
        let multiplier = pow(2.0, Double(exponent))
        let delay = min(initialDelay * multiplier, maximumDelay)
        let until = now.addingTimeInterval(delay)
        pausedUntil = until
        return until
    }

    mutating func recordSuccess() {
        consecutiveStalls = 0
        pausedUntil = nil
    }

    mutating func retryNow(resetStallCount: Bool = false) {
        pausedUntil = nil
        if resetStallCount {
            consecutiveStalls = 0
        }
    }

    mutating func isPaused(now: Date = Date()) -> Bool {
        guard let pausedUntil else { return false }
        if pausedUntil > now { return true }
        self.pausedUntil = nil
        return false
    }
}
