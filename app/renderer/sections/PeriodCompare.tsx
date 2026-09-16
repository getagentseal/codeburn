import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CliErrorPanel } from '../components/CliErrorPanel'
import { EmptyNote } from '../components/EmptyState'
import { SectionSkeleton } from '../components/Skeleton'
import { SegTabs } from '../components/SegTabs'
import { RangeCalendar } from '../components/RangeCalendar'
import { usePolled } from '../hooks/usePolled'
import { ChartTip } from '../components/ChartTip'
import { formatCompact, formatUsd, shortenProjectPath } from '../lib/format'
import { codeburn } from '../lib/ipc'
import { reportMemoKey } from '../lib/reportMemoKey'
import { trackEvent } from '../lib/track'
import type { DateRange, PeriodContribution, PeriodDiffReport, PeriodRangeInfo, PeriodSessionDiff } from '../lib/types'

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
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatDayTerse(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
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
  return range.days === 7 ? `Week of ${formatDayShort(range.from)}` : `${formatDayShort(range.from)} to ${formatDayShort(range.to)}`
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
    const sessions = sessionsDown ? 'Far fewer sessions' : 'Far more sessions'
    const calls = callsDown ? 'cheaper' : 'more expensive'
    const softener = sessionsDown === callsDown ? 'only ' : ''
    return `${sessions}, and ${calls} calls: cost per call ${callsDown ? 'fell' : 'rose'} ${softener}${wholePct(per100Pct)}.`
  }
  const calls = per100Pct === 0 ? 'the same cost per call' : callsDown ? 'cheaper calls' : 'more expensive calls'
  return `${sessionsDown ? 'Fewer' : 'More'} sessions and ${calls}.`
}

/// The whole comparison in one sentence, built only from report numbers.
export function leadSentence(report: PeriodDiffReport): string {
  const weeks = report.rangeA.days === 7 && report.rangeB.days === 7
  const subject = weeks ? `The week of ${formatDayShort(report.rangeB.from)}` : `The ${rangeLabel(report.rangeB)} range`
  const before = weeks ? 'the week before' : 'the range before'
  const costA = formatUsd(report.totals.A.cost)
  const costB = formatUsd(report.totals.B.cost)
  const pct = report.totals.pct.cost
  const head = pct === null
    ? `${subject} cost ${costB}, against ${costA} in ${before}.`
    : Math.abs(pct) < 0.5
      ? `${subject} cost the same as ${before}: ${costB} versus ${costA}.`
      : `${subject} cost ${wholePct(pct)} ${pct < 0 ? 'less' : 'more'} than ${before}: ${costB} versus ${costA}.`
  const tail = secondClause(report.totals.pct.sessions, report.normalized.per100Calls.pct)
  return tail ? `${head} ${tail}` : head
}

