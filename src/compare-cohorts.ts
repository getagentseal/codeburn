// Cohort model comparison: compare two models over EXPLICIT groups of similar
// work — an explicit, inspectable population of edit-turn observations the user
// can reproduce, not the classic whole-history aggregate.
//
// V1 OBSERVATION DEFINITION (normative, mirrored in docs/compare-cohorts.md):
//   * An observation is one EDIT turn (`turn.hasEdits`) whose behavioral calls
//     (`isBehavioralCall`, src/behavioral-weight.ts) carry EXACTLY ONE distinct
//     model. That model owns the observation.
//   * The cost attributed to the model is the RECORDED cost of that model's own
//     calls inside the turn (`costUSD` summed over the turn's calls of that
//     model only). Costs of any other model in the turn are never transferred,
//     and the session's total cost is never attributed to a dominant model.
//   * Edit turns whose behavioral calls span 2+ distinct models are EXCLUDED
//     from both cohorts, counted, and shown with their combined cost.
//   * An edit turn with zero behavioral calls is excluded the same way (no
//     model can own it).
//   * `costUSD === 0` on a model the existing pricing rules do not declare free
//     (`isExpectedFreeModel`, src/models.ts) is UNKNOWN cost, not zero: such
//     observations keep their retry/one-shot weight (which needs no pricing)
//     and are counted separately, excluded only from cost statistics.
// The classic compare formulas (src/compare-stats.ts) are untouched.

import type { ClassifiedTurn, ProjectSummary, TaskCategory } from './types.js'
import { CATEGORY_LABELS } from './types.js'
import { isBehavioralCall } from './behavioral-weight.js'
import { callBillableOutputTokens } from './session-output.js'
import { getShortModelName, isExpectedFreeModel } from './models.js'
import { aggregateModelStats, findModelStat, type ModelStats } from './compare-stats.js'

// The CLI's cohort branch resolves these through this one dynamic import; both
// are the classic module's own implementations (single identity source).
export { aggregateModelStats, findModelStat }

const SYNTHETIC = '<synthetic>'

/// Cost per behavioral model id inside one turn. `<synthetic>` is filtered: it
/// is accounting text, never a served model.
function behavioralCostByModel(turn: ClassifiedTurn): Map<string, number> {
  const byModel = new Map<string, number>()
  for (const call of turn.assistantCalls) {
    if (!isBehavioralCall(call)) continue
    if (call.model === SYNTHETIC) continue
    byModel.set(call.model, (byModel.get(call.model) ?? 0) + call.costUSD)
  }
  return byModel
}

export type CohortObservation = {
  /** Owning session id. Not globally unique by itself: pair with `project` for
   *  identity, per the app's canonical-identity rules. */
  sessionId: string
  /** Project label exactly as reports print it (`ProjectSummary.project`). */
  project: string
  timestamp: string
  category: TaskCategory
  /** The single behavioral model of the turn (canonical id). */
  model: string
  /** Recorded cost of the owning model's calls in this turn. */
  costUSD: number
  /** False when costUSD is 0 on a model the pricing rules do not declare free
   *  — a pricing gap, never reported as a $0 observation. */
  costKnown: boolean
  retries: number
  oneShot: boolean
  /** Token volumes summed over the owning model's calls in the turn. */
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** inputTokens + cacheReadTokens. An explicit PROXY for context size, not a
   *  measured context window; every UI label must say so. */
  contextProxyTokens: number
  /** False when the owning model's calls in the turn report no tokens at all.
   *  Volume bands must exclude and count these, never read them as small. */
  tokensReported: boolean
}

export type ExcludedMultiModelTurn = {
  sessionId: string
  project: string
  timestamp: string
  category: TaskCategory
  /** Canonical model ids of the turn's behavioral calls (2+). */
  models: string[]
  /** Combined recorded cost of all behavioral calls in the turn. Shown so the
   *  user can see what the V1 rule keeps out; attributed to NO cohort. */
  costUSD: number
}

export type CohortExclusions = {
  /** Edit turns in the selection with 2+ distinct behavioral models. */
  multiModelTurns: ExcludedMultiModelTurn[]
  /** Edit turns in the selection whose behavioral calls carry no model. */
  noBehavioralModelTurns: number
  combinedMultiModelCostUSD: number
}

