import type { MenubarPayload } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { formatCompactCurrency } from '../lib/currency'
import { formatSessionAveragePlaceholder, sessionCountIsExact } from '../lib/session-count-label'
import { PencilLineIcon } from './Icons'

type Props = {
  payload: MenubarPayload
  currency: CurrencyState
}

export function PulseInsight({ payload, currency }: Props) {
  const { cacheHitPercent, oneShotRate, cost, sessions, sessionCountBasis } = payload.current
  const cacheText = cacheHitPercent <= 0 ? '-' : `${Math.round(cacheHitPercent)}%`
  const oneShotText = oneShotRate == null ? '-' : `${Math.round(oneShotRate * 100)}%`
  const costPerSession = sessionCountIsExact(sessionCountBasis) && sessions > 0
    ? formatCompactCurrency(cost / sessions, currency)
    : formatSessionAveragePlaceholder()

  return (
    <div className="pulse">
      <div className="pulse-tiles">
        <div className="pulse-tile">
          <div className="pulse-label">Cache hit</div>
          <div className="pulse-value pulse-value-accent">{cacheText}</div>
        </div>
        <div className="pulse-tile">
          <div className="pulse-label">1-shot</div>
          <div className={`pulse-value ${oneShotRate == null ? '' : 'pulse-value-accent'}`}>{oneShotText}</div>
        </div>
        <div className="pulse-tile">
          <div className="pulse-label">Cost / session</div>
          <div className="pulse-value">{costPerSession}</div>
        </div>
      </div>
      <CostPerEdit payload={payload} currency={currency} />
    </div>
  )
}

/// The mac's CostPerEditCaption: what an accepted edit costs on the cheapest model of the
/// period, and on the dearest when that is a different model. It is the line that turns the
/// three tiles above into a decision, which is why it sits with them.
function CostPerEdit({ payload, currency }: Props) {
  const ranked = (payload.current.modelEfficiency ?? [])
    .filter((m): m is { name: string; costPerEdit: number; oneShotRate: number | null } =>
      typeof m.costPerEdit === 'number' && m.costPerEdit > 0)
    .sort((a, b) => a.costPerEdit - b.costPerEdit)
  const best = ranked[0]
  if (!best) return null
  const worst = ranked.length > 1 ? ranked[ranked.length - 1] : null

  return (
    <div className="pulse-cpe">
      <PencilLineIcon size={9} />
      <span className="pulse-cpe-label">Cost/edit</span>
      <span className="pulse-cpe-figure pulse-cpe-best">{perEdit(best.costPerEdit, currency)}</span>
      <span className="pulse-cpe-model">{best.name}</span>
      {worst && worst.name !== best.name && (
        <>
          <span className="pulse-cpe-dash">-</span>
          <span className="pulse-cpe-figure">{perEdit(worst.costPerEdit, currency)}</span>
          <span className="pulse-cpe-model">{worst.name}</span>
        </>
      )}
    </div>
  )
}

/// Three decimals under a cent, as on the mac: a model costing a tenth of a cent an edit and
/// one costing nine of them both read as $0.00 otherwise, which is the comparison this line
/// exists to make.
function perEdit(usd: number, currency: CurrencyState): string {
  const converted = usd * currency.rate
  return `${currency.symbol}${converted.toFixed(converted < 0.01 ? 3 : 2)}`
}
