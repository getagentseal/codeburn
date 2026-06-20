import { useMemo } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import type { DailyEntry, DeviceUsage } from '@/lib/api'
import { CHART_COLORS, compactUsd, label, usd } from '@/lib/utils'

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function fmtDay(d: string): string {
  const [, m, day] = String(d).split('-')
  return m && day ? `${Number(day)} ${MONTHS[Number(m)]}` : d
}

const TOP_N = 6

type Series = { key: string; label: string; color: string }

function makeTooltip(labels: Record<string, string>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function ChartTooltip({ active, payload, label: lbl }: any) {
    if (!active || !payload?.length) return null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = payload.filter((p: any) => p.value > 0).sort((a: any, b: any) => b.value - a.value)
    if (!items.length) return null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const total = items.reduce((s: number, p: any) => s + p.value, 0)
    return (
      <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-xl ring-1 ring-black/5">
        <div className="mb-1.5 font-medium text-foreground">{fmtDay(String(lbl))}</div>
        <div className="flex flex-col gap-1">
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          {items.slice(0, 6).map((p: any) => (
            <div key={p.dataKey} className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: p.color }} />
              <span className="flex-1 truncate text-tertiary-foreground">{labels[String(p.dataKey)] ?? String(p.dataKey)}</span>
              <span className="tabular-nums text-muted-foreground">{usd(p.value)}</span>
            </div>
          ))}
          <div className="mt-1 flex items-center justify-between border-t border-border pt-1 text-foreground">
            <span>Total</span>
            <span className="font-semibold tabular-nums">{usd(total)}</span>
          </div>
        </div>
      </div>
    )
  }
}

function StackedBars({ rows, series, labels }: { rows: Array<Record<string, number | string>>; series: Series[]; labels: Record<string, string> }) {
  const Tip = makeTooltip(labels)
  return (
    <div className="relative h-full w-full [&_.recharts-bar-rectangle]:transition-opacity [&_.recharts-bar-rectangle]:duration-75 [&:has(.recharts-bar-rectangle:hover)_.recharts-bar-rectangle:not(:hover)]:opacity-40">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -6 }} barCategoryGap="16%">
          <CartesianGrid vertical={false} strokeDasharray="2 2" stroke="var(--color-chart-grid-stroke)" />
          <XAxis
            dataKey="period"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            interval="equidistantPreserveStart"
            tick={{ fontSize: 11, fill: 'var(--color-tertiary-foreground)' }}
            tickFormatter={fmtDay}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={50}
            tick={{ fontSize: 11, fill: 'var(--color-tertiary-foreground)' }}
            tickFormatter={(v) => compactUsd(Number(v))}
          />
          <Tooltip cursor={{ fill: 'rgba(0,0,0,0.04)' }} content={<Tip />} />
          {series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              stackId="a"
              fill={s.color}
              isAnimationActive={false}
              radius={i === series.length - 1 ? [3, 3, 0, 0] : undefined}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// Spend per day, stacked by model (single device).
export function UsageChart({ daily }: { daily: DailyEntry[] }) {
  const { rows, series, labels } = useMemo(() => {
    const totals = new Map<string, number>()
    for (const d of daily) for (const m of d.topModels) totals.set(m.name, (totals.get(m.name) ?? 0) + m.cost)
    const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_N).map(([k]) => k)
    const topSet = new Set(top)
    const hasOther = [...totals.keys()].some((k) => !topSet.has(k))
    const keys = hasOther ? [...top, 'Other'] : top
    const rowData = daily.map((d) => {
      const row: Record<string, number | string> = { period: d.date }
      for (const k of keys) row[k] = 0
      for (const m of d.topModels) {
        const key = topSet.has(m.name) ? m.name : 'Other'
        row[key] = (row[key] as number) + m.cost
      }
      return row
    })
    const series: Series[] = keys.map((k, i) => ({ key: k, label: label(k), color: CHART_COLORS[i % CHART_COLORS.length]! }))
    const labels = Object.fromEntries(series.map((s) => [s.key, s.label]))
    return { rows: rowData, series, labels }
  }, [daily])

  return <StackedBars rows={rows} series={series} labels={labels} />
}

// Spend per day, stacked by device (one color per device) for the All view.
export function DeviceUsageChart({ devices }: { devices: DeviceUsage[] }) {
  const { rows, series, labels } = useMemo(() => {
    const named = devices.filter((d) => d.payload)
    const dates = [...new Set(named.flatMap((d) => d.payload!.history.daily.map((e) => e.date)))].sort((a, b) => a.localeCompare(b))
    const series: Series[] = named.map((d, i) => ({
      key: `d${i}`,
      label: d.name + (d.local ? ' (this Mac)' : ''),
      color: CHART_COLORS[i % CHART_COLORS.length]!,
    }))
    const rowData = dates.map((date) => {
      const row: Record<string, number | string> = { period: date }
      named.forEach((d, i) => {
        const e = d.payload!.history.daily.find((x) => x.date === date)
        row[`d${i}`] = e ? e.cost : 0
      })
      return row
    })
    const labels = Object.fromEntries(series.map((s) => [s.key, s.label]))
    return { rows: rowData, series, labels }
  }, [devices])

  return <StackedBars rows={rows} series={series} labels={labels} />
}
