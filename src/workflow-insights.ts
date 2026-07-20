import { homedir } from 'os'

import { EDIT_TOOLS } from './classifier.js'
import { CATEGORY_LABELS, type ProjectSummary, type TaskCategory } from './types.js'

// User-side mirror of compare-stats.ts scanSelfCorrections (which scans the
// assistant's own apologies). These match a *user* follow-up telling the
// assistant it got something wrong. Deliberately conservative: bare "wrong" or
// "undo" are excluded because they show up in ordinary task requests ("fix the
// wrong output", "undo the migration"). Every pattern requires a correction
// context so praise like "you were right" or "that's right" never trips it.
export const USER_CORRECTION_PATTERNS: RegExp[] = [
  /\bthat'?s (?:not|n'?t) (?:what|right|correct|it)\b/i,
  /\bthat'?s (?:wrong|incorrect)\b/i,
  /\bthat is (?:wrong|incorrect|not right)\b/i,
  /\bnot what I (?:meant|wanted|asked|said)\b/i,
  /\bno,? I (?:meant|wanted|said|asked for)\b/i,
  /\byou (?:missed|forgot|misunderstood|broke)\b/i,
  /\brevert (?:that|it|this|the|your)\b/i,
  /\bundo (?:that|it|this|your|the last|the change)\b/i,
  /\bwrong (?:file|approach|place|method|function|answer|way|direction)\b/i,
  /\bstill (?:wrong|broken|failing|not working)\b/i,
]

function matchesCorrection(text: string): boolean {
  return USER_CORRECTION_PATTERNS.some(p => p.test(text))
}

export type UserCorrectionStats = {
  corrections: number
  /// Turns carrying a real user prompt (non-empty userMessage). The denominator
  /// for correctionRate — continuation turns with no fresh prompt are excluded.
  userTurns: number
  correctionRate: number | null
}

export function scanUserCorrections(projects: ProjectSummary[]): UserCorrectionStats {
  let corrections = 0
  let userTurns = 0
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        const msg = turn.userMessage
        if (!msg || !msg.trim()) continue
        userTurns++
        if (matchesCorrection(msg)) corrections++
      }
    }
  }
  return { corrections, userTurns, correctionRate: userTurns > 0 ? corrections / userTurns : null }
}

function callHasEditTools(tools: string[]): boolean {
  return tools.some(t => EDIT_TOOLS.has(t))
}

/// Per-session ms from the session's first turn to the first assistant call
/// that used an edit-family tool. Returns null for sessions that never edited,
/// so those are excluded from the median rather than counted as zero.
export function sessionTimeToFirstEditMs(session: ProjectSummary['sessions'][number]): number | null {
  const startMs = Date.parse(session.turns[0]?.timestamp ?? '')
  if (Number.isNaN(startMs)) return null
  for (const turn of session.turns) {
    for (const call of turn.assistantCalls) {
      if (!callHasEditTools(call.tools)) continue
      const editMs = Date.parse(call.timestamp)
      if (Number.isNaN(editMs)) continue
      // Clamp: out-of-order timestamps across resumed transcripts would
      // otherwise pull the median negative.
      return Math.max(0, editMs - startMs)
    }
  }
  return null
}

export function medianTimeToFirstEditMs(projects: ProjectSummary[]): number | null {
  const samples: number[] = []
  for (const project of projects) {
    for (const session of project.sessions) {
      const ms = sessionTimeToFirstEditMs(session)
      if (ms !== null) samples.push(ms)
    }
  }
  if (samples.length === 0) return null
  samples.sort((a, b) => a - b)
  const mid = Math.floor(samples.length / 2)
  return samples.length % 2 === 0 ? (samples[mid - 1]! + samples[mid]!) / 2 : samples[mid]!
}

export type ReworkedFile = {
  path: string
  sessions: number
  edits: number
}

function relativizePath(absPath: string, projectPath: string): string {
  if (projectPath && (absPath === projectPath || absPath.startsWith(projectPath + '/'))) {
    return absPath.slice(projectPath.length + 1) || absPath
  }
  const home = homedir()
  if (absPath === home || absPath.startsWith(home + '/')) return '~' + absPath.slice(home.length)
  return absPath
}

