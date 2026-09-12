import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { CliErrorPanel } from '../components/CliErrorPanel'
import { Dropdown } from '../components/Dropdown'
import { EmptyNote } from '../components/EmptyState'
import { Panel } from '../components/Panel'
import { SegTabs } from '../components/SegTabs'
import { SectionSkeleton } from '../components/Skeleton'
import { SwitchingBanner } from '../components/SwitchingBanner'
import { usePolled } from '../hooks/usePolled'
import {
  applyVolumeBand,
  computeBandCohortStats,
  type VolumeBand,
  type VolumeMeasure,
} from '../lib/cohortStats'
import { formatCompact, formatUsd, shortenProjectPath } from '../lib/format'
import { codeburn } from '../lib/ipc'
import { reportMemoKey } from '../lib/reportMemoKey'
import { openSample } from '../lib/sampleNavigation'
import { trackEvent } from '../lib/track'
import type {
  CohortComparisonReport,
  CohortModelReport,
  CohortObservation,
  CompareJsonReport,
  ComparisonRow,
  DateRange,
  ModelStats,
  Period,
  WorkingStyleRow,
} from '../lib/types'

function fmtMetric(v: number | null, fn: 'cost' | 'number' | 'percent' | 'decimal'): string {
  if (v === null) return '—'
  if (fn === 'cost') return formatUsd(v)
  if (fn === 'percent') return `${v.toFixed(0)}%`
  if (fn === 'decimal') return v.toFixed(2)
  return Math.round(v).toLocaleString('en-US')
}

// The CLI `compare` command has no --from/--to, so a custom range falls back to
// the selected period. Say so instead of silently ignoring the dates.
function RangeNote() {
  return (
    <p className="cmp-range-note" role="status">
      Compare uses the selected period, custom dates are not supported yet.
    </p>
  )
}

type CompareMode = 'classic' | 'cohorts'

export function Compare({
  period,
  provider,
  range = null,
  refreshToken = 0,
  ready = true,
}: {
  period: Period
  provider: string
  range?: DateRange | null
  refreshToken?: number
  ready?: boolean
}) {
  const [mode, setMode] = useState<CompareMode>('classic')

  if (mode === 'cohorts') {
    return (
      <div className="cmp-body">
        <div className="cmp-picker" aria-label="Compare mode">
          <SegTabs
            options={[
              { value: 'classic', label: 'Classic' },
              { value: 'cohorts', label: 'Cohorts' },
            ]}
            value={mode}
            onChange={next => setMode(next as CompareMode)}
          />
        </div>
        <CohortCompare period={period} provider={provider} range={range} refreshToken={refreshToken} ready={ready} />
      </div>
    )
  }

  return (
    <div className="cmp-body">
      <div className="cmp-picker" aria-label="Compare mode">
        <SegTabs
          options={[
            { value: 'classic', label: 'Classic' },
            { value: 'cohorts', label: 'Cohorts' },
          ]}
          value={mode}
          onChange={next => setMode(next as CompareMode)}
        />
      </div>
      <ClassicCompare period={period} provider={provider} range={range} refreshToken={refreshToken} ready={ready} />
    </div>
  )
}

