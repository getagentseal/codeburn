import { useState } from 'react'

import { CliErrorPanel } from '../components/CliErrorPanel'
import { EmptyNote } from '../components/EmptyState'
import { seriesColorForModel } from '../components/ListRow'
import { Panel } from '../components/Panel'
import { SegTabs } from '../components/SegTabs'
import { StaleBanner } from '../components/StaleBanner'
import type { Section } from '../components/Sidebar'
import { usePolled } from '../hooks/usePolled'
import { formatCompact, formatUsd } from '../lib/format'
import { codeburn } from '../lib/ipc'
import type { DateRange, ModelReportRow, Period } from '../lib/types'
import type { SettingsPane } from './Settings'

type ModelsLens = 'model' | 'task'

const LENSES = [
  { value: 'model', label: 'By model' },
  { value: 'task', label: 'By task' },
]

function fmtInt(n: number): string {
  return n.toLocaleString('en-US')
}

export function Models({
  period,
  provider,
  range = null,
  refreshToken = 0,
  onNavigate,
}: {
  period: Period
  provider: string
  range?: DateRange | null
  refreshToken?: number
  onNavigate?: (section: Section, pane?: SettingsPane) => void
}) {
  const [lens, setLens] = useState<ModelsLens>('model')
  const onAddAlias = () => onNavigate?.('settings', 'aliases')
  const byTask = lens === 'task'
  const report = usePolled<ModelReportRow[]>(
    () => range ? codeburn.getModels(period, provider, byTask, range) : codeburn.getModels(period, provider, byTask),
    [period, provider, byTask, range?.from, range?.to, refreshToken],
  )

  if (!report.data) {
    if (report.error) return <CliErrorPanel error={report.error} subject="model usage" />
    return (
      <Panel title="Models">
        <EmptyNote>Scanning model usage…</EmptyNote>
      </Panel>
    )
  }

  return (
    <>
      {report.error && <StaleBanner error={report.error} />}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, alignSelf: 'flex-start' }}>
        <SegTabs options={LENSES} value={lens} onChange={value => setLens(value as ModelsLens)} />
        <button type="button" className="btn btn-s" onClick={() => onNavigate?.('compare')}>
          Compare…
        </button>
      </div>
      <Panel bodyStyle={{ overflowX: 'auto' }}>
        {report.data.length ? (
          <ModelsTable rows={report.data} byTask={byTask} onAddAlias={onAddAlias} />
        ) : (
          <EmptyNote>No model usage in this range yet.</EmptyNote>
        )}
      </Panel>
    </>
  )
}

function ModelsTable({ rows, byTask, onAddAlias }: { rows: ModelReportRow[]; byTask: boolean; onAddAlias: () => void }) {
  if (byTask) return <ModelsByTaskTable rows={rows} onAddAlias={onAddAlias} />

  return (
    <table>
      <thead>
        <tr>
          <th>Model</th>
          <th>Calls</th>
          <th>Input</th>
          <th>Output</th>
          <th>Cache read</th>
          <th>Cost</th>
          <th>Saved</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <ModelTableRow key={`${row.provider}-${row.model}-${i}`} row={row} onAddAlias={onAddAlias} />
        ))}
      </tbody>
    </table>
  )
}

function ModelsByTaskTable({ rows, onAddAlias }: { rows: ModelReportRow[]; onAddAlias: () => void }) {
  const groups = groupTaskRows(rows)

  return (
    <table className="models-by-task">
      <thead>
        <tr>
          <th>Task</th>
          <th>Calls</th>
          <th>Input</th>
          <th>Output</th>
          <th>Cache read</th>
          <th>Cost</th>
          <th>Saved</th>
        </tr>
      </thead>
      {groups.map(group => (
        <tbody className="model-task-group" key={`${group.provider}-${group.model}`}>
          <ModelGroupRow rows={group.rows} onAddAlias={onAddAlias} />
          {group.rows.map((row, i) => (
            <ModelTaskRow key={`${row.category ?? 'all'}-${i}`} row={row} />
          ))}
        </tbody>
      ))}
    </table>
  )
}

