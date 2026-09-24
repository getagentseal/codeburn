import { modelRowKey } from './models.js'
import type { ParsedApiCall, ProjectSummary } from './types.js'

export type ModelEfficiency = {
  model: string
  editTurns: number
  oneShotTurns: number
  retries: number
  /// Edit turns that contained at least one retry, and what those turns cost.
  retriedTurns: number
  editCostUSD: number
  retriedEditCostUSD: number
  oneShotRate: number | null
  retriesPerEdit: number | null
  costPerEditUSD: number | null
}

type MutableModelEfficiency = Omit<ModelEfficiency, 'oneShotRate' | 'retriesPerEdit' | 'costPerEditUSD'>

function rate(num: number, den: number): number | null {
  if (den === 0) return null
  return Math.round((num / den) * 1000) / 10
}

function modelKey(call: ParsedApiCall): string {
  return call.provider === 'devin' ? call.model : modelRowKey(call.model, call.route)
}

export function aggregateModelEfficiency(projects: ProjectSummary[]): Map<string, ModelEfficiency> {
  const byModel = new Map<string, MutableModelEfficiency>()

  function ensure(model: string): MutableModelEfficiency {
    let stats = byModel.get(model)
    if (!stats) {
      stats = { model, editTurns: 0, oneShotTurns: 0, retries: 0, retriedTurns: 0, editCostUSD: 0, retriedEditCostUSD: 0 }
      byModel.set(model, stats)
    }
    return stats
  }

  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        if (!turn.hasEdits || turn.assistantCalls.length === 0) continue

        const primaryCall = turn.assistantCalls.find(c => modelKey(c) !== '<synthetic>')
        if (!primaryCall) continue
        const primaryModel = modelKey(primaryCall)

        const stats = ensure(primaryModel)
        stats.editTurns++
        if (turn.retries === 0) stats.oneShotTurns++
        stats.retries += turn.retries
        const turnCost = turn.assistantCalls.reduce((sum, call) => {
          return modelKey(call) === '<synthetic>' ? sum : sum + call.costUSD
        }, 0)
        stats.editCostUSD += turnCost
        if (turn.retries > 0) {
          stats.retriedEditCostUSD += turnCost
          stats.retriedTurns++
        }
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

/// Retry tax is the real cost of the edit turns that needed a retry — a slice
/// of spend, never a multiple of it.
export function buildRetryTax(models: Iterable<ModelEfficiency>) {
  const retried = [...models].filter(m => m.retriedEditCostUSD > 0)
  return {
    totalUSD: retried.reduce((s, m) => s + m.retriedEditCostUSD, 0),
    retries: retried.reduce((s, m) => s + m.retries, 0),
    editTurns: retried.reduce((s, m) => s + m.retriedTurns, 0),
    byModel: retried
      .map(m => ({ name: m.model, taxUSD: m.retriedEditCostUSD, retries: m.retries, retriesPerEdit: m.retriesPerEdit }))
      .sort((a, b) => b.taxUSD - a.taxUSD)
      .slice(0, 5),
  }
}
