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

        const primaryCall = turn.assistantCalls.find(c => getShortModelName(c.model) !== '<synthetic>')
        if (!primaryCall) continue
        const primaryModel = getShortModelName(primaryCall.model)

        const stats = ensure(primaryModel)
        stats.editTurns++
        if (turn.retries === 0) stats.oneShotTurns++
        stats.retries += turn.retries
        stats.editCostUSD += turn.assistantCalls.reduce((sum, call) => {
          return getShortModelName(call.model) === '<synthetic>' ? sum : sum + call.costUSD
        }, 0)
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
