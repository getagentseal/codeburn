import { reportUnmatchedProjectPatterns } from './project-filter-warnings.js'
import { cachedProjectIdentitiesForRange } from './daily-cache.js'
import { toDateString } from './daily-cache.js'
import { filterProjectsByName, parseAllSessions } from './parser.js'
import { inferSessionProvider } from './session-output.js'
import { behavioralCallCount } from './behavioral-weight.js'
import { spendProjectIdentity } from './spend-flow.js'
import type { DateRange, ProjectSummary, SessionSummary } from './types.js'

/// Per-branch-and-project spend, the Spend "By branch" lens. Extends the
/// branch-name-only `aggregateByBranch` (sessions-report.ts) with the canonical
/// project in the row key, so two projects that both have a `main` branch never
/// merge, and with per-session contributions, worktree evidence, and coverage
/// splits so every attributed dollar is explained.
///
/// The reuse rules are the same as `aggregateByBranch`:
/// - The cache stores a turn's branch only when it CHANGES, so a report must
///   reconstruct each turn's branch by carrying the last-seen value forward.
///   (The parser already resolves this carry across a date-range boundary, so a
///   turn active after a branch switch made before the window carries the right
///   branch here; turns that genuinely precede the session's first-ever branch
///   arrive with no branch and stay unknown.)
/// - Only sessions that EVER observed a branch participate. A provider that
///   never captures branch data (everything but Claude today) would otherwise
///   pile all of its spend into one unknown bucket that dwarfs every real
///   branch; those sessions are reported separately as coverage instead.
/// - A session that switches branches contributes its turn-level cost to EACH
///   branch it touched, so branch rows (and project totals over them) must
///   never be summed into a distinct-session count. Distinct sessions are
///   counted by identity, once, per project and overall.

