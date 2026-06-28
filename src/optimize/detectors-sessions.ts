import type { ProjectSummary } from '../types.js'
import { formatCost } from '../currency.js'
import { formatTokens } from '../format.js'
import {
  CACHE_READ_DISCOUNT,
  CACHE_WRITE_MULTIPLIER,
  CONTEXT_BLOAT_RATIO_DISPLAY_CAP,
  DELIVERY_COMMAND_PATTERNS,
  WORTH_IT_MIN_COST_USD,
  WORTH_IT_NO_EDIT_MIN_COST_USD,
  WORTH_IT_MIN_RETRIES,
  WORTH_IT_RETRY_WITH_EDIT_MIN_RETRIES,
  WORTH_IT_PREVIEW,
  WORTH_IT_HIGH_MIN_CANDIDATES,
  WORTH_IT_HIGH_TOTAL_COST_USD,
  WORTH_IT_LOW_MAX_CANDIDATES,
  WORTH_IT_LOW_MAX_TOTAL_COST_USD,
  CONTEXT_BLOAT_MIN_INPUT_TOKENS,
  CONTEXT_BLOAT_MIN_RATIO,
  CONTEXT_BLOAT_TARGET_RATIO,
  CONTEXT_BLOAT_PREVIEW,
  CONTEXT_BLOAT_GROWTH_RATIO,
  CONTEXT_BLOAT_GROWTH_MAX_GAP_MS,
  CONTEXT_BLOAT_HIGH_MIN_CANDIDATES,
  CONTEXT_BLOAT_HIGH_INPUT_TOKENS,
  CONTEXT_BLOAT_LOW_MAX_CANDIDATES,
  CONTEXT_BLOAT_LOW_INPUT_TOKENS,
  MIN_SESSIONS_FOR_OUTLIER,
  SESSION_OUTLIER_MULTIPLIER,
  MIN_SESSION_OUTLIER_COST_USD,
  SESSION_OUTLIER_PREVIEW,
} from './constants.js'
import type { WasteFinding, Impact, LowWorthCandidate, ContextBloatCandidate } from './types.js'

function sessionTokenTotal(session: ProjectSummary['sessions'][number]): number {
  return session.totalInputTokens
    + session.totalOutputTokens
    + session.totalCacheReadTokens
    + session.totalCacheWriteTokens
}

function sessionEffectiveContextTokens(session: ProjectSummary['sessions'][number]): number {
  return session.totalInputTokens
    + session.totalCacheReadTokens * CACHE_READ_DISCOUNT
    + session.totalCacheWriteTokens * CACHE_WRITE_MULTIPLIER
}

function formatContextRatio(ratio: number): string {
  if (ratio >= CONTEXT_BLOAT_RATIO_DISPLAY_CAP) return `${CONTEXT_BLOAT_RATIO_DISPLAY_CAP}+`
  return ratio.toFixed(1)
}

function sessionDeliveryCommand(session: ProjectSummary['sessions'][number]): string | null {
  const commands = Object.keys(session.bashBreakdown)
  return commands.find(command => DELIVERY_COMMAND_PATTERNS.some(pattern => pattern.test(command))) ?? null
}

function hasCategoryBreakdownData(session: ProjectSummary['sessions'][number]): boolean {
  return Object.values(session.categoryBreakdown).some(category =>
    category.turns > 0
    || category.costUSD > 0
    || category.retries > 0
    || category.editTurns > 0
    || category.oneShotTurns > 0
  )
}

function sessionEditTurns(session: ProjectSummary['sessions'][number]): number {
  if (hasCategoryBreakdownData(session)) {
    return Object.values(session.categoryBreakdown).reduce((sum, c) => sum + c.editTurns, 0)
  }
  return session.turns.filter(turn => turn.hasEdits).length
}

function sessionOneShotTurns(session: ProjectSummary['sessions'][number]): number {
  if (hasCategoryBreakdownData(session)) {
    return Object.values(session.categoryBreakdown).reduce((sum, c) => sum + c.oneShotTurns, 0)
  }
  return session.turns.filter(turn => turn.hasEdits && turn.retries === 0).length
}

function sessionRetryCount(session: ProjectSummary['sessions'][number]): number {
  if (hasCategoryBreakdownData(session)) {
    return Object.values(session.categoryBreakdown).reduce((sum, c) => sum + c.retries, 0)
  }
  return session.turns.reduce((sum, turn) => sum + turn.retries, 0)
}

