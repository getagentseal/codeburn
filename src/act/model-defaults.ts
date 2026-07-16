import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { aggregateModelStats, type ModelStats } from '../compare-stats.js'
import type { ProjectSummary } from '../types.js'
import { sha256File } from './backup.js'
import type { ActionPlan } from './types.js'

const MIN_EDIT_TURNS = 30
const MAX_COST_RATIO = 0.6
const ONE_SHOT_TOLERANCE = 0.03
const DEBUGGING_HEAVY_THRESHOLD = 0.4
const RECENCY_DAYS = 14
const MS_PER_DAY = 24 * 60 * 60 * 1000

export type ModelDefaultRecommendation = {
  project: string
  projectPath: string
  currentModel: string
  candidateModel: string
  provider: string
  currentEditTurns: number
  candidateEditTurns: number
  currentOneShotRate: number
  candidateOneShotRate: number
  currentCostPerEdit: number
  candidateCostPerEdit: number
  savingsPct: number
  debuggingHeavy: boolean
}

function oneShotRate(s: ModelStats): number {
  return s.editTurns > 0 ? s.oneShotTurns / s.editTurns : 0
}

function costPerEdit(s: ModelStats): number {
  return s.editTurns > 0 ? s.editCost / s.editTurns : Number.POSITIVE_INFINITY
}

function isRecent(lastSeen: string, now: Date): boolean {
  if (!lastSeen) return false
  const seen = new Date(lastSeen)
  if (Number.isNaN(seen.getTime())) return false
  return now.getTime() - seen.getTime() <= RECENCY_DAYS * MS_PER_DAY
}

function providerByModel(project: ProjectSummary): Map<string, string> {
  const providers = new Map<string, string>()
  for (const session of project.sessions) {
    for (const turn of session.turns) {
      const primary = turn.assistantCalls[0]
      if (!primary || primary.model === '<synthetic>') continue
      if (!providers.has(primary.model)) providers.set(primary.model, primary.provider)
      for (const call of turn.assistantCalls) {
        if (call.model === '<synthetic>') continue
        if (!providers.has(call.model)) providers.set(call.model, call.provider)
      }
    }
  }
  return providers
}

function isDebuggingHeavy(project: ProjectSummary): boolean {
  let debuggingEditTurns = 0
  let totalEditTurns = 0
  for (const session of project.sessions) {
    for (const breakdown of Object.values(session.categoryBreakdown)) {
      totalEditTurns += breakdown.editTurns
    }
    debuggingEditTurns += session.categoryBreakdown.debugging?.editTurns ?? 0
  }
  return totalEditTurns > 0 && debuggingEditTurns / totalEditTurns > DEBUGGING_HEAVY_THRESHOLD
}

export function recommendModelDefault(project: ProjectSummary, opts: { now?: Date } = {}): ModelDefaultRecommendation | null {
  const now = opts.now ?? new Date()
  const stats = aggregateModelStats([project])
    .filter(s => s.model !== '<synthetic>' && s.editTurns >= MIN_EDIT_TURNS)
    .sort((a, b) => b.editTurns - a.editTurns || b.editCost - a.editCost)

  const current = stats[0]
  if (!current) return null

  const providers = providerByModel(project)
  const provider = providers.get(current.model)
  if (!provider || !isRecent(current.lastSeen, now)) return null

  const currentRate = oneShotRate(current)
  const currentCost = costPerEdit(current)
  if (!Number.isFinite(currentCost) || currentCost <= 0) return null

  const debuggingHeavy = isDebuggingHeavy(project)
  const tolerance = debuggingHeavy ? 0 : ONE_SHOT_TOLERANCE

  const candidates = stats
    .slice(1)
    .filter(candidate => providers.get(candidate.model) === provider)
    .filter(candidate => isRecent(candidate.lastSeen, now))
    .map(candidate => ({
      candidate,
      candidateRate: oneShotRate(candidate),
      candidateCost: costPerEdit(candidate),
    }))
    .filter(({ candidateRate }) => candidateRate >= currentRate - tolerance)
    .filter(({ candidateCost }) => candidateCost <= currentCost * MAX_COST_RATIO)
    .sort((a, b) => {
      const savingsA = 1 - a.candidateCost / currentCost
      const savingsB = 1 - b.candidateCost / currentCost
      return savingsB - savingsA || b.candidateRate - a.candidateRate
    })

  const best = candidates[0]
  if (!best) return null

  return {
    project: project.project,
    projectPath: project.projectPath,
    currentModel: current.model,
    candidateModel: best.candidate.model,
    provider,
    currentEditTurns: current.editTurns,
    candidateEditTurns: best.candidate.editTurns,
    currentOneShotRate: currentRate,
    candidateOneShotRate: best.candidateRate,
    currentCostPerEdit: currentCost,
    candidateCostPerEdit: best.candidateCost,
    savingsPct: (1 - best.candidateCost / currentCost) * 100,
    debuggingHeavy,
  }
}

export async function buildApplyModelDefaultPlan(recommendation: ModelDefaultRecommendation): Promise<ActionPlan> {
  const settingsPath = join(recommendation.projectPath, '.claude', 'settings.json')
  let settings: Record<string, unknown> = {}
  let expectedHash: string | null = null

  try {
    const raw = await readFile(settingsPath, 'utf-8')
    expectedHash = await sha256File(settingsPath)
    settings = JSON.parse(raw) as Record<string, unknown>
    if (!settings || Array.isArray(settings) || typeof settings !== 'object') settings = {}
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw err
  }

  settings.model = recommendation.candidateModel

  return {
    kind: 'model-default',
    findingId: `model-default:${recommendation.project}`,
    description: `Set Claude Code default model to ${recommendation.candidateModel} for ${recommendation.project}`,
    changes: [{
      op: 'edit',
      path: settingsPath,
      content: JSON.stringify(settings, null, 2) + '\n',
      expectedHash,
    }],
    baseline: {
      windowDays: 30,
      capturedAt: new Date().toISOString(),
      estimatedTokens: 0,
      sessions: recommendation.currentEditTurns + recommendation.candidateEditTurns,
      candidateModel: recommendation.candidateModel,
      metrics: {
        [recommendation.candidateModel]: recommendation.candidateOneShotRate,
        [recommendation.currentModel]: recommendation.currentOneShotRate,
      },
    },
  }
}
