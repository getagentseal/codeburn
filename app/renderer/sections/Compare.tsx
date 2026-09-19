import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { CliErrorPanel } from '../components/CliErrorPanel'
import { Dropdown } from '../components/Dropdown'
import { EmptyNote } from '../components/EmptyState'
import { Panel } from '../components/Panel'
import { SegTabs } from '../components/SegTabs'
import { SectionSkeleton } from '../components/Skeleton'
import { usePolled } from '../hooks/usePolled'
import {
  applyVolumeBand,
  computeBandCohortStats,
  type VolumeBand,
  type VolumeMeasure,
} from '../lib/cohortStats'
import { formatCompact, formatCount, formatUsd, shortenProjectPath } from '../lib/format'
import { Usd, tokensOf } from '../components/Usd'
import { t } from '../i18n'
import { codeburn } from '../lib/ipc'
import { reportMemoKey } from '../lib/reportMemoKey'
import { sessionFilters } from '../lib/investigation'
import { trackEvent } from '../lib/track'
import type { InvestigateRequest } from './Overview'
import { sessionRowKey } from './Sessions'
import type {
  CategoryComparison,
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
      {t('compare.classic.rangeNote')}
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
  onInvestigate,
}: {
  period: Period
  provider: string
  range?: DateRange | null
  refreshToken?: number
  ready?: boolean
  onInvestigate?: (request: InvestigateRequest) => void
}) {
  const [mode, setMode] = useState<CompareMode>('classic')

  if (mode === 'cohorts') {
    return (
      <div className="cmp-body">
        <div className="cmp-picker" aria-label={t('compare.mode.ariaLabel')}>
          <SegTabs
            options={[
              { value: 'classic', label: t('compare.mode.classic') },
              { value: 'cohorts', label: t('compare.mode.cohorts') },
            ]}
            value={mode}
            onChange={next => setMode(next as CompareMode)}
          />
        </div>
        <CohortCompare period={period} provider={provider} range={range} refreshToken={refreshToken} ready={ready} onInvestigate={onInvestigate} />
      </div>
    )
  }

  return (
    <div className="cmp-body">
      <div className="cmp-picker" aria-label={t('compare.mode.ariaLabel')}>
        <SegTabs
          options={[
            { value: 'classic', label: t('compare.mode.classic') },
            { value: 'cohorts', label: t('compare.mode.cohorts') },
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
    if (models.error) return <CliErrorPanel error={models.error} subject={t('compare.subject.modelComparisons')} />
    return <SectionSkeleton label={t('compare.classic.scanning')} rows={4} />
  }

  if (models.data.length < 2) {
    return (
      <Panel title={t('compare.classic.panelTitle')}>
        <EmptyNote>{t('compare.classic.needTwoModels')}</EmptyNote>
      </Panel>
    )
  }

  const modelRows = models.data
  const nudgeDistinct = (chosen: string) => modelRows.find(model => model.model !== chosen)?.model ?? null

  return (
    <>
      {range && <RangeNote />}
      <div className="cmp-picker" aria-label={t('compare.classic.modelsAriaLabel')}>
        <Dropdown
          id="compare-first-model"
          ariaLabel={t('compare.classic.firstModel')}
          value={modelA ?? ''}
          options={modelRows.map(model => ({ value: model.model, label: `${model.model} · ${formatCount(model.calls, 'call')}` }))}
          onChange={next => {
            setModelA(next)
            if (next === modelB) setModelB(nudgeDistinct(next))
          }}
        />
        <span className="cmp-vs">{t('compare.vs')}</span>
        <Dropdown
          id="compare-second-model"
          ariaLabel={t('compare.classic.secondModel')}
          value={modelB ?? ''}
          options={modelRows.map(model => ({ value: model.model, label: `${model.model} · ${formatCount(model.calls, 'call')}` }))}
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
    if (report.error) return <CliErrorPanel error={report.error} subject={t('compare.subject.modelComparisons')} />
    return <SectionSkeleton label={t('compare.classic.comparingModels')} rows={4} />
  }

  const performance = report.data.metrics.filter(metric => metric.section === 'Performance')
  const efficiency = report.data.metrics.filter(metric => metric.section === 'Efficiency')

  return (
    <div className="cmp-body">
      <div className="cmp-pair">
        <MetricCard title={t('compare.classic.performance')} rows={performance} modelA={report.data.modelA.model} modelB={report.data.modelB.model} showWinners />
        <MetricCard title={t('compare.classic.efficiency')} rows={efficiency} modelA={report.data.modelA.model} modelB={report.data.modelB.model} showWinners />
      </div>
      <CategoryCard report={report.data} />
      <div className="cmp-pair">
        <MetricCard title={t('compare.classic.workingStyle')} rows={report.data.workingStyle} modelA={report.data.modelA.model} modelB={report.data.modelB.model} />
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
      <div className="pbody">
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
      {showWinners && <div className="cmp-foot">{t('compare.classic.greenBetter')}</div>}
      </div>
    </div>
  )
}

function MetricHeader({ modelA, modelB }: { modelA: string; modelB: string }) {
  return <div className="cmp-metric-head"><span>{t('compare.classic.metricHeader')}</span><span>{modelA}</span><span>{modelB}</span></div>
}

/** A category is a head-to-head only when both models worked in it and both
 *  produced a rate. Anything less draws a bar against an empty track under a
 *  legend — a chart that shows no comparison. */
function isComparable(category: CategoryComparison): boolean {
  return category.turnsA > 0 && category.turnsB > 0
    && category.oneShotRateA !== null && category.oneShotRateB !== null
}

function CategoryCard({ report }: { report: CompareJsonReport }) {
  const comparable = report.categories.some(isComparable)
  return (
    <div className="panel cmp-card">
      <div className="cmp-head"><h3>{t('compare.classic.categoryHeadToHead')}</h3><span className="cmp-head-note">{t('compare.classic.oneShotRateEditTurns')}</span></div>
      <div className="pbody">
      <div className="cmp-category-body">
        {!comparable ? <EmptyNote>{t('compare.classic.noCategoriesToCompare')}</EmptyNote> : <>
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
        </>}
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
  const rows: Array<[string, ReactNode, ReactNode]> = [
    [t('compare.classic.context.calls'), modelA.calls.toLocaleString(), modelB.calls.toLocaleString()],
    [t('compare.classic.context.totalCost'), <Usd value={modelA.cost} tokens={tokensOf(modelA)} />, <Usd value={modelB.cost} tokens={tokensOf(modelB)} />],
    [t('compare.classic.context.inputTokens'), formatCompact(modelA.inputTokens), formatCompact(modelB.inputTokens)],
    [t('compare.classic.context.outputTokens'), formatCompact(modelA.outputTokens), formatCompact(modelB.outputTokens)],
    [t('compare.classic.context.editTurns'), modelA.editTurns.toLocaleString(), modelB.editTurns.toLocaleString()],
    [t('compare.classic.context.selfCorrections'), modelA.selfCorrections.toLocaleString(), modelB.selfCorrections.toLocaleString()],
    [t('compare.classic.context.cacheHitRate'), cacheHitRate(modelA), cacheHitRate(modelB)],
    [t('compare.classic.context.daysOfData'), daysOfData(modelA), daysOfData(modelB)],
  ]
  return (
    <div className="panel cmp-card">
      <div className="cmp-head"><h3>{t('compare.classic.context')}</h3></div>
      <div className="pbody">
      <div className="cmp-metrics">
        <MetricHeader modelA={modelA.model} modelB={modelB.model} />
        {rows.map(([label, valueA, valueB]) => (
          <div className="cmp-metric" key={label}>
            <span className="cmp-label">{label}</span><span className="cmp-value">{valueA}</span><span className="cmp-value">{valueB}</span>
          </div>
        ))}
      </div>
      </div>
    </div>
  )
}

// ————— Cohorts mode: model comparison over an explicit, inspectable population —————

const SAMPLES_INITIAL_COUNT = 20

type BandMeasureLabel = { value: VolumeMeasure; labelKey: string }

// Translated at render time (VolumeBandFilter), never at module scope, so a
// language switch picks it up like everything else.
const BAND_MEASURES: BandMeasureLabel[] = [
  { value: 'output', labelKey: 'compare.cohort.band.outputTokens' },
  { value: 'input', labelKey: 'compare.cohort.band.inputTokens' },
  { value: 'contextProxy', labelKey: 'compare.cohort.band.contextProxy' },
]

function CohortCompare({
  period,
  provider,
  range,
  refreshToken,
  ready,
  onInvestigate,
}: {
  period: Period
  provider: string
  range: DateRange | null
  refreshToken: number
  ready: boolean
  onInvestigate?: (request: InvestigateRequest) => void
}) {
  const facets = usePolled(
    () => codeburn.getCompareCohortModels(period, provider, range ?? undefined),
    [period, provider, range?.from, range?.to, refreshToken],
    { enabled: ready, memoKey: reportMemoKey('cohortmodels-v2', period, provider, range) },
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
      return facets.data?.projects.some(p => p.id === current) ? current : ''
    })
  }, [facets.data])

  const report = usePolled<CohortComparisonReport>(
    () => codeburn.getCompareCohort(period, provider, modelA ?? '', modelB ?? '', range ?? undefined, project ? [project] : undefined, category || undefined),
    [period, provider, modelA, modelB, range?.from, range?.to, project, category, refreshToken],
    {
      enabled: ready && !!modelA && !!modelB && modelA !== modelB,
      memoKey: reportMemoKey('cohort-v2', period, provider, range, JSON.stringify([modelA, modelB, project, category])),
    },
  )

  if (!facets.data) {
    if (facets.error) return <CliErrorPanel error={facets.error} subject={t('compare.subject.modelComparisons')} />
    return <SectionSkeleton label={t('compare.classic.scanning')} rows={4} />
  }

  if (facets.data.models.length < 2) {
    return (
      <Panel title={t('compare.cohort.panelTitle')}>
        <EmptyNote>{t('compare.classic.needTwoModels')}</EmptyNote>
      </Panel>
    )
  }

  const modelRows = facets.data.models
  const nudgeDistinct = (chosen: string) => modelRows.find(model => model.model !== chosen)?.model ?? null
  const intervalLabel = range ? `${range.from} → ${range.to}` : (report.data?.period.label ?? period)

  return (
    <>
      <div className="cmp-picker" aria-label={t('compare.cohort.selectionAriaLabel')}>
        <Dropdown
          id="cohort-first-model"
          ariaLabel={t('compare.cohort.firstModel')}
          value={modelA ?? ''}
          options={modelRows.map(model => ({ value: model.model, label: `${model.model} · ${formatCount(model.calls, 'call')}` }))}
          onChange={next => {
            setModelA(next)
            if (next === modelB) setModelB(nudgeDistinct(next))
          }}
        />
        <span className="cmp-vs">{t('compare.vs')}</span>
        <Dropdown
          id="cohort-second-model"
          ariaLabel={t('compare.cohort.secondModel')}
          value={modelB ?? ''}
          options={modelRows.map(model => ({ value: model.model, label: `${model.model} · ${formatCount(model.calls, 'call')}` }))}
          onChange={next => {
            setModelB(next)
            if (next === modelA) setModelA(nudgeDistinct(next))
          }}
        />
        <Dropdown
          id="cohort-project"
          ariaLabel={t('compare.cohort.projectAriaLabel')}
          value={project}
          options={[{ value: '', label: t('compare.cohort.allProjects') }, ...facets.data.projects.map(p => ({ value: p.id, label: shortenProjectPath(p.id) }))]}
          onChange={setProject}
        />
        <Dropdown
          id="cohort-category"
          ariaLabel={t('compare.cohort.categoryAriaLabel')}
          value={category}
          options={[{ value: '', label: t('compare.cohort.allCategories') }, ...facets.data.categories.map(c => ({ value: c.id, label: c.label }))]}
          onChange={setCategory}
        />
      </div>
      <p className="cmp-range-note" role="status">
        {t('compare.cohort.intervalNote', { interval: intervalLabel })}
      </p>
      {modelA && modelB && modelA !== modelB && (
        <CohortReport report={report} onInvestigate={onInvestigate} />
      )}
    </>
  )
}

