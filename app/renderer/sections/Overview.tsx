import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import gsap from 'gsap'

import { CliErrorPanel } from '../components/CliErrorPanel'
import { ActivityHeatmap } from '../components/ActivityHeatmap'
import { EmptyNote } from '../components/EmptyState'
import { ListRow } from '../components/ListRow'
import { SectionSkeleton } from '../components/Skeleton'
import { StaleBanner } from '../components/StaleBanner'
import { motionEnabled, useBarGrowIn } from '../lib/motion'
import { type Polled, usePolled } from '../hooks/usePolled'
import { formatCompact, formatUsd } from '../lib/format'
import { codeburn } from '../lib/ipc'
import { contiguousDailyWindow, formatChartDate, localDateKey, sliceDailyToPeriod, sliceDailyToRange } from '../lib/period'
import type {
  ActReportJson,
  DailyHistoryEntry,
  DateRange,
  MenubarPayload,
  Period,
  YieldJsonReport,
} from '../lib/types'

export { localDateKey } from '../lib/period'

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

type EfficiencyGrade = 'A+' | 'A' | 'B' | 'C' | 'D' | 'F'

function efficiencyGrade(score: number): EfficiencyGrade {
  if (score >= 93) return 'A+'
  if (score >= 85) return 'A'
  if (score >= 75) return 'B'
  if (score >= 65) return 'C'
  if (score >= 55) return 'D'
  return 'F'
}

function EfficiencyScorecard({ current, bare = false }: { current: MenubarPayload['current']; bare?: boolean }) {
  const oneShot = current.oneShotRate ?? 0.6
  const cacheFrac = clamp(current.cacheHitPercent / 100, 0, 1)
  const retrySpendFraction = current.retryTax.totalUSD / Math.max(current.cost, 1e-9)
  const retryPenalty = clamp(retrySpendFraction * 4, 0, 1)
  // score = 100 * (0.45*oneShot + 0.30*cacheFrac + 0.25*(1-retryPenalty))
  // Missing one-shot data uses the specified neutral 0.6 and is disclosed below.
  const score = 100 * (0.45 * oneShot + 0.30 * cacheFrac + 0.25 * (1 - retryPenalty))
  const grade = efficiencyGrade(score)
  const gradeTone = grade === 'A+' || grade === 'A'
    ? 'grade-a'
    : grade === 'D'
      ? 'grade-d'
      : grade === 'F'
        ? 'grade-f'
        : 'grade-bc'

  return (
    <div className={`${bare ? '' : 'ov-card '}ov-efficiency`}>
      <div className="ov-efficiency-head">
        <div><div className="ov-label">Efficiency</div><div className="ov-efficiency-score">{Math.round(score)} / 100</div></div>
        <div className={`ov-grade ${gradeTone}`} aria-label={`Efficiency grade ${grade}`}>{grade}</div>
      </div>
      <div className="ov-component-list">
        <div className="ov-component-row">
          <div><span>One-shot</span><strong>{formatRate(current.oneShotRate)}</strong></div>
          <div className="ov-component-track"><span style={{ width: `${oneShot * 100}%` }} /></div>
        </div>
        <div className="ov-component-row">
          <div><span>Cache hit</span><strong>{Math.round(current.cacheHitPercent)}%</strong></div>
          <div className="ov-component-track"><span style={{ width: `${cacheFrac * 100}%` }} /></div>
        </div>
        <div className="ov-component-row">
          <div><span>Retry tax</span><strong>{formatUsd(current.retryTax.totalUSD)} · {(retrySpendFraction * 100).toFixed(1)}% of spend</strong></div>
          <div className="ov-component-track adverse"><span style={{ width: `${retryPenalty * 100}%` }} /></div>
        </div>
      </div>
      <p className="ov-widget-caption">Composite of one-shot, cache hit, and retry tax.{current.oneShotRate === null ? ' Partial grade: one-shot is unavailable.' : ''}</p>
    </div>
  )
}

