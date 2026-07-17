import { Fragment, useState } from 'react'

import { CliErrorPanel, CliErrorText } from '../components/CliErrorPanel'
import { EmptyNote } from '../components/EmptyState'
import { ListRow } from '../components/ListRow'
import { Panel } from '../components/Panel'
import { Sankey } from '../components/Sankey'
import { SectionSkeleton } from '../components/Skeleton'
import { StackedBars } from '../components/StackedBars'
import { StaleBanner } from '../components/StaleBanner'
import { type Polled, usePolled } from '../hooks/usePolled'
import { formatUsd } from '../lib/format'
import { codeburn } from '../lib/ipc'
import { contiguousDailyWindow, localDateKey } from '../lib/period'
import type { CliError, DateRange, MenubarPayload, Period, SpendFlow } from '../lib/types'

type Project = MenubarPayload['current']['topProjects'][number]

/** Date-only CLI strings ("2026-07-11") formatted at local noon so the calendar day never rolls across time zones. */
function formatProjectDay(date: string): string {
  const d = new Date(`${date}T12:00:00`)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const SPEND_CHART_DAYS = 15

function providerLabel(provider: string): string {
  if (provider === 'all') return 'All models'
  return provider
    .split(/[-\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function Spend({ period, provider, range = null }: { period: Period; provider: string; range?: DateRange | null }) {
  const overview = usePolled<MenubarPayload>(
    () => range ? codeburn.getOverview(period, provider, range) : codeburn.getOverview(period, provider),
    [period, provider, range?.from, range?.to],
  )
  return <SpendContent period={period} provider={provider} range={range} overview={overview} />
}

export function SpendContent({
  period,
  provider,
  range = null,
  overview,
  refreshToken = 0,
  ready = true,
}: {
  period: Period
  provider: string
  range?: DateRange | null
  overview: Polled<MenubarPayload>
  refreshToken?: number
  ready?: boolean
}) {
  // Gate on app-level readiness so boot hydrates the cache once (default true
  // keeps standalone renders/tests polling normally).
  const flow = usePolled<SpendFlow>(
    () => range ? codeburn.getSpendFlow(period, provider, range) : codeburn.getSpendFlow(period, provider),
    [period, provider, range?.from, range?.to, refreshToken],
    { enabled: ready, memoKey: `spendflow|${period}|${provider}|${range?.from ?? ''}-${range?.to ?? ''}` },
  )

  if (!overview.data) {
    if (overview.error) return <CliErrorPanel error={overview.error} subject="spend" />
    return <SectionSkeleton label="Scanning spend…" rows={3} chart />
  }

  const animateKey = `${period}|${provider}|${range?.from ?? ''}|${range?.to ?? ''}`
  return <SpendPage data={overview.data} flow={flow} provider={provider} range={range} staleError={overview.error} animateKey={animateKey} />
}

function SpendPage({
  data,
  flow,
  provider,
  range,
  staleError,
  animateKey,
}: {
  data: MenubarPayload
  flow: ReturnType<typeof usePolled<SpendFlow>>
  provider: string
  range: DateRange | null
  staleError: CliError | null
  animateKey: string
}) {
  // `history.daily` is SPARSE (active days only), so zero-fill a contiguous
  // calendar window client-side; date keys are localDateKey / the CLI dateKey,
  // which match exactly, so real days always land in place.
  const now = new Date()
  const chartDaily = range
    ? contiguousDailyWindow(data.history.daily, range.from, range.to)
    : contiguousDailyWindow(
        data.history.daily,
        localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (SPEND_CHART_DAYS - 1))),
        localDateKey(now),
      )
  const chartHasSpend = chartDaily.some(day => day.cost > 0)
  const projects = data.current.topProjects
  const breakdowns = [
    {
      title: 'Activity',
      rows: [
        ...data.current.topActivities.map(row => ({
          key: `activity-${row.name}`,
          title: row.name,
          sub: `${row.turns.toLocaleString('en-US')} turns`,
          value: formatUsd(row.cost),
        })),
        ...data.current.skills.map(row => ({
          key: `skill-${row.name}`,
          title: row.name,
          sub: `${row.turns.toLocaleString('en-US')} turns · skill`,
          value: formatUsd(row.cost),
        })),
      ],
    },
    {
      title: 'Tools',
      rows: data.current.tools.map(row => ({
        key: row.name,
        title: row.name,
        sub: `${row.calls.toLocaleString('en-US')} calls`,
        value: undefined,
      })),
    },
    {
      title: 'MCP',
      rows: data.current.mcpServers.map(row => ({
        key: row.name,
        title: row.name,
        sub: `${row.calls.toLocaleString('en-US')} calls`,
        value: undefined,
      })),
    },
    {
      title: 'Subagents',
      rows: data.current.subagents.map(row => ({
        key: row.name,
        title: row.name,
        sub: `${row.calls.toLocaleString('en-US')} calls`,
        value: formatUsd(row.cost),
      })),
    },
  ].filter(section => section.rows.length)

  return (
    <>
      {staleError && <StaleBanner error={staleError} />}
      <div className="spend-top-row">
        <Panel title="Daily spend by model" className="spend-chart-panel">
          {chartHasSpend ? <StackedBars daily={chartDaily} fallbackLabel={providerLabel(provider)} animateKey={animateKey} /> : <EmptyNote>No model spend in this range yet.</EmptyNote>}
        </Panel>
        <ProjectBreakdown projects={projects} />
      </div>

      <Panel title="Cost flow · model → project" right="model → project flow for this range" className="scroll-x">
        {flow.data && flow.data.links.length ? (
          <Sankey flow={flow.data} />
        ) : flow.error ? (
          <CliErrorText error={flow.error} />
        ) : (
          <EmptyNote>{flow.loading ? 'Loading cost flow…' : 'No model-project flow in this range yet.'}</EmptyNote>
        )}
      </Panel>

      <div className="spend-breakdowns">
        {breakdowns.length ? (
          breakdowns.map(section => <RowsPanel key={section.title} title={section.title} rows={section.rows} />)
        ) : (
          <EmptyNote>No activity, tool, MCP, or subagent data in this range yet.</EmptyNote>
        )}
      </div>
    </>
  )
}

function ProjectBreakdown({ projects }: { projects: Project[] }) {
  const [expanded, setExpanded] = useState<string | null>(null)

  return (
    <Panel title="By project" right={projects.length ? `top ${projects.length}` : undefined} className="spend-scroll">
      {projects.length ? (
        projects.map((project, i) => {
          const open = expanded === project.name
          return (
            <Fragment key={project.name}>
              <ListRow
                no={String(i + 1).padStart(2, '0')}
                title={project.name}
                sub={`${project.sessions.toLocaleString('en-US')} ${project.sessions === 1 ? 'session' : 'sessions'}`}
                value={formatUsd(project.cost)}
                expanded={open}
                onClick={() => setExpanded(current => current === project.name ? null : project.name)}
              />
              {open && (
                <div className="spend-proj-detail" role="region" aria-label={`${project.name} sessions`}>
                  {project.sessionDetails.length ? (
                    project.sessionDetails.map((session, j) => (
                      <div className="spend-proj-session" key={`${session.date}-${j}`}>
                        <span className="sps-date">{formatProjectDay(session.date)}</span>
                        <span className="sps-model">{session.models[0]?.name ?? '—'}</span>
                        <span className="sps-calls">{session.calls.toLocaleString('en-US')} calls</span>
                        <span className="sps-cost">{formatUsd(session.cost)}</span>
                      </div>
                    ))
                  ) : (
                    <div className="spend-proj-empty">No session detail for this project.</div>
                  )}
                </div>
              )}
            </Fragment>
          )
        })
      ) : (
        <EmptyNote>No project spend in this range yet.</EmptyNote>
      )}
    </Panel>
  )
}

function RowsPanel({
  title,
  rows,
}: {
  title: string
  rows: Array<{ key: string; title: string; sub: string; value?: string }>
}) {
  return (
    <Panel title={title} className="spend-scroll">
      {rows.map((row, i) => (
        <ListRow key={row.key} no={String(i + 1).padStart(2, '0')} title={row.title} sub={row.sub} value={row.value} />
      ))}
    </Panel>
  )
}
