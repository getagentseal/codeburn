import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import gsap from 'gsap'

import { CliErrorPanel } from '../components/CliErrorPanel'
import { ActivityHeatmap } from '../components/ActivityHeatmap'
import { ChartTip } from '../components/ChartTip'
import { EmptyNote } from '../components/EmptyState'
import { ListRow } from '../components/ListRow'
import { SectionSkeleton } from '../components/Skeleton'
import { StaleBanner } from '../components/StaleBanner'
import { DUR, motionEnabled, useBarGrowIn } from '../lib/motion'
import { type Polled, usePolled } from '../hooks/usePolled'
import { formatCompact, formatCount, formatUsd, formatUsdWithCurrency } from '../lib/format'
import { Usd, sumTokens, tokensOf, useUsdPop } from '../components/Usd'
import { codeburn } from '../lib/ipc'
import {
  categoryFilters,
  dayFilters,
  modelFilters,
  sessionFilters,
  type InvestigationFilters,
} from '../lib/investigation'
import { contiguousDailyWindow, dataStartKey, formatChartDate, localDateKey, sliceDailyToPeriod, sliceDailyToRange } from '../lib/period'
import { reportMemoKey } from '../lib/reportMemoKey'
import { barBucketDays, barLayout, formatAxisMoney, niceTicks, ticksClearOfPeak } from '../lib/chartAxis'
import { generationHeadline, generationModels, rememberGeneration } from '../lib/generation'
import { rememberStreak } from '../lib/streak'
import { paceDirection, sparkArea, sparkPath, sparkPoints } from '../lib/spark'
import type {
  ActReportJson,
  CombinedUsage,
  DailyHistoryEntry,
  DateRange,
  MenubarPayload,
  Period,
  Scope,
  YieldJsonReport,
} from '../lib/types'
import type { OverviewHeadlineSnapshot } from '../lib/overviewSnapshot'
import { formatCombinedSessionCount, formatSessionCount, sessionCountIsExact, combinedSessionCountHelp, sessionCountHelp } from '../lib/session-count-label'
import { Icon } from '../components/icons'
import { localeTag, t } from '../i18n'

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

/** Ring gauge geometry: 96px box, 10px stroke, so the arc radius is 43. */
const GAUGE_BOX = 96
const GAUGE_STROKE = 10
const GAUGE_RADIUS = (GAUGE_BOX - GAUGE_STROKE) / 2
const GAUGE_LENGTH = 2 * Math.PI * GAUGE_RADIUS

/**
 * Sweeps the arc up from zero once, on the first mount. A later score arriving
 * under the 30s poll snaps to its new length: the ring is a reading, not a
 * replayed animation.
 */
function RingGauge({ fraction, face, children }: { fraction: number; face: ReactNode; children: ReactNode }) {
  const arcRef = useRef<SVGCircleElement>(null)
  const swept = useRef(false)
  const offset = GAUGE_LENGTH * (1 - clamp(fraction, 0, 1))

  useEffect(() => {
    const arc = arcRef.current
    if (!arc || swept.current) return
    swept.current = true
    if (!motionEnabled()) return
    const tween = gsap.fromTo(arc, { strokeDashoffset: GAUGE_LENGTH }, {
      strokeDashoffset: offset,
      duration: DUR.slow / 1000,
      ease: 'power2.out',
    })
    return () => { tween.kill() }
  }, [offset])

  return (
    <div className="ov-gauge">
      <div className="ov-gauge-ring">
        <svg viewBox={`0 0 ${GAUGE_BOX} ${GAUGE_BOX}`} aria-hidden="true">
          <circle className="ov-gauge-track" cx={GAUGE_BOX / 2} cy={GAUGE_BOX / 2} r={GAUGE_RADIUS} />
          <circle
            ref={arcRef}
            className="ov-gauge-arc"
            cx={GAUGE_BOX / 2}
            cy={GAUGE_BOX / 2}
            r={GAUGE_RADIUS}
            strokeDasharray={GAUGE_LENGTH}
            strokeDashoffset={offset}
            transform={`rotate(-90 ${GAUGE_BOX / 2} ${GAUGE_BOX / 2})`}
          />
        </svg>
        <div className="ov-gauge-face">{face}</div>
      </div>
      {children}
    </div>
  )
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
  const gradeTone = grade === 'C' ? 'grade-warn' : grade === 'D' || grade === 'F' ? 'grade-bad' : 'grade-ok'

  return (
    <div className={`${bare ? '' : 'ov-card '}ov-efficiency`}>
      <div className="ov-activity-head">
        <span className="ov-label">{t('overview.efficiency.label')}</span>
        <button
          className="ov-info"
          type="button"
          aria-label={t('overview.efficiency.howBuiltAria')}
          title={`${t('overview.efficiency.tooltip')}${current.oneShotRate === null ? ` ${t('overview.efficiency.partialGrade')}` : ''}`}
        >
          <Icon name="info" />
        </button>
      </div>
      <div className="ov-efficiency-main">
        <RingGauge
          fraction={score / 100}
          face={<>
            <strong className="ov-gauge-score">{Math.round(score)}</strong>
            <span className="ov-gauge-cap">/100</span>
          </>}
        >
          <span className={`ov-grade ${gradeTone}`} aria-label={t('overview.efficiency.gradeAria', { grade })}>{grade}</span>
        </RingGauge>
        <div className="ov-component-list">
          <div className="ov-component-row">
            <div><span>{t('overview.efficiency.oneShotLabel')}</span><strong>{formatRate(current.oneShotRate)}</strong></div>
            <div className="ov-component-track"><span style={{ width: `${oneShot * 100}%` }} /></div>
          </div>
          <div className="ov-component-row">
            <div><span>{t('overview.efficiency.cacheHitLabel')}</span><strong>{Math.round(current.cacheHitPercent)}%</strong></div>
            <div className="ov-component-track"><span style={{ width: `${cacheFrac * 100}%` }} /></div>
          </div>
          <div className="ov-component-row">
            <div><span>{t('overview.efficiency.retryTaxLabel')}</span><strong>{formatUsd(current.retryTax.totalUSD)} · {t('overview.efficiency.percentOfSpend', { percent: (retrySpendFraction * 100).toFixed(1) })}</strong></div>
            <div className="ov-component-track adverse"><span style={{ width: `${retryPenalty * 100}%` }} /></div>
          </div>
        </div>
      </div>
    </div>
  )
}

