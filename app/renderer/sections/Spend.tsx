import { CliErrorPanel, CliErrorText } from '../components/CliErrorPanel'
import { EmptyNote } from '../components/EmptyState'
import { ListRow } from '../components/ListRow'
import { Panel } from '../components/Panel'
import { Sankey } from '../components/Sankey'
import { StackedBars } from '../components/StackedBars'
import { StaleBanner } from '../components/StaleBanner'
import { type Polled, usePolled } from '../hooks/usePolled'
import { formatUsd } from '../lib/format'
import { codeburn } from '../lib/ipc'
import { contiguousDailyWindow, localDateKey } from '../lib/period'
import type { CliError, DateRange, MenubarPayload, Period, SpendFlow } from '../lib/types'

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
}: {
  period: Period
  provider: string
  range?: DateRange | null
  overview: Polled<MenubarPayload>
  refreshToken?: number
}) {
  const flow = usePolled<SpendFlow>(
    () => range ? codeburn.getSpendFlow(period, provider, range) : codeburn.getSpendFlow(period, provider),
    [period, provider, range?.from, range?.to, refreshToken],
  )

  if (!overview.data) {
    if (overview.error) return <CliErrorPanel error={overview.error} subject="spend" />
    return (
      <Panel title="Spend">
        <EmptyNote>Scanning spend…</EmptyNote>
      </Panel>
    )
  }

  return <SpendPage data={overview.data} flow={flow} provider={provider} range={range} staleError={overview.error} />
}

function SpendPage({
  data,
  flow,
  provider,
  range,
  staleError,
}: {
  data: MenubarPayload
  flow: ReturnType<typeof usePolled<SpendFlow>>
  provider: string
  range: DateRange | null
  staleError: CliError | null
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
          {chartHasSpend ? <StackedBars daily={chartDaily} fallbackLabel={providerLabel(provider)} /> : <EmptyNote>No model spend in this range yet.</EmptyNote>}
        </Panel>
        <Panel title="By project" right={projects.length ? `top ${projects.length}` : undefined} className="spend-scroll">
          {projects.length ? (
            projects.map((project, i) => (
              <ListRow
                key={project.name}
                no={String(i + 1).padStart(2, '0')}
                title={project.name}
                sub={`${project.sessions.toLocaleString('en-US')} ${project.sessions === 1 ? 'session' : 'sessions'}`}
                value={formatUsd(project.cost)}
              />
            ))
          ) : (
            <EmptyNote>No project spend in this range yet.</EmptyNote>
          )}
        </Panel>
      </div>

      <Panel title="Cost flow · model → project" right="model → project flow for this range" bodyStyle={{ overflowX: 'auto' }}>
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
