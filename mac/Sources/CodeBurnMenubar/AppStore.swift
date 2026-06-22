import Foundation
import Observation

private let cacheTTLSeconds: TimeInterval = 30
private let interactiveRefreshResetSeconds: TimeInterval = 120
private let menubarPeriodDefaultsKey = "CodeBurnMenubarPeriod"

struct CachedPayload {
    let payload: MenubarPayload
    let fetchedAt: Date
    var isFresh: Bool { Date().timeIntervalSince(fetchedAt) < cacheTTLSeconds }
}

struct PayloadCacheKey: Hashable {
    let period: Period
    let provider: ProviderFilter
    let day: String?
    let days: Set<String>

    init(period: Period, provider: ProviderFilter, day: String? = nil, days: Set<String> = []) {
        self.period = period
        self.provider = provider
        self.day = days.count <= 1 ? (day ?? days.first) : nil
        self.days = days.count > 1 ? days : []
    }

    var label: String {
        if !days.isEmpty, let first = days.min(), let last = days.max() {
            return "\(first)..\(last)"
        }
        return day.map { "Day(\($0))" } ?? period.rawValue
    }
}

@MainActor
@Observable
final class AppStore {
    var selectedProvider: ProviderFilter = .all
    var selectedPeriod: Period = .today
    var selectedDays: Set<String> = []

    var selectedDay: String? {
        guard selectedDays.count == 1 else { return nil }
        return selectedDays.first
    }
    private(set) var menubarPeriod: Period = Period.savedMenubarPeriod() {
        didSet { menubarPeriod.persistAsMenubarDefault() }
    }
    var selectedInsight: InsightMode = .trend
    var accentPreset: AccentPreset = ThemeState.shared.preset {
        didSet { ThemeState.shared.preset = accentPreset }
    }
    var showingAccentPicker: Bool = false
    var currency: String = "USD"
    /// Which Settings tab to show; lets the menu's "About CodeBurn" item jump
    /// straight to the About tab even when the Settings window is reused.
    var settingsTab: String = "general"
    var displayMetric: DisplayMetric = DisplayMetric(rawValue: UserDefaults.standard.string(forKey: "CodeBurnDisplayMetric") ?? "") ?? .cost {
        didSet { UserDefaults.standard.set(displayMetric.rawValue, forKey: "CodeBurnDisplayMetric") }
    }
    var dailyBudget: Double = UserDefaults.standard.double(forKey: "CodeBurnDailyBudget") {
        didSet { UserDefaults.standard.set(dailyBudget, forKey: "CodeBurnDailyBudget") }
    }
    // Token-denominated daily budget, used when the display metric is token-based.
    // Stored separately from the cost budget so switching metric never reinterprets
    // a dollar threshold as a token count (or vice versa).
    var dailyTokenBudget: Double = UserDefaults.standard.double(forKey: "CodeBurnDailyTokenBudget") {
        didSet { UserDefaults.standard.set(dailyTokenBudget, forKey: "CodeBurnDailyTokenBudget") }
    }

    /// True when the menubar metric counts tokens rather than cost.
    var isTokenMetric: Bool { displayMetric == .tokens || displayMetric == .totalTokens }

    /// Active daily-budget threshold for the current metric: a token count when
    /// tracking tokens, otherwise USD cost. 0 means the alert is off.
    var activeDailyBudget: Double { isTokenMetric ? dailyTokenBudget : dailyBudget }

    /// Today's total in the active metric (USD cost, or input+output tokens),
    /// or nil when today's payload has not loaded yet.
    var todayMetricTotal: Double? {
        guard let current = todayPayload?.current else { return nil }
        return isTokenMetric ? Double(current.inputTokens + current.outputTokens) : current.cost
    }

    /// True when today's usage has reached or passed the active daily budget.
    var isOverDailyBudget: Bool {
        guard activeDailyBudget > 0, let total = todayMetricTotal else { return false }
        return total >= activeDailyBudget
    }

    /// The active daily-budget threshold formatted for display (tokens, or USD).
    /// The cost budget is defined in USD (matching the "$" presets and field), so
    /// it is not run through the display-currency conversion here.
    var dailyBudgetLabel: String {
        isTokenMetric ? "\(activeDailyBudget.asCompactTokens()) tokens" : activeDailyBudget.asUSD()
    }