function CostPerOutcome({ outcome }: { outcome: Polled<YieldJsonReport> }) {
  const report = outcome.data
  let body: React.ReactNode

  if (!report) {
    body = <EmptyNote>{outcome.error ? t('overview.outcome.yieldUnavailable') : t('overview.outcome.correlating')}</EmptyNote>
  } else if (report.summary.total.sessions === 0 && report.details.length === 0) {
    body = <EmptyNote>{t('overview.outcome.noOutcomes')}</EmptyNote>
  } else {
    const commits = report.details.reduce((sum, detail) => sum + detail.commitCount, 0)
    const costPerCommit = commits > 0 ? report.summary.total.costUSD / commits : null
    const productive = report.summary.productive
    const costPerProductiveSession = productive.sessions > 0 ? productive.costUSD / productive.sessions : null
    body = (
      <>
        <div className="ov-outcome-metrics">
          <div><span>{t('overview.outcome.costPerCommit')}</span><strong>{costPerCommit === null ? '—' : formatUsd(costPerCommit)}</strong></div>
          <div><span>{t('overview.outcome.costPerProductiveSession')}</span><strong>{costPerProductiveSession === null ? '—' : formatUsd(costPerProductiveSession)}</strong></div>
        </div>
        <div className="ov-outcome-split">
          {t('overview.outcome.productive')} {Math.round(productive.costPercent)}% · {t('overview.outcome.reverted')} {Math.round(report.summary.reverted.costPercent)}% · {t('overview.outcome.abandoned')} {Math.round(report.summary.abandoned.costPercent)}%
        </div>
      </>
    )
  }

  return (
    <div className="ov-card ov-panel">
      <div className="ov-panel-head"><Icon name="scale" /><h3>{t('overview.outcome.title')}</h3><span className="r">{t('overview.outcome.yieldChip')}</span></div>
      <div className="ov-panel-body">
        {body}
        <p className="ov-widget-caption">{t('overview.outcome.caption')}</p>
      </div>
    </div>
  )
}

// Coaching-note thresholds, mirrored from the CLI so the card and the CLI never
// disagree (src/workflow-insights.ts buildCoachingNotes).
const WORKFLOW_CORRECTION_RATE = 0.15
const WORKFLOW_CORRECTION_COUNT = 3
const WORKFLOW_CHURN_SESSIONS = 3
const WORKFLOW_TTFE_SLOW_MS = 5 * 60 * 1000

