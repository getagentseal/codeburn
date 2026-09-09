import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { isColdHydrating } from './components/CliErrorPanel'
import { EmptyNote } from './components/EmptyState'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Hint } from './components/Hint'
import { Onboarding } from './components/Onboarding'
import { Panel } from './components/Panel'
import { Sidebar, type Section } from './components/Sidebar'
import { Splash } from './components/Splash'
import { ToastHost } from './components/ToastHost'
import { SwitchingBanner } from './components/SwitchingBanner'
import { UpdateBanner } from './components/UpdateBanner'
import { rangeLabel, TopBar } from './components/TopBar'
import { Window } from './components/Window'
import { clearPolledMemo, hasPolledMemo, polledMemoTimestamp, primePolledMemo, usePolled } from './hooks/usePolled'
import { readDailyBudget } from './lib/budget'
import { formatCompact, formatUsd, setActiveCurrency } from './lib/format'
import { motionClass } from './lib/motion'
import { clearOverviewHeadlines, readOverviewHeadline, writeOverviewHeadline } from './lib/overviewSnapshot'
import { codeburn } from './lib/ipc'
import { trackEvent } from './lib/track'
import { isModifierChord, shortcutLabel } from './lib/platform'
import { localDateKey, PERIOD_LABELS } from './lib/period'
import { readDisabledProviders } from './lib/providers'
import { reportMemoKey } from './lib/reportMemoKey'
import { persistRefreshValue, readRefreshValue, refreshValueToMs, RefreshCadenceContext, type RefreshCadence } from './lib/refreshCadence'
import { OverviewContent } from './sections/Overview'
import { OptimizeContent } from './sections/Optimize'
import { Models } from './sections/Models'
import { Sessions } from './sections/Sessions'
import { PullRequestsContent } from './sections/PullRequests'
import { Compare } from './sections/Compare'
import { Plans } from './sections/Plans'
import { Settings, type SettingsPane } from './sections/Settings'
import { SpendContent } from './sections/Spend'
import { PluginsSection } from './sections/Plugins'
import type { DateRange, MenubarPayload, ModelReportRow, Period, Scope, TelemetryStatus } from './lib/types'

// Bucket raw dollar amounts before they leave the machine: telemetry carries
// coarse ranges, never exact spend.
function costBucket(usd: number): string {
  if (usd < 1) return '<1'
  if (usd < 10) return '1-10'
  if (usd < 50) return '10-50'
  if (usd < 200) return '50-200'
  if (usd < 1000) return '200-1k'
  return '1k+'
}

// Bucket occurrence counts (MCP-server / skill invocations) the same way costBucket
// coarsens dollars: telemetry carries usage magnitude, never an exact tally.
function countBucket(n: number): string {
  if (!(n > 0)) return '0'
  if (n < 10) return '1-10'
  if (n < 100) return '10-100'
  if (n < 1000) return '100-1k'
  return '1k+'
}

/** Map each model to its dominant task category from the default models report.
 * `topCategory` is computed only in that view (not `--by-task`). The overview's
 * `topModels[].name` is the provider display name — for Claude that's exactly
 * `modelDisplayName`, so we key on both it and the raw `model` id and take the
 * highest-cost row per key (rows arrive cost-descending). */
export function topCategoryByModel(rows: ModelReportRow[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const row of rows) {
    if (!row.topCategory) continue
    if (!map.has(row.modelDisplayName)) map.set(row.modelDisplayName, row.topCategory)
    if (!map.has(row.model)) map.set(row.model, row.topCategory)
  }
  return map
}

/** The once-per-day anonymous aggregate, built in the renderer.
 * Fallback only: current CLIs compute the richer `payload.telemetrySnapshot`
 * (src/telemetry-snapshot.ts) so the desktop app and the Windows tray send the
 * identical shape. This builder covers a CLI that predates that field.
 * The main process dedups the event by calendar day either way. */
export function usageSnapshotProps(payload: MenubarPayload, modelCategories?: Map<string, string>): Record<string, unknown> {
  return {
    period: payload.current.label,
    providerCount: Object.keys(payload.current.providers).length,
    costBucket: costBucket(payload.current.cost),
    // Each top model with its coarse cost bucket, and — when the once-daily
    // by-model report joins — its dominant task category (a single name string,
    // never an array, so the sanitizer keeps it). This is the model x purpose cross.
    models: (payload.current.topModels ?? []).slice(0, 8).map(model => {
      const entry: Record<string, unknown> = { name: model.name, costBucket: costBucket(model.cost) }
      const topCategory = modelCategories?.get(model.name)
      if (topCategory) entry.topCategory = topCategory
      return entry
    }),
    // Per-provider spend, same cost-bucketing as models. `providers` maps lowercased
    // display name -> cost USD; sort by cost so the top spenders survive the cap.
    providers: Object.entries(payload.current.providers ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, cost]) => ({ name, costBucket: costBucket(cost) })),
    // Aggregate task categories (the "purpose" dimension across all models).
    categories: (payload.current.topActivities ?? []).slice(0, 12).map(activity => ({
      name: activity.name,
      // Task-completion signal: share of turns resolved in one shot, 2dp.
      oneShotRate: activity.oneShotRate == null ? -1 : Math.round(activity.oneShotRate * 100) / 100,
    })),
    // MCP servers and skills by name + bucketed usage. Names are config identifiers
    // (like model names), never args/paths/descriptions. Skills are measured in turns.
    mcpServers: (payload.current.mcpServers ?? []).slice(0, 12).map(server => ({
      name: server.name,
      callBucket: countBucket(server.calls),
    })),
    skills: (payload.current.skills ?? []).slice(0, 12).map(skill => ({
      name: skill.name,
      callBucket: countBucket(skill.turns),
    })),
  }
}