function CostPerOutcome({ outcome }: { outcome: Polled<YieldJsonReport> }) {
  const report = outcome.data
  let body: React.ReactNode

  if (!report) {
    body = <EmptyNote>{outcome.error ? 'Yield data is unavailable for this period.' : 'Correlating sessions with git…'}</EmptyNote>
  } else if (report.summary.total.sessions === 0 && report.details.length === 0) {
    body = <EmptyNote>No git-correlated outcomes in this period.</EmptyNote>
  } else {
    const commits = report.details.reduce((sum, detail) => sum + detail.commitCount, 0)
    const costPerCommit = commits > 0 ? report.summary.total.costUSD / commits : null
    const productive = report.summary.productive
    const costPerProductiveSession = productive.sessions > 0 ? productive.costUSD / productive.sessions : null
    body = (
      <>
        <div className="ov-outcome-metrics">
          <div><span>$ / commit</span><strong>{costPerCommit === null ? '—' : formatUsd(costPerCommit)}</strong></div>
          <div><span>$ / productive session</span><strong>{costPerProductiveSession === null ? '—' : formatUsd(costPerProductiveSession)}</strong></div>
        </div>
        <div className="ov-outcome-split">
          productive {Math.round(productive.costPercent)}% · reverted {Math.round(report.summary.reverted.costPercent)}% · abandoned {Math.round(report.summary.abandoned.costPercent)}%
        </div>
      </>
    )
  }

  return (
    <div className="ov-card ov-panel">
      <div className="ov-panel-head"><h3>Cost per outcome</h3><span className="r">Yield</span></div>
      <div className="ov-panel-body">
        {body}
        <p className="ov-widget-caption">Git-correlated. Reverted/abandoned = spend that didn't ship.</p>
      </div>
    </div>
  )
}

export type Signal = { text: string; trailing?: string }
export type SignalGroups = { wins: Signal[]; improvements: Signal[]; risks: Signal[] }

/**
 * Client-side port of the menubar's FindingsSection rule set
 * (mac/Sources/CodeBurnMenubar/Views/FindingsSection.swift:133-205). Thresholds
 * mirror the Swift; the desktop-only weekday-spike anomaly is absorbed as a risk.
 * Week-over-week and month-projection rules are suppressed for a custom range.
 */
