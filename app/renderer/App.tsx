import { useState } from 'react'

import { Hint } from './components/Hint'
import { Panel } from './components/Panel'
import { Sidebar, type Section } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { Window } from './components/Window'
import { usePolled } from './hooks/usePolled'
import { codeburn } from './lib/ipc'
import { Overview } from './sections/Overview'
import { Optimize } from './sections/Optimize'
import { Models } from './sections/Models'
import { Plans } from './sections/Plans'
import { Spend } from './sections/Spend'
import type { MenubarPayload, Period } from './lib/types'

const SECTION_TITLES: Record<Section, string> = {
  overview: 'Overview',
  spend: 'Spend',
  optimize: 'Optimize',
  models: 'Models',
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

function fmtUsd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function App() {
  const [section, setSection] = useState<Section>('overview')
  const [period, setPeriod] = useState<Period>('30days')
  const provider = 'all'

  // Polled at the app level: proves the spawn→IPC→render path and feeds the
  // sidebar status line. Section-specific fetching lands in T2–T7.
  const overview = usePolled<MenubarPayload>(() => codeburn.getOverview(period, provider), [period, provider])

  const onPeriodChange = (value: string) => {
    // 6M / Custom (date ranges) are not wired until T8; ignore for now so the
    // highlight never lies about what was fetched.
    if (isPeriod(value)) setPeriod(value)
  }

  const scope = `${PERIOD_LABELS[period]} · All providers`

  return (
    <Window>
      <Sidebar active={section} onNavigate={setSection} status={<StatusLine polled={overview} />} />
      <div className="ct">
        {section === 'plans' ? (
          <Plans period={period} />
        ) : (
          <>
            <TopBar
              title={SECTION_TITLES[section]}
              scope={section === 'settings' ? undefined : scope}
              period={period}
              onPeriodChange={onPeriodChange}
              providerLabel="All providers"
            />
            <div className="body">
              {section === 'overview' ? (
                <Overview period={period} provider={provider} />
              ) : section === 'spend' ? (
                <Spend period={period} provider={provider} />
              ) : section === 'optimize' ? (
                <Optimize period={period} provider={provider} />
              ) : section === 'models' ? (
                <Models period={period} provider={provider} />
              ) : (
                <SectionPlaceholder title={SECTION_TITLES[section]} />
              )}
            </div>
          </>
        )}
        <Hint
          items={[
            { k: '⌘K', label: 'Command' },
            { k: '⌘E', label: 'Export view' },
          ]}
          right={overview.loading ? 'refreshing…' : 'auto-refresh 30s'}
        />
      </div>
    </Window>
  )
}

function StatusLine({ polled }: { polled: ReturnType<typeof usePolled<MenubarPayload>> }) {
  if (polled.data) {
    return (
      <>
        {polled.data.current.label} <b>{fmtUsd(polled.data.current.cost)}</b>
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
      <p style={{ color: 'var(--t3)', margin: 0, fontSize: 12 }}>
        {title} lands in a later task. The shell, data bridge, and design system are in place.
      </p>
    </Panel>
  )
}
