import { isBehavioralCall } from './behavioral-weight.js'
import { dateKey } from './day-aggregator.js'
import { spendProjectIdentity } from './spend-flow.js'
import type { ProjectSummary, SessionSummary } from './types.js'
import { callBillableOutputTokens, inferSessionProvider, modelBreakdownKey } from './session-output.js'
import type { SessionRow } from './sessions-report.js'

/// One attributed slice of a session's in-range spend. Segments PARTITION the
/// session: every call lands in exactly one segment (consecutive calls with the
/// same day/category/branch/PR-set are merged), so summing segment costs over a
/// session reproduces the session's row cost, and summing a single dimension's
/// contributions over all segments reconciles that dimension's aggregate.
///
///   day      — local YYYY-MM-DD of the call (same bucketing as history.daily),
///              falling back to its turn when the call timestamp is unusable.
///   category — the turn's task category, or null when unclassified.
///   branch   — the git branch carried forward across the session's turns
///              (same reconstruction as aggregateByBranch); null before the
///              first observed branch, and for providers that never record one.
///   models   — short model name -> attributed cost (the same key family as
///              modelBreakdown / by-PR model chips). The map sums to `cost`,
///              with any unattributable remainder under ''.
///   prs      — the turn's ACTIVE PR set, carried forward exactly like
///              attributeSessionPrSpend (seeded by prRefsAtRangeStart). [] means
///              the turn's spend is not tied to any PR (unattributed). A multi-PR
///              set is listed whole: attributing to one PR of the set is a
///              share (1/len) of the segment, never the full amount. A legacy
///              session whose transcript expired keeps its session-level
///              prLinks instead: every segment carries that whole set with
///              `approx: true`, mirroring the by-PR even-split fallback.
export type ContributionSegment = {
  day: string
  category: string | null
  branch: string | null
  models: Record<string, number>
  /// Actual request/token counts for each model, independent of its price.
  /// Optional only for compatibility with previously cached payloads.
  modelUsage?: Record<string, { calls: number; inputTokens: number; outputTokens: number }>
  prs: string[]
  /// True when this segment's PR set is the legacy whole-session even split
  /// (transcript expired before per-turn capture). Absent otherwise.
  approx?: true
  cost: number
  calls: number
  savingsUSD: number
  inputTokens: number
  outputTokens: number
}

/// Per-session contribution payload attached to a SessionRow by
/// `withContributions` (opt-in via `sessions --contributions`). Purely additive:
/// every existing field keeps its meaning and value.
export type SessionContributions = {
  segments: ContributionSegment[]
}

export type SessionDrillRow = SessionRow & {
  /// Canonical project identity (spendProjectIdentity of the owning project)
  /// — the SAME id the menubar payload's topProjects[].id carries, so a
  /// project drill-through chip matches rows exactly and prefix-similar paths
  /// (/a/app vs /a/app-beta) can never capture each other's sessions.
  projectId?: string
  /// Claude/recorded parent of a subagent (sidechain) transcript, when the
  /// provider wrote the link durably. Additive integration point for work-unit
  /// grouping; absent for ordinary sessions.
  parentSessionId?: string
  /// The subagent id inside the parent's spawn map. Additive; absent otherwise.
  agentId?: string
  /// True when this record is a sidechain transcript. Additive; absent otherwise.
  isSidechain?: boolean
  /// Turn-granular contribution segments. Present only when requested.
  contributions?: SessionContributions
}

const UNKNOWN_MODEL_KEY = ''

/// The session's local-day key for a turn, mirroring the day aggregator's
/// bucketing order (turn timestamp, then the first call's). '' when neither is
/// a real timestamp so an unparseable turn can never masquerade as a date.
function turnDayKey(turn: SessionSummary['turns'][number], fallback: string): string {
  const iso = turn.timestamp || turn.assistantCalls[0]?.timestamp || fallback
  if (!iso) return ''
  const key = dateKey(iso)
  return key.includes('NaN') ? '' : key
}

/// The model-dimension key of a call: the same short-name family the parser
/// keys modelBreakdown with, '' when the call carries no model at all.
function modelKeyFor(call: { provider?: string; model?: string }): string {
  return modelBreakdownKey(call) ?? UNKNOWN_MODEL_KEY
}

function prsKey(prs: string[]): string {
  return prs.join('\u0000')
}