export function deriveSignals(data: MenubarPayload, now: Date, rangeActive: boolean): SignalGroups {
  const daily = data.history.daily
  const current = data.current
  const wins: Signal[] = []
  const improvements: Signal[] = []
  const risks: Signal[] = []

  const streak = streakDays(daily, now)

  // Week-over-week: mean of the last 7 active entries vs the prior 7 (matches the
  // coach's pacing line). Needs >= 14 entries for both windows to exist.
  let weekDelta: number | null = null
  if (daily.length >= 14) {
    const recent14 = daily.slice(-14)
    const weekNow = mean(recent14.slice(-7).map(day => day.cost))
    const weekPrior = mean(recent14.slice(0, 7).map(day => day.cost))
    if (weekPrior > 0) weekDelta = (weekNow - weekPrior) / weekPrior * 100
  }

  // Month projection vs previous calendar month's total.
  const todayKey = localDateKey(now)
  const monthPrefix = todayKey.slice(0, 7)
  const mtd = daily.filter(day => day.date.startsWith(monthPrefix)).reduce((sum, day) => sum + day.cost, 0)
  const medianDaily = median(daily.slice(-7).map(day => day.cost))
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const projectedMonth = mtd + medianDaily * Math.max(0, daysInMonth - now.getDate())
  const prevPrefix = localDateKey(new Date(now.getFullYear(), now.getMonth() - 1, 1)).slice(0, 7)
  const prevMonthTotal = daily.filter(day => day.date.startsWith(prevPrefix)).reduce((sum, day) => sum + day.cost, 0)

  // Weekday spike: today vs the mean of prior same-weekday entries.
  const today = daily.find(day => day.date === todayKey)
  const sameWeekdayCosts = daily
    .filter(day => {
      if (day.date === todayKey) return false
      const [year, month, date] = day.date.split('-').map(Number)
      return new Date(year, month - 1, date).getDay() === now.getDay()
    })
    .map(day => day.cost)
  const typicalWeekday = mean(sameWeekdayCosts)

  // ————— Wins —————
  if (current.cacheHitPercent >= 80) {
    wins.push({ text: `Cache hit at ${Math.round(current.cacheHitPercent)}%, most prompts reuse cache` })
  }
  if (current.oneShotRate !== null && current.oneShotRate >= 0.75) {
    wins.push({ text: `${Math.round(current.oneShotRate * 100)}% one-shot, edits land first try` })
  }
  if (!rangeActive && weekDelta !== null && weekDelta < -10) {
    wins.push({ text: `Spend down ${Math.round(Math.abs(weekDelta))}% vs last 7 days` })
  }
  if (streak >= 5) {
    wins.push({ text: `${streak}-day usage streak` })
  }
  if (current.localModelSavings.totalUSD > 0) {
    wins.push({ text: `${formatUsd(current.localModelSavings.totalUSD)} saved via local models` })
  }

  // ————— Improvements —————
  for (const finding of data.optimize.topFindings.slice(0, 3)) {
    improvements.push({ text: finding.title, trailing: formatUsd(finding.savingsUSD) })
  }
  if (current.cacheHitPercent > 0 && current.cacheHitPercent < 50) {
    improvements.push({ text: `Cache hit only ${Math.round(current.cacheHitPercent)}%, paying for cold prompts` })
  }
  if (current.oneShotRate !== null && current.oneShotRate < 0.5) {
    improvements.push({ text: `${Math.round(current.oneShotRate * 100)}% one-shot, lots of iteration` })
  }
  // Retry-tax share is not a menubar rule; the threshold is the point where the
  // efficiency scorecard's retry penalty saturates (retrySpendFraction * 4 == 1).
  const retryShare = current.retryTax.totalUSD / Math.max(current.cost, 1e-9)
  if (retryShare >= 0.25) {
    improvements.push({ text: `Retry tax is ${Math.round(retryShare * 100)}% of spend` })
  }

  // ————— Risks —————
  if (today && typicalWeekday > 0 && today.cost > typicalWeekday * 1.8) {
    const ratio = today.cost / typicalWeekday
    const weekday = now.toLocaleString('en-US', { weekday: 'long' })
    risks.push({ text: `Today's spend is ${ratio.toFixed(1).replace(/\.0$/, '')}× your typical ${weekday}` })
  }
  if (!rangeActive && weekDelta !== null && weekDelta > 25) {
    risks.push({ text: `Spend up ${Math.round(weekDelta)}% vs prior 7 days` })
  }
  if (!rangeActive && prevMonthTotal > 0 && projectedMonth > prevMonthTotal * 1.3) {
    const overPct = Math.round((projectedMonth - prevMonthTotal) / prevMonthTotal * 100)
    risks.push({ text: `On pace for ${formatUsd(projectedMonth)} this month, +${overPct}% vs last` })
  }

  return { wins: wins.slice(0, 3), improvements: improvements.slice(0, 3), risks: risks.slice(0, 3) }
}

const SIGNAL_GROUPS = [
  {
    key: 'wins' as const,
    label: 'Wins',
    icon: <><circle cx="12" cy="12" r="9" /><polyline points="8 12 11 15 16 9" /></>,
  },
  {
    key: 'improvements' as const,
    label: 'Improvements',
    icon: <><polyline points="7 17 17 7" /><polyline points="9 7 17 7 17 15" /></>,
  },
  {
    key: 'risks' as const,
    label: 'Risks',
    icon: <><path d="M12 4 21 19 3 19Z" /><line x1="12" y1="10" x2="12" y2="14" /><line x1="12" y1="16.5" x2="12" y2="16.6" /></>,
  },
]

