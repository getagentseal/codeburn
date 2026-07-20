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
  /// True when any contributing session used the legacy even-split fallback
  /// (session-level prLinks but no surviving per-turn refs), so this row's share
  /// is an approximation rather than genuine turn-level attribution.
  approx: boolean
}

const GITHUB_PR_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/

export function shortenPrUrl(url: string): string {
  const m = GITHUB_PR_RE.exec(url)
  return m ? `${m[1]}/${m[2]}#${m[3]}` : url
}

/// One PR's slice of a session's spend.
export type PrContribution = { cost: number; calls: number; savingsUSD: number; approx: boolean }

/// A single session's PR-attributed spend: `perUrl` is the turn-level split
/// across the PRs it referenced; `unattributed` is the spend that belongs to no
/// specific PR (turns before the session's first PR reference).
export type SessionPrAttribution = {
  perUrl: Map<string, PrContribution>
  unattributed: { cost: number; calls: number; savingsUSD: number }
}

// Minimal structural shape a SessionSummary satisfies, so the state machine is
// unit-testable without constructing a full session fixture.
type AttributableSession = {
  turns: Array<{ prRefs?: string[]; assistantCalls: Array<{ costUSD: number; savingsUSD?: number }> }>
  prLinks?: string[]
  totalCostUSD: number
  apiCalls: number
  totalSavingsUSD: number
}

function addContribution(
  map: Map<string, PrContribution>,
  url: string, cost: number, calls: number, savingsUSD: number, approx: boolean,
): void {
  const e = map.get(url) ?? { cost: 0, calls: 0, savingsUSD: 0, approx: false }
  e.cost += cost
  e.calls += calls
  e.savingsUSD += savingsUSD
  if (approx) e.approx = true
  map.set(url, e)
}

/// Attribute a session's spend to the PRs it referenced, at TURN granularity.
///
/// Walk the turns in order carrying `current` = the PR set of the most recent
/// turn that referenced any PR. Each turn's cost/calls/savings are attributed to
/// `current`, split evenly across a multi-PR set (a merge-sweep turn touching
/// several PRs at once). Turns before the first reference land in `unattributed`
/// (genuine session overhead: exploration, unrelated work).
///
/// Legacy fallback: a session whose transcript already expired keeps its
/// session-level `prLinks` but has NO per-turn `prRefs`. With no turn boundaries
/// to attribute by, split the whole session evenly across its prLinks and mark
/// every portion `approx` so surfaces can flag it honestly.
export function attributeSessionPrSpend(session: AttributableSession): SessionPrAttribution {
  const perUrl = new Map<string, PrContribution>()
  const unattributed = { cost: 0, calls: 0, savingsUSD: 0 }

  const hasTurnRefs = session.turns.some(t => t.prRefs?.length)
  if (!hasTurnRefs) {
    const links = session.prLinks
    if (links?.length) {
      const share = 1 / links.length
      for (const url of links) {
        addContribution(perUrl, url, session.totalCostUSD * share, session.apiCalls * share, session.totalSavingsUSD * share, true)
      }
    }
    return { perUrl, unattributed }
  }

  let current: string[] | null = null
  for (const turn of session.turns) {
    if (turn.prRefs?.length) current = turn.prRefs
    const cost = turn.assistantCalls.reduce((s, c) => s + c.costUSD, 0)
    const calls = turn.assistantCalls.length
    const savings = turn.assistantCalls.reduce((s, c) => s + (c.savingsUSD ?? 0), 0)
    if (cost === 0 && calls === 0 && savings === 0) continue
    if (current === null) {
      unattributed.cost += cost
      unattributed.calls += calls
      unattributed.savingsUSD += savings
      continue
    }
    const share = 1 / current.length
    for (const url of current) addContribution(perUrl, url, cost * share, calls * share, savings * share, false)
  }
  return { perUrl, unattributed }
}

