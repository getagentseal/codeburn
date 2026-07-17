import { execFileSync } from 'child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseAllSessions } from './parser.js'
import type { DateRange, SessionSummary } from './types.js'

export type YieldCategory = 'productive' | 'reverted' | 'abandoned' | 'ambiguous'

export type SessionYield = {
  sessionId: string
  project: string
  cost: number
  category: YieldCategory
  commitCount: number
}

export type YieldSummary = {
  productive: { cost: number; sessions: number }
  reverted: { cost: number; sessions: number }
  abandoned: { cost: number; sessions: number }
  ambiguous: { cost: number; sessions: number }
  total: { cost: number; sessions: number }
  details: SessionYield[]
}

export type YieldJsonReport = {
  period: {
    label: string
    start: string
    end: string
  }
  summary: {
    productive: YieldBucketJson
    reverted: YieldBucketJson
    abandoned: YieldBucketJson
    ambiguous: YieldBucketJson
    total: { costUSD: number; sessions: number }
    productiveToRevertedCostRatio: number | null
  }
  methodology: 'timestamp-window'
  details: SessionYieldJson[]
}

type YieldBucketJson = {
  costUSD: number
  sessions: number
  costPercent: number
  sessionPercent: number
}

type SessionYieldJson = Omit<SessionYield, 'cost'> & {
  costUSD: number
}

const SAFE_REF_PATTERN = /^[A-Za-z0-9._/\-]+$/

function runGit(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

type RepoResolution = {
  readonly root: string
  readonly commonDir: string
}

function canonicalizePath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function resolveRepo(dir: string): RepoResolution | null {
  // Accepted residual: moving the main repo after worktree add leaves stale Git metadata; Git fails and sessions fall back to cwd.
  const root = runGit(['rev-parse', '--show-toplevel'], dir)
  if (!root) return null

  const commonDir = runGit(['rev-parse', '--git-common-dir'], root)
  return {
    root,
    // Linked worktrees have different top-levels but `git log --all` reads
    // the same shared repository history, so they must share attribution.
    commonDir: canonicalizePath(commonDir ? resolve(root, commonDir) : root),
  }
}

function getMainBranch(cwd: string): string {
  const result = runGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], cwd)
  if (result) {
    const branch = result.replace('refs/remotes/origin/', '')
    if (SAFE_REF_PATTERN.test(branch)) return branch
  }

  const branches = runGit(['branch', '-a'], cwd) ?? ''
  if (branches.includes('main')) return 'main'
  if (branches.includes('master')) return 'master'
  return 'main'
}

type CommitInfo = {
  sha: string
  timestamp: Date
  inMain: boolean
  /** Set when a LATER commit's body says "This reverts commit <sha>" — i.e. the work in this commit was reverted out of main. */
  wasReverted: boolean
}

type SessionWindow = {
  readonly start: Date
  readonly end: Date
  readonly sessionId: string
}

type SessionAttribution = {
  readonly window: SessionWindow | null
  readonly commits: CommitInfo[]
  lostCandidacy: boolean
}

/**
 * Find SHAs that were the target of a `git revert` ANYWHERE in the repo's
 * history (not just the time window). The standard `git revert` body
 * format is "This reverts commit <SHA>." which we grep out.
 *
 * The previous implementation flagged a commit as `isRevert` based on the
 * substring "revert" appearing in its OWN subject. Two bugs there:
 * 1. Subjects like "Add revert button" matched.
 * 2. The session that PERFORMED the revert was tagged "reverted", not the
 *    session whose work was being reverted — so the original session always
 *    looked productive even after its work was thrown away.
 */
function getRevertedShas(cwd: string): Set<string> {
  const bodies = runGit(
    ['log', '--all', '--grep=^This reverts commit', '--format=%B%x1e'],
    cwd,
  ) ?? ''
  const set = new Set<string>()
  const re = /This reverts commit ([0-9a-f]{7,40})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(bodies)) !== null) {
    set.add(m[1].toLowerCase())
  }
  return set
}

function getCommitsInRange(cwd: string, since: Date, until: Date, mainBranch: string): CommitInfo[] {
  const sinceStr = since.toISOString()
  const untilStr = until.toISOString()

  const log = runGit(
    ['log', '--all', `--since=${sinceStr}`, `--until=${untilStr}`, '--format=%H|%aI|%s'],
    cwd
  )

  if (!log) return []

  const mainCommits = new Set(
    (runGit(['log', mainBranch, '--format=%H'], cwd) ?? '').split('\n').filter(Boolean)
  )
  const revertedShas = getRevertedShas(cwd)

  return log.split('\n').filter(Boolean).map(line => {
    const [sha] = line.split('|')
    const timestamp = line.split('|')[1] ?? ''
    return {
      sha,
      timestamp: new Date(timestamp),
      inMain: mainCommits.has(sha),
      // wasReverted: matches when ANY later commit's body says
      // "This reverts commit <sha>". Compare against the full SHA AND its
      // 7-char short prefix to be safe; git revert sometimes records the
      // short form.
      wasReverted: revertedShas.has(sha.toLowerCase()) ||
                   revertedShas.has(sha.toLowerCase().slice(0, 7)),
    }
  })
}

