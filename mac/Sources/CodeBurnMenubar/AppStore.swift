import Foundation
import Observation

private let cacheTTLSeconds: TimeInterval = 30
private let interactiveRefreshResetSeconds: TimeInterval = 120
private let menubarPeriodDefaultsKey = "CodeBurnMenubarPeriod"

struct CachedPayload {
    let payload: MenubarPayload
    let fetchedAt: Date
    /// This scoped payload still disagreed with its all-provider slice after a
    /// resident-bypassing one-shot re-parse. It is the best answer the CLI can
    /// give, so it is served rather than discarded, with the UI saying so.
    var contradictsAll: Bool = false
    var isFresh: Bool { Date().timeIntervalSince(fetchedAt) < cacheTTLSeconds }
}

struct PayloadCacheKey: Hashable {
    let scope: MenubarScope
    let period: Period
    let provider: ProviderFilter
    let day: String?
    let days: Set<String>
    let claudeConfigSourceId: String?

    init(scope: MenubarScope = .local,
         period: Period,
         provider: ProviderFilter,
         day: String? = nil,
         days: Set<String> = [],
         claudeConfigSourceId: String? = nil) {
        self.scope = scope
        self.period = period
        self.provider = provider
        self.day = days.count <= 1 ? (day ?? days.first) : nil
        self.days = days.count > 1 ? days : []
        self.claudeConfigSourceId = claudeConfigSourceId
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
    var selectedScope: MenubarScope = MenubarScope.savedMenubarScope()
    var selectedClaudeConfigSourceId: String?
    var selectedDays: Set<String> = []
    /// True while the status-item popover is on screen. The popover's hosting
    /// view is created once and lives forever, so repeat-forever animations
    /// must gate on this or they render at display cadence around the clock.
    var menuPopoverVisible = false
    var activeScope: MenubarScope { effectiveSelectedScope }

    private var effectiveSelectedScope: MenubarScope {
        selectedDays.count > 1 ? .local : selectedScope
    }

    var selectedDay: String? {
        guard selectedDays.count == 1 else { return nil }
        return selectedDays.first
    }
    private(set) var menubarPeriod: Period = Period.savedMenubarPeriod() {
        didSet { menubarPeriod.persistAsMenubarDefault() }
    }
    private(set) var menubarScope: MenubarScope = MenubarScope.savedMenubarScope() {
        didSet { menubarScope.persistAsMenubarDefault() }
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

    var shouldShowDailyBudgetWarning: Bool {
        isOverDailyBudget && activeScope == .local
    }

    /// The active daily-budget threshold formatted for display (tokens, or USD).
    /// The cost budget is defined in USD (matching the "$" presets and field), so
    /// it is not run through the display-currency conversion here.
    var dailyBudgetLabel: String {
        isTokenMetric ? L("\(activeDailyBudget.asCompactTokens()) tokens") : activeDailyBudget.asUSD()
    }

    var isLoading: Bool { loadingCountsByKey.values.contains { $0 > 0 } }
    var isCurrentKeyLoading: Bool { loadingCountsByKey[currentKey, default: 0] > 0 }
    var hasAttemptedCurrentKeyLoad: Bool {
        attemptedKeys.contains(currentKey) ||
            (effectiveSelectedScope == .combined && attemptedKeys.contains(localCurrentKey))
    }
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
    var codexLoadState: SubscriptionLoadState = (
        CodexCredentialStore.isBootstrapCompleted || CodexCredentialStore.hasCredentialSource
    ) ? .dormant : .notBootstrapped

    var kimiUsage: KimiUsage?
    var kimiError: String?
    // No keychain dance for Kimi — "connected" just means the CLI's
    // credential file exists, so we start dormant and auto-activate on the
    // first refresh tick.
    var kimiLoadState: SubscriptionLoadState = KimiSubscriptionService.hasCredential ? .dormant : .notBootstrapped

    var geminiUsage: GeminiUsage?
    var geminiError: String?
    // Same file-based activation as Kimi — reading ~/.gemini/oauth_creds.json
    // is prompt-free, so we start dormant and auto-activate on the first
    // refresh tick.
    var geminiLoadState: SubscriptionLoadState = GeminiSubscriptionService.hasCredential ? .dormant : .notBootstrapped

    var copilotUsage: CopilotUsage?
    var copilotError: String?
    // Same file-based activation as Kimi/Gemini — reading
    // Copilot discovery never raises a keychain prompt, so we start dormant and
    // auto-activate on the first refresh tick.
    var copilotLoadState: SubscriptionLoadState = CopilotSubscriptionService.hasCredential ? .dormant : .notBootstrapped

    var antigravityUsage: AntigravityUsage?
    var antigravityError: String?
    // No credential file at all — quota comes from probing the Antigravity
    // app's local language server, which is prompt-free, so we start dormant
    // and auto-activate (probe) on the first refresh tick.
    var antigravityLoadState: SubscriptionLoadState = .dormant

    /// Runtime state for providers that do not use one of the original native
    /// bespoke CodeBurn adapter. Keys are stable provider IDs from
    /// `ProviderConnectionCatalog`.
    var capacityDockProviderSummaries: [String: QuotaSummary] = [:]
    var capacityDockProviderErrors: [String: String] = [:]
    var capacityDockProvidersLoading: Set<String> = []
    var capacityDockProviderTransientFailures: Set<String> = []
    private var capacityDockProviderRefreshGenerations: [String: UInt64] = [:]
    @ObservationIgnored var capacityDockProviderQuotaService = CapacityDockProviderQuotaService.shared
    @ObservationIgnored var capacityDockCredentialLoader:
        @Sendable (String) async throws -> CapacityDockProviderCredential = {
            try await CapacityDockProviderCredentialStore.loadAsync(for: $0)
        }
    @ObservationIgnored var capacityDockCredentialSaver:
        @Sendable (CapacityDockProviderCredential, String) async throws -> Void = {
            try await CapacityDockProviderCredentialStore.saveAsync($0, for: $1)
        }
    @ObservationIgnored var capacityDockCredentialRemover:
        @Sendable (String) async throws -> Void = {
            try await CapacityDockProviderCredentialStore.removeAsync(for: $0)
        }
    @ObservationIgnored var capacityDockProviderDeselector:
        (CapacityDockProvider) -> Void = {
            CapacityDockPreferences.removeProvider($0)
        }

    /// Generation tokens for the in-flight refresh tasks. Incremented on every
    /// disconnect / reset so a fetch that started before the disconnect cannot
    /// resume after the await and re-populate the freshly-cleared state.
    private var claudeRefreshGen: Int = 0
    private var codexRefreshGen: Int = 0
    private var kimiRefreshGen: Int = 0
    private var geminiRefreshGen: Int = 0
    private var copilotRefreshGen: Int = 0
    private var antigravityRefreshGen: Int = 0

    private var cache: [PayloadCacheKey: CachedPayload] = [:]
    private var cacheDate: String = ""
    private var switchTask: Task<Void, Never>?
    private var payloadRefreshGeneration: UInt64 = 0
#if DEBUG
    private var refreshSuppressedForTesting = false
#endif
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
        PayloadCacheKey(scope: .local, period: .today, provider: .all, day: nil)
    }

    private var menubarStatusKey: PayloadCacheKey {
        // Scope the menu-bar figure to the selected Claude config so the icon
        // matches the popover instead of always showing the merged All total.
        PayloadCacheKey(scope: .local, period: menubarPeriod, provider: .all, day: nil, claudeConfigSourceId: selectedClaudeConfigSourceId)
    }

    private var currentKey: PayloadCacheKey {
        PayloadCacheKey(
            scope: effectiveSelectedScope,
            period: selectedPeriod,
            provider: selectedProvider,
            day: selectedDay,
            days: selectedDays,
            claudeConfigSourceId: selectedClaudeConfigSourceId
        )
    }

    private var localCurrentKey: PayloadCacheKey {
        PayloadCacheKey(
            scope: .local,
            period: selectedPeriod,
            provider: selectedProvider,
            day: selectedDay,
            days: selectedDays,
            claudeConfigSourceId: selectedClaudeConfigSourceId
        )
    }

    private var periodAllKey: PayloadCacheKey {
        PayloadCacheKey(
            scope: .local,
            period: selectedPeriod,
            provider: .all,
            day: selectedDay,
            days: selectedDays,
            claudeConfigSourceId: selectedClaudeConfigSourceId
        )
    }

    /// Capture the keys that must describe one selection before any suspension
    /// point. Reading `periodAllKey` before an await and `currentKey` afterward
    /// can otherwise pair evidence from two different user selections.
    private func selectionRefreshKeys() -> (
        scoped: PayloadCacheKey,
        local: PayloadCacheKey,
        all: PayloadCacheKey
    ) {
        (scoped: currentKey, local: localCurrentKey, all: periodAllKey)
    }

    var payload: MenubarPayload {
        if effectiveSelectedScope == .combined {
            let combinedPayload = cache[currentKey]?.payload
            if let localPayload = consistentCachedPayload(for: localCurrentKey) {
                if let combined = combinedPayload?.combined {
                    return MenubarPayload(
                        generated: combinedPayload?.generated ?? localPayload.generated,
                        current: localPayload.current,
                        optimize: localPayload.optimize,
                        history: localPayload.history,
                        combined: combined,
                        claudeConfigs: localPayload.claudeConfigs
                    )
                }
                return localPayload
            }
            if let combinedPayload {
                return combinedPayload
            }
        }
        // No fallback to the PREVIOUS selection's payload. It belonged to a
        // different provider, so serving it under this tab printed another
        // provider's dollar figure as if it were this one's. Empty here means
        // `hasCachedData` is false and the popover renders its loading state.
        return consistentCachedPayload(for: currentKey) ?? .empty
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

    private var menubarCombinedKey: PayloadCacheKey {
        PayloadCacheKey(scope: .combined, period: menubarPeriod, provider: .all, day: nil, claudeConfigSourceId: selectedClaudeConfigSourceId)
    }

    /// Cross-device totals for the menubar badge's period, used so the badge
    /// figure matches the popover hero under combined scope. `nil` under local
    /// scope, or when no combined payload for the badge period is cached yet
    /// (cold start, or the peer is unreachable) — the badge then falls back to
    /// the local figure, exactly like the popover.
    var menubarBadgeCombined: CombinedUsageTotals? {
        guard effectiveSelectedScope == .combined else { return nil }
        return cache[menubarCombinedKey]?.payload.combined?.combined
    }

    /// `(reachable, total)` only when combined scope is active and fewer paired
    /// devices reported than are paired — i.e. the badge total is degraded to
    /// the reachable subset (a peer is asleep/off-network this cycle). The badge
    /// shows this so a momentary drop to the local figure reads as "peer
    /// unreachable", not a glitch. `nil` when every paired device reported (or
    /// there is only one), and under local scope.
    var menubarBadgeDeviceShortfall: (reachable: Int, total: Int)? {
        guard let totals = menubarBadgeCombined, totals.reachableCount < totals.deviceCount else { return nil }
        return (totals.reachableCount, totals.deviceCount)
    }

    /// Refresh the payloads the badge renders for `period`: always the local
    /// figure, plus the combined cross-device total when combined scope is
    /// active. Combined is best-effort — a slow or unreachable peer degrades to
    /// the local figure — so the local fetch alone determines success.
    @discardableResult
    func refreshMenubarBadge(period: Period, force: Bool = false, qualityOfService: QualityOfService = .userInitiated) async -> Bool {
        async let local = refreshQuietly(period: period, force: force, qualityOfService: qualityOfService)
        guard effectiveSelectedScope == .combined else { return await local }
        async let combined = refreshQuietly(
            key: PayloadCacheKey(scope: .combined, period: period, provider: .all, day: nil, claudeConfigSourceId: selectedClaudeConfigSourceId),
            includeOptimize: false,
            force: force,
            qualityOfService: qualityOfService
        )
        let (localSucceeded, _) = await (local, combined)
        return localSucceeded
    }

    /// All-provider payload for the selected period. Used by the tab strip to show
    /// per-provider costs that match the active period, not just today.
    var periodAllPayload: MenubarPayload? {
        cache[periodAllKey]?.payload
    }

    var claudeConfigOptions: [ClaudeConfigOption] {
        payload.claudeConfigs?.options
            ?? periodAllPayload?.claudeConfigs?.options
            ?? todayPayload?.claudeConfigs?.options
            ?? []
    }

    var shouldShowClaudeConfigSelector: Bool {
        claudeConfigOptions.count > 1
    }

    var isDayMode: Bool {
        !selectedDays.isEmpty
    }

    var selectionLabel: String {
        if selectedDays.count > 1, let first = selectedDays.min(), let last = selectedDays.max() {
            return L("\(selectedDays.count) days (\(first) .. \(last))")
        }
        return selectedDay.map { L("Day (\($0))") } ?? selectedPeriod.displayName
    }

    var trendPeriod: Period {
        isDayMode ? .today : selectedPeriod
    }

    var hasCachedData: Bool {
        consistentCachedPayload(for: currentKey) != nil
            || (effectiveSelectedScope == .combined && consistentCachedPayload(for: localCurrentKey) != nil)
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
        !hasCachedData && !isCurrentKeyLoading && !hasAttemptedCurrentKeyLoad
    }

    var shouldResetInteractiveRefreshPipeline: Bool {
        hasStaleLoading || hasStaleInteractivePayload || hasMissingInteractivePayloadWithoutAttempt
    }

    var staleInteractivePayloadAgeSeconds: Int? {
        let keys = Set([
            currentKey,
            localCurrentKey,
            todayAllKey,
            periodAllKey,
        ])
        let staleAges = keys.compactMap { key -> TimeInterval? in
            guard let cached = cache[key] else { return nil }
            let age = Date().timeIntervalSince(cached.fetchedAt)
            return age > interactiveRefreshResetSeconds ? age : nil
        }
        return staleAges.max().map(Int.init)
    }

    var needsInteractivePayloadRefresh: Bool {
        var requiredKeys: Set<PayloadCacheKey> = [currentKey, todayAllKey, periodAllKey]
        if effectiveSelectedScope == .combined {
            requiredKeys.insert(localCurrentKey)
        }
        return requiredKeys.contains { key in
            guard let cached = cache[key], cached.isFresh else { return true }
            return providerPayloadContradictsAll(cached.payload, for: key)
        } || hasStaleLoading
    }

    /// True if any cached payload reports at least one provider. Used to keep the
    /// AgentTabStrip visible across period/provider switches even when the current
    /// key's payload is briefly empty (e.g. immediately after a `switchTo` and
    /// before the new fetch lands).
    var hasAnyProvidersInCache: Bool {
        cache.values.contains { !$0.payload.current.providers.isEmpty }
    }

#if DEBUG
    func setCachedPayloadForTesting(_ payload: MenubarPayload,
                                    scope: MenubarScope = .local,
                                    period: Period,
                                    provider: ProviderFilter,
                                    day: String? = nil,
                                    days: Set<String> = [],
                                    claudeConfigSourceId: String? = nil,
                                    fetchedAt: Date) {
        cache[PayloadCacheKey(scope: scope, period: period, provider: provider, day: day, days: days, claudeConfigSourceId: claudeConfigSourceId)] = CachedPayload(payload: payload, fetchedAt: fetchedAt)
    }

    func cachedPayloadForTesting(scope: MenubarScope = .local,
                                 period: Period,
                                 provider: ProviderFilter,
                                 day: String? = nil,
                                 days: Set<String> = [],
                                 claudeConfigSourceId: String? = nil) -> MenubarPayload? {
        cache[PayloadCacheKey(scope: scope, period: period, provider: provider, day: day, days: days, claudeConfigSourceId: claudeConfigSourceId)]?.payload
    }

    func providerPayloadContradictsAllForTesting(_ payload: MenubarPayload,
                                                  scope: MenubarScope = .local,
                                                  period: Period,
                                                  provider: ProviderFilter,
                                                  day: String? = nil,
                                                  days: Set<String> = [],
                                                  claudeConfigSourceId: String? = nil) -> Bool {
        providerPayloadContradictsAll(
            payload,
            for: PayloadCacheKey(
                scope: scope,
                period: period,
                provider: provider,
                day: day,
                days: days,
                claudeConfigSourceId: claudeConfigSourceId
            )
        )
    }

    func setLastErrorForTesting(_ error: String,
                                scope: MenubarScope = .local,
                                period: Period,
                                provider: ProviderFilter,
                                day: String? = nil,
                                days: Set<String> = []) {
        lastErrorByKey[PayloadCacheKey(scope: scope, period: period, provider: provider, day: day, days: days)] = error
    }

    func seedInFlightForTesting(scope: MenubarScope = .local,
                                period: Period,
                                provider: ProviderFilter,
                                day: String? = nil,
                                insertedAt: Date) {
        inFlightKeys[PayloadCacheKey(scope: scope, period: period, provider: provider, day: day)] =
            InFlightSlot(startedAt: insertedAt, token: UUID())
    }

    func setCacheDateToTodayForTesting() {
        cacheDate = currentCacheDate()
    }

    func isInFlightForTesting(scope: MenubarScope = .local, period: Period, provider: ProviderFilter, day: String? = nil) -> Bool {
        inFlightKeys[PayloadCacheKey(scope: scope, period: period, provider: provider, day: day)] != nil
    }

    func refreshQuietlyForTesting(scope: MenubarScope = .local,
                                  period: Period,
                                  provider: ProviderFilter,
                                  day: String? = nil) async -> Bool {
        await refreshQuietly(
            key: PayloadCacheKey(scope: scope, period: period, provider: provider, day: day),
            includeOptimize: false
        )
    }

    func inFlightWaiterCountForTesting(scope: MenubarScope = .local,
                                       period: Period,
                                       provider: ProviderFilter,
                                       day: String? = nil) -> Int {
        inFlightWaiters[PayloadCacheKey(scope: scope, period: period, provider: provider, day: day)]?.count ?? 0
    }

    func finishInFlightForTesting(scope: MenubarScope = .local,
                                  period: Period,
                                  provider: ProviderFilter,
                                  day: String? = nil) {
        forceFinishInFlight(for: PayloadCacheKey(scope: scope, period: period, provider: provider, day: day))
    }

    func selectionRefreshKeysForTesting() -> (scoped: PayloadCacheKey, all: PayloadCacheKey) {
        let snapshot = selectionRefreshKeys()
        return (snapshot.scoped, snapshot.all)
    }

    func suppressRefreshesForTesting() {
        refreshSuppressedForTesting = true
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

    func setMenubarScope(_ scope: MenubarScope) {
        let shouldResetProvider = scope == .combined && selectedProvider != .all
        guard menubarScope != scope || selectedScope != scope || shouldResetProvider else { return }
        menubarScope = scope
        selectedScope = scope
        if shouldResetProvider {
            selectedProvider = .all
        }
        if scope == .combined {
            selectedClaudeConfigSourceId = nil
        }
#if DEBUG
        if refreshSuppressedForTesting { return }
#endif
        Task { [weak self] in
            guard let self else { return }
            await self.refreshSelectionQuietly(scope: self.effectiveSelectedScope, force: true)
        }
    }

    /// Switch to a provider filter immediately, then refresh stale data quietly.
    /// Existing content stays mounted while the background fetch runs, so a tab
    /// click never becomes a loading gate or resets unrelated in-flight work.
    func switchTo(provider: ProviderFilter) {
        selectedProvider = provider
        // A Claude config scope only applies to All/Claude views; picking any
        // other provider tab clears it (the CLI rejects the contradictory combo).
        if provider != .all && provider != .claude {
            selectedClaudeConfigSourceId = nil
        }
        startInteractiveSelectionRefresh()
    }

    func switchTo(claudeConfigSourceId: String?) {
        guard selectedClaudeConfigSourceId != claudeConfigSourceId else { return }
        selectedClaudeConfigSourceId = claudeConfigSourceId
        if claudeConfigSourceId != nil {
            selectedProvider = .all
            selectedScope = .local
        }
        startInteractiveSelectionRefresh()
    }

    func switchTo(scope: MenubarScope) {
        let shouldResetProvider = scope == .combined && selectedProvider != .all
        guard selectedScope != scope || shouldResetProvider else { return }
        selectedScope = scope
        if shouldResetProvider {
            selectedProvider = .all
        }
        if scope == .combined {
            selectedClaudeConfigSourceId = nil
        }
        startInteractiveSelectionRefresh()
    }

    private func startInteractiveSelectionRefresh() {
        switchTask?.cancel()
#if DEBUG
        if refreshSuppressedForTesting { return }
#endif
        let period = selectedPeriod
        let provider = selectedProvider
        let scope = effectiveSelectedScope
        let day = selectedDay
        let days = selectedDays
        let claudeConfigSourceId = selectedClaudeConfigSourceId
        let key = PayloadCacheKey(scope: scope, period: period, provider: provider, day: day, days: days, claudeConfigSourceId: claudeConfigSourceId)
        let localKey = PayloadCacheKey(scope: .local, period: period, provider: provider, day: day, days: days, claudeConfigSourceId: claudeConfigSourceId)
        let allKey = PayloadCacheKey(scope: .local, period: period, provider: .all, day: day, days: days, claudeConfigSourceId: claudeConfigSourceId)
        switchTask = Task { [weak self] in
            guard let self else { return }
            // The all-provider slice is the evidence that lets a scoped false
            // zero be rejected, so it must be present BEFORE the scoped result
            // is accepted. It does not have to be present before the scoped
            // fetch STARTS: both run together and only the acceptance is
            // ordered, via the gate passed as acceptAfter.
            let allTask: Task<Bool, Never>? = provider == .all
                ? nil
                : self.startAllProviderEvidence(key: allKey, force: false)
            let gate: (@Sendable () async -> Void)? = allTask.map { task in { @Sendable in _ = await task.value } }
            if scope == .combined {
                async let local = self.refresh(key: localKey, includeOptimize: false, force: false, showLoading: false, acceptAfter: gate)
                async let combined = self.refresh(key: key, includeOptimize: false, force: false, showLoading: false, acceptAfter: gate)
                _ = await (local, combined)
            } else {
                await self.refresh(key: key, includeOptimize: false, force: false, showLoading: false, acceptAfter: gate)
            }
            _ = await allTask?.value
        }
    }

    /// Start the all-provider fetch immediately and hand back its task, so a
    /// scoped fetch can run alongside it and merely AWAIT it before accepting.
    private func startAllProviderEvidence(
        key: PayloadCacheKey,
        force: Bool,
        qualityOfService: QualityOfService = .userInitiated
    ) -> Task<Bool, Never> {
        Task { [weak self] in
            guard let self else { return false }
            return await self.refreshQuietly(
                key: key,
                includeOptimize: false,
                force: force,
                qualityOfService: qualityOfService
            )
        }
    }

    /// One occupancy of a key's in-flight slot. The token identifies WHICH
    /// fetch owns the slot right now: the watchdog and the display-sleep reset
    /// can evict an occupant, after which a later fetch legitimately claims the
    /// same key. Without the token the evicted fetch's `defer` would then clear
    /// the NEW owner's slot and resume its waiters, so a task parked on the
    /// live fetch woke to an empty cache and reported failure.
    private struct InFlightSlot {
        let startedAt: Date
        let token: UUID
    }

    private var inFlightKeys: [PayloadCacheKey: InFlightSlot] = [:]
    private var inFlightWaiters: [PayloadCacheKey: [CheckedContinuation<Void, Never>]] = [:]

    private func waitForInFlight(_ key: PayloadCacheKey) async {
        guard inFlightKeys[key] != nil else { return }
        await withCheckedContinuation { continuation in
            guard inFlightKeys[key] != nil else {
                continuation.resume()
                return
            }
            inFlightWaiters[key, default: []].append(continuation)
        }
    }

    private func claimInFlight(_ key: PayloadCacheKey) -> UUID {
        let token = UUID()
        inFlightKeys[key] = InFlightSlot(startedAt: Date(), token: token)
        return token
    }

    /// Release the slot only if this fetch still owns it. A fetch whose slot was
    /// evicted has nothing left to release and no waiters of its own.
    private func finishInFlight(for key: PayloadCacheKey, token: UUID) {
        guard inFlightKeys[key]?.token == token else { return }
        forceFinishInFlight(for: key)
    }

    /// Evict whoever holds the slot and wake everyone parked on it. Only the
    /// watchdog and the pipeline resets use this: they are declaring the slot
    /// dead, not reporting a fetch that ended.
    private func forceFinishInFlight(for key: PayloadCacheKey) {
        inFlightKeys[key] = nil
        let waiters = inFlightWaiters.removeValue(forKey: key) ?? []
        for waiter in waiters {
            waiter.resume()
        }
    }

    private func finishAllInFlight() {
        let keys = Set(inFlightKeys.keys).union(inFlightWaiters.keys)
        for key in keys {
            forceFinishInFlight(for: key)
        }
    }

    func resetLoadingState() {
        payloadRefreshGeneration &+= 1
        loadingCountsByKey.removeAll()
        loadingStartedAtByKey.removeAll()
        finishAllInFlight()
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
        let staleInFlight = inFlightKeys.filter { (key, slot) in
            now.timeIntervalSince(slot.startedAt) > loadingWatchdogSeconds &&
            loadingStartedAtByKey[key] == nil
        }
        guard !staleLoading.isEmpty || !staleInFlight.isEmpty else { return false }

        for (key, started) in staleLoading {
            NSLog("CodeBurn: loading stuck for %ds on %@/%@ — auto-clearing",
                  Int(now.timeIntervalSince(started)), key.label, key.provider.rawValue)
            loadingCountsByKey[key] = nil
            loadingStartedAtByKey[key] = nil
            forceFinishInFlight(for: key)
            if cache[key] == nil {
                lastErrorByKey[key] = L("Refresh took longer than expected. CodeBurn will keep retrying in the background.")
            }
        }
        for (key, slot) in staleInFlight {
            NSLog("CodeBurn: orphaned in-flight key stuck for %ds on %@/%@ — clearing",
                  Int(now.timeIntervalSince(slot.startedAt)), key.label, key.provider.rawValue)
            forceFinishInFlight(for: key)
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
            finishAllInFlight()
            attemptedKeys.removeAll()
            lastErrorByKey.removeAll()
            cacheDate = today
            NSLog("CodeBurn: reset menubar payload cache for new day %@", today)
        }
    }

    func invalidateCache() {
        cache.removeAll()
    }

    private func reconcileClaudeConfigSelection(from payload: MenubarPayload, for key: PayloadCacheKey) {
        guard let selected = key.claudeConfigSourceId else { return }
        guard selectedClaudeConfigSourceId == selected else { return }
        let valid = payload.claudeConfigs?.options.contains { $0.id == selected } ?? false
        if !valid || payload.claudeConfigs?.selectedId != selected {
            selectedClaudeConfigSourceId = nil
        }
    }

    /// A cached payload the refresh paths may keep instead of refetching. A
    /// contradicting one is refetched; one already VERIFIED as contradicting is
    /// not, or every poll would re-run the expensive one-shot parse forever.
    private func cachedPayloadIsUsable(_ cached: CachedPayload, for key: PayloadCacheKey) -> Bool {
        cached.contradictsAll || !providerPayloadContradictsAll(cached.payload, for: key)
    }

    private func consistentCachedPayload(for key: PayloadCacheKey) -> MenubarPayload? {
        guard let cached = cache[key] else { return nil }
        // A payload already verified by a resident-bypassing re-parse is served
        // even though it still disagrees: it is the CLI's real answer, and
        // `selectedPayloadMayBeIncomplete` is what tells the user so.
        if cached.contradictsAll { return cached.payload }
        guard !providerPayloadContradictsAll(cached.payload, for: key) else { return nil }
        return cached.payload
    }

    /// The visible payload was verified against its all-provider slice and
    /// still disagreed. The popover shows one subdued line rather than an error.
    var selectedPayloadMayBeIncomplete: Bool {
        if cache[currentKey]?.contradictsAll == true { return true }
        return effectiveSelectedScope == .combined && cache[localCurrentKey]?.contradictsAll == true
    }

    /// An all-provider payload and its scoped sibling describe the same period,
    /// day selection, scope, and Claude config. If the all-provider slice has a
    /// positive contribution for the selected provider, a scoped 0/0 payload is
    /// stale or incomplete rather than an honest answer. This is the exact
    /// contract that prevents a provider tab advertising spend and then opening
    /// onto a fabricated zero.
    private func providerPayloadContradictsAll(_ payload: MenubarPayload, for key: PayloadCacheKey) -> Bool {
        guard key.scope == .local,
              key.provider != .all else { return false }

        let allKey = PayloadCacheKey(
            scope: .local,
            period: key.period,
            provider: .all,
            day: key.day,
            days: key.days,
            claudeConfigSourceId: key.claudeConfigSourceId
        )
        guard let all = cache[allKey]?.payload else { return false }
        let providerKeys = Set(key.provider.providerKeys + [key.provider.cliArg])
        let detail = all.current.providerDetails.first(where: {
            providerKeys.contains($0.id.lowercased()) || providerKeys.contains($0.label.lowercased())
        })
        let allCost = detail?.cost ?? key.provider.providerKeys.reduce(0.0) { sum, providerKey in
            sum + (all.current.providers[providerKey] ?? 0)
        }
        let allCalls = detail?.calls
        let allHasUsage = detail?.hasUsage ?? (allCost > 0)

        // Cost and call dimensions are independent. A scoped result that keeps
        // its calls but loses the spend (or vice versa) is still stale.
        if allCost > 0, payload.current.cost == 0 { return true }
        if let allCalls, allCalls > 0, payload.current.calls == 0 { return true }

        // `hasUsage` is authoritative for subscription/token-only providers,
        // where both cost and behavioral calls may legitimately be zero.
        let scopedDetail = payload.current.providerDetails.first(where: {
            providerKeys.contains($0.id.lowercased()) || providerKeys.contains($0.label.lowercased())
        })
        let scopedHasUsage = scopedDetail?.hasUsage ?? (
            payload.current.cost > 0
                || payload.current.calls > 0
                || payload.current.sessions > 0
                || payload.current.inputTokens > 0
                || payload.current.outputTokens > 0
        )
        return allHasUsage && !scopedHasUsage
    }

    private func fetchPayload(
        for key: PayloadCacheKey,
        includeOptimize: Bool,
        qualityOfService: QualityOfService,
        acceptAfter: (@Sendable () async -> Void)? = nil
    ) async throws -> (payload: MenubarPayload, contradictsAll: Bool) {
        let fresh = try await DataClient.fetch(
            period: key.period,
            day: key.day,
            days: key.days,
            provider: key.provider,
            includeOptimize: includeOptimize,
            scope: key.scope,
            claudeConfigSourceId: key.claudeConfigSourceId,
            qualityOfService: qualityOfService
        )
        // The all-provider slice is the evidence providerPayloadContradictsAll
        // reads. It is awaited HERE, after this fetch has already run, so the
        // two parses overlap and only the ACCEPTANCE is ordered. Waiting for it
        // before starting cost a full serialized parse on every tab click.
        await acceptAfter?()
        guard providerPayloadContradictsAll(fresh, for: key) else { return (fresh, false) }

        NSLog("CodeBurn: resident %@ payload contradicted its all-provider slice; verifying with a one-shot parse",
              key.provider.rawValue)
        let verified = try await DataClient.fetch(
            period: key.period,
            day: key.day,
            days: key.days,
            provider: key.provider,
            includeOptimize: includeOptimize,
            scope: key.scope,
            claudeConfigSourceId: key.claudeConfigSourceId,
            bypassResident: true,
            qualityOfService: qualityOfService
        )
        // A second contradiction is not an error to show the user. The one-shot
        // parse bypassed the resident child, so this IS what the CLI reports for
        // this provider right now; throwing here replaced a real number with an
        // error banner and left the tab with nothing at all. Serve it, flagged,
        // and let the popover add one subdued line saying it may be incomplete.
        let stillContradicts = providerPayloadContradictsAll(verified, for: key)
        if stillContradicts {
            NSLog("CodeBurn: verified %@ payload still contradicted its all-provider slice; serving it as possibly incomplete",
                  key.provider.rawValue)
        }
        return (verified, stillContradicts)
    }

    @discardableResult
    func recoverFromStuckLoading() async -> Bool {
        guard prepareStuckLoadingRecovery() else { return false }
        return await refresh(includeOptimize: false, force: true, showLoading: true)
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
        lastErrorByKey[currentKey] = L("Could not load \(label). Check that the codeburn CLI is installed and working.")
    }

    @discardableResult
    func refresh(
        includeOptimize: Bool,
        force: Bool = false,
        showLoading: Bool = false,
        qualityOfService: QualityOfService = .userInitiated
    ) async -> Bool {
        let keys = selectionRefreshKeys()
        // Runs concurrently with the scoped fetch below; only the acceptance is
        // ordered behind it (see fetchPayload's acceptAfter).
        let allTask: Task<Bool, Never>? = keys.scoped.provider == .all
            ? nil
            : startAllProviderEvidence(key: keys.all, force: force, qualityOfService: qualityOfService)
        let gate: (@Sendable () async -> Void)? = allTask.map { task in { @Sendable in _ = await task.value } }
        if keys.scoped.scope == .combined {
            async let local = refreshQuietly(
                key: keys.local,
                includeOptimize: includeOptimize,
                force: force,
                qualityOfService: qualityOfService,
                acceptAfter: gate
            )
            async let combined = refresh(
                key: keys.scoped,
                includeOptimize: includeOptimize,
                force: force,
                showLoading: showLoading,
                qualityOfService: qualityOfService,
                acceptAfter: gate
            )
            let (localSucceeded, combinedSucceeded) = await (local, combined)
            return localSucceeded && combinedSucceeded
        } else {
            return await refresh(
                key: keys.scoped,
                includeOptimize: includeOptimize,
                force: force,
                showLoading: showLoading,
                qualityOfService: qualityOfService,
                acceptAfter: gate
            )
        }
    }

    private func refreshSelectionQuietly(scope: MenubarScope, force: Bool = false) async {
        let scopedKey = PayloadCacheKey(
            scope: scope,
            period: selectedPeriod,
            provider: selectedProvider,
            day: selectedDay,
            days: selectedDays,
            claudeConfigSourceId: selectedClaudeConfigSourceId
        )
        let localKey = PayloadCacheKey(
            scope: .local,
            period: scopedKey.period,
            provider: scopedKey.provider,
            day: scopedKey.day,
            days: scopedKey.days,
            claudeConfigSourceId: scopedKey.claudeConfigSourceId
        )
        let allKey = PayloadCacheKey(
            scope: .local,
            period: scopedKey.period,
            provider: .all,
            day: scopedKey.day,
            days: scopedKey.days,
            claudeConfigSourceId: scopedKey.claudeConfigSourceId
        )
        let allTask: Task<Bool, Never>? = scopedKey.provider == .all
            ? nil
            : startAllProviderEvidence(key: allKey, force: force)
        let gate: (@Sendable () async -> Void)? = allTask.map { task in { @Sendable in _ = await task.value } }
        if scope == .combined {
            async let local = refreshQuietly(key: localKey, includeOptimize: false, force: false, acceptAfter: gate)
            async let combined = refreshQuietly(key: scopedKey, includeOptimize: false, force: force, acceptAfter: gate)
            _ = await (local, combined)
        } else {
            await refreshQuietly(key: scopedKey, includeOptimize: false, force: force, acceptAfter: gate)
        }
        _ = await allTask?.value
    }

    @discardableResult
    private func refresh(
        key: PayloadCacheKey,
        includeOptimize: Bool,
        force: Bool = false,
        showLoading: Bool = false,
        qualityOfService: QualityOfService = .userInitiated,
        acceptAfter: (@Sendable () async -> Void)? = nil
    ) async -> Bool {
        invalidateStaleDayCache()
        let cacheDateAtStart = cacheDate
        let generationAtStart = payloadRefreshGeneration
        if Task.isCancelled { return false }
        if !force,
           let cached = cache[key],
           cached.isFresh,
           cachedPayloadIsUsable(cached, for: key) { return true }
        // Join an in-flight fetch instead of reporting failure. Returning false
        // here made recoverFromStuckLoading() announce a failed recovery while a
        // perfectly healthy fetch was still running, which is what the quiet
        // path already avoided by waiting.
        if inFlightKeys[key] != nil {
            await waitForInFlight(key)
            return consistentCachedPayload(for: key) != nil
        }
        let inFlightToken = claimInFlight(key)
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
            finishInFlight(for: key, token: inFlightToken)
            if didShowLoading {
                finishLoading(for: key)
            }
            if abandonedAttempt && cache[key] == nil && lastErrorByKey[key] == nil {
                attemptedKeys.remove(key)
            }
        }
        var succeeded = false
        do {
            let fresh = try await fetchPayload(
                for: key,
                includeOptimize: includeOptimize,
                qualityOfService: qualityOfService,
                acceptAfter: acceptAfter
            )
            if generationAtStart != payloadRefreshGeneration {
                NSLog("CodeBurn: dropping fetch result for \(key.label)/\(key.provider.rawValue) — refresh pipeline reset mid-fetch")
                return false
            }
            if Task.isCancelled {
                // Distinguish cancellation (user switched tabs mid-fetch) from
                // the silent-no-result path. Without this log, a cancelled
                // fetch leaves cache empty + lastError nil and the user sees
                // perpetual loading with nothing in the diagnostics.
                NSLog("CodeBurn: fetch for \(key.label)/\(key.provider.rawValue) cancelled before result was applied")
                return false
            }
            // Day-rollover race guard: if the calendar date changed during the
            // fetch, this payload was computed against yesterday's date and
            // would pollute today's freshly-cleared cache. Drop it; the next
            // tick will refetch with today's data.
            if cacheDate != cacheDateAtStart || cacheDate != currentCacheDate() {
                invalidateStaleDayCache()
                NSLog("CodeBurn: dropping fetch result for \(key.label)/\(key.provider.rawValue) — calendar rolled mid-fetch")
                return false
            }
            cache[key] = CachedPayload(payload: fresh.payload, fetchedAt: Date(), contradictsAll: fresh.contradictsAll)
            reconcileClaudeConfigSelection(from: fresh.payload, for: key)
            lastSuccessByKey[key] = Date()
            lastErrorByKey[key] = nil
            succeeded = true
        } catch {
            if Task.isCancelled { return false }
            NSLog("CodeBurn: fetch failed for \(key.label)/\(key.provider.rawValue): \(error)")
            if includeOptimize, cache[key] == nil {
                do {
                    let fallback = try await fetchPayload(
                        for: key,
                        includeOptimize: false,
                        qualityOfService: qualityOfService
                    )
                    guard !Task.isCancelled else { return false }
                    if generationAtStart != payloadRefreshGeneration { return false }
                    if cacheDate != cacheDateAtStart || cacheDate != currentCacheDate() {
                        invalidateStaleDayCache()
                        return false
                    }
                    cache[key] = CachedPayload(payload: fallback.payload, fetchedAt: Date(), contradictsAll: fallback.contradictsAll)
                    reconcileClaudeConfigSelection(from: fallback.payload, for: key)
                    lastSuccessByKey[key] = Date()
                    lastErrorByKey[key] = nil
                    return true
                } catch {
                    if Task.isCancelled { return false }
                    NSLog("CodeBurn: fallback fetch also failed: \(error)")
                }
            }
            lastErrorByKey[key] = String(describing: error)
        }

        guard succeeded else { return false }

        let allKey = PayloadCacheKey(
            scope: .local,
            period: key.period,
            provider: .all,
            day: key.day,
            days: key.days,
            claudeConfigSourceId: key.claudeConfigSourceId
        )
        if key != allKey, cache[allKey]?.isFresh != true {
            await refreshQuietly(
                key: allKey,
                includeOptimize: false,
                force: false,
                qualityOfService: qualityOfService
            )
        }
        return true
    }

    /// Background refresh for a period other than the visible one (e.g. keeping today fresh for the menubar badge).
    /// Does not toggle isLoading, so the popover's loading overlay is unaffected.
    /// Always uses the .all provider since the menubar badge shows total spend.
    @discardableResult
    func refreshQuietly(
        period: Period,
        day: String? = nil,
        force: Bool = false,
        qualityOfService: QualityOfService = .userInitiated
    ) async -> Bool {
        // Scope the status-payload fetch to the selected config so the menu-bar
        // figure matches the popover (see menubarStatusKey).
        return await refreshQuietly(
            key: PayloadCacheKey(scope: .local, period: period, provider: .all, day: day, claudeConfigSourceId: selectedClaudeConfigSourceId),
            includeOptimize: false,
            force: force,
            qualityOfService: qualityOfService
        )
    }

    @discardableResult
    private func refreshQuietly(
        key: PayloadCacheKey,
        includeOptimize: Bool,
        force: Bool = false,
        qualityOfService: QualityOfService = .userInitiated,
        acceptAfter: (@Sendable () async -> Void)? = nil
    ) async -> Bool {
        invalidateStaleDayCache()
        if !force,
           let cached = cache[key],
           cached.isFresh,
           cachedPayloadIsUsable(cached, for: key) { return true }
        if inFlightKeys[key] != nil {
            await waitForInFlight(key)
            return consistentCachedPayload(for: key) != nil
        }
        let inFlightToken = claimInFlight(key)
        attemptedKeys.insert(key)
        let cacheDateAtStart = cacheDate
        let generationAtStart = payloadRefreshGeneration
        if key.day == nil && key.period == .today, let age = todayPayloadAgeSeconds, age > 120 {
            NSLog("CodeBurn: refreshing stale today status payload after %ds", age)
        }
        defer {
            finishInFlight(for: key, token: inFlightToken)
        }
        do {
            let fresh = try await fetchPayload(
                for: key,
                includeOptimize: includeOptimize,
                qualityOfService: qualityOfService,
                acceptAfter: acceptAfter
            )
            if generationAtStart != payloadRefreshGeneration {
                NSLog("CodeBurn: dropping quiet fetch result for \(key.label) — refresh pipeline reset mid-fetch")
                return false
            }
            // Same day-rollover guard as refresh(): drop yesterday's payload if
            // the calendar rolled over during the fetch.
            if cacheDate != cacheDateAtStart || cacheDate != currentCacheDate() {
                invalidateStaleDayCache()
                return false
            }
            cache[key] = CachedPayload(payload: fresh.payload, fetchedAt: Date(), contradictsAll: fresh.contradictsAll)
            reconcileClaudeConfigSelection(from: fresh.payload, for: key)
            lastSuccessByKey[key] = Date()
            lastErrorByKey[key] = nil
        } catch {
            NSLog("CodeBurn: quiet refresh failed for \(key.label): \(error)")
            if key.scope == .combined {
                lastErrorByKey[key] = String(describing: error)
            }
            return false
        }
        return true
    }

    /// User-initiated. Reuses Claude's source credential; only the source-owned
    /// Keychain access may ask for consent, and only on this explicit action.
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

    /// Background refresh. No-op if the user has not yet connected. Source reads
    /// are prompt-suppressed and any historical CodeBurn cache is fallback-only.
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
            subscriptionError = sanitizeForUI(error.localizedDescription)
            subscriptionLoadState = .failed
            return false
        }
    }

