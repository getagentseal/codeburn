import { getShortModelName } from './models.js'
import type { ProjectSummary } from './types.js'

export interface ModelTotals {
  calls: number
  costUSD: number
  estimatedCostUSD: number
  freshInput: number
  cacheRead: number
  cacheWrite: number
}

/// Aggregate per-model usage across every session, keyed by the friendly display
/// name rather than the raw model id. A cache can hold more than one raw key that
/// resolves to the same name — e.g. the full Fireworks path
/// `accounts/fireworks/models/glm-5p2` written by an older build and the
/// normalized `glm-5p2`/`GLM-5.2` written by a newer one — and keying by the
/// resolved name merges those into a single row instead of rendering duplicates.
export function aggregateModelTotals(projects: ProjectSummary[]): Record<string, ModelTotals> {
  const modelTotals: Record<string, ModelTotals> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [model, data] of Object.entries(session.modelBreakdown)) {
        const name = getShortModelName(model)
        const totals = (modelTotals[name] ??= {
          calls: 0, costUSD: 0, estimatedCostUSD: 0, freshInput: 0, cacheRead: 0, cacheWrite: 0,
        })
        totals.calls += data.calls
        totals.costUSD += data.costUSD
        totals.estimatedCostUSD += data.estimatedCostUSD ?? 0
        totals.freshInput += data.tokens.inputTokens
        totals.cacheRead += data.tokens.cacheReadInputTokens
        totals.cacheWrite += data.tokens.cacheCreationInputTokens
      }
    }
  }
  return modelTotals
}
