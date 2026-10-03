import { useId, useState, type MouseEvent } from 'react'
import { ChartTip } from '../components/ChartTip'
import { CliErrorPanel } from '../components/CliErrorPanel'
import { EmptyNote } from '../components/EmptyState'
import { Panel } from '../components/Panel'
import { SectionSkeleton } from '../components/Skeleton'
import { StaleBanner } from '../components/StaleBanner'
import { usePolled } from '../hooks/usePolled'
import { localeTag, t } from '../i18n'
import { codeburn } from '../lib/ipc'
import { reportMemoKey } from '../lib/reportMemoKey'
import { sparkArea, sparkPath, type SparkPoint } from '../lib/spark'
import { harnessName, SPEED_HARNESSES, type SpeedHarness, type SpeedReport, type SpeedRow, type SpeedSample } from '../lib/speed'
import type { DateRange, Period } from '../lib/types'
import './Speed.css'

const number = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: 1 })
const source = (row: Pick<SpeedRow, 'source' | 'resolution'>) => `${t(`speed.source.${row.source}`)} · ${t(`speed.resolution.${row.resolution}`)}`
const rowKey = (row: SpeedRow) => `${row.harness}|${row.model}|${row.source}|${row.resolution}`
const percent = (value: number) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 0 })}%`
type Metric = 'generation' | 'first'
type Tone = 'good' | 'bad' | 'flat'
const METRIC = {
  generation: { higherIsBetter: true, unit: 'tok/s', typical: (r: SpeedRow) => r.typical?.generationTokensPerSecondP50 ?? null,
    change: (r: SpeedRow) => r.typical?.generationChangePct ?? null, shift: (r: SpeedRow) => r.typical?.generationShift === true },
  first: { higherIsBetter: false, unit: 'ms', typical: (r: SpeedRow) => r.typical?.firstEmissionMsP50 ?? null,
    change: (r: SpeedRow) => r.typical?.firstEmissionChangePct ?? null, shift: (r: SpeedRow) => r.typical?.firstEmissionShift === true },
} as const
const series = (row: SpeedRow, metric: Metric) => (row.trend ?? []).map(p => (metric === 'generation' ? p?.generationTokensPerSecondP50 : p?.firstEmissionMsP50) ?? null)
const counts = (row: SpeedRow, metric: Metric) => (row.trend ?? []).map(p => (metric === 'generation' ? p?.generationRequests : p?.firstEmissionRequests) ?? 0)
const charted = (values: Array<number | null>) => values.some(v => v !== null)
/** Green when the move helps (faster generation, earlier first arrival), amber when it hurts. */
const tone = (metric: Metric, change: number | null, shift: boolean): Tone =>
  !shift || change === null || change === 0 ? 'flat' : (change > 0) === METRIC[metric].higherIsBetter ? 'good' : 'bad'
// The CLI's shift rule, applied per interval to color the chart's points.
const moved = (value: number, count: number, typical: number | null) => typical !== null && typical > 0 && count >= 5 && Math.abs(value - typical) / typical >= 0.25

/** Point runs between missing intervals, so a gap is never drawn as a slope. */
function runs(values: Array<number | null>, x: (i: number) => number, y: (v: number) => number): SparkPoint[][] {
  const out: SparkPoint[][] = []
  let run: SparkPoint[] = []
  values.forEach((v, i) => {
    if (v === null) { if (run.length) out.push(run); run = [] } else run.push([x(i), y(v)])
  })
  if (run.length) out.push(run)
  return out
}

function Delta({ change, tone }: { change: number; tone: Tone }) {
  return <span className={`speed-delta tone-${tone}`}>{percent(change)}</span>
}

function Typical({ row, metric }: { row: SpeedRow; metric: Metric }) {
  const value = METRIC[metric].typical(row), change = METRIC[metric].change(row)
  if (value === null) return null
  return <span className="speed-typical">{t('speed.typical', { value: number(value) })}
    {change !== null && <Delta change={change} tone={tone(metric, change, METRIC[metric].shift(row))} />}</span>
}

export function Speed(props: { period: Period; provider: string; range?: DateRange | null; refreshToken?: number; ready?: boolean }) {
  // Reset the event inspector together with the filter; an old response must
  // never appear under a newly selected harness or date range.
  return <SpeedReportView key={`${props.period}|${props.provider}|${props.range?.from}|${props.range?.to}`} {...props} />
}

function SpeedReportView({ period, provider, range = null, refreshToken = 0, ready = true }: Parameters<typeof Speed>[0]) {
  const supported = provider === 'all' || SPEED_HARNESSES.includes(provider as SpeedHarness)
  const [selected, setSelected] = useState<SpeedRow | null>(null)
  const [trendKey, setTrendKey] = useState<string | null>(null)
  const report = usePolled(
    () => codeburn.getSpeed(period, provider, range ?? undefined),
    [period, provider, range?.from, range?.to, refreshToken],
    { enabled: ready && supported, memoKey: reportMemoKey('speed', period, provider, range), cadence: { slowMs: 60_000 } },
  )
  const setup = <button className="btn btn-s" onClick={() => codeburn.openExternal('https://github.com/getagentseal/codeburn/blob/main/docs/speed.md')}>{t('speed.setup')}</button>
  if (!supported) return <Panel title={t('shell.nav.speed')} right={setup}><EmptyNote>{t('speed.unsupported')}</EmptyNote></Panel>
  if (!report.data) {
    if (report.error) return <CliErrorPanel error={report.error} subject={t('shell.nav.speed')} />
    return <SectionSkeleton label={t('speed.loading')} rows={4} />
  }
  const data = report.data
  // Default to a row whose typical day moved, else the best-sampled one.
  const trendRows = data.rows.filter(row => charted(series(row, 'generation')) || charted(series(row, 'first')))
  const trendRow = trendRows.find(row => rowKey(row) === trendKey)
    ?? trendRows.find(row => row.typical?.generationShift || row.typical?.firstEmissionShift)
    ?? [...trendRows].sort((a, b) => b.generationRequests - a.generationRequests)[0]
  return <>
    {report.error && <StaleBanner error={report.error} />}
    <Panel className="speed-report" title={t('speed.title')} right={setup}>
      <p className="speed-note">{t('speed.scope')}. {t('speed.explanation')}</p>
      {data.rows.length ? <div className="speed-scroll"><table className="speed-table">
        <thead><tr>
          <th>{t('models.headers.model')} / {t('speed.harness')}</th><th>{t('speed.precision')}</th>
          <th>{t('speed.generation')}</th><th>{t('speed.first')}</th>
          <th>{t('speed.duration')}</th><th>{t('speed.samples')}</th><th>{t('speed.trend')}</th><th>{t('speed.timeline')}</th>
        </tr></thead>
        <tbody>{data.rows.map(row => <tr key={`${row.harness}|${row.model}|${row.source}|${row.resolution}`}>
          <td className="speed-model"><b>{row.model}</b><span className="speed-harness">{harnessName[row.harness]}</span></td><td>{source(row)}</td>
          <td><span className="speed-rate">{row.generationRateEstimated && row.generationTokensPerSecondP50 != null ? '~' : ''}{number(row.generationTokensPerSecondP50)}</span>
            {row.bufferedDelivery && <span className="speed-typical"><span className="speed-delta">{t('speed.bufferedTag')}</span></span>}
            <Typical row={row} metric="generation" /></td>
          <td>{number(row.firstEmissionMsP50)}
            <Typical row={row} metric="first" /></td>
          <td>{number(row.durationMsP95)}</td>
          <td>{row.generationRequests} / {row.requests}</td>
          <td>{trendRows.includes(row) ? <TrendSpark row={row} active={row === trendRow} onSelect={() => setTrendKey(rowKey(row))} /> : '—'}</td>
          <td>{row.latestSampleId ? <button className="btn btn-s" aria-label={`${t('speed.timeline')}: ${harnessName[row.harness]} / ${row.model}`} onClick={() => setSelected(row)}>{t('speed.inspect')}</button> : '—'}</td>
        </tr>)}</tbody>
      </table></div> : <EmptyNote>{t('speed.empty')}</EmptyNote>}
      <p className="speed-note">{t('speed.precisionNote')}</p>
      <p className="speed-note">{t('speed.historyNote', { count: data.historyLimit })}</p>
      {data.rows.some(row => row.bufferedDelivery) && <p className="speed-note" role="status">{t('speed.buffered', {
        models: data.rows.filter(row => row.bufferedDelivery).map(row => `${harnessName[row.harness]} / ${row.model}`).join(', ') })}</p>}
      {data.unavailableHarnesses.length > 0 && <p className="speed-note">{t('speed.missing', { harnesses: data.unavailableHarnesses.map(h => harnessName[h]).join(', ') })}</p>}
      {(data.rejectedRecords > 0 || data.omittedRecords > 0) && <p role="status" className="speed-note">{t('speed.bounded', { rejected: data.rejectedRecords, omitted: data.omittedRecords })}</p>}
      {data.warnings.map((warning, index) => <p className="speed-note" role="status" key={index}>{warning}</p>)}
    </Panel>
    {trendRow && <SpeedTrend key={rowKey(trendRow)} row={trendRow} report={data} />}
    {selected?.latestSampleId && <SpeedTimeline key={`${selected.harness}|${selected.latestSampleId}`} id={selected.latestSampleId} harness={selected.harness} />}
  </>
}

function SpeedTimeline({ id, harness }: { id: string; harness: SpeedHarness }) {
  const sample = usePolled(() => codeburn.getSpeedEvents(id, harness), [id, harness], { intervalMs: null })
  if (!sample.data) {
    if (sample.error) return <CliErrorPanel error={sample.error} subject={t('speed.timeline')} />
    return <SectionSkeleton label={t('speed.loading')} rows={2} />
  }
  const data = sample.data
  return <Panel className="speed-timeline" title={`${harnessName[data.harness]} / ${data.model}`} right={source(data)}>
    <p className="speed-note">{new Date(data.startedAt).toLocaleString()} · {t(`speed.status.${data.status}`)}</p>
    <dl className="speed-stats">
      <div><dt>{t('speed.output')}</dt><dd>{number(data.outputTokens)}</dd></div>
      <div><dt>{t('speed.events')}</dt><dd>{number(data.events.length)}</dd></div>
      <div><dt>{t('speed.firstRequest')}</dt><dd>{number(data.firstEmissionMs)}</dd></div>
      <div><dt>{t('speed.durationRequest')}</dt><dd>{number(data.durationMs)}</dd></div>
    </dl>
    {data.events.length > 0 && <ArrivalChart sample={data} />}
    <p className="speed-note">{t(data.resolution === 'token' ? 'speed.tokenNote' : 'speed.chunkNote')}</p>
    {data.timelineTruncated && <p role="status" className="speed-note">{t('speed.truncated')}</p>}
  </Panel>
}

export function ArrivalChart({ sample }: { sample: SpeedSample }) {
  // Render at most 200 points, including the last event. Full counts and the
  // source's truncation flag stay visible; a chunk never becomes a token.
  const count = Math.min(sample.events.length, 200)
  const points = Array.from({ length: count }, (_, i) => {
    const index = count === 1 ? 0 : Math.round(i * (sample.events.length - 1) / (count - 1))
    const x = 20 + sample.events[index]!.elapsedMs / Math.max(sample.durationMs, 1) * 760
    const y = 130 - index / Math.max(sample.events.length - 1, 1) * 110
    return { x, y, index }
  })
  return <figure className="speed-chart">
    <svg role="img" aria-label={t('speed.chart')} viewBox="0 0 800 160">
      <path d="M20 10 V140 H780" fill="none" stroke="currentColor" opacity="0.25" />
      <polyline points={points.map(p => `${p.x},${p.y}`).join(' ')} fill="none" stroke="var(--accent, #7c83ff)" strokeWidth="2" />
      {points.map(p => <circle key={p.index} cx={p.x} cy={p.y} r="3" fill="var(--accent, #7c83ff)"><title>{`${p.index + 1}: ${number(sample.events[p.index]!.elapsedMs)} ms`}</title></circle>)}
      <text x="20" y="157" fill="currentColor" fontSize="11">0 ms</text>
      <text x="780" y="157" textAnchor="end" fill="currentColor" fontSize="11">{number(sample.durationMs)} ms</text>
    </svg>
    <figcaption className="speed-note">{t('speed.chartCaption', { shown: count, total: sample.events.length })}</figcaption>
  </figure>
}

function TrendSpark({ row, active, onSelect }: { row: SpeedRow; active: boolean; onSelect: () => void }) {
  const id = useId()
  const metric: Metric = charted(series(row, 'generation')) ? 'generation' : 'first'
  const values = series(row, metric)
  const width = 84, height = 26
  const max = Math.max(...values.map(v => v ?? 0)) || 1
  const x = (i: number) => values.length === 1 ? width / 2 : 3 + i / (values.length - 1) * (width - 6)
  const y = (v: number) => height - 3 - v / max * (height - 8)
  const parts = runs(values, x, y)
  const last = parts.at(-1)?.at(-1)
  return <button className={`speed-spark tone-${tone(metric, METRIC[metric].change(row), METRIC[metric].shift(row))}${active ? ' on' : ''}`}
    aria-pressed={active} aria-label={`${t('speed.trend')}: ${harnessName[row.harness]} / ${row.model}`} onClick={onSelect}>
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true">
      <defs><linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" /><stop offset="100%" stopColor="currentColor" stopOpacity="0" />
      </linearGradient></defs>
      {parts.map((run, i) => run.length > 1
        // Two-point runs stay a plain stroke; a fill under them reads as a pin.
        ? <g key={i}>{run.length > 2 && <path d={sparkArea(run, height)} fill={`url(#${id}-fill)`} />}<path className="speed-spark-line" d={sparkPath(run)} /></g>
        : <circle key={i} cx={run[0]![0]} cy={run[0]![1]} r="1.5" fill="currentColor" />)}
      {last && <circle cx={last[0]} cy={last[1]} r="2.5" fill="currentColor" />}
    </svg>
  </button>
}

