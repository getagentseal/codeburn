import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { isColdHydrating } from './components/CliErrorPanel'
import { EmptyNote } from './components/EmptyState'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Hint } from './components/Hint'
import { Onboarding } from './components/Onboarding'
import { Panel } from './components/Panel'
import { Sidebar, type Section } from './components/Sidebar'
import { Splash } from './components/Splash'
import { ToastHost } from './components/ToastHost'
import { UpdateBanner } from './components/UpdateBanner'
import { rangeLabel, TopBar } from './components/TopBar'
import { Window } from './components/Window'
import { clearPolledMemo, hasPolledMemo, polledMemoTimestamp, primePolledMemo, usePolled, usePolledInFlight } from './hooks/usePolled'
import { readDailyBudget } from './lib/budget'
import { formatCompact, formatUsd, setActiveCurrency } from './lib/format'
import {
  EMPTY_FILTERS,
  filtersActive,
  modelFilters,
  projectFilters,
  unionFilters,
  type InvestigationFilters,
} from './lib/investigation'
import {
  backState,
  EMPTY_NAV_HISTORY,
  forwardState,
  persistNavState,
  pushState,
  readPersistedNavState,
  type NavHistory,
  type NavState,
} from './lib/navHistory'
import { motionClass } from './lib/motion'
import { clearOverviewHeadlines, readOverviewHeadline, writeOverviewHeadline } from './lib/overviewSnapshot'
import { codeburn } from './lib/ipc'
import { effectiveLocale, isLocaleChoice, LocaleContext, setCurrentLocale, t, type Locale, type LocaleChoice } from './i18n'
import { trackEvent } from './lib/track'
import { isMacPlatform, isModifierChord, shortcutLabel } from './lib/platform'
import { localDateKey, PERIOD_LABELS } from './lib/period'
import { generationAt } from './lib/generation'
import { detectedProviders as detectedProviderList, providerLabel, readDisabledProviders, type DetectedProvider } from './lib/providers'
import { reportMemoKey } from './lib/reportMemoKey'
import { persistRefreshValue, readRefreshValue, refreshValueToMs, RefreshCadenceContext, type RefreshCadence } from './lib/refreshCadence'
import { OverviewContent, type InvestigateRequest } from './sections/Overview'
import { OptimizeContent } from './sections/Optimize'
import { Models } from './sections/Models'
import { INITIAL_VISIBLE, Sessions, type SessionSort } from './sections/Sessions'
import { PullRequestsContent } from './sections/PullRequests'
import { Compare } from './sections/Compare'
import { PeriodCompare } from './sections/PeriodCompare'
import { Plans } from './sections/Plans'
import { Settings, type SettingsPane } from './sections/Settings'
import { SpendContent } from './sections/Spend'
import { PluginsSection } from './sections/Plugins'
import type { DateRange, MenubarPayload, ModelReportRow, Period, Scope, TelemetryStatus } from './lib/types'
import { Icon } from './components/icons'

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

