import { execSync } from 'child_process'
import { parseAllSessions } from './parser.js'
import type { DateRange, SessionSummary } from './types.js'

export type YieldCategory = 'productive' | 'reverted' | 'abandoned'

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
  total: { cost: number; sessions: number }
  details: SessionYield[]
}

function runGit(cmd: string, cwd: string): string | null {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

function isGitRepo(dir: string): boolean {
  return runGit('git rev-parse --is-inside-work-tree', dir) === 'true'
}

function getMainBranch(cwd: string): string {
  // Try to get default branch from remote
  const result = runGit('git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null', cwd)
  if (result) {
    return result.replace('refs/remotes/origin/', '')
  }

  // Fallback: check common names
  const branches = runGit('git branch -a', cwd) ?? ''
  if (branches.includes('main')) return 'main'
  if (branches.includes('master')) return 'master'
  return 'main'
}

type CommitInfo = {
  sha: string
  timestamp: Date
  isRevert: boolean
  inMain: boolean
}

function getCommitsInRange(cwd: string, since: Date, until: Date, mainBranch: string): CommitInfo[] {
  const sinceStr = since.toISOString()
  const untilStr = until.toISOString()

  const log = runGit(
    `git log --all --since="${sinceStr}" --until="${untilStr}" --format="%H|%aI|%s"`,
    cwd
  )

  if (!log) return []

  const mainCommits = new Set(
    (runGit(`git log ${mainBranch} --format="%H"`, cwd) ?? '').split('\n').filter(Boolean)
  )

  return log.split('\n').filter(Boolean).map(line => {
    const [sha, timestamp, subject] = line.split('|')
    return {
      sha,
      timestamp: new Date(timestamp),
      isRevert: subject.toLowerCase().includes('revert'),
      inMain: mainCommits.has(sha),
    }
  })
}

function categorizeSession(
  session: SessionSummary,
  commits: CommitInfo[]
): { category: YieldCategory; commitCount: number } {
  if (!session.firstTimestamp) {
    return { category: 'abandoned', commitCount: 0 }
  }

  const sessionStart = new Date(session.firstTimestamp)
  const lastTs = session.lastTimestamp ?? session.firstTimestamp
  const sessionEnd = new Date(new Date(lastTs).getTime() + 60 * 60 * 1000) // +1 hour

  const relevantCommits = commits.filter(c =>
    c.timestamp >= sessionStart && c.timestamp <= sessionEnd
  )

  if (relevantCommits.length === 0) {
    return { category: 'abandoned', commitCount: 0 }
  }

  const inMainCount = relevantCommits.filter(c => c.inMain).length
  const revertedCount = relevantCommits.filter(c => c.isRevert && c.inMain).length

  if (revertedCount > 0 && revertedCount >= inMainCount / 2) {
    return { category: 'reverted', commitCount: relevantCommits.length }
  }

  if (inMainCount > 0) {
    return { category: 'productive', commitCount: inMainCount }
  }

  return { category: 'abandoned', commitCount: relevantCommits.length }
}

export async function computeYield(range: DateRange, cwd: string): Promise<YieldSummary> {
  const projects = await parseAllSessions(range, 'all')

  const summary: YieldSummary = {
    productive: { cost: 0, sessions: 0 },
    reverted: { cost: 0, sessions: 0 },
    abandoned: { cost: 0, sessions: 0 },
    total: { cost: 0, sessions: 0 },
    details: [],
  }

  // Get all commits in the date range for correlation
  const commits = isGitRepo(cwd)
    ? getCommitsInRange(cwd, range.start, range.end, getMainBranch(cwd))
    : []

  for (const project of projects) {
    // Try project-specific git repo first, fall back to cwd
    const projectCwd = project.projectPath && isGitRepo(project.projectPath)
      ? project.projectPath
      : cwd

    const projectCommits = projectCwd !== cwd && isGitRepo(projectCwd)
      ? getCommitsInRange(projectCwd, range.start, range.end, getMainBranch(projectCwd))
      : commits

    for (const session of project.sessions) {
      const { category, commitCount } = categorizeSession(session, projectCommits)

      summary[category].cost += session.totalCostUSD
      summary[category].sessions += 1
      summary.total.cost += session.totalCostUSD
      summary.total.sessions += 1

      summary.details.push({
        sessionId: session.sessionId,
        project: project.project,
        cost: session.totalCostUSD,
        category,
        commitCount,
      })
    }
  }

  return summary
}

export function formatYieldSummary(summary: YieldSummary): string {
  const { productive, reverted, abandoned, total } = summary

  const pct = (n: number) => total.cost > 0 ? Math.round((n / total.cost) * 100) : 0
  const fmt = (n: number) => `$${n.toFixed(2)}`

  const lines = [
    '',
    `Productive:  ${fmt(productive.cost).padStart(8)} (${pct(productive.cost)}%) - ${productive.sessions} sessions shipped to main`,
    `Reverted:    ${fmt(reverted.cost).padStart(8)} (${pct(reverted.cost)}%) - ${reverted.sessions} sessions were reverted`,
    `Abandoned:   ${fmt(abandoned.cost).padStart(8)} (${pct(abandoned.cost)}%) - ${abandoned.sessions} sessions never committed`,
    '',
    `Total:       ${fmt(total.cost).padStart(8)}     - ${total.sessions} sessions`,
    '',
  ]

  return lines.join('\n')
}
