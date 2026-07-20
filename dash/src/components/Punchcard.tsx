import { useMemo, useRef, useState } from 'react'

import type { GranularHistory } from '@/lib/api'
import { usd } from '@/lib/utils'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const WEEKDAYS_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const HOURS = Array.from({ length: 24 }, (_, h) => h)

type Cell = { cost: number; covered: boolean }

function pad2(v: number): string {
  return String(v).padStart(2, '0')
}

// Mon-first weekday index from a Date. getDay() is 0=Sun..6=Sat.
function weekdayIndex(d: Date): number {
  return (d.getDay() + 6) % 7
}

// Perceptual ramp: sqrt keeps small spends visible against the largest cell
// instead of collapsing to an invisible dot.
function intensity(cost: number, max: number): number {
  if (max <= 0 || cost <= 0) return 0
  return Math.sqrt(cost / max)
}

export function Punchcard({ timeline }: { timeline: GranularHistory }) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [hover, setHover] = useState<{ x: number; y: number; wd: number; h: number } | null>(null)

  const { grid, max, hasBucket } = useMemo(() => {
    const g: Cell[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ cost: 0, covered: false })))
    let m = 0
    let any = false
    for (const p of timeline.points) {
      const d = new Date(p.timestamp)
      if (!Number.isFinite(d.getTime())) continue
      any = true
      const cell = g[weekdayIndex(d)]![d.getHours()]!
      cell.covered = true
      cell.cost += p.cost > 0 ? p.cost : 0
      if (cell.cost > m) m = cell.cost
    }
    return { grid: g, max: m, hasBucket: any }
  }, [timeline])

  // Buckets coarser than an hour carry no hour-of-day signal: every daily bucket
  // is timestamped at local midnight, so plotting it would assert all spend
  // happened at hour 0. Show the honest limitation instead of a fake column.
  const hourResolved = timeline.bucketMinutes < 1440

  const bucketNote = timeline.bucketMinutes >= 60 ? 'Hourly buckets' : `${timeline.bucketMinutes}-minute buckets`

  if (!hasBucket) {
    return <div className="py-10 text-center text-sm text-tertiary-foreground">No timestamped usage in this period.</div>
  }

  if (!hourResolved) {
    return (
      <div className="py-8 text-center text-sm text-tertiary-foreground">
        Hour-of-day detail needs sub-daily buckets. Switch to Today or 7 days to see the punchcard.
      </div>
    )
  }

  const hovered = hover ? grid[hover.wd]![hover.h]! : null

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-tertiary-foreground">{bucketNote} · local time</span>
        <div className="flex items-center gap-1.5 text-[10px] text-tertiary-foreground">
          <span>Less</span>
          {[0.12, 0.4, 0.7, 1].map((t) => (
            <span
              key={t}
              className="rounded-full"
              style={{
                width: `${5 + t * 7}px`,
                height: `${5 + t * 7}px`,
                background: 'var(--color-primary)',
                opacity: 0.35 + t * 0.65,
              }}
            />
          ))}
          <span>More</span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <div
          ref={wrapRef}
          className="relative min-w-[560px]"
          onMouseLeave={() => setHover(null)}
        >
          {/* Hour axis */}
          <div className="grid items-center" style={{ gridTemplateColumns: '2.25rem repeat(24, minmax(0, 1fr))' }}>
            <span />
            {HOURS.map((h) => (
              <span key={h} className="pb-1 text-center text-[9.5px] tabular-nums text-tertiary-foreground">
                {h % 3 === 0 ? h : ''}
              </span>
            ))}
          </div>

          {/* Weekday rows */}
          {WEEKDAYS.map((wdLabel, wd) => (
            <div
              key={wdLabel}
              className="grid items-center"
              style={{ gridTemplateColumns: '2.25rem repeat(24, minmax(0, 1fr))' }}
            >
              <span className="pr-2 text-right text-[11px] tabular-nums text-tertiary-foreground">{wdLabel}</span>
              {HOURS.map((h) => {
                const cell = grid[wd]![h]!
                const t = intensity(cell.cost, max)
                const active = hover?.wd === wd && hover?.h === h
                return (
                  <div
                    key={h}
                    className="flex aspect-square items-center justify-center p-[2px]"
                    onMouseEnter={(e) => {
                      if (!cell.covered || !wrapRef.current) return
                      const r = wrapRef.current.getBoundingClientRect()
                      setHover({ x: e.clientX - r.left, y: e.clientY - r.top, wd, h })
                    }}
                    onMouseMove={(e) => {
                      if (!cell.covered || !wrapRef.current) return
                      const r = wrapRef.current.getBoundingClientRect()
                      setHover({ x: e.clientX - r.left, y: e.clientY - r.top, wd, h })
                    }}
                  >
                    <div
                      className="flex h-full w-full items-center justify-center rounded-[3px]"
                      style={{ background: cell.covered ? 'var(--color-interactive-secondary)' : 'transparent' }}
                    >
                      {cell.cost > 0 ? (
                        <div
                          className="rounded-full ring-1 ring-inset ring-black/5 transition-transform"
                          style={{
                            width: `${22 + t * 70}%`,
                            height: `${22 + t * 70}%`,
                            background: 'var(--color-primary)',
                            opacity: 0.45 + t * 0.55,
                            transform: active ? 'scale(1.18)' : undefined,
                          }}
                        />
                      ) : cell.covered ? (
                        <div className="h-[3px] w-[3px] rounded-full bg-tertiary-foreground opacity-25" />
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </div>
          ))}

          {hover && hovered && (
            <div
              className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs shadow-xl ring-1 ring-black/5"
              style={{ left: hover.x, top: hover.y - 8 }}
            >
              <div className="font-medium text-foreground">
                {WEEKDAYS_FULL[hover.wd]} {pad2(hover.h)}:00
              </div>
              <div className="tabular-nums text-tertiary-foreground">{usd(hovered.cost)}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