// A function, not a module-level constant: it must re-read t() on every call so
// a language switch (which remounts the app subtree, not the module) is reflected.
function sectionTitles(): Record<Section, string> {
  return {
    overview: t('shell.nav.overview'),
    sessions: t('shell.nav.sessions'),
    pullRequests: t('shell.nav.pullRequests'),
    spend: t('shell.nav.spend'),
    optimize: t('shell.nav.optimize'),
    models: t('shell.nav.models'),
    compare: t('shell.nav.compare'),
    periods: t('shell.nav.periods'),
    plans: t('shell.nav.plans'),
    settings: t('shell.nav.settings'),
    plugins: t('shell.nav.plugins'),
  }
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

export function refreshedLabel(lastSuccessAt: number | null, loading: boolean, now: number): string {
  if (loading && lastSuccessAt === null) return t('shell.refreshedAt.refreshing')
  if (lastSuccessAt === null) return t('shell.refreshedAt.notYet')
  const seconds = Math.max(0, Math.floor((now - lastSuccessAt) / 1000))
  if (seconds < 1) return t('shell.refreshedAt.justNow')
  if (seconds < 60) return t('shell.refreshedAt.seconds', { count: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('shell.refreshedAt.minutes', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('shell.refreshedAt.hours', { count: hours })
  return t('shell.refreshedAt.days', { count: Math.floor(hours / 24) })
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
      <LocaleProvider>
        <AppMain />
      </LocaleProvider>
    </RefreshCadenceContext.Provider>
  )
}

/**
 * Resolves the active locale from the shared config `language` field (the same
 * key the CLI uses) and, when that is System, the OS locale the preload exposes.
 * Stage 1 renders English everywhere; this only wires the switch: it feeds the
 * Intl formatters (setCurrentLocale) and the <html lang> attribute, and lets the
 * Settings picker persist a new choice through the config-write IPC path.
 */
function LocaleProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<LocaleChoice>('system')
  useEffect(() => {
    void codeburn.getLanguage?.().then(saved => {
      if (saved && isLocaleChoice(saved)) setChoiceState(saved)
    }).catch(() => {})
  }, [])

  const locale: Locale = effectiveLocale(choice, codeburn.appLocale)
  useEffect(() => {
    setCurrentLocale(locale)
    document.documentElement.lang = locale
  }, [locale])

  const setChoice = useCallback((next: LocaleChoice) => {
    setChoiceState(next)
    void codeburn.setLanguage?.(next === 'system' ? null : next).catch(() => {})
  }, [])

  const value = useMemo(() => ({ locale, choice, setChoice }), [locale, choice, setChoice])
  // Remount the subtree on locale change so components using bare t() re-read the
  // active catalog. Switching language is a rare, deliberate action, so the brief
  // reload of transient UI state is acceptable.
  return <LocaleContext.Provider value={value}><Fragment key={locale}>{children}</Fragment></LocaleContext.Provider>
}

const NAV_SECTIONS = new Set<string>(['overview', 'sessions', 'pullRequests', 'spend', 'optimize', 'models', 'compare', 'plans', 'settings', 'plugins'])

/** Boot position: the best-effort restart snapshot when it is still valid
 *  (section and period re-validated; a stale drawer revalidates itself once
 *  the destination data lands), else the plain defaults. */
function initialNavState(): NavState {
  const restored = readPersistedNavState()
  if (restored
    && NAV_SECTIONS.has(restored.section)
    && isPeriod(restored.period)) {
    return { ...restored, range: restored.range ?? null, filters: restored.filters ?? EMPTY_FILTERS }
  }
  return {
    section: 'overview',
    period: initialPeriod(),
    provider: 'all',
    range: null,
    filters: EMPTY_FILTERS,
    sessionId: null,
    sort: 'cost',
    visibleCount: INITIAL_VISIBLE,
  }
}

function AppMain() {
  const [nav, setNav] = useState<NavState>(initialNavState)
  const [history, setHistory] = useState<NavHistory>(EMPTY_NAV_HISTORY)
  // Mirrors for synchronous reads inside callbacks (commit/back/forward must
  // reason about the CURRENT state, not the one from the last render).
  const navRef = useRef(nav)
  navRef.current = nav
  const historyRef = useRef(history)
  historyRef.current = history

  const { section, period, provider, filters, sessionId: openSessionId } = nav
  const customRange = nav.range
  const [settingsPane, setSettingsPane] = useState<SettingsPane>('general')
  const [providerCatalog, setProviderCatalog] = useState<{
    key: string | null
    entries: DetectedProvider[]
  }>({ key: null, entries: [] })
  const detectedProviders = providerCatalog.entries
  const [claudeConfigSource, setClaudeConfigSource] = useState<string | null>(initialConfigSource)
  const [requestedScope, setScopeState] = useState<Scope>(initialScope)
  const [refreshToken, setRefreshToken] = useState(0)
  const [projectFiltered, setProjectFiltered] = useState(initialProjectFiltered)
  // Combined reports unfiltered paired-device usage, so a project filter would
  // come back inside the aggregate. The filter wins, from the first poll.
  const scope: Scope = projectFiltered ? 'local' : requestedScope
  // Rolls the shell once per local calendar day: the overview memo keys bake in
  // a today/month boundary, so midnight must produce a re-render — but ticking
  // a wall clock every second would re-render the whole tree for a label one
  // row wide, so the per-second "refreshed Ns ago" tick lives in RefreshedAt.
  const dayRef = useRef(localDateKey(new Date()))
  const [, bumpDay] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => {
      const today = localDateKey(new Date())
      if (today !== dayRef.current) {
        dayRef.current = today
        bumpDay(n => n + 1)
      }
    }, 15_000)
    return () => window.clearInterval(id)
  }, [])
  const [, setCurrencyTick] = useState(0)
  const [snapshotRevision, setSnapshotRevision] = useState(0)
  const configGenerationRef = useRef(0)

  /** Commit a new app position: one history entry per committed change, with
   *  identical consecutive states coalesced (poll refreshes never push). */
  const commitNav = useCallback((patch: Partial<NavState>) => {
    const current = navRef.current
    const next = { ...current, ...patch }
    if (next === current) return
    navRef.current = next
    setNav(next)
    setHistory(currentHistory => pushState(currentHistory, current, next))
  }, [])

  const goBack = useCallback(() => {
    const result = backState(historyRef.current, navRef.current)
    if (!result) return
    historyRef.current = result.history
    setHistory(result.history)
    navRef.current = result.state
    setNav(result.state)
  }, [])

  const goForward = useCallback(() => {
    const result = forwardState(historyRef.current, navRef.current)
    if (!result) return
    historyRef.current = result.history
    setHistory(result.history)
    navRef.current = result.state
    setNav(result.state)
  }, [])

  // Best-effort restart restore of the app position (section, selection,
  // drawer): the snapshot revalidates lazily — the Sessions drawer closes
  // itself when its session is no longer in the reloaded population.
  useEffect(() => { persistNavState(nav) }, [nav])

  /** A drill-through entry from any report: navigate to Sessions with the
   *  selection applied (and the drawer pre-opened for a session entry). While
   *  an investigation is already active, a second aggregate click UNIONS into
   *  it (the OR rule within a dimension; the drawer closes for revalidation). */
  const investigate = useCallback((request: InvestigateRequest) => {
    const current = navRef.current
    // An active investigation survives going Back to the graph (that is the
    // point of returning with context), so a further aggregate click unions
    // into it instead of discarding it. With no active selection the click
    // starts a fresh one.
    const filters = filtersActive(current.filters)
      ? unionFilters(current.filters, request.filters)
      : request.filters
    commitNav({ section: 'sessions', filters, sessionId: request.sessionId ?? null, visibleCount: INITIAL_VISIBLE })
  }, [commitNav])

  // Preserve the 2/3-arg call shapes when no config is scoped so the CLI argv
  // stays flag-free; only add --claude-config-source once a config is picked.
  // Combined scope aggregates paired-device usage; the CLI rejects it alongside
  // a provider/config filter, so onScopeChange forces provider='all' and clears
  // the config scope before this poll runs. Passing scope='local' produces the
  // same flag-free argv as before, so local users are unaffected.
  const activeOverviewKey = overviewMemoKey(provider, period, customRange, claudeConfigSource, scope, new Date())
  // Provider membership is period/range-specific. Keep the catalog tied to the
  // exact unscoped local overview that produced it so a scoped view cannot leak
  // providers from a different time horizon while its own payload is loading.
  const allProviderOverviewKey = overviewMemoKey('all', period, customRange, null, 'local', new Date())
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
    if (period === 'today' && sessions === 0) commitNav({ period: 'week', visibleCount: INITIAL_VISIBLE })
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
    // An explicit "system" choice still follows the OS; only a fresh install with no choice at
    // all defaults to light rather than to the OS setting.
    else if (saved === 'system') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', 'light')
  }, [])

  useEffect(() => {
    // Only the all-provider payload is authoritative for the picker. A scoped
    // payload contains just the selected provider; merging it forever also
    // leaked idle providers across period changes.
    if (!overview.data || overview.switching || provider !== 'all' || claudeConfigSource || scope !== 'local') return
    setProviderCatalog({ key: allProviderOverviewKey, entries: detectedProviderList(overview.data.current) })
  }, [allProviderOverviewKey, claudeConfigSource, overview.data, overview.switching, provider, scope])

  const selectedProviderEntry = useMemo(() => provider === 'all'
    ? null
    : detectedProviders.find(entry => entry.id === provider) ?? { id: provider, label: providerLabel(provider), cost: 0, idle: false },
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
      for (const targetProvider of visibleProviderEntries.filter(entry => !entry.idle).map(entry => entry.id)) {
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
    commitNav({ section: next })
    trackEvent('section_view', { section: next })
  }, [commitNav])

  /** Compare periods' contribution drill-down: the same Sessions destination
   *  every other drill-through lands on, scoped to the clicked side's range
   *  and filtered to the contribution's own key. Not a union: the range moves,
   *  so any previous selection no longer describes this population. */
  const inspectContribution = useCallback((range: DateRange, dimension: 'project' | 'model', key: string) => {
    commitNav({
      section: 'sessions',
      range,
      filters: dimension === 'project' ? projectFilters(key) : modelFilters([key]),
      sessionId: null,
      visibleCount: INITIAL_VISIBLE,
    })
  }, [commitNav])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Back/Forward in app history: the platform navigation chords (Cmd+[ /
      // Cmd+] on macOS, Alt+Left/Right elsewhere). Checked BEFORE
      // isModifierChord, which deliberately rejects Alt for layout reasons.
      const mac = isMacPlatform()
      const plainModifiers = !event.ctrlKey && !event.metaKey && !event.shiftKey
      if (mac && event.metaKey && !event.ctrlKey && !event.altKey && event.key === '[') {
        event.preventDefault()
        goBack()
        return
      }
      if (mac && event.metaKey && !event.ctrlKey && !event.altKey && event.key === ']') {
        event.preventDefault()
        goForward()
        return
      }
      if (!mac && plainModifiers && event.altKey && event.key === 'ArrowLeft') {
        event.preventDefault()
        goBack()
        return
      }
      if (!mac && plainModifiers && event.altKey && event.key === 'ArrowRight') {
        event.preventDefault()
        goForward()
        return
      }
      if (!isModifierChord(event)) return
      const key = event.key.toLowerCase()
      if (key === '1') navigate('overview')
      else if (key === '2') navigate('sessions')
      else if (key === '3') navigate('pullRequests')
      else if (key === '4') navigate('spend')
      else if (key === '5') navigate('optimize')
      else if (key === '6') navigate('models')
      else if (key === '7') navigate('compare')
      else if (key === '9') navigate('periods')
      else if (key === '8') navigate('plans')
      else if (key === ',') navigate('settings')
      else if (key === 'r') refreshVisible()
      else return
      event.preventDefault()
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [refreshVisible, navigate, goBack, goForward])

  const onPeriodChange = (value: string) => {
    if (isPeriod(value)) {
      autoPeriod.current = false
      commitNav({ period: value, range: null, visibleCount: INITIAL_VISIBLE })
    }
  }

  // A Claude config scopes Claude usage only, so a non-Claude provider filter
  // would make the CLI reject the flag: reset it to 'all' first (a 'claude'
  // filter is already compatible and is left alone). Picking a config also
  // implies a device-specific view, so drop combined scope back to local.
  const onConfigSelect = (id: string) => {
    const next = id || null
    if (next && provider !== 'all' && provider !== 'claude') commitNav({ provider: 'all' })
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
    commitNav({ provider: value })
  }

  // Re-read on config invalidation (another window can save the pane too), on a
  // manual refresh, and on every overview poll. The main process honours a hand
  // edit of app-filter.json the moment the file changes, so a renderer that only
  // re-read on its own saves kept offering Combined while buildOverviewArgs had
  // already dropped `--scope combined` — a local, filtered total under a
  // "Combined · …" headline, which is the one reading the pane must never give.
  useEffect(() => {
    let cancelled = false
    void Promise.resolve().then(() => codeburn.getProjectFilter())
      .then(filter => {
        if (cancelled) return
        const active = filter.project.length > 0 || filter.exclude.length > 0
        // reportMemoKey has no filter component, so a snapshot memoised under
        // the other scope would repaint until the next fetch lands.
        if (active !== initialProjectFiltered()) clearPolledMemo()
        setProjectFiltered(active)
        persistProjectFiltered(active)
      })
      .catch(() => { /* an older preload has no getProjectFilter to honour */ })
    return () => { cancelled = true }
  }, [snapshotRevision, refreshToken, overview.data])

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
      if (provider !== 'all') commitNav({ provider: 'all' })
      if (claudeConfigSource) { setClaudeConfigSource(null); persistConfigSource(null) }
    }
    setScopeState(next)
    persistScope(next)
  }

  const claudeConfigs = overview.data?.claudeConfigs
  const providerOptions = [
    { value: 'all', label: t('shell.provider.all') },
    ...visibleProviderEntries.map(entry => ({ value: entry.id, label: entry.label, muted: entry.idle })),
  ]
  const activeProviderLabel = selectedProviderEntry?.label ?? providerLabel(provider)
  const activeConfigLabel = claudeConfigSource
    ? claudeConfigs?.options.find(option => option.id === claudeConfigSource)?.label ?? null
    : null
  // Combined scope reports unfiltered all-device usage, so the caption reads
  // "Combined" in place of the (forced-'all') provider label.
  const scopeCaption = scope === 'combined'
    ? `${customRange ? rangeLabel(customRange) : PERIOD_LABELS[period]} · ${t('shell.scope.combined')}`
    : `${customRange ? rangeLabel(customRange) : PERIOD_LABELS[period]} · ${activeProviderLabel}${activeConfigLabel ? ` · ${activeConfigLabel}` : ''}`
  const refreshing = usePolledInFlight() || overview.switching || (!!headlineSnapshot && overview.loading)
  const selectedReportKeys = selectedReportMemoKeys(section, period, provider, customRange, activeOverviewKey)
  const selectedReportTimestamps = selectedReportKeys.map(polledMemoTimestamp)
  const reportLastSuccessAt = selectedReportKeys.length > 0 && selectedReportTimestamps.every((value): value is number => value != null)
    ? Math.min(...selectedReportTimestamps)
    : null
  // The headline on screen is the generation's, so the clock describes the
  // generation. Without this the footer aged with whichever period's detail
  // payload happened to be oldest, which is not what the numbers came from.
  // A filtered view shows its own payload, never the machine-wide generation, so
  // its clock stays the report's.
  const headlineFromGeneration = !customRange
    && scope === 'local'
    && !claudeConfigSource
    && provider === 'all'
    && !projectFiltered
    && !!overview.data?.periodTotals
  const generationClock = headlineFromGeneration ? generationAt() : null
  const selectedLastSuccessAt = generationClock != null && (reportLastSuccessAt == null || generationClock > reportLastSuccessAt)
    ? generationClock
    : reportLastSuccessAt

  return (
    <Window>
      <Sidebar active={section} onNavigate={navigate} status={<StatusLine polled={overview} snapshot={headlineSnapshot} />} />
      <ToastHost />
      <Splash hasData={overview.data != null || headlineSnapshot != null} hasError={overview.error != null && !overviewCold} />
      {onboardingStatus && <Onboarding defaultEnabled={onboardingStatus.defaultEnabled} onDone={finishOnboarding} />}
      <div className="ct" aria-busy={refreshing}>
        <div className={refreshing ? 'switch-line on' : 'switch-line'} aria-hidden="true" />
        <UpdateBanner />
        <IndexingBanner payload={overview.degraded ?? overview.data ?? null} />
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
              title={sectionTitles()[section]}
              canBack={history.past.length > 0}
              canForward={history.future.length > 0}
              onBack={goBack}
              onForward={goForward}
              scope={scopeCaption}
              period={period}
              onPeriodChange={onPeriodChange}
              customRange={customRange}
              onRangeSelect={range => commitNav({ range, visibleCount: INITIAL_VISIBLE })}
              provider={provider}
              providerLabel={activeProviderLabel}
              providerOptions={providerOptions}
              onProviderSelect={onProviderSelect}
              claudeConfigs={claudeConfigs}
              configSource={claudeConfigSource}
              onConfigSelect={onConfigSelect}
            />
            <div className={motionClass('body', 'section-fade')}>
              {section === 'overview' ? (
                <OverviewContent period={period} provider={provider} range={customRange} overview={overview} onNavigate={navigate} onInvestigate={investigate} ready={ready} scope={scope} headlineSnapshot={headlineSnapshot} />
              ) : section === 'sessions' ? (
                // A new sort or a changed selection reorders the whole list, so
                // the pagination depth resets IN THE SAME commit — one history
                // entry, and the depth a Back/Forward restores stays whatever it
                // was when that position was committed.
                <Sessions period={period} provider={provider} range={customRange} refreshToken={refreshToken} detectedProviders={visibleProviderEntries} onProviderChange={onProviderSelect} ready={ready} filters={filters} onFiltersChange={next => commitNav({ filters: next, visibleCount: INITIAL_VISIBLE })} openSessionId={openSessionId} onSessionOpen={key => commitNav({ sessionId: key })} onSessionClose={() => commitNav({ sessionId: null })} sort={nav.sort as SessionSort} onSortChange={value => commitNav({ sort: value, visibleCount: INITIAL_VISIBLE })} visibleCount={nav.visibleCount} onVisibleCountChange={value => commitNav({ visibleCount: value })} />
              ) : section === 'pullRequests' ? (
                <PullRequestsContent overview={overview} period={period} provider={provider} range={customRange} onInvestigate={investigate} />
              ) : section === 'spend' ? (
                <SpendContent period={period} provider={provider} range={customRange} overview={overview} refreshToken={refreshToken} ready={ready} onInvestigate={investigate} />
              ) : section === 'optimize' ? (
                <OptimizeContent period={period} provider={provider} range={customRange} overview={overview} refreshToken={refreshToken} ready={ready} />
              ) : section === 'models' ? (
                <Models period={period} provider={provider} range={customRange} refreshToken={refreshToken} onNavigate={navigate} onInvestigate={investigate} ready={ready} />
              ) : section === 'compare' ? (
                <Compare period={period} provider={provider} range={customRange} refreshToken={refreshToken} ready={ready} onInvestigate={investigate} />
              ) : section === 'periods' ? (
                <PeriodCompare provider={provider} refreshToken={refreshToken} ready={ready} onInspectContribution={inspectContribution} />
              ) : (
                <SectionPlaceholder title={sectionTitles()[section]} />
              )}
            </div>
          </>
        )}
        </ErrorBoundary>
        {section !== 'settings' && (
          <Hint
            items={[
              { k: shortcutLabel('1-9'), label: t('shell.hint.navigate') },
              { k: shortcutLabel(','), label: t('shell.nav.settings') },
              { k: shortcutLabel('R'), label: t('shell.action.refresh') },
            ]}
            right={<RefreshedAt lastSuccessAt={selectedLastSuccessAt} refreshing={refreshing} />}
          />
        )}
      </div>
    </Window>
  )
}

