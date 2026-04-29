import { useState } from 'react'
import type { DailyEntry } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { formatCompactCurrency, formatCurrency } from '../lib/currency'
import { todayKey, formatDateKey, addDays, startOfDay, prettyDate, shortDate } from '../lib/dates'

const TREND_DAYS = 19

type TrendBar = {
  date: string
  cost: number
  inputTokens: number
  outputTokens: number
  isToday: boolean
  topModels: Array<{ name: string; totalTokens?: number; inputTokens?: number; outputTokens?: number }>
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return `${Math.round(n)}`
}

function buildBars(days: DailyEntry[]): TrendBar[] {
  const byDate = new Map(days.map(d => [d.date, d]))
  const today = startOfDay(new Date())
  const tk = todayKey()
  const bars: TrendBar[] = []
  for (let i = TREND_DAYS - 1; i >= 0; i--) {
    const d = addDays(today, -i)
    const key = formatDateKey(d)
    const entry = byDate.get(key)
    bars.push({
      date: key,
      cost: entry?.cost ?? 0,
      inputTokens: entry?.inputTokens ?? 0,
      outputTokens: entry?.outputTokens ?? 0,
      isToday: key === tk,
      topModels: entry?.topModels ?? [],
    })
  }
  return bars
}

function computeDelta(bars: TrendBar[], allDays: DailyEntry[]): number | null {
  const thisTotal = bars.reduce((s, b) => s + b.cost, 0)
  const today = startOfDay(new Date())
  const priorStart = formatDateKey(addDays(today, -(2 * TREND_DAYS - 1)))
  const thisStart = formatDateKey(addDays(today, -(TREND_DAYS - 1)))
  const priorTotal = allDays
    .filter(d => d.date >= priorStart && d.date < thisStart)
    .reduce((s, d) => s + d.cost, 0)
  if (priorTotal <= 0) return null
  return ((thisTotal - priorTotal) / priorTotal) * 100
}

type Props = {
  days: DailyEntry[]
  currency: CurrencyState
}

export function TrendInsight({ days, currency }: Props) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)
  const bars = buildBars(days)
  const totalTokens = bars.reduce((s, b) => s + b.inputTokens + b.outputTokens, 0)
  const useTokens = totalTokens > 0
  const metric = (b: TrendBar) => useTokens ? b.inputTokens + b.outputTokens : b.cost
  const maxVal = Math.max(...bars.map(metric), 0.01)
  const avgVal = bars.length > 0 ? bars.reduce((s, b) => s + metric(b), 0) / bars.length : 0
  const totalCost = bars.reduce((s, b) => s + b.cost, 0)
  const peak = bars.filter(b => metric(b) > 0).sort((a, b) => metric(b) - metric(a))[0]
  const yd = formatDateKey(addDays(startOfDay(new Date()), -1))
  const yesterday = bars.find(b => b.date === yd)
  const delta = computeDelta(bars, days)

  const fmtVal = (v: number) => useTokens ? `${formatTokens(v)} tok` : formatCompactCurrency(v, currency)
  const heroText = useTokens ? `${formatTokens(totalTokens)} tokens` : formatCurrency(totalCost, currency)

  return (
    <div className="trend-insight">
      <div className="trend-header">
        <div className="trend-header-left">
          <div className="trend-sublabel">Last {TREND_DAYS} days</div>
          <div className="trend-hero-value">{heroText}</div>
        </div>
        {delta !== null && (
          <div className="trend-delta">
            <span className="trend-delta-arrow">{delta >= 0 ? '↗' : '↘'}</span>
            {delta >= 0 ? '+' : ''}{Math.round(delta)}% vs prior {TREND_DAYS}d
          </div>
        )}
      </div>

      <div className="trend-chart" onMouseLeave={() => setHoveredIdx(null)}>
        <div className="trend-bars">
          {bars.map((bar, i) => {
            const val = metric(bar)
            const pct = maxVal > 0 ? (val / maxVal) * 100 : 0
            const isHovered = hoveredIdx === i
            return (
              <div
                key={bar.date}
                className="trend-bar-col"
                onMouseEnter={() => setHoveredIdx(i)}
              >
                <div className="trend-bar-spacer" />
                <div
                  className={`trend-bar ${bar.isToday ? 'trend-bar-today' : ''} ${isHovered ? 'trend-bar-hovered' : ''}`}
                  style={{ height: `${Math.max(2, pct)}%` }}
                />
              </div>
            )
          })}
        </div>
        <div
          className="trend-avg-line"
          style={{ bottom: `${Math.min((avgVal / maxVal) * 100, 100)}%` }}
        />
        {hoveredIdx !== null && bars[hoveredIdx] && (
          <div className="trend-tooltip">
            <div className="trend-tooltip-header">
              <span>{prettyDate(bars[hoveredIdx].date)}</span>
              <span className="trend-tooltip-value">{fmtVal(metric(bars[hoveredIdx]))}</span>
            </div>
            {bars[hoveredIdx].topModels.slice(0, 4).map(m => (
              <div key={m.name} className="trend-tooltip-model">
                <span className="trend-tooltip-dot" />
                <span className="trend-tooltip-name">{m.name}</span>
                <span className="trend-tooltip-tokens">{formatTokens(m.totalTokens ?? 0)} tok</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="trend-mini-stats">
        <div className="mini-stat">
          <div className="mini-stat-label">Avg/day</div>
          <div className="mini-stat-value">{fmtVal(avgVal)}</div>
        </div>
        <div className="mini-stat">
          <div className="mini-stat-label">Peak</div>
          <div className="mini-stat-value">
            {peak ? `${fmtVal(metric(peak))} on ${shortDate(peak.date)}` : '—'}
          </div>
        </div>
        <div className="mini-stat">
          <div className="mini-stat-label">Yesterday</div>
          <div className="mini-stat-value">{yesterday ? fmtVal(metric(yesterday)) : '—'}</div>
        </div>
      </div>
    </div>
  )
}
