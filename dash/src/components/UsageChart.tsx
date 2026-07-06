import { useMemo } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import type { DailyEntry, DeviceUsage } from '@/lib/api'
import { CHART_COLORS, compactUsd, fmtTokens, label, usd } from '@/lib/utils'

export type Unit = 'cost' | 'tokens'

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function fmtDay(d: string): string {
  const [, m, day] = String(d).split('-')
  return m && day ? `${Number(day)} ${MONTHS[Number(m)]}` : d
}

const TOP_N = 6

type Series = { key: string; label: string; color: string }

function makeTooltip(labels: Record<string, string>, fmt: (n: number) => string) {
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
              <span className="tabular-nums text-muted-foreground">{fmt(p.value)}</span>
            </div>
          ))}
          <div className="mt-1 flex items-center justify-between border-t border-border pt-1 text-foreground">
            <span>Total</span>
            <span className="font-semibold tabular-nums">{fmt(total)}</span>
          </div>
        </div>
      </div>
    )
  }
}

function StackedBars({
  rows,
  series,
  labels,
  unit,
}: {
  rows: Array<Record<string, number | string>>
  series: Series[]
  labels: Record<string, string>
  unit: Unit
}) {
  const fmt = unit === 'tokens' ? fmtTokens : usd
  const axisFmt = (v: number | string) => (unit === 'tokens' ? fmtTokens(Number(v)) : compactUsd(Number(v)))
  const Tip = makeTooltip(labels, fmt)
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
            tickFormatter={axisFmt}
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

// Spend (or tokens) per day, stacked by model (single device).
export function UsageChart({ daily, unit = 'cost' }: { daily: DailyEntry[]; unit?: Unit }) {
  const { rows, series, labels } = useMemo(() => {
    const measure = (m: { cost: number; inputTokens: number; outputTokens: number }) =>
      unit === 'tokens' ? m.inputTokens + m.outputTokens : m.cost
    const totals = new Map<string, number>()
    for (const d of daily) for (const m of d.topModels) totals.set(m.name, (totals.get(m.name) ?? 0) + measure(m))
    const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_N).map(([k]) => k)
    const topSet = new Set(top)
    const hasOther = [...totals.keys()].some((k) => !topSet.has(k))
    const keys = hasOther ? [...top, 'Other'] : top
    const rowData = daily.map((d) => {
      const row: Record<string, number | string> = { period: d.date }
      for (const k of keys) row[k] = 0
      for (const m of d.topModels) {
        const key = topSet.has(m.name) ? m.name : 'Other'
        row[key] = (row[key] as number) + measure(m)
      }
      return row
    })
    const series: Series[] = keys.map((k, i) => ({ key: k, label: label(k), color: CHART_COLORS[i % CHART_COLORS.length]! }))
    const labels = Object.fromEntries(series.map((s) => [s.key, s.label]))
    return { rows: rowData, series, labels }
  }, [daily, unit])

  return <StackedBars rows={rows} series={series} labels={labels} unit={unit} />
}

// Spend (or tokens) per day, stacked by device (one color per device) for the All view.
export function DeviceUsageChart({ devices, unit = 'cost' }: { devices: DeviceUsage[]; unit?: Unit }) {
  const { rows, series, labels } = useMemo(() => {
    const named = devices.filter((d) => d.payload)
    const dailyOf = (d: DeviceUsage) => d.payload?.history?.daily ?? []
    // Stable key + color per device (by unique id) so a device keeps its color
    // and its bars don't remount when another device drops/returns between
    // polls, and two devices sharing a hostname never collide.
    const keyOf = (d: DeviceUsage) => 'dev_' + d.id.replace(/[^a-zA-Z0-9]/g, '_')
    const colorOf = (id: string) => {
      let h = 0
      for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
      return CHART_COLORS[Math.abs(h) % CHART_COLORS.length]!
    }
    const dates = [...new Set(named.flatMap((d) => dailyOf(d).map((e) => e.date)))].sort((a, b) => a.localeCompare(b))
    const series: Series[] = named.map((d) => ({
      key: keyOf(d),
      label: d.name + (d.local ? ' (this Mac)' : ''),
      color: colorOf(d.id),
    }))
    const rowData = dates.map((date) => {
      const row: Record<string, number | string> = { period: date }
      named.forEach((d) => {
        const e = dailyOf(d).find((x) => x.date === date)
        row[keyOf(d)] = e ? (unit === 'tokens' ? e.inputTokens + e.outputTokens : e.cost) : 0
      })
      return row
    })
    const labels = Object.fromEntries(series.map((s) => [s.key, s.label]))
    return { rows: rowData, series, labels }
  }, [devices, unit])

  return <StackedBars rows={rows} series={series} labels={labels} unit={unit} />
}