function sessionTotalTurns(session: ProjectSummary['sessions'][number]): number {
  if (hasCategoryBreakdownData(session)) {
    return Object.values(session.categoryBreakdown).reduce((sum, c) => sum + c.turns, 0)
  }
  return session.turns.length
}

// Token-savings estimate for a low-worth candidate. Two regimes:
//   - No-edit sessions: full session tokens are at risk (the session produced
//     no apparent output to weigh against the spend).
//   - Sessions with edits but with retries / no one-shot: only the retry
//     fraction is counted as recoverable. Edits may still have been useful;
//     we credit the model with that and only flag the retry overhead.
// Ratio is bounded to [0, 1] so retry-heavy sessions with weird turn counts
// can't claim more than the full session token total.
function estimateLowWorthRecoverableTokens(
  session: ProjectSummary['sessions'][number],
  editTurns: number,
  retries: number,
): number {
  const tokens = sessionTokenTotal(session)
  if (editTurns === 0) return tokens
  const totalTurns = sessionTotalTurns(session)
  if (totalTurns === 0) return 0
  const fraction = Math.min(1, Math.max(0, retries / totalTurns))
  return Math.round(tokens * fraction)
}

export function findLowWorthCandidates(projects: ProjectSummary[]): LowWorthCandidate[] {
  const candidates: LowWorthCandidate[] = []

  for (const project of projects) {
    for (const session of project.sessions) {
      if (session.totalCostUSD < WORTH_IT_MIN_COST_USD) continue
      if (sessionDeliveryCommand(session)) continue

      const editTurns = sessionEditTurns(session)
      const oneShotTurns = sessionOneShotTurns(session)
      const retries = sessionRetryCount(session)
      const reasons: string[] = []

      if (editTurns === 0 && session.totalCostUSD >= WORTH_IT_NO_EDIT_MIN_COST_USD) {
        reasons.push('no edit turns')
      }
      if (retries >= WORTH_IT_MIN_RETRIES) {
        reasons.push(`${retries} retries`)
      }
      if (
        editTurns > 0
        && oneShotTurns === 0
        && retries >= WORTH_IT_RETRY_WITH_EDIT_MIN_RETRIES
      ) {
        reasons.push('no one-shot edit turns')
      }

      if (reasons.length === 0) continue

      candidates.push({
        project: project.project,
        sessionId: session.sessionId,
        date: session.firstTimestamp.slice(0, 10),
        cost: session.totalCostUSD,
        tokens: estimateLowWorthRecoverableTokens(session, editTurns, retries),
        reasons,
      })
    }
  }

  candidates.sort((a, b) =>
    b.cost - a.cost
    || a.date.localeCompare(b.date)
    || a.project.localeCompare(b.project)
    || a.sessionId.localeCompare(b.sessionId)
  )
  return candidates
}

export function detectLowWorthSessions(projects: ProjectSummary[]): WasteFinding | null {
  const candidates = findLowWorthCandidates(projects)
  if (candidates.length === 0) return null

  const preview = candidates.slice(0, WORTH_IT_PREVIEW)
  const list = preview
    .map(s => `${s.project}/${s.sessionId} on ${s.date}: ${formatCost(s.cost)} (${s.reasons.join(', ')})`)
    .join('; ')
  const extra = candidates.length > preview.length ? `; +${candidates.length - preview.length} more` : ''
  // Per-candidate `tokens` is already the recoverable estimate (full session
  // for no-edit, retry-fraction for edit-with-retries). Sum across candidates.
  const tokensSaved = Math.round(candidates.reduce((sum, s) => sum + s.tokens, 0))
  const totalCost = candidates.reduce((sum, s) => sum + s.cost, 0)

  // Three tiers consistent with detectContextBloat: high at >=10 candidates
  // or >=$50 total spend at risk; low at <=2 candidates AND <$10 total;
  // medium in between.
  let impact: Impact
  if (candidates.length >= WORTH_IT_HIGH_MIN_CANDIDATES || totalCost >= WORTH_IT_HIGH_TOTAL_COST_USD) {
    impact = 'high'
  } else if (candidates.length <= WORTH_IT_LOW_MAX_CANDIDATES && totalCost < WORTH_IT_LOW_MAX_TOTAL_COST_USD) {
    impact = 'low'
  } else {
    impact = 'medium'
  }

  return {
    title: `${candidates.length} possibly low-worth expensive session${candidates.length === 1 ? '' : 's'}`,
    explanation: `Sessions with meaningful spend but weak delivery signals: ${list}${extra}. This is a review candidate, not proof of waste: CodeBurn flags missing edit turns, repeated retries, and sessions without git delivery commands so you can decide whether the work was worth its cost before it becomes a habit.`,
    impact,
    tokensSaved,
    fix: {
      type: 'paste',
      destination: 'session-opener',
      label: 'Paste at the start of your NEXT expensive thread (one-time, do not add to CLAUDE.md):',
      text: 'Before continuing, name the deliverable in one sentence (PR title, file changed, command output you expect). Stop and check with me if (a) you spend more than 10 minutes without an edit, or (b) the same approach fails twice. Do not retry past two attempts on any single fix.',
    },
  }
}

