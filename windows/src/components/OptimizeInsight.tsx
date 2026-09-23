import { useState } from 'react'
import type { MenubarPayload, RetryTax, RoutingWaste } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { formatCompactCurrency, plural } from '../lib/currency'
import { ChevronRight, RetryIcon, RouteIcon } from './Icons'

/// Port of OptimizeInsight in mac/.../Views/HeatmapSection.swift: the two kinds of spend the
/// CLI can name as avoidable. Retry tax is the spend on edit turns that needed a retry; routing waste is what the
/// same edits would have cost on a cheaper model. They are shown apart because they are
/// different decisions, and their sum is only a headline.

export function OptimizeInsight({ payload, currency }: { payload: MenubarPayload; currency: CurrencyState }) {
  const retryTax = payload.current.retryTax
  const routingWaste = payload.current.routingWaste
  const cost = payload.current.cost
  const totalWaste = (retryTax?.totalUSD ?? 0) + (routingWaste?.totalSavingsUSD ?? 0)

  if (totalWaste <= 0) {
    return (
      <div className="optimize-empty">
        Nothing to optimize in this period. No retries and no calls that a cheaper model
        would have handled.
      </div>
    )
  }

  return (
    <div className="optimize-insight">
      {cost > 0 && (
        <div className="insight-header optimize-headline">
          <div>
            <div className="insight-sublabel">Potential savings</div>
            <div className="optimize-total">{formatCompactCurrency(totalWaste, currency)}</div>
          </div>
          <div className="optimize-share">
            <div className="optimize-share-pct">{Math.round((totalWaste / cost) * 100)}% of spend</div>
            <div className="optimize-share-note">could be optimized</div>
          </div>
        </div>
      )}
      <RetryTaxRow retryTax={retryTax} totalCost={cost} currency={currency} />
      <RoutingWasteRow routingWaste={routingWaste} totalCost={cost} currency={currency} />
    </div>
  )
}

function RetryTaxRow({ retryTax, totalCost, currency }: {
  retryTax: RetryTax | undefined
  totalCost: number
  currency: CurrencyState
}) {
  const [expanded, setExpanded] = useState(false)
  if (!retryTax || retryTax.totalUSD <= 0) return null

  return (
    <div className="waste-block is-retry">
      <button type="button" className="waste-head" aria-expanded={expanded} onClick={() => setExpanded(e => !e)}>
        <RetryIcon size={9} className="waste-icon" />
        <span className="waste-title">Retry tax</span>
        <span className="waste-spacer" />
        <span className="waste-total">{formatCompactCurrency(retryTax.totalUSD, currency)}</span>
        {totalCost > 0 && (
          <span className="waste-share">({Math.round((retryTax.totalUSD / totalCost) * 100)}%)</span>
        )}
        <ChevronRight size={7} className={`chevron ${expanded ? 'chevron-open' : ''}`} />
      </button>
      <div className="waste-note">
        {plural(retryTax.retries, 'retry', 'retries')} across {plural(retryTax.editTurns, 'retried edit')}
      </div>
      {expanded && (
        <div className="waste-rows">
          {retryTax.byModel.map(model => (
            <div key={model.name} className="waste-row">
              <span className="waste-row-name">{model.name}</span>
              <span className="waste-spacer" />
              {model.retriesPerEdit != null && (
                <span className="waste-row-note">{model.retriesPerEdit.toFixed(1)} ret/edit</span>
              )}
              <span className="waste-row-value">{formatCompactCurrency(model.taxUSD, currency)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function RoutingWasteRow({ routingWaste, totalCost, currency }: {
  routingWaste: RoutingWaste | undefined
  totalCost: number
  currency: CurrencyState
}) {
  const [expanded, setExpanded] = useState(false)
  if (!routingWaste || routingWaste.totalSavingsUSD <= 0) return null

  return (
    <div className="waste-block is-routing">
      <button type="button" className="waste-head" aria-expanded={expanded} onClick={() => setExpanded(e => !e)}>
        <RouteIcon size={9} className="waste-icon" />
        <span className="waste-title">Routing waste</span>
        <span className="waste-spacer" />
        <span className="waste-total">{formatCompactCurrency(routingWaste.totalSavingsUSD, currency)}</span>
        {totalCost > 0 && (
          <span className="waste-share">({Math.round((routingWaste.totalSavingsUSD / totalCost) * 100)}%)</span>
        )}
        <ChevronRight size={7} className={`chevron ${expanded ? 'chevron-open' : ''}`} />
      </button>
      {routingWaste.baselineModel !== '' && (
        <div className="waste-note">
          vs {routingWaste.baselineModel} @ {formatCompactCurrency(routingWaste.baselineCostPerEdit, currency)}/edit
        </div>
      )}
      {expanded && (
        <div className="waste-rows">
          {routingWaste.byModel.map(model => (
            <div key={model.name} className="waste-row">
              <span className="waste-row-name">{model.name}</span>
              <span className="waste-spacer" />
              <span className="waste-row-note">{formatCompactCurrency(model.costPerEdit, currency)}/edit</span>
              <span className="waste-row-value">{formatCompactCurrency(model.savingsUSD, currency)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