    /// User-initiated disconnect — clears CodeBurn continuity state, any legacy
    /// private cache, and the bootstrap flag,
    /// plus all derived state so a reconnect (potentially under a different
    /// account or tier) starts clean. capacityEstimates and the snapshot store
    /// would otherwise contaminate "Based on last cycle" projections.
    func disconnectSubscription() {
        let result = ClaudeSubscriptionService.disconnect()
        // Bump the generation token so any in-flight refreshSubscription that
        // resumes after this point detects the disconnect and discards its
        // result instead of re-populating the cleared state.
        claudeRefreshGen &+= 1
        guard result.isSuccess else {
            // Nothing was removed, so nothing is disconnected. Leave the
            // connected state exactly as it was — the bootstrap flag is still
            // set, Disconnect stays available, and the banner says to retry.
            subscriptionError = L("Could not fully remove the local Claude credential cache. Disconnect again to retry.")
            return
        }
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
            codexError = sanitizeForUI(error.localizedDescription)
            codexLoadState = .failed
        }
    }

    func refreshCodex() async {
        _ = await refreshCodexReportingSuccess()
    }

    @discardableResult
    func refreshCodexReportingSuccess() async -> Bool {
        if case .dormant = codexLoadState, !CodexCredentialStore.isBootstrapCompleted {
            await bootstrapCodex()
            return codexLoadState == .loaded
        }
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
            codexError = sanitizeForUI(error.localizedDescription)
            codexLoadState = .failed
            return false
        }
    }

    func disconnectCodex() {
        let result = CodexSubscriptionService.disconnect()
        codexRefreshGen &+= 1
        guard result.isSuccess else {
            // Nothing removed means nothing disconnected; keep state intact so
            // Disconnect stays available for a retry.
            codexError = L("Could not fully remove the local Codex credential cache. Disconnect again to retry.")
            return
        }
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

    // MARK: - Kimi Code

    /// Unlike Claude/Codex there is no keychain bootstrap: reading the CLI's
    /// credential file is prompt-free, so the first refresh tick activates
    /// the dormant state automatically.
    func bootstrapKimi() async {
        // Capture the generation before the await so a disconnect that lands
        // mid-fetch cannot be resurrected into .loaded when the fetch returns.
        let gen = kimiRefreshGen
        kimiLoadState = .bootstrapping
        do {
            let usage = try await KimiSubscriptionService.refresh()
            guard gen == kimiRefreshGen else { return }
            kimiUsage = usage
            kimiError = nil
            kimiLoadState = .loaded
        } catch let err as KimiSubscriptionService.FetchError {
            guard gen == kimiRefreshGen else { return }
            applyKimiFetchError(err)
        } catch {
            guard gen == kimiRefreshGen else { return }
            kimiError = sanitizeForUI(error.localizedDescription)
            kimiLoadState = .failed
        }
    }

    func refreshKimi() async {
        _ = await refreshKimiReportingSuccess()
    }

    @discardableResult
    func refreshKimiReportingSuccess() async -> Bool {
        if case .dormant = kimiLoadState {
            await bootstrapKimi()
            return kimiLoadState == .loaded
        }
        guard KimiSubscriptionService.hasCredential else {
            if kimiLoadState != .notBootstrapped { kimiLoadState = .notBootstrapped }
            return false
        }
        let gen = kimiRefreshGen
        if kimiUsage == nil { kimiLoadState = .loading }
        do {
            let usage = try await KimiSubscriptionService.refresh()
            guard gen == kimiRefreshGen else { return false }
            kimiUsage = usage
            kimiError = nil
            kimiLoadState = .loaded
            return true
        } catch let err as KimiSubscriptionService.FetchError {
            guard gen == kimiRefreshGen else { return false }
            applyKimiFetchError(err)
            return false
        } catch {
            guard gen == kimiRefreshGen else { return false }
            kimiError = sanitizeForUI(error.localizedDescription)
            kimiLoadState = .failed
            return false
        }
    }

    func disconnectKimi() {
        KimiSubscriptionService.disconnect()
        kimiRefreshGen &+= 1
        kimiUsage = nil
        kimiError = nil
        kimiLoadState = .notBootstrapped
        NotificationCenter.default.post(name: .codeBurnSubscriptionDisconnected, object: nil)
    }

    private func applyKimiFetchError(_ err: KimiSubscriptionService.FetchError) {
        let sanitized = sanitizeForUI(err.errorDescription)
        kimiError = sanitized
        if case .noCredentials = err {
            kimiLoadState = .noCredentials
        } else if err.isTerminal {
            kimiLoadState = .terminalFailure(reason: sanitized)
        } else if let retryAt = err.rateLimitRetryAt {
            kimiLoadState = .transientFailure(retryAt: retryAt)
        } else {
            kimiLoadState = .failed
        }
    }

    // MARK: - Gemini

    /// Same prompt-free activation as Kimi: reading the CLI's credential file
    /// needs no keychain, so the first refresh tick activates dormant state.
    func bootstrapGemini() async {
        // Capture the generation before the await so a disconnect that lands
        // mid-fetch cannot be resurrected into .loaded when the fetch returns.
        let gen = geminiRefreshGen
        geminiLoadState = .bootstrapping
        do {
            let usage = try await GeminiSubscriptionService.refresh()
            guard gen == geminiRefreshGen else { return }
            geminiUsage = usage
            geminiError = nil
            geminiLoadState = .loaded
        } catch let err as GeminiSubscriptionService.FetchError {
            guard gen == geminiRefreshGen else { return }
            applyGeminiFetchError(err)
        } catch {
            guard gen == geminiRefreshGen else { return }
            geminiError = sanitizeForUI(error.localizedDescription)
            geminiLoadState = .failed
        }
    }

    func refreshGemini() async {
        _ = await refreshGeminiReportingSuccess()
    }

    @discardableResult
    func refreshGeminiReportingSuccess() async -> Bool {
        if case .dormant = geminiLoadState {
            await bootstrapGemini()
            return geminiLoadState == .loaded
        }
        guard GeminiSubscriptionService.hasCredential else {
            if geminiLoadState != .notBootstrapped { geminiLoadState = .notBootstrapped }
            return false
        }
        let gen = geminiRefreshGen
        if geminiUsage == nil { geminiLoadState = .loading }
        do {
            let usage = try await GeminiSubscriptionService.refresh()
            guard gen == geminiRefreshGen else { return false }
            geminiUsage = usage
            geminiError = nil
            geminiLoadState = .loaded
            return true
        } catch let err as GeminiSubscriptionService.FetchError {
            guard gen == geminiRefreshGen else { return false }
            applyGeminiFetchError(err)
            return false
        } catch {
            guard gen == geminiRefreshGen else { return false }
            geminiError = sanitizeForUI(error.localizedDescription)
            geminiLoadState = .failed
            return false
        }
    }

    func disconnectGemini() {
        GeminiSubscriptionService.disconnect()
        geminiRefreshGen &+= 1
        geminiUsage = nil
        geminiError = nil
        geminiLoadState = .notBootstrapped
        NotificationCenter.default.post(name: .codeBurnSubscriptionDisconnected, object: nil)
    }

    private func applyGeminiFetchError(_ err: GeminiSubscriptionService.FetchError) {
        let sanitized = sanitizeForUI(err.errorDescription)
        geminiError = sanitized
        if case .noCredentials = err {
            geminiLoadState = .noCredentials
        } else if err.isTerminal {
            geminiLoadState = .terminalFailure(reason: sanitized)
        } else if let retryAt = err.rateLimitRetryAt {
            geminiLoadState = .transientFailure(retryAt: retryAt)
        } else {
            // 5xx / network blips back off automatically, mirroring the
            // Electron provider's transientFailure mapping.
            geminiLoadState = .transientFailure(retryAt: nil)
        }
    }

    // MARK: - Copilot

    /// Same prompt-free activation as Kimi/Gemini: the whole Copilot discovery
    /// chain is prompt-free, so the first refresh tick activates dormant state.
    func bootstrapCopilot() async {
        // Capture the generation before the await so a disconnect that lands
        // mid-fetch cannot be resurrected into .loaded when the fetch returns.
        let gen = copilotRefreshGen
        copilotLoadState = .bootstrapping
        do {
            let usage = try await CopilotSubscriptionService.refresh()
            guard gen == copilotRefreshGen else { return }
            copilotUsage = usage
            copilotError = nil
            copilotLoadState = .loaded
        } catch let err as CopilotSubscriptionService.FetchError {
            guard gen == copilotRefreshGen else { return }
            applyCopilotFetchError(err)
        } catch {
            guard gen == copilotRefreshGen else { return }
            copilotError = sanitizeForUI(error.localizedDescription)
            copilotLoadState = .failed
        }
    }

    func refreshCopilot() async {
        _ = await refreshCopilotReportingSuccess()
    }

    @discardableResult
    func refreshCopilotReportingSuccess() async -> Bool {
        if case .dormant = copilotLoadState {
            await bootstrapCopilot()
            return copilotLoadState == .loaded
        }
        guard CopilotSubscriptionService.hasCredential else {
            if copilotLoadState != .notBootstrapped { copilotLoadState = .notBootstrapped }
            return false
        }
        let gen = copilotRefreshGen
        if copilotUsage == nil { copilotLoadState = .loading }
        do {
            let usage = try await CopilotSubscriptionService.refresh()
            guard gen == copilotRefreshGen else { return false }
            copilotUsage = usage
            copilotError = nil
            copilotLoadState = .loaded
            return true
        } catch let err as CopilotSubscriptionService.FetchError {
            guard gen == copilotRefreshGen else { return false }
            applyCopilotFetchError(err)
            return false
        } catch {
            guard gen == copilotRefreshGen else { return false }
            copilotError = sanitizeForUI(error.localizedDescription)
            copilotLoadState = .failed
            return false
        }
    }

    func disconnectCopilot() {
        CopilotSubscriptionService.disconnect()
        copilotRefreshGen &+= 1
        copilotUsage = nil
        copilotError = nil
        copilotLoadState = .notBootstrapped
        NotificationCenter.default.post(name: .codeBurnSubscriptionDisconnected, object: nil)
    }

    private func applyCopilotFetchError(_ err: CopilotSubscriptionService.FetchError) {
        let sanitized = sanitizeForUI(err.errorDescription)
        copilotError = sanitized
        if case .noCredentials = err {
            copilotLoadState = .noCredentials
        } else if err.isTerminal {
            copilotLoadState = .terminalFailure(reason: sanitized)
        } else if let retryAt = err.rateLimitRetryAt {
            copilotLoadState = .transientFailure(retryAt: retryAt)
        } else {
            // 5xx / network blips and a rejected-but-unchanged token back off
            // automatically, mirroring the Electron provider's
            // transientFailure mapping.
            copilotLoadState = .transientFailure(retryAt: nil)
        }
    }

    // MARK: - Antigravity

    /// No credential dance at all: discovery is `ps` + loopback probes of the
    /// local language server, so the first refresh tick activates dormant
    /// state, like Kimi/Gemini/Copilot.
    func bootstrapAntigravity() async {
        // Capture the generation before the await so a disconnect that lands
        // mid-fetch cannot be resurrected into .loaded when the fetch returns.
        let gen = antigravityRefreshGen
        antigravityLoadState = .bootstrapping
        do {
            let usage = try await AntigravitySubscriptionService.refresh()
            guard gen == antigravityRefreshGen else { return }
            antigravityUsage = usage
            antigravityError = nil
            antigravityLoadState = .loaded
        } catch let err as AntigravitySubscriptionService.FetchError {
            guard gen == antigravityRefreshGen else { return }
            applyAntigravityFetchError(err)
        } catch {
            guard gen == antigravityRefreshGen else { return }
            antigravityError = sanitizeForUI(error.localizedDescription)
            antigravityLoadState = .failed
        }
    }

    func refreshAntigravity() async {
        _ = await refreshAntigravityReportingSuccess()
    }

    @discardableResult
    func refreshAntigravityReportingSuccess() async -> Bool {
        if case .dormant = antigravityLoadState {
            await bootstrapAntigravity()
            return antigravityLoadState == .loaded
        }
        // Only an explicit Disconnect stops the cadence probe; there is no
        // credential file to poll for, the probe IS the availability check.
        if case .notBootstrapped = antigravityLoadState { return false }
        let gen = antigravityRefreshGen
        if antigravityUsage == nil { antigravityLoadState = .loading }
        do {
            let usage = try await AntigravitySubscriptionService.refresh()
            guard gen == antigravityRefreshGen else { return false }
            antigravityUsage = usage
            antigravityError = nil
            antigravityLoadState = .loaded
            return true
        } catch let err as AntigravitySubscriptionService.FetchError {
            guard gen == antigravityRefreshGen else { return false }
            applyAntigravityFetchError(err)
            return false
        } catch {
            guard gen == antigravityRefreshGen else { return false }
            antigravityError = sanitizeForUI(error.localizedDescription)
            antigravityLoadState = .failed
            return false
        }
    }

    func disconnectAntigravity() {
        antigravityRefreshGen &+= 1
        antigravityUsage = nil
        antigravityError = nil
        antigravityLoadState = .notBootstrapped
        NotificationCenter.default.post(name: .codeBurnSubscriptionDisconnected, object: nil)
    }

    private func applyAntigravityFetchError(_ err: AntigravitySubscriptionService.FetchError) {
        let sanitized = sanitizeForUI(err.errorDescription)
        antigravityError = sanitized
        if case .disconnected = err {
            // No local server answered — the routine "app not running" state,
            // not an error; the UI shows the Connect affordance.
            antigravityLoadState = .noCredentials
        } else {
            // Unexpected discovery/probe failures back off automatically,
            // mirroring the Electron provider's transientFailure mapping.
            antigravityLoadState = .transientFailure(retryAt: nil)
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
    /// source-owned Keychain prompt at startup. Once bootstrapped, the bar persists across all
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
        if let usage = kimiUsage, shouldIncludeCachedQuota(loadState: kimiLoadState) {
            let worst = max(usage.primary?.usedPercent ?? 0, usage.details.map(\.usedPercent).max() ?? 0)
            if worst > 0 { providers.append(("Kimi Code", worst)) }
        }
        if let usage = geminiUsage, shouldIncludeCachedQuota(loadState: geminiLoadState) {
            let worst = usage.details.map(\.usedPercent).max() ?? 0
            if worst > 0 { providers.append(("Gemini", worst)) }
        }
        if let usage = copilotUsage, shouldIncludeCachedQuota(loadState: copilotLoadState) {
            let worst = usage.details.map(\.usedPercent).max() ?? 0
            if worst > 0 { providers.append(("Copilot", worst)) }
        }
        if let usage = antigravityUsage, shouldIncludeCachedQuota(loadState: antigravityLoadState) {
            let worst = usage.details.map(\.usedPercent).max() ?? 0
            if worst > 0 { providers.append(("Antigravity", worst)) }
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
        case .kimiCode: return kimiQuotaSummary(filter: filter)
        case .gemini:  return geminiQuotaSummary(filter: filter)
        case .copilot: return copilotQuotaSummary(filter: filter)
        case .antigravity: return antigravityQuotaSummary(filter: filter)
        default:      return nil
        }
    }

    /// Sessions the CLI reported as live under this provider, newest first. Nil
    /// when the payload carries no live-session block at all (a CLI that predates
    /// it), which the popover renders as an absent section rather than as
    /// "none running".
    func capacityDockLiveSessions(for provider: CapacityDockProvider) -> [LiveSession]? {
        guard let block = menubarPayload?.liveSessions else { return nil }
        return block.sessions.filter { $0.provider == provider.id }
    }

    /// Today's totals for the dock popover. The background loop keeps the
    /// menu-bar status payload fresh, so it wins whenever the badge is already
    /// scoped to today; otherwise fall back to the popover's own today cache.
    var capacityDockToday: CurrentBlock? {
        if menubarPeriod == .today, let payload = menubarPayload { return payload.current }
        return todayPayload?.current
    }

    /// Today's totals for ONE provider's glance card. The card is provider
    /// scoped, so the machine-wide `capacityDockToday` block is the wrong number
    /// in it; `providerDetails` carries the per-provider row.
    ///
    /// Nil when the payload has no provider breakdown at all (a CLI old enough
    /// to omit `providerDetails`), which hides the section rather than showing a
    /// figure that belongs to every other provider too. A provider simply absent
    /// from a breakdown that IS present had no usage today, which is a real
    /// zero, not missing data.
    func capacityDockToday(for provider: CapacityDockProvider) -> ProviderDetail? {
        guard let current = capacityDockToday, !current.providerDetails.isEmpty else { return nil }
        let ids = Set(provider.payloadProviderIDs)
        let rows = current.providerDetails.filter { ids.contains($0.id) }
        let id = provider.payloadProviderID
        guard let first = rows.first else {
            return ProviderDetail(id: id, label: provider.displayName, cost: 0, calls: 0, hasUsage: false)
        }
        guard rows.count > 1 else { return first }
        // A token field stays absent until some row reports it, so that "an old CLI
        // sent none" keeps reading differently from "this account used none".
        func sum(_ value: (ProviderDetail) -> Int?) -> Int? {
            let present = rows.compactMap(value)
            return present.isEmpty ? nil : present.reduce(0, +)
        }
        return ProviderDetail(
            id: id,
            label: provider.displayName,
            cost: rows.reduce(0) { $0 + $1.cost },
            calls: rows.reduce(0) { $0 + $1.calls },
            hasUsage: rows.contains { $0.hasUsage },
            inputTokens: sum(\.inputTokens),
            outputTokens: sum(\.outputTokens),
            sessions: sum(\.sessions)
        )
    }

    func capacityDockQuotaSummary(for provider: CapacityDockProvider) -> QuotaSummary? {
        if let filter = provider.legacyFilter {
            return quotaSummary(for: filter)
        }
        if let summary = capacityDockProviderSummaries[provider.id] {
            if capacityDockProvidersLoading.contains(provider.id)
                || capacityDockProviderTransientFailures.contains(provider.id)
            {
                return QuotaSummary(
                    providerFilter: .all,
                    connection: .stale,
                    primary: summary.primary,
                    details: summary.details,
                    planLabel: summary.planLabel,
                    footerLines: summary.footerLines + (
                        capacityDockProviderErrors[provider.id]
                            .map { [L("Refresh failed: \($0)")] } ?? []
                    )
                )
            }
            return summary
        }
        if capacityDockProvidersLoading.contains(provider.id) {
            return QuotaSummary(
                providerFilter: .all,
                connection: .loading,
                primary: nil,
                details: [],
                planLabel: nil,
                footerLines: []
            )
        }
        if let error = capacityDockProviderErrors[provider.id] {
            return QuotaSummary(
                providerFilter: .all,
                connection: capacityDockProviderTransientFailures.contains(provider.id)
                    ? .transientFailure
                    : .terminalFailure(reason: error),
                primary: nil,
                details: [],
                planLabel: nil,
                footerLines: [error]
            )
        }
        return nil
    }

    func capacityDockProviderIsConnected(_ provider: CapacityDockProvider) -> Bool {
        guard let connection = capacityDockQuotaSummary(for: provider)?.connection else { return false }
        return connection == .connected || connection == .stale
    }

    func capacityDockProviderIsDockEligible(_ provider: CapacityDockProvider) -> Bool {
        CapacityDockProviderSelection.isDockEligible(
            provider,
            isConnected: capacityDockProviderIsConnected(provider),
            hasSavedCredential: CapacityDockProviderCredentialPresence.contains(provider.id)
        )
    }

    func capacityDockCredential(for provider: CapacityDockProvider) async -> CapacityDockProviderCredential {
        (try? await capacityDockCredentialLoader(provider.id))
            ?? CapacityDockProviderCredential()
    }

    func saveCapacityDockCredential(
        _ credential: CapacityDockProviderCredential,
        for provider: CapacityDockProvider
    ) async throws {
        try await capacityDockCredentialSaver(credential, provider.id)
        capacityDockProviderRefreshGenerations[provider.id, default: 0] &+= 1
        capacityDockProviderSummaries[provider.id] = nil
        capacityDockProviderErrors[provider.id] = nil
        capacityDockProvidersLoading.remove(provider.id)
        capacityDockProviderTransientFailures.remove(provider.id)
    }

    func disconnectCapacityDockProvider(_ provider: CapacityDockProvider) async throws {
        if let filter = provider.legacyFilter {
            switch filter {
            case .claude: disconnectSubscription()
            case .codex: disconnectCodex()
            case .kimiCode: disconnectKimi()
            case .gemini: disconnectGemini()
            case .copilot: disconnectCopilot()
            case .antigravity: disconnectAntigravity()
            default: break
            }
            return
        }
        capacityDockProviderRefreshGenerations[provider.id, default: 0] &+= 1
        do {
            try await capacityDockCredentialRemover(provider.id)
        } catch {
            // The generation invalidates any read that began before the user's
            // disconnect. If deletion itself fails, keep the last-known summary
            // and credential, but never leave the row permanently loading.
            capacityDockProvidersLoading.remove(provider.id)
            throw error
        }
        capacityDockProviderSummaries[provider.id] = nil
        capacityDockProviderErrors[provider.id] = nil
        capacityDockProvidersLoading.remove(provider.id)
        capacityDockProviderTransientFailures.remove(provider.id)
        // Drop the provider from the persisted dock selection too. A
        // credential-less adapter (Cursor) still selected there would be
        // silently reconnected by the next scheduled refresh, undoing the
        // user's explicit disconnect.
        capacityDockProviderDeselector(provider)
    }

    func connectCapacityDockProvider(_ provider: CapacityDockProvider) async {
        if let filter = provider.legacyFilter {
            await connectQuotaProvider(filter)
            return
        }
        await CapacityDockProviderRefreshInteraction.userInitiated {
            await refreshCapacityDockProvider(provider)
        }
    }

    func refreshCapacityDockProvider(_ provider: CapacityDockProvider) async {
        guard provider.legacyFilter == nil,
              provider.catalogEntry.hasLiveCodeBurnQuotaAdapter,
              !capacityDockProvidersLoading.contains(provider.id) else { return }
        let generation = capacityDockProviderRefreshGenerations[provider.id, default: 0]
        capacityDockProvidersLoading.insert(provider.id)
        defer {
            if capacityDockProviderRefreshGenerations[provider.id, default: 0] == generation {
                capacityDockProvidersLoading.remove(provider.id)
            }
        }

        do {
            let credential = try await capacityDockCredentialLoader(provider.id)
            let summary = try await capacityDockProviderQuotaService.fetch(
                provider: provider,
                credential: credential
            )
            guard capacityDockProviderRefreshGenerations[provider.id, default: 0] == generation else {
                return
            }
            capacityDockProviderSummaries[provider.id] = summary
            capacityDockProviderErrors[provider.id] = nil
            capacityDockProviderTransientFailures.remove(provider.id)
        } catch {
            guard capacityDockProviderRefreshGenerations[provider.id, default: 0] == generation else {
                return
            }
            capacityDockProviderErrors[provider.id] = sanitizeForUI(error.localizedDescription)
            if let failure = error as? CapacityDockProviderFetchFailure,
               failure.disposition == .transient {
                capacityDockProviderTransientFailures.insert(provider.id)
            } else {
                capacityDockProviderTransientFailures.remove(provider.id)
                capacityDockProviderSummaries[provider.id] = nil
            }
        }
    }

    /// Refreshes selected generic providers sequentially. Browser-cookie and
    /// local CLI probes can touch shared system state, so serial execution is
    /// deliberately calmer than fanning 60+ connection attempts out at once.
    func refreshSelectedCapacityDockProviders() async {
        let selected = CapacityDockPreferences.load().selectedProviders
        for provider in selected
        where provider.legacyFilter == nil && provider.catalogEntry.hasLiveCodeBurnQuotaAdapter {
            await refreshCapacityDockProvider(provider)
        }
    }

    /// Shared direct-connect path used by Settings, Plan, and Capacity Dock.
    /// Providers whose credentials live in local files or localhost services
    /// perform passive discovery; Claude alone may request Keychain consent.
    func connectQuotaProvider(_ filter: ProviderFilter) async {
        switch filter {
        case .claude: await bootstrapSubscription()
        case .codex: await bootstrapCodex()
        case .kimiCode: await bootstrapKimi()
        case .gemini: await bootstrapGemini()
        case .copilot: await bootstrapCopilot()
        case .antigravity: await bootstrapAntigravity()
        default: break
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
                details.append(.init(label: L("5-hour"), percent: pct / 100, resetsAt: usage.fiveHourResetsAt))
            }
            if let pct = usage.sevenDayPercent {
                let weekly = QuotaSummary.Window(label: L("Weekly"), percent: pct / 100, resetsAt: usage.sevenDayResetsAt)
                primary = weekly
                details.append(weekly)
            }
            if let pct = usage.sevenDayOpusPercent {
                details.append(.init(label: L("Weekly · Opus"), percent: pct / 100, resetsAt: usage.sevenDayOpusResetsAt))
            }
            if let pct = usage.sevenDaySonnetPercent {
                details.append(.init(label: L("Weekly · Sonnet"), percent: pct / 100, resetsAt: usage.sevenDaySonnetResetsAt))
            }
            for scoped in usage.scopedWeekly {
                details.append(.init(label: L("Weekly · \(scoped.label)"), percent: scoped.percent / 100, resetsAt: scoped.resetsAt))
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
            // No rate windows here, so the allowance feeds the bar and badge.
            if let credits = usage.creditLimit {
                let row = QuotaSummary.Window(
                    label: credits.shortLabel,
                    percent: credits.usedPercent / 100,
                    resetsAt: credits.resetsAt
                )
                if primary == nil { primary = row }
                details.append(row)
            }
        }
        let plan = codexUsage?.plan.displayName
        var footerLines: [String] = []
        if let balance = codexUsage?.creditsBalance, balance > 0 {
            // Credit-settled accounts denominate in credits, so no symbol.
            let inCredits = codexUsage?.hasCredits == true
            let formatter = NumberFormatter()
            formatter.numberStyle = inCredits ? .decimal : .currency
            formatter.maximumFractionDigits = inCredits ? 0 : 2
            // Half-up matches the desktop decoder's Math.round; the default is
            // half-even, which disagrees on exact-half balances.
            formatter.roundingMode = .halfUp
            // `en_US`, not `en_US_POSIX`: the latter drops grouping entirely.
            formatter.locale = Locale(identifier: "en_US")
            if !inCredits { formatter.currencyCode = "USD" }
            let fallback = inCredits ? "\(Int(balance.rounded()))" : "$\(balance)"
            let formatted = formatter.string(from: NSNumber(value: balance)) ?? fallback
            footerLines.append(L("Credits remaining · \(formatted)"))
        }
        if codexUsage?.creditLimit == nil, codexUsage?.creditsUnlimited == true {
            footerLines.append(L("Credits · Unlimited"))
        }
        return QuotaSummary(providerFilter: filter, connection: connection, primary: primary, details: details, planLabel: plan, footerLines: footerLines)
    }

    private func kimiQuotaSummary(filter: ProviderFilter) -> QuotaSummary? {
        if case .notBootstrapped = kimiLoadState { return nil }
        if case .bootstrapping = kimiLoadState { return nil }
        if case .noCredentials = kimiLoadState { return nil }

        let connection: QuotaSummary.Connection = {
            switch kimiLoadState {
            case .notBootstrapped, .dormant, .bootstrapping, .noCredentials: return .disconnected
            case .loading: return kimiUsage == nil ? .loading : .stale
            case .loaded: return .connected
            case .failed: return kimiUsage == nil ? .loading : .stale
            // Kimi tokens expire ~every 15 min and only the CLI renews them, so
            // terminal is the steady state between CLI uses. Keep the last-known
            // bars (marked stale) instead of flapping the chip to a reconnect
            // card; the reconnect card is reserved for the genuinely-no-data case.
            case let .terminalFailure(reason): return kimiUsage == nil ? .terminalFailure(reason: reason) : .stale
            case .transientFailure: return .transientFailure
            }
        }()

        var primary: QuotaSummary.Window?
        var details: [QuotaSummary.Window] = []
        if let usage = kimiUsage {
            if let w = usage.primary {
                let row = QuotaSummary.Window(label: w.label, percent: w.usedPercent / 100, resetsAt: w.resetsAt)
                primary = row
                details.append(row)
            }
            for w in usage.details {
                let row = QuotaSummary.Window(label: w.label, percent: w.usedPercent / 100, resetsAt: w.resetsAt)
                if primary == nil { primary = row }
                details.append(row)
            }
        }
        return QuotaSummary(providerFilter: filter, connection: connection, primary: primary, details: details, planLabel: kimiUsage?.plan ?? "Kimi Code", footerLines: [])
    }

    private func geminiQuotaSummary(filter: ProviderFilter) -> QuotaSummary? {
        if case .notBootstrapped = geminiLoadState { return nil }
        if case .bootstrapping = geminiLoadState { return nil }
        if case .noCredentials = geminiLoadState { return nil }

        let connection: QuotaSummary.Connection = {
            switch geminiLoadState {
            case .notBootstrapped, .dormant, .bootstrapping, .noCredentials: return .disconnected
            case .loading: return geminiUsage == nil ? .loading : .stale
            case .loaded: return .connected
            case .failed: return geminiUsage == nil ? .loading : .stale
            // An expired Gemini login without a refresh path sits terminal
            // until the user runs the CLI. Keep the last-known bars (marked
            // stale) instead of flapping the chip to a reconnect card.
            case let .terminalFailure(reason): return geminiUsage == nil ? .terminalFailure(reason: reason) : .stale
            case .transientFailure: return .transientFailure
            }
        }()

        var primary: QuotaSummary.Window?
        var details: [QuotaSummary.Window] = []
        if let usage = geminiUsage {
            // details is sorted most-constrained first, so the first row is
            // the headline bar.
            for w in usage.details {
                let row = QuotaSummary.Window(label: w.label, percent: w.usedPercent / 100, resetsAt: w.resetsAt)
                if primary == nil { primary = row }
                details.append(row)
            }
        }
        return QuotaSummary(providerFilter: filter, connection: connection, primary: primary, details: details, planLabel: geminiUsage?.plan ?? "Gemini", footerLines: [])
    }

    private func copilotQuotaSummary(filter: ProviderFilter) -> QuotaSummary? {
        if case .notBootstrapped = copilotLoadState { return nil }
        if case .bootstrapping = copilotLoadState { return nil }
        if case .noCredentials = copilotLoadState { return nil }

        let connection: QuotaSummary.Connection = {
            switch copilotLoadState {
            case .notBootstrapped, .dormant, .bootstrapping, .noCredentials: return .disconnected
            case .loading: return copilotUsage == nil ? .loading : .stale
            case .loaded: return .connected
            case .failed: return copilotUsage == nil ? .loading : .stale
            // A revoked Copilot token sits terminal until the user signs in via
            // an editor's Copilot plugin again. Keep the last-known bars
            // (marked stale) instead of flapping the chip to a reconnect card.
            case let .terminalFailure(reason): return copilotUsage == nil ? .terminalFailure(reason: reason) : .stale
            case .transientFailure: return .transientFailure
            }
        }()

        var primary: QuotaSummary.Window?
        var details: [QuotaSummary.Window] = []
        if let usage = copilotUsage {
            // details leads with the premium-requests window, so the first row
            // is the headline bar.
            for w in usage.details {
                let row = QuotaSummary.Window(label: w.label, percent: w.usedPercent / 100, resetsAt: w.resetsAt)
                if primary == nil { primary = row }
                details.append(row)
            }
        }
        return QuotaSummary(providerFilter: filter, connection: connection, primary: primary, details: details, planLabel: copilotUsage?.plan ?? "Copilot", footerLines: [])
    }

    private func antigravityQuotaSummary(filter: ProviderFilter) -> QuotaSummary? {
        if case .notBootstrapped = antigravityLoadState { return nil }
        if case .bootstrapping = antigravityLoadState { return nil }
        if case .noCredentials = antigravityLoadState { return nil }

        let connection: QuotaSummary.Connection = {
            switch antigravityLoadState {
            case .notBootstrapped, .dormant, .bootstrapping, .noCredentials: return .disconnected
            case .loading: return antigravityUsage == nil ? .loading : .stale
            case .loaded: return .connected
            case .failed: return antigravityUsage == nil ? .loading : .stale
            // A vanished local server maps to noCredentials above, so terminal
            // is unreachable today; kept for switch exhaustivity.
            case let .terminalFailure(reason): return antigravityUsage == nil ? .terminalFailure(reason: reason) : .stale
            case .transientFailure: return .transientFailure
            }
        }()

        var primary: QuotaSummary.Window?
        var details: [QuotaSummary.Window] = []
        if let usage = antigravityUsage {
            // details is sorted most-constrained first, so the first row is
            // the headline bar.
            for w in usage.details {
                let row = QuotaSummary.Window(label: w.label, percent: w.usedPercent / 100, resetsAt: w.resetsAt)
                if primary == nil { primary = row }
                details.append(row)
            }
        }
        return QuotaSummary(providerFilter: filter, connection: connection, primary: primary, details: details, planLabel: antigravityUsage?.plan ?? "Antigravity", footerLines: [])
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
    case USD, GBP, EUR, AUD, CAD, NZD, JPY, CNY, CHF, INR, BRL, SEK, SGD, HKD, KRW, MXN, ZAR, DKK, RON
    var id: String { rawValue }
    var displayName: String {
        switch self {
        case .USD: L("US Dollar")
        case .GBP: L("British Pound")
        case .EUR: L("Euro")
        case .AUD: L("Australian Dollar")
        case .CAD: L("Canadian Dollar")
        case .NZD: L("New Zealand Dollar")
        case .JPY: L("Japanese Yen")
        case .CNY: L("Chinese Yuan")
        case .CHF: L("Swiss Franc")
        case .INR: L("Indian Rupee")
        case .BRL: L("Brazilian Real")
        case .SEK: L("Swedish Krona")
        case .SGD: L("Singapore Dollar")
        case .HKD: L("Hong Kong Dollar")
        case .KRW: L("South Korean Won")
        case .MXN: L("Mexican Peso")
        case .ZAR: L("South African Rand")
        case .DKK: L("Danish Krone")
        case .RON: L("Romanian Leu")
        }
    }
}

enum ProviderFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case claude = "Claude"
    case cline = "Cline"
    case codewhale = "CodeWhale"
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
    case kimiCode = "Kimi Code"
    case lingtaiTui = "LingTai TUI"
    case kiloCode = "KiloCode"
    case openclaw = "OpenClaw"
    case openclaude = "OpenClaude"
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

    /// Localized label for display; rawValue stays the stable identifier.
    var displayName: String { LR(rawValue) }

    var providerKeys: [String] {
        switch self {
        case .cursor: ["cursor"]
        case .cursorAgent: ["cursor-agent", "cursor agent"]
        case .cline: ["cline"]
        case .codewhale: ["codewhale"]
        case .rooCode: ["roo-code", "roo code"]
        case .kiloCode: ["kilo-code", "kilocode"]
        case .ibmBob: ["ibm-bob", "ibm bob"]
        case .openclaw: ["openclaw"]
        case .antigravity: ["antigravity"]
        case .goose: ["goose"]
        case .grok: ["grok", "grok build"]
        case .hermes: ["hermes", "hermes agent"]
        case .lingtaiTui: ["lingtai-tui", "lingtai tui"]
        case .kimiCode: ["kimicode", "kimi code"]
        default: [rawValue.lowercased()]
        }
    }

    var cliArg: String {
        switch self {
        case .all: "all"
        case .claude: "claude"
        case .cline: "cline"
        case .codewhale: "codewhale"
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
        case .kimiCode: "kimicode"
        case .lingtaiTui: "lingtai-tui"
        case .openclaw: "openclaw"
        case .openclaude: "openclaude"
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
    case notBootstrapped  // no usable source discovered yet — waiting for Connect
    case dormant          // source exists; prompt-free background activation is available
    case bootstrapping    // user clicked Connect; source-owned auth may request consent
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

    /// Localized label for display; rawValue stays the stable identifier.
    var displayName: String { LR(rawValue) }
}

enum Period: String, CaseIterable, Identifiable {
    // Compact labels: six segments plus the calendar button share one narrow
    // popover row, so the longer names ("6 Months", "Lifetime") wrapped.
    // Matches the desktop app's strip (Today / 7D / 30D / Month / 6M / Life).
    case today = "Today"
    case sevenDays = "7D"
    case thirtyDays = "30D"
    case month = "Month"
    case all = "6M"
    case lifetime = "Life"

    var id: String { rawValue }

    /// Localized label for display; rawValue stays the stable identifier.
    var displayName: String { LR(rawValue) }

    /// Maps to the CLI's `--period` argument values.
    var cliArg: String {
        switch self {
        case .today: "today"
        case .sevenDays: "week"
        case .thirtyDays: "30days"
        case .month: "month"
        case .all: "all"
        case .lifetime: "lifetime"
        }
    }

    static let menubarMetricCases: [Period] = [.today, .sevenDays, .month, .all]

    var menubarMetricLabel: String {
        switch self {
        case .today: L("Today")
        case .sevenDays: L("Week")
        case .thirtyDays: L("30 Days")
        case .month: L("Month")
        case .all: L("6 Months")
        case .lifetime: L("Lifetime")
        }
    }

    var menubarDefaultsValue: String {
        switch self {
        case .today: "today"
        case .sevenDays: "week"
        case .thirtyDays: "30days"
        case .month: "month"
        case .all: "sixMonths"
        case .lifetime: "lifetime"
        }
    }

    init(menubarDefaultsValue: String?) {
        switch menubarDefaultsValue {
        case "today": self = .today
        case "week", "sevenDays": self = .sevenDays
        case "month": self = .month
        case "sixMonths", "all": self = .all
        case "lifetime": self = .lifetime
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
        case .sevenDays: compact ? L("/wk") : L(" / wk")
        case .thirtyDays: compact ? L("/30d") : L(" / 30d")
        case .month: compact ? L("/mo") : L(" / mo")
        case .all: compact ? L("/6mo") : L(" / 6mo")
        // lifetime is a panel-only period (never a menubar metric, see
        // menubarMetricCases), but the switch must stay exhaustive.
        case .lifetime: compact ? L("/life") : L(" / life")
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
