import type { DailyEntry } from './daily-cache.js'
import type { PeriodData } from './menubar-json.js'
import { CATEGORY_LABELS, type ProjectSummary, type TaskCategory } from './types.js'

function emptyEntry(date: string): DailyEntry {
  return {
    date,
    cost: 0,
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

function emptyProviderEntry(): DailyEntry['providers'][string] {
  return {
    calls: 0,
    cost: 0,
    sessions: 0,
    editTurns: 0,
    oneShotTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    models: {},
    categories: {},
  }
}

function emptyCategoryEntry(): DailyEntry['categories'][string] {
  return {
    turns: 0,
    cost: 0,
    editTurns: 0,
    oneShotTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
}

function emptyModelEntry(): DailyEntry['models'][string] {
  return {
    calls: 0,
    cost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
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
      const sessionDay = ensure(sessionDate)
      sessionDay.sessions += 1
      const sessionProviders = new Set(session.turns.flatMap(turn => turn.assistantCalls.map(call => call.provider)))
      for (const providerName of sessionProviders) {
        const provider = sessionDay.providers[providerName] ?? emptyProviderEntry()
        provider.sessions += 1
        sessionDay.providers[providerName] = provider
      }

      for (const turn of session.turns) {
        if (turn.assistantCalls.length === 0) continue
        const turnDate = dateKey(turn.assistantCalls[0]!.timestamp)
        const turnDay = ensure(turnDate)

        const editTurns = turn.hasEdits ? 1 : 0
        const oneShotTurns = turn.hasEdits && turn.retries === 0 ? 1 : 0
        const turnTotals = turn.assistantCalls.reduce((acc, call) => {
          acc.cost += call.costUSD
          acc.inputTokens += call.usage.inputTokens
          acc.outputTokens += call.usage.outputTokens
          acc.cacheReadTokens += call.usage.cacheReadInputTokens
          acc.cacheWriteTokens += call.usage.cacheCreationInputTokens
          return acc
        }, { cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })

        turnDay.editTurns += editTurns
        turnDay.oneShotTurns += oneShotTurns

        const cat = turnDay.categories[turn.category] ?? emptyCategoryEntry()
        cat.turns += 1
        cat.cost += turnTotals.cost
        cat.editTurns += editTurns
        cat.oneShotTurns += oneShotTurns
        cat.inputTokens += turnTotals.inputTokens
        cat.outputTokens += turnTotals.outputTokens
        cat.cacheReadTokens += turnTotals.cacheReadTokens
        cat.cacheWriteTokens += turnTotals.cacheWriteTokens
        turnDay.categories[turn.category] = cat

        const turnProviderTotals = new Map<string, {
          cost: number
          calls: number
          inputTokens: number
          outputTokens: number
          cacheReadTokens: number
          cacheWriteTokens: number
        }>()

        for (const call of turn.assistantCalls) {
          const callDate = dateKey(call.timestamp)
          const callDay = ensure(callDate)

          callDay.cost += call.costUSD
          callDay.calls += 1
          callDay.inputTokens += call.usage.inputTokens
          callDay.outputTokens += call.usage.outputTokens
          callDay.cacheReadTokens += call.usage.cacheReadInputTokens
          callDay.cacheWriteTokens += call.usage.cacheCreationInputTokens

          const model = callDay.models[call.model] ?? emptyModelEntry()
          model.calls += 1
          model.cost += call.costUSD
          model.inputTokens += call.usage.inputTokens
          model.outputTokens += call.usage.outputTokens
          model.cacheReadTokens += call.usage.cacheReadInputTokens
          model.cacheWriteTokens += call.usage.cacheCreationInputTokens
          callDay.models[call.model] = model

          const provider = callDay.providers[call.provider] ?? emptyProviderEntry()
          provider.calls += 1
          provider.cost += call.costUSD
          provider.inputTokens += call.usage.inputTokens
          provider.outputTokens += call.usage.outputTokens
          provider.cacheReadTokens += call.usage.cacheReadInputTokens
          provider.cacheWriteTokens += call.usage.cacheCreationInputTokens

          const providerModel = provider.models[call.model] ?? emptyModelEntry()
          providerModel.calls += 1
          providerModel.cost += call.costUSD
          providerModel.inputTokens += call.usage.inputTokens
          providerModel.outputTokens += call.usage.outputTokens
          providerModel.cacheReadTokens += call.usage.cacheReadInputTokens
          providerModel.cacheWriteTokens += call.usage.cacheCreationInputTokens
          provider.models[call.model] = providerModel

          callDay.providers[call.provider] = provider

          const providerTurn = turnProviderTotals.get(call.provider) ?? {
            cost: 0,
            calls: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          }
          providerTurn.calls += 1
          providerTurn.cost += call.costUSD
          providerTurn.inputTokens += call.usage.inputTokens
          providerTurn.outputTokens += call.usage.outputTokens
          providerTurn.cacheReadTokens += call.usage.cacheReadInputTokens
          providerTurn.cacheWriteTokens += call.usage.cacheCreationInputTokens
          turnProviderTotals.set(call.provider, providerTurn)
        }

        for (const [providerName, totals] of turnProviderTotals) {
          const provider = turnDay.providers[providerName] ?? emptyProviderEntry()
          const providerCat = provider.categories[turn.category] ?? emptyCategoryEntry()
          providerCat.turns += 1
          providerCat.cost += totals.cost
          providerCat.editTurns += editTurns
          providerCat.oneShotTurns += oneShotTurns
          providerCat.inputTokens += totals.inputTokens
          providerCat.outputTokens += totals.outputTokens
          providerCat.cacheReadTokens += totals.cacheReadTokens
          providerCat.cacheWriteTokens += totals.cacheWriteTokens
          provider.categories[turn.category] = providerCat
          provider.editTurns += editTurns
          provider.oneShotTurns += oneShotTurns
          turnDay.providers[providerName] = provider
        }
      }
    }
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

export function buildPeriodDataFromDays(days: DailyEntry[], label: string): PeriodData {
  let cost = 0, calls = 0, sessions = 0
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0
  const catTotals: Record<string, {
    turns: number
    cost: number
    editTurns: number
    oneShotTurns: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
  }> = {}
  const modelTotals: Record<string, { calls: number; cost: number }> = {}

  for (const d of days) {
    cost += d.cost
    calls += d.calls
    sessions += d.sessions
    inputTokens += d.inputTokens
    outputTokens += d.outputTokens
    cacheReadTokens += d.cacheReadTokens
    cacheWriteTokens += d.cacheWriteTokens

    for (const [name, m] of Object.entries(d.models)) {
      const acc = modelTotals[name] ?? { calls: 0, cost: 0 }
      acc.calls += m.calls
      acc.cost += m.cost
      modelTotals[name] = acc
    }
    for (const [cat, c] of Object.entries(d.categories)) {
      const acc = catTotals[cat] ?? {
        turns: 0, cost: 0, editTurns: 0, oneShotTurns: 0,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      }
      acc.turns += c.turns
      acc.cost += c.cost
      acc.editTurns += c.editTurns
      acc.oneShotTurns += c.oneShotTurns
      acc.inputTokens += c.inputTokens
      acc.outputTokens += c.outputTokens
      acc.cacheReadTokens += c.cacheReadTokens
      acc.cacheWriteTokens += c.cacheWriteTokens
      catTotals[cat] = acc
    }
  }

  return {
    label,
    cost,
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