export function findContextBloatCandidates(projects: ProjectSummary[]): ContextBloatCandidate[] {
  const candidates: ContextBloatCandidate[] = []

  for (const project of projects) {
    const sessions = [...project.sessions].sort((a, b) =>
      new Date(a.firstTimestamp).getTime() - new Date(b.firstTimestamp).getTime()
    )
    let previousInputTokens: number | null = null
    let previousTimestampMs: number | null = null

    for (const session of sessions) {
      const inputTokens = sessionEffectiveContextTokens(session)
      const outputTokens = session.totalOutputTokens
      const ratio = inputTokens / Math.max(outputTokens, 1)
      const currentMs = new Date(session.firstTimestamp).getTime()
      const gapMs = previousTimestampMs !== null ? currentMs - previousTimestampMs : null
      // Suppress growth ratio when the previous session is too far back to be
      // a meaningful baseline (e.g. a small test run weeks before a real
      // working session would otherwise produce alarming "1000x" figures).
      const growthRatio = previousInputTokens !== null
        && previousInputTokens > 0
        && gapMs !== null
        && gapMs <= CONTEXT_BLOAT_GROWTH_MAX_GAP_MS
        ? inputTokens / previousInputTokens
        : null

      // Anchor growth to the immediately previous project session, even if
      // that session is below threshold and never becomes a finding.
      previousInputTokens = inputTokens
      previousTimestampMs = currentMs

      if (inputTokens < CONTEXT_BLOAT_MIN_INPUT_TOKENS) continue
      if (ratio < CONTEXT_BLOAT_MIN_RATIO) continue

      candidates.push({
        project: project.project,
        sessionId: session.sessionId,
        date: session.firstTimestamp.slice(0, 10),
        effectiveInputTokens: inputTokens,
        outputTokens,
        ratio,
        excessInputTokens: Math.max(0, inputTokens - outputTokens * CONTEXT_BLOAT_TARGET_RATIO),
        growthRatio,
      })
    }
  }

  candidates.sort((a, b) =>
    b.excessInputTokens - a.excessInputTokens
    || a.date.localeCompare(b.date)
    || a.project.localeCompare(b.project)
    || a.sessionId.localeCompare(b.sessionId)
  )
  return candidates
}

export function detectContextBloat(projects: ProjectSummary[], excludedSessionIds?: ReadonlySet<string>): WasteFinding | null {
  const candidates = findContextBloatCandidates(projects)
    .filter(c => !excludedSessionIds?.has(c.sessionId))
  if (candidates.length === 0) return null

  const preview = candidates.slice(0, CONTEXT_BLOAT_PREVIEW)
  const list = preview
    .map(c => {
      const growth = c.growthRatio !== null && c.growthRatio >= CONTEXT_BLOAT_GROWTH_RATIO
        ? `, ${c.growthRatio.toFixed(1)}x previous session input`
        : ''
      return `${c.project}/${c.sessionId} on ${c.date}: ${formatTokens(c.effectiveInputTokens)} effective input/cache vs ${formatTokens(c.outputTokens)} output (${formatContextRatio(c.ratio)}:1${growth})`
    })
    .join('; ')
  const extra = candidates.length > preview.length ? `; +${candidates.length - preview.length} more` : ''
  // Savings estimate only counts context above a healthier 15:1 input-output ratio.
  // Detection stays stricter at 25:1 so borderline sessions are not shown.
  const tokensSaved = Math.round(candidates.reduce((sum, c) => sum + c.excessInputTokens, 0))
  const totalInputTokens = candidates.reduce((sum, c) => sum + c.effectiveInputTokens, 0)

  // Tier on candidate count first, total context size second. A single 600K
  // session is "high"; 1-2 modest-sized sessions are "low"; everything in
  // between is "medium".
  let impact: Impact
  if (candidates.length >= CONTEXT_BLOAT_HIGH_MIN_CANDIDATES || totalInputTokens >= CONTEXT_BLOAT_HIGH_INPUT_TOKENS) {
    impact = 'high'
  } else if (candidates.length <= CONTEXT_BLOAT_LOW_MAX_CANDIDATES && totalInputTokens < CONTEXT_BLOAT_LOW_INPUT_TOKENS) {
    impact = 'low'
  } else {
    impact = 'medium'
  }

  return {
    title: `${candidates.length} context-heavy session${candidates.length === 1 ? '' : 's'}`,
    explanation: `Effective input/cache tokens swamp output in these sessions: ${list}${extra}. This can come from stale context carryover, inherently context-heavy work, or abandoned runs that loaded too much context; starting fresh with only the current goal and relevant files can cut repeated prompt overhead.`,
    impact,
    tokensSaved,
    fix: {
      type: 'paste',
      destination: 'session-opener',
      label: 'Paste at the start of your NEXT expensive thread (one-time, do not add to CLAUDE.md):',
      text: 'Start fresh before continuing. Use only the current goal, the relevant files, the failing command/output, and the constraints below. Restate the working context in under 10 bullets before editing.',
    },
  }
}