/** The footer's "refreshed Ns ago" note. The only part of the shell that needs
 *  a 1-second tick, so the tick lives here: a clock in AppMain would reconcile
 *  the whole tree — sidebar, hero, chart, heatmap, tables — 60 times a minute
 *  for a label one row wide. Props re-renders (a new lastSuccessAt) still land
 *  immediately; the interval only repaints elapsed time. The RefreshMark it
 *  renders keeps the fixed icon and screen-reader state main's footer added. */
function RefreshedAt({ lastSuccessAt, refreshing }: { lastSuccessAt: number | null; refreshing: boolean }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick(tick => tick + 1), 1000)
    return () => window.clearInterval(id)
  }, [])
  return <RefreshMark refreshing={refreshing} label={refreshedLabel(lastSuccessAt, refreshing, Date.now())} />
}

/** Footer refresh state. The icon is always in the DOM at a fixed 12px so the
 *  "refreshed Ns ago" text never moves between idle and in-flight, and it sits
 *  LAST in a right-anchored row so the label re-flowing never shifts it. */
function RefreshMark({ refreshing, label }: { refreshing: boolean; label: string }) {
  return (
    <>
      <span className="sr-only" role="status" aria-live="polite">{refreshing ? t('shell.status.refreshing') : ''}</span>
      <span>{label}</span>
      <Icon name="refresh-cw" className={refreshing ? 'refresh-mark spinning' : 'refresh-mark'} />
    </>
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
  if (snapshot) return <>{snapshot.label} <b>{formatUsd(snapshot.cost)}</b> · {t('shell.status.updating')}</>
  if (polled.error?.kind === 'not-found') return <>{t('shell.status.cliNotFound')}</>
  if (polled.loading) return <>{t('shell.status.scanning')}</>
  return <>—</>
}

function SectionPlaceholder({ title }: { title: string }) {
  return (
    <Panel title={title}>
      <EmptyNote>{t('shell.placeholder.body', { title })}</EmptyNote>
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
        {t('shell.indexing.stale')}
      </div>
    )
  }
  if (!hydration || hydration.complete || hydration.indexedFiles >= hydration.totalFiles) return null
  return (
    <div role="status" className="stale-banner">
      {t('shell.indexing.progress', { indexed: Math.min(hydration.indexedFiles, hydration.totalFiles), total: hydration.totalFiles })}
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
    ? t('shell.budget.exceeded', { spent, cap })
    : t('shell.budget.warning', { percent: Math.floor(percent) })

  const dismiss = () => {
    try { globalThis.localStorage?.setItem('codeburn.dailyBudget.dismissed', todayKey) } catch { /* storage can be unavailable */ }
    bumpDismiss(tick => tick + 1)
  }

  return (
    <div role="status" className={exceeded ? 'budget-banner exceeded' : 'budget-banner'}>
      <span>{text}</span>
      <button type="button" className="set-text-button" onClick={dismiss}>{t('shell.action.dismiss')}</button>
    </div>
  )
}