function CohortReport({ report, onInvestigate }: {
  report: ReturnType<typeof usePolled<CohortComparisonReport>>
  onInvestigate?: (request: InvestigateRequest) => void
}) {
  const [band, setBand] = useState<VolumeBand | null>(null)

  if (!report.data) {
    if (report.error) return <CliErrorPanel error={report.error} subject={t('compare.subject.modelComparisons')} />
    return <SectionSkeleton label={t('compare.cohort.comparing')} rows={4} />
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
        <VolumeCard title={t('compare.cohort.volume.title')} side={sideA} />
        <VolumeCard title={t('compare.cohort.volume.title')} side={sideB} />
      </div>
      <div className="cmp-pair">
        <SampleInspector side={sideA} onInvestigate={onInvestigate} />
        <SampleInspector side={sideB} onInvestigate={onInvestigate} />
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
        <h3>{t('compare.cohort.population.title')}</h3>
        <span className="cmp-head-note">{t('compare.cohort.population.subtitle')}</span>
      </div>
      <div className="cmp-metrics">
        <div className="cmp-metric-head"><span>{t('compare.cohort.population.selectionHeader')}</span><span>{data.modelA.label}</span><span>{data.modelB.label}</span></div>
        <div className="cmp-metric">
          <span className="cmp-label">{t('compare.cohort.population.observations')}</span>
          <span className="cmp-value">{sideA.stats.observationCount.toLocaleString()}</span>
          <span className="cmp-value">{sideB.stats.observationCount.toLocaleString()}</span>
        </div>
        <div className="cmp-metric">
          <span className="cmp-label">{t('compare.cohort.population.distinctSessions')}</span>
          <span className="cmp-value">{sideA.stats.distinctSessionCount.toLocaleString()}</span>
          <span className="cmp-value">{sideB.stats.distinctSessionCount.toLocaleString()}</span>
        </div>
        <div className="cmp-metric">
          <span className="cmp-label" title={t('compare.cohort.population.excludedMixedTooltip')}>{t('compare.cohort.population.excludedMixedLabel')}</span>
          <span className="cmp-value">{data.modelA.exclusions.multiModelTurnCount.toLocaleString()} ({formatUsd(data.modelA.exclusions.combinedMultiModelCostUSD)})</span>
          <span className="cmp-value">{data.modelB.exclusions.multiModelTurnCount.toLocaleString()} ({formatUsd(data.modelB.exclusions.combinedMultiModelCostUSD)})</span>
        </div>
        <div className="cmp-metric">
          <span className="cmp-label" title={t('compare.cohort.population.excludedNoModelTooltip')}>{t('compare.cohort.population.excludedNoModelLabel')}</span>
          <span className="cmp-value">{data.modelA.exclusions.noBehavioralModelTurns.toLocaleString()}</span>
          <span className="cmp-value">{data.modelB.exclusions.noBehavioralModelTurns.toLocaleString()}</span>
        </div>
        <div className="cmp-metric">
          <span className="cmp-label" title={t('compare.cohort.population.unknownCostTooltip')}>{t('compare.cohort.population.unknownCostLabel')}</span>
          <span className="cmp-value">{sideA.stats.unknownCostCount.toLocaleString()}</span>
          <span className="cmp-value">{sideB.stats.unknownCostCount.toLocaleString()}</span>
        </div>
        <div className="cmp-metric">
          <span className="cmp-label">{t('compare.cohort.population.projectsCategoryLabel')}</span>
          <span className="cmp-value cmp-value-wide">{describeSelection(data)}</span>
        </div>
      </div>
      <VolumeBandFilter band={band} onChange={onBandChange} />
      {(bandExcludedTotal > 0 || missingMeasureTotal > 0) && (
        <div className="cmp-foot" role="status">
          {t('compare.cohort.population.bandExcluded', { count: bandExcludedTotal.toLocaleString() })}
          {missingMeasureTotal > 0 ? t('compare.cohort.population.bandExcludedMissing', { count: missingMeasureTotal.toLocaleString() }) : ''}.
          {' '}{t('compare.cohort.population.ratesNote')}
        </div>
      )}
      <div className="cmp-foot">
        {t('compare.cohort.population.conventionNote')}
      </div>
    </div>
  )
}

