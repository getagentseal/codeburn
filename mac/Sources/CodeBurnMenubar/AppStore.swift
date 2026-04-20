import Foundation
import Observation

private let cacheTTLSeconds: TimeInterval = 300

struct CachedPayload {
    let payload: MenubarPayload
    let fetchedAt: Date
    var isFresh: Bool { Date().timeIntervalSince(fetchedAt) < cacheTTLSeconds }
}

struct PayloadCacheKey: Hashable {
    let period: Period
}

@MainActor
@Observable
final class AppStore {
    var selectedPeriod: Period = .today
    var selectedInsight: InsightMode = .trend
    var currency: String = "USD"
    var isLoading: Bool = false
    var lastError: String?
    var subscription: SubscriptionUsage?
    var subscriptionError: String?
    var subscriptionLoadState: SubscriptionLoadState = .idle

    private var cache: [PayloadCacheKey: CachedPayload] = [:]

    private var currentKey: PayloadCacheKey {
        PayloadCacheKey(period: selectedPeriod)
    }

    var payload: MenubarPayload {
        cache[currentKey]?.payload ?? .empty
    }

    /// Today is pinned for the always-visible menubar icon, independent of
    /// the popover's selected period.
    var todayPayload: MenubarPayload? {
        cache[PayloadCacheKey(period: .today)]?.payload
    }

    var hasCachedData: Bool {
        cache[currentKey] != nil
    }

    var findingsCount: Int {
        payload.optimize.findingCount
    }

    /// Switch to a period. Uses cached payload if fresh; otherwise fetches.
    func switchTo(period: Period) async {
        selectedPeriod = period
        if let cached = cache[currentKey], cached.isFresh { return }
        await refresh(includeOptimize: true)
    }

    private var inFlightKeys: Set<PayloadCacheKey> = []

    /// Refresh the currently selected period. Guards against concurrent fetches for the same key
    /// so a slow initial request can't overwrite a newer one that finished first.
    func refresh(includeOptimize: Bool) async {
        let key = currentKey
        guard !inFlightKeys.contains(key) else { return }
        inFlightKeys.insert(key)
        isLoading = true
        defer {
            inFlightKeys.remove(key)
            isLoading = false
        }
        do {
            let fresh = try await DataClient.fetch(period: key.period, includeOptimize: includeOptimize)
            cache[key] = CachedPayload(payload: fresh, fetchedAt: Date())
            lastError = nil
        } catch {
            lastError = String(describing: error)
            NSLog("CodeBurn: fetch failed for \(key.period.rawValue): \(error)")
        }
    }

    /// Background refresh for a period other than the visible one (e.g. keeping today fresh for the menubar badge).
    /// Does not toggle isLoading, so the popover's loading overlay is unaffected.
    func refreshQuietly(period: Period) async {
        do {
            let fresh = try await DataClient.fetch(period: period, includeOptimize: true)
            cache[PayloadCacheKey(period: period)] = CachedPayload(payload: fresh, fetchedAt: Date())
        } catch {
            NSLog("CodeBurn: quiet refresh failed for \(period.rawValue): \(error)")
        }
    }

    func refreshSubscription() async {
        subscriptionLoadState = .loading
        do {
            let usage = try await SubscriptionClient.fetch()
            subscription = usage
            subscriptionError = nil
            subscriptionLoadState = .loaded
        } catch SubscriptionError.noSession {
            subscription = nil
            subscriptionError = nil
            subscriptionLoadState = .noCredentials
        } catch SubscriptionError.sessionInvalid {
            subscription = nil
            subscriptionError = nil
            subscriptionLoadState = .noCredentials
        } catch SubscriptionError.sessionExpired(let code) {
            subscription = nil
            subscriptionError = "Session expired (\(code)). Run `auggie login` and reopen."
            subscriptionLoadState = .sessionExpired
        } catch {
            subscription = nil
            subscriptionError = String(describing: error)
            subscriptionLoadState = .failed
            NSLog("CodeBurn: subscription fetch failed: \(error)")
        }
    }


}

