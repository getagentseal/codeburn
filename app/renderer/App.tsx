import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { EmptyNote } from './components/EmptyState'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Hint } from './components/Hint'
import { Onboarding } from './components/Onboarding'
import { Panel } from './components/Panel'
import { Sidebar, type Section } from './components/Sidebar'
import { Splash } from './components/Splash'
import { ToastHost } from './components/ToastHost'
import { rangeLabel, TopBar } from './components/TopBar'
import { Window } from './components/Window'
import { hasPolledMemo, primePolledMemo, setPolledMemoMax, usePolled } from './hooks/usePolled'
import { readDailyBudget } from './lib/budget'
import { formatCompact, formatUsd, setActiveCurrency } from './lib/format'
import { motionClass } from './lib/motion'
import { codeburn } from './lib/ipc'
import { localDateKey } from './lib/period'
import { persistRefreshValue, readRefreshValue, refreshValueToMs, RefreshCadenceContext, type RefreshCadence } from './lib/refreshCadence'
import { OverviewContent } from './sections/Overview'
import { OptimizeContent } from './sections/Optimize'
import { Models } from './sections/Models'
import { Sessions } from './sections/Sessions'
import { Compare } from './sections/Compare'
import { Plans } from './sections/Plans'
import { Settings, type SettingsPane } from './sections/Settings'
import { SpendContent } from './sections/Spend'
import type { DateRange, MenubarPayload, Period, TelemetryStatus } from './lib/types'

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

/** The once-per-day anonymous aggregate (main process dedups by calendar day). */
function usageSnapshotProps(payload: MenubarPayload): Record<string, unknown> {
  return {
    period: payload.current.label,
    providerCount: Object.keys(payload.current.providers).length,
    costBucket: costBucket(payload.current.cost),
    models: (payload.current.topModels ?? []).slice(0, 8).map(model => ({
      name: model.name,
      costBucket: costBucket(model.cost),
    })),
    categories: (payload.current.topActivities ?? []).slice(0, 12).map(activity => ({
      name: activity.name,
      // Task-completion signal: share of turns resolved in one shot, 2dp.
      oneShotRate: activity.oneShotRate == null ? -1 : Math.round(activity.oneShotRate * 100) / 100,
    })),
  }
}

const SECTION_TITLES: Record<Section, string> = {
  overview: 'Overview',
  sessions: 'Sessions',
  spend: 'Spend',
  optimize: 'Optimize',
  models: 'Models',
  compare: 'Compare',
  plans: 'Plans',
  settings: 'Settings',
}

const PERIOD_LABELS: Record<Period, string> = {
  today: 'Today',
  week: 'Last 7 days',
  month: 'This month',
  '30days': 'Last 30 days',
  all: 'All time',
}

const STANDARD_PERIODS: Period[] = ['today', 'week', '30days', 'month', 'all']

// Instant-switch memo key for an overview result. Shared by the overview poll
// and the provider prefetcher so the two never drift out of sync. Exported so
// the prefetch-storm test can assert warmed keys survive between polls.
export function overviewMemoKey(provider: string, period: Period, range: DateRange | null, configSource: string | null): string {
  return `overview|${provider}|${period}|${range?.from ?? ''}-${range?.to ?? ''}|${configSource ?? ''}`
}

// Prefetch pacing: wait a short idle after the first paint, then warm one
// provider at a time at low priority so the background scan never competes with
// the interaction the user is actually having.
const PREFETCH_START_DELAY_MS = 1500
const PREFETCH_STAGGER_MS = 400
// Base instant-switch memo keys live during overview polling besides the per-
// provider prefetch entries: `overview|all`, `overview-act`, `overview-yield`,
// plus one slot of headroom for section navigation. The memo cap is sized to
// (detected providers + this) so warmed entries — and the base overview key —
// never LRU-evict between polls (which would blank the overview and re-arm the
// prefetch every cycle).
const BASE_MEMO_KEYS = 4

