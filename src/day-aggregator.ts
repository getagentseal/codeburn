import type { DailyEntry } from './daily-cache.js'
import type { PeriodData } from './menubar-json.js'
import { CATEGORY_LABELS, type ProjectSummary, type TaskCategory } from './types.js'

function emptyEntry(date: string): DailyEntry {
  return {
    date,
    cost: 0,
    estimatedCostUSD: 0,
    savingsUSD: 0,
    calls: 0,
    sessions: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    editTurns: 0,
    oneShotTurns: 0,
    models: {},
    categories: {},
    providers: {},
  }
}

export function dateKey(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function aggregateProjectsIntoDays(projects: ProjectSummary[]): DailyEntry[] {
  const byDate = new Map<string, DailyEntry>()
  const ensure = (date: string): DailyEntry => {
    let d = byDate.get(date)
    if (!d) { d = emptyEntry(date); byDate.set(date, d) }
    return d
  }

  for (const project of projects) {
    for (const session of project.sessions) {
      const sessionDate = dateKey(session.firstTimestamp)
      ensure(sessionDate).sessions += 1

      for (const turn of session.turns) {
        if (turn.assistantCalls.length === 0) continue
        const turnDate = dateKey(turn.assistantCalls[0]!.timestamp)
        const turnDay = ensure(turnDate)

        const editTurns = turn.hasEdits ? 1 : 0
        const oneShotTurns = turn.hasEdits && turn.retries === 0 ? 1 : 0
        const turnCost = turn.assistantCalls.reduce((s, c) => s + c.costUSD, 0)
        const turnEstimatedCost = turn.assistantCalls.reduce((s, c) => s + (c.estimatedCostUSD ?? 0), 0)
        const turnSavings = turn.assistantCalls.reduce((s, c) => s + (c.savingsUSD ?? 0), 0)

        turnDay.editTurns += editTurns
        turnDay.oneShotTurns += oneShotTurns

        const cat = turnDay.categories[turn.category] ?? { turns: 0, cost: 0, estimatedCostUSD: 0, savingsUSD: 0, editTurns: 0, oneShotTurns: 0 }
        cat.turns += 1
        cat.cost += turnCost
        cat.estimatedCostUSD = (cat.estimatedCostUSD ?? 0) + turnEstimatedCost
        cat.savingsUSD += turnSavings
        cat.editTurns += editTurns
        cat.oneShotTurns += oneShotTurns
        turnDay.categories[turn.category] = cat

        for (const call of turn.assistantCalls) {
          const callDate = dateKey(call.timestamp)
          const callDay = ensure(callDate)
          const callSavings = call.savingsUSD ?? 0

          callDay.cost += call.costUSD
          callDay.estimatedCostUSD = (callDay.estimatedCostUSD ?? 0) + (call.estimatedCostUSD ?? 0)
          callDay.savingsUSD += callSavings
          callDay.calls += 1
          callDay.inputTokens += call.usage.inputTokens
          callDay.outputTokens += call.usage.outputTokens
          callDay.cacheReadTokens += call.usage.cacheReadInputTokens
          callDay.cacheWriteTokens += call.usage.cacheCreationInputTokens

          const model = callDay.models[call.model] ?? {
            calls: 0, cost: 0, estimatedCostUSD: 0, savingsUSD: 0,
            inputTokens: 0, outputTokens: 0,
            cacheReadTokens: 0, cacheWriteTokens: 0,
          }
          model.calls += 1
          model.cost += call.costUSD
          model.estimatedCostUSD = (model.estimatedCostUSD ?? 0) + (call.estimatedCostUSD ?? 0)
          model.savingsUSD += callSavings
          model.inputTokens += call.usage.inputTokens
          model.outputTokens += call.usage.outputTokens
          model.cacheReadTokens += call.usage.cacheReadInputTokens
          model.cacheWriteTokens += call.usage.cacheCreationInputTokens
          callDay.models[call.model] = model

          const provider = callDay.providers[call.provider] ?? { calls: 0, cost: 0, estimatedCostUSD: 0, savingsUSD: 0 }
          provider.calls += 1
          provider.cost += call.costUSD
          provider.estimatedCostUSD = (provider.estimatedCostUSD ?? 0) + (call.estimatedCostUSD ?? 0)
          provider.savingsUSD += callSavings
          callDay.providers[call.provider] = provider
        }
      }
    }
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

export function buildPeriodDataFromDays(days: DailyEntry[], label: string): PeriodData {
  let cost = 0, estimatedCostUSD = 0, savingsUSD = 0, calls = 0, sessions = 0
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0
  const catTotals: Record<string, { turns: number; cost: number; estimatedCostUSD: number; savingsUSD: number; editTurns: number; oneShotTurns: number }> = {}
  const modelTotals: Record<string, { calls: number; cost: number; estimatedCostUSD: number; savingsUSD: number }> = {}

  for (const d of days) {
    cost += d.cost
    estimatedCostUSD += d.estimatedCostUSD ?? 0
    savingsUSD += d.savingsUSD
    calls += d.calls
    sessions += d.sessions
    inputTokens += d.inputTokens
    outputTokens += d.outputTokens
    cacheReadTokens += d.cacheReadTokens
    cacheWriteTokens += d.cacheWriteTokens

    for (const [name, m] of Object.entries(d.models)) {
      const acc = modelTotals[name] ?? { calls: 0, cost: 0, estimatedCostUSD: 0, savingsUSD: 0 }
      acc.calls += m.calls
      acc.cost += m.cost
      acc.estimatedCostUSD += m.estimatedCostUSD ?? 0
      acc.savingsUSD += (m.savingsUSD ?? 0)
      modelTotals[name] = acc
    }
    for (const [cat, c] of Object.entries(d.categories)) {
      const acc = catTotals[cat] ?? { turns: 0, cost: 0, estimatedCostUSD: 0, savingsUSD: 0, editTurns: 0, oneShotTurns: 0 }
      acc.turns += c.turns
      acc.cost += c.cost
      acc.estimatedCostUSD += c.estimatedCostUSD ?? 0
      acc.savingsUSD += (c.savingsUSD ?? 0)
      acc.editTurns += c.editTurns
      acc.oneShotTurns += c.oneShotTurns
      catTotals[cat] = acc
    }
  }

  return {
    label,
    cost,
    estimatedCostUSD,
    savingsUSD,
    calls,
    sessions,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    categories: Object.entries(catTotals)
      .sort(([, a], [, b]) => b.cost - a.cost)
      .map(([cat, d]) => ({ name: CATEGORY_LABELS[cat as TaskCategory] ?? cat, ...d })),
    models: Object.entries(modelTotals)
      .sort(([, a], [, b]) => b.cost - a.cost)
      .map(([name, d]) => ({ name, ...d })),
  }
}
