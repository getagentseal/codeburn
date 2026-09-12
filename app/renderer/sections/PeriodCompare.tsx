import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CliErrorPanel } from '../components/CliErrorPanel'
import { EmptyNote } from '../components/EmptyState'
import { SectionSkeleton } from '../components/Skeleton'
import { SegTabs } from '../components/SegTabs'
import { SwitchingBanner } from '../components/SwitchingBanner'
import { RangeCalendar } from '../components/RangeCalendar'
import { usePolled } from '../hooks/usePolled'
import { formatCompact, formatUsd } from '../lib/format'
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

function signedUsd(value: number): string {
  const body = formatUsd(Math.abs(value))
  if (value > 0) return `+${body}`
  if (value < 0) return `−${body}`
  return body
}

function signedPct(value: number | null): string {
  if (value === null) return '—'
  const body = `${Math.abs(value) >= 100 ? Math.round(Math.abs(value)) : Math.abs(value).toFixed(1)}%`
  return value > 0 ? `+${body}` : value < 0 ? `−${body}` : '0%'
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
  onInspectRange,
}: {
  provider: string
  refreshToken?: number
  ready?: boolean
  /** Navigation adapter (until the goal-8 navigation lands): open the existing
   *  Sessions section scoped to one of the compared ranges. */
  onInspectRange?: (range: DateRange) => void
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
      {report.switching && <SwitchingBanner />}
      <div className="panel cmp-card pcmp-controls">
        <div className="pcmp-controls-row">
          <SegTabs
            options={[{ value: 'last7', label: 'Last 7 vs prior 7' }, { value: 'custom', label: 'Custom' }]}
            value={preset}
            onChange={pickPreset}
          />
          <button type="button" className="pcmp-swap" onClick={swap} aria-label="Swap A and B">⇄ Swap</button>
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
              <TotalsCard report={report.data} />
              <NormalizedCard report={report.data} />
              <LensCard
                report={report.data}
                lens={lens}
                view={view}
                onLens={setLens}
                onView={setView}
                drill={drill}
                onDrill={setDrill}
                onInspectRange={onInspectRange}
                provider={provider}
                refreshToken={refreshToken}
              />
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
      {delta !== 0 && <> · duration differs by {delta > 0 ? '+' : ''}{delta} {Math.abs(delta) === 1 ? 'day' : 'days'}</>}
      {overlap > 0 && <> · the ranges overlap on {overlap} {overlap === 1 ? 'day' : 'days'} — overlapping days count in BOTH sides</>}
      · all differences are B − A
    </p>
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
  return (
    <div className="panel cmp-card">
      <div className="cmp-head"><h3>Totals</h3><span className="cmp-head-note">B − A · API-equivalent cost is not a subscription bill</span></div>
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
  const body = Math.abs(diff).toLocaleString('en-US')
  return diff > 0 ? `+${body}` : diff < 0 ? `−${body}` : body
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
    <div className="panel cmp-card">
      <div className="cmp-head"><h3>Normalized</h3><span className="cmp-head-note">— means the denominator is zero or unknown, not zero</span></div>
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

function LensCard({
  report,
  lens,
  view,
  onLens,
  onView,
  drill,
  onDrill,
  onInspectRange,
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
  onInspectRange?: (range: DateRange) => void
  provider: string
  refreshToken: number
}) {
  const rows = lens === 'projects' ? report.projects : report.models
  return (
    <div className="panel cmp-card">
      <div className="cmp-head">
        <h3>{lens === 'projects' ? 'Contributions by project' : 'Contributions by model'}</h3>
        <span className="cmp-head-note">{view === 'raw' ? 'Raw' : view === 'perDay' ? 'Per day' : 'Per 100 calls'}</span>
      </div>
      <div className="pcmp-controls-row">
        <div role="group" aria-label="Contribution lens">
          <SegTabs
            options={[{ value: 'projects', label: 'Projects' }, { value: 'models', label: 'Models' }]}
            value={lens}
            onChange={value => { onLens(value as Lens); onDrill(null) }}
          />
        </div>
        <div role="group" aria-label="Normalization view">
          <SegTabs
            options={[{ value: 'raw', label: 'Raw' }, { value: 'perDay', label: 'Per day' }, { value: 'per100Calls', label: 'Per 100 calls' }]}
            value={view}
            onChange={value => onView(value as View)}
          />
        </div>
      </div>
      {view === 'perDay' && (
        <p className="pcmp-caption">Each side's cost divided by its own calendar days (A: {report.rangeA.days}, B: {report.rangeB.days}) — differences and percentages compare these daily averages.</p>
      )}
      {view === 'per100Calls' && (
        <p className="pcmp-caption">Each side's cost per 100 of its OWN API calls — efficiency, not scale. A side with zero calls has no cost per call: shown as —.</p>
      )}
      <div className="pcmp-table" role="table" aria-label={`${lens} contributions`}>
        <div className="pcmp-tr pcmp-th" role="row">
          <span role="columnheader">{lens === 'projects' ? 'Project' : 'Model'}</span><span role="columnheader">A</span><span role="columnheader">B</span><span role="columnheader">Diff</span><span role="columnheader">%</span>
        </div>
        {rows.length === 0 && (
          <div className="pcmp-tr" role="row"><span role="cell"><EmptyNote>No usage in either range.</EmptyNote></span></div>
        )}
        {rows.map(row => {
          const norm = normalizeRow(row, view, report.rangeA.days, report.rangeB.days)
          const dimension = lens === 'projects' ? 'project' : 'model'
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
              <span role="cell" className="pcmp-label pcmp-key" title={row.key}>{row.key}</span>
              <span role="cell">{norm.a === null ? '—' : formatUsd(norm.a)}</span>
              <span role="cell">{norm.b === null ? '—' : formatUsd(norm.b)}</span>
              <span role="cell" className={diffClass(norm.diff ?? 0, 'cost')}>{norm.diff === null ? '—' : signedUsd(norm.diff)}</span>
              <span role="cell">
                {norm.status === 'new' && <span className="pcmp-badge new">New</span>}
                {norm.status === 'gone' && <><span className="pcmp-badge gone">Gone</span> {signedPct(norm.pct)}</>}
                {norm.status !== 'new' && norm.status !== 'gone' && signedPct(norm.pct)}
              </span>
            </button>
          )
        })}
      </div>
      {report.rangeA.days !== report.rangeB.days && (
        <p className="pcmp-caption">Different range lengths — per-day rows compare daily averages, not totals.</p>
      )}
      {drill && (
        <DrillPanel
          rangeA={report.rangeA}
          rangeB={report.rangeB}
          provider={provider}
          refreshToken={refreshToken}
          dimension={drill.dimension}
          drillKey={drill.key}
          onInspectRange={onInspectRange}
          onClose={() => onDrill(null)}
        />
      )}
      <p className="pcmp-caption">Click a row to inspect the sessions behind it. The project and model lenses describe the SAME global difference from two perspectives — never add them together.</p>
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
  onInspectRange,
  onClose,
}: {
  rangeA: PeriodRangeInfo
  rangeB: PeriodRangeInfo
  provider: string
  refreshToken: number
  dimension: 'project' | 'model'
  drillKey: string
  onInspectRange?: (range: DateRange) => void
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
          <button type="button" className="ov-link" onClick={() => onInspectRange?.({ from: rangeA.from, to: rangeA.to })}>Open A in Sessions →</button>
          <button type="button" className="ov-link" onClick={() => onInspectRange?.({ from: rangeB.from, to: rangeB.to })}>Open B in Sessions →</button>
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
      <p className="pcmp-caption">A session active on both sides of the boundary appears once with its in-range cost on each side — attribution follows each call's own timestamp.</p>
    </div>
  )
}

function CoverageCard({ report }: { report: PeriodDiffReport }) {
  const unpriced = [...report.coverage.unpricedModelsA.map(m => ({ ...m, side: 'A' as const })), ...report.coverage.unpricedModelsB.map(m => ({ ...m, side: 'B' as const }))]
  const carried = report.history
  const aggregateOnly = carried ? carried.aggregateOnly.A + carried.aggregateOnly.B : 0
  return (
    <div className="panel cmp-card">
      <div className="cmp-head"><h3>Coverage &amp; basis</h3></div>
      <ul className="pcmp-coverage">
        <li>Pricing coverage — A: {report.coverage.pricingCoverageA === null ? 'unknown' : `${Math.round(report.coverage.pricingCoverageA * 100)}%`}, B: {report.coverage.pricingCoverageB === null ? 'unknown' : `${Math.round(report.coverage.pricingCoverageB * 100)}%`}.</li>
        {unpriced.length > 0 && (
          <li>
            Missing pricing (unknown, not zero):{' '}
            {unpriced.map(m => `${m.model} (${m.side}, ${m.calls.toLocaleString('en-US')} calls)`).join('; ')}.
          </li>
        )}
        {carried && carried.days.A.length === 0 && carried.days.B.length === 0 && (
          <li>{carried.basis} No aggregate-only days in either range.</li>
        )}
        {carried && (carried.days.A.length > 0 || carried.days.B.length > 0) && (
          <li>
            Aggregate history without session detail — A: {formatUsd(carried.aggregateOnly.A)} ({carried.days.A.map(d => `${d.date}: ${formatUsd(d.aggregateOnly)}`).join(', ')}),{' '}
            B: {formatUsd(carried.aggregateOnly.B)} ({carried.days.B.map(d => `${d.date}: ${formatUsd(d.aggregateOnly)}`).join(', ')}). This cost survives only as daily history; it is reported separately and is NOT in the totals or the lenses.
          </li>
        )}
        <li>All differences are deterministic calculations (B − A) over the full population of each range — no sampled top-N, no generated explanation.</li>
      </ul>
    </div>
  )
}
