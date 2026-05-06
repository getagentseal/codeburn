import Foundation
import Observation

private let cacheTTLSeconds: TimeInterval = 30

struct CachedPayload {
    let payload: MenubarPayload
    let fetchedAt: Date
    var isFresh: Bool { Date().timeIntervalSince(fetchedAt) < cacheTTLSeconds }
}

struct PayloadCacheKey: Hashable {
    let period: Period
    let provider: ProviderFilter
}

@MainActor
@Observable
final class AppStore {
    var selectedProvider: ProviderFilter = .all
    var selectedPeriod: Period = .today
    var selectedInsight: InsightMode = .trend
    var accentPreset: AccentPreset = ThemeState.shared.preset {
        didSet { ThemeState.shared.preset = accentPreset }
    }
    var showingAccentPicker: Bool = false
    var currency: String = "USD"
    var isLoading: Bool { loadingCount > 0 }
    private var loadingCount: Int = 0
    var lastError: String?
    var subscription: SubscriptionUsage?
    var subscriptionError: String?
    var subscriptionLoadState: SubscriptionLoadState = .idle
    var capacityEstimates: [String: CapacityEstimate] = [:]

    private var cache: [PayloadCacheKey: CachedPayload] = [:]
    private var cacheDate: String = ""
    private var switchTask: Task<Void, Never>?

    private var currentKey: PayloadCacheKey {
        PayloadCacheKey(period: selectedPeriod, provider: selectedProvider)
    }

    var payload: MenubarPayload {
        cache[currentKey]?.payload ?? .empty
    }

    /// Today (across all providers) is pinned for the always-visible menubar icon, independent of
    /// the popover's selected period or provider.
    var todayPayload: MenubarPayload? {
        cache[PayloadCacheKey(period: .today, provider: .all)]?.payload
    }

    /// All-provider payload for the selected period. Used by the tab strip to show
    /// per-provider costs that match the active period, not just today.
    var periodAllPayload: MenubarPayload? {
        cache[PayloadCacheKey(period: selectedPeriod, provider: .all)]?.payload
    }

    var hasCachedData: Bool {
        cache[currentKey] != nil
    }

    /// True if any cached payload reports at least one provider. Used to keep the
    /// AgentTabStrip visible across period/provider switches even when the current
    /// key's payload is briefly empty (e.g. immediately after a `switchTo` and
    /// before the new fetch lands).
    var hasAnyProvidersInCache: Bool {
        cache.values.contains { !$0.payload.current.providers.isEmpty }
    }

    var findingsCount: Int {
        payload.optimize.findingCount
    }

    /// Switch to a period. Cancels any in-flight switch and fetches provider-specific +
    /// all-provider data in parallel so tab strip costs stay in sync with the hero.
    func switchTo(period: Period) {
        selectedPeriod = period
        switchTask?.cancel()
        switchTask = Task {
            if selectedProvider == .all {
                await refresh(includeOptimize: false, force: true)
            } else {
                async let main: Void = refresh(includeOptimize: false, force: true)
                async let all: Void = refreshQuietly(period: period)
                _ = await (main, all)
            }
        }
    }

    /// Switch to a provider filter. Cancels any in-flight switch so rapid tab tapping only
    /// runs the CLI for the final selection. Fetches provider-specific and all-provider data
    /// in parallel so the tab strip costs stay in sync with the hero.
    func switchTo(provider: ProviderFilter) {
        selectedProvider = provider
        switchTask?.cancel()
        switchTask = Task {
            if provider == .all {
                await refresh(includeOptimize: false, force: true)
            } else {
                async let main: Void = refresh(includeOptimize: false, force: true)
                async let all: Void = refreshQuietly(period: selectedPeriod)
                _ = await (main, all)
            }
        }
    }

    private var inFlightKeys: Set<PayloadCacheKey> = []

    private func invalidateStaleDayCache() {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        let today = formatter.string(from: Date())
        if cacheDate != today {
            cache.removeAll()
            cacheDate = today
        }
    }

