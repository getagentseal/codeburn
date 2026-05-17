import { execFileSync } from 'child_process'
import { isAbsolute, parse, resolve, sep } from 'path'

import chalk from 'chalk'

import { formatCost } from './currency.js'
import { toDateString } from './daily-cache.js'
import type { DateRange, ProjectSummary, SessionSummary } from './types.js'

const GOLD = '#ffd700'
const GREEN = '#5bf5a0'
const ORANGE = '#ff8c42'
const DIM = '#888888'
const PANEL_WIDTH = 76
const DEFAULT_TOP_LIMIT = 10
const MS_PER_MINUTE = 60 * 1000
const END_OF_DAY_HOURS = 23
const END_OF_DAY_MINUTES = 59
const END_OF_DAY_SECONDS = 59
const END_OF_DAY_MS = 999

export type GitCommit = {
  sha: string
  committerDate: string
  authorName: string
  subject: string
}

export type GitCostCommit = {
  sha: string
  shortSha: string
  committerDate: string
  authorName: string
  subject: string
  costUSD: number
  sessions: number
  calls: number
}

export type GitCostSession = {
  project: string
  sessionId: string
  firstTimestamp: string
  lastTimestamp: string
  costUSD: number
  calls: number
}

export type GitCostSummary = {
  label: string
  repoRoot: string
  repoName: string
  windowMinutes: number
  totalCostUSD: number
  attributedCostUSD: number
  unattributedCostUSD: number
  attributedPercent: number | null
  commits: number
  sessions: number
  attributedSessions: number
  unattributedSessions: number
  calls: number
}

export type GitCostResult = {
  summary: GitCostSummary
  commits: GitCostCommit[]
  unattributedSessions: GitCostSession[]
}

type MutableCommitCost = {
  commit: GitCommit
  costUSD: number
  sessions: Set<string>
  calls: number
}

function formatGitError(err: unknown): string {
  const stderr = (err as { stderr?: string | Buffer }).stderr
  const stderrMessage = stderr ? String(stderr).trim() : ''
  if (stderrMessage) return stderrMessage
  if (err instanceof Error) return err.message
  return String(err)
}

function runGit(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (err) {
    if (process.env['CODEBURN_VERBOSE'] === '1') {
      console.error(`codeburn: git ${args.join(' ')} failed: ${formatGitError(err)}`)
    }
    return null
  }
}

export function parseGitSince(value: string, now = new Date()): { range: DateRange; label: string } {
  const end = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    END_OF_DAY_HOURS,
    END_OF_DAY_MINUTES,
    END_OF_DAY_SECONDS,
    END_OF_DAY_MS,
  )

  const normalized = value.trim().toLowerCase()
  if (normalized === 'today') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    return { range: { start, end }, label: `Today (${toDateString(start)})` }
  }
  if (normalized === 'week' || normalized === '7days' || normalized === '7d') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7)
    return { range: { start, end }, label: 'Last 7 Days' }
  }
  if (normalized === '30days' || normalized === '30d') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30)
    return { range: { start, end }, label: 'Last 30 Days' }
  }
  if (normalized === 'month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1)
    return { range: { start, end }, label: `${now.toLocaleString('default', { month: 'long' })} ${now.getFullYear()}` }
  }

  const daysMatch = normalized.match(/^(\d+)\s*(?:d|day|days)$/)
  if (daysMatch) {
    const days = Number(daysMatch[1])
    if (!Number.isInteger(days) || days <= 0) {
      throw new Error(`Invalid --since value "${value}": day count must be positive`)
    }
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days)
    return { range: { start, end }, label: `Last ${days} ${days === 1 ? 'Day' : 'Days'}` }
  }

  throw new Error(`Invalid --since value "${value}": use today, week/7days/7d, 30days/30d, month, or Nd/Nday/Ndays`)
}

export function getGitRepoRoot(cwd: string): string | null {
  return runGit(['rev-parse', '--show-toplevel'], cwd)
}

