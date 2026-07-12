import { useCallback, useEffect, useState } from 'react'

import { CliErrorPanel } from '../components/CliErrorPanel'
import { Panel } from '../components/Panel'
import { usePolled } from '../hooks/usePolled'
import { formatCompact, formatUsd } from '../lib/format'
import { codeburn } from '../lib/ipc'
import type { CompareJsonReport, ComparisonRow, ModelStats, Period, WorkingStyleRow } from '../lib/types'

function fmtMetric(v: number | null, fn: 'cost' | 'number' | 'percent' | 'decimal'): string {
  if (v === null) return '—'
  if (fn === 'cost') return formatUsd(v)
  if (fn === 'percent') return `${v.toFixed(0)}%`
  if (fn === 'decimal') return v.toFixed(2)
  return Math.round(v).toLocaleString('en-US')
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p style={{ color: 'var(--t3)', margin: 0, fontSize: 12 }}>{children}</p>
}

export function Compare({
  period,
  provider,
  refreshToken = 0,
}: {
  period: Period
  provider: string
  refreshToken?: number
}) {
  const models = usePolled<ModelStats[]>(
    () => codeburn.getCompareModels(period, provider),
    [period, provider, refreshToken],
  )
  const [modelA, setModelA] = useState<string | null>(null)
  const [modelB, setModelB] = useState<string | null>(null)

  useEffect(() => {
    if (!models.data) return
    const available = new Set(models.data.map(model => model.model))
    setModelA(current => current && available.has(current) ? current : models.data?.[0]?.model ?? null)
    setModelB(current => current && available.has(current) ? current : models.data?.[1]?.model ?? null)
  }, [models.data])

  const resetToDefaults = useCallback(() => {
    if (!models.data) return
    setModelA(models.data[0]?.model ?? null)
    setModelB(models.data[1]?.model ?? null)
  }, [models.data])

  if (!models.data) {
    if (models.error) return <CliErrorPanel error={models.error} subject="model comparisons" />
    return (
      <Panel title="Compare">
        <EmptyNote>Scanning model usage…</EmptyNote>
      </Panel>
    )
  }

  if (models.data.length < 2) {
    return (
      <Panel title="Compare">
        <EmptyNote>Need at least two models with usage in this range to compare.</EmptyNote>
      </Panel>
    )
  }

  const modelRows = models.data
  const nudgeDistinct = (chosen: string) => modelRows.find(model => model.model !== chosen)?.model ?? null

  return (
    <>
      <div className="cmp-picker" aria-label="Models being compared">
        <select
          className="cmp-select"
          aria-label="First model"
          value={modelA ?? ''}
          onChange={event => {
            const next = event.target.value
            setModelA(next)
            if (next === modelB) setModelB(nudgeDistinct(next))
          }}
        >
          {modelRows.map(model => <option key={model.model} value={model.model}>{model.model} · {model.calls.toLocaleString()} calls</option>)}
        </select>
        <span className="cmp-vs">vs</span>
        <select
          className="cmp-select"
          aria-label="Second model"
          value={modelB ?? ''}
          onChange={event => {
            const next = event.target.value
            setModelB(next)
            if (next === modelA) setModelA(nudgeDistinct(next))
          }}
        >
          {modelRows.map(model => <option key={model.model} value={model.model}>{model.model} · {model.calls.toLocaleString()} calls</option>)}
        </select>
      </div>
      {modelA && modelB && modelA !== modelB && (
        <CompareReport
          period={period}
          provider={provider}
          modelA={modelA}
          modelB={modelB}
          refreshToken={refreshToken}
          onError={resetToDefaults}
        />
      )}
    </>
  )
}

function CompareReport({
  period,
  provider,
  modelA,
  modelB,
  refreshToken,
  onError,
}: {
  period: Period
  provider: string
  modelA: string
  modelB: string
  refreshToken: number
  onError: () => void
}) {
  const report = usePolled<CompareJsonReport>(
    () => codeburn.getCompare(period, provider, modelA, modelB),
    [period, provider, modelA, modelB, refreshToken],
  )

  useEffect(() => {
    if (report.error) onError()
  }, [report.error, onError])

  if (!report.data) {
    if (report.error) return <CliErrorPanel error={report.error} subject="model comparisons" />
    return (
      <Panel title="Compare">
        <EmptyNote>Comparing models…</EmptyNote>
      </Panel>
    )
  }

  const performance = report.data.metrics.filter(metric => metric.section === 'Performance')
  const efficiency = report.data.metrics.filter(metric => metric.section === 'Efficiency')

  return (
    <div className="cmp-body">
      <div className="cmp-pair">
        <MetricCard title="Performance" rows={performance} modelA={report.data.modelA.model} modelB={report.data.modelB.model} showWinners />
        <MetricCard title="Efficiency" rows={efficiency} modelA={report.data.modelA.model} modelB={report.data.modelB.model} showWinners />
      </div>
      <CategoryCard report={report.data} />
      <div className="cmp-pair">
        <MetricCard title="Working style" rows={report.data.workingStyle} modelA={report.data.modelA.model} modelB={report.data.modelB.model} />
        <ContextCard modelA={report.data.modelA} modelB={report.data.modelB} />
      </div>
    </div>
  )
}

