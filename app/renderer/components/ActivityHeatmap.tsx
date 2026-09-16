import { useLayoutEffect, useMemo, useRef, useState } from 'react'

import { ChartTip } from './ChartTip'
import { formatUsd } from '../lib/format'
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

const WEEK_COUNT = 26
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

function buildHeatmapDays(daily: DailyHistoryEntry[], now: Date): HeatmapDay[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfWeek = new Date(today)
  startOfWeek.setDate(today.getDate() - today.getDay())
  const firstDay = new Date(startOfWeek)
  firstDay.setDate(startOfWeek.getDate() - (WEEK_COUNT - 1) * 7)
  const byDate = new Map(daily.map(day => [day.date, day]))
  const dataStart = dataStartKey(daily)
  const visibleCosts: number[] = []

  for (let offset = 0; offset < WEEK_COUNT * 7; offset++) {
    const date = new Date(firstDay)
    date.setDate(firstDay.getDate() + offset)
    if (date <= today) visibleCosts.push(byDate.get(localDateKey(date))?.cost ?? 0)
  }
  const maxCost = Math.max(...visibleCosts, 0)

  return Array.from({ length: WEEK_COUNT * 7 }, (_, offset) => {
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
  const days = useMemo(() => buildHeatmapDays(daily, new Date()), [daily])
  const monthMarkers = useMemo(() => {
    const markers: Array<{ key: string; label: string; week: number }> = []
    const seen = new Set<string>()
    for (let index = 0; index < days.length; index++) {
      const date = dateFromKey(days[index]!.date)
      if (index !== 0 && date.getDate() !== 1) continue
      const key = `${date.getFullYear()}-${date.getMonth()}`
      if (seen.has(key)) continue
      seen.add(key)
      markers.push({
        key,
        label: date.toLocaleString('en-US', { month: 'short' }),
        week: Math.floor(index / 7),
      })
    }
    return markers
  }, [days])
  const activeDays = days.filter(day => !day.isFuture && day.cost > 0).length
  const [tip, setTip] = useState<{ day: HeatmapDay; x: number; y: number } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToNewestRef = useRef(true)

  // The fixed 26-week grid is wider than the compact hero slot. Start at the
  // newest weeks, then leave the user's scroll position alone.
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return

    const alignNewest = (): void => {
      if (!stickToNewestRef.current) return
      const newestOffset = Math.max(0, scroller.scrollWidth - scroller.clientWidth)
      scroller.scrollLeft = newestOffset
    }

    alignNewest()

    // Electron can mount this card while its parent still has the wider
    // skeleton measurement, then compact it before first paint. Keep observing
    // later resizes too while the user remains pinned to newest; once they
    // deliberately scroll away, their position is left alone.
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(alignNewest)
    observer?.observe(scroller)
    const frame = window.requestAnimationFrame(alignNewest)

    return () => {
      window.cancelAnimationFrame(frame)
      observer?.disconnect()
    }
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
      <div
        className="ov-heatmap-scroll"
        ref={scrollRef}
        role="region"
        aria-label="Scrollable daily activity timeline"
        tabIndex={0}
        onScroll={() => {
          const scroller = scrollRef.current
          if (!scroller) return
          const newestOffset = Math.max(0, scroller.scrollWidth - scroller.clientWidth)
          stickToNewestRef.current = Math.abs(scroller.scrollLeft - newestOffset) <= 1
        }}
      >
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
                aria-label={`${formatDate(day.date)}: ${day.noData ? 'no data recorded' : day.isFuture ? 'future day' : `${formatUsd(day.cost)}, ${day.calls} calls`}`}
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