function SignalsCard({ signals }: { signals: SignalGroups }) {
  const groups = SIGNAL_GROUPS.filter(group => signals[group.key].length > 0)
  if (!groups.length) return null
  return (
    <div className="ov-card ov-signals" aria-label="Coaching signals">
      {groups.map(group => (
        <div className={`ov-signal-group ${group.key}`} key={group.key}>
          <div className="ov-signal-head">
            <svg viewBox="0 0 24 24" aria-hidden="true">{group.icon}</svg>
            <span>{group.label}</span>
          </div>
          <ul className="ov-signal-list">
            {signals[group.key].map((signal, index) => (
              <li className="ov-signal" key={`${signal.text}-${index}`}>
                <span title={signal.text}>{signal.text}</span>
                {signal.trailing && <span className="ov-signal-trailing">{signal.trailing}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

function RoutingWhatIf({ routing, onNavigate }: {
  routing: MenubarPayload['current']['routingWaste']
  onNavigate?: (section: 'optimize') => void
}) {
  if (routing.totalSavingsUSD <= 0 || !routing.baselineModel) return null
  return (
    <div className="ov-card ov-routing">
      <div><span className="ov-label">Routing what-if</span><p>Routing to <strong>{routing.baselineModel}</strong> could save ~<strong>{formatUsd(routing.totalSavingsUSD)}</strong> this period.</p></div>
      <button className="ov-link" type="button" onClick={() => onNavigate?.('optimize')}>Optimize →</button>
    </div>
  )
}

function deriveStats(data: MenubarPayload, now: Date) {
  const daily = data.history.daily
  const todayKey = localDateKey(now)
  const todayEntry = daily.find(day => day.date === todayKey)
  const monthPrefix = todayKey.slice(0, 7)
  const mtdEntries = daily.filter(day => day.date.startsWith(monthPrefix))
  const mtd = mtdEntries.reduce((sum, day) => sum + day.cost, 0)
  const medianDaily = median(daily.slice(-7).map(day => day.cost))
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const projected = mtd + medianDaily * Math.max(0, daysInMonth - now.getDate())
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const prevPrefix = localDateKey(prevMonth).slice(0, 7)
  const priorEntries = daily.filter(day => day.date.startsWith(prevPrefix))
  const priorAverage = mean(priorEntries.map(day => day.cost))
  const currentAverage = mean(mtdEntries.map(day => day.cost))
  const pacePct = priorAverage > 0 ? ((currentAverage - priorAverage) / priorAverage) * 100 : null

  return {
    todayEntry,
    todayCost: todayEntry?.cost ?? 0,
    mtd,
    projected,
    pacePct,
    prevMonthName: prevMonth.toLocaleString('en-US', { month: 'long' }),
  }
}

export function sessionModelKey(project: string, date: string, calls: number, cost: number): string {
  return `${project}|${date}|${calls}|${cost}`
}

function buildModelIndex(data: MenubarPayload): Map<string, string> {
  const index = new Map<string, string>()
  for (const project of data.current.topProjects) {
    for (const session of project.sessionDetails) {
      const dominant = [...session.models].sort((a, b) => b.cost - a.cost)[0]
      if (dominant) index.set(sessionModelKey(project.name, session.date, session.calls, session.cost), dominant.name)
    }
  }
  return index
}

function streakDays(daily: DailyHistoryEntry[], now: Date): number {
  const byDate = new Map(daily.map(day => [day.date, day.cost]))
  let streak = 0
  for (let offset = 0; ; offset++) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset)
    if ((byDate.get(localDateKey(date)) ?? 0) <= 0) break
    streak++
  }
  return streak
}

/**
 * Hero cost with a count-up that fires on mount and whenever the filter key
 * changes (a user action), but never on the 30s poll: a value that arrives
 * under the same `animateKey` snaps in place instead of re-animating.
 */
function CountUp({ value, animateKey }: { value: number; animateKey: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const keyRef = useRef<string | null>(null)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const keyChanged = keyRef.current !== animateKey
    keyRef.current = animateKey
    if (!keyChanged || !motionEnabled()) {
      element.textContent = formatUsd(value)
      return
    }
    const counter = { n: 0 }
    const tween = gsap.to(counter, {
      n: value,
      duration: 0.7,
      ease: 'power2.out',
      onUpdate: () => { element.textContent = formatUsd(counter.n) },
    })
    return () => { tween.kill() }
  }, [value, animateKey])

  return <div ref={ref} className="ov-hero-num" data-countup={value}>{formatUsd(value)}</div>
}

function formatShortDay(date: string): string {
  const [, month, day] = date.split('-').map(Number)
  return `${month}/${day}`
}

type AggregatedModel = {
  name: string
  cost: number
  calls: number
  // Absent in provider-filtered mode: `current.topModels` carries no per-model
  // token counts, so the table shows "—" rather than a misleading zero.
  inputTokens?: number
  outputTokens?: number
}

/** Provider-filtered source: `current.topModels` is already period/range/provider-scoped by the CLI. */
function topModelsToAggregated(models: MenubarPayload['current']['topModels']): AggregatedModel[] {
  return models
    .map(model => ({ name: model.name, cost: model.cost, calls: model.calls }))
    .sort((a, b) => b.cost - a.cost)
}

function aggregateModels(daily: DailyHistoryEntry[]): AggregatedModel[] {
  const byName = new Map<string, AggregatedModel>()
  for (const day of daily) {
    for (const model of day.topModels) {
      const row = byName.get(model.name) ?? {
        name: model.name,
        cost: 0,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
      }
      row.cost += model.cost
      row.calls += model.calls
      row.inputTokens = (row.inputTokens ?? 0) + model.inputTokens
      row.outputTokens = (row.outputTokens ?? 0) + model.outputTokens
      byName.set(model.name, row)
    }
  }
  return [...byName.values()].sort((a, b) => b.cost - a.cost)
}

function ModelsTable({ models }: { models: AggregatedModel[] }) {
  if (!models.length) return <EmptyNote>No model usage in this range yet.</EmptyNote>

  return (
    <div className="ov-model-scroll">
      <table className="ov-models" aria-label="Models this period">
        <thead>
          <tr>
            <th>Model</th>
            <th className="num">Input tok</th>
            <th className="num">Output tok</th>
            <th className="num">Cost</th>
            <th className="num">Calls</th>
          </tr>
        </thead>
        <tbody>
          {models.map(model => (
            <tr key={model.name}>
              <td className="ov-model-name">{model.name}</td>
              <td className="num mono">{model.inputTokens === undefined ? '—' : formatCompact(model.inputTokens)}</td>
              <td className="num mono">{model.outputTokens === undefined ? '—' : formatCompact(model.outputTokens)}</td>
              <td className="num mono">{formatUsd(model.cost)}</td>
              <td className="num">{model.calls.toLocaleString('en-US')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DailyChart({ daily, animateKey = '' }: { daily: DailyHistoryEntry[]; animateKey?: string }) {
  const max = Math.max(...daily.map(day => day.cost), 0)
  const peakIndex = daily.reduce((peak, day, index) => day.cost > (daily[peak]?.cost ?? -1) ? index : peak, 0)
  const peak = daily[peakIndex]
  const yesterday = daily.at(-2)
  const average = mean(daily.map(day => day.cost))
  const ticks = daily.filter((_, index) => index % 7 === 0)
  const [tip, setTip] = useState<{ day: DailyHistoryEntry; x: number; y: number } | null>(null)
  const [tipPosition, setTipPosition] = useState<{ left: number; top: number } | null>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<HTMLDivElement>(null)
  useBarGrowIn(chartRef, '.col', [animateKey])

  useLayoutEffect(() => {
    if (!tip) {
      setTipPosition(null)
      return
    }
    const width = tipRef.current?.offsetWidth ?? 220
    const height = tipRef.current?.offsetHeight ?? 62
    const gutter = 8
    const cursorGap = 12
    let left = tip.x + cursorGap
    if (left + width > window.innerWidth - gutter) left = tip.x - width - cursorGap
    left = Math.max(gutter, Math.min(left, window.innerWidth - width - gutter))
    let top = tip.y - height - cursorGap
    if (top < gutter) top = tip.y + cursorGap
    top = Math.max(gutter, Math.min(top, window.innerHeight - height - gutter))
    setTipPosition({ left, top })
  }, [tip])

  return (
    <>
      <div className="chart" ref={chartRef}>
        {daily.map((day, index) => (
          <button
            type="button"
            aria-label={`${day.date}: ${formatUsd(day.cost)}`}
            className={`col${index === peakIndex ? ' hi' : ''}`}
            key={day.date}
            style={{ height: `${max > 0 ? Math.max(2, day.cost / max * 100) : 2}%` }}
            data-date={day.date}
            data-cost={day.cost}
            data-calls={day.calls}
            data-led={day.topModels[0]?.name ?? ''}
            onMouseEnter={event => setTip({ day, x: event.clientX, y: event.clientY })}
            onMouseMove={event => setTip({ day, x: event.clientX, y: event.clientY })}
            onMouseLeave={() => setTip(null)}
          />
        ))}
      </div>
      <div className="ov-xax">
        {ticks.map(day => {
          const index = daily.indexOf(day)
          return <span key={day.date} style={{ left: `${daily.length > 1 ? index / (daily.length - 1) * 100 : 0}%` }}>{formatChartDate(day.date)}</span>
        })}
      </div>
      <div className="ov-chart-summaries" aria-label="Daily spend summary">
        <div className="ov-summary-chip"><span>Avg/day</span><strong>{formatUsd(average)}</strong></div>
        <div className="ov-summary-chip"><span>Peak</span><strong>{peak ? `${formatUsd(peak.cost)} · ${formatShortDay(peak.date)}` : '$0.00'}</strong></div>
        <div className="ov-summary-chip"><span>Yesterday</span><strong>{formatUsd(yesterday?.cost ?? 0)}</strong></div>
      </div>
      {tip && createPortal(
        <div
          ref={tipRef}
          className={`chart-tip${tipPosition ? ' on' : ''}`}
          style={{ position: 'fixed', ...(tipPosition ?? { left: 0, top: 0 }) }}
          role="tooltip"
        >
          <div className="chart-tip-d">{formatChartDate(tip.day.date)}</div>
          <div className="chart-tip-v">{formatUsd(tip.day.cost)}</div>
          <div className="chart-tip-s">{tip.day.calls} calls · {tip.day.topModels[0]?.name ?? 'No model'} led</div>
        </div>,
        document.body,
      )}
    </>
  )
}

function formatRate(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`
}

function TopActivities({ activities }: { activities: MenubarPayload['current']['topActivities'] }) {
  const rows = [...activities].sort((a, b) => b.cost - a.cost).slice(0, 6)
  if (!rows.length) return <EmptyNote>No activity in this range yet.</EmptyNote>
  const maxCost = rows[0].cost

  return (
    <div className="ov-activities">
      {rows.map(activity => (
        <div className="ov-activity" key={activity.name}>
          <div className="ov-activity-bar" aria-hidden="true">
            <span style={{ width: `${maxCost > 0 ? activity.cost / maxCost * 100 : 0}%` }} />
          </div>
          <div className="ov-activity-main">
            <span className="ov-activity-name">{activity.name}</span>
            <strong>{formatUsd(activity.cost)}</strong>
          </div>
          <div className="ov-activity-meta">
            <span>{activity.turns.toLocaleString('en-US')} turns</span>
            <span>{formatRate(activity.oneShotRate)} one-shot</span>
          </div>
        </div>
      ))}
    </div>
  )
}

export function Overview({ period, provider }: { period: Period; provider: string }) {
  const overview = usePolled<MenubarPayload>(() => codeburn.getOverview(period, provider), [period, provider])
  return <OverviewContent period={period} provider={provider} overview={overview} />
}

export function OverviewContent({
  period,
  provider = 'all',
  range = null,
  overview,
  onNavigate,
  ready = true,
}: {
  period: Period
  provider?: string
  range?: DateRange | null
  overview: Polled<MenubarPayload>
  onNavigate?: (section: 'optimize' | 'sessions') => void
  ready?: boolean
}) {
  // Gate secondary spawns on the app-level readiness (first overview resolved),
  // so the cold hydration runs once (via overview) rather than 3 parses at once
  // on boot. Defaults true so standalone renders/tests poll normally.
  const actReport = usePolled<ActReportJson>(() => codeburn.getActReport(), [], { enabled: ready, memoKey: 'overview-act' })
  const yieldReport = usePolled<YieldJsonReport>(() => codeburn.getYield(period, provider), [period, provider], { enabled: ready, memoKey: `overview-yield|${period}|${provider}` })
  const { data, error } = overview
  const modelIndex = useMemo(() => data ? buildModelIndex(data) : new Map<string, string>(), [data])

  if (!data) {
    if (error) return <CliErrorPanel error={error} subject="your usage" />
    return <SectionSkeleton label="Scanning sessions…" rows={3} chart />
  }

  const now = new Date()
  const rangeActive = !!range
  const animateKey = `${period}|${provider}|${range?.from ?? ''}|${range?.to ?? ''}`
  const stats = deriveStats(data, now)
  const periodDaily = sliceDailyToPeriod(data.history.daily, period, now)
  // Daily chart: contiguous zero-filled calendar window. A custom range spans
  // [from..to]; otherwise the trend covers at least the last 30 days, extended
  // back to the earliest active day already in the period window.
  const defaultChartStart = localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29))
  const chartDaily = rangeActive
    ? contiguousDailyWindow(data.history.daily, range.from, range.to)
    : contiguousDailyWindow(
        data.history.daily,
        periodDaily[0] && periodDaily[0].date < defaultChartStart ? periodDaily[0].date : defaultChartStart,
        localDateKey(now),
      )
  // Provider-filtered history.daily has empty topModels, so source the models
  // table from current.topModels (already period/range/provider-scoped) instead.
  const models = provider !== 'all'
    ? topModelsToAggregated(data.current.topModels)
    : aggregateModels(rangeActive ? sliceDailyToRange(data.history.daily, range.from, range.to) : periodDaily)
  const recent14 = data.history.daily.slice(-14)
  const weekNow = mean(recent14.slice(-7).map(day => day.cost))
  const weekPrior = mean(recent14.slice(-14, -7).map(day => day.cost))
  const weeklyPct = weekPrior > 0 ? Math.round(Math.abs((weekNow - weekPrior) / weekPrior * 100)) : null
  const weeklyDirection = weekNow >= weekPrior ? 'higher' : 'lower'
  const topModel = data.current.topModels[0]
  const saved = actReport.data?.totals.realizedCostUSD ?? 0
  const applied = saved > 0 ? (actReport.data?.totals.measuredActions ?? 0) : 0
  const localSaved = data.current.localModelSavings.totalUSD
  // A custom range has no meaningful "vs last week" or month-to-date baseline.
  const signals = deriveSignals(data, now, rangeActive)
  return (
    <div className="ov-dashboard">
      {error && <StaleBanner error={error} />}
      <div className="ov-card ov-hero-split" aria-label="Key performance indicators">
        <div className="ov-hero-main">
          <div className="ov-hero-top"><span className="ov-label">{data.current.label}</span><span className="ov-streak"><b>{streakDays(data.history.daily, now)}</b>-day streak</span></div>
          <CountUp value={data.current.cost} animateKey={animateKey} />
          <div className="ov-hero-sub">{data.current.calls.toLocaleString('en-US')} calls · {data.current.sessions.toLocaleString('en-US')} sessions</div>
          {saved > 0 && (
            <div className="ov-saved-line"><span>Saved by applied fixes</span><strong>{formatUsd(saved)}</strong><small>across {applied} {applied === 1 ? 'fix' : 'fixes'}</small></div>
          )}
          {localSaved > 0 && (
            <div className="ov-saved-line"><span>Saved via local models</span><strong>{formatUsd(localSaved)}</strong><small>local-model routing</small></div>
          )}
        </div>
        <ActivityHeatmap daily={data.history.daily} bare />
        <EfficiencyScorecard current={data.current} bare />
      </div>

      {!rangeActive && (
        <div className="ov-card ov-stats3">
          <div className="ov-stat"><div className="ov-label">Month to date</div><div className="v">{formatUsd(stats.mtd)}</div><div className="d">{stats.pacePct === null ? `No ${stats.prevMonthName} pace yet` : `${stats.pacePct >= 0 ? '+' : ''}${Math.round(stats.pacePct)}% vs ${stats.prevMonthName} pace`}</div></div>
          <div className="ov-stat"><div className="ov-label">Projected month</div><div className="v">{formatUsd(stats.projected)} <small>est</small></div><div className="d warn">{formatUsd(Math.max(0, stats.projected - stats.mtd))} to go</div></div>
        </div>
      )}

      <div className="ov-card ov-panel ov-chart-widget">
        <div className="ov-panel-head"><h3>Daily spend</h3><span className="r">{topModel ? `Biggest driver: ${topModel.name}` : 'No model driver yet'}</span></div>
        <div className="ov-panel-body">{data.history.daily.length ? <DailyChart daily={chartDaily} animateKey={animateKey} /> : <EmptyNote>No spend yet.</EmptyNote>}</div>
      </div>

      <div className="ov-insight-band">
        <div className="ov-coach">
          <svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="3 17 9 11 13 15 21 7"/><polyline points="15 7 21 7 21 13"/></svg>
          <div className="ov-coach-tx">
            {rangeActive
              ? <>{topModel ? <><span className="num">{topModel.name}</span> is the biggest driver in this range</> : 'No single model dominates this range'}. <span className="num">{formatUsd(data.optimize.savingsUSD)}</span> is recoverable.</>
              : <>{weeklyPct === null ? <>No prior-week pacing baseline yet</> : <>You're pacing <span className="num">{weeklyPct}% {weeklyDirection}</span> than last week</>}{topModel ? <>; <span className="num">{topModel.name}</span> is the biggest driver</> : ''}. <span className="num">{formatUsd(data.optimize.savingsUSD)}</span> is recoverable.</>}
          </div>
          <button className="ov-coach-cta" type="button" onClick={() => onNavigate?.('optimize')}>Review →</button>
        </div>
      </div>

      <SignalsCard signals={signals} />

      <div className="ov-analytics-row">
        <CostPerOutcome outcome={yieldReport} />
        <RoutingWhatIf routing={data.current.routingWaste} onNavigate={onNavigate} />
      </div>

      <div className="ov-body-grid">
        <div className="ov-main-column">
          <div className="ov-card ov-panel ov-models-widget">
            <div className="ov-panel-head"><h3>Models this period</h3><span className="r">Sorted by cost</span></div>
            <div className="ov-panel-body ov-model-panel"><ModelsTable models={models} /></div>
          </div>

          <div className="ov-card ov-panel ov-sessions-widget">
            <div className="ov-panel-head"><h3>Most expensive sessions</h3><span className="r"><button className="ov-link" type="button" onClick={() => onNavigate?.('sessions')}>See all →</button></span></div>
            <div className="ov-panel-body">
              {data.current.topSessions.length ? data.current.topSessions.map((session, index) => {
                const model = modelIndex.get(sessionModelKey(session.project, session.date, session.calls, session.cost))
                const sub = [formatChartDate(session.date), model, `${session.calls} calls`].filter(Boolean).join(' · ')
                return <ListRow key={`${session.project}-${session.date}-${index}`} no={String(index + 1).padStart(2, '0')} title={session.project} sub={sub} value={formatUsd(session.cost)} onClick={() => onNavigate?.('sessions')} />
              }) : <EmptyNote>No sessions in this range.</EmptyNote>}
            </div>
          </div>
        </div>

        <div className="ov-side-column">
          <div className="ov-card ov-panel ov-activities-widget">
            <div className="ov-panel-head"><h3>Top activities</h3><span className="r">Sorted by cost</span></div>
            <div className="ov-panel-body"><TopActivities activities={data.current.topActivities} /></div>
          </div>
        </div>
      </div>
    </div>
  )
}
