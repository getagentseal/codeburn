import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { formatUsd } from '../lib/format'
import { localDateKey } from '../lib/period'
import type { DailyHistoryEntry } from '../lib/types'

type HeatmapDay = {
  date: string
  cost: number
  calls: number
  level: number
  isFuture: boolean
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
    const isFuture = date > today
    const entry = byDate.get(localDateKey(date))
    const cost = isFuture ? 0 : (entry?.cost ?? 0)
    return {
      date: localDateKey(date),
      cost,
      calls: isFuture ? 0 : (entry?.calls ?? 0),
      level: intensityLevel(cost, maxCost),
      isFuture,
    }
  })
}

export function ActivityHeatmap({ daily, bare = false }: { daily: DailyHistoryEntry[]; bare?: boolean }) {
  const days = useMemo(() => buildHeatmapDays(daily, new Date()), [daily])
  const activeDays = days.filter(day => !day.isFuture && day.cost > 0).length
  const [tip, setTip] = useState<{ day: HeatmapDay; x: number; y: number } | null>(null)
  const [tipPosition, setTipPosition] = useState<{ left: number; top: number } | null>(null)
  const tipRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!tip) {
      setTipPosition(null)
      return
    }
    const width = tipRef.current?.offsetWidth ?? 180
    const height = tipRef.current?.offsetHeight ?? 58
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

  const head = (
    <div className={bare ? 'ov-activity-head' : 'ov-panel-head'}>
      {bare ? <span className="ov-label">Daily activity</span> : <h3>Daily activity</h3>}
      <span className="r ov-active-days">{activeDays} active days</span>
    </div>
  )
  const grid = (
    <div className="ov-heatmap-scroll">
      <div className="ov-heatmap" role="grid" aria-label="Daily activity contribution heatmap">
        <div className="ov-heatmap-labels" aria-hidden="true">
          {WEEKDAYS.map((weekday, index) => (
            <span key={weekday}>{index === 1 || index === 3 || index === 5 ? weekday : ''}</span>
          ))}
        </div>
        <div className="ov-heatmap-cells">
          {days.map(day => (
            <button
              type="button"
              role="gridcell"
              key={day.date}
              className={`ov-heat-cell heat-level-${day.level}${day.isFuture ? ' future' : ''}`}
              aria-label={`${formatDate(day.date)}: ${day.isFuture ? 'future day' : `${formatUsd(day.cost)}, ${day.calls} calls`}`}
              data-date={day.date}
              data-cost={day.cost}
              data-active={!day.isFuture && day.cost > 0 ? 'true' : 'false'}
              onMouseEnter={event => setTip({ day, x: event.clientX, y: event.clientY })}
              onMouseMove={event => setTip({ day, x: event.clientX, y: event.clientY })}
              onMouseLeave={() => setTip(null)}
            />
          ))}
        </div>
      </div>
    </div>
  )
  const tooltip = tip
    ? createPortal(
        <div
          ref={tipRef}
          className={`chart-tip${tipPosition ? ' on' : ''}`}
          style={{ position: 'fixed', ...(tipPosition ?? { left: 0, top: 0 }) }}
          role="tooltip"
        >
          <div className="chart-tip-d">{formatDate(tip.day.date)}</div>
          <div className="chart-tip-v">{tip.day.isFuture ? 'Future day' : formatUsd(tip.day.cost)}</div>
          <div className="chart-tip-s">{tip.day.isFuture ? 'No activity yet' : `${tip.day.calls} calls`}</div>
        </div>,
        document.body,
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