    func invalidateCache() {
        cache.removeAll()
    }

    func refresh(includeOptimize: Bool, force: Bool = false, showLoading: Bool = false) async {
        invalidateStaleDayCache()
        let key = currentKey
        let cacheDateAtStart = cacheDate
        if !force, cache[key]?.isFresh == true { return }
        if !force, inFlightKeys.contains(key) { return }
        inFlightKeys.insert(key)
        let didShowLoading = showLoading || cache[key] == nil
        if didShowLoading {
            loadingCount += 1
        }
        defer {
            inFlightKeys.remove(key)
            if didShowLoading { loadingCount = max(loadingCount - 1, 0) }
        }
        do {
            let fresh = try await DataClient.fetch(period: key.period, provider: key.provider, includeOptimize: includeOptimize)
            guard !Task.isCancelled else { return }
            // Day-rollover race guard: if the calendar date changed during the
            // fetch, this payload was computed against yesterday's date and
            // would pollute today's freshly-cleared cache. Drop it; the next
            // tick will refetch with today's data.
            if cacheDate != cacheDateAtStart { return }
            cache[key] = CachedPayload(payload: fresh, fetchedAt: Date())
            lastError = nil
        } catch {
            if Task.isCancelled { return }
            NSLog("CodeBurn: fetch failed for \(key.period.rawValue)/\(key.provider.rawValue): \(error)")
            if includeOptimize, cache[key] == nil {
                do {
                    let fallback = try await DataClient.fetch(period: key.period, provider: key.provider, includeOptimize: false)
                    guard !Task.isCancelled else { return }
                    if cacheDate != cacheDateAtStart { return }
                    cache[key] = CachedPayload(payload: fallback, fetchedAt: Date())
                    lastError = nil
                    return
                } catch {
                    if Task.isCancelled { return }
                    NSLog("CodeBurn: fallback fetch also failed: \(error)")
                }
            }
            lastError = String(describing: error)
        }

        let allKey = PayloadCacheKey(period: selectedPeriod, provider: .all)
        if key != allKey, cache[allKey]?.isFresh != true {
            await refreshQuietly(period: selectedPeriod)
        }
    }

    /// Background refresh for a period other than the visible one (e.g. keeping today fresh for the menubar badge).
    /// Does not toggle isLoading, so the popover's loading overlay is unaffected.
    /// Always uses the .all provider since the menubar badge shows total spend.
    func refreshQuietly(period: Period) async {
        invalidateStaleDayCache()
        let cacheDateAtStart = cacheDate
        do {
            let fresh = try await DataClient.fetch(period: period, provider: .all, includeOptimize: false)
            // Same day-rollover guard as refresh(): drop yesterday's payload if
            // the calendar rolled over during the fetch.
            if cacheDate != cacheDateAtStart { return }
            cache[PayloadCacheKey(period: period, provider: .all)] = CachedPayload(payload: fresh, fetchedAt: Date())
        } catch {
            NSLog("CodeBurn: quiet refresh failed for \(period.rawValue): \(error)")
        }
    }

    /// Fetch Claude subscription usage. Sets subscription = nil on missing creds (API users / unauthenticated).
    /// Triggered eagerly so the AgentTab quota bar lights up without requiring the user to open
    /// any deep view; the gate prevents a dead refresh token from spamming Anthropic forever.
    func refreshSubscription() async {
        // Don't drop to "loading" if we already have data — keeps the bar steady across ticks.
        if subscription == nil { subscriptionLoadState = .loading }
        do {
            let usage = try await SubscriptionClient.fetch()
            subscription = usage
            subscriptionError = nil
            subscriptionLoadState = .loaded
            await captureSnapshots(for: usage)
        } catch SubscriptionError.noCredentials {
            subscription = nil
            subscriptionError = nil
            subscriptionLoadState = .noCredentials
        } catch let SubscriptionError.refreshBlockedTerminal(reason) {
            subscriptionError = reason
            subscriptionLoadState = .terminalFailure(reason: reason)
        } catch SubscriptionError.refreshBlockedTransient {
            subscriptionLoadState = .transientFailure
        } catch {
            subscriptionError = String(describing: error)
            subscriptionLoadState = .failed
            NSLog("CodeBurn: subscription fetch failed: \(error)")
        }
    }

