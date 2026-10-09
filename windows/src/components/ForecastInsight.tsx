import type { DailyEntry } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { formatCurrency, formatCompactCurrency } from '../lib/currency'
import { computeHistoryStats } from '../lib/history'
import { ArrowUpRight, ArrowDownRight } from './Icons'
import { t } from '../i18n/index'

const WEEK_DAYS = 7

type Props = {
  days: DailyEntry[]
  currency: CurrencyState
}

export function ForecastInsight({ days, currency }: Props) {
  const s = computeHistoryStats(days)
  const prevDelta = s.previousMonthTotal && s.previousMonthTotal > 0
    ? ((s.monthProjection - s.previousMonthTotal) / s.previousMonthTotal) * 100
    : null

  return (
    <div className="forecast-insight">
      <div className="insight-header">
        <div>
          <div className="insight-sublabel">{t('Month-to-date')}</div>
          <div className="forecast-mtd">{formatCurrency(s.monthToDate, currency)}</div>
        </div>
        <div className="forecast-right">
          <div className="insight-sublabel">{t('On pace for')}</div>
          <div className="forecast-projection">{formatCurrency(s.monthProjection, currency)}</div>
        </div>
      </div>

      <div className="mini-stats">
        <div className="mini-stat">
          <div className="mini-stat-label">{t('Avg/day (this wk)')}</div>
          <div className="mini-stat-value">{formatCompactCurrency(s.weekTotal / WEEK_DAYS, currency)}</div>
        </div>
        <div className="mini-stat">
          <div className="mini-stat-label">{t('Yesterday')}</div>
          <div className="mini-stat-value">{formatCompactCurrency(s.yesterday, currency)}</div>
        </div>
        <div className="mini-stat">
          <div className="mini-stat-label">{t('Last 7d')}</div>
          <div className="mini-stat-value">{formatCompactCurrency(s.weekTotal, currency)}</div>
        </div>
      </div>

      {prevDelta !== null && s.previousMonthTotal !== null && (
        <div className="delta-badge delta-badge-block">
          {prevDelta >= 0 ? <ArrowUpRight size={9} /> : <ArrowDownRight size={9} />}
          <span>
            {prevDelta >= 0 ? '+' : ''}{Math.round(prevDelta)}% vs last month
            ({formatCompactCurrency(s.previousMonthTotal, currency)})
          </span>
        </div>
      )}
    </div>
  )
}
