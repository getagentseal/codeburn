import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CliErrorPanel } from '../components/CliErrorPanel'
import { EmptyNote } from '../components/EmptyState'
import { SectionSkeleton } from '../components/Skeleton'
import { SegTabs } from '../components/SegTabs'
import { AnchoredSurface } from '../components/AnchoredSurface'
import { RangeCalendar } from '../components/RangeCalendar'
import { useEscape } from '../hooks/useEscape'
import { usePolled } from '../hooks/usePolled'
import { ChartTip } from '../components/ChartTip'
import { formatAxisMoney, niceTicks, ticksClearOfPeak } from '../lib/chartAxis'
import { formatCompact, formatUsd, shortenProjectPath } from '../lib/format'
import { Usd, tokensOf } from '../components/Usd'
import { localeTag, t } from '../i18n'
import { codeburn } from '../lib/ipc'
import { reportMemoKey } from '../lib/reportMemoKey'
import { trackEvent } from '../lib/track'
import type { DateRange, PeriodContribution, PeriodDiffReport, PeriodRangeInfo, PeriodSessionDiff } from '../lib/types'
import { Icon } from '../components/icons'

// Compare periods: two ranges, one deterministic difference. A is the
// reference, B the analyzed period; every difference on screen is B − A,
// straight from `codeburn compare-periods` (src/period-diff.ts). Nothing here
// recomputes usage — the renderer never reads logs or aggregates sessions.

type Lens = 'projects' | 'models'
type View = 'raw' | 'perDay' | 'per100Calls'

type Persisted = { preset: 'last7' | 'custom'; rangeA: DateRange; rangeB: DateRange; lens: Lens; view: View }

const STORAGE_KEY = 'codeburn.periodCompare.v1'

function readPersisted(): Persisted | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Persisted>
    if (!parsed?.rangeA?.from || !parsed?.rangeB?.from) return null
    return {
      preset: parsed.preset === 'custom' ? 'custom' : 'last7',
      rangeA: { from: parsed.rangeA.from, to: parsed.rangeA.to },
      rangeB: { from: parsed.rangeB.from, to: parsed.rangeB.to },
      lens: parsed.lens === 'models' ? 'models' : 'projects',
      view: parsed.view === 'perDay' || parsed.view === 'per100Calls' ? parsed.view : 'raw',
    }
  } catch { return null }
}

function persist(state: Persisted): void {
  try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* storage can be unavailable */ }
}

/// Mirror of the CLI default (src/period-diff.ts defaultSevenDayRanges):
/// B = the last seven COMPLETE local calendar days (today is never complete),
/// A = the seven before that. Local time only — never UTC.
export function defaultSevenRanges(now = new Date()): { rangeA: DateRange; rangeB: DateRange } {
  const key = (offset: number): string => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
    return localKey(d)
  }
  return {
    rangeB: { from: key(-7), to: key(-1) },
    rangeA: { from: key(-14), to: key(-8) },
  }
}

function localKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function formatDayShort(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(localeTag(), { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatDayTerse(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(localeTag(), { month: 'short', day: 'numeric' })
}

/// A column header has no room for two full dates. Drop the year, and the
/// second month too when both ends share it: "Sep 1–7", "Mar 1–Jun 8".
function terseRangeLabel(range: PeriodRangeInfo): string {
  if (range.from === range.to) return formatDayTerse(range.from)
  const sameMonth = range.from.slice(0, 7) === range.to.slice(0, 7)
  const to = sameMonth ? String(Number(range.to.slice(8))) : formatDayTerse(range.to)
  return `${formatDayTerse(range.from)}–${to}`
}

function signedUsd(value: number): string {
  const body = formatUsd(Math.abs(value))
  if (value > 0) return `+${body}`
  if (value < 0) return `−${body}`
  return body
}

function signedPct(value: number | null): string {
  if (value === null) return '—'
  const body = `${Math.abs(value) >= 100 ? Math.round(Math.abs(value)).toLocaleString('en-US') : Math.abs(value).toFixed(1)}%`
  return value > 0 ? `+${body}` : value < 0 ? `−${body}` : '0%'
}

function signedCount(value: number): string {
  const body = Math.abs(value).toLocaleString('en-US')
  return value > 0 ? `+${body}` : value < 0 ? `−${body}` : body
}

function wholePct(value: number): string {
  return `${Math.round(Math.abs(value)).toLocaleString('en-US')}%`
}

/// Tiles sit in the same card as the lead sentence and are read in the same
/// glance, so they round the way the prose does; the tables keep one decimal.
function signedWholePct(value: number | null): string {
  if (value === null) return '—'
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${wholePct(value)}`
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`
}

function rangeLabel(range: PeriodRangeInfo): string {
  if (range.from === range.to) return formatDayShort(range.from)
  return range.days === 7
    ? t('compare.periodCompare.rangeLabel.weekOf', { date: formatDayShort(range.from) })
    : t('compare.periodCompare.rangeLabel.fromTo', { from: formatDayShort(range.from), to: formatDayShort(range.to) })
}

/// The second half of the lead sentence. Sessions moving hard while cost per
/// call barely follows is the one reading a reader gets wrong, so it gets its
/// own wording; everything else states both directions plainly.
function secondClause(sessionsPct: number | null, per100Pct: number | null): string {
  if (sessionsPct === null || per100Pct === null || sessionsPct === 0) return ''
  const sessionsDown = sessionsPct < 0
  const callsDown = per100Pct < 0
  const together = sessionsDown === callsDown && Math.abs(per100Pct) >= Math.abs(sessionsPct)
  if (Math.abs(sessionsPct) > 30 && per100Pct !== 0 && !together) {
    const sessions = t(sessionsDown ? 'compare.periodCompare.second.farFewerSessions' : 'compare.periodCompare.second.farMoreSessions')
    const calls = t(callsDown ? 'compare.periodCompare.second.cheaper' : 'compare.periodCompare.second.moreExpensive')
    const softener = sessionsDown === callsDown ? t('compare.periodCompare.second.only') : ''
    const direction = t(callsDown ? 'compare.periodCompare.second.fell' : 'compare.periodCompare.second.rose')
    return t('compare.periodCompare.second.farClause', { sessions, calls, direction, softener, percent: wholePct(per100Pct) })
  }
  const calls = t(per100Pct === 0 ? 'compare.periodCompare.second.sameCostPerCall' : callsDown ? 'compare.periodCompare.second.cheaperCalls' : 'compare.periodCompare.second.moreExpensiveCalls')
  const direction = t(sessionsDown ? 'compare.periodCompare.second.fewer' : 'compare.periodCompare.second.more')
  return t('compare.periodCompare.second.simpleClause', { direction, calls })
}

/// The whole comparison in one sentence, built only from report numbers.
export function leadSentence(report: PeriodDiffReport): string {
  const weeks = report.rangeA.days === 7 && report.rangeB.days === 7
  const subject = weeks
    ? t('compare.periodCompare.lead.subjectWeek', { date: formatDayShort(report.rangeB.from) })
    : t('compare.periodCompare.lead.subjectRange', { range: rangeLabel(report.rangeB) })
  const before = t(weeks ? 'compare.periodCompare.lead.beforeWeek' : 'compare.periodCompare.lead.beforeRange')
  const costA = formatUsd(report.totals.A.cost)
  const costB = formatUsd(report.totals.B.cost)
  const pct = report.totals.pct.cost
  const head = pct === null
    ? t('compare.periodCompare.lead.headNoPct', { subject, costB, costA, before })
    : Math.abs(pct) < 0.5
      ? t('compare.periodCompare.lead.headFlat', { subject, before, costB, costA })
      : t('compare.periodCompare.lead.headChanged', { subject, percent: wholePct(pct), direction: t(pct < 0 ? 'compare.periodCompare.lead.less' : 'compare.periodCompare.lead.more'), before, costB, costA })
  const tail = secondClause(report.totals.pct.sessions, report.normalized.per100Calls.pct)
  return tail ? `${head} ${tail}` : head
}

const STATUS_LABEL_KEY: Record<PeriodContribution['status'], string> = {
  new: 'compare.periodCompare.status.new',
  gone: 'compare.periodCompare.status.gone',
  up: 'compare.periodCompare.status.up',
  down: 'compare.periodCompare.status.down',
  flat: 'compare.periodCompare.status.flat',
}

/// One lens row under a normalization view. Raw rows come straight from the
/// report; normalized views recompute differences, percentages and direction
/// from each side's own denominator — a
/// zero-call side has NO cost-per-call, never zero.
function normalizeRow(row: PeriodContribution, view: View, daysA: number, daysB: number): { a: number | null; b: number | null; diff: number | null; pct: number | null; status: PeriodContribution['status'] } {
  if (view === 'raw') return { a: row.costA, b: row.costB, diff: row.diff, pct: row.pct, status: row.status }
  const a = view === 'perDay'
    ? (daysA > 0 ? row.costA / daysA : null)
    : (row.callsA > 0 ? row.costA * 100 / row.callsA : null)
  const b = view === 'perDay'
    ? (daysB > 0 ? row.costB / daysB : null)
    : (row.callsB > 0 ? row.costB * 100 / row.callsB : null)
  let status: PeriodContribution['status']
  if ((a === null || a === 0) && b !== null && b !== 0) status = 'new'
  else if ((b === null || b === 0) && a !== null && a !== 0) status = 'gone'
  else if (a === null && b === null) status = 'flat'
  else if (b! > a!) status = 'up'
  else if (b! < a!) status = 'down'
  else status = 'flat'
  const diff = a !== null && b !== null ? b - a : null
  const pct = a !== null && Math.abs(a) > 0 && diff !== null ? (diff / Math.abs(a)) * 100 : null
  return { a, b, diff, pct, status }
}

export function PeriodCompare({
  provider,
  refreshToken = 0,
  ready = true,
  onInspectContribution,
}: {
  provider: string
  refreshToken?: number
  ready?: boolean
  /** Navigation adapter (until the goal-8 navigation lands): open the existing
   *  Sessions section scoped to one of the compared ranges. */
  onInspectContribution?: (range: DateRange, dimension: 'project' | 'model', key: string) => void
}) {
  const saved = useMemo(readPersisted, [])
  const defaults = useMemo(() => defaultSevenRanges(), [])
  const [preset, setPreset] = useState<Persisted['preset']>(saved?.preset ?? 'last7')
  const [rangeA, setRangeA] = useState<DateRange>(saved?.rangeA ?? defaults.rangeA)
  const [rangeB, setRangeB] = useState<DateRange>(saved?.rangeB ?? defaults.rangeB)
  const [lens, setLens] = useState<Lens>(saved?.lens ?? 'projects')
  const [view, setView] = useState<View>(saved?.view ?? 'raw')
  const [drill, setDrill] = useState<{ dimension: 'project' | 'model'; key: string } | null>(null)

  useEffect(() => {
    persist({ preset, rangeA, rangeB, lens, view })
  }, [preset, rangeA, rangeB, lens, view])

  const report = usePolled<PeriodDiffReport>(
    () => codeburn.getPeriodCompare(rangeA, rangeB, provider),
    [rangeA.from, rangeA.to, rangeB.from, rangeB.to, provider, refreshToken],
    { enabled: ready, memoKey: reportMemoKey('periodcompare-v2', 'week', provider, rangeA, `${rangeB.from}..${rangeB.to}`) },
  )

  // One event per distinct (lens, view) actually put on screen, not per
  // keystroke. Enum values only.
  const trackedConfig = useRef<string | null>(null)
  useEffect(() => {
    if (!report.data) return
    const config = `${lens}|${view}`
    if (trackedConfig.current === config) return
    trackedConfig.current = config
    trackEvent('period_compare_view', { lens, view })
  }, [report.data, lens, view])

  const swap = useCallback(() => {
    setRangeA(rangeB)
    setRangeB(rangeA)
  }, [rangeA, rangeB])

  const pickPreset = useCallback((value: string) => {
    if (value === 'last7') {
      const next = defaultSevenRanges()
      setPreset('last7')
      setRangeA(next.rangeA)
      setRangeB(next.rangeB)
    } else {
      setPreset('custom')
    }
  }, [])

  return (
    <div className="pcmp" aria-label={t('compare.periodCompare.rootAriaLabel')}>
      <div className="panel cmp-card pcmp-controls">
        <div className="pbody pcmp-controls-body">
        <div className="pcmp-controls-row">
          <SegTabs
            options={[{ value: 'last7', label: t('compare.periodCompare.preset.last7') }, { value: 'custom', label: t('compare.periodCompare.preset.custom') }]}
            value={preset}
            onChange={pickPreset}
          />
          <button type="button" className="pcmp-swap" onClick={swap} aria-label={t('compare.periodCompare.controls.swapAriaLabel')}>
            <Icon name="arrow-left-right" className="pcmp-swap-icon" /> {t('compare.periodCompare.controls.swap')}
          </button>
        </div>
        <div className="pcmp-ranges">
          <RangeField label={t('compare.periodCompare.range.aLabel')} value={rangeA} onChange={setRangeA} />
          <RangeField label={t('compare.periodCompare.range.bLabel')} value={rangeB} onChange={setRangeB} />
        </div>
        <RangeMeta rangeA={rangeA} rangeB={rangeB} />
        </div>
      </div>

      {!report.data
        ? report.error
          ? <CliErrorPanel error={report.error} subject={t('compare.periodCompare.subject')} />
          : <SectionSkeleton label={t('compare.periodCompare.comparing')} rows={5} />
        : (
            <>
              <SummaryCard report={report.data} />
              <DayBarsCard report={report.data} />
              <MoversCard
                report={report.data}
                lens={lens}
                view={view}
                onLens={setLens}
                onView={setView}
                drill={drill}
                onDrill={setDrill}
                onInspectContribution={onInspectContribution}
                provider={provider}
                refreshToken={refreshToken}
              />
              <details className="panel cmp-card pcmp-fold">
                <summary>{t('compare.periodCompare.allMetrics')}</summary>
                <div className="pcmp-fold-body">
                  <TotalsCard report={report.data} />
                  <NormalizedCard report={report.data} />
                </div>
              </details>
              <CoverageCard report={report.data} />
            </>
          )}
    </div>
  )
}

function RangeField({ label, value, onChange }: { label: string; value: DateRange; onChange: (range: DateRange) => void }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (!wrapRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  useEscape(open, () => setOpen(false))

  return (
    <div className="pcmp-range" ref={wrapRef}>
      <span className="pcmp-range-label">{label}</span>
      <button
        ref={triggerRef}
        type="button"
        className="pcmp-range-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}: ${t('compare.periodCompare.rangeLabel.fromTo', { from: value.from, to: value.to })}`}
        onClick={() => setOpen(current => !current)}
      >
        {formatDayShort(value.from)} – {formatDayShort(value.to)}
      </button>
      {open && (
        <AnchoredSurface anchor={triggerRef} surfaceRef={popoverRef} className="calendar-popover" role="dialog" aria-label={t('compare.periodCompare.range.dateRangeAriaLabel', { label })}>
          <RangeCalendar
            value={value}
            onSelect={range => {
              onChange(range)
              setOpen(false)
            }}
          />
        </AnchoredSurface>
      )}
    </div>
  )
}

function RangeMeta({ rangeA, rangeB }: { rangeA: DateRange; rangeB: DateRange }) {
  const days = (range: DateRange): number => {
    // Local midnight walk — same arithmetic as the engine (src/period-diff.ts).
    const [fy, fm, fd] = range.from.split('-').map(Number)
    const [ty, tm, td] = range.to.split('-').map(Number)
    const cursor = new Date(fy, fm - 1, fd)
    const end = new Date(ty, tm - 1, td)
    if (cursor > end) return 0
    let count = 0
    while (cursor <= end) { count++; cursor.setDate(cursor.getDate() + 1) }
    return count
  }
  const daysA = days(rangeA)
  const daysB = days(rangeB)
  const overlapStart = rangeA.from > rangeB.from ? rangeA.from : rangeB.from
  const overlapEnd = rangeA.to < rangeB.to ? rangeA.to : rangeB.to
  const overlap = overlapStart <= overlapEnd ? days({ from: overlapStart, to: overlapEnd }) : 0
  const delta = daysB - daysA
  const unit = (n: number) => t(n === 1 ? 'compare.periodCompare.meta.day' : 'compare.periodCompare.meta.days')
  return (
    <p className="pcmp-meta" role="status">
      {t('compare.periodCompare.meta.aSpans', { count: daysA, unit: unit(daysA) })}
      {' · '}
      {t('compare.periodCompare.meta.bSpans', { count: daysB, unit: unit(daysB) })}
      {delta !== 0 && <> · {t('compare.periodCompare.meta.durationDiffers', { sign: delta > 0 ? '+' : '−', count: Math.abs(delta), unit: unit(Math.abs(delta)) })}</>}
      {overlap > 0 && <> · {t('compare.periodCompare.meta.overlap', { count: overlap, unit: unit(overlap) })}</>}
      {' · '}{t('compare.periodCompare.meta.allDiffs')}
    </p>
  )
}

function SummaryCard({ report }: { report: PeriodDiffReport }) {
  const per100 = report.normalized.per100Calls
  // Only the two money tiles carry the cost semantics: more sessions is not a
  // bill going up, so the Sessions tile stays neutral.
  const tiles = [
    { label: t('compare.periodCompare.summary.totalCost'), value: <Usd value={report.totals.B.cost} tokens={tokensOf(report.totals.B)} />, change: signedUsd(report.totals.diff.cost), tone: diffClass(report.totals.diff.cost, 'cost'), pct: report.totals.pct.cost },
    { label: t('compare.periodCompare.summary.costPer100Calls'), value: per100.b === null ? '—' : formatUsd(per100.b), change: per100.diff === null ? '—' : signedUsd(per100.diff), tone: diffClass(per100.diff ?? 0, 'cost'), pct: per100.pct },
    { label: t('compare.periodCompare.summary.sessions'), value: report.totals.B.sessions.toLocaleString('en-US'), change: signedCount(report.totals.diff.sessions), tone: '', pct: report.totals.pct.sessions },
  ]
  return (
    <div className="panel cmp-card pcmp-summary">
      <div className="pbody pcmp-summary-body">
      <p className="pcmp-lead">{leadSentence(report)}</p>
      <div className="pcmp-tiles">
        {tiles.map(tile => (
          <div className="pcmp-tile" key={tile.label}>
            <span className="pcmp-tile-label">{tile.label}</span>
            <span className="pcmp-tile-value">{tile.value}</span>
            <span className={`pcmp-tile-change ${tile.tone}`}>{tile.change}, {signedWholePct(tile.pct)}</span>
          </div>
        ))}
      </div>
      </div>
    </div>
  )
}

function DayBarsCard({ report }: { report: PeriodDiffReport }) {
  const [tip, setTip] = useState<{ index: number; x: number; y: number } | null>(null)
  const daysA = report.daily?.A ?? []
  const daysB = report.daily?.B ?? []
  const span = Math.max(daysA.length, daysB.length)
  if (span === 0) return null
  const max = Math.max(0, ...daysA.map(day => day.cost), ...daysB.map(day => day.cost))
  // Bars are drawn against the top tick, so a bar top and a gridline agree.
  const valueTicks = niceTicks(max)
  const axisMax = valueTicks.at(-1) || 1
  const height = (cost: number): string => `${axisMax > 0 ? Math.max(2, (cost / axisMax) * 100) : 2}%`
  const peakIndex = Math.max(daysA.findIndex(day => day.cost === max), daysB.findIndex(day => day.cost === max))
  const labelA = rangeLabel(report.rangeA)
  const labelB = rangeLabel(report.rangeB)
  // Same stride as the Overview chart, floored so a short range still gets a
  // label per day: at most ~7 dates, never one per day past ~25.
  const stride = span <= 45 ? Math.min(7, Math.max(1, Math.ceil(span / 7))) : Math.ceil((span - 1) / 5)
  const ticks = Array.from({ length: span }, (_, index) => index).filter(index => index % stride === 0)
  if (span > 45 && ticks.at(-1) !== span - 1) ticks.push(span - 1)
  const bar = (side: 'A' | 'B', index: number) => {
    const day = (side === 'A' ? daysA : daysB)[index]
    if (!day) return null
    return <span key={side} className={`pcmp-bar pcmp-bar-${side.toLowerCase()}`} style={{ height: height(day.cost) }} />
  }
  const slotLabel = (index: number): string => (
    ([[labelA, daysA], [labelB, daysB]] as const)
      .map(([label, days]) => {
        const day = days[index]
        return day ? `${label}, ${formatDayShort(day.date)}: ${formatUsd(day.cost)}` : null
      })
      .filter(Boolean)
      .join('; ')
  )
  return (
    <div className="panel cmp-card">
      <div className="cmp-head">
        <h3>{t('compare.periodCompare.dayBars.title')}</h3>
        <span className="cmp-head-note pcmp-legend">
          <span><i className="pcmp-swatch-a" />{labelA}</span>
          <span><i className="pcmp-swatch-b" />{labelB}</span>
        </span>
      </div>
      <div className="pbody pcmp-chart">
        <div className="chart-frame">
        <div className="chart-plot">
        <div className="chart-grid" aria-hidden="true">
          {valueTicks.map(tick => <span className="chart-gridline" key={tick} style={{ bottom: `${(tick / axisMax) * 100}%` }} />)}
          {Array.from({ length: span }, (_, index) => (index > 0 && index % 7 === 0
            ? <span className="chart-weekline" key={index} style={{ left: `${(index / span) * 100}%` }} />
            : null))}
        </div>
        <div className="chart pcmp-days" style={{ gap: `${span > 45 ? 3 : span > 20 ? 6 : 10}px` }} aria-label={t('compare.periodCompare.dayBars.chartAriaLabel')}>
          {Array.from({ length: span }, (_, index) => (
            <button
              type="button"
              className="pcmp-day"
              key={index}
              aria-label={slotLabel(index)}
              onMouseEnter={event => setTip({ index, x: event.clientX, y: event.clientY })}
              onMouseMove={event => setTip({ index, x: event.clientX, y: event.clientY })}
              onMouseLeave={() => setTip(null)}
            >{bar('A', index)}{bar('B', index)}</button>
          ))}
        </div>
        {max > 0 && (
          <span className="chart-peak-guide" aria-hidden="true" style={{ bottom: `${(max / axisMax) * 100}%`, left: `${((Math.max(0, peakIndex) + 0.5) / span) * 100}%` }} />
        )}
        </div>
        <div className="chart-axis" aria-hidden="true">
          {ticksClearOfPeak(valueTicks, max, axisMax).map(tick => <span className="chart-axis-tick" key={tick} style={{ bottom: `${(tick / axisMax) * 100}%` }}>{formatAxisMoney(tick)}</span>)}
          {max > 0 && <span className="chart-axis-peak" style={{ bottom: `${(max / axisMax) * 100}%` }}>{formatUsd(max)}</span>}
        </div>
        <div className="ov-xax">
          {ticks.map(index => {
            // A centred label on the appended edge tick runs past the card;
            // at that density anchoring it is invisible.
            const atEdge = span > 45 && index === span - 1
            return atEdge
              ? <span key={index} className="pcmp-xax-end" style={{ right: 0 }}>{t('compare.periodCompare.dayBars.dayLabel', { n: index + 1 })}</span>
              : <span key={index} style={{ left: `${((index + 0.5) / span) * 100}%` }}>{t('compare.periodCompare.dayBars.dayLabel', { n: index + 1 })}</span>
          })}
        </div>
        </div>
        <p className="pcmp-caption">{t('compare.periodCompare.dayBars.caption')}</p>
      </div>
      {tip && (
        <ChartTip x={tip.x} y={tip.y}>
          {(['A', 'B'] as const).map(side => {
            const day = (side === 'A' ? daysA : daysB)[tip.index]
            return day && (
              <div className="pcmp-tip-row" key={side}>
                <i className={`pcmp-swatch-${side.toLowerCase()}`} />
                <span className="pcmp-tip-date">{formatDayTerse(day.date)}</span>
                <span className="pcmp-tip-cost">{formatUsd(day.cost)}</span>
              </div>
            )
          })}
        </ChartTip>
      )}
    </div>
  )
}

// The report's own field names double as ids: translating the display label
// can no longer break the cost/tokens formatting or coloring lookups below.
type TotalsRowId = keyof PeriodDiffReport['totals']['pct']

const TOTALS_ROWS: Array<{ id: TotalsRowId; labelKey: string }> = [
  { id: 'cost', labelKey: 'compare.periodCompare.totals.apiEquivalentCost' },
  { id: 'calls', labelKey: 'compare.periodCompare.totals.apiCalls' },
  { id: 'sessions', labelKey: 'compare.periodCompare.totals.sessions' },
  { id: 'inputTokens', labelKey: 'compare.periodCompare.totals.inputTokens' },
  { id: 'outputTokens', labelKey: 'compare.periodCompare.totals.outputTokens' },
  { id: 'cacheReadTokens', labelKey: 'compare.periodCompare.totals.cacheReadTokens' },
  { id: 'cacheWriteTokens', labelKey: 'compare.periodCompare.totals.cacheWriteTokens' },
  { id: 'savingsUSD', labelKey: 'compare.periodCompare.totals.localModelSavings' },
  { id: 'estimatedCostUSD', labelKey: 'compare.periodCompare.totals.estimatedPriceCost' },
]

const TOKEN_ROW_IDS: TotalsRowId[] = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']

function isCostLikeRow(id: TotalsRowId): boolean {
  return id === 'cost' || id === 'estimatedCostUSD'
}

function fmtTotalsValue(id: TotalsRowId, value: number): string {
  if (id === 'cost' || id === 'savingsUSD' || id === 'estimatedCostUSD') return formatUsd(value)
  if (TOKEN_ROW_IDS.includes(id)) return formatCompact(value)
  return value.toLocaleString('en-US')
}

function signed(id: TotalsRowId, diff: number): string {
  if (id === 'cost' || id === 'savingsUSD' || id === 'estimatedCostUSD') return signedUsd(diff)
  if (TOKEN_ROW_IDS.includes(id)) return signedCompact(diff)
  return signedCount(diff)
}

function signedCompact(value: number): string {
  const body = formatCompact(Math.abs(value))
  return value > 0 ? `+${body}` : value < 0 ? `−${body}` : body
}

function diffClass(value: number, label: string): string {
  if (!label.includes('cost')) return ''
  if (value > 0) return 'pcmp-up'
  if (value < 0) return 'pcmp-down'
  return ''
}

function TotalsCard({ report }: { report: PeriodDiffReport }) {
  // A range whose sources aged off disk is explained by the durable daily
  // history alone, which carries no session detail. That cost is real and it is
  // NOT in these totals, so say so where the totals are read — not only in the
  // Coverage card at the bottom of the page.
  const carriedA = report.history?.aggregateOnly.A ?? 0
  const carriedB = report.history?.aggregateOnly.B ?? 0
  return (
    <div className="cmp-card pcmp-block">
      <div className="cmp-head"><h3>{t('compare.periodCompare.totals.title')}</h3><span className="cmp-head-note">{t('compare.periodCompare.totals.subtitle')}</span></div>
      <div className="pbody">
      {(carriedA > 0 || carriedB > 0) && (
        <p className="pcmp-caption">
          {t('compare.periodCompare.totals.carriedCaption', { a: formatUsd(carriedA), b: formatUsd(carriedB) })}
        </p>
      )}
      <div className="pcmp-table" role="table" aria-label={t('compare.periodCompare.totals.tableAriaLabel')}>
        <div className="pcmp-tr pcmp-th" role="row">
          <span role="columnheader">{t('compare.periodCompare.col.metric')}</span><span role="columnheader">{t('compare.periodCompare.col.a')}</span><span role="columnheader">{t('compare.periodCompare.col.b')}</span><span role="columnheader">{t('compare.periodCompare.col.diff')}</span><span role="columnheader">{t('compare.periodCompare.col.pct')}</span>
        </div>
        {TOTALS_ROWS.map(row => {
          const a = report.totals.A[row.id]
          const b = report.totals.B[row.id]
          const diff = report.totals.diff[row.id]
          const pct = report.totals.pct[row.id]
          const costTone = isCostLikeRow(row.id) ? 'cost' : ''
          return (
            <div className="pcmp-tr" role="row" key={row.id}>
              <span role="cell" className="pcmp-label">{t(row.labelKey)}</span>
              <span role="cell">{fmtTotalsValue(row.id, a)}</span>
              <span role="cell">{fmtTotalsValue(row.id, b)}</span>
              <span role="cell" className={diffClass(diff, costTone)}>{signed(row.id, diff)}</span>
              <span role="cell" className={diffClass(pct ?? 0, costTone)}>{signedPct(pct)}</span>
            </div>
          )
        })}
      </div>
      </div>
    </div>
  )
}

function NormalizedCard({ report }: { report: PeriodDiffReport }) {
  const metric = (labelKey: string, m: { a: number | null; b: number | null; diff: number | null; pct: number | null }) => (
    <div className="pcmp-tr" role="row" key={labelKey}>
      <span role="cell" className="pcmp-label">{t(labelKey)}</span>
      <span role="cell">{m.a === null ? '—' : formatUsd(m.a)}</span>
      <span role="cell">{m.b === null ? '—' : formatUsd(m.b)}</span>
      <span role="cell" className={m.diff === null ? '' : diffClass(m.diff, 'cost')}>{m.diff === null ? '—' : signedUsd(m.diff)}</span>
      <span role="cell">{signedPct(m.pct)}</span>
    </div>
  )
  return (
    <div className="cmp-card pcmp-block">
      <div className="cmp-head"><h3>{t('compare.periodCompare.normalized.title')}</h3><span className="cmp-head-note">{t('compare.periodCompare.normalized.dashNote')}</span></div>
      <div className="pbody">
      <div className="pcmp-table" role="table" aria-label={t('compare.periodCompare.normalized.tableAriaLabel')}>
        <div className="pcmp-tr pcmp-th" role="row">
          <span role="columnheader">{t('compare.periodCompare.col.view')}</span><span role="columnheader">{t('compare.periodCompare.col.a')}</span><span role="columnheader">{t('compare.periodCompare.col.b')}</span><span role="columnheader">{t('compare.periodCompare.col.diff')}</span><span role="columnheader">{t('compare.periodCompare.col.pct')}</span>
        </div>
        {metric('compare.periodCompare.normalized.costPerDay', report.normalized.perDay)}
        {metric('compare.periodCompare.normalized.costPer100Calls', report.normalized.per100Calls)}
      </div>
      <p className="pcmp-caption">
        {t('compare.periodCompare.normalized.denominatorsLabel')} {report.normalized.denominators.perDay}; {report.normalized.denominators.per100Calls}.
      </p>
      </div>
    </div>
  )
}

function MoversCard({
  report,
  lens,
  view,
  onLens,
  onView,
  drill,
  onDrill,
  onInspectContribution,
  provider,
  refreshToken,
}: {
  report: PeriodDiffReport
  lens: Lens
  view: View
  onLens: (lens: Lens) => void
  onView: (view: View) => void
  drill: { dimension: 'project' | 'model'; key: string } | null
  onDrill: (drill: { dimension: 'project' | 'model'; key: string } | null) => void
  onInspectContribution?: (range: DateRange, dimension: 'project' | 'model', key: string) => void
  provider: string
  refreshToken: number
}) {
  const [showAll, setShowAll] = useState(false)
  const ranked = (lens === 'projects' ? report.projects : report.models)
    .map(row => ({ row, norm: normalizeRow(row, view, report.rangeA.days, report.rangeB.days) }))
    .sort((x, y) => Math.abs(y.norm.diff ?? 0) - Math.abs(x.norm.diff ?? 0))
  const shown = showAll ? ranked : ranked.slice(0, 5)
  const dimension = lens === 'projects' ? 'project' : 'model'
  const unit = view === 'perDay' ? t('compare.periodCompare.movers.perDayUnit') : view === 'per100Calls' ? t('compare.periodCompare.movers.per100CallsUnit') : ''
  return (
    <div className="panel cmp-card">
      <div className="cmp-head">
        <h3>{t('compare.periodCompare.movers.title')}</h3>
        <span className="cmp-head-note">{t(view === 'raw' ? 'compare.periodCompare.view.raw' : view === 'perDay' ? 'compare.periodCompare.view.perDay' : 'compare.periodCompare.view.per100Calls')}</span>
        <span className="pcmp-controls-row">
        <div role="group" aria-label={t('compare.periodCompare.movers.lensAriaLabel')}>
          <SegTabs
            options={[{ value: 'projects', label: t('compare.periodCompare.lens.byProject') }, { value: 'models', label: t('compare.periodCompare.lens.byModel') }]}
            value={lens}
            onChange={value => { onLens(value as Lens); onDrill(null); setShowAll(false) }}
          />
        </div>
        <div role="group" aria-label={t('compare.periodCompare.movers.viewAriaLabel')}>
          <SegTabs
            options={[{ value: 'raw', label: t('compare.periodCompare.view.raw') }, { value: 'perDay', label: t('compare.periodCompare.view.perDay') }, { value: 'per100Calls', label: t('compare.periodCompare.view.per100Calls') }]}
            value={view}
            onChange={value => { onView(value as View); setShowAll(false) }}
          />
        </div>
        {ranked.length > 5 && (
          <button type="button" className="ov-link" onClick={() => setShowAll(current => !current)} aria-expanded={showAll}>
            {showAll ? t('compare.periodCompare.movers.showTopFive') : t('compare.periodCompare.movers.showAll', { count: ranked.length })}
          </button>
        )}
        </span>
      </div>
      <div className="pbody">
      {view === 'perDay' && (
        <p className="pcmp-caption">{t('compare.periodCompare.movers.perDayCaption', { daysA: report.rangeA.days, daysB: report.rangeB.days })}</p>
      )}
      {view === 'per100Calls' && (
        <p className="pcmp-caption">{t('compare.periodCompare.movers.per100Caption')}</p>
      )}
      <div className="pcmp-table pcmp-movers" role="table" aria-label={`${lens} ${t('compare.periodCompare.movers.contributionsAriaSuffix')}`}>
        <div className="pcmp-tr pcmp-th" role="row">
          <span role="columnheader">{t(lens === 'projects' ? 'compare.periodCompare.col.project' : 'compare.periodCompare.col.model')}</span>
          <span role="columnheader">{terseRangeLabel(report.rangeA)}{unit}</span>
          <span role="columnheader">{terseRangeLabel(report.rangeB)}{unit}</span>
          <span role="columnheader">{t('compare.periodCompare.col.change')}</span>
          <span role="columnheader">{t('compare.periodCompare.col.pct')}</span>
        </div>
        {ranked.length === 0 && (
          <div className="pcmp-tr" role="row"><span role="cell"><EmptyNote>{t('compare.periodCompare.movers.noUsage')}</EmptyNote></span></div>
        )}
        {shown.map(({ row, norm }) => {
          const selected = drill?.dimension === dimension && drill.key === row.key
          return (
            <button
              type="button"
              className={`pcmp-tr pcmp-row${selected ? ' pcmp-row-on' : ''}`}
              key={`${dimension}:${row.key}`}
              onClick={() => onDrill(selected ? null : { dimension, key: row.key })}
              aria-expanded={selected}
              aria-label={t('compare.periodCompare.movers.rowAriaLabel', {
                key: row.key,
                aLabel: t('compare.periodCompare.col.a'),
                a: norm.a === null ? t('compare.periodCompare.movers.none') : formatUsd(norm.a),
                bLabel: t('compare.periodCompare.col.b'),
                b: norm.b === null ? t('compare.periodCompare.movers.none') : formatUsd(norm.b),
                status: t(STATUS_LABEL_KEY[norm.status]),
              })}
            >
              <span role="cell" className="pcmp-label pcmp-key" title={row.key}>{lens === 'projects' ? shortenProjectPath(row.key) : row.key}</span>
              <span role="cell">{norm.a === null ? '—' : formatUsd(norm.a)}</span>
              <span role="cell">{norm.b === null ? '—' : formatUsd(norm.b)}</span>
              <span role="cell" className={diffClass(norm.diff ?? 0, 'cost')}>{norm.diff === null ? '—' : signedUsd(norm.diff)}</span>
              <span role="cell">
                {norm.status === 'new' && <span className="pcmp-badge new">{t('compare.periodCompare.movers.newBadge')}</span>}
                {norm.status === 'gone' && <span className="pcmp-badge gone">{t('compare.periodCompare.movers.goneBadge')}</span>}
                {norm.status !== 'new' && norm.status !== 'gone' && signedPct(norm.pct)}
              </span>
            </button>
          )
        })}
      </div>
      {report.rangeA.days !== report.rangeB.days && (
        <p className="pcmp-caption">{t('compare.periodCompare.movers.differentLengthsCaption')}</p>
      )}
      {drill && (
        <DrillPanel
          rangeA={report.rangeA}
          rangeB={report.rangeB}
          provider={provider}
          refreshToken={refreshToken}
          dimension={drill.dimension}
          drillKey={drill.key}
          onInspectContribution={onInspectContribution}
          onClose={() => onDrill(null)}
        />
      )}
      <p className="pcmp-caption">{t('compare.periodCompare.movers.footerCaption')}</p>
      </div>
    </div>
  )
}

function DrillPanel({
  rangeA,
  rangeB,
  provider,
  refreshToken,
  dimension,
  drillKey,
  onInspectContribution,
  onClose,
}: {
  rangeA: PeriodRangeInfo
  rangeB: PeriodRangeInfo
  provider: string
  refreshToken: number
  dimension: 'project' | 'model'
  drillKey: string
  onInspectContribution?: (range: DateRange, dimension: 'project' | 'model', key: string) => void
  onClose: () => void
}) {
  const report = usePolled<PeriodSessionDiff>(
    () => codeburn.getPeriodCompareSessions(
      { from: rangeA.from, to: rangeA.to },
      { from: rangeB.from, to: rangeB.to },
      provider,
      dimension,
      drillKey,
    ),
    [rangeA.from, rangeA.to, rangeB.from, rangeB.to, provider, dimension, drillKey, refreshToken],
    { memoKey: reportMemoKey('periodcomparesessions-v2', 'week', provider, { from: rangeA.from, to: rangeA.to }, JSON.stringify([rangeB.from, rangeB.to, dimension, drillKey])) },
  )
  if (!report.data) {
    if (report.error) return <CliErrorPanel error={report.error} subject={t('compare.periodCompare.drill.subject')} />
    return <SectionSkeleton label={t('compare.periodCompare.drill.loading')} rows={3} />
  }
  const sessions = report.data.sessions
  return (
    <div className="pcmp-drill" aria-label={t('compare.periodCompare.drill.ariaLabel', { key: drillKey })}>
      <div className="pcmp-drill-head">
        <strong>{t(dimension === 'project' ? 'compare.periodCompare.col.project' : 'compare.periodCompare.col.model')}: {drillKey}</strong>
        <span className="pcmp-drill-actions">
          <button type="button" className="ov-link" onClick={() => onInspectContribution?.({ from: rangeA.from, to: rangeA.to }, dimension, drillKey)}>{t('compare.periodCompare.drill.openAInSessions')}</button>
          <button type="button" className="ov-link" onClick={() => onInspectContribution?.({ from: rangeB.from, to: rangeB.to }, dimension, drillKey)}>{t('compare.periodCompare.drill.openBInSessions')}</button>
          <button type="button" className="ov-link" onClick={onClose}>{t('compare.periodCompare.drill.close')}</button>
        </span>
      </div>
      <div className="pcmp-table" role="table" aria-label={t('compare.periodCompare.drill.tableAriaLabel')}>
        <div className="pcmp-tr pcmp-th" role="row">
          <span role="columnheader">{t('compare.periodCompare.col.session')}</span><span role="columnheader">{t('compare.periodCompare.col.provider')}</span><span role="columnheader">{t('compare.periodCompare.col.a')}</span><span role="columnheader">{t('compare.periodCompare.col.b')}</span><span role="columnheader">{t('compare.periodCompare.col.diff')}</span>
        </div>
        {sessions.length === 0 && (
          <div className="pcmp-tr" role="row"><span role="cell"><EmptyNote>{t('compare.periodCompare.drill.noSessions')}</EmptyNote></span></div>
        )}
        {sessions.map(session => (
          <div className="pcmp-tr" role="row" key={session.identity}>
            <span role="cell" className="pcmp-label" title={session.project}>
              {session.title ?? session.sessionId}
              <span className="pcmp-sub">{session.project}</span>
            </span>
            <span role="cell">{session.provider}</span>
            <span role="cell">{session.costA > 0 ? formatUsd(session.costA) : '—'}</span>
            <span role="cell">{session.costB > 0 ? formatUsd(session.costB) : '—'}</span>
            <span role="cell" className={diffClass(session.diff, 'cost')}>{signedUsd(session.diff)}</span>
          </div>
        ))}
      </div>
      <p className="pcmp-caption">{t('compare.periodCompare.drill.caption')}</p>
    </div>
  )
}

function dayList(days: Array<{ date: string; aggregateOnly: number }>): string {
  if (days.length === 0) return ''
  return ` (${days.map(d => `${formatDayShort(d.date)}: ${formatUsd(d.aggregateOnly)}`).join(', ')})`
}

function CoverageCard({ report }: { report: PeriodDiffReport }) {
  const unpriced = [...report.coverage.unpricedModelsA.map(m => ({ ...m, side: 'A' as const })), ...report.coverage.unpricedModelsB.map(m => ({ ...m, side: 'B' as const }))]
  const carried = report.history
  const aggregateOnly = carried ? carried.aggregateOnly.A + carried.aggregateOnly.B : 0
  return (
    <details className="panel cmp-card pcmp-fold">
      <summary>{t('compare.periodCompare.coverage.title')}{aggregateOnly > 0 && t('compare.periodCompare.coverage.noDetailSuffix', { amount: formatUsd(aggregateOnly) })}</summary>
      <div className="pbody">
      <ul className="pcmp-coverage">
        <li>{t('compare.periodCompare.coverage.shareKnownPrice', {
          a: report.coverage.pricingCoverageA === null ? t('compare.periodCompare.coverage.unknown') : `${Math.round(report.coverage.pricingCoverageA * 100)}%`,
          b: report.coverage.pricingCoverageB === null ? t('compare.periodCompare.coverage.unknown') : `${Math.round(report.coverage.pricingCoverageB * 100)}%`,
        })}</li>
        {unpriced.length > 0 && (
          <li>
            {t('compare.periodCompare.coverage.noPriceModels', {
              list: unpriced.map(m => t('compare.periodCompare.coverage.modelEntry', {
                model: m.model,
                side: m.side,
                count: plural(m.calls, t('compare.periodCompare.coverage.call'), t('compare.periodCompare.coverage.calls')),
              })).join('; '),
            })}
          </li>
        )}
        {carried && carried.days.A.length === 0 && carried.days.B.length === 0 && (
          <li>{carried.basis} {t('compare.periodCompare.coverage.everyDayHasSessions')}</li>
        )}
        {carried && (carried.days.A.length > 0 || carried.days.B.length > 0) && (
          <li>
            {t('compare.periodCompare.coverage.dailyHistoryNote', {
              aggA: formatUsd(carried.aggregateOnly.A),
              listA: dayList(carried.days.A),
              aggB: formatUsd(carried.aggregateOnly.B),
              listB: dayList(carried.days.B),
            })}
          </li>
        )}
        <li>{t('compare.periodCompare.coverage.everyDifference')}</li>
      </ul>
      </div>
    </details>
  )
}
