import type { MenubarPayload, DailyEntry } from './payload'
import { formatDateKey, addDays, startOfDay, firstOfMonth, daysInMonth, dayOfMonth } from './dates'

export type TipItem = { text: string; trailing: string | null }
export type TipGroup = { label: string; icon: string; items: TipItem[] }

function historyStats(history: DailyEntry[]) {
  const now = new Date()
  const today = startOfDay(now)
  const costByDate = new Map(history.map(d => [d.date, d.cost]))

  const lastWeekStart = formatDateKey(addDays(today, -6))
  const priorWeekStart = formatDateKey(addDays(today, -13))
  const priorWeekEnd = formatDateKey(addDays(today, -7))
  const thisWeek = history.filter(d => d.date >= lastWeekStart).reduce((s, d) => s + d.cost, 0)
  const prior = history.filter(d => d.date >= priorWeekStart && d.date <= priorWeekEnd).reduce((s, d) => s + d.cost, 0)
  const weekDelta = prior > 0 ? ((thisWeek - prior) / prior) * 100 : null

  let streak = 0
  for (let i = 0; i < 60; i++) {
    const key = formatDateKey(addDays(today, -i))
    if ((costByDate.get(key) ?? 0) > 0) streak++
    else break
  }

  const fom = firstOfMonth(now)
  const fomStr = formatDateKey(fom)
  const mtd = history.filter(d => d.date >= fomStr).reduce((s, d) => s + d.cost, 0)
  const dom = dayOfMonth(now)
  const projected = dom > 0 ? (mtd / dom) * daysInMonth(now) : null

  const prevMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  const prevFirstStr = formatDateKey(prevMonth)
  const prevLastStr = formatDateKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)))
  const prevEntries = history.filter(d => d.date >= prevFirstStr && d.date <= prevLastStr)
  const prevTotal = prevEntries.length > 0 ? prevEntries.reduce((s, d) => s + d.cost, 0) : null

  return { weekDelta, streak, projected, prevTotal }
}

export function computeTipGroups(payload: MenubarPayload): TipGroup[] {
  const stats = historyStats(payload.history.daily)
  const { cacheHitPercent, oneShotRate } = payload.current

  const wins: TipItem[] = []
  if (cacheHitPercent >= 80) wins.push({ text: `Cache hit at ${Math.round(cacheHitPercent)}% — most prompts reuse cache`, trailing: null })
  if (oneShotRate != null && oneShotRate >= 0.75) wins.push({ text: `${Math.round(oneShotRate * 100)}% one-shot — edits landing first try`, trailing: null })
  if (stats.weekDelta != null && stats.weekDelta < -10) wins.push({ text: `Spend down ${Math.round(Math.abs(stats.weekDelta))}% vs last 7 days`, trailing: null })
  if (stats.streak >= 5) wins.push({ text: `${stats.streak}-day usage streak`, trailing: null })

  const improvements: TipItem[] = payload.optimize.topFindings.slice(0, 3).map(f => ({
    text: f.title,
    trailing: `$${f.savingsUSD.toFixed(2)}`,
  }))

  const risks: TipItem[] = []
  if (stats.weekDelta != null && stats.weekDelta > 25) risks.push({ text: `Spend up ${Math.round(stats.weekDelta)}% vs prior 7 days`, trailing: null })
  if (cacheHitPercent > 0 && cacheHitPercent < 50) risks.push({ text: `Cache hit only ${Math.round(cacheHitPercent)}% — paying for cold prompts`, trailing: null })
  if (oneShotRate != null && oneShotRate < 0.5) risks.push({ text: `${Math.round(oneShotRate * 100)}% one-shot — lots of iteration`, trailing: null })
  if (stats.projected != null && stats.prevTotal != null && stats.projected > stats.prevTotal * 1.3) {
    const pct = Math.round(((stats.projected - stats.prevTotal) / stats.prevTotal) * 100)
    risks.push({ text: `On pace for $${stats.projected.toFixed(2)} this month (+${pct}% vs last)`, trailing: null })
  }

  return [
    { label: "What's working", icon: '✓', items: wins },
    { label: 'What to improve', icon: '↗', items: improvements },
    { label: 'Risks', icon: '⚠', items: risks },
  ]
}