function SpeedTrend({ row, report }: { row: SpeedRow; report: SpeedReport }) {
  const chart = (metric: Metric, label: string) => <TrendChart label={label} metric={metric} starts={report.trend?.starts ?? []} bucket={report.trend?.bucket ?? 'day'}
    values={series(row, metric)} counts={counts(row, metric)} now={metric === 'generation' ? row.generationTokensPerSecondP50 : row.firstEmissionMsP50}
    typical={METRIC[metric].typical(row)} change={METRIC[metric].change(row)} shift={METRIC[metric].shift(row)} />
  return <Panel className="speed-trend" title={`${t('speed.trend')} · ${harnessName[row.harness]} / ${row.model}`} right={t(`speed.trend.${report.trend?.bucket ?? 'day'}`)}>
    {chart('generation', t('speed.generation'))}
    {chart('first', t('speed.first'))}
    <p className="speed-note">{t('speed.trendNote')}{report.typicalDays != null && ` ${t('speed.typicalNote', { days: report.typicalDays })}`}</p>
  </Panel>
}

/** Rounds an axis maximum up to 1, 2, 2.5 or 5 times a power of ten. */
function niceCeil(value: number): number {
  if (value <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  return ([1, 2, 2.5, 5, 10].find(step => step * power >= value) ?? 10) * power
}

export function TrendChart({ label, metric, starts, bucket, values, counts, now, typical, change, shift }: {
  label: string; metric: Metric; starts: string[]; bucket: 'hour' | 'day' | 'week'
  values: Array<number | null>; counts: number[]; now: number | null; typical: number | null; change: number | null; shift: boolean
}) {
  const id = useId()
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null)
  if (!charted(values)) return null
  const width = 800, height = 180, left = 58, right = 18, top = 16, bottom = 30
  const top_ = niceCeil(Math.max(...values.map(v => v ?? 0), typical ?? 0) * 1.08)
  const x = (i: number) => left + (values.length === 1 ? 0.5 : i / (values.length - 1)) * (width - left - right)
  const y = (v: number) => top + (1 - v / top_) * (height - top - bottom)
  const when = (iso: string | undefined, long = false) => iso === undefined ? '' : bucket === 'hour'
    ? new Date(iso).toLocaleString(localeTag(), long ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' })
    : new Date(iso).toLocaleDateString(localeTag(), { month: 'short', day: 'numeric', ...(long && bucket === 'week' ? { year: 'numeric' } : {}) })
  const ticks = values.length <= 1 ? [0] : [...new Set([0, 0.25, 0.5, 0.75, 1].map(f => Math.round(f * (values.length - 1))))]
  const parts = runs(values, x, y)
  const unit = METRIC[metric].unit
  const point = (event: MouseEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const vx = (event.clientX - box.left) / box.width * width
    const index = values.length === 1 ? 0 : Math.round((vx - left) / (width - left - right) * (values.length - 1))
    setHover({ index: Math.max(0, Math.min(values.length - 1, index)), x: event.clientX, y: event.clientY })
  }
  const hovered = hover ? values[hover.index] ?? null : null
  return <figure className="speed-chart speed-trend-chart">
    <figcaption className="speed-chart-head">
      <span className="speed-chart-label">{label}</span>
      <span className="speed-chips">
        {now !== null && <span className="speed-chip"><i className="speed-chip-sw" />{number(now)} {unit}</span>}
        {typical !== null && <span className="speed-chip"><i className="speed-chip-sw dashed" />{t('speed.typical', { value: number(typical) })}</span>}
        {change !== null && <Delta change={change} tone={tone(metric, change, shift)} />}
      </span>
    </figcaption>
    <svg role="img" aria-label={t('speed.trendChart', { metric: label })} viewBox={`0 0 ${width} ${height}`} onMouseMove={point} onMouseLeave={() => setHover(null)}>
      <defs><linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" /><stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
      </linearGradient></defs>
      {[0, 0.5, 1].map(f => <g key={f}>
        <line className={f === 0 ? 'speed-axis' : 'speed-grid'} x1={left} x2={width - right} y1={y(top_ * f)} y2={y(top_ * f)} />
        <text className="speed-axis-text" x={left - 10} y={y(top_ * f) + 4} textAnchor="end">{number(top_ * f)}</text>
      </g>)}
      {ticks.map(i => <text key={i} className="speed-axis-text" x={x(i)} y={height - 8}
        textAnchor={values.length === 1 ? 'middle' : i === 0 ? 'start' : i === values.length - 1 ? 'end' : 'middle'}>{when(starts[i])}</text>)}
      {parts.map((run, i) => run.length > 1 && <path key={i} d={sparkArea(run, height - bottom)} fill={`url(#${id}-fill)`} />)}
      {typical !== null && <g>
        <line className="speed-typical-line" x1={left} x2={width - right} y1={y(typical)} y2={y(typical)} />
        <text className="speed-axis-text speed-typical-text" x={width - right} y={y(typical) - 6} textAnchor="end">{t('speed.typical', { value: number(typical) })}</text>
      </g>}
      {parts.map((run, i) => run.length > 1 && <path key={i} className="speed-line" d={sparkPath(run)} />)}
      {hover && <line className="speed-crosshair" x1={x(hover.index)} x2={x(hover.index)} y1={top} y2={height - bottom} />}
      {values.map((v, i) => {
        if (v === null) return null
        const isolated = values[i - 1] == null && values[i + 1] == null
        const shifted = moved(v, counts[i]!, typical)
        if (!isolated && !shifted && hover?.index !== i && i !== values.length - 1) return null
        const pointTone = shifted ? tone(metric, v - typical!, true) : 'flat'
        return <circle key={i} className={`speed-dot tone-${pointTone}`} cx={x(i)} cy={y(v)} r={hover?.index === i ? 5 : shifted ? 4 : 3} />
      })}
    </svg>
    {hover && <ChartTip x={hover.x} y={hover.y}>
      <div className="chart-tip-d">{when(starts[hover.index], true)}</div>
      {hovered === null ? <div className="chart-tip-s">{t('speed.noInterval')}</div> : <>
        <div className="chart-tip-v">{number(hovered)} {unit}</div>
        <div className="chart-tip-s">{t('speed.requests', { count: counts[hover.index]! })}</div>
        {typical !== null && typical > 0 && <div className="chart-tip-s">{t('speed.typical', { value: number(typical) })} · {percent((hovered - typical) / typical * 100)}</div>}
      </>}
    </ChartTip>}
  </figure>
}
