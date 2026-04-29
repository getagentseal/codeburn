import type { MenubarPayload } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { formatCurrency, formatCompactCurrency } from '../lib/currency'
import { formatDateKey, addDays, startOfDay, firstOfMonth, daysInMonth } from '../lib/dates'

type Props = {
  payload: MenubarPayload
  currency: CurrencyState
}

function computeStats(payload: MenubarPayload, currency: CurrencyState) {
  const history = payload.history.daily
  const now = new Date()
  const today = startOfDay(now)

  const favoriteModel = payload.current.topModels[0]?.name ?? '—'

  const fom = firstOfMonth(now)
  const fomStr = formatDateKey(fom)
  const mtdActive = history.filter(d => d.date >= fomStr && d.cost > 0).length
  const activeDaysFraction = `${mtdActive}/${daysInMonth(now)}`

  const peak = history.reduce<{ date: string; cost: number } | null>(
    (best, d) => (!best || d.cost > best.cost) ? d : best, null
  )
  const mostActiveDay = peak && peak.cost > 0
    ? new Date(peak.date + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    : '—'
  const peakDaySpend = peak && peak.cost > 0 ? formatCompactCurrency(peak.cost, currency) : '—'

  const costByDate = new Map(history.map(d => [d.date, d.cost]))
  let currentStreak = 0
  for (let i = 0; i < 400; i++) {
    const key = formatDateKey(addDays(today, -i))
    if ((costByDate.get(key) ?? 0) > 0) currentStreak++
    else break
  }

  let longestStreak = 0
  let running = 0
  if (history.length > 0) {
    const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date))
    const first = new Date(sorted[0].date + 'T00:00:00Z')
    const last = addDays(today, 0)
    const totalDays = Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1
    for (let i = 0; i < totalDays; i++) {
      const key = formatDateKey(addDays(first, i))
      if ((costByDate.get(key) ?? 0) > 0) {
        running++
        longestStreak = Math.max(longestStreak, running)
      } else {
        running = 0
      }
    }
  }

  const lifetimeTotal = history.length > 0 ? history.reduce((s, d) => s + d.cost, 0) : null

  return {
    favoriteModel,
    activeDaysFraction,
    mostActiveDay,
    peakDaySpend,
    currentStreak: currentStreak > 0 ? `${currentStreak} days` : '—',
    longestStreak: longestStreak > 0 ? `${longestStreak} days` : '—',
    lifetimeTotal,
    historyDayCount: history.length,
  }
}

export function StatsInsight({ payload, currency }: Props) {
  const s = computeStats(payload, currency)

  return (
    <div className="stats-insight">
      <div className="stats-grid">
        <div className="stats-col">
          <StatRow label="Favorite model" value={s.favoriteModel} />
          <StatRow label="Active days (month)" value={s.activeDaysFraction} />
          <StatRow label="Most active day" value={s.mostActiveDay} />
          <StatRow label="Peak day spend" value={s.peakDaySpend} />
        </div>
        <div className="stats-col">
          <StatRow label="Sessions today" value={`${payload.current.sessions}`} />
          <StatRow label="Calls today" value={payload.current.calls.toLocaleString()} />
          <StatRow label="Current streak" value={s.currentStreak} />
          <StatRow label="Longest streak" value={s.longestStreak} />
        </div>
      </div>
      {s.lifetimeTotal !== null && (
        <div className="stats-lifetime">
          <span className="stats-lifetime-label">
            Tracked spend (last {s.historyDayCount} days)
          </span>
          <span className="stats-lifetime-value">
            {formatCurrency(s.lifetimeTotal, currency)}
          </span>
        </div>
      )}
    </div>
  )
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-row">
      <div className="stat-row-label">{label}</div>
      <div className="stat-row-value">{value}</div>
    </div>
  )
}
