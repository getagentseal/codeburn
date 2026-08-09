import type { DailyEntry, ProjectDayStats, ProviderDaySlice } from './daily-cache.js'
import type { PeriodData } from './menubar-json.js'
import { CATEGORY_LABELS, type ProjectSummary, type SessionSummary, type TaskCategory } from './types.js'
import { projectIdentityOf } from './project-identity.js'

function emptyEntry(date: string): DailyEntry {
  return {
    date,
    cost: 0,
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

function emptySlice(): ProviderDaySlice {
  return {
    calls: 0, cost: 0, savingsUSD: 0,
    sessions: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    editTurns: 0, oneShotTurns: 0, models: {}, categories: {},
  }
}

export function aggregateProjectsIntoDays(projects: ProjectSummary[]): DailyEntry[] {
  const byDate = new Map<string, DailyEntry>()
  const ensure = (date: string): DailyEntry => {
    let d = byDate.get(date)
    if (!d) { d = emptyEntry(date); byDate.set(date, d) }
    return d
  }
  const ensureSlice = (day: DailyEntry, provider: string): ProviderDaySlice => {
    let s = day.providers[provider]
    if (!s) { s = emptySlice(); day.providers[provider] = s }
    return s
  }
  const ensureProject = (
    holder: { projects?: Record<string, ProjectDayStats> },
    project: string,
    path?: string,
    name?: string,
  ): ProjectDayStats => {
    const projects = (holder.projects ??= {})
    // defineProperty so a project directory named "__proto__" becomes an own
    // key instead of mutating the prototype link.
    let p = Object.hasOwn(projects, project) ? projects[project] : undefined
    if (!p) {
      p = {
        cost: 0,
        calls: 0,
        savingsUSD: 0,
        sessions: 0,
        ...(name ? { name } : {}),
      }
      Object.defineProperty(projects, project, { value: p, enumerable: true, writable: true, configurable: true })
    }
    if (!p.path && path) p.path = path
    if (!p.name && name) p.name = name
    return p
  }

  // Key per-day per-project rollups by the stable identity (path/root-set when
  // known, display label otherwise) so two projects sharing a basename — e.g.
  // Zed threads rooted at /Users/alice/repo and /Users/bob/repo, both labelled
  // "repo" — stay separate in the persisted daily attribution instead of
  // merging under the first-seen path. Multi-root labels are stored in `name`
  // because their identity is not a filesystem path.
  const projectRollupKey = (project: ProjectSummary, session: SessionSummary): string =>
    projectIdentityOf(project, session.project)
  const projectPath = (project: ProjectSummary): string | undefined => project.projectPath || undefined
  const projectName = (project: ProjectSummary): string | undefined => project.projectPath ? undefined : project.project

  for (const project of projects) {
    for (const session of project.sessions) {
      const sessionDate = dateKey(session.firstTimestamp)
      const sessionDay = ensure(sessionDate)
      sessionDay.sessions += 1
      ensureProject(sessionDay, projectRollupKey(project, session), projectPath(project), projectName(project)).sessions += 1
      // A session belongs to exactly one provider; its calls all carry it.
      const sessionProvider = session.turns.flatMap(t => t.assistantCalls)[0]?.provider
      if (sessionProvider) {
        const slice = ensureSlice(sessionDay, sessionProvider)
        slice.sessions! += 1
        ensureProject(slice, projectRollupKey(project, session), projectPath(project), projectName(project)).sessions += 1
      }

      for (const turn of session.turns) {
        if (turn.assistantCalls.length === 0) continue
        // Two bucketing rules, deliberately different per level:
        // - Turn-level judgments (category, editTurns, oneShotTurns) stay
        //   anchored to the turn's day (its timestamp — the user-message time,
        //   or the re-anchored first surviving call when the parser sliced
        //   the turn to a range, and falling back to the first assistant call
        //   when the user line is missing). They describe the whole exchange,
        //   not a per-call sum, so a sliced straddling turn reports them on
        //   each side's anchor day — summed across days they inflate, which
        //   is the accepted, documented semantics (see review on #852).
        // - Call-derived values (cost/savings/calls/tokens and the model,
        //   project, and provider-slice rollups built from them) bucket under
        //   EACH CALL's own local day (the per-call loop below). The parser
        //   slices straddling turns per range (issue #852), so every parse
        //   only holds in-range calls and per-call bucketing keeps day-N +
        //   day-N+1 equal to the whole range — and history.daily reconciled
        //   to the headline built from the same days. (Before the parser
        //   sliced per call, per-call bucketing here was what caused the
        //   constant offset against the whole-turn headline; the slice is
        //   what makes it exact now.)
        const turnDate = dateKey(turn.timestamp || turn.assistantCalls[0]!.timestamp)
        const turnDay = ensure(turnDate)

        const editTurns = turn.hasEdits ? 1 : 0
        const oneShotTurns = turn.hasEdits && turn.retries === 0 ? 1 : 0
        const turnCost = turn.assistantCalls.reduce((s, c) => s + c.costUSD, 0)
        const turnSavings = turn.assistantCalls.reduce((s, c) => s + (c.savingsUSD ?? 0), 0)

        turnDay.editTurns += editTurns
        turnDay.oneShotTurns += oneShotTurns

        const cat = turnDay.categories[turn.category] ?? { turns: 0, cost: 0, savingsUSD: 0, editTurns: 0, oneShotTurns: 0 }
        cat.turns += 1
        cat.cost += turnCost
        cat.savingsUSD += turnSavings
        cat.editTurns += editTurns
        cat.oneShotTurns += oneShotTurns
        turnDay.categories[turn.category] = cat

        // Cost stays attributed to every provider actually present in the turn,
        // but turn counts belong to exactly one slice. Otherwise carrying one
        // missing provider later re-adds a turn already present in the fresh
        // provider's slice. Highest call count wins; when the first call's
        // provider is tied for highest, replacing only on a strict increase
        // leaves that provider selected.
        const providersInTurn = new Map<string, { calls: number; cost: number; savingsUSD: number }>()
        for (const call of turn.assistantCalls) {
          const acc = providersInTurn.get(call.provider) ?? { calls: 0, cost: 0, savingsUSD: 0 }
          acc.calls += 1
          acc.cost += call.costUSD
          acc.savingsUSD += call.savingsUSD ?? 0
          providersInTurn.set(call.provider, acc)
        }
        let primaryProvider = turn.assistantCalls[0]!.provider
        let primaryCalls = providersInTurn.get(primaryProvider)!.calls
        for (const [provider, totals] of providersInTurn) {
          if (totals.calls > primaryCalls) {
            primaryProvider = provider
            primaryCalls = totals.calls
          }
        }
        for (const [prov, totals] of providersInTurn) {
          const turnSlice = ensureSlice(turnDay, prov)
          const ownsTurn = prov === primaryProvider
          turnSlice.editTurns! += ownsTurn ? editTurns : 0
          turnSlice.oneShotTurns! += ownsTurn ? oneShotTurns : 0
          const sliceCat = turnSlice.categories![turn.category] ?? { turns: 0, cost: 0, savingsUSD: 0, editTurns: 0, oneShotTurns: 0 }
          sliceCat.turns += ownsTurn ? 1 : 0
          sliceCat.cost += totals.cost
          sliceCat.savingsUSD += totals.savingsUSD
          sliceCat.editTurns += ownsTurn ? editTurns : 0
          sliceCat.oneShotTurns += ownsTurn ? oneShotTurns : 0
          turnSlice.categories![turn.category] = sliceCat
        }

        for (const call of turn.assistantCalls) {
          const callSavings = call.savingsUSD ?? 0
          // Call-derived values bucket under the call's OWN day (see the
          // two-rule comment above). An unparseable call timestamp falls back
          // to the turn's anchor day rather than producing a garbage date key.
          const callDate = Number.isNaN(new Date(call.timestamp).getTime()) ? turnDate : dateKey(call.timestamp)
          const callDay = ensure(callDate)

          callDay.cost += call.costUSD
          callDay.savingsUSD += callSavings
          callDay.calls += 1
          callDay.inputTokens += call.usage.inputTokens
          callDay.outputTokens += call.usage.outputTokens
          callDay.cacheReadTokens += call.usage.cacheReadInputTokens
          callDay.cacheWriteTokens += call.usage.cacheCreationInputTokens

          const dayProject = ensureProject(callDay, projectRollupKey(project, session), projectPath(project), projectName(project))
          dayProject.cost += call.costUSD
          dayProject.calls += 1
          dayProject.savingsUSD += callSavings

          const model = callDay.models[call.model] ?? {
            calls: 0, cost: 0, savingsUSD: 0,
            inputTokens: 0, outputTokens: 0,
            cacheReadTokens: 0, cacheWriteTokens: 0,
          }
          model.calls += 1
          model.cost += call.costUSD
          model.savingsUSD += callSavings
          model.inputTokens += call.usage.inputTokens
          model.outputTokens += call.usage.outputTokens
          model.cacheReadTokens += call.usage.cacheReadInputTokens
          model.cacheWriteTokens += call.usage.cacheCreationInputTokens
          callDay.models[call.model] = model

          const slice = ensureSlice(callDay, call.provider)
          slice.calls += 1
          slice.cost += call.costUSD
          slice.savingsUSD += callSavings
          slice.inputTokens! += call.usage.inputTokens
          slice.outputTokens! += call.usage.outputTokens
          slice.cacheReadTokens! += call.usage.cacheReadInputTokens
          slice.cacheWriteTokens! += call.usage.cacheCreationInputTokens

          const sliceProject = ensureProject(slice, projectRollupKey(project, session), projectPath(project), projectName(project))
          sliceProject.cost += call.costUSD
          sliceProject.calls += 1
          sliceProject.savingsUSD += callSavings

          const sliceModel = slice.models![call.model] ?? {
            calls: 0, cost: 0, savingsUSD: 0,
            inputTokens: 0, outputTokens: 0,
            cacheReadTokens: 0, cacheWriteTokens: 0,
          }
          sliceModel.calls += 1
          sliceModel.cost += call.costUSD
          sliceModel.savingsUSD += callSavings
          sliceModel.inputTokens += call.usage.inputTokens
          sliceModel.outputTokens += call.usage.outputTokens
          sliceModel.cacheReadTokens += call.usage.cacheReadInputTokens
          sliceModel.cacheWriteTokens += call.usage.cacheCreationInputTokens
          slice.models![call.model] = sliceModel
        }
      }
    }
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

export function buildPeriodDataFromDays(days: DailyEntry[], label: string): PeriodData {
  let cost = 0, savingsUSD = 0, calls = 0, sessions = 0
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0
  const catTotals: Record<string, { turns: number; cost: number; savingsUSD: number; editTurns: number; oneShotTurns: number }> = {}
  const modelTotals: Record<string, { calls: number; cost: number; savingsUSD: number }> = {}

  for (const d of days) {
    cost += d.cost
    savingsUSD += d.savingsUSD
    calls += d.calls
    sessions += d.sessions
    inputTokens += d.inputTokens
    outputTokens += d.outputTokens
    cacheReadTokens += d.cacheReadTokens
    cacheWriteTokens += d.cacheWriteTokens

    for (const [name, m] of Object.entries(d.models)) {
      const acc = modelTotals[name] ?? { calls: 0, cost: 0, savingsUSD: 0 }
      acc.calls += m.calls
      acc.cost += m.cost
      acc.savingsUSD += (m.savingsUSD ?? 0)
      modelTotals[name] = acc
    }
    for (const [cat, c] of Object.entries(d.categories)) {
      const acc = catTotals[cat] ?? { turns: 0, cost: 0, savingsUSD: 0, editTurns: 0, oneShotTurns: 0 }
      acc.turns += c.turns
      acc.cost += c.cost
      acc.savingsUSD += (c.savingsUSD ?? 0)
      acc.editTurns += c.editTurns
      acc.oneShotTurns += c.oneShotTurns
      catTotals[cat] = acc
    }
  }

  return {
    label,
    cost,
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
