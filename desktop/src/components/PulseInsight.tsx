import type { MenubarPayload } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { formatCompactCurrency } from '../lib/currency'

type Props = {
  payload: MenubarPayload
  currency: CurrencyState
}

export function PulseInsight({ payload, currency }: Props) {
  const { cacheHitPercent, oneShotRate, cost, sessions } = payload.current
  const cacheText = cacheHitPercent <= 0 ? '-' : `${Math.round(cacheHitPercent)}%`
  const oneShotText = oneShotRate == null ? '-' : `${Math.round(oneShotRate * 100)}%`
  const costPerSession = sessions > 0 ? formatCompactCurrency(cost / sessions, currency) : '-'

  return (
    <div className="pulse-tiles">
      <div className="pulse-tile">
        <div className="pulse-label">Cache hit</div>
        <div className="pulse-value pulse-value-accent">{cacheText}</div>
      </div>
      <div className="pulse-tile">
        <div className="pulse-label">1-shot</div>
        <div className="pulse-value pulse-value-accent">{oneShotText}</div>
      </div>
      <div className="pulse-tile">
        <div className="pulse-label">Cost / session</div>
        <div className="pulse-value">{costPerSession}</div>
      </div>
    </div>
  )
}
