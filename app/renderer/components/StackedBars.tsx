import { useRef } from 'react'

import { formatUsd } from '../lib/format'
import { useBarGrowIn } from '../lib/motion'
import { SERIES_LABELS, type SeriesKey, seriesClassForKey, seriesClassForModel, seriesKeyForModel } from '../lib/modelSeries'
import { formatChartDate } from '../lib/period'
import type { DailyHistoryEntry } from '../lib/types'

const SERIES_ORDER: readonly SeriesKey[] = ['opus', 'fable', 'haiku', 'gpt', 'sonnet', 'other']

function modelSpend(day: DailyHistoryEntry): number {
  return day.topModels.reduce((sum, model) => sum + Math.max(0, model.cost), 0)
}

export function StackedBars({ daily, fallbackLabel = 'All models', animateKey = '' }: { daily: DailyHistoryEntry[]; fallbackLabel?: string; animateKey?: string }) {
  const barsRef = useRef<HTMLDivElement>(null)
  useBarGrowIn(barsRef, '.c', [animateKey])
  const presentSeries = new Set<SeriesKey>()
  let usesFallback = false
  for (const day of daily) {
    if (modelSpend(day) > 0) {
      for (const model of day.topModels) {
        if (model.cost > 0) presentSeries.add(seriesKeyForModel(model.name))
      }
    } else if (day.cost > 0) {
      // Provider-filtered days carry day.cost but no per-model breakdown; the
      // bar must still reflect spend (the Swift menubar draws from day.cost).
      usesFallback = true
    }
  }
  // Fallback days contribute day.cost to the scale so their single segment is proportional.
  const maxTotal = Math.max(1, ...daily.map(day => (modelSpend(day) > 0 ? modelSpend(day) : Math.max(0, day.cost))))
  const legendSeries = SERIES_ORDER.filter(series => presentSeries.has(series))
  const ticks = daily.filter((_, index) => index % 4 === 0)
  const lastDay = daily.at(-1)
  if (lastDay && ticks.at(-1) !== lastDay) ticks.push(lastDay)

  return (
    <div className="sbars-wrap">
      <div className="sbars" aria-label="Daily spend by model" ref={barsRef}>
        {daily.map(day => (
          <div className="c" key={day.date} data-date={day.date} title={`${day.date} · ${formatUsd(day.cost)}`}>
            {modelSpend(day) > 0 ? (
              [...day.topModels].sort(
                (a, b) => SERIES_ORDER.indexOf(seriesKeyForModel(a.name)) - SERIES_ORDER.indexOf(seriesKeyForModel(b.name)),
              ).map(model => {
                const pct = Math.max(1, (Math.max(0, model.cost) / maxTotal) * 100)
                return (
                  <span
                    key={`${day.date}-${model.name}`}
                    className={`s ${seriesClassForModel(model.name)}`}
                    style={{ height: `${pct}%` }}
                    title={`${model.name} · ${formatUsd(model.cost)}`}
                  />
                )
              })
            ) : day.cost > 0 ? (
              <span
                className={`s ${seriesClassForKey('other')}`}
                style={{ height: `${Math.max(1, (day.cost / maxTotal) * 100)}%` }}
                title={`${fallbackLabel} · ${formatUsd(day.cost)}`}
              />
            ) : null}
          </div>
        ))}
      </div>
      <div className="ov-xax">
        {ticks.map(day => {
          const index = daily.indexOf(day)
          return (
            <span key={day.date} style={{ left: `${daily.length > 1 ? index / (daily.length - 1) * 100 : 0}%` }}>
              {formatChartDate(day.date)}
            </span>
          )
        })}
      </div>
      <div className="legend">
        {legendSeries.map(series => (
          <span key={series}>
            <i className={seriesClassForKey(series)} />
            {SERIES_LABELS[series]}
          </span>
        ))}
        {usesFallback && !presentSeries.has('other') && (
          <span key="fallback">
            <i className={seriesClassForKey('other')} />
            {fallbackLabel}
          </span>
        )}
      </div>
    </div>
  )
}