/// Build one session's contribution segments by walking its turns in order,
/// carrying forward both the active PR set (seeded by `prRefsAtRangeStart`, the
/// attributeSessionPrSpend rule) and the last observed git branch (the
/// aggregateByBranch rule). Turns that carry nothing at all (no cost, calls,
/// savings, or tokens) are skipped, matching the by-PR attribution's empty-turn
/// rule; a tokens-only turn is kept so the token partition stays complete.
export function buildSessionContributions(session: SessionSummary): SessionContributions {
  const segments: ContributionSegment[] = []
  let currentPrs: string[] | null = session.prRefsAtRangeStart?.length ? session.prRefsAtRangeStart : null
  let sawTurnRefs = false
  let currentBranch: string | null = null

  for (const turn of session.turns) {
    if (turn.prRefs?.length) { currentPrs = turn.prRefs; sawTurnRefs = true }
    if (turn.gitBranch) currentBranch = turn.gitBranch

    const prs = currentPrs ?? []
    const turnDay = turnDayKey(turn, session.firstTimestamp)
    const category = turn.category ?? null
    for (const call of turn.assistantCalls) {
      const cost = call.costUSD
      const savings = call.savingsUSD ?? 0
      const inputTokens = call.usage.inputTokens
      const outputTokens = callBillableOutputTokens(call)
      const calls = isBehavioralCall(call) ? 1 : 0
      if (cost === 0 && calls === 0 && savings === 0 && inputTokens === 0 && outputTokens === 0) continue
      const day = Number.isNaN(new Date(call.timestamp).getTime()) ? turnDay : dateKey(call.timestamp)
      const key = modelKeyFor(call)
      let segment = segments.at(-1)
      if (!segment || segment.day !== day || segment.category !== category || segment.branch !== currentBranch || prsKey(segment.prs) !== prsKey(prs)) {
        segment = {
          day, category, branch: currentBranch, prs,
          models: Object.create(null), modelUsage: Object.create(null),
          cost: 0, calls: 0, savingsUSD: 0, inputTokens: 0, outputTokens: 0,
        }
        segments.push(segment)
      }
      segment.cost += cost
      segment.calls += calls
      segment.savingsUSD += savings
      segment.inputTokens += inputTokens
      segment.outputTokens += outputTokens
      segment.models[key] = (segment.models[key] ?? 0) + cost
      const usage = segment.modelUsage![key] ?? { calls: 0, inputTokens: 0, outputTokens: 0 }
      usage.calls += calls
      usage.inputTokens += inputTokens
      usage.outputTokens += outputTokens
      segment.modelUsage![key] = usage
    }
  }

  // Legacy fallback, mirroring attributeSessionPrSpend: a session whose
  // transcript expired keeps its session-level prLinks but has no per-turn
  // refs. With no turn boundaries to attribute by, every segment carries the
  // WHOLE prLinks set (each PR's share is 1/len of the segment) and is marked
  // approx, so a PR drill-through reconciles with the by-PR report.
  if (!sawTurnRefs && !session.prRefsAtRangeStart?.length && session.prLinks?.length) {
    for (const segment of segments) {
      segment.prs = [...session.prLinks]
      segment.approx = true
    }
  }
  return { segments }
}

/// Attach `contributions` (and the identity/lineage integration fields) to the
/// default session rows. `rows` must be the exact `aggregateSessions(projects)`
/// output. Provider, project label and session id locate a candidate; ambiguous
/// identities (including identical labels at different paths) stay unannotated
/// because plain SessionRow does not carry a canonical project path.
export function withContributions(rows: SessionRow[], projects: ProjectSummary[]): SessionDrillRow[] {
  const drillSessions = new Map<string, { session: SessionSummary; projectId: string } | null>()
  const keyFor = (provider: string, project: string, sessionId: string) => JSON.stringify([provider, project, sessionId])
  for (const project of projects) {
    const projectId = spendProjectIdentity({ project: project.project, projectPath: project.projectPath }).id
    for (const session of project.sessions) {
      const key = keyFor(inferSessionProvider(session), session.project || project.project, session.sessionId)
      drillSessions.set(key, drillSessions.has(key) ? null : { session, projectId })
    }
  }
  return rows.map(row => {
    const found = drillSessions.get(keyFor(row.provider, row.project, row.sessionId))
    const drill: SessionDrillRow = { ...row, projectId: found?.projectId }
    if (found) {
      const { session } = found
      drill.contributions = buildSessionContributions(session)
      if (session.parentSessionId) drill.parentSessionId = session.parentSessionId
      if (session.agentId) drill.agentId = session.agentId
      if (session.isSidechain) drill.isSidechain = true
    }
    return drill
  })
}