/** Median time to first edit: `<60s → Ns`, else `Nm` (src/workflow-insights.ts formatDurationShort). */
function formatWorkflowDuration(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 1000)}s`
}

type WorkflowRollup = NonNullable<MenubarPayload['current']['workflow']>
type ReworkedFile = { path: string; sessions: number; edits: number }

/**
 * One coaching line derived with the CLI's thresholds and dry copy voice
 * (src/workflow-insights.ts buildCoachingNotes): corrections, then file churn,
 * then time-to-first-edit; the first that fires. Null when none clears its bar.
 */
function workflowCoachingNote(workflow: WorkflowRollup, topReworked?: ReworkedFile): string | null {
  const { correctionRate, corrections, medianTimeToFirstEditMs } = workflow
  if (correctionRate !== null && correctionRate >= WORKFLOW_CORRECTION_RATE && corrections >= WORKFLOW_CORRECTION_COUNT) {
    return t('overview.workflow.correctionNote', { percent: Math.round(correctionRate * 100), times: formatCount(corrections, 'time') })
  }
  if (topReworked && topReworked.sessions >= WORKFLOW_CHURN_SESSIONS) {
    return t('overview.workflow.reworkNote', { path: topReworked.path, sessions: formatCount(topReworked.sessions, 'session'), edits: formatCount(topReworked.edits, 'edit') })
  }
  if (medianTimeToFirstEditMs !== null && medianTimeToFirstEditMs >= WORKFLOW_TTFE_SLOW_MS) {
    return t('overview.workflow.ttfeNote', { duration: formatWorkflowDuration(medianTimeToFirstEditMs) })
  }
  return null
}

function WorkflowCard({ current }: { current: MenubarPayload['current'] }) {
  const workflow = current.workflow
  const topReworked = current.topReworkedFiles?.[0]
  // Hide when there is no real signal: never show a card of zeros.
  const hasSignal = !!workflow && (
    workflow.correctionRate !== null ||
    workflow.medianTimeToFirstEditMs !== null ||
    workflow.corrections > 0 ||
    !!topReworked
  )
  if (!workflow || !hasSignal) return null

  const coverage = current.pricingCoverage
  const showCoverage = typeof coverage === 'number' && coverage < 1
  const note = workflowCoachingNote(workflow, topReworked)
  const { correctionRate, corrections, medianTimeToFirstEditMs } = workflow

  return (
    <div className="ov-card ov-panel ov-workflow-widget">
      <div className="ov-panel-head">
        <Icon name="sliders-horizontal" />
        <h3>{t('overview.workflow.title')}</h3>
        {showCoverage && <span className="ov-priced-chip">{t('overview.workflow.pricedChip', { percent: Math.min(99, Math.round(coverage * 100)) })}</span>}
      </div>
      <div className="ov-panel-body">
        <div className="ov-outcome-metrics">
          <div>
            <span>{t('overview.workflow.correctionRateLabel')}</span>
            <strong>{correctionRate === null ? '—' : `${Math.round(correctionRate * 100)}%`}</strong>
            {correctionRate !== null && <span>{formatCount(corrections, 'correction')}</span>}
          </div>
          <div>
            <span>{t('overview.workflow.timeToFirstEditLabel')}</span>
            <strong>{medianTimeToFirstEditMs === null ? '—' : formatWorkflowDuration(medianTimeToFirstEditMs)}</strong>
            <span>{t('overview.workflow.median')}</span>
          </div>
        </div>
        {topReworked && (
          <div className="ov-workflow-rework">
            {t('overview.workflow.topRework')}<strong>{topReworked.path}</strong> · {formatCount(topReworked.sessions, 'session')} · {formatCount(topReworked.edits, 'edit')}
          </div>
        )}
        <p className="ov-widget-caption">{note ?? t('overview.workflow.defaultCaption')}</p>
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

  const streak = rememberStreak(data.streak) ?? streakDays(daily, now)

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
    wins.push({ text: t('overview.signals.win.cacheHit', { percent: Math.round(current.cacheHitPercent) }) })
  }
  if (current.oneShotRate !== null && current.oneShotRate >= 0.75) {
    wins.push({ text: t('overview.signals.win.oneShot', { percent: Math.round(current.oneShotRate * 100) }) })
  }
  if (!rangeActive && weekDelta !== null && weekDelta < -10) {
    wins.push({ text: t('overview.signals.win.spendDown', { percent: Math.round(Math.abs(weekDelta)) }) })
  }
  if (streak >= 5) {
    wins.push({ text: t('overview.signals.win.streak', { count: streak }) })
  }
  if (current.localModelSavings.totalUSD > 0) {
    wins.push({ text: t('overview.signals.win.localSavings', { amount: formatUsd(current.localModelSavings.totalUSD) }) })
  }

  // ————— Improvements —————
  for (const finding of data.optimize.topFindings.slice(0, 3)) {
    improvements.push({ text: finding.title, trailing: formatUsd(finding.savingsUSD) })
  }
  if (current.cacheHitPercent > 0 && current.cacheHitPercent < 50) {
    improvements.push({ text: t('overview.signals.improve.lowCacheHit', { percent: Math.round(current.cacheHitPercent) }) })
  }
  if (current.oneShotRate !== null && current.oneShotRate < 0.5) {
    improvements.push({ text: t('overview.signals.improve.lowOneShot', { percent: Math.round(current.oneShotRate * 100) }) })
  }
  // Retry-tax share is not a menubar rule; the threshold is the point where the
  // efficiency scorecard's retry penalty saturates (retrySpendFraction * 4 == 1).
  const retryShare = current.retryTax.totalUSD / Math.max(current.cost, 1e-9)
  if (retryShare >= 0.25) {
    improvements.push({ text: t('overview.signals.improve.retryTax', { percent: Math.round(retryShare * 100) }) })
  }

  // ————— Risks —————
  if (today && typicalWeekday > 0 && today.cost > typicalWeekday * 1.8) {
    const ratio = today.cost / typicalWeekday
    const weekday = now.toLocaleString(localeTag(), { weekday: 'long' })
    risks.push({ text: t('overview.signals.risk.spikeToday', { ratio: ratio.toFixed(1).replace(/\.0$/, ''), weekday }) })
  }
  if (!rangeActive && weekDelta !== null && weekDelta > 25) {
    risks.push({ text: t('overview.signals.risk.spendUp', { percent: Math.round(weekDelta) }) })
  }
  if (!rangeActive && prevMonthTotal > 0 && projectedMonth > prevMonthTotal * 1.3) {
    const overPct = Math.round((projectedMonth - prevMonthTotal) / prevMonthTotal * 100)
    risks.push({ text: t('overview.signals.risk.pace', { amount: formatUsd(projectedMonth), percent: overPct }) })
  }

  return { wins: wins.slice(0, 3), improvements: improvements.slice(0, 3), risks: risks.slice(0, 3) }
}

const SIGNAL_GROUPS = [
  {
    key: 'wins' as const,
    labelKey: 'overview.signals.wins',
    icon: <Icon name="circle-check" />,
  },
  {
    key: 'improvements' as const,
    labelKey: 'overview.signals.improvements',
    icon: <Icon name="trending-up" />,
  },
  {
    key: 'risks' as const,
    labelKey: 'overview.signals.risks',
    icon: <Icon name="triangle-alert" />,
  },
]

function SignalsCard({ signals }: { signals: SignalGroups }) {
  const groups = SIGNAL_GROUPS.filter(group => signals[group.key].length > 0)
  if (!groups.length) return null
  return (
    <div className="ov-card ov-signals" aria-label={t('overview.signals.aria')}>
      <div className="ov-card-inner ov-signal-grid">
        {groups.map(group => (
          <div className={`ov-signal-group ${group.key}`} key={group.key}>
            <div className="ov-signal-head">
              {group.icon}
              <span>{t(group.labelKey)}</span>
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
      <div className="ov-card-inner ov-routing-body">
        <div><span className="ov-label">{t('overview.routing.label')}</span><p>{t('overview.routing.prefix')}<strong>{routing.baselineModel}</strong>{t('overview.routing.middle')}<strong>{formatUsd(routing.totalSavingsUSD)}</strong>{t('overview.routing.suffix')}</p></div>
        <button className="ov-link" type="button" onClick={() => onNavigate?.('optimize')}>{t('overview.routing.cta')}</button>
      </div>
    </div>
  )
}

function deriveStats(data: MenubarPayload, now: Date, anchorKey = localDateKey(now)) {
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
  // Cumulative spend, one point per calendar day of the month so far, so a
  // silent day is a flat step rather than a missing column.
  // Anchored to the last day of the selected window, not to today, so a custom
  // range reports the days it actually covers.
  const [anchorYear, anchorMonth, anchorDay] = anchorKey.split('-').map(Number)
  const priorKey = localDateKey(new Date(anchorYear, anchorMonth - 1, anchorDay - 1))
  const anchorCost = daily.find(day => day.date === anchorKey)?.cost ?? 0
  const priorDayCost = daily.find(day => day.date === priorKey)?.cost ?? null
  const upToAnchor = daily.filter(day => day.date <= anchorKey)
  const sevenDayAvg = upToAnchor.length ? mean(upToAnchor.slice(-7).map(day => day.cost)) : null
  const dayOverDayPct = priorDayCost !== null && priorDayCost > 0
    ? ((anchorCost - priorDayCost) / priorDayCost) * 100
    : null
  let running = 0
  const mtdSeries = contiguousDailyWindow(daily, `${monthPrefix}-01`, todayKey).map(day => (running += day.cost))
  const remainingDays = Math.max(0, daysInMonth - now.getDate())
  const projectedTail = Array.from({ length: remainingDays }, (_, index) => mtd + (projected - mtd) * ((index + 1) / remainingDays))

  return {
    todayEntry,
    todayCost: todayEntry?.cost ?? 0,
    mtdEntries,
    priorDayEntry: daily.find(day => day.date === priorKey),
    sevenDayEntries: upToAnchor.slice(-7),
    mtd,
    projected,
    pacePct,
    mtdSeries,
    projectedTail,
    priorDayCost,
    sevenDayAvg,
    dayOverDayPct,
    prevMonthName: prevMonth.toLocaleString(localeTag(), { month: 'long' }),
  }
}

const TREND_WIDTH = 160
const TREND_HEIGHT = 64

/**
 * The card's corner curve: cumulative spend anchored to the inner surface's
 * bottom-right, filled with a soft gradient in the delta's colour, with today
 * marked and any projected tail drawn dashed.
 */
function SpendTrend({ values, tone, dashFrom }: { values: number[]; tone: 'good' | 'bad' | 'flat'; dashFrom?: number }) {
  const id = useId()
  const points = sparkPoints(values, TREND_WIDTH, TREND_HEIGHT, 6)
  if (points.length < 2) return null
  const solid = dashFrom === undefined ? points : points.slice(0, dashFrom + 1)
  const dashed = dashFrom === undefined ? [] : points.slice(dashFrom)
  const last = points.at(-1) ?? points[0]

  return (
    <div className={`ov-trend tone-${tone}`} aria-hidden="true">
      <svg viewBox={`0 0 ${TREND_WIDTH} ${TREND_HEIGHT}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
            <stop offset="70%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
          <radialGradient id={`${id}-glow`}>
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.06" />
            <stop offset="55%" stopColor="currentColor" stopOpacity="0.02" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </radialGradient>
        </defs>
        <ellipse cx={last[0]} cy={last[1]} rx={TREND_WIDTH * 0.7} ry={TREND_HEIGHT * 0.8} fill={`url(#${id}-glow)`} />
        <path d={sparkArea(solid, TREND_HEIGHT)} fill={`url(#${id}-fill)`} />
        <path className="ov-trend-line" d={sparkPath(solid)} vectorEffect="non-scaling-stroke" />
        {dashed.length > 1 && <path className="ov-trend-line dashed" d={sparkPath(dashed)} vectorEffect="non-scaling-stroke" />}
      </svg>
      <span className="ov-trend-dot" style={{ left: `${(last[0] / TREND_WIDTH) * 100}%`, top: `${(last[1] / TREND_HEIGHT) * 100}%` }} />
    </div>
  )
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
  const spent = (offset: number) =>
    (byDate.get(localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset))) ?? 0) > 0
  // A day that has not happened yet does not end a streak: before the first
  // session of the day the count runs from yesterday, so a long run of active
  // days never reads as 0.
  let streak = 0
  for (let offset = spent(0) ? 0 : 1; spent(offset); offset++) streak++
  return streak
}

/**
 * Hero cost with a count-up that fires on mount and whenever the filter key
 * changes (a user action), but never on the 30s poll: a value that arrives
 * under the same `animateKey` snaps in place instead of re-animating.
 */