/// Spend attributed to each pull request at turn granularity (see
/// attributeSessionPrSpend). Rows carry ATTRIBUTED cost/calls and ARE summable;
/// `sessions` counts the distinct sessions that contributed any spend to the PR;
/// `approx` marks rows fed by the legacy even-split fallback. Sorted by cost, desc.
export function aggregateByPr(projects: ProjectSummary[]): PrRow[] {
  const byUrl = new Map<string, {
    cost: number; savingsUSD: number; calls: number; approx: boolean
    sessions: Set<string>; firstStarted: string; lastEnded: string
  }>()
  for (const project of projects) {
    for (const session of project.sessions) {
      if (!session.prLinks?.length) continue
      const { perUrl } = attributeSessionPrSpend(session)
      for (const [url, c] of perUrl) {
        if (c.cost === 0 && c.calls === 0 && c.savingsUSD === 0) continue
        const row = byUrl.get(url) ?? {
          cost: 0, savingsUSD: 0, calls: 0, approx: false,
          sessions: new Set<string>(), firstStarted: session.firstTimestamp, lastEnded: session.lastTimestamp,
        }
        row.cost += c.cost
        row.savingsUSD += c.savingsUSD
        row.calls += c.calls
        row.sessions.add(session.sessionId)
        if (c.approx) row.approx = true
        if (session.firstTimestamp < row.firstStarted) row.firstStarted = session.firstTimestamp
        if (session.lastTimestamp > row.lastEnded) row.lastEnded = session.lastTimestamp
        byUrl.set(url, row)
      }
    }
  }
  return [...byUrl.entries()]
    .map(([url, r]) => ({
      url, label: shortenPrUrl(url),
      cost: r.cost, savingsUSD: r.savingsUSD,
      sessions: r.sessions.size, calls: Math.round(r.calls),
      firstStarted: r.firstStarted, lastEnded: r.lastEnded,
      approx: r.approx,
    }))
    .sort((a, b) => b.cost - a.cost)
}

/// Totals across every PR-linked session. `attributedCost` is the sum of the
/// per-PR rows (a summable total, unlike the old by-reference rows);
/// `unattributedCost` is the pre-reference overhead not tied to any specific PR.
/// `cost` = attributed + unattributed = the distinct-session spend that produced
/// PRs. `sessions` counts distinct PR-linked sessions.
export function prLinkedTotals(projects: ProjectSummary[]): { cost: number; sessions: number; attributedCost: number; unattributedCost: number } {
  let attributedCost = 0
  let unattributedCost = 0
  let sessions = 0
  for (const project of projects) {
    for (const session of project.sessions) {
      if (!session.prLinks?.length) continue
      sessions += 1
      const { perUrl, unattributed } = attributeSessionPrSpend(session)
      for (const c of perUrl.values()) attributedCost += c.cost
      unattributedCost += unattributed.cost
    }
  }
  return { cost: attributedCost + unattributedCost, sessions, attributedCost, unattributedCost }
}

export type BranchRow = {
  /// The git branch active for the attributed turns, or `null` for spend that
  /// occurred before any branch was observed within a branch-bearing session.
  branch: string | null
  cost: number
  calls: number
  sessions: number
}

/// Per-branch spend, carrying each session's last-seen git branch forward across
/// its turns. The cache stores a turn's branch only when it CHANGES, so a report
/// must reconstruct each turn's branch from the last stored value — this walks a
/// session's turns in order and does exactly that.
///
/// Only sessions that EVER observed a branch participate: a provider that never
/// captures branch data (only Claude does today) would otherwise pile all of its
/// spend into one `null` bucket that dwarfs every real branch. Within a
/// participating session, turns before the first observed branch are attributed
/// to a single explicit `null` row the caller can label honestly.
///
/// A session that switches branches counts toward EACH branch it touched (like
/// the by-PR by-reference attribution), so rows must never be summed into a grand
/// total. Sorted by cost, descending.
export function aggregateByBranch(projects: ProjectSummary[]): BranchRow[] {
  const byBranch = new Map<string | null, { cost: number; calls: number; sessions: Set<string> }>()
  for (const project of projects) {
    for (const session of project.sessions) {
      // Participate when the session observed a branch anywhere in its full
      // transcript (`everHadBranch`, set pre-date-filter) — falling back to the
      // turns in hand for producers/fixtures that don't set the flag. A session
      // that never observed a branch (every non-Claude provider) is skipped so
      // it can't pile into the null bucket.
      if (!session.everHadBranch && !session.turns.some(turn => turn.gitBranch)) continue
      let current: string | null = null
      for (const turn of session.turns) {
        if (turn.gitBranch) current = turn.gitBranch
        if (turn.assistantCalls.length === 0) continue
        const turnCost = turn.assistantCalls.reduce((sum, call) => sum + call.costUSD, 0)
        const row = byBranch.get(current) ?? { cost: 0, calls: 0, sessions: new Set<string>() }
        row.cost += turnCost
        row.calls += turn.assistantCalls.length
        row.sessions.add(session.sessionId)
        byBranch.set(current, row)
      }
    }
  }
  return [...byBranch.entries()]
    .map(([branch, d]) => ({ branch, cost: d.cost, calls: d.calls, sessions: d.sessions.size }))
    .sort((a, b) => b.cost - a.cost)
}
