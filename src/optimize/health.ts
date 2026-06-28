import type { DateRange, ProjectSummary } from '../types.js'
import {
  HEALTH_WEIGHT_HIGH,
  HEALTH_WEIGHT_MEDIUM,
  HEALTH_WEIGHT_LOW,
  HEALTH_MAX_PENALTY,
  GRADE_A_MIN,
  GRADE_B_MIN,
  GRADE_C_MIN,
  GRADE_D_MIN,
  URGENCY_IMPACT_WEIGHT,
  URGENCY_TOKEN_WEIGHT,
  URGENCY_TOKEN_NORMALIZE,
  IMPROVING_THRESHOLD,
  DEFAULT_TREND_PERIOD_MS,
  RECENT_WINDOW_MS,
  INPUT_COST_RATIO,
  DEFAULT_COST_PER_TOKEN,
} from './constants.js'
import type { Impact, HealthGrade, WasteFinding, Trend, TrendInputs } from './types.js'

// ============================================================================
// Scoring
// ============================================================================

const HEALTH_WEIGHTS: Record<Impact, number> = {
  high: HEALTH_WEIGHT_HIGH,
  medium: HEALTH_WEIGHT_MEDIUM,
  low: HEALTH_WEIGHT_LOW,
}

export function computeHealth(findings: WasteFinding[]): { score: number; grade: HealthGrade } {
  if (findings.length === 0) return { score: 100, grade: 'A' }
  let penalty = 0
  for (const f of findings) penalty += HEALTH_WEIGHTS[f.impact] ?? 0
  const score = Math.max(0, 100 - Math.min(HEALTH_MAX_PENALTY, penalty))
  const grade: HealthGrade =
    score >= GRADE_A_MIN ? 'A' :
    score >= GRADE_B_MIN ? 'B' :
    score >= GRADE_C_MIN ? 'C' :
    score >= GRADE_D_MIN ? 'D' : 'F'
  return { score, grade }
}

const URGENCY_WEIGHTS: Record<Impact, number> = { high: 1, medium: 0.5, low: 0.2 }

export function urgencyScore(f: WasteFinding): number {
  const normalizedTokens = Math.min(1, f.tokensSaved / URGENCY_TOKEN_NORMALIZE)
  return URGENCY_WEIGHTS[f.impact] * URGENCY_IMPACT_WEIGHT + normalizedTokens * URGENCY_TOKEN_WEIGHT
}

export function computeTrend(inputs: TrendInputs): Trend | 'resolved' {
  const { recentCount, recentWindowMs, baselineCount, baselineWindowMs, hasRecentActivity } = inputs
  if (baselineCount === 0) return 'active'
  if (recentCount === 0 && hasRecentActivity) return 'resolved'
  if (!hasRecentActivity) return 'active'
  const baselineRate = baselineCount / baselineWindowMs
  const recentRate = recentCount / Math.max(recentWindowMs, 1)
  if (recentRate < baselineRate * IMPROVING_THRESHOLD) return 'improving'
  return 'active'
}

export function sessionTrend(
  recentItemCount: number,
  totalItemCount: number,
  dateRange: DateRange | undefined,
  hasRecentActivity: boolean,
): Trend | 'resolved' {
  const now = Date.now()
  const baselineCount = totalItemCount - recentItemCount
  const periodStart = dateRange ? dateRange.start.getTime() : now - DEFAULT_TREND_PERIOD_MS
  const recentStart = now - RECENT_WINDOW_MS
  const baselineWindowMs = Math.max(recentStart - periodStart, 1)
  return computeTrend({
    recentCount: recentItemCount,
    recentWindowMs: RECENT_WINDOW_MS,
    baselineCount,
    baselineWindowMs,
    hasRecentActivity,
  })
}

// ============================================================================
// Cost estimation
// ============================================================================

export function computeInputCostRate(projects: ProjectSummary[]): number {
  const sessions = projects.flatMap(p => p.sessions)
  const totalCost = sessions.reduce((s, sess) => s + sess.totalCostUSD, 0)
  const totalTokens = sessions.reduce((s, sess) =>
    s + sess.totalInputTokens + sess.totalCacheReadTokens + sess.totalCacheWriteTokens, 0)
  if (totalTokens === 0 || totalCost === 0) return DEFAULT_COST_PER_TOKEN
  return (totalCost * INPUT_COST_RATIO) / totalTokens
}