    /// Snapshot of live quota state for a given provider, used by AgentTab to render
    /// the inline progress bar and the hover popover. Returns nil for providers without
    /// a quota source (today: everything except Claude).
    func quotaSummary(for filter: ProviderFilter) -> QuotaSummary? {
        guard filter == .claude else { return nil }

        let connection: QuotaSummary.Connection = {
            switch subscriptionLoadState {
            case .idle, .loading: return subscription == nil ? .loading : .stale
            case .loaded: return .connected
            case .noCredentials: return .disconnected
            case .failed: return subscription == nil ? .loading : .stale
            case let .terminalFailure(reason): return .terminalFailure(reason: reason)
            case .transientFailure: return .transientFailure
            }
        }()

        // Build the windows. Weekly is the headline; details include all four for hover.
        var primary: QuotaSummary.Window?
        var details: [QuotaSummary.Window] = []
        if let usage = subscription {
            if let pct = usage.fiveHourPercent {
                details.append(.init(label: "5-hour", percent: pct / 100, resetsAt: usage.fiveHourResetsAt))
            }
            if let pct = usage.sevenDayPercent {
                let weekly = QuotaSummary.Window(label: "Weekly", percent: pct / 100, resetsAt: usage.sevenDayResetsAt)
                primary = weekly
                details.append(weekly)
            }
            if let pct = usage.sevenDayOpusPercent {
                details.append(.init(label: "Weekly · Opus", percent: pct / 100, resetsAt: usage.sevenDayOpusResetsAt))
            }
            if let pct = usage.sevenDaySonnetPercent {
                details.append(.init(label: "Weekly · Sonnet", percent: pct / 100, resetsAt: usage.sevenDaySonnetResetsAt))
            }
        }

        // No data yet, no connection state worth showing → bail.
        if primary == nil, case .disconnected = connection { return nil }
        if primary == nil, case .loading = connection {
            return QuotaSummary(providerFilter: filter, connection: connection, primary: nil, details: [])
        }

        return QuotaSummary(providerFilter: filter, connection: connection, primary: primary, details: details)
    }

    /// Persist one snapshot per window so we can answer "what did the prior cycle end at?"
    /// when the current window has just reset and projection from current data isn't meaningful.
    /// Also computes the effective_tokens consumed inside each 7-day window from local history,
    /// which the CapacityEstimator uses to derive the absolute token capacity per tier.
    private func captureSnapshots(for usage: SubscriptionUsage) async {
        let now = Date()
        let history = payload.history.daily

        let captures: [(key: String, percent: Double?, resetsAt: Date?, effective: Double?)] = [
            ("five_hour", usage.fiveHourPercent, usage.fiveHourResetsAt, nil),
            ("seven_day", usage.sevenDayPercent, usage.sevenDayResetsAt,
             effectiveTokensInLast7Days(history: history, asOf: now)),
            ("seven_day_opus", usage.sevenDayOpusPercent, usage.sevenDayOpusResetsAt, nil),
            ("seven_day_sonnet", usage.sevenDaySonnetPercent, usage.sevenDaySonnetResetsAt, nil),
        ]
        for capture in captures {
            guard let percent = capture.percent, let resetsAt = capture.resetsAt else { continue }
            await SubscriptionSnapshotStore.record(SubscriptionSnapshot(
                windowKey: capture.key,
                percent: percent,
                resetsAt: resetsAt,
                capturedAt: now,
                effectiveTokens: capture.effective
            ))
        }

        await refreshCapacityEstimates()
    }