function sessionWindow(session: SessionSummary): SessionWindow | null {
  if (!session.firstTimestamp) return null

  const start = new Date(session.firstTimestamp)
  const lastTs = session.lastTimestamp ?? session.firstTimestamp
  const end = new Date(new Date(lastTs).getTime() + 60 * 60 * 1000)
  return { start, end, sessionId: session.sessionId }
}

function attributeCommits(
  sessions: SessionSummary[],
  commits: CommitInfo[],
): SessionAttribution[] {
  const attributions: SessionAttribution[] = sessions.map(session => ({
    window: sessionWindow(session),
    commits: [],
    lostCandidacy: false,
  }))

  for (const commit of commits) {
    const candidates = attributions.filter((attribution): attribution is SessionAttribution & { window: SessionWindow } =>
      attribution.window !== null &&
      commit.timestamp >= attribution.window.start &&
      commit.timestamp <= attribution.window.end,
    )

    const owner = candidates.reduce<SessionAttribution & { window: SessionWindow } | null>((current, candidate) => {
      if (current === null) return candidate

      const currentSpan = current.window.end.getTime() - current.window.start.getTime()
      const candidateSpan = candidate.window.end.getTime() - candidate.window.start.getTime()
      if (candidateSpan !== currentSpan) return candidateSpan < currentSpan ? candidate : current
      if (candidate.window.start.getTime() !== current.window.start.getTime()) {
        return candidate.window.start < current.window.start ? candidate : current
      }
      // sessionId, not array position: session order is cache-state dependent.
      return candidate.window.sessionId < current.window.sessionId ? candidate : current
    }, null)

    for (const candidate of candidates) {
      if (candidate !== owner) candidate.lostCandidacy = true
    }
    owner?.commits.push(commit)
  }

  return attributions
}

function categorizeSession(
  session: SessionSummary,
  commits: CommitInfo[],
  lostCandidacy: boolean,
): { category: YieldCategory; commitCount: number } {
  if (!session.firstTimestamp) {
    return { category: 'abandoned', commitCount: 0 }
  }

  if (commits.length === 0) {
    // Ambiguous only when this session's window actually contained a commit
    // that a tighter window won — mere overlap with a credited session is not
    // enough to withhold the abandoned classification.
    return {
      category: lostCandidacy ? 'ambiguous' : 'abandoned',
      commitCount: 0,
    }
  }

  const inMainCount = commits.filter(c => c.inMain).length
  // A session is "reverted" when at least half of its in-main commits were
  // later reverted out (revert detected via "This reverts commit <sha>"
  // anywhere later in history, not in the same time window).
  const revertedCount = commits.filter(c => c.inMain && c.wasReverted).length

  if (revertedCount > 0 && revertedCount >= inMainCount / 2) {
    return { category: 'reverted', commitCount: commits.length }
  }

  if (inMainCount > 0) {
    return { category: 'productive', commitCount: inMainCount }
  }

  return { category: 'abandoned', commitCount: commits.length }
}