export function getGitCommits(cwd: string, range: DateRange): GitCommit[] {
  const log = runGit([
    'log',
    `--since=${range.start.toISOString()}`,
    `--until=${range.end.toISOString()}`,
    '--format=%H%x1f%cI%x1f%an%x1f%s',
  ], cwd)

  if (!log) return []

  return log.split('\n')
    .filter(Boolean)
    .map(line => {
      const [sha = '', committerDate = '', authorName = '', subject = ''] = line.split('\x1f')
      return { sha, committerDate, authorName, subject }
    })
    .filter(commit => commit.sha && !Number.isNaN(new Date(commit.committerDate).getTime()))
}

function normalizePath(path: string): string {
  return resolve(path)
}

function isInsidePath(child: string, parent: string): boolean {
  const normalizedChild = normalizePath(child)
  const normalizedParent = normalizePath(parent)
  if (normalizedParent === parse(normalizedParent).root) {
    return normalizedChild.startsWith(normalizedParent)
  }
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${sep}`)
}

function projectBelongsToRepo(projectPath: string, repoRoot: string): boolean {
  const candidates = isAbsolute(projectPath) ? [projectPath] : [`/${projectPath}`]
  return candidates.some(candidate => isInsidePath(candidate, repoRoot))
}

function parseTime(timestamp: string): Date | null {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? null : date
}

function sessionKey(projectPath: string, session: SessionSummary): string {
  return `${projectPath}:${session.sessionId}`
}

function sessionCalls(session: SessionSummary): number {
  return session.apiCalls ?? session.turns.reduce((sum, turn) => sum + turn.assistantCalls.length, 0)
}

export function computeGitCost(
  projects: ProjectSummary[],
  commits: GitCommit[],
  options: {
    label: string
    repoRoot: string
    windowMinutes: number
  },
): GitCostResult {
  const repoRoot = normalizePath(options.repoRoot)
  const repoName = repoRoot.split(sep).filter(Boolean).at(-1) ?? repoRoot
  const sortedCommits = [...commits]
    .sort((a, b) => new Date(a.committerDate).getTime() - new Date(b.committerDate).getTime())
  const commitMap = new Map<string, MutableCommitCost>()
  const unattributedSessions: GitCostSession[] = []
  let totalCostUSD = 0
  let attributedCostUSD = 0
  let sessions = 0
  let attributedSessions = 0
  let calls = 0

  for (const project of projects) {
    if (!projectBelongsToRepo(project.projectPath, repoRoot)) continue

    for (const session of project.sessions) {
      const start = parseTime(session.firstTimestamp)
      const endBase = parseTime(session.lastTimestamp) ?? start
      const callCount = sessionCalls(session)
      if (!start || !endBase) continue

      sessions += 1
      calls += callCount
      totalCostUSD += session.totalCostUSD

      const end = new Date(endBase.getTime() + options.windowMinutes * MS_PER_MINUTE)
      const matchingCommits = sortedCommits.filter(commit => {
        const ts = new Date(commit.committerDate)
        return ts >= start && ts <= end
      })

      if (matchingCommits.length === 0) {
        unattributedSessions.push({
          project: project.project,
          sessionId: session.sessionId,
          firstTimestamp: session.firstTimestamp,
          lastTimestamp: session.lastTimestamp,
          costUSD: session.totalCostUSD,
          calls: callCount,
        })
        continue
      }

      attributedSessions += 1
      attributedCostUSD += session.totalCostUSD
      const costShare = session.totalCostUSD / matchingCommits.length
      const callShare = callCount / matchingCommits.length

      for (const commit of matchingCommits) {
        const existing = commitMap.get(commit.sha) ?? {
          commit,
          costUSD: 0,
          sessions: new Set<string>(),
          calls: 0,
        }
        existing.costUSD += costShare
        existing.sessions.add(sessionKey(project.projectPath, session))
        existing.calls += callShare
        commitMap.set(commit.sha, existing)
      }
    }
  }

  const commitRows = [...commitMap.values()]
    .map(row => ({
      sha: row.commit.sha,
      shortSha: row.commit.sha.slice(0, 7),
      committerDate: row.commit.committerDate,
      authorName: row.commit.authorName,
      subject: row.commit.subject,
      costUSD: row.costUSD,
      sessions: row.sessions.size,
      calls: row.calls,
    }))
    .sort((a, b) => b.costUSD - a.costUSD)

  unattributedSessions.sort((a, b) => b.costUSD - a.costUSD)

  return {
    summary: {
      label: options.label,
      repoRoot,
      repoName,
      windowMinutes: options.windowMinutes,
      totalCostUSD,
      attributedCostUSD,
      unattributedCostUSD: totalCostUSD - attributedCostUSD,
      attributedPercent: totalCostUSD > 0 ? (attributedCostUSD / totalCostUSD) * 100 : null,
      commits: commitRows.length,
      sessions,
      attributedSessions,
      unattributedSessions: unattributedSessions.length,
      calls,
    },
    commits: commitRows,
    unattributedSessions,
  }
}

function formatCount(count: number): string {
  return Number.isInteger(count) ? String(count) : count.toFixed(1)
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : pluralForm}`
}

