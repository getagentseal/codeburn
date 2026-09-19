import { useMemo, useRef, useState } from 'react'

import { t } from '../i18n'
import { formatUsd } from '../lib/format'
import type { MenubarPayload } from '../lib/types'

type Timeline = NonNullable<MenubarPayload['history']['timeline']>

function weekdays(): string[] {
  return [
    t('shared.weekday.mon'),
    t('shared.weekday.tue'),
    t('shared.weekday.wed'),
    t('shared.weekday.thu'),
    t('shared.weekday.fri'),
    t('shared.weekday.sat'),
    t('shared.weekday.sun'),
  ]
}
function weekdaysFull(): string[] {
  return [
    t('shared.weekdayFull.mon'),
    t('shared.weekdayFull.tue'),
    t('shared.weekdayFull.wed'),
    t('shared.weekdayFull.thu'),
    t('shared.weekdayFull.fri'),
    t('shared.weekdayFull.sat'),
    t('shared.weekdayFull.sun'),
  ]
}
const HOURS = Array.from({ length: 24 }, (_, h) => h)

type Cell = { cost: number; covered: boolean }

// Mon-first weekday index; getDay() is 0=Sun..6=Sat.
function weekdayIndex(d: Date): number {
  return (d.getDay() + 6) % 7
}

// Perceptual ramp: sqrt keeps small spends visible against the largest cell.
function intensity(cost: number, max: number): number {
  if (max <= 0 || cost <= 0) return 0
  return Math.sqrt(cost / max)
}

/** Hour-of-day × weekday spend matrix, computed client-side from the granular
 *  timeline. Mirrors the web dashboard's punchcard, restyled to the app's
 *  tokens. Honesty rules shared with the web version: empty cells stay empty,
 *  and coarser-than-hourly buckets (daily timestamps at midnight) show the
 *  limitation instead of a fake midnight column. */
export function Punchcard({ timeline }: { timeline: Timeline }) {
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

  const hourResolved = timeline.bucketMinutes < 1440
  if (!hasBucket) {
    return <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 'var(--fs-meta)', color: 'var(--mut)' }}>{t('shared.punchcard.noTimestamped')}</div>
  }
  if (!hourResolved) {
    return (
      <div style={{ padding: '24px 0', textAlign: 'center', fontSize: 'var(--fs-meta)', color: 'var(--mut)' }}>
        {t('shared.punchcard.hourlyNeeded')}
      </div>
    )
  }

  const hovered = hover ? grid[hover.wd]![hover.h]! : null
  const gridCols = { display: 'grid', gridTemplateColumns: '2.25rem repeat(24, minmax(0, 1fr))', alignItems: 'center' } as const
  const weekdayLabels = weekdays()

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontSize: 'var(--fs-micro)', fontWeight: 'var(--fw-medium)' as never, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--mut)' }}>
          {timeline.bucketMinutes >= 60 ? t('shared.punchcard.hourlyBuckets') : t('shared.punchcard.minuteBuckets', { minutes: timeline.bucketMinutes })} · {t('shared.punchcard.localTime')}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-micro)', color: 'var(--mut)' }}>
          {t('shared.punchcard.less')}
          {[0.12, 0.4, 0.7, 1].map(dot => (
            <span key={dot} style={{ width: 5 + dot * 7, height: 5 + dot * 7, borderRadius: '50%', background: 'var(--accent)', opacity: 0.35 + dot * 0.65 }} />
          ))}
          {t('shared.punchcard.more')}
        </span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <div ref={wrapRef} style={{ position: 'relative', minWidth: 560 }} onMouseLeave={() => setHover(null)}>
          <div style={gridCols}>
            <span />
            {HOURS.map(h => (
              <span key={h} style={{ paddingBottom: 3, textAlign: 'center', fontSize: 'var(--fs-micro)', fontVariantNumeric: 'tabular-nums', color: 'var(--mut)' }}>
                {h % 3 === 0 ? h : ''}
              </span>
            ))}
          </div>
          {weekdayLabels.map((wdLabel, wd) => (
            <div key={wd} style={gridCols}>
              <span style={{ paddingRight: 8, textAlign: 'right', fontSize: 'var(--fs-micro)', fontVariantNumeric: 'tabular-nums', color: 'var(--mut)' }}>{wdLabel}</span>
              {HOURS.map(h => {
                const cell = grid[wd]![h]!
                const t = intensity(cell.cost, max)
                const active = hover?.wd === wd && hover?.h === h
                const track = (event: React.MouseEvent) => {
                  if (!cell.covered || !wrapRef.current) return
                  const r = wrapRef.current.getBoundingClientRect()
                  // Clamp x so the centered tooltip never crops at the strip's
                  // edges; the y flip below handles the top rows.
                  const x = Math.min(Math.max(event.clientX - r.left, 70), r.width - 70)
                  setHover({ x, y: event.clientY - r.top, wd, h })
                }
                return (
                  <div key={h} style={{ aspectRatio: '1', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 2 }} onMouseEnter={track} onMouseMove={track}>
                    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 3, background: cell.covered ? 'var(--hover)' : 'transparent' }}>
                      {cell.cost > 0 ? (
                        <div style={{
                          width: `${22 + t * 70}%`, height: `${22 + t * 70}%`, borderRadius: '50%',
                          background: 'var(--accent)', opacity: 0.45 + t * 0.55,
                          transform: active ? 'scale(1.18)' : undefined, transition: 'transform 120ms',
                        }} />
                      ) : cell.covered ? (
                        <div style={{ width: 3, height: 3, borderRadius: '50%', background: 'var(--mut)', opacity: 0.25 }} />
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
          {hover && hovered && (
            <div style={{
              pointerEvents: 'none', position: 'absolute', zIndex: 10, left: hover.x,
              // Top rows flip the tooltip BELOW the cursor: the scroll
              // container clips anything above its own top edge.
              top: hover.y < 56 ? hover.y + 14 : hover.y - 8,
              transform: hover.y < 56 ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
              borderRadius: 8, border: '1px solid var(--line)',
              background: 'var(--bg)', padding: '5px 10px', fontSize: 'var(--fs-meta)', boxShadow: 'var(--card-shadow)',
            }}>
              <div style={{ fontWeight: 'var(--fw-medium)' as never, color: 'var(--ink)' }}>{weekdaysFull()[hover.wd]} {String(hover.h).padStart(2, '0')}:00</div>
              <div style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--mut)' }}>{formatUsd(hovered.cost)}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