function isPeriod(value: string): value is Period {
  return (STANDARD_PERIODS as string[]).includes(value)
}

/** Boot period = the persisted "Default period" Settings writes, else 30 days. */
function initialPeriod(): Period {
  let saved: string | null = null
  try { saved = globalThis.localStorage?.getItem('codeburn.defaultPeriod') ?? null } catch { /* storage can be unavailable */ }
  return saved && isPeriod(saved) ? saved : '30days'
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

function providerName(provider: string): string {
  if (provider === 'all') return 'All providers'
  return provider
    .split(/[-\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function refreshedLabel(lastSuccessAt: number | null, loading: boolean, now: number): string {
  if (loading && lastSuccessAt === null) return 'refreshing…'
  if (lastSuccessAt === null) return 'not refreshed yet'
  const seconds = Math.max(0, Math.floor((now - lastSuccessAt) / 1000))
  if (seconds < 1) return 'refreshed just now'
  if (seconds < 60) return `refreshed ${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  return `refreshed ${minutes}m ago`
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
  const [detectedProviders, setDetectedProviders] = useState<Array<{ id: string; label: string }>>([])
  const [customRange, setCustomRange] = useState<DateRange | null>(null)
  const [claudeConfigSource, setClaudeConfigSource] = useState<string | null>(initialConfigSource)
  const [refreshToken, setRefreshToken] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [, setCurrencyTick] = useState(0)

  // Preserve the 2/3-arg call shapes when no config is scoped so the CLI argv
  // stays flag-free; only add --claude-config-source once a config is picked.
  const overview = usePolled<MenubarPayload>(
    () => claudeConfigSource
      ? codeburn.getOverview(period, provider, customRange ?? undefined, claudeConfigSource)
      : customRange
      ? codeburn.getOverview(period, provider, customRange)
      : codeburn.getOverview(period, provider),
    [period, provider, customRange?.from, customRange?.to, claudeConfigSource],
    { memoKey: overviewMemoKey(provider, period, customRange, claudeConfigSource) },
  )
  const refreshOverview = overview.refresh

  // Boot readiness: the overview poll is the single cold-cache warmer (long
  // timeout + progress). Other sections gate their first CLI spawn on this so a
  // cold first run hydrates ONCE here instead of fanning out into a parallel
  // full-history parse per section. Flips true the moment overview first has data
  // OR a (resolved) error; LATCHED, so a later uncached switch (which clears
  // overview.data to paint a skeleton) can never re-gate the sections.
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (overview.data != null || overview.error != null) setReady(true)
  }, [overview.data, overview.error])

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

  const trackEvent = useCallback((name: string, props?: Record<string, unknown>) => {
    if (typeof codeburn.telemetryTrack === 'function') void codeburn.telemetryTrack(name, props).catch(() => {})
  }, [])

  // Once-per-day anonymous usage aggregate, only from the canonical view
  // (all providers, standard period, no config scope) so buckets are stable.
  useEffect(() => {
    if (!overview.data || provider !== 'all' || customRange || claudeConfigSource) return
    trackEvent('usage_snapshot', usageSnapshotProps(overview.data))
  }, [overview.data, provider, customRange, claudeConfigSource, trackEvent])

  useEffect(() => {
    let saved: string | null = null
    try { saved = globalThis.localStorage?.getItem('codeburn.theme') ?? null } catch { /* storage can be unavailable */ }
    if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved)
    else document.documentElement.removeAttribute('data-theme')
  }, [])

  useEffect(() => {
    if (!overview.data) return
    const details = overview.data.current.providerDetails
    // Prefer providerDetails (internal id + display label); fall back to the
    // providers map keys (lowercased display names) for older CLIs. The CLI
    // only emits detected providers, so keep every entry (including ones with
    // no spend this period) and sort by cost so zero-cost ones sit at the
    // bottom of the picker.
    const found = details
      ? [...details]
          .sort((a, b) => b.cost - a.cost)
          .map(entry => ({ id: entry.id, label: entry.label }))
      : Object.entries(overview.data.current.providers)
          // Fallback map keys are lowercased display names; ones with spaces
          // ("grok build") cannot round-trip as --provider, so exclude them
          // rather than offer a filter that is guaranteed to error.
          .filter(([key]) => /^[a-z0-9-]+$/.test(key))
          .sort(([, a], [, b]) => b - a)
          .map(([key]) => ({ id: key, label: providerName(key) }))
    setDetectedProviders(current => {
      const next = [...current]
      for (const item of found) if (!next.some(entry => entry.id === item.id)) next.push(item)
      return next.length === current.length ? current : next
    })
  }, [overview.data])

  useEffect(() => {
    const currency = overview.data?.currency
    if (!currency) return
    setActiveCurrency(currency)
    setCurrencyTick(tick => tick + 1)
  }, [overview.data?.currency?.code, overview.data?.currency?.rate, overview.data?.currency?.symbol])

  // Size the instant-switch memo to hold every prefetched provider overview plus
  // the base keys, so warmed entries survive between polls instead of evicting.
  useEffect(() => {
    setPolledMemoMax(detectedProviders.length + BASE_MEMO_KEYS)
  }, [detectedProviders.length])

  // Prefetch for millisecond switches: once the first overview has resolved,
  // quietly warm the instant-switch memo for every OTHER detected provider at the
  // current period, so a picker switch to one paints from memory instead of
  // waiting on a fresh 2-3s CLI spawn. One provider at a time, lowest priority,
  // and only for the plain view (no custom range / no config scope) the picker
  // actually toggles between. The CLI's own read-cache + in-flight coalescing keep
  // this from double-spawning against a live user fetch; hasPolledMemo skips any
  // provider already warm (including one warmed by a real visit).
  //
  // `warmedKeys` is a session-lifetime once-per-key guard: each (provider,period)
  // memo key is marked BEFORE its spawn, so an effect re-run — e.g. an overview
  // poll that momentarily blanked `overview.data` — can never re-spawn a provider
  // already warmed. New keys (a new provider id, or a period switch) still warm
  // exactly once. Without this the prefetch re-fired every poll: 12 redundant
  // full-history CLI parses every 30s, forever.
  const warmedKeys = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!ready || overview.data == null || customRange || claudeConfigSource) return
    const targets = detectedProviders.map(entry => entry.id).filter(id => id !== provider)
    if (targets.length === 0) return
    let cancelled = false
    const warm = async () => {
      for (const id of targets) {
        if (cancelled) return
        const key = overviewMemoKey(id, period, null, null)
        if (warmedKeys.current.has(key) || hasPolledMemo(key)) continue
        warmedKeys.current.add(key)
        try {
          const value = await codeburn.getOverview(period, id)
          if (!cancelled) primePolledMemo(key, value)
        } catch { /* best-effort warm; a real switch will fetch and surface any error */ }
        if (!cancelled) await new Promise(resolve => setTimeout(resolve, PREFETCH_STAGGER_MS))
      }
    }
    const start = setTimeout(() => { void warm() }, PREFETCH_START_DELAY_MS)
    return () => { cancelled = true; clearTimeout(start) }
    // `overview.data == null` (a boolean) gates on first-resolution without
    // re-running every poll; the data content itself is intentionally not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, period, provider, customRange, claudeConfigSource, detectedProviders, overview.data == null])

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  const refreshVisible = useCallback(() => {
    refreshOverview()
    setRefreshToken(token => token + 1)
  }, [refreshOverview])

  const navigate = useCallback((next: Section, pane: SettingsPane = 'general') => {
    setSettingsPane(pane)
    setSection(next)
    trackEvent('section_view', { section: next })
  }, [trackEvent])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return
      const key = event.key.toLowerCase()
      if (key === '1') navigate('overview')
      else if (key === '2') navigate('sessions')
      else if (key === '3') navigate('spend')
      else if (key === '4') navigate('optimize')
      else if (key === '5') navigate('models')
      else if (key === '6') navigate('compare')
      else if (key === '7') navigate('plans')
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
      setCustomRange(null)
      setPeriod(value)
    }
  }

  // A Claude config scopes Claude usage only, so a non-Claude provider filter
  // would make the CLI reject the flag: reset it to 'all' first (a 'claude'
  // filter is already compatible and is left alone).
  const onConfigSelect = (id: string) => {
    const next = id || null
    if (next && provider !== 'all' && provider !== 'claude') setProvider('all')
    setClaudeConfigSource(next)
    persistConfigSource(next)
  }

  // Symmetric direction: picking a non-Claude provider while a config is
  // scoped would hit the same CLI rejection, so drop the config scope.
  const onProviderSelect = (value: string) => {
    if (claudeConfigSource && value !== 'all' && value !== 'claude') {
      setClaudeConfigSource(null)
      persistConfigSource(null)
    }
    setProvider(value)
  }

  const claudeConfigs = overview.data?.claudeConfigs
  const providerOptions = [
    { value: 'all', label: 'All providers' },
    ...detectedProviders.map(entry => ({ value: entry.id, label: entry.label })),
  ]
  const providerLabel = detectedProviders.find(entry => entry.id === provider)?.label ?? providerName(provider)
  const activeConfigLabel = claudeConfigSource
    ? claudeConfigs?.options.find(option => option.id === claudeConfigSource)?.label ?? null
    : null
  const scope = `${customRange ? rangeLabel(customRange) : PERIOD_LABELS[period]} · ${providerLabel}${activeConfigLabel ? ` · ${activeConfigLabel}` : ''}`

  return (
    <Window>
      <Sidebar active={section} onNavigate={navigate} status={<StatusLine polled={overview} />} />
      <ToastHost />
      <Splash hasData={overview.data != null} hasError={overview.error != null} />
      {onboardingStatus && <Onboarding defaultEnabled={onboardingStatus.defaultEnabled} onDone={finishOnboarding} />}
      <div className="ct">
        <div className={overview.switching ? 'switch-line on' : 'switch-line'} aria-hidden="true" />
        <DailyBudgetBanner payload={overview.data ?? null} provider={provider} />
        <ErrorBoundary key={section}>
        {section === 'plans' ? (
          <Plans period={period} refreshToken={refreshToken} onNavigate={navigate} ready={ready} />
        ) : section === 'settings' ? (
          <Settings period={period} refreshToken={refreshToken} onNavigate={navigate} initialPane={settingsPane} claudeConfigs={claudeConfigs} claudeConfigSource={claudeConfigSource} />
        ) : (
          <>
            <TopBar
              title={SECTION_TITLES[section]}
              scope={scope}
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
                <OverviewContent period={period} provider={provider} range={customRange} overview={overview} onNavigate={navigate} ready={ready} />
              ) : section === 'sessions' ? (
                <Sessions period={period} provider={provider} range={customRange} refreshToken={refreshToken} detectedProviders={detectedProviders} onProviderChange={onProviderSelect} ready={ready} />
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
              { k: '⌘1-7', label: 'Navigate' },
              { k: '⌘,', label: 'Settings' },
              { k: '⌘R', label: 'Refresh' },
            ]}
            right={refreshedLabel(overview.lastSuccessAt, overview.loading, now)}
          />
        )}
      </div>
    </Window>
  )
}

function StatusLine({ polled }: { polled: ReturnType<typeof usePolled<MenubarPayload>> }) {
  if (polled.data) {
    return (
      <>
        {polled.data.current.label} <b>{formatUsd(polled.data.current.cost)}</b>
      </>
    )
  }
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