function formatPercent(value: number | null): string {
  return value === null ? '-' : `${value.toFixed(1)}%`
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`
}

export function renderGitCostText(result: GitCostResult): string {
  const { summary } = result
  const lines: string[] = []
  lines.push('')
  lines.push(`  ${formatTitle('CodeBurn git cost')}${formatDim('  ' + summary.label)}`)
  lines.push(formatDim('  ' + '-'.repeat(PANEL_WIDTH)))
  lines.push(`  Repo: ${summary.repoName} ${formatDim(summary.repoRoot)}`)
  lines.push(`  Attribution window: ${summary.windowMinutes} minutes after session end`)
  lines.push('')

  if (summary.sessions === 0) {
    lines.push(formatDim('  No usage sessions matched this git repository for the selected period.'))
    lines.push('')
    return lines.join('\n')
  }

  lines.push(`  Total repo spend:     ${formatGold(formatCost(summary.totalCostUSD))}`)
  lines.push(`  Attributed spend:     ${formatGreen(formatCost(summary.attributedCostUSD))} ${formatDim(`(${formatPercent(summary.attributedPercent)})`)}`)
  lines.push(`  Unattributed spend:   ${formatCost(summary.unattributedCostUSD)}`)
  lines.push('  ' + [
    plural(summary.commits, 'attributed commit'),
    plural(summary.sessions, 'total session'),
    plural(summary.calls, 'total call'),
  ].join(formatDim('   ')))
  lines.push('')

  if (result.commits.length > 0) {
    lines.push(`  ${formatBold('Top commit costs')}`)
    for (const commit of result.commits.slice(0, DEFAULT_TOP_LIMIT)) {
      const subject = truncate(commit.subject || '(no subject)', 52)
      lines.push(`  ${formatGold(formatCost(commit.costUSD))}  ${commit.shortSha}  ${subject} ${formatDim(`(${plural(commit.sessions, 'session')}, ${plural(commit.calls, 'call')})`)}`)
    }
    lines.push('')
  }

  if (result.unattributedSessions.length > 0) {
    lines.push(`  ${formatBold('Largest unattributed sessions')}`)
    for (const session of result.unattributedSessions.slice(0, 5)) {
      const target = truncate(`${session.project}/${session.sessionId}`, 58)
      lines.push(`  ${formatCost(session.costUSD)}  ${target} ${formatDim(`(${plural(session.calls, 'call')})`)}`)
    }
    const hidden = result.unattributedSessions.length - 5
    if (hidden > 0) {
      lines.push(formatDim(`  ...and ${plural(hidden, 'more unattributed session')}.`))
    }
    lines.push('')
  }

  lines.push(formatDim('  Attribution is time-based and splits a session evenly across matching commits.'))
  lines.push('')
  return lines.join('\n')
}

function formatTitle(value: string): string {
  return chalk.bold.hex(ORANGE)(value)
}

function formatBold(value: string): string {
  return chalk.bold(value)
}

function formatDim(value: string): string {
  return chalk.hex(DIM)(value)
}

function formatGold(value: string): string {
  return chalk.hex(GOLD)(value)
}

function formatGreen(value: string): string {
  return chalk.hex(GREEN)(value)
}