    var isLoading: Bool { loadingCountsByKey.values.contains { $0 > 0 } }
    var isCurrentKeyLoading: Bool { loadingCountsByKey[currentKey, default: 0] > 0 }
    var hasAttemptedCurrentKeyLoad: Bool { attemptedKeys.contains(currentKey) }
    var lastError: String? { lastErrorByKey[currentKey] }
    private var loadingCountsByKey: [PayloadCacheKey: Int] = [:]
    private var loadingStartedAtByKey: [PayloadCacheKey: Date] = [:]
    private var attemptedKeys: Set<PayloadCacheKey> = []
    private var lastErrorByKey: [PayloadCacheKey: String] = [:]
    var subscription: SubscriptionUsage?
    var subscriptionError: String?
    var subscriptionLoadState: SubscriptionLoadState = ClaudeCredentialStore.isBootstrapCompleted ? .dormant : .notBootstrapped
    var capacityEstimates: [String: CapacityEstimate] = [:]

    var codexUsage: CodexUsage?
    var codexError: String?
    var codexLoadState: SubscriptionLoadState = CodexCredentialStore.isBootstrapCompleted ? .dormant : .notBootstrapped

    /// Generation tokens for the in-flight refresh tasks. Incremented on every
    /// disconnect / reset so a fetch that started before the disconnect cannot
    /// resume after the await and re-populate the freshly-cleared state.
    private var claudeRefreshGen: Int = 0
    private var codexRefreshGen: Int = 0

    private var cache: [PayloadCacheKey: CachedPayload] = [:]
    private var cacheDate: String = ""
    private var switchTask: Task<Void, Never>?
    private var payloadRefreshGeneration: UInt64 = 0
    /// Tracks the last successful fetch timestamp per key for stuck-loading
    /// diagnostics. NOT used for cache-freshness logic — `CachedPayload.fetchedAt`
    /// is authoritative there. This map persists across cache wipes (day
    /// rollover, etc.) so we can distinguish "fresh install, never fetched"
    /// from "cache was wiped 10 minutes ago and we still haven't refilled".
    private var lastSuccessByKey: [PayloadCacheKey: Date] = [:]