const SECTION_TITLES: Record<Section, string> = {
  overview: 'Overview',
  sessions: 'Sessions',
  pullRequests: 'Pull requests',
  spend: 'Spend',
  optimize: 'Optimize',
  models: 'Models',
  compare: 'Compare',
  plans: 'Plans',
  settings: 'Settings',
  plugins: 'Plugins',
}

const STANDARD_PERIODS: Period[] = ['today', 'week', '30days', 'month', 'all', 'lifetime']

// Instant-switch memo key for an overview result. Shared by the overview poll
// and the provider prefetcher so the two never drift out of sync. Exported so
// the prefetch-storm test can assert warmed keys survive between polls.
export function overviewMemoKey(provider: string, period: Period, range: DateRange | null, configSource: string | null, scope: Scope = 'local', now = new Date()): string {
  const boundary = period === 'today'
    ? localDateKey(now)
    : period === 'month'
      ? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
      : ''
  return `overview|${provider}|${period}|${range?.from ?? ''}-${range?.to ?? ''}|${configSource ?? ''}|${scope}|${boundary}`
}

/** Exact report identities that make a top-level destination complete enough
 * for its footer to claim a refresh time. Composite destinations use the oldest
 * constituent timestamp; a missing constituent remains "not refreshed yet". */
export function selectedReportMemoKeys(
  section: Section,
  period: Period,
  provider: string,
  range: DateRange | null,
  activeOverviewKey: string,
  disabledProviders: Iterable<string> = readDisabledProviders(),
): string[] {
  if (section === 'overview' || section === 'pullRequests') return [activeOverviewKey]
  if (section === 'sessions') return [reportMemoKey('sessions', period, provider, range)]
  if (section === 'spend') return [activeOverviewKey, reportMemoKey('spendflow', period, provider, range)]
  if (section === 'optimize') return [
    activeOverviewKey,
    reportMemoKey('optimize', period, provider, range),
    reportMemoKey('yield', period, provider, range),
  ]
  if (section === 'models') return [reportMemoKey('models', period, provider, range, 'false')]
  if (section === 'compare') return [reportMemoKey('comparemodels', period, provider, range)]
  if (section === 'plans') return [
    `quota|${[...disabledProviders].sort().join(',')}`,
    reportMemoKey('plans', period),
  ]
  return []
}

// Prefetch pacing: wait a short idle after the first paint, then warm one
// provider at a time at low priority so the background scan never competes with
// the interaction the user is actually having.
const PREFETCH_START_DELAY_MS = 1500
// A warm spawn takes seconds, so a 400ms stagger let the loop fire the whole set
// almost at once; pace it wide enough that each warm genuinely trails the last.
const PREFETCH_STAGGER_MS = 2000
// Heavy-corpus report reads can briefly use more than a gigabyte while the CLI
// materializes a view. Leave a real cooling window between them: the queue still
// finishes comfortably while an app is left open, without keeping a laptop at
// sustained high CPU simply to make every possible future click instant.
const REPORT_PREFETCH_STAGGER_MS = 5000
function isPeriod(value: string): value is Period {
  return (STANDARD_PERIODS as string[]).includes(value)
}

/** The persisted "Default period" Settings writes, when there is one. */
function savedPeriod(): Period | null {
  let saved: string | null = null
  try { saved = globalThis.localStorage?.getItem('codeburn.defaultPeriod') ?? null } catch { /* storage can be unavailable */ }
  return saved && isPeriod(saved) ? saved : null
}

/** Boot period = the persisted "Default period" Settings writes, else today. */
function initialPeriod(): Period {
  return savedPeriod() ?? 'today'
}

/** Persisted Claude config override (empty/absent = aggregate all configs). */
function initialConfigSource(): string | null {
  try { return globalThis.localStorage?.getItem('codeburn.claudeConfigSource') || null } catch { return null }
}

function persistConfigSource(id: string | null): void {
  try {
    if (id) globalThis.localStorage?.setItem('codeburn.claudeConfigSource', id)
    else globalThis.localStorage?.removeItem('codeburn.claudeConfigSource')
  } catch { /* storage can be unavailable */ }
}

/** Boot scope = the persisted dashboard Scope setting, else local. */
function initialScope(): Scope {
  try { return globalThis.localStorage?.getItem('codeburn.scope') === 'combined' ? 'combined' : 'local' } catch { return 'local' }
}

function persistScope(scope: Scope): void {
  try { globalThis.localStorage?.setItem('codeburn.scope', scope) } catch { /* storage can be unavailable */ }
}

/// Boot mirror of the main-process filter, which arrives after the first poll.
function initialProjectFiltered(): boolean {
  try { return globalThis.localStorage?.getItem('codeburn.projectFiltered') === '1' } catch { return false }
}