export type CohortSelection = {
  projects: ProjectSummary[]
  /** Inclusive; undefined = every activity category. */
  category?: TaskCategory
}

/**
 * Walk the selection once and split every edit turn into cohort observations or
 * exclusions. Both cohorts see the same turn stream, so a mixed session
 * contributes observations to each of its models and its multi-model turns to
 * nobody — only to the ONE shared exclusion ledger both reports attach.
 */
export function extractCohortObservations(
  selection: CohortSelection,
): { perModel: Map<string, CohortObservation[]>; exclusions: CohortExclusions } {
  const perModel = new Map<string, CohortObservation[]>()
  const exclusions: CohortExclusions = {
    multiModelTurns: [],
    noBehavioralModelTurns: 0,
    combinedMultiModelCostUSD: 0,
  }

  const cohortFor = (model: string): CohortObservation[] => {
    let obs = perModel.get(model)
    if (!obs) {
      obs = []
      perModel.set(model, obs)
    }
    return obs
  }

  for (const project of selection.projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        if (!turn.hasEdits) continue
        if (selection.category && turn.category !== selection.category) continue

        const byModel = behavioralCostByModel(turn)

        if (byModel.size === 0) {
          // Shared ledger: no behavioral model owns this edit turn.
          exclusions.noBehavioralModelTurns++
          continue
        }
        if (byModel.size > 1) {
          const models = [...byModel.keys()].sort()
          const cost = [...byModel.values()].reduce((sum, c) => sum + c, 0)
          exclusions.multiModelTurns.push({
            sessionId: session.sessionId,
            project: project.project,
            timestamp: turn.timestamp,
            category: turn.category,
            models,
            costUSD: cost,
          })
          exclusions.combinedMultiModelCostUSD += cost
          continue
        }

        const model = byModel.keys().next().value as string
        let cost = 0
        let inputTokens = 0
        let outputTokens = 0
        let cacheReadTokens = 0
        let cacheWriteTokens = 0
        let tokensReported = false
        for (const call of turn.assistantCalls) {
          if (call.model !== model || !isBehavioralCall(call)) continue
          cost += call.costUSD
          const callInput = call.usage.inputTokens
          const callOutput = call.usage.outputTokens
          const callCacheRead = call.usage.cacheReadInputTokens
          const callCacheWrite = call.usage.cacheCreationInputTokens
          inputTokens += callInput
          outputTokens += callBillableOutputTokens(call)
          cacheReadTokens += callCacheRead
          cacheWriteTokens += callCacheWrite
          if (callInput > 0 || callOutput > 0 || callCacheRead > 0 || callCacheWrite > 0) tokensReported = true
        }

        // Unknown ≠ zero: reuse the app's own pricing-gap rules (models.ts).
        const costKnown = cost > 0 || isExpectedFreeModel(model)

        const acc = cohortFor(model)
        acc.push({
          sessionId: session.sessionId,
          project: project.project,
          timestamp: turn.timestamp,
          category: turn.category,
          model,
          costUSD: cost,
          costKnown,
          retries: turn.retries,
          oneShot: turn.retries === 0,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          contextProxyTokens: inputTokens + cacheReadTokens,
          tokensReported,
        })
      }
    }
  }

  return { perModel, exclusions }
}

/// Percentile convention FIXED for this feature (pinned in tests on both the
/// core and the renderer mirror): sort ascending, position (N-1)*p, linear
/// interpolation between neighbors. [1, 2, 4, 8] → median 3, P90 6.8.
export function linearPercentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null
  if (sorted.length === 1) return sorted[0] as number
  const pos = (sorted.length - 1) * p
  const lower = Math.floor(pos)
  const upper = Math.ceil(pos)
  if (lower === upper) return sorted[lower] as number
  const fraction = pos - lower
  return (sorted[lower] as number) * (1 - fraction) + (sorted[upper] as number) * fraction
}

export function medianOf(sorted: readonly number[]): number | null {
  return linearPercentile(sorted, 0.5)
}