export async function computeYield(range: DateRange, cwd: string, provider: string = 'all'): Promise<YieldSummary> {
  const projects = await parseAllSessions(range, provider)

  const summary: YieldSummary = {
    productive: { cost: 0, sessions: 0 },
    reverted: { cost: 0, sessions: 0 },
    abandoned: { cost: 0, sessions: 0 },
    ambiguous: { cost: 0, sessions: 0 },
    total: { cost: 0, sessions: 0 },
    details: [],
  }

  // Resolve each recorded path once. Multiple project entries can carry the
  // same path, and each uncached lookup would otherwise spawn git again.
  const repoResolutionCache = new Map<string, RepoResolution | null>()
  const resolveRepoCached = (dir: string): RepoResolution | null => {
    if (!repoResolutionCache.has(dir)) repoResolutionCache.set(dir, resolveRepo(dir))
    return repoResolutionCache.get(dir) ?? null
  }
  const cwdRepo = resolveRepoCached(cwd)

  // Canonical top-levels are the primary keys. A secondary common-dir index
  // aliases linked worktree roots to one group because --all sees the same
  // shared history from each worktree. Missing/non-git paths still use cwd.
  type RepoGroup = { commits: CommitInfo[]; sessions: SessionSummary[]; projectNames: string[] }
  const repoGroups = new Map<string, RepoGroup>()
  const commonDirGroups = new Map<string, RepoGroup>()
  const uniqueRepoGroups = new Set<RepoGroup>()
  for (const project of projects) {
    const repo = (project.projectPath && resolveRepoCached(project.projectPath)) || cwdRepo
    const projectCwd = repo?.root ?? cwd
    const groupKey = repo?.root ?? cwd

    let group = repoGroups.get(groupKey) ?? (repo ? commonDirGroups.get(repo.commonDir) : undefined)
    if (!group) {
      group = {
        commits: repo
          ? getCommitsInRange(projectCwd, range.start, range.end, getMainBranch(projectCwd))
          : [],
        sessions: [],
        projectNames: [],
      }
      uniqueRepoGroups.add(group)
    }
    repoGroups.set(groupKey, group)
    if (repo) commonDirGroups.set(repo.commonDir, group)
    for (const session of project.sessions) {
      group.sessions.push(session)
      group.projectNames.push(project.project)
    }
  }

  for (const group of uniqueRepoGroups) {
    const attributions = attributeCommits(group.sessions, group.commits)
    for (const [index, session] of group.sessions.entries()) {
      const attribution = attributions[index]
      const { category, commitCount } = categorizeSession(
        session,
        attribution?.commits ?? [],
        attribution?.lostCandidacy ?? false,
      )

      summary[category].cost += session.totalCostUSD
      summary[category].sessions += 1
      summary.total.cost += session.totalCostUSD
      summary.total.sessions += 1

      summary.details.push({
        sessionId: session.sessionId,
        project: group.projectNames[index] ?? session.project,
        cost: session.totalCostUSD,
        category,
        commitCount,
      })
    }
  }

  return summary
}

export function formatYieldSummary(summary: YieldSummary): string {
  const { productive, reverted, abandoned, ambiguous, total } = summary

  const pct = (n: number) => total.cost > 0 ? Math.round((n / total.cost) * 100) : 0
  const fmt = (n: number) => `$${n.toFixed(2)}`

  const lines = [
    '',
    `Productive:  ${fmt(productive.cost).padStart(8)} (${pct(productive.cost)}%) - ${productive.sessions} sessions shipped to main`,
    `Reverted:    ${fmt(reverted.cost).padStart(8)} (${pct(reverted.cost)}%) - ${reverted.sessions} sessions were reverted`,
    `Abandoned:   ${fmt(abandoned.cost).padStart(8)} (${pct(abandoned.cost)}%) - ${abandoned.sessions} sessions never committed`,
    `Ambiguous:   ${fmt(ambiguous.cost).padStart(8)} (${pct(ambiguous.cost)}%) - ${ambiguous.sessions} sessions lost commits to concurrent sessions`,
    '',
    'Attribution: timestamp-window based (heuristic)',
    '',
    `Total:       ${fmt(total.cost).padStart(8)}     - ${total.sessions} sessions`,
    '',
  ]

  return lines.join('\n')
}

export function buildYieldJsonReport(
  summary: YieldSummary,
  periodLabel: string,
  range: DateRange,
): YieldJsonReport {
  const bucket = (value: { cost: number; sessions: number }): YieldBucketJson => ({
    costUSD: value.cost,
    sessions: value.sessions,
    costPercent: summary.total.cost > 0
      ? Math.round((value.cost / summary.total.cost) * 1000) / 10
      : 0,
    sessionPercent: summary.total.sessions > 0
      ? Math.round((value.sessions / summary.total.sessions) * 1000) / 10
      : 0,
  })

  return {
    period: {
      label: periodLabel,
      start: range.start.toISOString(),
      end: range.end.toISOString(),
    },
    summary: {
      productive: bucket(summary.productive),
      reverted: bucket(summary.reverted),
      abandoned: bucket(summary.abandoned),
      ambiguous: bucket(summary.ambiguous),
      total: {
        costUSD: summary.total.cost,
        sessions: summary.total.sessions,
      },
      productiveToRevertedCostRatio: summary.reverted.cost > 0
        ? Math.round((summary.productive.cost / summary.reverted.cost) * 100) / 100
        : null,
    },
    methodology: 'timestamp-window',
    details: summary.details.map(detail => ({
      sessionId: detail.sessionId,
      project: detail.project,
      costUSD: detail.cost,
      category: detail.category,
      commitCount: detail.commitCount,
    })),
  }
}