function describeSelection(data: CohortComparisonReport): string {
  const projects = data.selection.projects
  const projectLabel = projects.length === 0
    ? t('compare.cohort.selection.all')
    : projects.length <= 2 ? projects.join(', ') : t('compare.cohort.selection.projectsCount', { count: projects.length })
  const category = data.selection.category ?? t('compare.cohort.selection.allCategories')
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
    <div className="cmp-band" role="group" aria-label={t('compare.cohort.band.filterAriaLabel')}>
      <span className="cmp-band-label">{t('compare.cohort.band.label')}</span>
      <Dropdown
        id="cohort-band-measure"
        ariaLabel={t('compare.cohort.band.measureAriaLabel')}
        value={measure}
        options={BAND_MEASURES.map(m => ({ value: m.value, label: t(m.labelKey) }))}
        onChange={next => push({ measure: next as VolumeMeasure })}
      />
      <input
        className="cmp-band-input"
        aria-label={t('compare.cohort.band.minAriaLabel')}
        type="number"
        min={0}
        placeholder={t('compare.cohort.band.minPlaceholder')}
        value={min}
        onChange={event => push({ min: event.target.value })}
      />
      <span className="cmp-band-sep">–</span>
      <input
        className="cmp-band-input"
        aria-label={t('compare.cohort.band.maxAriaLabel')}
        type="number"
        min={0}
        placeholder={t('compare.cohort.band.maxPlaceholder')}
        value={max}
        onChange={event => push({ max: event.target.value })}
      />
      {band && (
        <button type="button" className="cmp-band-clear" onClick={() => onChange(null)}>{t('compare.cohort.band.clear')}</button>
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
      <div className="cmp-head"><h3>{t('compare.cohort.model.costPerEditTurn')}</h3><span className="cmp-head-note">{side.model.label}</span></div>
      <div className="cmp-metrics">
        <div className="cmp-metric"><span className="cmp-label">{t('compare.cohort.model.medianCost')}</span><span className="cmp-value">{fmtCost(stats.costMedian)}</span></div>
        <div className="cmp-metric"><span className="cmp-label">{t('compare.cohort.model.p90Cost')}</span><span className="cmp-value">{fmtCost(stats.costP90)}</span></div>
        <div className="cmp-metric"><span className="cmp-label">{t('compare.cohort.model.meanCost')}</span><span className="cmp-value">{fmtCost(stats.costMean)}</span></div>
        <div className="cmp-metric"><span className="cmp-label" title={t('compare.cohort.model.oneShotTooltip')}>{t('compare.cohort.model.oneShotRateLabel')}</span><span className="cmp-value">{fmtMetric(stats.oneShotRate, 'percent')} <span className="cmp-turns">({stats.oneShotCount}/{stats.observationCount})</span></span></div>
        <div className="cmp-metric"><span className="cmp-label" title={t('compare.cohort.model.retryTooltip')}>{t('compare.cohort.model.retryRateLabel')}</span><span className="cmp-value">{fmtMetric(stats.retryRate, 'decimal')} <span className="cmp-turns">({stats.retryCount})</span></span></div>
        <div className="cmp-metric"><span className="cmp-label">{t('compare.cohort.model.costKnownFor')}</span><span className="cmp-value">{t('compare.cohort.model.observationsOf', { known: stats.costKnownCount, total: stats.observationCount })}</span></div>
      </div>
      <div className="cmp-histogram" role="img" aria-label={t('compare.cohort.model.costDistributionAria', { label: side.model.label })}>
        {histogram.edges.length === 0 && histogram.counts.length === 1 ? (
          <div className="cmp-hist-note">{t('compare.cohort.model.allFreeCosts')}</div>
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
  // id drives the tooltip lookup so it survives translation; the row's own
  // English label can no longer be pattern-matched once it's localized.
  const rows: Array<{ id: 'output' | 'input' | 'context'; labelKey: string; median: string; p90: string }> = [
    { id: 'output', labelKey: 'compare.cohort.volume.outputTokensRow', median: fmtVolume(volume.outputMedian), p90: fmtVolume(volume.outputP90) },
    { id: 'input', labelKey: 'compare.cohort.volume.inputTokensRow', median: fmtVolume(volume.inputMedian), p90: fmtVolume(volume.inputP90) },
    { id: 'context', labelKey: 'compare.cohort.volume.contextProxyRow', median: fmtVolume(volume.contextProxyMedian), p90: fmtVolume(volume.contextProxyP90) },
  ]
  return (
    <div className="panel cmp-card">
      <div className="cmp-head"><h3>{title}</h3><span className="cmp-head-note">{side.model.label}</span></div>
      <div className="cmp-metrics">
        <div className="cmp-metric-head"><span>{t('compare.cohort.volume.columnHeader')}</span><span>{t('compare.cohort.volume.medianHeader')}</span><span>{t('compare.cohort.volume.p90Header')}</span></div>
        {rows.map(row => (
          <div className="cmp-metric" key={row.id}>
            <span className="cmp-label" title={row.id === 'context' ? t('compare.cohort.volume.contextProxyTooltip') : undefined}>{t(row.labelKey)}</span>
            <span className="cmp-value">{row.median}</span>
            <span className="cmp-value">{row.p90}</span>
          </div>
        ))}
        <div className="cmp-metric">
          <span className="cmp-label">{t('compare.cohort.volume.missingMeasureLabel')}</span>
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

/** Inspect samples: the declared population, inspectable row by row. Activating
 *  a row drills through to the owning session with the shared investigation
 *  navigation, keyed by the same provider/project/session triple Sessions uses. */
function SampleInspector({ side, onInvestigate }: {
  side: CohortSide
  onInvestigate?: (request: InvestigateRequest) => void
}) {
  const [showAll, setShowAll] = useState(false)
  const observations = useMemo(
    () => [...side.kept].sort((a, b) => b.costUSD - a.costUSD || a.timestamp.localeCompare(b.timestamp)),
    [side.kept],
  )
  const visible = showAll ? observations : observations.slice(0, SAMPLES_INITIAL_COUNT)

  return (
    <div className="panel cmp-card">
      <div className="cmp-head">
        <h3>{t('compare.cohort.samples.title')}</h3>
        <span className="cmp-head-note">{side.model.label} · {t('compare.cohort.samples.ofInSelection', { count: side.stats.observationCount.toLocaleString(), total: side.model.stats.observationCount.toLocaleString() })}</span>
      </div>
      {observations.length === 0 ? (
        <div className="cmp-category-body">
          <EmptyNote>{t('compare.cohort.samples.noObservations')}{side.band ? t('compare.cohort.samples.andVolumeBand') : ''}{t('compare.cohort.samples.nothingCompared')}</EmptyNote>
        </div>
      ) : (
        <div className="cmp-samples">
          {visible.map((observation, index) => (
            <SampleRow key={`${observation.sessionId}-${observation.timestamp}-${index}`} observation={observation} onInvestigate={onInvestigate} />
          ))}
          {observations.length > SAMPLES_INITIAL_COUNT && (
            <button type="button" className="cmp-samples-more" onClick={() => setShowAll(current => !current)}>
              {showAll ? t('compare.cohort.samples.showFewer') : t('compare.cohort.samples.showAll', { count: formatCount(observations.length, 'observation') })}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function SampleRow({ observation, onInvestigate }: {
  observation: CohortObservation
  onInvestigate?: (request: InvestigateRequest) => void
}) {
  const activate = () => {
    onInvestigate?.({
      filters: sessionFilters({ provider: observation.provider, sessionId: observation.sessionId }),
      sessionId: sessionRowKey(observation),
    })
  }
  return (
    <button type="button" className="cmp-sample" onClick={activate}
      title={t('compare.cohort.sample.openSession', { path: `${observation.project}/${observation.sessionId}` })}
      aria-label={t('compare.cohort.sample.ariaLabel', { project: shortenProjectPath(observation.project), timestamp: observation.timestamp })}>
      <span className="cmp-sample-time">{observation.timestamp.slice(0, 16).replace('T', ' ')}</span>
      <span className="cmp-sample-project" title={observation.project}>{shortenProjectPath(observation.project)}</span>
      <span className="cmp-sample-session" title={observation.sessionId}>{observation.sessionId.slice(0, 10)}</span>
      <span className="cmp-sample-cat">{observation.category}</span>
      <span className="cmp-sample-cost" title={observation.costKnown ? undefined : t('compare.cohort.sample.unknownCostTooltip')}>
        {observation.costKnown ? formatUsd(observation.costUSD) : t('compare.cohort.sample.unknownCost')}
      </span>
      <span className="cmp-sample-tokens" title={t('compare.cohort.sample.tokensTooltip')}>
        {observation.tokensReported ? `${formatCompact(observation.inputTokens)} / ${formatCompact(observation.outputTokens)} / ${formatCompact(observation.contextProxyTokens)}` : t('compare.cohort.sample.noTokenData')}
      </span>
      <span className="cmp-sample-retries">{observation.oneShot ? t('compare.cohort.sample.oneShot') : t('compare.cohort.sample.retryCount', { count: observation.retries })}</span>
    </button>
  )
}