    static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = .current
        return formatter
    }()

    static func dayString(from date: Date) -> String {
        dayFormatter.string(from: date)
    }

    private func staleSecondsForKey(_ key: PayloadCacheKey) -> TimeInterval {
        guard let last = lastSuccessByKey[key] else { return .infinity }
        return Date().timeIntervalSince(last)
    }

    private var todayAllKey: PayloadCacheKey {
        PayloadCacheKey(period: .today, provider: .all, day: nil)
    }

    private var menubarStatusKey: PayloadCacheKey {
        PayloadCacheKey(period: menubarPeriod, provider: .all, day: nil)
    }

    private var currentKey: PayloadCacheKey {
        PayloadCacheKey(period: selectedPeriod, provider: selectedProvider, day: selectedDay, days: selectedDays)
    }

    var payload: MenubarPayload {
        cache[currentKey]?.payload ?? .empty
    }

    /// Today (across all providers) backs day-specific views in the popover.
    var todayPayload: MenubarPayload? {
        cache[todayAllKey]?.payload
    }

    var todayPayloadAgeSeconds: Int? {
        guard let cached = cache[todayAllKey] else { return nil }
        return Int(Date().timeIntervalSince(cached.fetchedAt))
    }

    var menubarPayloadAgeSeconds: Int? {
        guard let cached = cache[menubarStatusKey] else { return nil }
        return Int(Date().timeIntervalSince(cached.fetchedAt))
    }

    var needsStatusPayloadRefresh: Bool {
        cache[menubarStatusKey]?.isFresh != true
    }

    var menubarPayload: MenubarPayload? {
        cache[menubarStatusKey]?.payload
    }

    /// All-provider payload for the selected period. Used by the tab strip to show
    /// per-provider costs that match the active period, not just today.
    var periodAllPayload: MenubarPayload? {
        cache[PayloadCacheKey(period: selectedPeriod, provider: .all, day: selectedDay, days: selectedDays)]?.payload
    }

    var isDayMode: Bool {
        !selectedDays.isEmpty
    }

    var selectionLabel: String {
        if selectedDays.count > 1, let first = selectedDays.min(), let last = selectedDays.max() {
            return "\(selectedDays.count) days (\(first) .. \(last))"
        }
        return selectedDay.map { "Day (\($0))" } ?? selectedPeriod.rawValue
    }

    var trendPeriod: Period {
        isDayMode ? .today : selectedPeriod
    }

    var hasCachedData: Bool {
        cache[currentKey] != nil
    }

    var hasStaleLoading: Bool {
        let now = Date()
        return loadingStartedAtByKey.values.contains {
            now.timeIntervalSince($0) > loadingWatchdogSeconds
        }
    }

    var hasStaleInteractivePayload: Bool {
        staleInteractivePayloadAgeSeconds != nil
    }

    var hasMissingInteractivePayloadWithoutAttempt: Bool {
        cache[currentKey] == nil && !isCurrentKeyLoading && !hasAttemptedCurrentKeyLoad
    }

    var shouldResetInteractiveRefreshPipeline: Bool {
        hasStaleLoading || hasStaleInteractivePayload || hasMissingInteractivePayloadWithoutAttempt
    }

    var staleInteractivePayloadAgeSeconds: Int? {
        let keys = Set([
            currentKey,
            todayAllKey,
            PayloadCacheKey(period: selectedPeriod, provider: .all, day: selectedDay, days: selectedDays),
        ])
        let staleAges = keys.compactMap { key -> TimeInterval? in
            guard let cached = cache[key] else { return nil }
            let age = Date().timeIntervalSince(cached.fetchedAt)
            return age > interactiveRefreshResetSeconds ? age : nil
        }
        return staleAges.max().map(Int.init)
    }

    var needsInteractivePayloadRefresh: Bool {
        let periodAllKey = PayloadCacheKey(period: selectedPeriod, provider: .all, day: selectedDay, days: selectedDays)
        return cache[currentKey]?.isFresh != true ||
            cache[todayAllKey]?.isFresh != true ||
            cache[periodAllKey]?.isFresh != true ||
            hasStaleLoading
    }

    /// True if any cached payload reports at least one provider. Used to keep the
    /// AgentTabStrip visible across period/provider switches even when the current
    /// key's payload is briefly empty (e.g. immediately after a `switchTo` and
    /// before the new fetch lands).
    var hasAnyProvidersInCache: Bool {
        cache.values.contains { !$0.payload.current.providers.isEmpty }
    }

#if DEBUG
    func setCachedPayloadForTesting(_ payload: MenubarPayload, period: Period, provider: ProviderFilter, day: String? = nil, fetchedAt: Date) {
        cache[PayloadCacheKey(period: period, provider: provider, day: day)] = CachedPayload(payload: payload, fetchedAt: fetchedAt)
    }

    func seedInFlightForTesting(period: Period, provider: ProviderFilter, day: String? = nil, insertedAt: Date) {
        inFlightKeys[PayloadCacheKey(period: period, provider: provider, day: day)] = insertedAt
    }

    func isInFlightForTesting(period: Period, provider: ProviderFilter, day: String? = nil) -> Bool {
        inFlightKeys[PayloadCacheKey(period: period, provider: provider, day: day)] != nil
    }