function CountUp({ value, tokens, animateKey, animate = true }: { value: number; tokens?: ReturnType<typeof tokensOf>; animateKey: string; animate?: boolean }) {
  const pop = useUsdPop<HTMLDivElement>(tokens)
  const ref = pop.ref
  const keyRef = useRef<string | null>(null)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const keyChanged = keyRef.current !== animateKey
    keyRef.current = animateKey
    if (!animate || !keyChanged || !motionEnabled()) {
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
  }, [value, animateKey, animate])

  return (
    <>
      <div ref={ref} className="ov-hero-num" data-countup={value} data-countup-animation={animate ? 'enabled' : 'suppressed'} {...pop.props}>{formatUsd(value)}</div>
      {pop.pop}
    </>
  )
}

/** 0 = Sunday, from a local `YYYY-MM-DD` key. */
function dayOfWeek(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day).getDay()
}

function formatShortDay(date: string): string {
  const [, month, day] = date.split('-').map(Number)
  return `${month}/${day}`
}

type AggregatedModel = {
  name: string
  cost: number
  calls: number
  // Absent when the payload carries no count for the row (an older CLI, or a
  // row whose contributing legacy data lacked counts): the table shows "—"
  // rather than a misleading zero.
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  // No column of its own; the cost cell's token popover reads it.
  cacheWriteTokens?: number
}

/** Provider-filtered source: `current.topModels` is already period/range/provider-scoped by the CLI. */
function topModelsToAggregated(models: MenubarPayload['current']['topModels']): AggregatedModel[] {
  return models
    .map(model => ({
      name: model.name,
      cost: model.cost,
      calls: model.calls,
      ...(model.inputTokens === undefined ? {} : { inputTokens: model.inputTokens }),
      ...(model.outputTokens === undefined ? {} : { outputTokens: model.outputTokens }),
      ...(model.cacheReadTokens === undefined ? {} : { cacheReadTokens: model.cacheReadTokens }),
      ...(model.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: model.cacheWriteTokens }),
    }))
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