    /// Sum effective tokens (input + 5*output + cache_creation + 0.1*cache_read) across the
    /// last 7 days of dailyHistory. Used as the "tokens consumed in 7-day window" reading paired
    /// with the API-reported percent for capacity estimation.
    private func effectiveTokensInLast7Days(history: [DailyHistoryEntry], asOf now: Date) -> Double {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = .current
        let cutoff = f.string(from: now.addingTimeInterval(-7 * 86400))
        return history
            .filter { $0.date >= cutoff }
            .reduce(0.0) { $0 + $1.effectiveTokens }
    }

    /// Run CapacityEstimator over each window's accumulated snapshots. Only snapshots with a
    /// non-nil effectiveTokens contribute. Result lives in capacityEstimates dict for UI gating.
    private func refreshCapacityEstimates() async {
        var next: [String: CapacityEstimate] = [:]
        for key in ["seven_day", "seven_day_opus", "seven_day_sonnet"] {
            let snaps = await SubscriptionSnapshotStore.snapshots(for: key)
            let capacitySnaps = snaps.compactMap { s -> CapacitySnapshot? in
                guard let effective = s.effectiveTokens, effective > 0 else { return nil }
                return CapacitySnapshot(percent: s.percent, effectiveTokens: effective, capturedAt: s.capturedAt)
            }
            if let estimate = CapacityEstimator.estimate(capacitySnaps) {
                next[key] = estimate
            }
        }
        capacityEstimates = next
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

enum ProviderFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case claude = "Claude"
    case codex = "Codex"
    case cursor = "Cursor"
    case copilot = "Copilot"
    case droid = "Droid"
    case gemini = "Gemini"
    case kiro = "Kiro"
    case kiloCode = "KiloCode"
    case openclaw = "OpenClaw"
    case opencode = "OpenCode"
    case pi = "Pi"
    case qwen = "Qwen"
    case omp = "OMP"
    case rooCode = "Roo Code"

    var id: String { rawValue }

    var providerKeys: [String] {
        switch self {
        case .cursor: ["cursor", "cursor agent"]
        case .rooCode: ["roo-code", "roo code"]
        case .kiloCode: ["kilo-code", "kilocode"]
        case .openclaw: ["openclaw"]
        default: [rawValue.lowercased()]
        }
    }

    var cliArg: String {
        switch self {
        case .all: "all"
        case .claude: "claude"
        case .codex: "codex"
        case .cursor: "cursor"
        case .copilot: "copilot"
        case .droid: "droid"
        case .gemini: "gemini"
        case .kiloCode: "kilo-code"
        case .kiro: "kiro"
        case .openclaw: "openclaw"
        case .opencode: "opencode"
        case .pi: "pi"
        case .qwen: "qwen"
        case .omp: "omp"
        case .rooCode: "roo-code"
        }
    }
}

enum SubscriptionLoadState: Sendable, Equatable {
    case idle           // never tried, awaiting user intent
    case loading        // fetch in progress
    case loaded         // success; subscription is populated
    case noCredentials  // tried; user has no Claude OAuth (API user / not logged in)
    case failed         // tried; non-recoverable transient error
    case terminalFailure(reason: String?)  // refresh-token invalid; user must reconnect
    case transientFailure                  // anthropic flaky; backing off
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
    case all = "6 Months"

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

@MainActor extension Double {
    func asCurrency() -> String {
        let state = CurrencyState.shared
        let converted = self * state.rate
        return state.symbol + (groupedDecimalFormatter.string(from: NSNumber(value: converted)) ?? "\(converted)")
    }

    func asCompactCurrency() -> String {
        let state = CurrencyState.shared
        return String(format: "\(state.symbol)%.2f", self * state.rate)
    }

    func asCompactCurrencyWhole() -> String {
        let state = CurrencyState.shared
        return "\(state.symbol)\(Int((self * state.rate).rounded()))"
    }
}

extension Int {
    func asThousandsSeparated() -> String {
        thousandsFormatter.string(from: NSNumber(value: self)) ?? "\(self)"
    }
}