#endif

    var findingsCount: Int {
        payload.optimize.findingCount
    }

    /// Switch to a period. Cancels any in-flight switch and fetches provider-specific +
    /// all-provider data in parallel so tab strip costs stay in sync with the hero.
    func switchTo(period: Period) {
        selectedPeriod = period
        selectedDays = []
        startInteractiveSelectionRefresh()
    }

    func switchToYesterday() {
        let yesterday = Calendar.current.date(byAdding: .day, value: -1, to: Date()) ?? Date()
        switchTo(day: yesterday)
    }

    func switchTo(day: Date) {
        let clamped = min(Calendar.current.startOfDay(for: day), Calendar.current.startOfDay(for: Date()))
        selectedDays = [Self.dayString(from: clamped)]
        startInteractiveSelectionRefresh()
    }

    func switchTo(days: Set<String>) {
        selectedDays = days
        startInteractiveSelectionRefresh()
    }

    func shiftSelectedDay(by delta: Int) {
        let base = selectedDayDate ?? Calendar.current.date(byAdding: .day, value: -1, to: Date()) ?? Date()
        let shifted = Calendar.current.date(byAdding: .day, value: delta, to: base) ?? base
        switchTo(day: shifted)
    }

    var selectedDayDate: Date? {
        guard let selectedDay else { return nil }
        return Self.dayFormatter.date(from: selectedDay)
    }

    var canShiftSelectedDayForward: Bool {
        guard let selectedDayDate else { return false }
        return Calendar.current.startOfDay(for: selectedDayDate) < Calendar.current.startOfDay(for: Date())
    }

    func setMenubarPeriod(_ period: Period) {
        guard Period.menubarMetricCases.contains(period) else { return }
        guard menubarPeriod != period else { return }
        menubarPeriod = period
        Task { [weak self] in
            await self?.refreshQuietly(period: period)
        }
    }

    /// Switch to a provider filter. Cancels any in-flight switch so rapid tab tapping only
    /// runs the CLI for the final selection. Fetches provider-specific and all-provider data
    /// in parallel so the tab strip costs stay in sync with the hero.
    func switchTo(provider: ProviderFilter) {
        selectedProvider = provider
        startInteractiveSelectionRefresh()
    }

    private func startInteractiveSelectionRefresh() {
        switchTask?.cancel()
        resetLoadingState()
        let period = selectedPeriod
        let provider = selectedProvider
        let day = selectedDay
        let days = selectedDays
        let key = PayloadCacheKey(period: period, provider: provider, day: day, days: days)
        lastErrorByKey[key] = nil
        switchTask = Task {
            if provider == .all {
                await refresh(key: key, includeOptimize: false, force: true, showLoading: true)
            } else {
                async let main: Void = refresh(key: key, includeOptimize: false, force: true, showLoading: true)
                async let all: Void = refreshQuietly(period: period, day: day)
                _ = await (main, all)
            }
        }
    }

    private var inFlightKeys: [PayloadCacheKey: Date] = [:]

    func resetLoadingState() {
        payloadRefreshGeneration &+= 1
        loadingCountsByKey.removeAll()
        loadingStartedAtByKey.removeAll()
        inFlightKeys.removeAll()
        attemptedKeys.removeAll()
    }

    func resetRefreshState(clearCache: Bool = false) {
        switchTask?.cancel()
        switchTask = nil
        resetLoadingState()
        attemptedKeys.removeAll()
        lastErrorByKey.removeAll()
        if clearCache {
            cache.removeAll()
        }
    }

    private let loadingWatchdogSeconds: TimeInterval = 60

    @discardableResult
    func clearStaleLoadingIfNeeded() -> Bool {
        let now = Date()
        let staleLoading = loadingStartedAtByKey.filter {
            now.timeIntervalSince($0.value) > loadingWatchdogSeconds
        }
        let staleInFlight = inFlightKeys.filter { (key, insertedAt) in
            now.timeIntervalSince(insertedAt) > loadingWatchdogSeconds &&
            loadingStartedAtByKey[key] == nil
        }
        guard !staleLoading.isEmpty || !staleInFlight.isEmpty else { return false }

        for (key, started) in staleLoading {
            NSLog("CodeBurn: loading stuck for %ds on %@/%@ — auto-clearing",
                  Int(now.timeIntervalSince(started)), key.label, key.provider.rawValue)
            loadingCountsByKey[key] = nil
            loadingStartedAtByKey[key] = nil
            inFlightKeys[key] = nil
            if cache[key] == nil {
                lastErrorByKey[key] = "Refresh took longer than expected. CodeBurn will keep retrying in the background."
            }
        }
        for (key, insertedAt) in staleInFlight {
            NSLog("CodeBurn: orphaned in-flight key stuck for %ds on %@/%@ — clearing",
                  Int(now.timeIntervalSince(insertedAt)), key.label, key.provider.rawValue)
            inFlightKeys[key] = nil
        }
        return true
    }

    private func beginLoading(for key: PayloadCacheKey) {
        if loadingCountsByKey[key, default: 0] == 0 {
            loadingStartedAtByKey[key] = Date()
        }
        loadingCountsByKey[key, default: 0] += 1
    }

    private func finishLoading(for key: PayloadCacheKey) {
        guard let count = loadingCountsByKey[key], count > 0 else { return }
        if count == 1 {
            loadingCountsByKey[key] = nil
            loadingStartedAtByKey[key] = nil
        } else {
            loadingCountsByKey[key] = count - 1
        }
    }

    private func currentCacheDate() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: Date())
    }

    private func invalidateStaleDayCache() {
        let today = currentCacheDate()
        if cacheDate != today {
            payloadRefreshGeneration &+= 1
            cache.removeAll()
            loadingCountsByKey.removeAll()
            loadingStartedAtByKey.removeAll()
            inFlightKeys.removeAll()
            attemptedKeys.removeAll()
            lastErrorByKey.removeAll()
            cacheDate = today
            NSLog("CodeBurn: reset menubar payload cache for new day %@", today)
        }
    }

    func invalidateCache() {
        cache.removeAll()
    }

    func recoverFromStuckLoading() async {
        guard prepareStuckLoadingRecovery() else { return }
        await refresh(key: currentKey, includeOptimize: false, force: true, showLoading: true)
    }

    /// Decides whether stuck-loading recovery should kick off a fresh fetch for
    /// the current key, preparing the loading bookkeeping when it can.
    ///
    /// A quiet refresh torn down across sleep/wake (or a generation reset) can
    /// leave an orphaned `inFlightKeys` entry behind. Without clearing stale
    /// state first the in-flight guard would bail on every retry, trapping the
    /// popover on the spinner forever. A healthy in-flight fetch (younger than
    /// the watchdog) is still respected so recovery never kills it.
    @discardableResult
    func prepareStuckLoadingRecovery() -> Bool {
        _ = clearStaleLoadingIfNeeded()
        let key = currentKey
        guard inFlightKeys[key] == nil else { return false }
        loadingCountsByKey[key] = nil
        loadingStartedAtByKey[key] = nil
        return true
    }

    func setRecoveryExhausted(for label: String) {
        lastErrorByKey[currentKey] = "Could not load \(label). Check that the codeburn CLI is installed and working."
    }

    func refresh(includeOptimize: Bool, force: Bool = false, showLoading: Bool = false) async {
        await refresh(key: currentKey, includeOptimize: includeOptimize, force: force, showLoading: showLoading)
    }

    private func refresh(key: PayloadCacheKey, includeOptimize: Bool, force: Bool = false, showLoading: Bool = false) async {
        invalidateStaleDayCache()
        let cacheDateAtStart = cacheDate
        let generationAtStart = payloadRefreshGeneration
        if Task.isCancelled { return }
        if !force, cache[key]?.isFresh == true { return }
        if inFlightKeys[key] != nil { return }
        inFlightKeys[key] = Date()
        attemptedKeys.insert(key)
        lastErrorByKey[key] = nil
        let didShowLoading = showLoading || cache[key] == nil
        if didShowLoading {
            beginLoading(for: key)
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
            NSLog("CodeBurn: refresh attempt for stale key \(key.label)/\(key.provider.rawValue) — last success was \(Int(staleSeconds))s ago")
        }
        defer {
            let abandonedAttempt = Task.isCancelled || generationAtStart != payloadRefreshGeneration
            inFlightKeys[key] = nil
            if didShowLoading {
                finishLoading(for: key)
            }
            if abandonedAttempt && cache[key] == nil && lastErrorByKey[key] == nil {
                attemptedKeys.remove(key)
            }
        }
        do {
            let fresh = try await DataClient.fetch(period: key.period, day: key.day, days: key.days, provider: key.provider, includeOptimize: includeOptimize)
            if generationAtStart != payloadRefreshGeneration {
                NSLog("CodeBurn: dropping fetch result for \(key.label)/\(key.provider.rawValue) — refresh pipeline reset mid-fetch")
                return
            }
            if Task.isCancelled {
                // Distinguish cancellation (user switched tabs mid-fetch) from
                // the silent-no-result path. Without this log, a cancelled
                // fetch leaves cache empty + lastError nil and the user sees
                // perpetual loading with nothing in the diagnostics.
                NSLog("CodeBurn: fetch for \(key.label)/\(key.provider.rawValue) cancelled before result was applied")
                return
            }
            // Day-rollover race guard: if the calendar date changed during the
            // fetch, this payload was computed against yesterday's date and
            // would pollute today's freshly-cleared cache. Drop it; the next
            // tick will refetch with today's data.
            if cacheDate != cacheDateAtStart || cacheDate != currentCacheDate() {
                invalidateStaleDayCache()
                NSLog("CodeBurn: dropping fetch result for \(key.label)/\(key.provider.rawValue) — calendar rolled mid-fetch")
                return
            }
            cache[key] = CachedPayload(payload: fresh, fetchedAt: Date())
            lastSuccessByKey[key] = Date()
            lastErrorByKey[key] = nil
        } catch {
            if Task.isCancelled { return }
            NSLog("CodeBurn: fetch failed for \(key.label)/\(key.provider.rawValue): \(error)")
            if includeOptimize, cache[key] == nil {
                do {
                    let fallback = try await DataClient.fetch(period: key.period, day: key.day, days: key.days, provider: key.provider, includeOptimize: false)
                    guard !Task.isCancelled else { return }
                    if generationAtStart != payloadRefreshGeneration { return }
                    if cacheDate != cacheDateAtStart || cacheDate != currentCacheDate() {
                        invalidateStaleDayCache()
                        return
                    }
                    cache[key] = CachedPayload(payload: fallback, fetchedAt: Date())
                    lastSuccessByKey[key] = Date()
                    lastErrorByKey[key] = nil
                    return
                } catch {
                    if Task.isCancelled { return }
                    NSLog("CodeBurn: fallback fetch also failed: \(error)")
                }
            }
            lastErrorByKey[key] = String(describing: error)
        }

        let allKey = PayloadCacheKey(period: key.period, provider: .all, day: key.day)
        if key != allKey, cache[allKey]?.isFresh != true {
            await refreshQuietly(period: key.period, day: key.day)
        }
    }

    /// Background refresh for a period other than the visible one (e.g. keeping today fresh for the menubar badge).
    /// Does not toggle isLoading, so the popover's loading overlay is unaffected.
    /// Always uses the .all provider since the menubar badge shows total spend.
    func refreshQuietly(period: Period, day: String? = nil, force: Bool = false) async {
        invalidateStaleDayCache()
        let key = PayloadCacheKey(period: period, provider: .all, day: day)
        if !force, cache[key]?.isFresh == true { return }
        if inFlightKeys[key] != nil { return }
        inFlightKeys[key] = Date()
        attemptedKeys.insert(key)
        let cacheDateAtStart = cacheDate
        let generationAtStart = payloadRefreshGeneration
        if day == nil && period == .today, let age = todayPayloadAgeSeconds, age > 120 {
            NSLog("CodeBurn: refreshing stale today status payload after %ds", age)
        }
        defer {
            inFlightKeys[key] = nil
        }
        do {
            let fresh = try await DataClient.fetch(period: period, day: day, provider: .all, includeOptimize: false)
            if generationAtStart != payloadRefreshGeneration {
                NSLog("CodeBurn: dropping quiet fetch result for \(key.label) — refresh pipeline reset mid-fetch")
                return
            }
            // Same day-rollover guard as refresh(): drop yesterday's payload if
            // the calendar rolled over during the fetch.
            if cacheDate != cacheDateAtStart || cacheDate != currentCacheDate() {
                invalidateStaleDayCache()
                return
            }
            cache[key] = CachedPayload(payload: fresh, fetchedAt: Date())
            lastSuccessByKey[key] = Date()
            lastErrorByKey[key] = nil
        } catch {
            NSLog("CodeBurn: quiet refresh failed for \(key.label): \(error)")
        }
    }

    /// User-initiated. Reads Claude's source (this is what triggers the macOS keychain
    func activateClaudeFromDormant() async {
        guard case .dormant = subscriptionLoadState else { return }
        await bootstrapSubscription()
    }

    func activateCodexFromDormant() async {
        guard case .dormant = codexLoadState else { return }
        await bootstrapCodex()
    }

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
        if case .dormant = subscriptionLoadState { return false }
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
        if case .dormant = codexLoadState { return false }
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
        if let usage = subscription, shouldIncludeCachedQuota(loadState: subscriptionLoadState) {
            let worst = [
                usage.fiveHourPercent,
                usage.sevenDayPercent,
                usage.sevenDayOpusPercent,
                usage.sevenDaySonnetPercent,
            ].compactMap { $0 }.max() ?? 0
            if worst > 0 { providers.append(("Claude", worst)) }
        }
        if let usage = codexUsage, shouldIncludeCachedQuota(loadState: codexLoadState) {
            let worst = max(usage.primary?.usedPercent ?? 0, usage.secondary?.usedPercent ?? 0)
            if worst > 0 { providers.append(("Codex", worst)) }
        }
        let worst = providers.map(\.percent).max() ?? 0
        let severity = QuotaSummary.severity(for: worst / 100)
        let sorted = providers.sorted { $0.percent > $1.percent }
        let warnings = sorted.filter { $0.percent >= 70 }
        return AggregateQuotaStatus(severity: severity, warnings: warnings)
    }

    private func shouldIncludeCachedQuota(loadState: SubscriptionLoadState) -> Bool {
        switch loadState {
        case .notBootstrapped, .dormant, .bootstrapping, .noCredentials:
            return false
        case .loading, .loaded, .failed, .terminalFailure, .transientFailure:
            return true
        }
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
            case .notBootstrapped, .dormant, .bootstrapping, .noCredentials: return .disconnected
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
            case .notBootstrapped, .dormant, .bootstrapping, .noCredentials: return .disconnected
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
    case USD, GBP, EUR, AUD, CAD, NZD, JPY, CNY, CHF, INR, BRL, SEK, SGD, HKD, KRW, MXN, ZAR, DKK
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
        case .CNY: "Chinese Yuan"
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
    case cline = "Cline"
    case codex = "Codex"
    case cursor = "Cursor"
    case cursorAgent = "Cursor Agent"
    case copilot = "Copilot"
    case devin = "Devin"
    case droid = "Droid"
    case gemini = "Gemini"
    case ibmBob = "IBM Bob"
    case kiro = "Kiro"
    case kimi = "Kimi"
    case kiloCode = "KiloCode"
    case openclaw = "OpenClaw"
    case opencode = "OpenCode"
    case pi = "Pi"
    case qwen = "Qwen"
    case omp = "OMP"
    case rooCode = "Roo Code"
    case crush = "Crush"
    case antigravity = "Antigravity"
    case goose = "Goose"
    case grok = "Grok"
    case hermes = "Hermes"
    case zcode = "ZCode"

    var id: String { rawValue }

    var providerKeys: [String] {
        switch self {
        case .cursor: ["cursor"]
        case .cursorAgent: ["cursor-agent", "cursor agent"]
        case .cline: ["cline"]
        case .rooCode: ["roo-code", "roo code"]
        case .kiloCode: ["kilo-code", "kilocode"]
        case .ibmBob: ["ibm-bob", "ibm bob"]
        case .openclaw: ["openclaw"]
        case .antigravity: ["antigravity"]
        case .goose: ["goose"]
        case .grok: ["grok", "grok build"]
        case .hermes: ["hermes", "hermes agent"]
        default: [rawValue.lowercased()]
        }
    }

    var cliArg: String {
        switch self {
        case .all: "all"
        case .claude: "claude"
        case .cline: "cline"
        case .codex: "codex"
        case .cursor: "cursor"
        case .cursorAgent: "cursor-agent"
        case .copilot: "copilot"
        case .devin: "devin"
        case .droid: "droid"
        case .gemini: "gemini"
        case .ibmBob: "ibm-bob"
        case .kiloCode: "kilo-code"
        case .kiro: "kiro"
        case .kimi: "kimi"
        case .openclaw: "openclaw"
        case .opencode: "opencode"
        case .pi: "pi"
        case .qwen: "qwen"
        case .omp: "omp"
        case .rooCode: "roo-code"
        case .crush: "crush"
        case .antigravity: "antigravity"
        case .goose: "goose"
        case .grok: "grok"
        case .hermes: "hermes"
        case .zcode: "zcode"
        }
    }
}