function ModelsTable({ models, onSelectModel }: { models: AggregatedModel[]; onSelectModel?: (name: string) => void }) {
  if (!models.length) return <EmptyNote>{t('overview.models.noUsage')}</EmptyNote>

  return (
    <div className="ov-model-scroll">
      <table className="ov-models" aria-label={t('overview.models.periodTitle')}>
        <thead>
          <tr>
            <th>{t('overview.models.model')}</th>
            <th className="num">{t('overview.models.inputTok')}</th>
            <th className="num">{t('overview.models.outputTok')}</th>
            {/* Reused input tokens: prompts the provider served from cache. */}
            <th className="num" title={t('overview.models.cacheReadTooltip')}>{t('overview.models.cacheRead')}</th>
            <th className="num">{t('overview.models.cost')}</th>
            <th className="num">{t('overview.models.calls')}</th>
          </tr>
        </thead>
        <tbody>
          {models.map(model => (
            <tr key={model.name}>
              <td className="ov-model-name">
                {onSelectModel ? (
                  <button type="button" className="ov-link" title={t('overview.models.viewSessionsFor', { name: model.name })} onClick={() => onSelectModel(model.name)}>{model.name}</button>
                ) : model.name}
              </td>
              <td className="num mono">{model.inputTokens === undefined ? '—' : formatCompact(model.inputTokens)}</td>
              <td className="num mono">{model.outputTokens === undefined ? '—' : formatCompact(model.outputTokens)}</td>
              <td className="num mono">{model.cacheReadTokens === undefined ? '—' : formatCompact(model.cacheReadTokens)}</td>
              <td className="num mono"><Usd value={model.cost} tokens={tokensOf(model)} /></td>
              <td className="num">{model.calls.toLocaleString('en-US')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The drill-through payload App passes down: a filter selection plus the
 *  (optional) session to open the drawer on at the destination. */
export type InvestigateRequest = {
  filters: InvestigationFilters
  sessionId?: string | null
}

/** A drawn column: a single day, or a bucket that also carries the first day it covers. */
type ChartDay = DailyHistoryEntry & { spanStart?: string }

/** The days a column stands for. A bucket sums a week, so naming only its last
 *  day presents a weekly figure as a daily one. */
function spanLabel(day: ChartDay, format: (date: string) => string = date => date): string {
  return day.spanStart && day.spanStart !== day.date ? t('overview.chart.dateRangeTo', { from: format(day.spanStart), to: format(day.date) }) : format(day.date)
}

/** Fold `size` consecutive days into one column, dated by the last day it covers
 *  so the axis label, the today highlight and the no-data cutoff stay truthful. */
function bucketDays(daily: DailyHistoryEntry[], size: number): ChartDay[] {
  if (size <= 1) return daily
  const buckets: ChartDay[] = []
  for (let start = 0; start < daily.length; start += size) {
    const slice = daily.slice(start, start + size)
    const lead = slice.reduce((best, day) => (day.cost > best.cost ? day : best), slice[0])
    buckets.push({
      ...slice[slice.length - 1],
      spanStart: slice[0].date,
      cost: slice.reduce((total, day) => total + day.cost, 0),
      calls: slice.reduce((total, day) => total + day.calls, 0),
      inputTokens: slice.reduce((total, day) => total + day.inputTokens, 0),
      outputTokens: slice.reduce((total, day) => total + day.outputTokens, 0),
      cacheReadTokens: slice.reduce((total, day) => total + day.cacheReadTokens, 0),
      cacheWriteTokens: slice.reduce((total, day) => total + day.cacheWriteTokens, 0),
      topModels: lead.topModels,
    })
  }
  return buckets
}

/** The token breakdown behind a bar's amount, in the chart tip's own skin. */
const TOKEN_TIP_ROWS = [
  ['overview.models.input', 'inputTokens'],
  ['overview.models.output', 'outputTokens'],
  ['overview.models.cacheRead', 'cacheReadTokens'],
  ['overview.models.cacheWrite', 'cacheWriteTokens'],
] as const

function DailyChart({ daily, dataStart = null, animateKey = '', onSelectDay, bucketed = false }: { daily: ChartDay[]; dataStart?: string | null; animateKey?: string; onSelectDay?: (date: string) => void; bucketed?: boolean }) {
  const bars = barLayout(daily.length)
  const isNoData = (day: ChartDay) => dataStart !== null && day.date < dataStart
  const max = Math.max(...daily.map(day => day.cost), 0)
  // Bars are drawn against the top tick, not the raw peak, so a bar top and a
  // gridline mean the same number.
  const valueTicks = niceTicks(max)
  const axisMax = valueTicks.at(-1) || 1
  const peakIndex = daily.reduce((peak, day, index) => day.cost > (daily[peak]?.cost ?? -1) ? index : peak, 0)
  const peak = daily[peakIndex]
  const todayKey = localDateKey(new Date())
  // Weekly labels work for 30 days, but become unreadable at 6M/Life (26-53
  // labels). Long ranges use five even intervals plus the newest day.
  const tickStride = daily.length <= 45 ? 7 : Math.ceil((daily.length - 1) / 5)
  const tickIndexes = daily.map((_, index) => index).filter(index => index % tickStride === 0)
  if (daily.length > 45 && tickIndexes.at(-1) !== daily.length - 1) tickIndexes.push(daily.length - 1)
  const ticks = tickIndexes.map(index => daily[index])
  const [tip, setTip] = useState<{ day: ChartDay; x: number; y: number } | null>(null)
  const chartRef = useRef<HTMLDivElement>(null)
  useBarGrowIn(chartRef, '.col', [animateKey])
  const columnCentre = (index: number) => ((index + 0.5) / Math.max(1, daily.length)) * 100

  return (
    <>
      <div className="chart-frame">
        <div className="chart-plot">
          <div className="chart-grid" aria-hidden="true">
            {valueTicks.map(tick => <span className="chart-gridline" key={tick} style={{ bottom: `${(tick / axisMax) * 100}%` }} />)}
            {bucketed ? null : daily.map((day, index) => (dayOfWeek(day.date) === 0 && index > 0
              ? <span className="chart-weekline" key={day.date} style={{ left: `${columnCentre(index) - (50 / Math.max(1, daily.length))}%` }} />
              : null))}
          </div>
          <div className="chart" ref={chartRef} style={{ gap: `${bars.gap}px` }}>
            {daily.map(day => {
              const noData = isNoData(day)
              // A day with recorded activity is a drill-through entry: clicking it
              // opens the sessions that were active that day (sessions started
              // earlier included, within the source's day granularity).
              const drillable = !noData && (day.cost > 0 || day.calls > 0) && onSelectDay !== undefined
              return (
                <button
                  type="button"
                  aria-label={`${spanLabel(day)}: ${noData ? t('overview.chart.noDataAria') : formatUsd(day.cost)}${drillable ? ` — ${t('overview.chart.viewSessionsAria')}` : ''}`}
                  className={`col${day.date === todayKey && !noData ? ' hi' : ''}${noData ? ' nodata' : ''}`}
                  key={day.date}
                  style={{ height: `${axisMax > 0 ? Math.max(2, (day.cost / axisMax) * 100) : 2}%`, minWidth: `${bars.minWidth}px` }}
                  data-date={day.date}
                  data-cost={day.cost}
                  data-calls={day.calls}
                  data-led={day.topModels[0]?.name ?? ''}
                  data-nodata={noData ? 'true' : 'false'}
                  onMouseEnter={event => setTip({ day, x: event.clientX, y: event.clientY })}
                  onMouseMove={event => setTip({ day, x: event.clientX, y: event.clientY })}
                  onMouseLeave={() => setTip(null)}
                  onClick={drillable ? () => onSelectDay!(day.date) : undefined}
                />
              )
            })}
          </div>
          {peak && peak.cost > 0 && (
            <span className="chart-peak-guide" aria-hidden="true" style={{ bottom: `${(peak.cost / axisMax) * 100}%`, left: `${columnCentre(peakIndex)}%` }} />
          )}
        </div>
        <div className="chart-axis" aria-hidden="true">
          {ticksClearOfPeak(valueTicks, peak && peak.cost > 0 ? peak.cost : 0, axisMax).map(tick => <span className="chart-axis-tick" key={tick} style={{ bottom: `${(tick / axisMax) * 100}%` }}>{formatAxisMoney(tick)}</span>)}
          {peak && peak.cost > 0 && (
            <span className="chart-axis-peak" style={{ bottom: `${(peak.cost / axisMax) * 100}%` }}>{formatUsd(peak.cost)}</span>
          )}
        </div>
        <div className="ov-xax">
          {ticks.map(day => {
            const index = daily.indexOf(day)
            return <span key={day.date} style={{ left: `${daily.length > 1 ? index / (daily.length - 1) * 100 : 0}%` }}>{formatChartDate(day.date)}</span>
          })}
        </div>
      </div>
      {tip && (
        <ChartTip x={tip.x} y={tip.y}>
          <div className="chart-tip-d">{spanLabel(tip.day, formatChartDate)}</div>
          {isNoData(tip.day) ? (
            <div className="chart-tip-s">{t('overview.chart.noDataRecorded')}</div>
          ) : (
            <>
              <div className="chart-tip-row">
                <i className={tip.day.date === todayKey ? 'chart-tip-sw hi' : 'chart-tip-sw'} />
                <span>{t('overview.chart.spend')}</span>
                <b>{formatUsd(tip.day.cost)}</b>
              </div>
              <div className="chart-tip-row">
                <i className="chart-tip-sw mut" />
                <span>{t('overview.chart.modelLed', { name: tip.day.topModels[0]?.name ?? t('overview.chart.noModel') })}</span>
                <b>{formatCount(tip.day.calls, 'call')}</b>
              </div>
              {TOKEN_TIP_ROWS.map(([label, key]) => (
                <div className="chart-tip-row" key={key}>
                  <i className="chart-tip-sw" />
                  <span>{t(label)}</span>
                  <b>{formatCompact(tip.day[key])}</b>
                </div>
              ))}
            </>
          )}
        </ChartTip>
      )}
    </>
  )
}

/** The card header's right slot: the menubar's three daily figures, read off the drawn window. */
function DailySummaries({ daily, anchorIsToday, bucketed = false }: { daily: DailyHistoryEntry[]; anchorIsToday: boolean; bucketed?: boolean }) {
  const peak = daily.reduce<DailyHistoryEntry | undefined>((best, day) => (best && best.cost >= day.cost ? best : day), undefined)
  const yesterday = daily.at(-2)
  const average = mean(daily.map(day => day.cost))
  return (
    <div className="ov-chart-summaries" aria-label={t('overview.chart.dailySpendSummaryAria')}>
      <div className="ov-summary-chip"><span>{bucketed ? t('overview.chart.avgPerWeek') : t('overview.chart.avgPerDay')}</span><strong><Usd value={average} tokens={sumTokens(daily, daily.length)} /></strong></div>
      <div className="ov-summary-chip"><span>{t('overview.chart.peak')}</span><strong>{peak ? <><Usd value={peak.cost} tokens={tokensOf(peak)} /> · {formatShortDay(peak.date)}</> : '$0.00'}</strong></div>
      <div className="ov-summary-chip"><span>{bucketed ? t('overview.day.previousWeek') : anchorIsToday ? t('overview.day.yesterday') : t('overview.day.previousDay')}</span><strong><Usd value={yesterday?.cost ?? 0} tokens={tokensOf(yesterday)} /></strong></div>
    </div>
  )
}

function formatRate(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`
}

function TopActivities({ activities, onSelectCategory }: { activities: MenubarPayload['current']['topActivities']; onSelectCategory?: (rawCategory: string) => void }) {
  const rows = [...activities].sort((a, b) => b.cost - a.cost).slice(0, 6)
  if (!rows.length) return <EmptyNote>{t('overview.activities.noActivity')}</EmptyNote>
  const maxCost = rows[0].cost

  return (
    <div className="ov-activities">
      {rows.map(activity => {
        // Only categories the CLI named with their raw key are drill entries:
        // an older payload's label cannot round-trip as a filter value.
        const drillable = onSelectCategory !== undefined && !!activity.rawCategory
        const select = () => onSelectCategory?.(activity.rawCategory!)
        return (
          <div
            className={drillable ? 'ov-activity ov-drill' : 'ov-activity'}
            key={activity.name}
            {...(drillable ? {
              role: 'button',
              tabIndex: 0,
              title: t('overview.activities.viewSessions', { name: activity.name }),
              onClick: select,
              onKeyDown: (event: React.KeyboardEvent) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  select()
                }
              },
            } : {})}
          >
            <div className="ov-activity-bar" aria-hidden="true">
              <span style={{ width: `${maxCost > 0 ? activity.cost / maxCost * 100 : 0}%` }} />
            </div>
            <div className="ov-activity-main">
              <span className="ov-activity-name">{activity.name}</span>
              <strong>{formatUsd(activity.cost)}</strong>
            </div>
            <div className="ov-activity-meta">
              <span>{formatCount(activity.turns, 'turn')}</span>
              <span>{formatRate(activity.oneShotRate)} {t('overview.activities.oneShotSuffix')}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function Overview({ period, provider }: { period: Period; provider: string }) {
  const overview = usePolled<MenubarPayload>(() => codeburn.getOverview(period, provider), [period, provider])
  return <OverviewContent period={period} provider={provider} overview={overview} />
}

/** Combined-scope hero footer: a per-device cost breakdown plus a reachable/
 *  total device count, mirroring the menubar's combined view. An unreachable
 *  device (powered off, off-network) shows its error in place of a cost. */
function CombinedDevices({ usage }: { usage: CombinedUsage }) {
  return (
    <div className="ov-combined-devices">
      <div className="ov-combined-head">{usage.combined.reachableCount.toLocaleString('en-US')} {t('overview.combined.of')} {formatCount(usage.combined.deviceCount, 'device')}</div>
      {usage.perDevice.map(device => (
        <div className={device.error ? 'ov-combined-row err' : 'ov-combined-row'} key={device.id}>
          <span className="ov-combined-name">{device.local ? `${device.name} · ${t('overview.combined.thisDevice')}` : device.name}</span>
          <span className="ov-combined-val">{device.error ?? formatUsd(device.cost)}</span>
        </div>
      ))}
    </div>
  )
}

export function OverviewContent({
  period,
  provider = 'all',
  range = null,
  overview,
  onNavigate,
  onInvestigate,
  ready = true,
  scope = 'local',
  headlineSnapshot = null,
}: {
  period: Period
  provider?: string
  range?: DateRange | null
  overview: Polled<MenubarPayload>
  onNavigate?: (section: 'optimize' | 'sessions' | 'spend' | 'plans') => void
  /** Drill-through entries: day bars, expensive sessions, models, categories. */
  onInvestigate?: (request: InvestigateRequest) => void
  ready?: boolean
  scope?: Scope
  headlineSnapshot?: OverviewHeadlineSnapshot | null
}) {
  const { data, error, lastSuccessAt } = overview
  const heroSelectionKey = `${period}|${provider}|${range?.from ?? ''}|${range?.to ?? ''}|${scope}`
  // Suppress only the single persisted-headline -> live-data handoff. A stored
  // headline remains available after that handoff, so testing the snapshot prop
  // directly would disable every later user-triggered period/provider animation.
  const pendingSnapshotHandoffRef = useRef<string | null>(null)
  const suppressHeroReplay = pendingSnapshotHandoffRef.current === heroSelectionKey
  useLayoutEffect(() => {
    if (!data && headlineSnapshot) {
      pendingSnapshotHandoffRef.current = heroSelectionKey
    } else if (data && pendingSnapshotHandoffRef.current === heroSelectionKey) {
      pendingSnapshotHandoffRef.current = null
    }
  }, [data, headlineSnapshot, heroSelectionKey])
  // Gate secondary spawns on the app-level readiness (first overview resolved),
  // so the cold hydration runs once (via overview) rather than 3 parses at once
  // on boot. Defaults true so standalone renders/tests poll normally.
  // A bounded Overview timeout is not permission to fan out more expensive
  // analysis. On a real heavy corpus the timeout released act/yield, and a user
  // Refresh then ran another status parse beside yield. Latch that timeout until
  // real Overview data arrives: refresh() clears the current error while its new
  // request is pending, which must not accidentally re-open the secondary gate.
  const [timeoutBlocked, setTimeoutBlocked] = useState(false)
  useEffect(() => {
    if (overview.error?.kind === 'timeout') setTimeoutBlocked(true)
    else if (overview.data != null) setTimeoutBlocked(false)
  }, [overview.data, overview.error?.kind])
  const detailsReady = ready && !timeoutBlocked && overview.error?.kind !== 'timeout'
  const actReport = usePolled<ActReportJson>(() => codeburn.getActReport(), [], { enabled: detailsReady, memoKey: 'overview-act' })
  const yieldReport = usePolled<YieldJsonReport>(() => codeburn.getYield(period, provider), [period, provider], { enabled: detailsReady, memoKey: reportMemoKey('yield', period, provider) })
  const modelIndex = useMemo(() => data ? buildModelIndex(data) : new Map<string, string>(), [data])

  if (!data) {
    if (error) return <CliErrorPanel error={error} subject={t('common.subject.usage')} />
    if (headlineSnapshot) {
      const generated = new Date(headlineSnapshot.generated)
      const captured = Number.isNaN(generated.getTime()) ? new Date(headlineSnapshot.capturedAt) : generated
      const capturedLabel = Number.isNaN(captured.getTime())
        ? t('overview.snapshot.earlier')
        : localDateKey(captured) === localDateKey(new Date())
          ? t('overview.snapshot.at', { time: captured.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) })
          : t('overview.snapshot.dateAt', { date: captured.toLocaleDateString([], { month: 'short', day: 'numeric' }), time: captured.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) })
      const headlineCost = headlineSnapshot.currency
        ? formatUsdWithCurrency(headlineSnapshot.cost, headlineSnapshot.currency)
        : formatUsd(headlineSnapshot.cost)
      return (
        <div className="ov-dashboard" aria-label={t('overview.snapshot.cachedAria')}>
          <div className="ov-card">
            <div className="ov-panel-head"><Icon name="circle-dollar-sign" /><h3>{headlineSnapshot.label}</h3><span className="r"><span className="ov-streak">{t('overview.snapshot.exact', { label: capturedLabel })}</span></span></div>
            <div className="ov-card-inner ov-hero-split snapshot-hero">
              <div className="ov-hero-main">
                <div className="ov-hero-num" data-countup={headlineSnapshot.cost}>{headlineCost}</div>
                <div className="ov-hero-sub">{formatCount(headlineSnapshot.calls, 'call')} · {t('overview.snapshot.sessionsUpdating')}</div>
              </div>
            </div>
          </div>
          <SectionSkeleton label={t('overview.snapshot.updatingDrillDowns')} rows={3} chart />
        </div>
      )
    }
    return <SectionSkeleton label={t('overview.snapshot.scanningSessions')} rows={3} chart />
  }

  const now = new Date()
  const rangeActive = !!range
  // Combined scope shows the paired-device aggregate in the hero KPIs, mirroring
  // the menubar. Only the hero totals are aggregated; the detailed panels below
  // (daily chart, models) stay local — the combined payload carries totals only.
  const combined = scope === 'combined' ? data.combined : undefined
  // One generation behind every period the user can switch to. `periodTotals`
  // is emitted only for an unscoped, unfiltered request, so its presence on THIS
  // payload is the gate: under a provider, project or config filter the machine-
  // wide generation must never stand in for the filtered headline.
  const unfiltered = !rangeActive && !combined && !!data.periodTotals
  rememberGeneration(unfiltered ? data : null, lastSuccessAt, period)
  const headline = unfiltered ? generationHeadline(period, lastSuccessAt) : null
  // The hero stands in with the generation only when the models table can stand in
  // with the same one; a generation from another period carries the wrong models,
  // so both fall back to this payload rather than disagreeing for a moment.
  const genModels = unfiltered ? generationModels(period, lastSuccessAt) : null
  const useGeneration = headline != null && genModels != null
  const heroCost = combined ? combined.combined.cost : useGeneration ? headline.cost : data.current.cost
  const heroCalls = combined ? combined.combined.calls : useGeneration ? headline.calls : data.current.calls
  const heroSessions = combined ? combined.combined.sessions : data.current.sessions
  const heroSessionLabel = combined
    ? formatCombinedSessionCount()
    : formatSessionCount(heroSessions, data.current.sessionCountBasis)
  // The breakdown must belong to the number on screen: the combined aggregate,
  // the generation window, or this payload's own period — never a mix.
  const heroTokens = combined
    ? tokensOf({ ...combined.combined, cacheWriteTokens: combined.combined.cacheCreateTokens })
    : tokensOf(useGeneration ? headline : data.current)
  const heroSessionHelp = combined
    ? combinedSessionCountHelp()
    : (sessionCountIsExact(data.current.sessionCountBasis) ? undefined : sessionCountHelp())
  const animateKey = heroSelectionKey
  const anchorKey = rangeActive ? range.to : localDateKey(now)
  const anchorIsToday = anchorKey === localDateKey(now)
  const stats = deriveStats(data, now, anchorKey)
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
  // The chips read the same series the chart draws. Past the fit ceiling the
  // chart folds days into weeks, and a Peak taken from the raw days then named a
  // day the chart has no bar for, so the guide and the chip disagreed.
  const chartBucketSize = barBucketDays(chartDaily.length)
  const drawnDaily = bucketDays(chartDaily, chartBucketSize)
  // Models this period come from `current.topModels` — period/range/provider-
  // scoped by the CLI, and (on CLIs that emit per-model counts) carrying input/
  // output/cache-read counts for every model in the period, including days
  // whose per-day top-5 history list no longer names them. history.daily is
  // the fallback for payloads from older CLIs: its rows know input/output but
  // not cache read, so the cache column shows "—" there. Provider-filtered
  // history.daily has empty topModels, so a provider filter always sources
  // from current.topModels.
  //
  // `current.topModels` is uncapped (#1318), so this table lists every model
  // with usage in the period — the union-over-top-5 fallback it replaced was
  // itself truncated per day, and a row cap would drop exactly the local and
  // free models (qwen, llama, …) whose cost is $0 and therefore rank last.
  // Consumers wanting fewer rows slice their own; this table scrolls instead.
  const topModelsCarryCounts = data.current.topModels.some(model =>
    model.inputTokens !== undefined || model.outputTokens !== undefined,
  )
  const models = useGeneration
    ? topModelsToAggregated(genModels)
    : provider !== 'all' || topModelsCarryCounts
      ? topModelsToAggregated(data.current.topModels)
      : aggregateModels(rangeActive ? sliceDailyToRange(data.history.daily, range.from, range.to) : periodDaily)
  const recent14 = data.history.daily.slice(-14)
  const weekNow = mean(recent14.slice(-7).map(day => day.cost))
  const weekPrior = mean(recent14.slice(-14, -7).map(day => day.cost))
  const weeklyPct = weekPrior > 0 ? Math.round(Math.abs((weekNow - weekPrior) / weekPrior * 100)) : null
  const topModel = data.current.topModels[0]
  const saved = actReport.data?.totals?.realizedCostUSD ?? 0
  const applied = saved > 0 ? (actReport.data?.totals?.measuredActions ?? 0) : 0
  const localSaved = data.current.localModelSavings.totalUSD
  // A custom range has no meaningful "vs last week" or month-to-date baseline.
  const signals = deriveSignals(data, now, rangeActive)
  // Drill-through entry points. An expensive-session row can only open the
  // exact session when the payload carries its identity (provider + id);
  // otherwise the row keeps the plain "See all" navigation, never a guess.
  const openSessionRow = (session: MenubarPayload['current']['topSessions'][number]) => {
    if (!session.sessionId || !session.provider || !onInvestigate) {
      onNavigate?.('sessions')
      return
    }
    // The drawer key uses the RAW row project (projectKey), not the friendly
    // display name, so it matches the sessions-list rows exactly.
    const projectKey = session.projectKey ?? session.project
    onInvestigate({
      filters: sessionFilters({ provider: session.provider, sessionId: session.sessionId }),
      sessionId: `${session.provider}\u0000${projectKey}\u0000${session.sessionId}`,
    })
  }
  return (
    <div className="ov-dashboard">
      {error && <StaleBanner error={error} />}
      <div className="ov-card">
        <div className="ov-panel-head">
          <Icon name="circle-dollar-sign" />
          <h3>{combined ? `${t('overview.hero.combined')} · ${data.current.label}` : data.current.label}</h3>
          <span className="r"><span className="ov-streak">{t('overview.hero.streakPrefix')}<b>{rememberStreak(data.streak) ?? streakDays(data.history.daily, now)}</b>{t('overview.hero.streakSuffix')}</span></span>
        </div>
        <div className="ov-card-inner ov-hero-split" aria-label={t('overview.hero.kpiAria')}>
          <div className="ov-hero-main">
            <div className="ov-hero-figures">
              {/* A returning launch already showed a truthful persisted headline.
                  Replaying the live hero from $0 on handoff makes that exact value
                  appear to collapse and recover; snap to the revalidated total. */}
              <CountUp value={heroCost} tokens={heroTokens} animateKey={animateKey} animate={!suppressHeroReplay} />
              <div className="ov-hero-sub" title={heroSessionHelp}>{formatCount(heroCalls, 'call')} · {heroSessionLabel}</div>
              {combined
                ? <CombinedDevices usage={combined} />
                : (
                  <>
                    {saved > 0 && (
                      <div className="ov-saved-line"><span>{t('overview.hero.savedByFixes')}</span><strong>{formatUsd(saved)}</strong><small>{t('overview.hero.across')} {formatCount(applied, 'fix', 'fixes')}</small></div>
                    )}
                    {localSaved > 0 && (
                      <div className="ov-saved-line"><span>{t('overview.hero.savedViaLocal')}</span><strong>{formatUsd(localSaved)}</strong><small>{t('overview.hero.localModelRouting')}</small></div>
                    )}
                  </>
                )}
            </div>
            <div className="ov-hero-foot">
              <div><span>{anchorIsToday ? t('overview.day.yesterday') : t('overview.day.previousDay')}</span><strong>{stats.priorDayCost === null ? t('overview.common.na') : <Usd value={stats.priorDayCost} tokens={tokensOf(stats.priorDayEntry)} />}</strong></div>
              <div><span>{t('overview.hero.sevenDayAvg')}</span><strong>{stats.sevenDayAvg === null ? t('overview.common.na') : <Usd value={stats.sevenDayAvg} tokens={sumTokens(stats.sevenDayEntries, stats.sevenDayEntries.length)} />}</strong></div>
              <div><span>{anchorIsToday ? t('overview.day.vsYesterday') : t('overview.day.vsPreviousDay')}</span><strong className={stats.dayOverDayPct === null ? undefined : `tone-${paceDirection(stats.dayOverDayPct)}`}>{stats.dayOverDayPct === null ? t('overview.common.na') : `${stats.dayOverDayPct >= 0 ? '+' : '-'}${Math.abs(Math.round(stats.dayOverDayPct))}%`}</strong></div>
            </div>
          </div>
          <ActivityHeatmap daily={data.history.daily} bare />
          <EfficiencyScorecard current={data.current} bare />
        </div>
      </div>

      {!rangeActive && (
        <div className="ov-stats3">
          <div className="ov-card">
            <div className="ov-panel-head"><Icon name="calendar" /><h3>{t('overview.stats.monthToDate')}</h3></div>
            <div className="ov-card-inner ov-stat">
              <SpendTrend values={stats.mtdSeries} tone={stats.pacePct === null ? 'flat' : paceDirection(stats.pacePct)} />
              <div className="ov-stat-figures">
                <div className="v"><Usd value={stats.mtd} tokens={sumTokens(stats.mtdEntries)} /></div>
                {stats.pacePct === null ? (
                  <div className="d">{t('overview.stats.noMonthPaceYet', { month: stats.prevMonthName })}</div>
                ) : (
                  <>
                    <span className={`ov-stat-pill tone-${paceDirection(stats.pacePct)}`}>
                      <Icon name={stats.pacePct < 0 ? 'arrow-down' : 'arrow-up'} />
                      {Math.abs(Math.round(stats.pacePct))}%
                    </span>
                    <div className="d">{t('overview.stats.vsMonthPace', { month: stats.prevMonthName })}</div>
                  </>
                )}
              </div>
              <div className="ov-stat-foot">
                <button className="ov-link" type="button" onClick={() => onNavigate?.('spend')}>{t('overview.stats.seeSpend')}<Icon name="arrow-right" /></button>
              </div>
            </div>
          </div>
          <div className="ov-card">
            <div className="ov-panel-head"><Icon name="trending-up" /><h3>{t('overview.stats.projectedMonth')}</h3></div>
            <div className="ov-card-inner ov-stat">
              <SpendTrend values={[...stats.mtdSeries, ...stats.projectedTail]} tone="flat" dashFrom={Math.max(0, stats.mtdSeries.length - 1)} />
              <div className="ov-stat-figures">
                <div className="v">{formatUsd(stats.projected)} <small>{t('overview.stats.est')}</small></div>
                <span className="ov-stat-pill tone-neutral">
                  <b>{formatUsd(Math.max(0, stats.projected - stats.mtd))}</b> {t('overview.stats.toGo')}
                </span>
              </div>
              <div className="ov-stat-foot">
                <button className="ov-link" type="button" onClick={() => onNavigate?.('plans')}>{t('overview.stats.seePlans')}<Icon name="arrow-right" /></button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="ov-card ov-panel ov-chart-widget">
        <div className="ov-panel-head"><Icon name="chart-column" /><h3>{t('overview.chartWidget.dailySpend')}</h3>{data.history.daily.length ? <span className="r"><DailySummaries daily={drawnDaily} anchorIsToday={anchorIsToday} bucketed={chartBucketSize > 1} /></span> : null}</div>
        <div className="ov-panel-body">{data.history.daily.length ? <DailyChart daily={drawnDaily} bucketed={chartBucketSize > 1} dataStart={dataStartKey(data.history.daily)} animateKey={animateKey} onSelectDay={date => onInvestigate?.({ filters: dayFilters(date) })} /> : <EmptyNote>{t('overview.chartWidget.noSpendYet')}</EmptyNote>}</div>
      </div>

      <WorkflowCard current={data.current} />

      <div className="ov-insight-band">
        <div className="ov-coach">
          <div className="ov-card-inner ov-coach-inner">
            <Icon name="trending-up" />
            <div className="ov-coach-tx">
              {rangeActive
                ? <>{topModel ? <><span className="num">{topModel.name}</span>{t('overview.coach.driverSuffixRange')}</> : t('overview.coach.noDriverRange')}. <span className="num">{formatUsd(data.optimize.savingsUSD)}</span>{t('overview.coach.recoverableSuffix')}</>
                : <>{weeklyPct === null ? <>{t('overview.coach.noBaseline')}</> : <>{t('overview.coach.pacingLead')}<span className="num">{t('overview.coach.pacingClause', { percent: weeklyPct, direction: t(weekNow >= weekPrior ? 'overview.coach.higher' : 'overview.coach.lower') })}</span></>}{topModel ? <>; <span className="num">{topModel.name}</span>{t('overview.coach.alsoDriverSuffix')}</> : ''}. <span className="num">{formatUsd(data.optimize.savingsUSD)}</span>{t('overview.coach.recoverableSuffix')}</>}
            </div>
            <button className="ov-coach-cta" type="button" onClick={() => onNavigate?.('optimize')}>{t('overview.coach.reviewCta')}</button>
          </div>
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
            <div className="ov-panel-head"><Icon name="box" /><h3>{t('overview.models.periodTitle')}</h3><span className="r">{t('overview.common.sortedByCost')}</span></div>
            <div className="ov-panel-body ov-model-panel"><ModelsTable models={models} onSelectModel={onInvestigate ? name => onInvestigate({ filters: modelFilters([name]) }) : undefined} /></div>
          </div>

          <div className="ov-card ov-panel ov-sessions-widget">
            <div className="ov-panel-head"><Icon name="coins" /><h3>{t('overview.sessions.mostExpensive')}</h3><span className="r"><button className="ov-link" type="button" onClick={() => onNavigate?.('sessions')}>{t('overview.sessions.seeAll')}</button></span></div>
            <div className="ov-panel-body">
              {data.current.topSessions.length ? data.current.topSessions.map((session, index) => {
                const model = modelIndex.get(sessionModelKey(session.project, session.date, session.calls, session.cost))
                const sub = [formatChartDate(session.date), model, formatCount(session.calls, 'call')].filter(Boolean).join(' · ')
                return <ListRow key={`${session.project}-${session.date}-${index}`} no={String(index + 1).padStart(2, '0')} title={session.project} sub={sub} value={formatUsd(session.cost)} onClick={() => openSessionRow(session)} />
              }) : <EmptyNote>{t('overview.sessions.noSessions')}</EmptyNote>}
            </div>
          </div>
        </div>

        <div className="ov-side-column">
          <div className="ov-card ov-panel ov-activities-widget">
            <div className="ov-panel-head"><Icon name="list" /><h3>{t('overview.activities.title')}</h3><span className="r">{t('overview.common.sortedByCost')}</span></div>
            <div className="ov-panel-body"><TopActivities activities={data.current.topActivities} onSelectCategory={onInvestigate ? raw => onInvestigate({ filters: categoryFilters(raw) }) : undefined} /></div>
          </div>
        </div>
      </div>
    </div>
  )
}
