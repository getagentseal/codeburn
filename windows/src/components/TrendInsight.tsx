import { useState } from 'react'
import type { DailyEntry, DailyModel } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { formatCompactCurrency, formatCurrency, formatTokens } from '../lib/currency'
import { todayKey, formatDateKey, addDays, startOfDay, prettyDate, shortDate } from '../lib/dates'
import { ArrowUpRight, ArrowDownRight } from './Icons'
import type { DaySelection, Period } from './PeriodTabs'
import { t } from '../i18n/index'

/// How many days the chart covers, from the mac TrendInsight.trendDayCount. 19 is what
/// fits the 332px content width of a 360px popover at a readable bar width; the longer
/// periods trade width for reach. A picked day falls back to the 19-day window, as the
/// mac's trendPeriod does, because one day is not a trend.
export function trendDayCount(period: Period, days: DaySelection, historyLength: number): number {
  if (days.length > 0) return 19
  switch (period) {
    case 'today':
    case 'week': return 19
    case '30days': return 30
    case 'month': return 31
    case 'all':
    case 'lifetime': return Math.min(historyLength, 90)
  }
}

const MAX_TOOLTIP_MODELS = 4
const MIN_BAR_PCT = 2

type TrendBar = {
  date: string
  cost: number
  tokens: number
  isToday: boolean
  topModels: DailyModel[]
}

function buildBars(days: DailyEntry[], dayCount: number): TrendBar[] {
  const byDate = new Map(days.map(d => [d.date, d]))
  const today = startOfDay(new Date())
  const tk = todayKey()
  const bars: TrendBar[] = []
  for (let i = dayCount - 1; i >= 0; i--) {
    const key = formatDateKey(addDays(today, -i))
    const entry = byDate.get(key)
    bars.push({
      date: key,
      cost: entry?.cost ?? 0,
      tokens: (entry?.inputTokens ?? 0) + (entry?.outputTokens ?? 0),
      isToday: key === tk,
      topModels: entry?.topModels ?? [],
    })
  }
  return bars
}

function computeDelta(bars: TrendBar[], allDays: DailyEntry[], dayCount: number): number | null {
  const thisTotal = bars.reduce((s, b) => s + b.cost, 0)
  const today = startOfDay(new Date())
  const priorStart = formatDateKey(addDays(today, -(2 * dayCount - 1)))
  const thisStart = formatDateKey(addDays(today, -(dayCount - 1)))
  const priorTotal = allDays
    .filter(d => d.date >= priorStart && d.date < thisStart)
    .reduce((s, d) => s + d.cost, 0)
  if (priorTotal <= 0) return null
  return ((thisTotal - priorTotal) / priorTotal) * 100
}

type Props = {
  days: DailyEntry[]
  currency: CurrencyState
  dayCount: number
}

export function TrendInsight({ days, currency, dayCount }: Props) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)
  const bars = buildBars(days, dayCount)
  const totalTokens = bars.reduce((s, b) => s + b.tokens, 0)
  const useTokens = totalTokens > 0
  const metric = (b: TrendBar) => useTokens ? b.tokens : b.cost
  const maxVal = Math.max(...bars.map(metric), 0.01)
  const avgVal = bars.reduce((s, b) => s + metric(b), 0) / bars.length
  const totalCost = bars.reduce((s, b) => s + b.cost, 0)
  const peak = bars.filter(b => metric(b) > 0).sort((a, b) => metric(b) - metric(a))[0]
  const yd = formatDateKey(addDays(startOfDay(new Date()), -1))
  const yesterday = bars.find(b => b.date === yd)
  const delta = computeDelta(bars, days, dayCount)
  // Past 45 bars the 4px gap eats more of the chart than the bars keep, as on the mac.
  const barGap = dayCount > 45 ? 2 : 4

  const fmtVal = (v: number) => useTokens ? `${formatTokens(v)} tok` : formatCompactCurrency(v, currency)
  const heroText = useTokens ? t('%@ tokens', formatTokens(totalTokens)) : formatCurrency(totalCost, currency)
  const hovered = hoveredIdx !== null ? bars[hoveredIdx] : null

  return (
    <div className="trend-insight">
      <div className="insight-header">
        <div>
          <div className="insight-sublabel">{t('Last %lld days', dayCount)}</div>
          <div className="insight-hero">{heroText}</div>
        </div>
        {delta !== null && (
          <div className="delta-badge">
            {delta >= 0 ? <ArrowUpRight size={9} /> : <ArrowDownRight size={9} />}
            <span>{t('%1$@%% vs prior %2$lldd', `${delta >= 0 ? '+' : ''}${Math.round(delta)}`, dayCount)}</span>
          </div>
        )}
      </div>

      <div
        className="trend-chart"
        role="group"
        aria-label={t('Last %lld days', dayCount)}
        onMouseLeave={() => setHoveredIdx(null)}
      >
        <div className="trend-bars" style={{ gap: `${barGap}px` }}>
          {bars.map((bar, i) => {
            const val = metric(bar)
            const pct = (val / maxVal) * 100
            const cls = [
              'trend-bar',
              bar.isToday ? 'trend-bar-today' : '',
              val <= 0 ? 'trend-bar-empty' : '',
              hoveredIdx === i ? 'trend-bar-hovered' : '',
            ].join(' ')
            return (
              <div
                key={bar.date}
                className="trend-bar-col"
                // A painted column with no text: the day and the figure live in its label.
                role="img"
                aria-label={`${prettyDate(bar.date)}: ${fmtVal(val)}`}
                onMouseEnter={() => setHoveredIdx(i)}
              >
                <div className={cls} style={{ height: `${Math.max(MIN_BAR_PCT, pct)}%` }} />
              </div>
            )
          })}
        </div>
        <div
          className="trend-avg-line"
          style={{ bottom: `${Math.min((avgVal / maxVal) * 100, 100)}%` }}
        />
        {hovered && (
          <div className="bar-tooltip" role="tooltip">
            <div className="bar-tooltip-header">
              <span>{prettyDate(hovered.date)}</span>
              <span className="bar-tooltip-value">{fmtVal(metric(hovered))}</span>
            </div>
            {hovered.topModels.slice(0, MAX_TOOLTIP_MODELS).map(m => (
              <div key={m.name} className="bar-tooltip-model">
                <span className="bar-tooltip-dot" />
                <span className="bar-tooltip-name">{m.name}</span>
                <span className="bar-tooltip-tokens">{formatTokens(m.inputTokens + m.outputTokens)} tok</span>
                <span className="bar-tooltip-split">({formatTokens(m.inputTokens)}/{formatTokens(m.outputTokens)})</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mini-stats">
        <div className="mini-stat">
          <div className="mini-stat-label">{t('Avg/day')}</div>
          <div className="mini-stat-value">{fmtVal(avgVal)}</div>
        </div>
        <div className="mini-stat">
          <div className="mini-stat-label">{t('Peak')}</div>
          <div className="mini-stat-value">
            {peak ? `${fmtVal(metric(peak))} on ${shortDate(peak.date)}` : '-'}
          </div>
        </div>
        <div className="mini-stat">
          <div className="mini-stat-label">{t('Yesterday')}</div>
          <div className="mini-stat-value">{yesterday ? fmtVal(metric(yesterday)) : '-'}</div>
        </div>
      </div>
    </div>
  )
}