extension Notification.Name {
    static let codeBurnSubscriptionDisconnected = Notification.Name("com.codeburn.subscriptionDisconnected")
}

enum SubscriptionLoadState: Sendable, Equatable {
    case notBootstrapped  // no Keychain access yet — waiting for user to click Connect
    case dormant          // previously bootstrapped; keychain not yet accessed this session
    case bootstrapping    // user clicked Connect; reading Claude's keychain (PROMPTS)
    case loading          // background fetch in progress (subscription may already be populated)
    case loaded           // success; subscription is populated
    case noCredentials    // bootstrap tried; user has no Claude credentials at all
    case failed           // generic non-recoverable failure
    case terminalFailure(reason: String?)  // refresh-token invalid; user must reconnect
    case transientFailure(retryAt: Date?)  // 429 / network blip; backing off automatically
}

enum DisplayMetric: String {
    case cost, tokens, totalTokens, credits, iconOnly
}

enum InsightMode: String, CaseIterable, Identifiable {
    case plan = "Plan"
    case trend = "Trend"
    case forecast = "Forecast"
    case calendar = "Calendar"
    case pulse = "Pulse"
    case stats = "Stats"
    case optimize = "Optimize"
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

    static let menubarMetricCases: [Period] = [.today, .sevenDays, .month, .all]