enum SupportedCurrency: String, CaseIterable, Identifiable {
    case USD, GBP, EUR, AUD, CAD, NZD, JPY, CHF, INR, BRL, SEK, SGD, HKD, KRW, MXN, ZAR, DKK
    var id: String { rawValue }
    var displayName: String {
        switch self {
        case .USD: "US Dollar"
        case .GBP: "British Pound"
        case .EUR: "Euro"
        case .AUD: "Australian Dollar"
        case .CAD: "Canadian Dollar"
        case .NZD: "New Zealand Dollar"
        case .JPY: "Japanese Yen"
        case .CHF: "Swiss Franc"
        case .INR: "Indian Rupee"
        case .BRL: "Brazilian Real"
        case .SEK: "Swedish Krona"
        case .SGD: "Singapore Dollar"
        case .HKD: "Hong Kong Dollar"
        case .KRW: "South Korean Won"
        case .MXN: "Mexican Peso"
        case .ZAR: "South African Rand"
        case .DKK: "Danish Krone"
        }
    }
}

enum SubscriptionLoadState: Sendable, Equatable {
    case idle           // never tried, awaiting user intent
    case loading        // fetch in progress
    case loaded         // success; subscription is populated
    case noCredentials  // tried; user has no session (not logged in)
    case sessionExpired // tried; session expired (401/403)
    case failed         // tried; error occurred
}

enum InsightMode: String, CaseIterable, Identifiable {
    case plan = "Plan"
    case trend = "Trend"
    case forecast = "Forecast"
    case pulse = "Pulse"
    case stats = "Stats"
    var id: String { rawValue }
}

enum Period: String, CaseIterable, Identifiable {
    case today = "Today"
    case sevenDays = "7 Days"
    case thirtyDays = "30 Days"
    case month = "Month"
    case all = "All"

    var id: String { rawValue }

    /// Maps to the CLI's `--period` argument values.
    var cliArg: String {
        switch self {
        case .today: "today"
        case .sevenDays: "week"
        case .thirtyDays: "30days"
        case .month: "month"
        case .all: "all"
        }
    }
}

/// NumberFormatter is expensive to instantiate (~microseconds each) and currency/token values
/// are formatted dozens of times per popover refresh. These shared instances avoid thousands of
/// allocations per frame while SwiftUI's Observation framework still triggers redraws when
/// CurrencyState.shared mutates.
private let groupedDecimalFormatter: NumberFormatter = {
    let f = NumberFormatter()
    f.numberStyle = .decimal
    f.groupingSeparator = ","
    f.decimalSeparator = "."
    f.maximumFractionDigits = 2
    f.minimumFractionDigits = 2
    return f
}()

private let thousandsFormatter: NumberFormatter = {
    let f = NumberFormatter()
    f.numberStyle = .decimal
    f.groupingSeparator = ","
    return f
}()

extension Double {
    func asCurrency() -> String {
        let state = CurrencyState.shared
        let converted = self * state.rate
        return state.symbol + (groupedDecimalFormatter.string(from: NSNumber(value: converted)) ?? "\(converted)")
    }

    func asCompactCurrency() -> String {
        let state = CurrencyState.shared
        return String(format: "\(state.symbol)%.2f", self * state.rate)
    }

    /// Format as credits (no currency symbol, comma-separated integer)
    func asCredits() -> String {
        thousandsFormatter.string(from: NSNumber(value: Int(self))) ?? "\(Int(self))"
    }

    /// Format as compact credits (K/M suffix for large values)
    func asCompactCredits() -> String {
        if self >= 1_000_000 {
            return String(format: "%.1fM", self / 1_000_000)
        } else if self >= 1_000 {
            return String(format: "%.1fK", self / 1_000)
        }
        return "\(Int(self))"
    }
}

extension Optional where Wrapped == Double {
    /// Format optional double as currency with fallback
    func asCurrency(fallback: String = "—") -> String {
        guard let v = self else { return fallback }
        return v.asCurrency()
    }

    func asCompactCurrency(fallback: String = "—") -> String {
        guard let v = self else { return fallback }
        return v.asCompactCurrency()
    }

    func asCredits(fallback: String = "—") -> String {
        guard let v = self else { return fallback }
        return v.asCredits()
    }

    func asCompactCredits(fallback: String = "—") -> String {
        guard let v = self else { return fallback }
        return v.asCompactCredits()
    }
}

extension Int {
    func asThousandsSeparated() -> String {
        thousandsFormatter.string(from: NSNumber(value: self)) ?? "\(self)"
    }
}
