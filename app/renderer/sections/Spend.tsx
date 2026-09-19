import { Fragment, useState } from 'react'

import { BranchBreakdown } from '../components/BranchBreakdown'
import { CliErrorPanel, CliErrorText } from '../components/CliErrorPanel'
import { EmptyNote } from '../components/EmptyState'
import { ListRow } from '../components/ListRow'
import { Panel } from '../components/Panel'
import { Punchcard } from '../components/Punchcard'
import { Sankey } from '../components/Sankey'
import { SectionSkeleton } from '../components/Skeleton'
import { StackedBars } from '../components/StackedBars'
import { StaleBanner } from '../components/StaleBanner'
import { type Polled, usePolled } from '../hooks/usePolled'
import { formatCount, formatUsd } from '../lib/format'
import { codeburn } from '../lib/ipc'
import { contiguousDailyWindow, dataStartKey, localDateKey } from '../lib/period'
import { reportMemoKey } from '../lib/reportMemoKey'
import { projectFilters } from '../lib/investigation'
import { formatSessionCount, sessionCountHelp } from '../lib/session-count-label'
import type { CliError, DateRange, MenubarPayload, Period, SpendFlow } from '../lib/types'
import { localeTag, t } from '../i18n'

import type { InvestigateRequest } from './Overview'

type Project = MenubarPayload['current']['topProjects'][number]

function projectRowKey(project: Project, index: number): string {
  return project.id || `legacy:${index}:${project.name}`
}

/** Date-only CLI strings ("2026-07-11") formatted at local noon so the calendar day never rolls across time zones. */
function formatProjectDay(date: string): string {
  const d = new Date(`${date}T12:00:00`)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(localeTag(), { month: 'short', day: 'numeric' })
}

const SPEND_CHART_DAYS = 15

