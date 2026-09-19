import { useRef, useState } from 'react'

import { ChartTip } from './ChartTip'
import { t } from '../i18n'
import { formatAxisMoney, niceTicks, ticksClearOfPeak } from '../lib/chartAxis'
import { formatUsd } from '../lib/format'
import { useBarGrowIn } from '../lib/motion'
import { type SeriesKey, seriesClassForKey, seriesClassForModel, seriesKeyForModel, seriesLabel } from '../lib/modelSeries'
import { formatChartDate } from '../lib/period'
import type { DailyHistoryEntry } from '../lib/types'

const SERIES_ORDER: readonly SeriesKey[] = ['flagship', 'premium', 'balanced', 'fast', 'other']

function modelSpend(day: DailyHistoryEntry): number {
  return day.topModels.reduce((sum, model) => sum + Math.max(0, model.cost), 0)
}

export function StackedBars({ daily, fallbackLabel, animateKey = '', dataStart = null }: { daily: DailyHistoryEntry[]; fallbackLabel?: string; animateKey?: string; dataStart?: string | null }) {
  const resolvedFallbackLabel = fallbackLabel ?? t('shared.stackedBars.allModels')
  const barsRef = useRef<HTMLDivElement>(null)
  const [tip, setTip] = useState<{ day: DailyHistoryEntry; x: number; y: number } | null>(null)
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
  const dayTotal = (day: DailyHistoryEntry) => (modelSpend(day) > 0 ? modelSpend(day) : Math.max(0, day.cost))
  const maxTotal = Math.max(1, ...daily.map(dayTotal))
  // Bars are drawn against the top tick, so a bar top and a gridline agree.
  const valueTicks = niceTicks(maxTotal)
  const axisMax = valueTicks.at(-1) || 1
  const peakIndex = daily.reduce((peak, day, index) => (dayTotal(day) > dayTotal(daily[peak]) ? index : peak), 0)
  const peak = daily[peakIndex]
  const legendSeries = SERIES_ORDER.filter(series => presentSeries.has(series))
  const ticks = daily.filter((_, index) => (daily.length - 1 - index) % 4 === 0)
  const columnCentre = (index: number) => ((index + 0.5) / Math.max(1, daily.length)) * 100

  return (
    <div className="sbars-wrap">
      <div className="chart-frame">
      <div className="chart-plot">
      <div className="chart-grid" aria-hidden="true">
        {valueTicks.map(tick => <span className="chart-gridline" key={tick} style={{ bottom: `${(tick / axisMax) * 100}%` }} />)}
        {daily.map((day, index) => (dayOfWeek(day.date) === 0 && index > 0
          ? <span className="chart-weekline" key={day.date} style={{ left: `${columnCentre(index) - (50 / Math.max(1, daily.length))}%` }} />
          : null))}
      </div>
      <div className="sbars" aria-label={t('shared.stackedBars.ariaLabel')} ref={barsRef}>
        {daily.map(day => {
          // Days before the first recorded day are unknown, not zero: no bar, and
          // an honest "No data recorded" hover instead of a "$0.00" claim.
          const noData = dataStart !== null && day.date < dataStart
          return (
            <div
              className={`c${noData ? ' nodata' : ''}`}
              key={day.date}
              data-date={day.date}
              data-nodata={noData ? 'true' : 'false'}
              role="img"
              aria-label={noData ? `${day.date}, ${t('shared.chart.noDataAria')}` : `${day.date}, ${formatUsd(day.cost)}`}
              title={noData ? `${day.date} · ${t('shared.chart.noData')}` : `${day.date} · ${formatUsd(day.cost)}`}
              onMouseEnter={event => setTip({ day, x: event.clientX, y: event.clientY })}
              onMouseMove={event => setTip({ day, x: event.clientX, y: event.clientY })}
              onMouseLeave={() => setTip(null)}
            >
              {noData ? (
                <span className="nodata-mark" aria-hidden="true" />
              ) : modelSpend(day) > 0 ? (
                [...day.topModels].sort(
                  (a, b) => SERIES_ORDER.indexOf(seriesKeyForModel(a.name)) - SERIES_ORDER.indexOf(seriesKeyForModel(b.name)),
                ).map(model => {
                  const pct = Math.max(1, (Math.max(0, model.cost) / axisMax) * 100)
                  const routes = model.rawModels && model.rawModels.length > 1 ? ` (${model.rawModels.join(', ')})` : ''
                  return (
                    <span
                      key={`${day.date}-${model.name}`}
                      className={`s ${seriesClassForModel(model.name)}`}
                      style={{ height: `${pct}%` }}
                      title={`${model.name}${routes} · ${formatUsd(model.cost)}`}
                    />
                  )
                })
              ) : day.cost > 0 ? (
                <span
                  className={`s ${seriesClassForKey('other')}`}
                  style={{ height: `${Math.max(1, (day.cost / axisMax) * 100)}%` }}
                  title={`${resolvedFallbackLabel} · ${formatUsd(day.cost)}`}
                />
              ) : null}
            </div>
          )
        })}
      </div>
      {peak && dayTotal(peak) > 0 && (
        <span className="chart-peak-guide" aria-hidden="true" style={{ bottom: `${(dayTotal(peak) / axisMax) * 100}%`, left: `${columnCentre(peakIndex)}%` }} />
      )}
      </div>
      <div className="chart-axis" aria-hidden="true">
        {ticksClearOfPeak(valueTicks, peak && dayTotal(peak) > 0 ? dayTotal(peak) : 0, axisMax).map(tick => <span className="chart-axis-tick" key={tick} style={{ bottom: `${(tick / axisMax) * 100}%` }}>{formatAxisMoney(tick)}</span>)}
        {peak && dayTotal(peak) > 0 && (
          <span className="chart-axis-peak" style={{ bottom: `${(dayTotal(peak) / axisMax) * 100}%` }}>{formatUsd(dayTotal(peak))}</span>
        )}
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
      </div>
      <div className="legend">
        {legendSeries.map(series => (
          <span key={series}>
            <i className={seriesClassForKey(series)} />
            {seriesLabel(series)}
          </span>
        ))}
        {usesFallback && !presentSeries.has('other') && (
          <span key="fallback">
            <i className={seriesClassForKey('other')} />
            {resolvedFallbackLabel}
          </span>
        )}
      </div>
      {tip && (
        <ChartTip x={tip.x} y={tip.y}>
          <div className="chart-tip-d">{formatChartDate(tip.day.date)}</div>
          {dataStart !== null && tip.day.date < dataStart ? (
            <div className="chart-tip-s">{t('shared.chart.noData')}</div>
          ) : modelSpend(tip.day) > 0 ? (
            [...tip.day.topModels].sort((a, b) => b.cost - a.cost).map(model => (
              <div className="chart-tip-row" key={model.name}>
                <i className={`chart-tip-sw ${seriesClassForModel(model.name)}`} />
                <span>{model.name}</span>
                <b>{formatUsd(model.cost)}</b>
              </div>
            ))
          ) : (
            <div className="chart-tip-row">
              <i className={`chart-tip-sw ${seriesClassForKey('other')}`} />
              <span>{resolvedFallbackLabel}</span>
              <b>{formatUsd(tip.day.cost)}</b>
            </div>
          )}
        </ChartTip>
      )}
    </div>
  )
}

/** 0 = Sunday, from a local `YYYY-MM-DD` key. */
function dayOfWeek(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day).getDay()
}
