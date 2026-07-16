import { useCallback, useEffect, useState } from 'react'

import { EmptyNote } from './components/EmptyState'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Hint } from './components/Hint'
import { Panel } from './components/Panel'
import { Sidebar, type Section } from './components/Sidebar'
import { rangeLabel, TopBar } from './components/TopBar'
import { Window } from './components/Window'
import { usePolled } from './hooks/usePolled'
import { formatUsd, setActiveCurrency } from './lib/format'
import { codeburn } from './lib/ipc'
import { OverviewContent } from './sections/Overview'
import { OptimizeContent } from './sections/Optimize'
import { Models } from './sections/Models'
import { Sessions } from './sections/Sessions'
import { Compare } from './sections/Compare'
import { Plans } from './sections/Plans'
import { Settings, type SettingsPane } from './sections/Settings'
import { SpendContent } from './sections/Spend'
import type { DateRange, MenubarPayload, Period } from './lib/types'

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

function isPeriod(value: string): value is Period {
  return (STANDARD_PERIODS as string[]).includes(value)
}

/** Boot period = the persisted "Default period" Settings writes, else 30 days. */
function initialPeriod(): Period {
  let saved: string | null = null
  try { saved = globalThis.localStorage?.getItem('codeburn.defaultPeriod') ?? null } catch { /* storage can be unavailable */ }
  return saved && isPeriod(saved) ? saved : '30days'
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

export function App() {
  const [section, setSection] = useState<Section>('overview')
  const [settingsPane, setSettingsPane] = useState<SettingsPane>('general')
  const [period, setPeriod] = useState<Period>(initialPeriod)
  const [provider, setProvider] = useState<string>('all')
  const [detectedProviders, setDetectedProviders] = useState<Array<{ id: string; label: string }>>([])
  const [customRange, setCustomRange] = useState<DateRange | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [, setCurrencyTick] = useState(0)

  const overview = usePolled<MenubarPayload>(
    () => customRange
      ? codeburn.getOverview(period, provider, customRange)
      : codeburn.getOverview(period, provider),
    [period, provider, customRange?.from, customRange?.to],
  )
  const refreshOverview = overview.refresh

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
    // providers map keys (lowercased display names) for older CLIs.
    const found = details
      ? details.filter(entry => entry.cost > 0).map(entry => ({ id: entry.id, label: entry.label }))
      : Object.entries(overview.data.current.providers).filter(([, value]) => value > 0).map(([key]) => ({ id: key, label: providerName(key) }))
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
  }, [])

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

  const providerOptions = [
    { value: 'all', label: 'All providers' },
    ...detectedProviders.map(entry => ({ value: entry.id, label: entry.label })),
  ]
  const providerLabel = detectedProviders.find(entry => entry.id === provider)?.label ?? providerName(provider)
  const scope = `${customRange ? rangeLabel(customRange) : PERIOD_LABELS[period]} · ${providerLabel}`

  return (
    <Window>
      <Sidebar active={section} onNavigate={navigate} status={<StatusLine polled={overview} />} />
      <div className="ct">
        <ErrorBoundary key={section}>
        {section === 'plans' ? (
          <Plans period={period} refreshToken={refreshToken} onNavigate={navigate} />
        ) : section === 'settings' ? (
          <Settings period={period} refreshToken={refreshToken} onNavigate={navigate} initialPane={settingsPane} />
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
              onProviderSelect={setProvider}
            />
            <div className="body">
              {section === 'overview' ? (
                <OverviewContent period={period} provider={provider} range={customRange} overview={overview} onNavigate={navigate} />
              ) : section === 'sessions' ? (
                <Sessions period={period} provider={provider} range={customRange} refreshToken={refreshToken} />
              ) : section === 'spend' ? (
                <SpendContent period={period} provider={provider} range={customRange} overview={overview} refreshToken={refreshToken} />
              ) : section === 'optimize' ? (
                <OptimizeContent period={period} provider={provider} range={customRange} overview={overview} refreshToken={refreshToken} />
              ) : section === 'models' ? (
                <Models period={period} provider={provider} range={customRange} refreshToken={refreshToken} onNavigate={navigate} />
              ) : section === 'compare' ? (
                <Compare period={period} provider={provider} range={customRange} refreshToken={refreshToken} />
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
