import type { ProjectSummary, SessionSummary } from './types.js'

export type SessionRow = {
  sessionId: string
  /// Captured human title, empty when the transcript never produced one.
  title: string
  project: string
  provider: string
  models: string[]
  cost: number
  savingsUSD: number
  calls: number
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  startedAt: string
  endedAt: string
  durationMs: number
}

function inferProvider(session: SessionSummary): string {
  for (const turn of session.turns) {
    const provider = turn.assistantCalls[0]?.provider
    if (provider) return provider
  }

  const models = Object.keys(session.modelBreakdown)
  const model = models[0]?.toLowerCase() ?? ''
  if (model.startsWith('claude')) return 'claude'
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) return 'codex'
  if (model.startsWith('gemini')) return 'gemini'
  if (model.includes('/')) return model.split('/', 1)[0] || 'unknown'
  return 'unknown'
}

function durationMs(startedAt: string, endedAt: string): number {
  const duration = new Date(endedAt).getTime() - new Date(startedAt).getTime()
  return Number.isFinite(duration) ? duration : 0
}

export function aggregateSessions(projects: ProjectSummary[]): SessionRow[] {
  return projects.flatMap(project => project.sessions.map(session => ({
    sessionId: session.sessionId,
    title: session.title ?? '',
    project: session.project || project.project,
    provider: inferProvider(session),
    models: Object.keys(session.modelBreakdown),
    cost: session.totalCostUSD,
    savingsUSD: session.totalSavingsUSD,
    calls: session.apiCalls,
    turns: session.turns.length,
    inputTokens: session.totalInputTokens,
    outputTokens: session.totalOutputTokens,
    cacheReadTokens: session.totalCacheReadTokens,
    cacheWriteTokens: session.totalCacheWriteTokens,
    startedAt: session.firstTimestamp,
    endedAt: session.lastTimestamp,
    durationMs: durationMs(session.firstTimestamp, session.lastTimestamp),
  })))
}

export function renderJson(rows: SessionRow[]): string {
  return JSON.stringify(rows, null, 2)
}

export function renderTable(rows: SessionRow[]): string {
  const headers = ['SESSION', 'TITLE', 'PROJECT', 'PROVIDER', 'MODELS', 'COST', 'SAVED', 'CALLS', 'TURNS', 'STARTED']
  const values = rows.map(row => [
    row.sessionId,
    row.title.length > 38 ? row.title.slice(0, 37) + '\u2026' : row.title,
    row.project,
    row.provider,
    row.models.join(', '),
    `$${row.cost.toFixed(2)}`,
    `$${row.savingsUSD.toFixed(2)}`,
    String(row.calls),
    String(row.turns),
    row.startedAt,
  ])
  const widths = headers.map((header, i) => Math.max(header.length, ...values.map(row => row[i]!.length)))
  const format = (row: string[]) => row.map((value, i) => value.padEnd(widths[i]!)).join('  ').trimEnd()
  return [format(headers), format(widths.map(width => '-'.repeat(width))), ...values.map(format)].join('\n')
}

export type PrRow = {
  /// Full PR URL (the aggregation key).
  url: string
  /// Short display form, `owner/repo#123` for GitHub URLs, else the URL.
  label: string
  cost: number
  savingsUSD: number
  sessions: number
  calls: number
  firstStarted: string
  lastEnded: string
}

const GITHUB_PR_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/

export function shortenPrUrl(url: string): string {
  const m = GITHUB_PR_RE.exec(url)
  return m ? `${m[1]}/${m[2]}#${m[3]}` : url
}

/// Spend attributed to each pull request a session's transcript referenced.
/// A session that mentions two PRs counts fully toward BOTH rows: attribution
/// is by reference, not a split, so rows must never be summed into a grand
/// total (the caller reports distinct-session spend separately).
export function aggregateByPr(projects: ProjectSummary[]): PrRow[] {
  const byUrl = new Map<string, PrRow>()
  for (const project of projects) {
    for (const session of project.sessions) {
      if (!session.prLinks?.length) continue
      for (const url of session.prLinks) {
        const row = byUrl.get(url) ?? {
          url, label: shortenPrUrl(url),
          cost: 0, savingsUSD: 0, sessions: 0, calls: 0,
          firstStarted: session.firstTimestamp, lastEnded: session.lastTimestamp,
        }
        row.cost += session.totalCostUSD
        row.savingsUSD += session.totalSavingsUSD
        row.sessions += 1
        row.calls += session.apiCalls
        if (session.firstTimestamp < row.firstStarted) row.firstStarted = session.firstTimestamp
        if (session.lastTimestamp > row.lastEnded) row.lastEnded = session.lastTimestamp
        byUrl.set(url, row)
      }
    }
  }
  return [...byUrl.values()].sort((a, b) => b.cost - a.cost)
}

/// Distinct-session totals across every PR-linked session, safe to present as
/// "spend that produced PRs" without the multi-link double count.
export function prLinkedTotals(projects: ProjectSummary[]): { cost: number; sessions: number } {
  let cost = 0
  let sessions = 0
  for (const project of projects) {
    for (const session of project.sessions) {
      if (!session.prLinks?.length) continue
      cost += session.totalCostUSD
      sessions += 1
    }
  }
  return { cost, sessions }
}