function ModelTableRow({ row, onAddAlias }: { row: ModelReportRow; onAddAlias: () => void }) {
  const unpriced = row.costUSD === 0 && row.savingsUSD === 0
  const cellClass = unpriced ? 'dim' : undefined
  const tokenValue = (value: number) => (unpriced ? '—' : formatCompact(value))
  const dotStyle = {
    display: 'inline-block',
    background: seriesColorForModel(row.modelDisplayName || row.model),
    marginRight: 8,
  }

  return (
    <tr>
      <td className={cellClass} title={row.model}>
        <span className="mdot" style={dotStyle} />
        {row.modelDisplayName}
        {unpriced ? (
          <>
            {' '}
            <button type="button" className="alias" onClick={onAddAlias}>add alias ›</button>
          </>
        ) : null}
      </td>
      <td className={cellClass}>{fmtInt(row.calls)}</td>
      <td className={cellClass}>{tokenValue(row.inputTokens)}</td>
      <td className={cellClass}>{tokenValue(row.outputTokens)}</td>
      <td className={cellClass}>{tokenValue(row.cacheReadTokens)}</td>
      <td className={cellClass}>{unpriced ? '—' : formatUsd(row.costUSD)}</td>
      <td className={unpriced ? 'dim' : row.savingsUSD > 0 ? 'pos' : undefined}>{unpriced ? '—' : formatUsd(row.savingsUSD)}</td>
    </tr>
  )
}

function ModelGroupRow({ rows, onAddAlias }: { rows: ModelReportRow[]; onAddAlias: () => void }) {
  const model = rows[0]
  const calls = rows.reduce((sum, row) => sum + row.calls, 0)
  const costUSD = rows.reduce((sum, row) => sum + row.costUSD, 0)
  const savingsUSD = rows.reduce((sum, row) => sum + row.savingsUSD, 0)
  const unpriced = costUSD === 0 && savingsUSD === 0

  return (
    <tr className="model-group-row">
      <td className={unpriced ? 'dim' : undefined} title={model.model}>
        <span className="model-group-lead">
          <span
            className="mdot"
            style={{ background: seriesColorForModel(model.modelDisplayName || model.model) }}
          />
          <span className="model-group-name">{model.modelDisplayName}</span>
          {unpriced ? <button type="button" className="alias" onClick={onAddAlias}>add alias ›</button> : null}
        </span>
      </td>
      <td className={unpriced ? 'dim' : undefined}>{fmtInt(calls)}</td>
      <td aria-label="No aggregate input" />
      <td aria-label="No aggregate output" />
      <td aria-label="No aggregate cache read" />
      <td className={unpriced ? 'dim' : undefined}>{unpriced ? '—' : formatUsd(costUSD)}</td>
      <td className={unpriced ? 'dim' : savingsUSD > 0 ? 'pos' : undefined}>{unpriced ? '—' : formatUsd(savingsUSD)}</td>
    </tr>
  )
}

function ModelTaskRow({ row }: { row: ModelReportRow }) {
  const unpriced = row.costUSD === 0 && row.savingsUSD === 0
  const cellClass = unpriced ? 'dim' : undefined
  const tokenValue = (value: number) => (unpriced ? '—' : formatCompact(value))

  return (
    <tr className="model-task-row">
      <td className={cellClass}>{row.category ?? 'general'}</td>
      <td className={cellClass}>{fmtInt(row.calls)}</td>
      <td className={cellClass}>{tokenValue(row.inputTokens)}</td>
      <td className={cellClass}>{tokenValue(row.outputTokens)}</td>
      <td className={cellClass}>{tokenValue(row.cacheReadTokens)}</td>
      <td className={cellClass}>{unpriced ? '—' : formatUsd(row.costUSD)}</td>
      <td className={unpriced ? 'dim' : row.savingsUSD > 0 ? 'pos' : undefined}>{unpriced ? '—' : formatUsd(row.savingsUSD)}</td>
    </tr>
  )
}

function groupTaskRows(rows: ModelReportRow[]) {
  const groups = new Map<string, { provider: string; model: string; rows: ModelReportRow[] }>()
  for (const row of rows) {
    const key = `${row.provider}\u0000${row.model}`
    const group = groups.get(key)
    if (group) group.rows.push(row)
    else groups.set(key, { provider: row.provider, model: row.model, rows: [row] })
  }
  return [...groups.values()]
}