    var menubarMetricLabel: String {
        switch self {
        case .today: "Today"
        case .sevenDays: "Week"
        case .thirtyDays: "30 Days"
        case .month: "Month"
        case .all: "6 Months"
        }
    }

    var menubarDefaultsValue: String {
        switch self {
        case .today: "today"
        case .sevenDays: "week"
        case .thirtyDays: "30days"
        case .month: "month"
        case .all: "sixMonths"
        }
    }

    init(menubarDefaultsValue: String?) {
        switch menubarDefaultsValue {
        case "today": self = .today
        case "week", "sevenDays": self = .sevenDays
        case "month": self = .month
        case "sixMonths", "all": self = .all
        default: self = .today
        }
    }

    static func savedMenubarPeriod(defaults: UserDefaults = .standard) -> Period {
        Period(menubarDefaultsValue: defaults.string(forKey: menubarPeriodDefaultsKey))
    }

    func persistAsMenubarDefault(defaults: UserDefaults = .standard) {
        let period = Period.menubarMetricCases.contains(self) ? self : Period.today
        defaults.set(period.menubarDefaultsValue, forKey: menubarPeriodDefaultsKey)
    }

    func menubarSuffix(compact: Bool) -> String {
        switch self {
        case .today: ""
        case .sevenDays: compact ? "/wk" : " / wk"
        case .thirtyDays: compact ? "/30d" : " / 30d"
        case .month: compact ? "/mo" : " / mo"
        case .all: compact ? "/6mo" : " / 6mo"
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

    func asCompactTokens() -> String {
        let n = self
        if n >= 1_000_000_000 { return String(format: "%.1fB", n / 1_000_000_000) }
        if n >= 1_000_000 { return String(format: "%.1fM", n / 1_000_000) }
        if n >= 1_000 { return String(format: "%.0fK", n / 1_000) }
        return String(format: "%.0f", n)
    }

    /// Formats a raw USD amount with a "$" and grouping, without applying the
    /// display-currency rate. Used for the USD-denominated daily budget.
    func asUSD() -> String {
        "$" + (groupedDecimalFormatter.string(from: NSNumber(value: self)) ?? "\(Int(self))")
    }
}

extension Int {
    func asThousandsSeparated() -> String {
        thousandsFormatter.string(from: NSNumber(value: self)) ?? "\(self)"
    }
}