function MetricCard({
  title,
  rows,
  modelA,
  modelB,
  showWinners = false,
}: {
  title: string
  rows: Array<ComparisonRow | WorkingStyleRow>
  modelA: string
  modelB: string
  showWinners?: boolean
}) {
  return (
    <div className="panel cmp-card">
      <div className="cmp-head"><h3>{title}</h3></div>
      <div className="cmp-metrics">
        <MetricHeader modelA={modelA} modelB={modelB} />
        {rows.map(row => {
          const winner = 'winner' in row ? row.winner : 'none'
          return (
            <div className="cmp-metric" key={row.label}>
              <span className="cmp-label">{row.label}</span>
              <span className={`cmp-value${showWinners && winner === 'a' ? ' cmp-best' : ''}`}>{fmtMetric(row.valueA, row.formatFn)}</span>
              <span className={`cmp-value${showWinners && winner === 'b' ? ' cmp-best' : ''}`}>{fmtMetric(row.valueB, row.formatFn)}</span>
            </div>
          )
        })}
      </div>
      {showWinners && <div className="cmp-foot">Green = better on that metric.</div>}
    </div>
  )
}

function MetricHeader({ modelA, modelB }: { modelA: string; modelB: string }) {
  return <div className="cmp-metric-head"><span>Metric</span><span>{modelA}</span><span>{modelB}</span></div>
}

function CategoryCard({ report }: { report: CompareJsonReport }) {
  return (
    <div className="panel cmp-card">
      <div className="cmp-head"><h3>Category head-to-head</h3><span className="cmp-head-note">One-shot rate · edit turns</span></div>
      <div className="cmp-category-body">
        <div className="cmp-legend">
          <span className="cmp-legend-item"><span className="cmp-key" />{report.modelA.model}</span>
          <span className="cmp-legend-item"><span className="cmp-key cmp-key-b" />{report.modelB.model}</span>
        </div>
        <div className="cmp-categories">
          {report.categories.map(category => (
            <div className="cmp-category" key={category.category}>
              <span className="cmp-category-name">{category.category}</span>
              <div className="cmp-bars">
                <div className="cmp-bar-row">
                  <span className="cmp-track"><span className="cmp-bar" style={{ width: `${category.oneShotRateA ?? 0}%` }} /></span>
                  <span className={`cmp-bar-value${category.winner === 'a' ? ' cmp-best' : ''}`}>{fmtMetric(category.oneShotRateA, 'percent')} <span className="cmp-turns">({category.editTurnsA})</span></span>
                </div>
                <div className="cmp-bar-row">
                  <span className="cmp-track"><span className="cmp-bar cmp-bar-b" style={{ width: `${category.oneShotRateB ?? 0}%` }} /></span>
                  <span className={`cmp-bar-value${category.winner === 'b' ? ' cmp-best' : ''}`}>{fmtMetric(category.oneShotRateB, 'percent')} <span className="cmp-turns">({category.editTurnsB})</span></span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function cacheHitRate(model: ModelStats): string {
  const total = model.inputTokens + model.cacheReadTokens + model.cacheWriteTokens
  return total > 0 ? `${Math.round(model.cacheReadTokens / total * 100)}%` : '—'
}

function daysOfData(model: ModelStats): string {
  if (!model.firstSeen || !model.lastSeen) return '—'
  return String(Math.max(1, Math.round((new Date(model.lastSeen).getTime() - new Date(model.firstSeen).getTime()) / 86_400_000) + 1))
}

function ContextCard({ modelA, modelB }: { modelA: ModelStats; modelB: ModelStats }) {
  const rows = [
    ['Calls', modelA.calls.toLocaleString(), modelB.calls.toLocaleString()],
    ['Total cost', formatUsd(modelA.cost), formatUsd(modelB.cost)],
    ['Input tokens', formatCompact(modelA.inputTokens), formatCompact(modelB.inputTokens)],
    ['Output tokens', formatCompact(modelA.outputTokens), formatCompact(modelB.outputTokens)],
    ['Edit turns', modelA.editTurns.toLocaleString(), modelB.editTurns.toLocaleString()],
    ['Self-corrections', modelA.selfCorrections.toLocaleString(), modelB.selfCorrections.toLocaleString()],
    ['Cache hit rate', cacheHitRate(modelA), cacheHitRate(modelB)],
    ['Days of data', daysOfData(modelA), daysOfData(modelB)],
  ]
  return (
    <div className="panel cmp-card">
      <div className="cmp-head"><h3>Context</h3></div>
      <div className="cmp-metrics">
        <MetricHeader modelA={modelA.model} modelB={modelB.model} />
        {rows.map(([label, valueA, valueB]) => (
          <div className="cmp-metric" key={label}>
            <span className="cmp-label">{label}</span><span className="cmp-value">{valueA}</span><span className="cmp-value">{valueB}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