export type BranchTokenSplit = {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/// One session's contribution inside a single (project, branch) row. The cost
/// is the branch-sliced portion (a session in two branch rows shows each
/// portion, not its whole total).
export type BranchSpendSessionRow = {
  sessionId: string
  /// Human session title captured from the transcript. Absent when none.
  title?: string
  /// Inferred provider id (first turn's call provider, model-name fallback).
  provider: string
  /// The provider-recorded historical working directory, BEFORE git-worktree
  /// canonicalization — for a session that ran in a linked worktree this is
  /// the worktree path itself. Evidence-only: never resolved from today's
  /// checkout. Absent when the provider recorded none.
  workingDirectory?: string
  /// Claude Code only: this row is a subagent (sidechain) transcript.
  isSidechain?: boolean
  cost: number
  calls: number
  tokens: BranchTokenSplit
  /// Distinct models contributing cost in this branch, cost-descending.
  models: string[]
  /// First/last attributed call timestamps inside this branch (ISO strings).
  firstActive: string | null
  lastActive: string | null
}

/// Recorded working-directory evidence for one branch row, grouped over the
/// session contributions that carry it.
export type BranchWorktreeRow = {
  path: string
  sessions: number
  cost: number
}

export type BranchSpendRow = {
  /// Canonical project id (absolute projectPath, path-folded) and display
  /// label — the same identity the spend-flow and By project views use.
  projectId: string
  projectLabel: string
  /// The git branch active for the attributed turns. `null` means Unknown:
  /// spend inside a branch-bearing session that happened before its first
  /// observed branch. It is NOT "main" and must never be relabeled.
  branch: string | null
  cost: number
  /// Behavioral calls (supplementary accounting excluded), the app-wide
  /// request counter convention.
  calls: number
  /// Distinct sessions contributing to THIS row (by provider+project+session
  /// identity). A session that switched branches appears in several rows.
  sessions: number
  tokens: BranchTokenSplit
  firstActive: string | null
  lastActive: string | null
  /// Recorded worktree evidence (historical working directories) for the
  /// sessions in this row, cost-descending. Empty when no session recorded one.
  worktrees: BranchWorktreeRow[]
  /// Per-session contributions in this branch, cost-descending.
  sessionRows: BranchSpendSessionRow[]
}

/// Where the in-range spend of one project stands relative to branch metadata.
export type BranchSpendCoverage = {
  /// Cost attributed to named branches.
  branchKnownCost: number
  /// Cost inside branch-bearing sessions that predates their first observed
  /// branch (the `null` branch rows).
  branchUnknownCost: number
  /// Cost from sessions that never observed a branch anywhere in their
  /// transcript — sources without branch metadata. Unknown ≠ 0, and this cost
  /// is NOT relabeled or dropped.
  noBranchDataCost: number
  noBranchDataSessions: number
  /// Providers whose sessions carried no branch metadata, cost-descending.
  noBranchDataProviders: string[]
  /// Distinct sessions across ALL branch rows of the scope (identity-based;
  /// never the sum of row session counts).
  distinctSessions: number
}

export type BranchSpendProjectReport = {
  id: string
  label: string
  /// The project's full in-range cost across all its sessions, including the
  /// no-branch-data share — the same number the By project view reports.
  totalCost: number
  /// Branch rows, named branches cost-descending, then the Unknown (`null`)
  /// row last.
  branches: BranchSpendRow[]
  coverage: BranchSpendCoverage
}

export type BranchSpendReport = {
  period: { label: string; start: string; end: string }
  /// Every project with branch-relevant in-range spend, cost-descending. The
  /// full population for the filters — callers paginate only the display.
  projects: BranchSpendProjectReport[]
  totals: BranchSpendCoverage
}

const NUL = String.fromCharCode(0)

/// Row-level distinct-session key, matching the by-PR convention: provider +
/// project + sessionId, NUL-delimited so ids/names containing spaces or the
/// separator never collide (a session id alone is not globally unique).
function distinctSessionKey(session: SessionSummary): string {
  return `${linkageProvider(session)}${NUL}${session.project}${NUL}${session.sessionId}`
}

function linkageProvider(session: SessionSummary): string {
  if (session.parentSessionId || session.agentSpawnLinks || session.spawnPrSets) return 'claude'
  return inferSessionProvider(session)
}

function emptyTokens(): BranchTokenSplit {
  return { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

function addTokens(acc: BranchTokenSplit, usage: SessionSummary['turns'][number]['assistantCalls'][number]['usage']): void {
  acc.inputTokens += usage.inputTokens
  acc.outputTokens += usage.outputTokens
  acc.reasoningTokens += usage.reasoningTokens
  acc.cacheReadTokens += usage.cacheReadInputTokens
  acc.cacheWriteTokens += usage.cacheCreationInputTokens
}

type SessionAccumulator = {
  key: string
  session: SessionSummary
  provider: string
  cost: number
  calls: number
  tokens: BranchTokenSplit
  models: Map<string, number>
  firstActive: string | null
  lastActive: string | null
}

type BranchAccumulator = {
  branch: string | null
  cost: number
  calls: number
  tokens: BranchTokenSplit
  firstActive: string | null
  lastActive: string | null
  sessions: Map<string, SessionAccumulator>
}

function firstTimestampOf(value: string | null, candidate: string | undefined): string | null {
  if (!candidate) return value
  if (value === null || Date.parse(candidate) < Date.parse(value)) return candidate
  return value
}

function lastTimestampOf(value: string | null, candidate: string | undefined): string | null {
  if (!candidate) return value
  if (value === null || Date.parse(candidate) > Date.parse(value)) return candidate
  return value
}

function projectBranches(project: ProjectSummary): {
  branches: BranchAccumulator[]
  noBranchCost: number
  noBranchSessions: Set<string>
  noBranchProviders: Map<string, number>
  totalCost: number
} {
  const byBranch = new Map<string, BranchAccumulator>()
  let noBranchCost = 0
  const noBranchSessions = new Set<string>()
  const noBranchProviders = new Map<string, number>()
  let totalCost = 0

  for (const session of project.sessions) {
    const participates = session.everHadBranch === true || session.turns.some(turn => !!turn.gitBranch)
    const sessionCallCost = session.turns.reduce(
      (sum, turn) => sum + turn.assistantCalls.reduce((s, call) => s + call.costUSD, 0), 0)
    totalCost += sessionCallCost

    if (!participates) {
      // Source without branch metadata: keep its cost visible in coverage, not
      // in branch rows, so it can never be relabeled as a branch.
      noBranchCost += sessionCallCost
      noBranchSessions.add(distinctSessionKey(session))
      const provider = linkageProvider(session)
      noBranchProviders.set(provider, (noBranchProviders.get(provider) ?? 0) + sessionCallCost)
      continue
    }

    const identity = distinctSessionKey(session)
    const provider = linkageProvider(session)
    // Carry the last-seen branch forward across turns (the cache stores it
    // only when it changes; the parser pre-resolves the range-boundary carry).
    let current: string | null = null
    for (const turn of session.turns) {
      if (turn.gitBranch) current = turn.gitBranch
      if (turn.assistantCalls.length === 0) continue
      let acc = byBranch.get(current ?? '')
      if (!acc) {
        acc = { branch: current, cost: 0, calls: 0, tokens: emptyTokens(), firstActive: null, lastActive: null, sessions: new Map() }
        byBranch.set(current ?? '', acc)
      }
      let sessionAcc = acc.sessions.get(identity)
      if (!sessionAcc) {
        sessionAcc = { key: identity, session, provider, cost: 0, calls: 0, tokens: emptyTokens(), models: new Map(), firstActive: null, lastActive: null }
        acc.sessions.set(identity, sessionAcc)
      }
      for (const call of turn.assistantCalls) {
        acc.cost += call.costUSD
        sessionAcc.cost += call.costUSD
        addTokens(acc.tokens, call.usage)
        addTokens(sessionAcc.tokens, call.usage)
        if (call.model && call.costUSD > 0) sessionAcc.models.set(call.model, (sessionAcc.models.get(call.model) ?? 0) + call.costUSD)
        acc.firstActive = firstTimestampOf(acc.firstActive, call.timestamp)
        acc.lastActive = lastTimestampOf(acc.lastActive, call.timestamp)
        sessionAcc.firstActive = firstTimestampOf(sessionAcc.firstActive, call.timestamp)
        sessionAcc.lastActive = lastTimestampOf(sessionAcc.lastActive, call.timestamp)
      }
      acc.calls += behavioralCallCount(turn.assistantCalls)
      sessionAcc.calls += behavioralCallCount(turn.assistantCalls)
    }
  }

  return { branches: [...byBranch.values()], noBranchCost, noBranchSessions, noBranchProviders, totalCost }
}

function toSessionRow(acc: SessionAccumulator): BranchSpendSessionRow {
  return {
    sessionId: acc.session.sessionId,
    ...(acc.session.title ? { title: acc.session.title } : {}),
    provider: acc.provider,
    ...(acc.session.workingDirectory ? { workingDirectory: acc.session.workingDirectory } : {}),
    ...(acc.session.isSidechain ? { isSidechain: true } : {}),
    cost: acc.cost,
    calls: acc.calls,
    tokens: acc.tokens,
    models: [...acc.models.entries()].sort(([, a], [, b]) => b - a).map(([model]) => model),
    firstActive: acc.firstActive,
    lastActive: acc.lastActive,
  }
}

function toRow(acc: BranchAccumulator, projectId: string, projectLabel: string): BranchSpendRow {
  const sessionRows = [...acc.sessions.values()].sort((a, b) => b.cost - a.cost)
  const worktreeMap = new Map<string, BranchWorktreeRow>()
  for (const s of sessionRows) {
    if (!s.session.workingDirectory) continue
    const existing = worktreeMap.get(s.session.workingDirectory)
    if (existing) {
      existing.sessions += 1
      existing.cost += s.cost
    } else {
      worktreeMap.set(s.session.workingDirectory, { path: s.session.workingDirectory, sessions: 1, cost: s.cost })
    }
  }
  return {
    projectId,
    projectLabel,
    branch: acc.branch,
    cost: acc.cost,
    calls: acc.calls,
    sessions: acc.sessions.size,
    tokens: acc.tokens,
    firstActive: acc.firstActive,
    lastActive: acc.lastActive,
    worktrees: [...worktreeMap.values()].sort((a, b) => b.cost - a.cost),
    sessionRows: sessionRows.map(toSessionRow),
  }
}

function coverageOf(
  branches: BranchAccumulator[],
  noBranchCost: number,
  noBranchSessions: Set<string>,
  noBranchProviders: Map<string, number>,
): BranchSpendCoverage {
  const distinct = new Set<string>()
  for (const acc of branches) for (const key of acc.sessions.keys()) distinct.add(key)
  return {
    branchKnownCost: branches.filter(acc => acc.branch !== null).reduce((sum, acc) => sum + acc.cost, 0),
    branchUnknownCost: branches.filter(acc => acc.branch === null).reduce((sum, acc) => sum + acc.cost, 0),
    noBranchDataCost: noBranchCost,
    noBranchDataSessions: noBranchSessions.size,
    noBranchDataProviders: [...noBranchProviders.entries()].sort(([, a], [, b]) => b - a).map(([provider]) => provider),
    distinctSessions: distinct.size,
  }
}

/// Pure core over an already-parsed, already-filtered project list — unit-test
/// surface for the fixtures with known outcomes.
export function buildBranchSpendReport(projects: ProjectSummary[], range: DateRange): BranchSpendReport {
  const out: BranchSpendProjectReport[] = []
  const totalsDistinct = new Set<string>()
  let totalsKnown = 0
  let totalsUnknown = 0
  let totalsNoBranch = 0
  let totalsNoBranchSessions = 0
  const totalsNoBranchProviders = new Map<string, number>()

  for (const project of projects) {
    const { id: projectId, label: projectLabel } = spendProjectIdentity(project)
    const { branches, noBranchCost, noBranchSessions, noBranchProviders, totalCost } = projectBranches(project)
    if (branches.length === 0 && noBranchCost <= 0) continue
    const sorted = [...branches].sort((a, b) => {
      // Named branches by cost first; the Unknown row sinks to the bottom of
      // its project rather than masquerading as the biggest branch.
      if (a.branch === null && b.branch !== null) return 1
      if (b.branch === null && a.branch !== null) return -1
      const byCost = b.cost - a.cost
      return byCost !== 0 ? byCost : (a.branch ?? '').localeCompare(b.branch ?? '')
    })
    const coverage = coverageOf(branches, noBranchCost, noBranchSessions, noBranchProviders)
    for (const key of noBranchSessions) totalsDistinct.add(key)
    for (const acc of branches) for (const key of acc.sessions.keys()) totalsDistinct.add(key)
    totalsKnown += coverage.branchKnownCost
    totalsUnknown += coverage.branchUnknownCost
    totalsNoBranch += coverage.noBranchDataCost
    totalsNoBranchSessions += coverage.noBranchDataSessions
    for (const [provider, cost] of noBranchProviders) {
      totalsNoBranchProviders.set(provider, (totalsNoBranchProviders.get(provider) ?? 0) + cost)
    }
    out.push({
      id: projectId,
      label: projectLabel,
      totalCost,
      branches: sorted.map(acc => toRow(acc, projectId, projectLabel)),
      coverage,
    })
  }

  out.sort((a, b) => b.totalCost - a.totalCost)
  return {
    period: {
      label: `${toDateString(range.start)} to ${toDateString(range.end)}`,
      start: range.start.toISOString(),
      end: range.end.toISOString(),
    },
    projects: out,
    totals: {
      branchKnownCost: totalsKnown,
      branchUnknownCost: totalsUnknown,
      noBranchDataCost: totalsNoBranch,
      noBranchDataSessions: totalsNoBranchSessions,
      noBranchDataProviders: [...totalsNoBranchProviders.entries()].sort(([, a], [, b]) => b - a).map(([provider]) => provider),
      distinctSessions: totalsDistinct.size,
    },
  }
}

/// CLI/IPC entry: parse the filtered population (range, provider, project
/// patterns — the same flags and semantics as `spend --format flow-json`) and
/// build the by-branch report over it.
export async function computeBranchSpend(range: DateRange, provider: string, projectFilter?: string[], excludeFilter?: string[]): Promise<BranchSpendReport> {
  const parsed = await parseAllSessions(range, provider)
  await reportUnmatchedProjectPatterns(parsed, projectFilter, excludeFilter, () => cachedProjectIdentitiesForRange(range))
  const projects = filterProjectsByName(parsed, projectFilter, excludeFilter)
  return buildBranchSpendReport(projects, range)
}