const STATUS_LABEL: Record<PeriodContribution['status'], string> = {
  new: 'New',
  gone: 'Gone',
  up: 'Up',
  down: 'Down',
  flat: 'Flat',
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
    <div className="pcmp" aria-label="Compare periods">
      <div className="panel cmp-card pcmp-controls">
        <div className="pcmp-controls-row">
          <SegTabs
            options={[{ value: 'last7', label: 'Last 7 vs prior 7' }, { value: 'custom', label: 'Custom' }]}
            value={preset}
            onChange={pickPreset}
          />
          <button type="button" className="pcmp-swap" onClick={swap} aria-label="Swap A and B">
            <span className="pcmp-swap-icon" aria-hidden="true">⇄</span> Swap
          </button>
        </div>
        <div className="pcmp-ranges">
          <RangeField label="A · reference" value={rangeA} onChange={setRangeA} />
          <RangeField label="B · analyzed" value={rangeB} onChange={setRangeB} />
        </div>
        <RangeMeta rangeA={rangeA} rangeB={rangeB} />
      </div>

      {!report.data
        ? report.error
          ? <CliErrorPanel error={report.error} subject="period comparison" />
          : <SectionSkeleton label="Comparing periods…" rows={5} />
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
                <summary>All metrics</summary>
                <TotalsCard report={report.data} />
                <NormalizedCard report={report.data} />
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
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="pcmp-range" ref={wrapRef}>
      <span className="pcmp-range-label">{label}</span>
      <button
        type="button"
        className="pcmp-range-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}: ${value.from} to ${value.to}`}
        onClick={() => setOpen(current => !current)}
      >
        {formatDayShort(value.from)} – {formatDayShort(value.to)}
      </button>
      {open && (
        <div className="calendar-popover" role="dialog" aria-label={`${label} date range`}>
          <RangeCalendar
            value={value}
            onSelect={range => {
              onChange(range)
              setOpen(false)
            }}
          />
        </div>
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
  return (
    <p className="pcmp-meta" role="status">
      A spans {daysA} {daysA === 1 ? 'day' : 'days'} · B spans {daysB} {daysB === 1 ? 'day' : 'days'}
      {delta !== 0 && <> · duration differs by {delta > 0 ? '+' : '−'}{Math.abs(delta)} {Math.abs(delta) === 1 ? 'day' : 'days'}</>}
      {overlap > 0 && <> · the ranges overlap on {overlap} {overlap === 1 ? 'day' : 'days'}, which count in both sides</>}
      {' '}· all differences are B − A
    </p>
  )
}

function SummaryCard({ report }: { report: PeriodDiffReport }) {
  const per100 = report.normalized.per100Calls
  // Only the two money tiles carry the cost semantics: more sessions is not a
  // bill going up, so the Sessions tile stays neutral.
  const tiles = [
    { label: 'Total cost', value: formatUsd(report.totals.B.cost), change: signedUsd(report.totals.diff.cost), tone: diffClass(report.totals.diff.cost, 'cost'), pct: report.totals.pct.cost },
    { label: 'Cost per 100 calls', value: per100.b === null ? '—' : formatUsd(per100.b), change: per100.diff === null ? '—' : signedUsd(per100.diff), tone: diffClass(per100.diff ?? 0, 'cost'), pct: per100.pct },
    { label: 'Sessions', value: report.totals.B.sessions.toLocaleString('en-US'), change: signedCount(report.totals.diff.sessions), tone: '', pct: report.totals.pct.sessions },
  ]
  return (
    <div className="panel cmp-card pcmp-summary">
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
  )
}

function DayBarsCard({ report }: { report: PeriodDiffReport }) {
  const [tip, setTip] = useState<{ index: number; x: number; y: number } | null>(null)
  const daysA = report.daily?.A ?? []
  const daysB = report.daily?.B ?? []
  const span = Math.max(daysA.length, daysB.length)
  if (span === 0) return null
  const max = Math.max(0, ...daysA.map(day => day.cost), ...daysB.map(day => day.cost))
  const height = (cost: number): string => `${max > 0 ? Math.max(2, (cost / max) * 100) : 2}%`
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
        <h3>Cost per day, both ranges side by side</h3>
        <span className="cmp-head-note pcmp-legend">
          <span><i className="pcmp-swatch-a" />{labelA}</span>
          <span><i className="pcmp-swatch-b" />{labelB}</span>
        </span>
      </div>
      <div className="pcmp-chart">
        <div className="chart pcmp-days" style={{ gap: `${span > 45 ? 3 : span > 20 ? 6 : 10}px` }} aria-label="Cost per day in both ranges">
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
        <div className="ov-xax">
          {ticks.map(index => {
            // A centred label on the appended edge tick runs past the card;
            // at that density anchoring it is invisible.
            const atEdge = span > 45 && index === span - 1
            return atEdge
              ? <span key={index} className="pcmp-xax-end" style={{ right: 0 }}>Day {index + 1}</span>
              : <span key={index} style={{ left: `${((index + 0.5) / span) * 100}%` }}>Day {index + 1}</span>
          })}
        </div>
      </div>
      <p className="pcmp-caption">Each pair is one day of A beside the same-numbered day of B.</p>
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

function TotalsCard({ report }: { report: PeriodDiffReport }) {
  const rows: Array<{ label: string; get: (t: PeriodDiffReport['totals']['A']) => number }> = [
    { label: 'API-equivalent cost', get: t => t.cost },
    { label: 'API calls', get: t => t.calls },
    { label: 'Sessions', get: t => t.sessions },
    { label: 'Input tokens', get: t => t.inputTokens },
    { label: 'Output tokens', get: t => t.outputTokens },
    { label: 'Cache read tokens', get: t => t.cacheReadTokens },
    { label: 'Cache write tokens', get: t => t.cacheWriteTokens },
    { label: 'Local-model savings', get: t => t.savingsUSD },
    { label: 'Estimated-price cost', get: t => t.estimatedCostUSD },
  ]
  const fmt = (label: string, value: number): string => {
    if (label.includes('cost') || label.includes('savings')) return formatUsd(value)
    if (label.includes('tokens')) return formatCompact(value)
    return value.toLocaleString('en-US')
  }
  // A range whose sources aged off disk is explained by the durable daily
  // history alone, which carries no session detail. That cost is real and it is
  // NOT in these totals, so say so where the totals are read — not only in the
  // Coverage card at the bottom of the page.
  const carriedA = report.history?.aggregateOnly.A ?? 0
  const carriedB = report.history?.aggregateOnly.B ?? 0
  return (
    <div className="cmp-card pcmp-block">
      <div className="cmp-head"><h3>Totals</h3><span className="cmp-head-note">B − A · API-equivalent cost is not a subscription bill</span></div>
      {(carriedA > 0 || carriedB > 0) && (
        <p className="pcmp-caption">
          Session detail only. A further {formatUsd(carriedA)} (A) and {formatUsd(carriedB)} (B) comes from daily
          history with no sessions behind it, so it is not in these totals. See what is counted, at the foot of the page.
        </p>
      )}
      <div className="pcmp-table" role="table" aria-label="Totals difference">
        <div className="pcmp-tr pcmp-th" role="row">
          <span role="columnheader">Metric</span><span role="columnheader">A</span><span role="columnheader">B</span><span role="columnheader">Diff</span><span role="columnheader">%</span>
        </div>
        {rows.map(row => {
          const a = row.get(report.totals.A)
          const b = row.get(report.totals.B)
          const diff = row.get(report.totals.diff)
          const pct = report.totals.pct[rowLabelKey(row.label)]
          return (
            <div className="pcmp-tr" role="row" key={row.label}>
              <span role="cell" className="pcmp-label">{row.label}</span>
              <span role="cell">{fmt(row.label, a)}</span>
              <span role="cell">{fmt(row.label, b)}</span>
              <span role="cell" className={diffClass(diff, row.label)}>{signed(row, diff)}</span>
              <span role="cell" className={diffClass(pct ?? 0, row.label)}>{signedPct(pct)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function signed(row: { label: string }, diff: number): string {
  if (row.label.includes('cost') || row.label.includes('savings')) return signedUsd(diff)
  if (row.label.includes('tokens')) return signedCompact(diff)
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

// The totals diff table keys its percent column by display label; map back to
// the PeriodTotalsRow keys the report uses.
const PCT_KEY_BY_LABEL: Record<string, keyof PeriodDiffReport['totals']['pct']> = {
  'API-equivalent cost': 'cost',
  'API calls': 'calls',
  'Sessions': 'sessions',
  'Input tokens': 'inputTokens',
  'Output tokens': 'outputTokens',
  'Cache read tokens': 'cacheReadTokens',
  'Cache write tokens': 'cacheWriteTokens',
  'Local-model savings': 'savingsUSD',
  'Estimated-price cost': 'estimatedCostUSD',
}

function rowLabelKey(label: string): keyof PeriodDiffReport['totals']['pct'] {
  return PCT_KEY_BY_LABEL[label] ?? 'cost'
}

function NormalizedCard({ report }: { report: PeriodDiffReport }) {
  const metric = (label: string, m: { a: number | null; b: number | null; diff: number | null; pct: number | null }) => (
    <div className="pcmp-tr" role="row" key={label}>
      <span role="cell" className="pcmp-label">{label}</span>
      <span role="cell">{m.a === null ? '—' : formatUsd(m.a)}</span>
      <span role="cell">{m.b === null ? '—' : formatUsd(m.b)}</span>
      <span role="cell" className={m.diff === null ? '' : diffClass(m.diff, 'cost')}>{m.diff === null ? '—' : signedUsd(m.diff)}</span>
      <span role="cell">{signedPct(m.pct)}</span>
    </div>
  )
  return (
    <div className="cmp-card pcmp-block">
      <div className="cmp-head"><h3>Normalized</h3><span className="cmp-head-note">A dash means the denominator is zero or unknown.</span></div>
      <div className="pcmp-table" role="table" aria-label="Normalized difference">
        <div className="pcmp-tr pcmp-th" role="row">
          <span role="columnheader">View</span><span role="columnheader">A</span><span role="columnheader">B</span><span role="columnheader">Diff</span><span role="columnheader">%</span>
        </div>
        {metric('Cost / day', report.normalized.perDay)}
        {metric('Cost / 100 calls', report.normalized.per100Calls)}
      </div>
      <p className="pcmp-caption">
        Denominators: {report.normalized.denominators.perDay}; {report.normalized.denominators.per100Calls}.
      </p>
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
  const unit = view === 'perDay' ? ' · per day' : view === 'per100Calls' ? ' · per 100 calls' : ''
  return (
    <div className="panel cmp-card">
      <div className="cmp-head">
        <h3>What changed, biggest movers</h3>
        <span className="cmp-head-note">{view === 'raw' ? 'Raw' : view === 'perDay' ? 'Per day' : 'Per 100 calls'}</span>
      </div>
      <div className="pcmp-controls-row">
        <div role="group" aria-label="Contribution lens">
          <SegTabs
            options={[{ value: 'projects', label: 'By project' }, { value: 'models', label: 'By model' }]}
            value={lens}
            onChange={value => { onLens(value as Lens); onDrill(null); setShowAll(false) }}
          />
        </div>
        <div role="group" aria-label="Normalization view">
          <SegTabs
            options={[{ value: 'raw', label: 'Raw' }, { value: 'perDay', label: 'Per day' }, { value: 'per100Calls', label: 'Per 100 calls' }]}
            value={view}
            onChange={value => { onView(value as View); setShowAll(false) }}
          />
        </div>
        {ranked.length > 5 && (
          <button type="button" className="ov-link" onClick={() => setShowAll(current => !current)} aria-expanded={showAll}>
            {showAll ? 'Show top five' : `Show all ${ranked.length}`}
          </button>
        )}
      </div>
      {view === 'perDay' && (
        <p className="pcmp-caption">Each side's cost divided by its own calendar days (A: {report.rangeA.days}, B: {report.rangeB.days}). Differences and percentages compare these daily averages. A row with no value on either side sorts last, so it can fall below the top five here.</p>
      )}
      {view === 'per100Calls' && (
        <p className="pcmp-caption">Each side's cost per 100 of its own API calls. This is efficiency, not scale. A side with no calls has no cost per call, so it shows a dash and sorts last: a row that vanished can fall below the top five here.</p>
      )}
      <div className="pcmp-table pcmp-movers" role="table" aria-label={`${lens} contributions`}>
        <div className="pcmp-tr pcmp-th" role="row">
          <span role="columnheader">{lens === 'projects' ? 'Project' : 'Model'}</span>
          <span role="columnheader">{terseRangeLabel(report.rangeA)}{unit}</span>
          <span role="columnheader">{terseRangeLabel(report.rangeB)}{unit}</span>
          <span role="columnheader">Change</span>
          <span role="columnheader">%</span>
        </div>
        {ranked.length === 0 && (
          <div className="pcmp-tr" role="row"><span role="cell"><EmptyNote>No usage in either range.</EmptyNote></span></div>
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
              aria-label={`${row.key}: A ${norm.a === null ? 'none' : formatUsd(norm.a)}, B ${norm.b === null ? 'none' : formatUsd(norm.b)}, ${STATUS_LABEL[norm.status]}`}
            >
              <span role="cell" className="pcmp-label pcmp-key" title={row.key}>{lens === 'projects' ? shortenProjectPath(row.key) : row.key}</span>
              <span role="cell">{norm.a === null ? '—' : formatUsd(norm.a)}</span>
              <span role="cell">{norm.b === null ? '—' : formatUsd(norm.b)}</span>
              <span role="cell" className={diffClass(norm.diff ?? 0, 'cost')}>{norm.diff === null ? '—' : signedUsd(norm.diff)}</span>
              <span role="cell">
                {norm.status === 'new' && <span className="pcmp-badge new">new this period</span>}
                {norm.status === 'gone' && <span className="pcmp-badge gone">not used this period</span>}
                {norm.status !== 'new' && norm.status !== 'gone' && signedPct(norm.pct)}
              </span>
            </button>
          )
        })}
      </div>
      {report.rangeA.days !== report.rangeB.days && (
        <p className="pcmp-caption">The ranges are different lengths, so per-day rows compare daily averages, not totals.</p>
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
      <p className="pcmp-caption">Click a row to see its sessions. Projects and models split the same difference two ways. Do not add them together.</p>
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
    if (report.error) return <CliErrorPanel error={report.error} subject="contribution sessions" />
    return <SectionSkeleton label="Loading sessions…" rows={3} />
  }
  const sessions = report.data.sessions
  return (
    <div className="pcmp-drill" aria-label={`Sessions behind ${drillKey}`}>
      <div className="pcmp-drill-head">
        <strong>{dimension === 'project' ? 'Project' : 'Model'}: {drillKey}</strong>
        <span className="pcmp-drill-actions">
          <button type="button" className="ov-link" onClick={() => onInspectContribution?.({ from: rangeA.from, to: rangeA.to }, dimension, drillKey)}>Open A in Sessions →</button>
          <button type="button" className="ov-link" onClick={() => onInspectContribution?.({ from: rangeB.from, to: rangeB.to }, dimension, drillKey)}>Open B in Sessions →</button>
          <button type="button" className="ov-link" onClick={onClose}>Close</button>
        </span>
      </div>
      <div className="pcmp-table" role="table" aria-label="Session costs in A and B">
        <div className="pcmp-tr pcmp-th" role="row">
          <span role="columnheader">Session</span><span role="columnheader">Provider</span><span role="columnheader">A</span><span role="columnheader">B</span><span role="columnheader">Diff</span>
        </div>
        {sessions.length === 0 && (
          <div className="pcmp-tr" role="row"><span role="cell"><EmptyNote>No sessions behind this contribution in either range.</EmptyNote></span></div>
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
      <p className="pcmp-caption">A session that runs across both ranges appears once, with its cost in each range. Every call counts in the range its own timestamp falls in.</p>
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
      <summary>What is counted{aggregateOnly > 0 && `: ${formatUsd(aggregateOnly)} has no session detail behind it`}</summary>
      <ul className="pcmp-coverage">
        <li>Share of calls with a known price. A: {report.coverage.pricingCoverageA === null ? 'unknown' : `${Math.round(report.coverage.pricingCoverageA * 100)}%`}, B: {report.coverage.pricingCoverageB === null ? 'unknown' : `${Math.round(report.coverage.pricingCoverageB * 100)}%`}.</li>
        {unpriced.length > 0 && (
          <li>
            These models have no price, so their cost is unknown, not zero:{' '}
            {unpriced.map(m => `${m.model} (${m.side}, ${plural(m.calls, 'call', 'calls')})`).join('; ')}.
          </li>
        )}
        {carried && carried.days.A.length === 0 && carried.days.B.length === 0 && (
          <li>{carried.basis} Every day in both ranges has sessions behind it.</li>
        )}
        {carried && (carried.days.A.length > 0 || carried.days.B.length > 0) && (
          <li>
            Daily history with no sessions behind it. A: {formatUsd(carried.aggregateOnly.A)}{dayList(carried.days.A)}, B: {formatUsd(carried.aggregateOnly.B)}{dayList(carried.days.B)}. This cost is reported here only, never in the totals above.
          </li>
        )}
        <li>Every difference is B − A over all usage in each range. Nothing is sampled, guessed or written by a model.</li>
      </ul>
    </details>
  )
}
