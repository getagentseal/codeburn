import { useState } from 'react'

import { CliErrorPanel, CliErrorText } from '../components/CliErrorPanel'
import { ListRow } from '../components/ListRow'
import { Panel } from '../components/Panel'
import { Sankey } from '../components/Sankey'
import { SegTabs } from '../components/SegTabs'
import { StackedBars } from '../components/StackedBars'
import { type Polled, usePolled } from '../hooks/usePolled'
import { formatUsd } from '../lib/format'
import { codeburn } from '../lib/ipc'
import { sliceDailyToPeriod } from '../lib/period'
import type { DateRange, MenubarPayload, Period, SpendFlow } from '../lib/types'

type Lens = 'projects' | 'activity' | 'tools' | 'mcp' | 'subagents'

const LENSES = [
  { value: 'projects', label: 'Projects' },
  { value: 'activity', label: 'Activity' },
  { value: 'tools', label: 'Tools' },
  { value: 'mcp', label: 'MCP' },
  { value: 'subagents', label: 'Subagents' },
]

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p style={{ color: 'var(--t3)', margin: 0, fontSize: 12 }}>{children}</p>
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
  const [lens, setLens] = useState<Lens>('projects')

  if (!overview.data) {
    if (overview.error) return <CliErrorPanel error={overview.error} subject="spend" />
    return (
      <Panel title="Spend">
        <EmptyNote>Scanning spend…</EmptyNote>
      </Panel>
    )
  }

  return (
    <>
      <SegTabs options={LENSES} value={lens} onChange={value => setLens(value as Lens)} style={{ alignSelf: 'flex-start' }} />
      {lens === 'projects' ? (
        <ProjectsLens data={overview.data} flow={flow} period={period} range={range} />
      ) : (
        <DetailLens data={overview.data} lens={lens} />
      )}
    </>
  )
}

function ProjectsLens({
  data,
  flow,
  period,
  range,
}: {
  data: MenubarPayload
  flow: ReturnType<typeof usePolled<SpendFlow>>
  period: Period
  range: DateRange | null
}) {
  const daily = range
    ? data.history.daily.filter(day => day.date >= range.from && day.date <= range.to)
    : sliceDailyToPeriod(data.history.daily, period)
  const projects = data.current.topProjects

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Panel title="Daily spend by model" className="spend-chart-panel">
          {daily.length ? <StackedBars daily={daily} /> : <EmptyNote>No model spend in this range yet.</EmptyNote>}
        </Panel>
        <Panel title="By project" right={projects.length ? `top ${projects.length}` : undefined}>
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

      <Panel title="Cost flow · model → project" right="click a ribbon to filter" bodyStyle={{ overflowX: 'auto' }}>
        {flow.data && flow.data.links.length ? (
          <Sankey flow={flow.data} />
        ) : flow.error ? (
          <CliErrorText error={flow.error} />
        ) : (
          <EmptyNote>{flow.loading ? 'Loading cost flow…' : 'No model-project flow in this range yet.'}</EmptyNote>
        )}
      </Panel>
    </>
  )
}

function DetailLens({ data, lens }: { data: MenubarPayload; lens: Exclude<Lens, 'projects'> }) {
  if (lens === 'activity') {
    const rows = [
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
    ]
    return <RowsPanel title="Activity" rows={rows} empty="No activity or skill spend in this range yet." />
  }

  if (lens === 'tools') {
    const rows = data.current.tools.map(row => ({
      key: row.name,
      title: row.name,
      sub: `${row.calls.toLocaleString('en-US')} calls`,
      value: undefined,
    }))
    return <RowsPanel title="Tools" rows={rows} empty="No tool calls in this range yet." />
  }

  if (lens === 'mcp') {
    const rows = data.current.mcpServers.map(row => ({
      key: row.name,
      title: row.name,
      sub: `${row.calls.toLocaleString('en-US')} calls`,
      value: undefined,
    }))
    return <RowsPanel title="MCP" rows={rows} empty="No MCP server calls in this range yet." />
  }

  const rows = data.current.subagents.map(row => ({
    key: row.name,
    title: row.name,
    sub: `${row.calls.toLocaleString('en-US')} calls`,
    value: formatUsd(row.cost),
  }))
  return <RowsPanel title="Subagents" rows={rows} empty="No subagent spend in this range yet." />
}

function RowsPanel({
  title,
  rows,
  empty,
}: {
  title: string
  rows: Array<{ key: string; title: string; sub: string; value?: string }>
  empty: string
}) {
  return (
    <Panel title={title}>
      {rows.length ? (
        rows.map((row, i) => (
          <ListRow key={row.key} no={String(i + 1).padStart(2, '0')} title={row.title} sub={row.sub} value={row.value} />
        ))
      ) : (
        <EmptyNote>{empty}</EmptyNote>
      )}
    </Panel>
  )
}