export function detectSessionOutliers(projects: ProjectSummary[], excludedSessionIds?: ReadonlySet<string>): WasteFinding | null {
  type Outlier = {
    project: string
    sessionId: string
    date: string
    cost: number
    avgCost: number
    ratio: number
    tokenExcess: number
  }

  const outliers: Outlier[] = []

  for (const project of projects) {
    const sessions = project.sessions.filter(s => s.totalCostUSD > 0)
    if (sessions.length < MIN_SESSIONS_FOR_OUTLIER) continue

    const totalCost = sessions.reduce((sum, s) => sum + s.totalCostUSD, 0)
    const totalTokens = sessions.reduce((sum, s) => sum + sessionTokenTotal(s), 0)
    for (const session of sessions) {
      const avgCost = (totalCost - session.totalCostUSD) / (sessions.length - 1)
      const avgTokens = (totalTokens - sessionTokenTotal(session)) / (sessions.length - 1)
      if (avgCost <= 0) continue

      const ratio = session.totalCostUSD / avgCost
      if (ratio <= SESSION_OUTLIER_MULTIPLIER) continue
      if (session.totalCostUSD < MIN_SESSION_OUTLIER_COST_USD) continue
      // Avoid reporting the same session under both this finding and the
      // context-bloat finding. Context-bloat takes priority because its
      // suggested fix ("start fresh") is more concrete than the generic
      // "tighter constraint" advice here.
      if (excludedSessionIds?.has(session.sessionId)) continue

      outliers.push({
        project: project.project,
        sessionId: session.sessionId,
        date: session.firstTimestamp.slice(0, 10),
        cost: session.totalCostUSD,
        avgCost,
        ratio,
        tokenExcess: Math.max(0, sessionTokenTotal(session) - avgTokens),
      })
    }
  }

  if (outliers.length === 0) return null

  outliers.sort((a, b) => b.cost - a.cost)
  const preview = outliers.slice(0, SESSION_OUTLIER_PREVIEW)
  const list = preview
    .map(o => `${o.project}/${o.sessionId} on ${o.date}: ${formatCost(o.cost)} (${o.ratio.toFixed(1)}x avg)`)
    .join('; ')
  const extra = outliers.length > preview.length ? `; +${outliers.length - preview.length} more` : ''
  const tokensSaved = Math.round(outliers.reduce((sum, o) => sum + o.tokenExcess, 0))
  const totalExcessCost = outliers.reduce((sum, o) => sum + Math.max(0, o.cost - o.avgCost), 0)

  return {
    title: `${outliers.length} high-cost session outlier${outliers.length === 1 ? '' : 's'}`,
    explanation: `Sessions costing more than ${SESSION_OUTLIER_MULTIPLIER}x their peer-session average in the same project: ${list}${extra}. These usually come from broad prompts, runaway loops, or context-heavy work that should be split into smaller sessions.`,
    impact: outliers.length >= 3 || totalExcessCost >= 10 ? 'high' : 'medium',
    tokensSaved,
    fix: {
      type: 'paste',
      destination: 'session-opener',
      label: 'Paste at the start of your NEXT expensive thread (one-time, do not add to CLAUDE.md):',
      text: 'Before making changes, summarize the smallest viable plan. Keep context narrow, avoid broad searches, and stop after the first working patch so I can review before continuing.',
    },
  }
}