function ClassicCompare({
  period,
  provider,
  range,
  refreshToken,
  ready,
}: {
  period: Period
  provider: string
  range: DateRange | null
  refreshToken: number
  ready: boolean
}) {
  const models = usePolled<ModelStats[]>(
    () => codeburn.getCompareModels(period, provider),
    [period, provider, refreshToken],
    { enabled: ready, memoKey: reportMemoKey('comparemodels', period, provider) },
  )
  const [modelA, setModelA] = useState<string | null>(null)
  const [modelB, setModelB] = useState<string | null>(null)

  useEffect(() => {
    if (!models.data) return
    const available = new Set(models.data.map(model => model.model))
    setModelA(current => current && available.has(current) ? current : models.data?.[0]?.model ?? null)
    setModelB(current => current && available.has(current) ? current : models.data?.[1]?.model ?? null)
  }, [models.data])

  // One event per distinct pair actually put on screen, not per keystroke in
  // the pickers. Model names only.
  const comparedPair = useRef<string | null>(null)
  useEffect(() => {
    if (!modelA || !modelB || modelA === modelB) return
    const pair = `${modelA} ${modelB}`
    if (comparedPair.current === pair) return
    comparedPair.current = pair
    trackEvent('compare_view', { modelA, modelB })
  }, [modelA, modelB])

  const resetToDefaults = useCallback(() => {
    if (!models.data) return
    setModelA(models.data[0]?.model ?? null)
    setModelB(models.data[1]?.model ?? null)
  }, [models.data])

  if (!models.data) {
    if (models.error) return <CliErrorPanel error={models.error} subject="model comparisons" />
    return <SectionSkeleton label="Scanning model usage…" rows={4} />
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
      {models.switching && <SwitchingBanner />}
      {range && <RangeNote />}
      <div className="cmp-picker" aria-label="Models being compared">
        <Dropdown
          id="compare-first-model"
          ariaLabel="First model"
          value={modelA ?? ''}
          options={modelRows.map(model => ({ value: model.model, label: `${model.model} · ${model.calls.toLocaleString()} calls` }))}
          onChange={next => {
            setModelA(next)
            if (next === modelB) setModelB(nudgeDistinct(next))
          }}
        />
        <span className="cmp-vs">vs</span>
        <Dropdown
          id="compare-second-model"
          ariaLabel="Second model"
          value={modelB ?? ''}
          options={modelRows.map(model => ({ value: model.model, label: `${model.model} · ${model.calls.toLocaleString()} calls` }))}
          onChange={next => {
            setModelB(next)
            if (next === modelA) setModelA(nudgeDistinct(next))
          }}
        />
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
    { memoKey: reportMemoKey('compare', period, provider, null, `${modelA}|${modelB}`) },
  )

  useEffect(() => {
    if (report.error) onError()
  }, [report.error, onError])

  if (!report.data) {
    if (report.error) return <CliErrorPanel error={report.error} subject="model comparisons" />
    return <SectionSkeleton label="Comparing models…" rows={4} />
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
  // reads over reads + fresh input (matches menubar-json + compare-stats).
  const total = model.inputTokens + model.cacheReadTokens
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

// ————— Cohorts mode: model comparison over an explicit, inspectable population —————

const SAMPLES_INITIAL_COUNT = 20

type BandMeasureLabel = { value: VolumeMeasure; label: string }

const BAND_MEASURES: BandMeasureLabel[] = [
  { value: 'output', label: 'Output tokens' },
  { value: 'input', label: 'Input tokens' },
  { value: 'contextProxy', label: 'Context proxy (input + cache read)' },
]

function CohortCompare({
  period,
  provider,
  range,
  refreshToken,
  ready,
}: {
  period: Period
  provider: string
  range: DateRange | null
  refreshToken: number
  ready: boolean
}) {
  const facets = usePolled(
    () => codeburn.getCompareCohortModels(period, provider, range ?? undefined),
    [period, provider, range?.from, range?.to, refreshToken],
    { enabled: ready, memoKey: reportMemoKey('cohortmodels', period, provider, range) },
  )

  const [modelA, setModelA] = useState<string | null>(null)
  const [modelB, setModelB] = useState<string | null>(null)
  const [project, setProject] = useState<string>('')
  const [category, setCategory] = useState<string>('')

  useEffect(() => {
    if (!facets.data) return
    const available = new Set(facets.data.models.map(model => model.model))
    setModelA(current => current && available.has(current) ? current : facets.data?.models[0]?.model ?? null)
    setModelB(current => current && available.has(current) ? current : facets.data?.models[1]?.model ?? null)
    // A project/category that vanished from the population must not keep
    // filtering silently: fall back to "all".
    setProject(current => {
      if (!current) return ''
      return facets.data?.projects.some(p => p.project === current) ? current : ''
    })
  }, [facets.data])

  const report = usePolled<CohortComparisonReport>(
    () => codeburn.getCompareCohort(period, provider, modelA ?? '', modelB ?? '', range ?? undefined, project ? [project] : undefined, category || undefined),
    [period, provider, modelA, modelB, range?.from, range?.to, project, category, refreshToken],
    {
      enabled: ready && !!modelA && !!modelB && modelA !== modelB,
      memoKey: reportMemoKey('cohort', period, provider, range, `${modelA}|${modelB}|${project}|${category}`),
    },
  )

  if (!facets.data) {
    if (facets.error) return <CliErrorPanel error={facets.error} subject="model comparisons" />
    return <SectionSkeleton label="Scanning model usage…" rows={4} />
  }

  if (facets.data.models.length < 2) {
    return (
      <Panel title="Cohorts">
        <EmptyNote>Need at least two models with usage in this range to compare.</EmptyNote>
      </Panel>
    )
  }

  const modelRows = facets.data.models
  const nudgeDistinct = (chosen: string) => modelRows.find(model => model.model !== chosen)?.model ?? null
  const intervalLabel = range ? `${range.from} → ${range.to}` : (report.data?.period.label ?? period)

  return (
    <>
      {facets.switching && <SwitchingBanner />}
      <div className="cmp-picker" aria-label="Cohort selection">
        <Dropdown
          id="cohort-first-model"
          ariaLabel="Cohort first model"
          value={modelA ?? ''}
          options={modelRows.map(model => ({ value: model.model, label: `${model.model} · ${model.calls.toLocaleString()} calls` }))}
          onChange={next => {
            setModelA(next)
            if (next === modelB) setModelB(nudgeDistinct(next))
          }}
        />
        <span className="cmp-vs">vs</span>
        <Dropdown
          id="cohort-second-model"
          ariaLabel="Cohort second model"
          value={modelB ?? ''}
          options={modelRows.map(model => ({ value: model.model, label: `${model.model} · ${model.calls.toLocaleString()} calls` }))}
          onChange={next => {
            setModelB(next)
            if (next === modelA) setModelA(nudgeDistinct(next))
          }}
        />
        <Dropdown
          id="cohort-project"
          ariaLabel="Cohort project"
          value={project}
          options={[{ value: '', label: 'All projects' }, ...facets.data.projects.map(p => ({ value: p.project, label: shortenProjectPath(p.project) }))]}
          onChange={setProject}
        />
        <Dropdown
          id="cohort-category"
          ariaLabel="Cohort activity category"
          value={category}
          options={[{ value: '', label: 'All categories' }, ...facets.data.categories.map(c => ({ value: c.id, label: c.label }))]}
          onChange={setCategory}
        />
      </div>
      <p className="cmp-range-note" role="status">
        Cohort interval: {intervalLabel}. One observation = one edit turn driven by exactly one
        behavioral model; turns mixing models are excluded and counted below.
      </p>
      {modelA && modelB && modelA !== modelB && (
        <CohortReport report={report} />
      )}
    </>
  )
}

function CohortReport({ report }: { report: ReturnType<typeof usePolled<CohortComparisonReport>> }) {
  const [band, setBand] = useState<VolumeBand | null>(null)

  if (!report.data) {
    if (report.error) return <CliErrorPanel error={report.error} subject="model comparisons" />
    return <SectionSkeleton label="Comparing cohorts…" rows={4} />
  }

  const data = report.data
  // Volume bands recompute from the report's own declared population — instant,
  // deterministic, and reproducible from the sample lists.
  const sideA = cohortSide(data.modelA, band)
  const sideB = cohortSide(data.modelB, band)

  return (
    <div className="cmp-body">
      <PopulationCard data={data} sideA={sideA} sideB={sideB} band={band} onBandChange={setBand} />
      <div className="cmp-pair">
        <CohortModelCard side={sideA} />
        <CohortModelCard side={sideB} />
      </div>
      <div className="cmp-pair">
        <VolumeCard title="Token volume (median · P90)" side={sideA} />
        <VolumeCard title="Token volume (median · P90)" side={sideB} />
      </div>
      <div className="cmp-pair">
        <SampleInspector side={sideA} />
        <SampleInspector side={sideB} />
      </div>
    </div>
  )
}

function cohortSide(model: CohortModelReport, band: VolumeBand | null) {
  const filtered = applyVolumeBand(model.observations, band)
  const stats = band ? computeBandCohortStats(model.model, filtered.kept) : model.stats
  return {
    model,
    band,
    kept: filtered.kept,
    excludedOutsideBand: filtered.outsideBand,
    excludedMissingMeasure: filtered.missingMeasure,
    stats,
  }
}

type CohortSide = ReturnType<typeof cohortSide>

function PopulationCard({ data, sideA, sideB, band, onBandChange }: {
  data: CohortComparisonReport
  sideA: CohortSide
  sideB: CohortSide
  band: VolumeBand | null
  onBandChange: (band: VolumeBand | null) => void
}) {
  const bandExcludedTotal = sideA.excludedOutsideBand + sideB.excludedOutsideBand
  const missingMeasureTotal = sideA.excludedMissingMeasure + sideB.excludedMissingMeasure
  return (
    <div className="panel cmp-card">
      <div className="cmp-head">
        <h3>Population</h3>
        <span className="cmp-head-note">Who is being compared, before any metric</span>
      </div>
      <div className="cmp-metrics">
        <div className="cmp-metric-head"><span>Selection</span><span>{data.modelA.label}</span><span>{data.modelB.label}</span></div>
        <div className="cmp-metric">
          <span className="cmp-label">Observations (edit turns, one model)</span>
          <span className="cmp-value">{sideA.stats.observationCount.toLocaleString()}</span>
          <span className="cmp-value">{sideB.stats.observationCount.toLocaleString()}</span>
        </div>
        <div className="cmp-metric">
          <span className="cmp-label">Distinct sessions they come from</span>
          <span className="cmp-value">{sideA.stats.distinctSessionCount.toLocaleString()}</span>
          <span className="cmp-value">{sideB.stats.distinctSessionCount.toLocaleString()}</span>
        </div>
        <div className="cmp-metric">
          <span className="cmp-label" title="Edit turns whose behavioral calls span 2+ models: attributed to nobody, cost shown so you can see what stays out">Excluded turns mixing models</span>
          <span className="cmp-value">{data.modelA.exclusions.multiModelTurnCount.toLocaleString()} ({formatUsd(data.modelA.exclusions.combinedMultiModelCostUSD)})</span>
          <span className="cmp-value">{data.modelB.exclusions.multiModelTurnCount.toLocaleString()} ({formatUsd(data.modelB.exclusions.combinedMultiModelCostUSD)})</span>
        </div>
        <div className="cmp-metric">
          <span className="cmp-label" title="Edit turns with no behavioral model call — no model can own them">Excluded turns without a model</span>
          <span className="cmp-value">{data.modelA.exclusions.noBehavioralModelTurns.toLocaleString()}</span>
          <span className="cmp-value">{data.modelB.exclusions.noBehavioralModelTurns.toLocaleString()}</span>
        </div>
        <div className="cmp-metric">
          <span className="cmp-label" title="Observations priced at $0 on a model without a free-rate rule: unknown cost, kept for retry stats, kept out of cost stats">Unknown cost (not zero)</span>
          <span className="cmp-value">{sideA.stats.unknownCostCount.toLocaleString()}</span>
          <span className="cmp-value">{sideB.stats.unknownCostCount.toLocaleString()}</span>
        </div>
        <div className="cmp-metric">
          <span className="cmp-label">Projects / category in selection</span>
          <span className="cmp-value cmp-value-wide">{describeSelection(data)}</span>
        </div>
      </div>
      <VolumeBandFilter band={band} onChange={onBandChange} />
      {(bandExcludedTotal > 0 || missingMeasureTotal > 0) && (
        <div className="cmp-foot" role="status">
          Volume band excludes {bandExcludedTotal.toLocaleString()} observation(s) outside the band
          {missingMeasureTotal > 0 ? ` and ${missingMeasureTotal.toLocaleString()} without any token measure (never counted as small)` : ''}.
          Rates below use the remaining declared population.
        </div>
      )}
      <div className="cmp-foot">
        Context proxy = input + cache-read tokens (a proxy, not a measured context window).
        Percentiles use linear interpolation at position (N-1)·p. Outliers are never removed;
        no winner is picked — this is a descriptive comparison.
      </div>
    </div>
  )
}

function describeSelection(data: CohortComparisonReport): string {
  const projects = data.selection.projects
  const projectLabel = projects.length === 0
    ? 'all'
    : projects.length <= 2 ? projects.join(', ') : `${projects.length} projects`
  const category = data.selection.category ?? 'all categories'
  const interval = data.selection.from && data.selection.to ? `${data.selection.from} → ${data.selection.to}` : data.period.label
  return `${projectLabel} · ${category} · ${interval}`
}

function VolumeBandFilter({ band, onChange }: { band: VolumeBand | null; onChange: (band: VolumeBand | null) => void }) {
  const measure = band?.measure ?? 'output'
  const min = band?.min?.toString() ?? ''
  const max = band?.max?.toString() ?? ''

  const push = (next: { measure?: VolumeMeasure; min?: string; max?: string }) => {
    const nextMeasure = next.measure ?? measure
    const minRaw = next.min ?? min
    const maxRaw = next.max ?? max
    const minNum = minRaw.trim() === '' ? null : Number(minRaw)
    const maxNum = maxRaw.trim() === '' ? null : Number(maxRaw)
    const validMin = minNum != null && Number.isFinite(minNum) ? minNum : null
    const validMax = maxNum != null && Number.isFinite(maxNum) ? maxNum : null
    if (validMin == null && validMax == null) {
      onChange(null)
      return
    }
    onChange({ measure: nextMeasure, min: validMin, max: validMax })
  }

  return (
    <div className="cmp-band" role="group" aria-label="Volume band filter">
      <span className="cmp-band-label">Volume band</span>
      <Dropdown
        id="cohort-band-measure"
        ariaLabel="Volume band measure"
        value={measure}
        options={BAND_MEASURES.map(m => ({ value: m.value, label: m.label }))}
        onChange={next => push({ measure: next as VolumeMeasure })}
      />
      <input
        className="cmp-band-input"
        aria-label="Volume band minimum"
        type="number"
        min={0}
        placeholder="min"
        value={min}
        onChange={event => push({ min: event.target.value })}
      />
      <span className="cmp-band-sep">–</span>
      <input
        className="cmp-band-input"
        aria-label="Volume band maximum"
        type="number"
        min={0}
        placeholder="max"
        value={max}
        onChange={event => push({ max: event.target.value })}
      />
      {band && (
        <button type="button" className="cmp-band-clear" onClick={() => onChange(null)}>Clear band</button>
      )}
    </div>
  )
}

function CohortModelCard({ side }: { side: CohortSide }) {
  const stats = side.stats
  const histogram = stats.costHistogram
  const maxCount = Math.max(1, ...histogram.counts)
  return (
    <div className="panel cmp-card">
      <div className="cmp-head"><h3>Cost per edit turn</h3><span className="cmp-head-note">{side.model.label}</span></div>
      <div className="cmp-metrics">
        <div className="cmp-metric"><span className="cmp-label">Median cost</span><span className="cmp-value">{fmtCost(stats.costMedian)}</span></div>
        <div className="cmp-metric"><span className="cmp-label">P90 cost</span><span className="cmp-value">{fmtCost(stats.costP90)}</span></div>
        <div className="cmp-metric"><span className="cmp-label">Mean cost</span><span className="cmp-value">{fmtCost(stats.costMean)}</span></div>
        <div className="cmp-metric"><span className="cmp-label" title="One-shot = the edit turn produced no observed retry. Zero observed retries never proves code correctness.">One-shot rate</span><span className="cmp-value">{fmtMetric(stats.oneShotRate, 'percent')} <span className="cmp-turns">({stats.oneShotCount}/{stats.observationCount})</span></span></div>
        <div className="cmp-metric"><span className="cmp-label" title="Observed retries per edit turn. Absence of observed retries does not prove correctness.">Retry rate</span><span className="cmp-value">{fmtMetric(stats.retryRate, 'decimal')} <span className="cmp-turns">({stats.retryCount})</span></span></div>
        <div className="cmp-metric"><span className="cmp-label">Cost known for</span><span className="cmp-value">{stats.costKnownCount}/{stats.observationCount} observations</span></div>
      </div>
      <div className="cmp-histogram" role="img" aria-label={`Cost distribution for ${side.model.label}`}>
        {histogram.edges.length === 0 && histogram.counts.length === 1 ? (
          <div className="cmp-hist-note">All known costs ≈ $0 (free models).</div>
        ) : (
          histogram.counts.map((count, index) => (
            <div className="cmp-hist-row" key={index}>
              <span className="cmp-hist-label">{bucketLabel(histogram.edges, index)}</span>
              <span className="cmp-track"><span className="cmp-bar" style={{ width: `${(count / maxCount) * 100}%` }} /></span>
              <span className="cmp-hist-count">{count.toLocaleString()}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function fmtCost(value: number | null): string {
  return value === null ? '—' : formatUsd(value)
}

function bucketLabel(edges: number[], index: number): string {
  if (edges.length === 0) return '$0'
  if (index === 0) return `< ${formatUsd(edges[0] as number)}`
  if (index === edges.length) return `≥ ${formatUsd(edges[edges.length - 1] as number)}`
  return `${formatUsd(edges[index - 1] as number)}–${formatUsd(edges[index] as number)}`
}

function VolumeCard({ title, side }: { title: string; side: CohortSide }) {
  const volume = side.stats.volume
  const rows = [
    ['Output tokens', fmtVolume(volume.outputMedian), fmtVolume(volume.outputP90)],
    ['Input tokens', fmtVolume(volume.inputMedian), fmtVolume(volume.inputP90)],
    ['Context proxy (in + cache read)', fmtVolume(volume.contextProxyMedian), fmtVolume(volume.contextProxyP90)],
  ]
  return (
    <div className="panel cmp-card">
      <div className="cmp-head"><h3>{title}</h3><span className="cmp-head-note">{side.model.label}</span></div>
      <div className="cmp-metrics">
        <div className="cmp-metric-head"><span>Volume</span><span>Median</span><span>P90</span></div>
        {rows.map(([label, median, p90]) => (
          <div className="cmp-metric" key={label}>
            <span className="cmp-label" title={label.startsWith('Context') ? 'input + cache-read tokens: a proxy for context size, not a measured context window' : undefined}>{label}</span>
            <span className="cmp-value">{median}</span>
            <span className="cmp-value">{p90}</span>
          </div>
        ))}
        <div className="cmp-metric">
          <span className="cmp-label">Observations without token data</span>
          <span className="cmp-value" >{volume.missingMeasureCount.toLocaleString()}</span>
          <span className="cmp-value" />
        </div>
      </div>
    </div>
  )
}

function fmtVolume(value: number | null): string {
  return value === null ? '—' : formatCompact(value)
}

/** Inspect samples: the declared population, inspectable row by row. Renders
 *  inline (self-contained); activating a row also hands it to the shared
 *  navigation adapter when one is registered (sampleNavigation.ts contract). */
function SampleInspector({ side }: { side: CohortSide }) {
  const [showAll, setShowAll] = useState(false)
  const observations = useMemo(
    () => [...side.kept].sort((a, b) => b.costUSD - a.costUSD || a.timestamp.localeCompare(b.timestamp)),
    [side.kept],
  )
  const visible = showAll ? observations : observations.slice(0, SAMPLES_INITIAL_COUNT)

  return (
    <div className="panel cmp-card">
      <div className="cmp-head">
        <h3>Inspect samples</h3>
        <span className="cmp-head-note">{side.model.label} · {side.stats.observationCount.toLocaleString()} of {side.model.stats.observationCount.toLocaleString()} in selection</span>
      </div>
      {observations.length === 0 ? (
        <div className="cmp-category-body">
          <EmptyNote>No observations match the current selection{side.band ? ' and volume band' : ''}. Nothing is compared.</EmptyNote>
        </div>
      ) : (
        <div className="cmp-samples">
          {visible.map((observation, index) => (
            <SampleRow key={`${observation.sessionId}-${observation.timestamp}-${index}`} observation={observation} />
          ))}
          {observations.length > SAMPLES_INITIAL_COUNT && (
            <button type="button" className="cmp-samples-more" onClick={() => setShowAll(current => !current)}>
              {showAll ? 'Show fewer' : `Show all ${observations.length.toLocaleString()} observations`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function SampleRow({ observation }: { observation: CohortObservation }) {
  const activate = () => {
    openSample({ sessionId: observation.sessionId, project: observation.project, timestamp: observation.timestamp })
  }
  return (
    <button type="button" className="cmp-sample" onClick={activate}
      title={`Open sample in navigation: ${observation.project}/${observation.sessionId}`}
      aria-label={`Sample from ${shortenProjectPath(observation.project)} at ${observation.timestamp}`}>
      <span className="cmp-sample-time">{observation.timestamp.slice(0, 16).replace('T', ' ')}</span>
      <span className="cmp-sample-project" title={observation.project}>{shortenProjectPath(observation.project)}</span>
      <span className="cmp-sample-session" title={observation.sessionId}>{observation.sessionId.slice(0, 10)}</span>
      <span className="cmp-sample-cat">{observation.category}</span>
      <span className="cmp-sample-cost" title={observation.costKnown ? undefined : 'Unknown cost: this model has no pricing and no free-rate rule — not counted as $0'}>
        {observation.costKnown ? formatUsd(observation.costUSD) : 'unknown'}
      </span>
      <span className="cmp-sample-tokens" title="input / output / context proxy tokens">
        {observation.tokensReported ? `${formatCompact(observation.inputTokens)} / ${formatCompact(observation.outputTokens)} / ${formatCompact(observation.contextProxyTokens)}` : 'no token data'}
      </span>
      <span className="cmp-sample-retries">{observation.oneShot ? 'one-shot' : `${observation.retries} retry`}</span>
    </button>
  )
}