export type CostHistogram = {
  /// Half-open buckets [edge[i], edge[i+1]) over the KNOWN costs. The LAST
  /// bucket is open-ended: outliers are never dropped, they land there and stay
  /// in every percentile. Empty edges means "everything is $0 (free models)".
  edges: number[]
  counts: number[]
}

const HISTOGRAM_BUCKETS = 8

/** Deterministic linear edges from 0 to the 95th percentile of the known
 *  costs; the top bucket is open-ended so outliers stretch nothing. */
export function costHistogram(costs: readonly number[]): CostHistogram {
  if (costs.length === 0) return { edges: [], counts: [] }
  const sorted = [...costs].sort((a, b) => a - b)
  const p95 = linearPercentile(sorted, 0.95) ?? 0
  const top = p95 > 0 ? p95 : 0
  if (top <= 0) return { edges: [], counts: [costs.length] }
  const edges: number[] = []
  for (let i = 1; i < HISTOGRAM_BUCKETS; i++) edges.push((top * i) / HISTOGRAM_BUCKETS)
  const counts = new Array(HISTOGRAM_BUCKETS).fill(0)
  for (const cost of costs) {
    let bucket = 0
    while (bucket < edges.length && cost >= (edges[bucket] as number)) bucket++
    counts[bucket]++
  }
  return { edges, counts }
}

export type CohortVolumeStats = {
  outputMedian: number | null
  outputP90: number | null
  inputMedian: number | null
  inputP90: number | null
  contextProxyMedian: number | null
  contextProxyP90: number | null
  /** Observations with no token measure at all: visible, never read as small. */
  missingMeasureCount: number
}

export type CohortStats = {
  model: string
  label: string
  /** Declared population: observations after the selection filters (and after a
   *  volume band when one is active). Every rate below uses THIS denominator. */
  observationCount: number
  distinctSessionCount: number
  /** Retry / one-shot over the declared population (classic meaning: observed
   *  retries only; zero observed retries never proves code correctness). */
  retryCount: number
  retryRate: number | null
  oneShotCount: number
  oneShotRate: number | null
  /** Cost statistics over cost-KNOWN observations only. */
  costKnownCount: number
  unknownCostCount: number
  costMedian: number | null
  costP90: number | null
  costMean: number | null
  costHistogram: CostHistogram
  volume: CohortVolumeStats
}

export function computeCohortStats(model: string, observations: readonly CohortObservation[]): CohortStats {
  const knownCosts = observations.filter(o => o.costKnown).map(o => o.costUSD).sort((a, b) => a - b)
  const knownCostSum = knownCosts.reduce((sum, c) => sum + c, 0)
  const sessionKeys = new Set(observations.map(o => `${o.project}/${o.sessionId}`))
  const byMeasure = (pick: (o: CohortObservation) => number) =>
    observations.filter(o => o.tokensReported).map(pick).sort((a, b) => a - b)
  const outputTokens = byMeasure(o => o.outputTokens)
  const inputTokens = byMeasure(o => o.inputTokens)
  const contextProxy = byMeasure(o => o.contextProxyTokens)

  const retryCount = observations.reduce((sum, o) => sum + o.retries, 0)
  const oneShotCount = observations.filter(o => o.oneShot).length
  const n = observations.length

  return {
    model,
    label: getShortModelName(model),
    observationCount: n,
    distinctSessionCount: sessionKeys.size,
    retryCount,
    retryRate: n > 0 ? retryCount / n : null,
    oneShotCount,
    oneShotRate: n > 0 ? (oneShotCount / n) * 100 : null,
    costKnownCount: knownCosts.length,
    unknownCostCount: n - knownCosts.length,
    costMedian: medianOf(knownCosts),
    costP90: linearPercentile(knownCosts, 0.9),
    costMean: knownCosts.length > 0 ? knownCostSum / knownCosts.length : null,
    costHistogram: costHistogram(knownCosts),
    volume: {
      outputMedian: medianOf(outputTokens),
      outputP90: linearPercentile(outputTokens, 0.9),
      inputMedian: medianOf(inputTokens),
      inputP90: linearPercentile(inputTokens, 0.9),
      contextProxyMedian: medianOf(contextProxy),
      contextProxyP90: linearPercentile(contextProxy, 0.9),
      missingMeasureCount: observations.filter(o => !o.tokensReported).length,
    },
  }
}