function persistProjectFiltered(active: boolean): void {
  try { globalThis.localStorage?.setItem('codeburn.projectFiltered', active ? '1' : '0') } catch { /* storage can be unavailable */ }
}

function providerName(provider: string): string {
  if (provider === 'all') return 'All providers'
  return provider
    .split(/[-\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function refreshedLabel(lastSuccessAt: number | null, loading: boolean, now: number): string {
  if (loading && lastSuccessAt === null) return 'refreshing…'
  if (lastSuccessAt === null) return 'not refreshed yet'
  const seconds = Math.max(0, Math.floor((now - lastSuccessAt) / 1000))
  if (seconds < 1) return 'refreshed just now'
  if (seconds < 60) return `refreshed ${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `refreshed ${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `refreshed ${hours}h ago`
  return `refreshed ${Math.floor(hours / 24)}d ago`
}

/** Provides the app-wide refresh cadence (read persisted at boot, applied live)
 *  so every usePolled below reads it as its default interval. */
export function App() {
  const [refreshValue, setRefreshValue] = useState(readRefreshValue)
  const setValue = useCallback((value: string) => {
    setRefreshValue(value)
    persistRefreshValue(value)
  }, [])
  const cadence = useMemo<RefreshCadence>(
    () => ({ value: refreshValue, intervalMs: refreshValueToMs(refreshValue), setValue }),
    [refreshValue, setValue],
  )
  return (
    <RefreshCadenceContext.Provider value={cadence}>
      <AppMain />
    </RefreshCadenceContext.Provider>
  )
}

function AppMain() {
  const [section, setSection] = useState<Section>('overview')
  const [settingsPane, setSettingsPane] = useState<SettingsPane>('general')
  const [period, setPeriod] = useState<Period>(initialPeriod)
  const [provider, setProvider] = useState<string>('all')
  const [providerCatalog, setProviderCatalog] = useState<{
    key: string | null
    entries: Array<{ id: string; label: string }>
  }>({ key: null, entries: [] })
  const detectedProviders = providerCatalog.entries
  const [customRange, setCustomRange] = useState<DateRange | null>(null)
  const [claudeConfigSource, setClaudeConfigSource] = useState<string | null>(initialConfigSource)
  const [requestedScope, setScopeState] = useState<Scope>(initialScope)
  const [refreshToken, setRefreshToken] = useState(0)
  const [projectFiltered, setProjectFiltered] = useState(initialProjectFiltered)
  // Combined reports unfiltered paired-device usage, so a project filter would
  // come back inside the aggregate. The filter wins, from the first poll.
  const scope: Scope = projectFiltered ? 'local' : requestedScope
  const [now, setNow] = useState(() => Date.now())
  const [, setCurrencyTick] = useState(0)
  const [snapshotRevision, setSnapshotRevision] = useState(0)
  const configGenerationRef = useRef(0)

  // Preserve the 2/3-arg call shapes when no config is scoped so the CLI argv
  // stays flag-free; only add --claude-config-source once a config is picked.
  // Combined scope aggregates paired-device usage; the CLI rejects it alongside
  // a provider/config filter, so onScopeChange forces provider='all' and clears
  // the config scope before this poll runs. Passing scope='local' produces the
  // same flag-free argv as before, so local users are unaffected.
  const activeOverviewKey = overviewMemoKey(provider, period, customRange, claudeConfigSource, scope, new Date(now))
  // Provider membership is period/range-specific. Keep the catalog tied to the
  // exact unscoped local overview that produced it so a scoped view cannot leak
  // providers from a different time horizon while its own payload is loading.
  const allProviderOverviewKey = overviewMemoKey('all', period, customRange, null, 'local', new Date(now))
  const overview = usePolled<MenubarPayload>(
    () => scope === 'combined'
      ? codeburn.getOverview(period, 'all', customRange ?? undefined, undefined, undefined, 'combined')
      : claudeConfigSource
      ? codeburn.getOverview(period, provider, customRange ?? undefined, claudeConfigSource)
      : customRange
      ? codeburn.getOverview(period, provider, customRange)
      : codeburn.getOverview(period, provider),
    [period, provider, customRange?.from, customRange?.to, claudeConfigSource, scope],
    { memoKey: activeOverviewKey },
  )
  const refreshOverview = overview.refresh
  // A compact, privacy-minimized last exact headline makes a returning launch or
  // an as-yet-unwarmed period useful immediately. It is never presented as the
  // current answer: the full authoritative fetch starts normally behind it.
  const headlineSnapshot = useMemo(
    () => customRange || scope !== 'local' ? null : readOverviewHeadline(activeOverviewKey),
    [activeOverviewKey, customRange, scope, snapshotRevision],
  )

  useEffect(() => {
    // React renders once with the previous hook result before the dependency-
    // change effect clears or swaps it. Never persist that previous payload
    // beneath the newly selected period/provider key.
    if (!overview.data || overview.dataKey !== activeOverviewKey || customRange || scope !== 'local') return
    writeOverviewHeadline(activeOverviewKey, overview.data, overview.lastSuccessAt ?? Date.now())
  }, [activeOverviewKey, customRange, overview.data, overview.dataKey, overview.lastSuccessAt, scope])

  useEffect(() => {
    if (overview.data || !headlineSnapshot?.currency) return
    setActiveCurrency(headlineSnapshot.currency)
    setCurrencyTick(tick => tick + 1)
  }, [headlineSnapshot?.currency, overview.data])

  // Boot readiness: the overview poll is the single cold-cache warmer (long
  // timeout + progress). Other sections gate their first CLI spawn on this so a
  // cold first run hydrates ONCE here instead of fanning out into a parallel
  // full-history parse per section. Flips true the moment overview first has data
  // OR a (resolved) error; LATCHED, so a later uncached switch (which clears
  // overview.data to paint a skeleton) can never re-gate the sections.
  // A cold-hydration failure is NOT a resolution: flipping ready on it released
  // every section to spawn its own read behind the still-running parse, and each
  // one then died on its own timeout. Stay gated (and keep the splash) until the
  // hydration actually settles.
  // #1111: with no persisted default the app opens on Today and falls back to 7
  // days once, when the first payload shows today has no sessions yet. Disarmed
  // by the period picker, so it can never move a period the user chose.
  const autoPeriod = useRef(savedPeriod() === null)
  useEffect(() => {
    const sessions = overview.data?.current.sessions
    if (!autoPeriod.current || sessions === undefined) return
    autoPeriod.current = false
    if (period === 'today' && sessions === 0) setPeriod('week')
  }, [overview.data, period])

  const overviewCold = isColdHydrating(overview.error)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (overview.data != null || (overview.error != null && !overviewCold)) setReady(true)
  }, [overview.data, overview.error, overviewCold])

  // First-launch onboarding: shown until the telemetry consent screen has been
  // completed once. All telemetry bridge calls are typeof-guarded so an older
  // preload (or the test bridge mock) degrades to "no onboarding, no tracking".
  const [onboardingStatus, setOnboardingStatus] = useState<TelemetryStatus | null>(null)
  useEffect(() => {
    if (typeof codeburn.telemetryStatus !== 'function') return
    codeburn.telemetryStatus()
      .then(status => { if (status && !status.onboarded) setOnboardingStatus(status) })
      .catch(() => { /* telemetry unavailable — skip onboarding */ })
  }, [])
  const finishOnboarding = useCallback((enabled: boolean) => {
    setOnboardingStatus(null)
    if (typeof codeburn.completeOnboarding === 'function') void codeburn.completeOnboarding(enabled).catch(() => {})
  }, [])

  // Once-per-day anonymous usage aggregate, only from the canonical view
  // (all providers, standard period, no config scope) so buckets are stable.
  // Gated to the first qualifying render per calendar day (main also dedups the
  // event). Current CLIs hand us the finished, already-bucketed snapshot and we
  // forward it verbatim; only an older CLI falls back to the renderer builder,
  // which needs an extra by-model report fetch to get the model x category cross
  // and still emits without it if that fetch fails.
  const snapshotDayRef = useRef<string | null>(null)
  useEffect(() => {
    if (!overview.data || provider !== 'all' || customRange || claudeConfigSource || scope !== 'local') return
    const today = localDateKey(new Date())
    if (snapshotDayRef.current === today) return
    snapshotDayRef.current = today
    const payload = overview.data
    const fromCli = payload.telemetrySnapshot
    if (fromCli && typeof fromCli === 'object') {
      trackEvent('usage_snapshot', fromCli)
      return
    }
    void (async () => {
      let modelCategories: Map<string, string> | undefined
      try {
        modelCategories = topCategoryByModel(await codeburn.getModels(period, 'all', false))
      } catch { /* degrade: emit the snapshot without per-model topCategory */ }
      trackEvent('usage_snapshot', usageSnapshotProps(payload, modelCategories))
    })()
  }, [overview.data, provider, customRange, claudeConfigSource, scope, period])

  useEffect(() => {
    let saved: string | null = null
    try { saved = globalThis.localStorage?.getItem('codeburn.theme') ?? null } catch { /* storage can be unavailable */ }
    if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved)
    else document.documentElement.removeAttribute('data-theme')
  }, [])

  useEffect(() => {
    // Only the all-provider payload is authoritative for the picker. A scoped
    // payload contains just the selected provider; merging it forever also
    // leaked idle providers across period changes.
    if (!overview.data || overview.switching || provider !== 'all' || claudeConfigSource || scope !== 'local') return
    const details = overview.data.current.providerDetails
    // Prefer providerDetails (internal id + display label); fall back to the
    // providers map keys (lowercased display names) for older CLIs. `hasUsage`
    // keeps idle discovery rows out of the picker, but only when the CLI
    // actually emits it: every released CLI omits it, and falling back to cost
    // there hid subscription-backed providers whose period spend is $0.
    const found = details
      ? [...details]
          .filter(entry => entry.hasUsage ?? true)
          .sort((a, b) => b.cost - a.cost)
          .map(entry => ({ id: entry.id, label: entry.label }))
      : Object.entries(overview.data.current.providers)
          // Fallback map keys are lowercased display names; ones with spaces
          // ("grok build") cannot round-trip as --provider, so exclude them
          // rather than offer a filter that is guaranteed to error.
          .filter(([key, cost]) => cost > 0 && /^[a-z0-9-]+$/.test(key))
          .sort(([, a], [, b]) => b - a)
          .map(([key]) => ({ id: key, label: providerName(key) }))
    setProviderCatalog({ key: allProviderOverviewKey, entries: found })
  }, [allProviderOverviewKey, claudeConfigSource, overview.data, overview.switching, provider, scope])

  const selectedProviderEntry = useMemo(() => provider === 'all'
    ? null
    : detectedProviders.find(entry => entry.id === provider) ?? { id: provider, label: providerName(provider) },
  [detectedProviders, provider])
  const visibleProviderEntries = useMemo(() => providerCatalog.key === allProviderOverviewKey
    ? detectedProviders
    : selectedProviderEntry
      ? [selectedProviderEntry]
      : [],
  [allProviderOverviewKey, detectedProviders, providerCatalog.key, selectedProviderEntry])

  useEffect(() => {
    const currency = overview.data?.currency
    if (!currency) return
    // While `switching`, `data` is a memo-served payload from a previous key that
    // may carry a STALE currency (cached before a Settings currency change): never
    // let it regress the display. Apply currency only from a freshly-resolved
    // fetch; the fresh result (switching false) re-runs this and applies the real
    // one. clearPolledMemo() on a currency mutation also purges those stale entries.
    if (overview.switching) return
    setActiveCurrency(currency)
    setCurrencyTick(tick => tick + 1)
  }, [overview.data?.currency?.code, overview.data?.currency?.rate, overview.data?.currency?.symbol, overview.switching])

  // Prefetch for millisecond switches: once the first overview has resolved,
  // quietly warm every standard time horizon for the active provider in product
  // priority order (Today -> 7D -> 30D -> Month -> 6M -> Life). After each
  // headline, warm that horizon's first-click reports before moving farther back
  // in history. Preserve the reviewed current-period provider warm after those
  // horizons: the universal provider-summary prototype is still held, but a
  // user's first provider switch must not silently regress to a cold parse. The
  // CLI's own read-cache + in-flight
  // coalescing keep it from double-spawning against a live user fetch;
  // hasPolledMemo skips any result already warm (including one warmed by a real
  // visit).
  //
  // `warmedKeys` is a session-lifetime once-per-key guard: each (provider,period)
  // memo key is marked BEFORE its spawn, so an effect re-run — e.g. an overview
  // poll that momentarily blanked `overview.data` — can never re-spawn work already
  // warmed. New keys (a new provider id, or a period switch) still warm exactly
  // once. Without this the prefetch re-fired every poll: redundant full-history
  // CLI parses every 30s, forever.
  // Mirror the visible overview's fetch state into a ref so the prefetch can hold
  // for a user-triggered fetch without re-arming the whole loop on each toggle.
  const overviewBusyRef = useRef(false)
  overviewBusyRef.current = overview.loading
  const warmedKeys = useRef<Set<string>>(new Set())
  useEffect(() => {
    // Keep this first slice local-only; combined scope has its own remote-data
    // lifecycle and must not inherit local-corpus assumptions by accident.
    if (!ready || overview.data == null || customRange || claudeConfigSource || scope !== 'local') return
    let cancelled = false
    const warm = async () => {
      for (const targetPeriod of STANDARD_PERIODS) {
        if (cancelled) break

        const overviewKey = overviewMemoKey(provider, targetPeriod, null, null)
        if (!warmedKeys.current.has(overviewKey) && !hasPolledMemo(overviewKey)) {
          // Only warm while the visible overview is idle: a user fetch in flight
          // takes priority, so hold this horizon rather than racing it.
          while (!cancelled && overviewBusyRef.current) {
            await new Promise(resolve => setTimeout(resolve, PREFETCH_STAGGER_MS))
          }
          try {
            const configGeneration = configGenerationRef.current
            // Background priority (5th arg) lets an interactive click jump ahead.
            const value = await codeburn.getOverview(targetPeriod, provider, undefined, undefined, true)
            if (!cancelled
              && configGeneration === configGenerationRef.current
              && value.hydration?.complete !== false) {
              primePolledMemo(overviewKey, value)
              writeOverviewHeadline(overviewKey, value)
              warmedKeys.current.add(overviewKey)
            }
          } catch { /* best-effort warm; a real switch will retry and surface the error */ }
          if (!cancelled) await new Promise(resolve => setTimeout(resolve, PREFETCH_STAGGER_MS))
        }

        // Warm the reports for this horizon before moving farther back in time.
        // The queue is deliberately serial and every request is background-
        // priority. Results use the exact section memo keys, then persist through
        // usePolled so tomorrow's launch paints them before revalidation.
        const reportTargets: Array<{ key: string; load: () => Promise<unknown> }> = [
          {
            key: reportMemoKey('sessions', targetPeriod, provider),
            load: () => codeburn.getSessions(targetPeriod, provider, undefined, true),
          },
          {
            key: reportMemoKey('spendflow', targetPeriod, provider),
            load: () => codeburn.getSpendFlow(targetPeriod, provider, undefined, true),
          },
          {
            key: reportMemoKey('models', targetPeriod, provider, null, 'false'),
            load: () => codeburn.getModels(targetPeriod, provider, false, undefined, true),
          },
          {
            key: reportMemoKey('comparemodels', targetPeriod, provider),
            load: () => codeburn.getCompareModels(targetPeriod, provider, true),
          },
          {
            key: reportMemoKey('optimize', targetPeriod, provider),
            load: () => codeburn.getOptimizeReport(targetPeriod, provider, undefined, true),
          },
          {
            key: reportMemoKey('yield', targetPeriod, provider),
            load: () => codeburn.getYield(targetPeriod, provider, undefined, true),
          },
          {
            key: reportMemoKey('plans', targetPeriod),
            load: () => codeburn.getPlans(targetPeriod, true),
          },
        ]
        for (const target of reportTargets) {
          if (cancelled) break
          if (!hasPolledMemo(target.key)) {
            try {
              const configGeneration = configGenerationRef.current
              const value = await target.load()
              if (!cancelled && configGeneration === configGenerationRef.current) {
                primePolledMemo(target.key, value)
              }
            } catch { /* on-demand visit will retry and surface the error */ }
            if (!cancelled) await new Promise(resolve => setTimeout(resolve, REPORT_PREFETCH_STAGGER_MS))
          }
        }
      }

      // Keep the current-main provider-switch contract while the shared Core
      // provider snapshot work is still held: warm the visible period for each
      // detected provider only after the higher-value period/report queue.
      for (const targetProvider of visibleProviderEntries.map(entry => entry.id)) {
        if (cancelled || targetProvider === provider) continue
        const key = overviewMemoKey(targetProvider, period, null, null)
        if (warmedKeys.current.has(key) || hasPolledMemo(key)) continue
        while (!cancelled && overviewBusyRef.current) {
          await new Promise(resolve => setTimeout(resolve, PREFETCH_STAGGER_MS))
        }
        try {
          const configGeneration = configGenerationRef.current
          const value = await codeburn.getOverview(period, targetProvider, undefined, undefined, true)
          if (!cancelled
            && configGeneration === configGenerationRef.current
            && value.hydration?.complete !== false) {
            primePolledMemo(key, value)
            writeOverviewHeadline(key, value)
            warmedKeys.current.add(key)
          }
        } catch { /* a real provider switch will retry and surface the error */ }
        if (!cancelled) await new Promise(resolve => setTimeout(resolve, PREFETCH_STAGGER_MS))
      }
    }
    const start = setTimeout(() => { void warm() }, PREFETCH_START_DELAY_MS)
    return () => { cancelled = true; clearTimeout(start) }
    // `overview.data == null` (a boolean) gates on first-resolution without
    // re-running every poll; the data content itself is intentionally not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, period, provider, visibleProviderEntries, customRange, claudeConfigSource, scope, snapshotRevision, overview.data == null])

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  const refreshVisible = useCallback(() => {
    refreshOverview()
    setRefreshToken(token => token + 1)
  }, [refreshOverview])

  // A Settings action changed config that alters computed costs/currency
  // (currency/alias/plan/price-override). The electron read-cache is flushed CLI-
  // side, but the renderer's instant-switch memo still holds payloads computed
  // under the OLD config — a later provider switch would repaint the stale currency.
  // Purge the memo, then force-refresh the active view so the new values land in a
  // couple seconds (quick like the menubar) instead of at the next poll.
  const onConfigMutated = useCallback(() => {
    configGenerationRef.current++
    warmedKeys.current.clear()
    clearPolledMemo()
    clearOverviewHeadlines()
    setSnapshotRevision(revision => revision + 1)
    refreshVisible()
  }, [refreshVisible])

  const navigate = useCallback((next: Section, pane: SettingsPane = 'general') => {
    setSettingsPane(pane)
    setSection(next)
    trackEvent('section_view', { section: next })
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isModifierChord(event)) return
      const key = event.key.toLowerCase()
      if (key === '1') navigate('overview')
      else if (key === '2') navigate('sessions')
      else if (key === '3') navigate('pullRequests')
      else if (key === '4') navigate('spend')
      else if (key === '5') navigate('optimize')
      else if (key === '6') navigate('models')
      else if (key === '7') navigate('compare')
      else if (key === '8') navigate('plans')
      else if (key === ',') navigate('settings')
      else if (key === 'r') refreshVisible()
      else return
      event.preventDefault()
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [refreshVisible, navigate])

  const onPeriodChange = (value: string) => {
    if (isPeriod(value)) {
      autoPeriod.current = false
      setCustomRange(null)
      setPeriod(value)
    }
  }

  // A Claude config scopes Claude usage only, so a non-Claude provider filter
  // would make the CLI reject the flag: reset it to 'all' first (a 'claude'
  // filter is already compatible and is left alone). Picking a config also
  // implies a device-specific view, so drop combined scope back to local.
  const onConfigSelect = (id: string) => {
    const next = id || null
    if (next && provider !== 'all' && provider !== 'claude') setProvider('all')
    if (next && scope === 'combined') { setScopeState('local'); persistScope('local') }
    setClaudeConfigSource(next)
    persistConfigSource(next)
  }

  // Symmetric direction: picking a non-Claude provider while a config is
  // scoped would hit the same CLI rejection, so drop the config scope. A
  // specific provider filter is a device-specific view, so it also drops
  // combined scope back to local (combined reports unfiltered usage).
  const onProviderSelect = (value: string) => {
    if (value !== 'all' && scope === 'combined') { setScopeState('local'); persistScope('local') }
    if (claudeConfigSource && value !== 'all' && value !== 'claude') {
      setClaudeConfigSource(null)
      persistConfigSource(null)
    }
    setProvider(value)
  }

  // Re-read on config invalidation: another window can save the pane too.
  useEffect(() => {
    let cancelled = false
    void Promise.resolve().then(() => codeburn.getProjectFilter())
      .then(filter => {
        if (cancelled) return
        const active = filter.project.length > 0 || filter.exclude.length > 0
        setProjectFiltered(active)
        persistProjectFiltered(active)
      })
      .catch(() => { /* an older preload has no getProjectFilter to honour */ })
    return () => { cancelled = true }
  }, [snapshotRevision])

  // Collapse the stored preference too, so clearing the filter later starts
  // from local instead of silently restoring a combined view.
  useEffect(() => {
    if (!projectFiltered || requestedScope !== 'combined') return
    setScopeState('local')
    persistScope('local')
  }, [projectFiltered, requestedScope])

  // Combined scope reports unfiltered, all-provider usage across paired devices,
  // so switching to it resets the provider filter and Claude-config scope (which
  // the CLI would otherwise reject), mirroring the menubar's setMenubarScope.
  const onScopeChange = (value: string) => {
    const next: Scope = value === 'combined' ? 'combined' : 'local'
    if (next === 'combined') {
      if (provider !== 'all') setProvider('all')
      if (claudeConfigSource) { setClaudeConfigSource(null); persistConfigSource(null) }
    }
    setScopeState(next)
    persistScope(next)
  }

  const claudeConfigs = overview.data?.claudeConfigs
  const providerOptions = [
    { value: 'all', label: 'All providers' },
    ...visibleProviderEntries.map(entry => ({ value: entry.id, label: entry.label })),
  ]
  const providerLabel = selectedProviderEntry?.label ?? providerName(provider)
  const activeConfigLabel = claudeConfigSource
    ? claudeConfigs?.options.find(option => option.id === claudeConfigSource)?.label ?? null
    : null
  // Combined scope reports unfiltered all-device usage, so the caption reads
  // "Combined" in place of the (forced-'all') provider label.
  const scopeCaption = scope === 'combined'
    ? `${customRange ? rangeLabel(customRange) : PERIOD_LABELS[period]} · Combined`
    : `${customRange ? rangeLabel(customRange) : PERIOD_LABELS[period]} · ${providerLabel}${activeConfigLabel ? ` · ${activeConfigLabel}` : ''}`
  const selectedReportKeys = selectedReportMemoKeys(section, period, provider, customRange, activeOverviewKey)
  const selectedReportTimestamps = selectedReportKeys.map(polledMemoTimestamp)
  const selectedLastSuccessAt = selectedReportKeys.length > 0 && selectedReportTimestamps.every((value): value is number => value != null)
    ? Math.min(...selectedReportTimestamps)
    : null

  return (
    <Window>
      <Sidebar active={section} onNavigate={navigate} status={<StatusLine polled={overview} snapshot={headlineSnapshot} />} />
      <ToastHost />
      <Splash hasData={overview.data != null || headlineSnapshot != null} hasError={overview.error != null && !overviewCold} />
      {onboardingStatus && <Onboarding defaultEnabled={onboardingStatus.defaultEnabled} onDone={finishOnboarding} />}
      <div className="ct" aria-busy={overview.switching || (!!headlineSnapshot && overview.loading)}>
        <div className={overview.switching || (!!headlineSnapshot && overview.loading) ? 'switch-line on' : 'switch-line'} aria-hidden="true" />
        {(overview.switching || (!!headlineSnapshot && overview.loading)) && <SwitchingBanner />}
        <UpdateBanner />
        <IndexingBanner payload={overview.data ?? null} />
        <DailyBudgetBanner payload={overview.data ?? null} provider={provider} />
        <ErrorBoundary key={section}>
        {section === 'plans' ? (
          <Plans period={period} refreshToken={refreshToken} onNavigate={navigate} ready={ready} />
        ) : section === 'settings' ? (
          <Settings period={period} refreshToken={refreshToken} onNavigate={navigate} initialPane={settingsPane} claudeConfigs={claudeConfigs} claudeConfigSource={claudeConfigSource} onConfigMutated={onConfigMutated} scope={scope} onScopeChange={onScopeChange} projectFiltered={projectFiltered} />
        ) : section === 'plugins' ? (
          <PluginsSection />
        ) : (
          <>
            <TopBar
              title={SECTION_TITLES[section]}
              scope={scopeCaption}
              period={period}
              onPeriodChange={onPeriodChange}
              customRange={customRange}
              onRangeSelect={setCustomRange}
              provider={provider}
              providerLabel={providerLabel}
              providerOptions={providerOptions}
              onProviderSelect={onProviderSelect}
              claudeConfigs={claudeConfigs}
              configSource={claudeConfigSource}
              onConfigSelect={onConfigSelect}
            />
            <div className={motionClass('body', 'section-fade')}>
              {section === 'overview' ? (
                <OverviewContent period={period} provider={provider} range={customRange} overview={overview} onNavigate={navigate} ready={ready} scope={scope} headlineSnapshot={headlineSnapshot} />
              ) : section === 'sessions' ? (
                <Sessions period={period} provider={provider} range={customRange} refreshToken={refreshToken} detectedProviders={visibleProviderEntries} onProviderChange={onProviderSelect} ready={ready} />
              ) : section === 'pullRequests' ? (
                <PullRequestsContent overview={overview} period={period} provider={provider} range={customRange} />
              ) : section === 'spend' ? (
                <SpendContent period={period} provider={provider} range={customRange} overview={overview} refreshToken={refreshToken} ready={ready} />
              ) : section === 'optimize' ? (
                <OptimizeContent period={period} provider={provider} range={customRange} overview={overview} refreshToken={refreshToken} ready={ready} />
              ) : section === 'models' ? (
                <Models period={period} provider={provider} range={customRange} refreshToken={refreshToken} onNavigate={navigate} ready={ready} />
              ) : section === 'compare' ? (
                <Compare period={period} provider={provider} range={customRange} refreshToken={refreshToken} ready={ready} />
              ) : (
                <SectionPlaceholder title={SECTION_TITLES[section]} />
              )}
            </div>
          </>
        )}
        </ErrorBoundary>
        {section !== 'settings' && (
          <Hint
            items={[
              { k: shortcutLabel('1-8'), label: 'Navigate' },
              { k: shortcutLabel(','), label: 'Settings' },
              { k: shortcutLabel('R'), label: 'Refresh' },
            ]}
            right={refreshedLabel(selectedLastSuccessAt, false, now)}
          />
        )}
      </div>
    </Window>
  )
}

function StatusLine({ polled, snapshot }: { polled: ReturnType<typeof usePolled<MenubarPayload>>; snapshot?: ReturnType<typeof readOverviewHeadline> }) {
  if (polled.data) {
    return (
      <>
        {polled.data.current.label} <b>{formatUsd(polled.data.current.cost)}</b>
      </>
    )
  }
  if (snapshot) return <>{snapshot.label} <b>{formatUsd(snapshot.cost)}</b> · updating</>
  if (polled.error?.kind === 'not-found') return <>CLI not found</>
  if (polled.loading) return <>scanning…</>
  return <>—</>
}

function SectionPlaceholder({ title }: { title: string }) {
  return (
    <Panel title={title}>
      <EmptyNote>{title} lands in a later task. The shell, data bridge, and design system are in place.</EmptyNote>
    </Panel>
  )
}

/** Honest partiality (#1110): on a cold cache the resident serve child answers
 * from the files the selected period can show and indexes the rest behind it.
 * Wording mirrors the TUI banner. Absent `hydration` means a full parse (a
 * one-shot spawn, or a CLI predating the field), so nothing is shown. */
function IndexingBanner({ payload }: { payload: MenubarPayload | null }) {
  const hydration = payload?.hydration
  if (payload?.stale) {
    return (
      <div role="status" className="stale-banner">
        Some sources could not be refreshed. Showing indexed data; recent activity may be missing.
      </div>
    )
  }
  if (!hydration || hydration.complete || hydration.indexedFiles >= hydration.totalFiles) return null
  return (
    <div role="status" className="stale-banner">
      Indexing history · {Math.min(hydration.indexedFiles, hydration.totalFiles)}/{hydration.totalFiles} files · You can keep using CodeBurn; totals update as indexing completes.
    </div>
  )
}

/** App-wide daily-budget alert: reads today's usage from the overview payload and
 * warns at >=80% / alerts at >=100% of the configured cap. Dismissible per day. */
function DailyBudgetBanner({ payload, provider }: { payload: MenubarPayload | null; provider: string }) {
  const [, bumpDismiss] = useState(0)
  const budget = readDailyBudget()
  if (!budget || !payload) return null

  // Token totals in history.daily are zeroed under a specific-provider filter
  // (only cost is per-provider), so a token cap can only be evaluated honestly on
  // the all-providers view; otherwise we'd compare usage against a false zero.
  if (budget.kind === 'tokens' && provider !== 'all') return null

  const todayKey = localDateKey(new Date())
  let dismissed: string | null = null
  try { dismissed = globalThis.localStorage?.getItem('codeburn.dailyBudget.dismissed') ?? null } catch { /* storage can be unavailable */ }
  if (dismissed === todayKey) return null

  // Today's entry may be absent when there has been no activity yet: that's 0 used.
  const entry = payload.history.daily.find(day => day.date === todayKey)
  const used = budget.kind === 'usd'
    ? entry?.cost ?? 0
    : entry ? entry.inputTokens + entry.outputTokens : 0
  const percent = (used / budget.value) * 100
  if (percent < 80) return null

  const exceeded = percent >= 100
  const spent = budget.kind === 'usd' ? formatUsd(used) : formatCompact(used)
  const cap = budget.kind === 'usd' ? formatUsd(budget.value) : formatCompact(budget.value)
  const text = exceeded
    ? `Daily budget exceeded: ${spent} of ${cap}`
    : `Today's spend is at ${Math.floor(percent)}% of your daily budget`

  const dismiss = () => {
    try { globalThis.localStorage?.setItem('codeburn.dailyBudget.dismissed', todayKey) } catch { /* storage can be unavailable */ }
    bumpDismiss(tick => tick + 1)
  }

  return (
    <div role="status" className={exceeded ? 'budget-banner exceeded' : 'budget-banner'}>
      <span>{text}</span>
      <button type="button" className="set-text-button" onClick={dismiss}>Dismiss</button>
    </div>
  )
}