/// Ranks the files touched most by edit-family tool calls. File paths come from
/// each call's toolSequence, which the parser/cache retain per edit tool_use
/// (see parser.ts and session-cache CachedCall.toolSequence). Rank by distinct
/// sessions first (a file reworked across many sessions is the real churn
/// signal), then total edit calls.
export function aggregateFileChurn(projects: ProjectSummary[], limit = 15): ReworkedFile[] {
  type Acc = { path: string; sessions: Set<string>; edits: number }
  const byPath = new Map<string, Acc>()

  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        for (const call of turn.assistantCalls) {
          if (!call.toolSequence) continue
          for (const step of call.toolSequence) {
            for (const tc of step) {
              if (!EDIT_TOOLS.has(tc.tool) || !tc.file) continue
              let acc = byPath.get(tc.file)
              if (!acc) {
                acc = { path: relativizePath(tc.file, project.projectPath), sessions: new Set(), edits: 0 }
                byPath.set(tc.file, acc)
              }
              acc.sessions.add(session.sessionId)
              acc.edits++
            }
          }
        }
      }
    }
  }

  return [...byPath.values()]
    .map(a => ({ path: a.path, sessions: a.sessions.size, edits: a.edits }))
    .sort((a, b) => b.sessions - a.sessions || b.edits - a.edits || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, limit)
}

/// Share (0-1) of cost-bearing calls that resolved a price. `unpricedCalls` are
/// the calls of models with usage but no pricing table entry (findUnpricedModels).
/// Returns 1 when there is nothing to price (no coverage gap to report).
export function computePricingCoverage(totalCostBearingCalls: number, unpricedCalls: number): number {
  if (totalCostBearingCalls <= 0) return 1
  const priced = Math.max(0, totalCostBearingCalls - unpricedCalls)
  return priced / totalCostBearingCalls
}

export type CategoryOneShot = { category: string; rate: number; editTurns: number }

/// The task category with the weakest one-shot rate (over enough edit turns to
/// trust), used by the coaching notes. Rate is a percentage (0-100), matching
/// model-efficiency and the report's category one-shot figures.
export function worstOneShotCategory(projects: ProjectSummary[], minEditTurns = 5): CategoryOneShot | null {
  const acc = new Map<string, { editTurns: number; oneShotTurns: number }>()
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [cat, d] of Object.entries(session.categoryBreakdown)) {
        const e = acc.get(cat) ?? { editTurns: 0, oneShotTurns: 0 }
        e.editTurns += d.editTurns
        e.oneShotTurns += d.oneShotTurns
        acc.set(cat, e)
      }
    }
  }
  let worst: CategoryOneShot | null = null
  for (const [cat, d] of acc) {
    if (d.editTurns < minEditTurns) continue
    const rate = (d.oneShotTurns / d.editTurns) * 100
    if (!worst || rate < worst.rate) {
      worst = { category: CATEGORY_LABELS[cat as TaskCategory] ?? cat, rate, editTurns: d.editTurns }
    }
  }
  return worst
}

// Coaching-note thresholds. Kept conservative so a note only fires on a signal
// strong enough to act on.
const ONE_SHOT_LOW_PERCENT = 60
const CORRECTION_HIGH_RATE = 0.15
const CORRECTION_MIN_COUNT = 3
const CHURN_MIN_SESSIONS = 3
const TTFE_SLOW_MS = 5 * 60 * 1000

export type CoachingInput = {
  worstOneShot?: CategoryOneShot | null
  corrections?: number
  correctionRate?: number | null
  topReworkedFile?: ReworkedFile | null
  medianTimeToFirstEditMs?: number | null
}

function formatDurationShort(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 1000)}s`
}

/// 1-3 templated one-liners keyed on the strongest workflow signals. Pure
/// templating on already-computed numbers. Copy is dry and specific and uses no
/// em-dashes (UI copy house style).
export function buildCoachingNotes(input: CoachingInput): string[] {
  const notes: string[] = []

  const ws = input.worstOneShot
  if (ws && ws.editTurns >= 5 && ws.rate < ONE_SHOT_LOW_PERCENT) {
    notes.push(`One-shot rate on ${ws.category} is ${Math.round(ws.rate)}% over ${ws.editTurns} edit turns. Add the constraints up front or split the work into smaller edits.`)
  }

  if (input.correctionRate != null && input.correctionRate >= CORRECTION_HIGH_RATE && (input.corrections ?? 0) >= CORRECTION_MIN_COUNT) {
    notes.push(`You corrected the assistant on ${Math.round(input.correctionRate * 100)}% of prompts (${input.corrections} times). State the requirements in the first message to cut the back and forth.`)
  }

  const cf = input.topReworkedFile
  if (cf && cf.sessions >= CHURN_MIN_SESSIONS) {
    notes.push(`${cf.path} was reworked across ${cf.sessions} sessions (${cf.edits} edits). A focused pass on it may cost less than the repeated churn.`)
  }

  if (input.medianTimeToFirstEditMs != null && input.medianTimeToFirstEditMs >= TTFE_SLOW_MS) {
    notes.push(`Median time to first edit is ${formatDurationShort(input.medianTimeToFirstEditMs)}. Point the assistant at the target file to cut the exploration before it starts editing.`)
  }

  return notes.slice(0, 3)
}