// ————— Report contracts (JSON over the IPC bridge) —————

export type CohortModelReport = {
  model: string
  label: string
  stats: CohortStats
  /** The DECLARED population: every observation the stats above were computed
   *  from, so any number in the report is reproducible from this list. */
  observations: CohortObservation[]
  /** Exclusions as seen from this cohort (the same shared ledger on both). */
  exclusions: {
    multiModelTurnCount: number
    combinedMultiModelCostUSD: number
    noBehavioralModelTurns: number
  }
}

export type CohortComparisonReport = {
  kind: 'cohort-comparison'
  period: { label: string; provider: string }
  selection: { projects: string[]; category: string | null; from: string | null; to: string | null }
  /** Conventions the UI must surface, not bury. */
  conventions: {
    percentile: string
    contextProxy: string
    attribution: string
  }
  modelA: CohortModelReport
  modelB: CohortModelReport
}

export type CohortFacets = {
  kind: 'cohort-facets'
  /** Models with usage in the population (classic ModelStats shape): one
   *  canonical identity per row (aliases folded), the same list the classic
   *  picker shows, so both Compare modes agree on which models exist. */
  models: ModelStats[]
  /** Canonical project identities of the population. */
  projects: Array<{ project: string; projectPath: string; sessions: number; costUSD: number }>
  categories: Array<{ id: TaskCategory; label: string }>
}

export function cohortCategoryOptions(): Array<{ id: TaskCategory; label: string }> {
  return Object.entries(CATEGORY_LABELS).map(([id, label]) => ({ id: id as TaskCategory, label }))
}

export function buildCohortComparison(
  projects: ProjectSummary[],
  modelA: string,
  modelB: string,
  label: string,
  provider: string,
  selection: { category?: TaskCategory; from?: string | null; to?: string | null } = {},
): CohortComparisonReport {
  const { perModel, exclusions } = extractCohortObservations({ projects, category: selection.category })
  const sharedExclusions = {
    multiModelTurnCount: exclusions.multiModelTurns.length,
    combinedMultiModelCostUSD: exclusions.combinedMultiModelCostUSD,
    noBehavioralModelTurns: exclusions.noBehavioralModelTurns,
  }

  const build = (model: string): CohortModelReport => {
    const observations = perModel.get(model) ?? []
    return {
      model,
      label: getShortModelName(model),
      stats: computeCohortStats(model, observations),
      observations,
      exclusions: sharedExclusions,
    }
  }

  return {
    kind: 'cohort-comparison',
    period: { label, provider },
    selection: {
      projects: [...new Set(projects.map(p => p.project))].sort(),
      category: selection.category ?? null,
      from: selection.from ?? null,
      to: selection.to ?? null,
    },
    conventions: {
      percentile: 'linear interpolation at position (N-1)*p',
      contextProxy: 'input + cache-read tokens (proxy, not a measured context window)',
      attribution: 'observation cost = recorded cost of the owning model\'s calls in the turn',
    },
    modelA: build(modelA),
    modelB: build(modelB),
  }
}

export function buildCohortFacets(projects: ProjectSummary[]): CohortFacets {
  const projectMap = new Map<string, { project: string; projectPath: string; sessions: number; costUSD: number }>()
  for (const p of projects) {
    const existing = projectMap.get(p.project)
    if (existing) {
      existing.sessions += p.sessions.length
      existing.costUSD += p.totalCostUSD
    } else {
      projectMap.set(p.project, { project: p.project, projectPath: p.projectPath, sessions: p.sessions.length, costUSD: p.totalCostUSD })
    }
  }
  return {
    kind: 'cohort-facets',
    models: aggregateModelStats(projects),
    projects: [...projectMap.values()].sort((a, b) => b.costUSD - a.costUSD),
    categories: cohortCategoryOptions(),
  }
}

export function renderCohortJson(report: CohortComparisonReport | CohortFacets): string {
  return JSON.stringify(report, null, 2)
}
