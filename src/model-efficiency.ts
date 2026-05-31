import { getShortModelName } from './models.js'
import type { ProjectSummary } from './types.js'

export type ModelEfficiency = {
  model: string
  editTurns: number
  oneShotTurns: number
  retries: number
  editCostUSD: number
  oneShotRate: number | null
  retriesPerEdit: number | null
  costPerEditUSD: number | null
}

type MutableModelEfficiency = Omit<ModelEfficiency, 'oneShotRate' | 'retriesPerEdit' | 'costPerEditUSD'>

function rate(num: number, den: number): number | null {
  if (den === 0) return null
  return Math.round((num / den) * 1000) / 10
}

export function aggregateModelEfficiency(projects: ProjectSummary[]): Map<string, ModelEfficiency> {
  const byModel = new Map<string, MutableModelEfficiency>()

  function ensure(model: string): MutableModelEfficiency {
    let stats = byModel.get(model)
    if (!stats) {
      stats = { model, editTurns: 0, oneShotTurns: 0, retries: 0, editCostUSD: 0 }
      byModel.set(model, stats)
    }
    return stats
  }

  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        if (!turn.hasEdits || turn.assistantCalls.length === 0) continue

        // Single pass: find primary model and accumulate cost together
        let primaryModel: string | undefined
        let turnCost = 0
        for (const call of turn.assistantCalls) {
          const short = getShortModelName(call.model)
          if (short === '<synthetic>') continue
          if (!primaryModel) primaryModel = short
          turnCost += call.costUSD
        }
        if (!primaryModel) continue

        const stats = ensure(primaryModel)
        stats.editTurns++
        if (turn.retries === 0) stats.oneShotTurns++
        stats.retries += turn.retries
        stats.editCostUSD += turnCost
      }
    }
  }

  return new Map([...byModel.entries()].map(([model, stats]) => [model, {
    ...stats,
    oneShotRate: rate(stats.oneShotTurns, stats.editTurns),
    retriesPerEdit: stats.editTurns > 0 ? Math.round((stats.retries / stats.editTurns) * 10) / 10 : null,
    costPerEditUSD: stats.editTurns > 0 ? stats.editCostUSD / stats.editTurns : null,
  }]))
}
