import { useLayoutEffect, useMemo, useRef, useState } from 'react'

import { ChartTip } from './ChartTip'
import { formatCount, formatUsd } from '../lib/format'
import { dataStartKey, localDateKey } from '../lib/period'
import type { DailyHistoryEntry } from '../lib/types'

type HeatmapDay = {
  date: string
  cost: number
  calls: number
  level: number
  isFuture: boolean
  // True for days that predate the first recorded day: a zero here is unknown,
  // not a real zero, so it renders as "no data" rather than a currency zero.
  noData: boolean
}

/** Cell box and gutter, in CSS px — must match `.ov-heat-cell` / `.ov-heatmap-cells`. */
const CELL = 11
const GAP = 3
/** Six months of history: the most weeks the card ever draws. */
const MAX_WEEKS = 26
/** Fewest week columns between two month labels before the later one is dropped. */
const MIN_LABEL_COLUMNS = 3
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function dateFromKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function formatDate(key: string): string {
  return dateFromKey(key).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function intensityLevel(cost: number, maxCost: number): number {
  if (cost <= 0 || maxCost <= 0) return 0
  const ratio = Math.min(1, cost / maxCost)
  if (ratio < 0.25) return 1
  if (ratio < 0.5) return 2
  if (ratio < 0.75) return 3
  return 4
}

function buildHeatmapDays(daily: DailyHistoryEntry[], now: Date, weeks: number): HeatmapDay[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfWeek = new Date(today)
  startOfWeek.setDate(today.getDate() - today.getDay())
  const firstDay = new Date(startOfWeek)
  firstDay.setDate(startOfWeek.getDate() - (weeks - 1) * 7)
  const byDate = new Map(daily.map(day => [day.date, day]))
  const dataStart = dataStartKey(daily)
  const visibleCosts: number[] = []

  for (let offset = 0; offset < weeks * 7; offset++) {
    const date = new Date(firstDay)
    date.setDate(firstDay.getDate() + offset)
    if (date <= today) visibleCosts.push(byDate.get(localDateKey(date))?.cost ?? 0)
  }
  const maxCost = Math.max(...visibleCosts, 0)

  return Array.from({ length: weeks * 7 }, (_, offset) => {
    const date = new Date(firstDay)
    date.setDate(firstDay.getDate() + offset)
    const key = localDateKey(date)
    const isFuture = date > today
    const noData = !isFuture && (dataStart === null || key < dataStart)
    const entry = byDate.get(key)
    const cost = isFuture || noData ? 0 : (entry?.cost ?? 0)
    return {
      date: key,
      cost,
      calls: isFuture || noData ? 0 : (entry?.calls ?? 0),
      level: intensityLevel(cost, maxCost),
      isFuture,
      noData,
    }
  })
}

export function ActivityHeatmap({ daily, bare = false }: { daily: DailyHistoryEntry[]; bare?: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [weeks, setWeeks] = useState(MAX_WEEKS)
  const days = useMemo(() => buildHeatmapDays(daily, new Date(), weeks), [daily, weeks])
  const monthMarkers = useMemo(() => {
    const markers: Array<{ key: string; label: string; week: number }> = []
    const seen = new Set<string>()
    for (let index = 0; index < days.length; index++) {
      const date = dateFromKey(days[index]!.date)
      if (index !== 0 && date.getDate() !== 1) continue
      const key = `${date.getFullYear()}-${date.getMonth()}`
      if (seen.has(key)) continue
      seen.add(key)
      markers.push({ key, label: date.toLocaleString('en-US', { month: 'short' }), week: Math.floor(index / 7) })
    }
    // Two labels closer than MIN_LABEL_COLUMNS would collide. Real month starts
    // are always four or five weeks apart, so this only ever drops the leading
    // partial month, keeping the label that actually sits over its own weeks.
    return markers.filter((marker, index) => {
      const next = markers[index + 1]
      return !next || next.week - marker.week >= MIN_LABEL_COLUMNS
    })
  }, [days])
  const activeDays = useMemo(
    () => buildHeatmapDays(daily, new Date(), MAX_WEEKS).filter(day => !day.isFuture && day.cost > 0).length,
    [daily],
  )
  const [tip, setTip] = useState<{ day: HeatmapDay; x: number; y: number } | null>(null)

  // Draw only as many week columns as the slot can hold, right-anchored on the
  // current week, so the grid never scrolls and never hides its newest days.
  useLayoutEffect(() => {
    const slot = scrollRef.current
    if (!slot) return
    const fit = (): void => {
      const width = slot.clientWidth
      if (width <= 0) return
      setWeeks(Math.max(1, Math.min(MAX_WEEKS, Math.floor((width + GAP) / (CELL + GAP)))))
    }
    fit()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit)
    observer?.observe(slot)
    return () => observer?.disconnect()
  }, [])

  const head = (
    <div className={bare ? 'ov-activity-head' : 'ov-panel-head'}>
      {bare ? <span className="ov-label">Daily activity</span> : <h3>Daily activity</h3>}
      <span className="r ov-active-days">{activeDays} active days</span>
    </div>
  )
  const grid = (
    <div className="ov-heatmap-frame">
      <div className="ov-heatmap-corner" aria-hidden="true" />
      <div className="ov-heatmap-labels" aria-label="Weekday labels">
        {WEEKDAYS.map((weekday, index) => (
          <span key={weekday}>{index === 1 || index === 3 || index === 5 ? weekday : ''}</span>
        ))}
      </div>
      <div className="ov-heatmap-scroll" ref={scrollRef} role="region" aria-label="Daily activity timeline">
        <div className="ov-heatmap-track">
          <div className="ov-heatmap-months" aria-label="Month labels">
            {monthMarkers.map(marker => (
              <span key={marker.key} style={{ gridColumnStart: marker.week + 1 }}>{marker.label}</span>
            ))}
          </div>
          <div className="ov-heatmap-cells" role="grid" aria-label="Daily activity contribution heatmap">
            {days.map(day => (
              <button
                type="button"
                role="gridcell"
                key={day.date}
                className={`ov-heat-cell heat-level-${day.level}${day.isFuture ? ' future' : ''}${day.noData ? ' nodata' : ''}`}
                aria-label={`${formatDate(day.date)}: ${day.noData ? 'no data recorded' : day.isFuture ? 'future day' : `${formatUsd(day.cost)}, ${formatCount(day.calls, 'call')}`}`}
                data-date={day.date}
                data-cost={day.cost}
                data-active={!day.isFuture && !day.noData && day.cost > 0 ? 'true' : 'false'}
                onMouseEnter={event => setTip({ day, x: event.clientX, y: event.clientY })}
                onMouseMove={event => setTip({ day, x: event.clientX, y: event.clientY })}
                onMouseLeave={() => setTip(null)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
  const tooltip = tip
    ? (
        <ChartTip x={tip.x} y={tip.y}>
          <div className="chart-tip-d">{formatDate(tip.day.date)}</div>
          {tip.day.noData ? (
            <div className="chart-tip-s">No data recorded</div>
          ) : (
            <>
              <div className="chart-tip-v">{tip.day.isFuture ? 'Future day' : formatUsd(tip.day.cost)}</div>
              <div className="chart-tip-s">{tip.day.isFuture ? 'No activity yet' : `${tip.day.calls} calls`}</div>
            </>
          )}
        </ChartTip>
      )
    : null

  if (bare) {
    return <div className="ov-heatmap-bare">{head}{grid}{tooltip}</div>
  }
  return (
    <div className="ov-card ov-panel ov-heatmap-panel">
      {head}
      <div className="ov-panel-body">{grid}</div>
      {tooltip}
    </div>
  )
}
