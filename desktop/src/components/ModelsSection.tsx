import { useState } from 'react'
import type { Model } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { formatCompactCurrency } from '../lib/currency'

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

type Props = {
  models: Model[]
  inputTokens: number
  outputTokens: number
  cacheHitPercent: number
  currency: CurrencyState
}

export function ModelsSection({ models, inputTokens, outputTokens, cacheHitPercent, currency }: Props) {
  const [expanded, setExpanded] = useState(true)

  if (models.length === 0) return null

  const maxCost = Math.max(...models.map(m => m.cost))

  return (
    <section className="models-section">
      <button className="section-header" onClick={() => setExpanded(!expanded)}>
        <span className="section-dot" />
        <span className="section-caption">Models</span>
        {expanded && (
          <span className="section-columns">
            <span>Cost</span>
            <span>Calls</span>
          </span>
        )}
        <span className={`chevron ${expanded ? 'chevron-open' : ''}`}>&#9656;</span>
      </button>

      {expanded && (
        <>
          {models.map(m => {
            const fillPct = maxCost > 0 ? (m.cost / maxCost) * 100 : 0
            return (
              <div key={m.name} className="model-row">
                <div className="row-bar-container">
                  <div className="row-bar-fill" style={{ width: `${fillPct}%` }} />
                </div>
                <div className="row-label">{m.name}</div>
                <div className="row-cost">{formatCompactCurrency(m.cost, currency)}</div>
                <div className="row-calls">{m.calls}</div>
              </div>
            )
          })}

          {(inputTokens > 0 || outputTokens > 0) && (
            <div className="tokens-line">
              <span className="tokens-label">Tokens</span>
              <span className="tokens-value">{formatTokens(inputTokens)} in</span>
              <span className="tokens-sep">&middot;</span>
              <span className="tokens-value">{formatTokens(outputTokens)} out</span>
              <span className="tokens-sep">&middot;</span>
              <span className="tokens-value">{Math.round(cacheHitPercent)}% cache hit</span>
            </div>
          )}
        </>
      )}
    </section>
  )
}
