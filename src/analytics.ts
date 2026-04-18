import type { ProjectSummary, SessionSummary, TaskCategory } from './types.js'
import { CATEGORY_LABELS } from './types.js'
import { getShortModelName } from './models.js'

export const TOP_OUTLIER_COUNT = 5
export const OUTLIER_MULTIPLIER = 2

export type OutlierSession = {
  rank: number
  project: string
  sessionId: string
  date: string
  totalCostUSD: number
  dominantActivity: string
  isOutlier: boolean
}

export type ModelOneShotRow = {
  model: string
  sessions: number
  oneShotTurns: number
  editTurns: number
  oneShotRate: number | null
  costUSD: number
}

export function dominantActivity(session: SessionSummary): string {
  let best: TaskCategory | null = null
  let bestCost = -1
  for (const [cat, data] of Object.entries(session.categoryBreakdown)) {
    if (data.costUSD > bestCost) {
      bestCost = data.costUSD
      best = cat as TaskCategory
    }
  }
  return best ? (CATEGORY_LABELS[best] ?? best) : 'General'
}

export function computeOutlierSessions(projects: ProjectSummary[]): OutlierSession[] {
  const projectAvg = new Map<string, number>()
  for (const p of projects) {
    const avg = p.sessions.length > 0 ? p.totalCostUSD / p.sessions.length : 0
    projectAvg.set(p.project, avg)
  }

  const all = projects.flatMap(p =>
    p.sessions.map(s => ({ session: s, project: p.project }))
  )
  const sorted = [...all].sort((a, b) => b.session.totalCostUSD - a.session.totalCostUSD)
  const top = sorted.slice(0, TOP_OUTLIER_COUNT)

  return top.map(({ session, project }, i) => {
    const avg = projectAvg.get(project) ?? 0
    return {
      rank: i + 1,
      project,
      sessionId: session.sessionId,
      date: session.firstTimestamp ? session.firstTimestamp.slice(0, 10) : '----------',
      totalCostUSD: session.totalCostUSD,
      dominantActivity: dominantActivity(session),
      isOutlier: avg > 0 && session.totalCostUSD > OUTLIER_MULTIPLIER * avg,
    }
  })
}

export function computeModelOneShotRates(projects: ProjectSummary[]): ModelOneShotRow[] {
  const modelData = new Map<string, { oneShotTurns: number; editTurns: number; sessions: Set<string>; costUSD: number }>()

  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        const primaryModel = turn.assistantCalls[0]
          ? getShortModelName(turn.assistantCalls[0].model)
          : null
        if (!primaryModel) continue
        const entry = modelData.get(primaryModel) ?? {
          oneShotTurns: 0,
          editTurns: 0,
          sessions: new Set<string>(),
          costUSD: 0,
        }
        if (turn.hasEdits) {
          entry.editTurns++
          if (turn.retries === 0) entry.oneShotTurns++
        }
        modelData.set(primaryModel, entry)
      }
      for (const [model, data] of Object.entries(session.modelBreakdown)) {
        const entry = modelData.get(model) ?? {
          oneShotTurns: 0,
          editTurns: 0,
          sessions: new Set<string>(),
          costUSD: 0,
        }
        entry.costUSD += data.costUSD
        entry.sessions.add(session.sessionId)
        modelData.set(model, entry)
      }
    }
  }

  const rows: ModelOneShotRow[] = []
  for (const [model, data] of modelData) {
    rows.push({
      model,
      sessions: data.sessions.size,
      oneShotTurns: data.oneShotTurns,
      editTurns: data.editTurns,
      oneShotRate: data.editTurns > 0 ? data.oneShotTurns / data.editTurns : null,
      costUSD: data.costUSD,
    })
  }

  return rows.sort((a, b) => {
    if (a.oneShotRate === null && b.oneShotRate === null) return b.costUSD - a.costUSD
    if (a.oneShotRate === null) return 1
    if (b.oneShotRate === null) return -1
    return b.oneShotRate - a.oneShotRate || b.costUSD - a.costUSD
  })
}
