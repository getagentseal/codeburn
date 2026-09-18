import type { Model } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { formatCompactCurrency, formatTokens } from '../lib/currency'
import { CollapsibleSection } from './CollapsibleSection'
import { FixedBar, COL_COST, COL_COUNT } from './ActivitySection'

/// The Saved column only appears once something was actually saved. With no local-model
/// mapping it would be an unlabelled column of dashes, so the mac drops it entirely.
const COL_SAVED = 54

type Props = {
  models: Model[]
  inputTokens: number
  outputTokens: number
  cacheHitPercent: number
  currency: CurrencyState
  unpricedModels?: Array<{ model: string; calls: number; tokens: number }>
}

export function ModelsSection({ models, inputTokens, outputTokens, cacheHitPercent, currency, unpricedModels }: Props) {
  if (models.length === 0) return null
  const maxCost = Math.max(...models.map(m => m.cost), 0.01)
  const showSavings = models.some(m => (m.savingsUSD ?? 0) > 0)
  const unpriced = unpricedModels ?? []
  const unpricedTokens = unpriced.reduce((sum, m) => sum + m.tokens, 0)

  return (
    <CollapsibleSection
      caption="Models"
      columns={[
        { label: 'Cost', width: COL_COST },
        ...(showSavings ? [{ label: 'Saved', width: COL_SAVED }] : []),
        { label: 'Calls', width: COL_COUNT },
      ]}
    >
      {models.map(m => (
        <div key={m.name} className="data-row">
          {/* The bar tracks real cost, so a local model at $0 leaves it empty. The
              counterfactual saving is text in its own column and is never added in. */}
          <FixedBar fraction={m.cost / maxCost} />
          <span className="row-name">{m.name}</span>
          <span className="row-cost" style={{ minWidth: COL_COST }}>{formatCompactCurrency(m.cost, currency)}</span>
          {showSavings && (
            <span
              className={`row-saved ${(m.savingsUSD ?? 0) > 0 ? 'row-saved-on' : ''}`}
              style={{ minWidth: COL_SAVED }}
            >
              {(m.savingsUSD ?? 0) > 0 ? formatCompactCurrency(m.savingsUSD ?? 0, currency) : '-'}
            </span>
          )}
          <span className="row-count" style={{ minWidth: COL_COUNT }}>{m.calls}</span>
        </div>
      ))}
      {(inputTokens > 0 || outputTokens > 0) && (
        <div className="tokens-line">
          <span className="tokens-label">Tokens</span>
          <span className="tokens-value">{formatTokens(inputTokens)} in</span>
          <span className="tokens-sep">·</span>
          <span className="tokens-value">{formatTokens(outputTokens)} out</span>
          <span className="tokens-sep">·</span>
          <span className="tokens-value">{Math.round(cacheHitPercent)}% cache hit</span>
        </div>
      )}
      {/* The $0-cost rows below the table's floor never render as rows; without
          this line "cheap" and "uncounted" read the same (#1420). Same wording
          as every other consumer of the block ("counted at $0"). */}
      {unpriced.length > 0 && (
        <div className="tokens-line" title={unpriced.map(m => `${m.model} (${m.calls} calls)`).join(', ')}>
          <span className="tokens-label">Unpriced</span>
          <span className="tokens-value">
            {unpriced.length === 1
              ? `1 model counted at $0 · ${formatTokens(unpricedTokens)} tokens`
              : `${unpriced.length} models counted at $0 · ${formatTokens(unpricedTokens)} tokens`}
          </span>
        </div>
      )}
    </CollapsibleSection>
  )
}
