import { useState } from 'react'
import type { MenubarPayload } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { formatCompactCurrency } from '../lib/currency'

type Props = {
  payload: MenubarPayload
  currency: CurrencyState
}

export function ActivitySection({ payload, currency }: Props) {
  const [expanded, setExpanded] = useState(true)
  const activities = payload.current.topActivities
  if (activities.length === 0) return null

  const maxCost = Math.max(...activities.map(a => a.cost), 0.01)

  return (
    <section className="activity-section">
      <button className="section-header" onClick={() => setExpanded(!expanded)}>
        <div className="section-header-left">
          <span className="section-dot" />
          <span className="section-caption">Activity</span>
        </div>
        <div className="section-header-right">
          <span className="col-header">Cost</span>
          <span className="col-header col-header-sm">Turns</span>
          <span className="col-header col-header-sm">1-shot</span>
          <span className={`chevron ${expanded ? 'chevron-open' : ''}`}>›</span>
        </div>
      </button>

      {expanded && (
        <div className="section-body">
          {activities.map(a => (
            <div key={a.name} className="activity-row">
              <div className="row-bar-container">
                <div
                  className="row-bar-fill"
                  style={{ width: `${Math.max(2, (a.cost / maxCost) * 100)}%` }}
                />
              </div>
              <div className="row-label">{a.name}</div>
              <div className="row-cost">{formatCompactCurrency(a.cost, currency)}</div>
              <div className="row-turns">{a.turns}</div>
              <div className="row-oneshot">
                {a.oneShotRate == null ? '—' : `${Math.round(a.oneShotRate * 100)}%`}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
