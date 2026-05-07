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
    var subscriptionLoadState: SubscriptionLoadState = ClaudeCredentialStore.isBootstrapCompleted ? .loading : .notBootstrapped
    var capacityEstimates: [String: CapacityEstimate] = [:]

    var codexUsage: CodexUsage?
    var codexError: String?
    var codexLoadState: SubscriptionLoadState = CodexCredentialStore.isBootstrapCompleted ? .loading : .notBootstrapped

    /// Generation tokens for the in-flight refresh tasks. Incremented on every
    /// disconnect / reset so a fetch that started before the disconnect cannot
    /// resume after the await and re-populate the freshly-cleared state.
    private var claudeRefreshGen: Int = 0
    private var codexRefreshGen: Int = 0

    private var cache: [PayloadCacheKey: CachedPayload] = [:]
    private var cacheDate: String = ""
    private var switchTask: Task<Void, Never>?
    /// Tracks the last successful fetch timestamp per key for stuck-loading
    /// diagnostics. NOT used for cache-freshness logic — `CachedPayload.fetchedAt`
    /// is authoritative there. This map persists across cache wipes (day
    /// rollover, etc.) so we can distinguish "fresh install, never fetched"
    /// from "cache was wiped 10 minutes ago and we still haven't refilled".
    private var lastSuccessByKey: [PayloadCacheKey: Date] = [:]

    private func staleSecondsForKey(_ key: PayloadCacheKey) -> TimeInterval {
        guard let last = lastSuccessByKey[key] else { return .infinity }
        return Date().timeIntervalSince(last)
    }

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

    func resetLoadingState() {
        loadingCount = 0
        inFlightKeys.removeAll()
    }

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
        // Diagnostic anchor: if this key has been empty for a long time (the
        // popover would currently be showing "Loading..."), log how stale the
        // miss is so the next time a user reports a stuck-loading bug we have
        // a concrete data point — "no successful fetch for (today, claude)
        // in 14 minutes" beats squinting at unified-log noise. We deliberately
        // skip the first-attempt case (no prior success ever, finite check
        // below filters .infinity) — that's just the cold path, not a bug.
        let staleSeconds = staleSecondsForKey(key)
        if staleSeconds.isFinite, staleSeconds > 120 {
            NSLog("CodeBurn: refresh attempt for stale key \(key.period.rawValue)/\(key.provider.rawValue) — last success was \(Int(staleSeconds))s ago")
        }
        defer {
            inFlightKeys.remove(key)
            if didShowLoading { loadingCount = max(loadingCount - 1, 0) }
        }
        do {
            let fresh = try await DataClient.fetch(period: key.period, provider: key.provider, includeOptimize: includeOptimize)
            if Task.isCancelled {
                // Distinguish cancellation (user switched tabs mid-fetch) from
                // the silent-no-result path. Without this log, a cancelled
                // fetch leaves cache empty + lastError nil and the user sees
                // perpetual loading with nothing in the diagnostics.
                NSLog("CodeBurn: fetch for \(key.period.rawValue)/\(key.provider.rawValue) cancelled before result was applied")
                return
            }
            // Day-rollover race guard: if the calendar date changed during the
            // fetch, this payload was computed against yesterday's date and
            // would pollute today's freshly-cleared cache. Drop it; the next
            // tick will refetch with today's data.
            if cacheDate != cacheDateAtStart {
                NSLog("CodeBurn: dropping fetch result for \(key.period.rawValue)/\(key.provider.rawValue) — calendar rolled mid-fetch")
                return
            }
            cache[key] = CachedPayload(payload: fresh, fetchedAt: Date())
            lastSuccessByKey[key] = Date()
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
                    lastSuccessByKey[key] = Date()
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

    /// User-initiated. Reads Claude's source (this is what triggers the macOS keychain
    /// prompt for `Claude Code-credentials`). Once successful, subsequent background
    /// refreshes go through our own keychain item without prompting.
    func bootstrapSubscription() async {
        subscriptionLoadState = .bootstrapping
        do {
            let usage = try await ClaudeSubscriptionService.bootstrap()
            subscription = usage
            subscriptionError = nil
            subscriptionLoadState = .loaded
            await captureSnapshots(for: usage)
        } catch let err as ClaudeSubscriptionService.FetchError {
            applyFetchError(err)
        } catch {
            subscriptionError = String(describing: error)
            subscriptionLoadState = .failed
        }
    }

    /// Background refresh. No-op if the user has not yet connected. Never triggers
    /// a keychain prompt — uses our own keychain item exclusively.
    func refreshSubscription() async {
        _ = await refreshSubscriptionReportingSuccess()
    }

    /// Same as `refreshSubscription` but returns whether the fetch produced a
    /// `.loaded` state, so the caller can anchor cadence timing on real success
    /// rather than every attempt.
    @discardableResult
    func refreshSubscriptionReportingSuccess() async -> Bool {
        guard ClaudeCredentialStore.isBootstrapCompleted else {
            if subscriptionLoadState != .notBootstrapped {
                subscriptionLoadState = .notBootstrapped
            }
            return false
        }
        let gen = claudeRefreshGen
        if subscription == nil { subscriptionLoadState = .loading }
        do {
            guard let usage = try await ClaudeSubscriptionService.refreshIfBootstrapped() else {
                return false
            }
            // Disconnect-during-fetch guard: if the user clicked Disconnect
            // while we were awaiting Anthropic, the generation token will
            // have advanced and we must drop this result instead of writing
            // it back over the freshly-cleared state.
            guard gen == claudeRefreshGen else { return false }
            subscription = usage
            subscriptionError = nil
            subscriptionLoadState = .loaded
            await captureSnapshots(for: usage)
            return true
        } catch let err as ClaudeSubscriptionService.FetchError {
            guard gen == claudeRefreshGen else { return false }
            applyFetchError(err)
            return false
        } catch {
            guard gen == claudeRefreshGen else { return false }
            subscriptionError = sanitizeForUI(String(describing: error))
            subscriptionLoadState = .failed
            return false
        }
    }

    /// User-initiated disconnect — clears our keychain item and bootstrap flag,
    /// plus all derived state so a reconnect (potentially under a different
    /// account or tier) starts clean. capacityEstimates and the snapshot store
    /// would otherwise contaminate "Based on last cycle" projections.
    func disconnectSubscription() {
        ClaudeSubscriptionService.disconnect()
        // Bump the generation token so any in-flight refreshSubscription that
        // resumes after this point detects the disconnect and discards its
        // result instead of re-populating the cleared state.
        claudeRefreshGen &+= 1
        subscription = nil
        subscriptionError = nil
        subscriptionLoadState = .notBootstrapped
        capacityEstimates = [:]
        Task.detached { await SubscriptionSnapshotStore.clearAll() }
        // Notify the AppDelegate to clear its cadence-loop anchor so the next
        // reconnect doesn't measure against a pre-disconnect timestamp.
        NotificationCenter.default.post(name: .codeBurnSubscriptionDisconnected, object: nil)
    }

    // MARK: - Codex

    func bootstrapCodex() async {
        codexLoadState = .bootstrapping
        do {
            let usage = try await CodexSubscriptionService.bootstrap()
            codexUsage = usage
            codexError = nil
            codexLoadState = .loaded
        } catch let err as CodexSubscriptionService.FetchError {
            applyCodexFetchError(err)
        } catch {
            codexError = sanitizeForUI(String(describing: error))
            codexLoadState = .failed
        }
    }

    func refreshCodex() async {
        _ = await refreshCodexReportingSuccess()
    }

    @discardableResult
    func refreshCodexReportingSuccess() async -> Bool {
        guard CodexCredentialStore.isBootstrapCompleted else {
            if codexLoadState != .notBootstrapped { codexLoadState = .notBootstrapped }
            return false
        }
        let gen = codexRefreshGen
        if codexUsage == nil { codexLoadState = .loading }
        do {
            guard let usage = try await CodexSubscriptionService.refreshIfBootstrapped() else {
                return false
            }
            guard gen == codexRefreshGen else { return false }
            codexUsage = usage
            codexError = nil
            codexLoadState = .loaded
            return true
        } catch let err as CodexSubscriptionService.FetchError {
            guard gen == codexRefreshGen else { return false }
            applyCodexFetchError(err)
            return false
        } catch {
            guard gen == codexRefreshGen else { return false }
            codexError = sanitizeForUI(String(describing: error))
            codexLoadState = .failed
            return false
        }
    }

    func disconnectCodex() {
        CodexSubscriptionService.disconnect()
        codexRefreshGen &+= 1
        codexUsage = nil
        codexError = nil
        codexLoadState = .notBootstrapped
        NotificationCenter.default.post(name: .codeBurnSubscriptionDisconnected, object: nil)
    }

    private func applyCodexFetchError(_ err: CodexSubscriptionService.FetchError) {
        let sanitized = sanitizeForUI(err.errorDescription)
        codexError = sanitized
        if err.isTerminal {
            codexLoadState = .terminalFailure(reason: sanitized)
        } else if let retryAt = err.rateLimitRetryAt {
            codexLoadState = .transientFailure(retryAt: retryAt)
        } else if case .notBootstrapped = err {
            codexLoadState = .notBootstrapped
        } else if case let .bootstrapFailed(storeErr) = err, case .bootstrapNoSource = storeErr {
            codexLoadState = .noCredentials
        } else {
            codexLoadState = .failed
        }
    }

    private func applyFetchError(_ err: ClaudeSubscriptionService.FetchError) {
        let sanitized = sanitizeForUI(err.errorDescription)
        subscriptionError = sanitized
        if err.isTerminal {
            subscriptionLoadState = .terminalFailure(reason: sanitized)
        } else if let retryAt = err.rateLimitRetryAt {
            subscriptionLoadState = .transientFailure(retryAt: retryAt)
        } else if case .notBootstrapped = err {
            subscriptionLoadState = .notBootstrapped
        } else if case let .bootstrapFailed(storeErr) = err, case .bootstrapNoSource = storeErr {
            subscriptionLoadState = .noCredentials
        } else {
            subscriptionLoadState = .failed
        }
    }

    /// Strip control characters and any token-shaped substrings from server-error
    /// strings before they land in NSLog or the UI. Anthropic / OpenAI error
    /// envelopes don't typically echo tokens, but we also surface this in
    /// unified-log paths readable by other local users via `log stream`.
    private func sanitizeForUI(_ s: String?) -> String? {
        guard let s, !s.isEmpty else { return nil }
        var cleaned = s.replacingOccurrences(of: "\u{0000}", with: "")
        // Token-shaped redaction. Apply to all known auth-token formats so
        // an error body that quotes the request/response token is masked.
        let patterns: [(pattern: String, replacement: String)] = [
            (#"sk-ant-[A-Za-z0-9_-]+"#, "sk-ant-***"),
            (#"sk-[A-Za-z0-9_-]{16,}"#, "sk-***"),
            (#"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"#, "eyJ***"),
            (#"(?i)Bearer\s+\S+"#, "Bearer ***"),
        ]
        for entry in patterns {
            cleaned = cleaned.replacingOccurrences(of: entry.pattern, with: entry.replacement, options: .regularExpression)
        }
        // Cap length so a runaway server body cannot fill stderr.
        if cleaned.count > 240 { cleaned = String(cleaned.prefix(240)) + "…" }
        return cleaned
    }

    /// Snapshot of live quota state for a given provider. Returns nil when the user
    /// has not connected yet — the bar slot stays empty so we never trigger a
    /// keychain prompt at startup. Once bootstrapped, the bar persists across all
    /// subsequent states (loading / stale / transient failure / terminal failure)
    /// so it doesn't flicker on every refresh tick.
    /// Aggregate quota status across all connected providers, used by the menu
    /// bar flame icon (color) and the popover warning row. Severity = worst
    /// observed across any provider's worst window. Warning providers are
    /// every connected provider at >= 70% utilization.
    struct AggregateQuotaStatus {
        let severity: QuotaSummary.Severity
        let warnings: [(name: String, percent: Double)]   // sorted desc by percent
    }

    var aggregateQuotaStatus: AggregateQuotaStatus {
        var providers: [(name: String, percent: Double)] = []
        if case .loaded = subscriptionLoadState, let usage = subscription {
            let worst = [
                usage.fiveHourPercent,
                usage.sevenDayPercent,
                usage.sevenDayOpusPercent,
                usage.sevenDaySonnetPercent,
            ].compactMap { $0 }.max() ?? 0
            if worst > 0 { providers.append(("Claude", worst)) }
        }
        if case .loaded = codexLoadState, let usage = codexUsage {
            let worst = max(usage.primary?.usedPercent ?? 0, usage.secondary?.usedPercent ?? 0)
            if worst > 0 { providers.append(("Codex", worst)) }
        }
        let worst = providers.map(\.percent).max() ?? 0
        let severity = QuotaSummary.severity(for: worst / 100)
        let sorted = providers.sorted { $0.percent > $1.percent }
        let warnings = sorted.filter { $0.percent >= 70 }
        return AggregateQuotaStatus(severity: severity, warnings: warnings)
    }

    func quotaSummary(for filter: ProviderFilter) -> QuotaSummary? {
        switch filter {
        case .claude: return claudeQuotaSummary(filter: filter)
        case .codex:  return codexQuotaSummary(filter: filter)
        default:      return nil
        }
    }

    private func claudeQuotaSummary(filter: ProviderFilter) -> QuotaSummary? {
        if case .notBootstrapped = subscriptionLoadState { return nil }
        if case .bootstrapping = subscriptionLoadState { return nil }
        if case .noCredentials = subscriptionLoadState { return nil }

        let connection: QuotaSummary.Connection = {
            switch subscriptionLoadState {
            case .notBootstrapped, .bootstrapping, .noCredentials: return .disconnected
            case .loading: return subscription == nil ? .loading : .stale
            case .loaded: return .connected
            case .failed: return subscription == nil ? .loading : .stale
            case let .terminalFailure(reason): return .terminalFailure(reason: reason)
            case .transientFailure: return .transientFailure
            }
        }()

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
        let plan = subscription?.tier.displayName
        return QuotaSummary(providerFilter: filter, connection: connection, primary: primary, details: details, planLabel: plan, footerLines: [])
    }

    private func codexQuotaSummary(filter: ProviderFilter) -> QuotaSummary? {
        if case .notBootstrapped = codexLoadState { return nil }
        if case .bootstrapping = codexLoadState { return nil }
        if case .noCredentials = codexLoadState { return nil }

        let connection: QuotaSummary.Connection = {
            switch codexLoadState {
            case .notBootstrapped, .bootstrapping, .noCredentials: return .disconnected
            case .loading: return codexUsage == nil ? .loading : .stale
            case .loaded: return .connected
            case .failed: return codexUsage == nil ? .loading : .stale
            case let .terminalFailure(reason): return .terminalFailure(reason: reason)
            case .transientFailure: return .transientFailure
            }
        }()

        var primary: QuotaSummary.Window?
        var details: [QuotaSummary.Window] = []
        if let usage = codexUsage {
            if let w = usage.primary {
                let row = QuotaSummary.Window(label: w.windowLabel, percent: w.usedPercent / 100, resetsAt: w.resetsAt)
                primary = row
                details.append(row)
            }
            if let w = usage.secondary {
                let row = QuotaSummary.Window(label: w.windowLabel, percent: w.usedPercent / 100, resetsAt: w.resetsAt)
                // Some Codex plans (free / guest tiers) only return a secondary
                // window. Promote it to primary so the chip bar always has a
                // data source instead of rendering as an empty track.
                if primary == nil { primary = row }
                details.append(row)
            }
            // Surface per-model additional rate limits (e.g. "GPT-5.3-Codex-Spark")
            // only when the user has actually hit them. Skipping zero rows keeps
            // the popover compact for the common case where the user only uses
            // the main Codex window.
            for extra in usage.additionalLimits {
                if let p = extra.primary, p.usedPercent > 0 {
                    details.append(.init(label: "\(extra.name) · \(p.windowLabel)", percent: p.usedPercent / 100, resetsAt: p.resetsAt))
                }
                if let s = extra.secondary, s.usedPercent > 0 {
                    details.append(.init(label: "\(extra.name) · \(s.windowLabel)", percent: s.usedPercent / 100, resetsAt: s.resetsAt))
                }
            }
        }
        let plan = codexUsage?.plan.displayName
        var footerLines: [String] = []
        if let balance = codexUsage?.creditsBalance, balance > 0 {
            // Format as plain dollars; ChatGPT settles in USD regardless of
            // the user's display-currency preference.
            let formatter = NumberFormatter()
            formatter.numberStyle = .currency
            formatter.currencyCode = "USD"
            formatter.maximumFractionDigits = 2
            let formatted = formatter.string(from: NSNumber(value: balance)) ?? "$\(balance)"
            footerLines.append("Credits remaining · \(formatted)")
        }
        return QuotaSummary(providerFilter: filter, connection: connection, primary: primary, details: details, planLabel: plan, footerLines: footerLines)
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

extension Notification.Name {
    static let codeBurnSubscriptionDisconnected = Notification.Name("com.codeburn.subscriptionDisconnected")
}

enum SubscriptionLoadState: Sendable, Equatable {
    case notBootstrapped  // no Keychain access yet — waiting for user to click Connect
    case bootstrapping    // user clicked Connect; reading Claude's keychain (PROMPTS)
    case loading          // background fetch in progress (subscription may already be populated)
    case loaded           // success; subscription is populated
    case noCredentials    // bootstrap tried; user has no Claude credentials at all
    case failed           // generic non-recoverable failure
    case terminalFailure(reason: String?)  // refresh-token invalid; user must reconnect
    case transientFailure(retryAt: Date?)  // 429 / network blip; backing off automatically
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