function providerLabel(provider: string): string {
  if (provider === 'all') return t('spend.provider.allModels')
  return provider
    .split(/[-\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function SpendPunchcard({ period, provider, range }: { period: Period; provider: string; range: DateRange | null }) {
  const payload = usePolled<MenubarPayload>(
    () => range ? codeburn.getTimeline(period, provider, range) : codeburn.getTimeline(period, provider),
    [period, provider, range?.from, range?.to],
  )
  const timeline = payload.data?.history.timeline
  if (!timeline) return null
  return (
    <Panel title={t('spend.punchcard.title')} right={t('spend.punchcard.right')}>
      <Punchcard timeline={timeline} />
    </Panel>
  )
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
  onInvestigate,
}: {
  period: Period
  provider: string
  range?: DateRange | null
  overview: Polled<MenubarPayload>
  refreshToken?: number
  ready?: boolean
  onInvestigate?: (request: InvestigateRequest) => void
}) {
  // Gate on app-level readiness so boot hydrates the cache once (default true
  // keeps standalone renders/tests polling normally).
  const flow = usePolled<SpendFlow>(
    () => range ? codeburn.getSpendFlow(period, provider, range) : codeburn.getSpendFlow(period, provider),
    [period, provider, range?.from, range?.to, refreshToken],
    { enabled: ready, memoKey: reportMemoKey('spendflow', period, provider, range) },
  )

  if (!overview.data) {
    if (overview.error) return <CliErrorPanel error={overview.error} subject={t('common.subject.spend')} />
    return <SectionSkeleton label={t('spend.loading.scanning')} rows={3} chart />
  }

  const animateKey = `${period}|${provider}|${range?.from ?? ''}|${range?.to ?? ''}`
  return <SpendPage data={overview.data} flow={flow} period={period} provider={provider} range={range} staleError={overview.error} animateKey={animateKey} onInvestigate={onInvestigate} />
}

function SpendPage({
  data,
  flow,
  period,
  provider,
  range,
  staleError,
  animateKey,
  onInvestigate,
}: {
  data: MenubarPayload
  flow: ReturnType<typeof usePolled<SpendFlow>>
  period: Period
  provider: string
  range: DateRange | null
  staleError: CliError | null
  animateKey: string
  onInvestigate?: (request: InvestigateRequest) => void
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
  const dataStart = dataStartKey(data.history.daily)
  const projects = data.current.topProjects
  const breakdowns = [
    {
      title: t('spend.breakdown.activity'),
      rows: [
        ...data.current.topActivities.map(row => ({
          key: `activity-${row.name}`,
          title: row.name,
          sub: formatCount(row.turns, 'turn'),
          value: formatUsd(row.cost),
        })),
        ...data.current.skills.map(row => ({
          key: `skill-${row.name}`,
          title: row.name,
          sub: t('spend.breakdown.skillSuffix', { turns: formatCount(row.turns, 'turn') }),
          value: formatUsd(row.cost),
        })),
      ],
    },
    {
      title: t('spend.breakdown.tools'),
      rows: data.current.tools.map(row => ({
        key: row.name,
        title: row.name,
        sub: formatCount(row.calls, 'call'),
        value: undefined,
      })),
    },
    {
      title: t('spend.breakdown.mcp'),
      rows: data.current.mcpServers.map(row => ({
        key: row.name,
        title: row.name,
        sub: formatCount(row.calls, 'call'),
        value: undefined,
      })),
    },
    {
      title: t('spend.breakdown.subagents'),
      rows: data.current.subagents.map(row => ({
        key: row.name,
        title: row.name,
        sub: formatCount(row.calls, 'call'),
        value: formatUsd(row.cost),
      })),
    },
  ].filter(section => section.rows.length)

  return (
    <>
      {staleError && <StaleBanner error={staleError} />}
      <div className="spend-top-row">
        <Panel title={t('spend.chart.title')} className="spend-chart-panel">
          {chartHasSpend ? <StackedBars daily={chartDaily} fallbackLabel={providerLabel(provider)} animateKey={animateKey} dataStart={dataStart} /> : <EmptyNote>{t('spend.chart.empty')}</EmptyNote>}
        </Panel>
        <ProjectBreakdown projects={projects} onInvestigate={onInvestigate} />
      </div>

      <BranchBreakdown period={period} provider={provider} range={range} />

      <Panel title={t('spend.flow.title')} right={t('spend.flow.right')} className="scroll-x">
        {flow.data && flow.data.links.length ? (
          <Sankey flow={flow.data} />
        ) : flow.error ? (
          <CliErrorText error={flow.error} />
        ) : (
          <EmptyNote>{flow.loading ? t('spend.flow.loading') : t('spend.flow.empty')}</EmptyNote>
        )}
      </Panel>

      <SpendPunchcard period={period} provider={provider} range={range} />

      <div className="spend-breakdowns">
        {breakdowns.length ? (
          breakdowns.map(section => <RowsPanel key={section.title} title={section.title} rows={section.rows} />)
        ) : (
          <EmptyNote>{t('spend.breakdown.emptyAll')}</EmptyNote>
        )}
      </div>
    </>
  )
}

function ProjectBreakdown({ projects, onInvestigate }: { projects: Project[]; onInvestigate?: (request: InvestigateRequest) => void }) {
  const [expanded, setExpanded] = useState<string | null>(null)

  return (
    <Panel title={t('spend.project.title')} right={projects.length ? t('spend.project.top', { count: projects.length }) : undefined} className="spend-scroll">
      {projects.length ? (
        projects.map((project, i) => {
          const rowKey = projectRowKey(project, i)
          const open = expanded === rowKey
          return (
            <Fragment key={rowKey}>
              <ListRow
                no={String(i + 1).padStart(2, '0')}
                title={project.name}
                sub={<span title={project.sessionCountBasis === 'identity' ? undefined : sessionCountHelp()}>{formatSessionCount(project.sessions, project.sessionCountBasis)}</span>}
                value={formatUsd(project.cost)}
                expanded={open}
                onClick={() => setExpanded(current => current === rowKey ? null : rowKey)}
              />
              {open && (
                <div className="spend-proj-detail" role="region" aria-label={t('spend.project.sessionsAria', { name: project.name })}>
                  {/* Drill-through entry: canonical project id (the same one the
                      session rows carry), so the destination matches exactly. */}
                  {onInvestigate && (
                    <button
                      className="ov-link spend-proj-drill"
                      type="button"
                      onClick={() => onInvestigate({ filters: projectFilters(project.id || project.name) })}
                    >
                      {t('spend.project.viewSessions')}
                    </button>
                  )}
                  {project.sessionDetails.length ? (
                    project.sessionDetails.map((session, j) => (
                      <div className="spend-proj-session" key={`${session.date}-${j}`}>
                        <span className="sps-date">{formatProjectDay(session.date)}</span>
                        <span className="sps-model">{session.models[0]?.name ?? '—'}</span>
                        <span className="sps-calls">{formatCount(session.calls, 'call')}</span>
                        <span className="sps-cost">{formatUsd(session.cost)}</span>
                      </div>
                    ))
                  ) : (
                    <div className="spend-proj-empty">{t('spend.project.noDetail')}</div>
                  )}
                </div>
              )}
            </Fragment>
          )
        })
      ) : (
        <EmptyNote>{t('spend.project.empty')}</EmptyNote>
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
