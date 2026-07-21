import { getShortModelName } from './models.js'
import { CATEGORY_LABELS } from './types.js'
import type { ProjectSummary, SessionSummary, TaskCategory } from './types.js'

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
  /// Short model names that processed this PR's attributed calls, ordered by
  /// attributed cost descending, deduplicated.
  models: string[]
  /// Attributed cost per task category (from the turns' classification), ordered
  /// by cost descending. Omitted for legacy approx rows: with no turn-level
  /// attribution there is no honest per-category split.
  categories?: Array<{ name: string; cost: number }>
}

const GITHUB_PR_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/

export function shortenPrUrl(url: string): string {
  const m = GITHUB_PR_RE.exec(url)
  return m ? `${m[1]}/${m[2]}#${m[3]}` : url
}

/// One PR's slice of a session's spend. `models`/`categories` map a key (raw
/// model name / task category) to the attributed cost carried under it.
export type PrContribution = {
  cost: number; calls: number; savingsUSD: number; approx: boolean
  models: Map<string, number>
  categories: Map<string, number>
}

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
  turns: Array<{ prRefs?: string[]; category?: string; assistantCalls: Array<{ costUSD: number; savingsUSD?: number; model?: string }> }>
  prLinks?: string[]
  totalCostUSD: number
  apiCalls: number
  totalSavingsUSD: number
  /// The PR set carried into the in-range turn slice: the refs of the last turn
  /// BEFORE the report's range start that referenced any PR. Seeds `current` so a
  /// PR referenced before the range still owns its later, in-range, ref-less turns
  /// (mirrors the branch carry-forward). Set by the parser; absent in unit tests.
  prRefsAtRangeStart?: string[]
}

function addToMap(m: Map<string, number>, key: string, value: number): void {
  m.set(key, (m.get(key) ?? 0) + value)
}

function ensureContribution(map: Map<string, PrContribution>, url: string): PrContribution {
  let e = map.get(url)
  if (!e) {
    e = { cost: 0, calls: 0, savingsUSD: 0, approx: false, models: new Map(), categories: new Map() }
    map.set(url, e)
  }
  return e
}

// Split an integer `total` across `n` buckets as evenly as possible, giving the
// first `total % n` buckets the extra unit (largest-remainder, deterministic by
// bucket order). Keeps per-PR call counts integral so aggregated rows never
// over- or under-count from independent per-row rounding (a 1-call, 2-PR turn
// allocates [1, 0], not [0.5, 0.5] that would each round up to 1).
export function allocateEven(total: number, n: number): number[] {
  const base = Math.floor(total / n)
  const extra = total - base * n
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0))
}

/// A subagent (sidechain) session's spend, pre-aggregated for folding into the
/// parent turn that launched it. `models` is keyed by RAW model name (the row
/// builder collapses it to short names, exactly like a turn's own calls);
/// `categories` by TaskCategory. Both maps sum to `cost` (all three derive from
/// the same child turns), so folding a child in never introduces a rounding gap.
export type ChildFold = {
  agentId: string
  cost: number
  calls: number
  savingsUSD: number
  /// The child's first-activity timestamp, used by the timestamp-bucket fallback.
  spawnAt: string
  models: Map<string, number>
  categories: Map<string, number>
}

function childFoldFromSession(child: SessionSummary): ChildFold {
  const models = new Map<string, number>()
  const categories = new Map<string, number>()
  for (const turn of child.turns) {
    let turnCost = 0
    for (const call of turn.assistantCalls) {
      turnCost += call.costUSD
      if (call.model) addToMap(models, call.model, call.costUSD)
    }
    if (turn.category) addToMap(categories, turn.category, turnCost)
  }
  return {
    agentId: child.agentId ?? child.sessionId,
    cost: child.totalCostUSD,
    calls: child.apiCalls,
    savingsUSD: child.totalSavingsUSD,
    spawnAt: child.firstTimestamp,
    models,
    categories,
  }
}

// A sessionId can repeat across projects, so the parent index is keyed on
// project + parentSessionId (a child and its parent share a project).
function subagentKey(project: string, parentSessionId: string): string {
  return `${project} ${parentSessionId}`
}

/// Index every sidechain (subagent) session by the parent that spawned it. Keyed
/// on project + `parentSessionId`. Children whose parent id was never captured
/// (or is absent from the scan) are simply never looked up, so they stay
/// standalone sessions contributing nothing to by-PR — the orphan behavior.
export function buildSubagentIndex(projects: ProjectSummary[]): Map<string, ChildFold[]> {
  const index = new Map<string, ChildFold[]>()
  for (const project of projects) {
    for (const session of project.sessions) {
      if (!session.parentSessionId) continue
      const key = subagentKey(session.project, session.parentSessionId)
      const list = index.get(key)
      if (list) list.push(childFoldFromSession(session))
      else index.set(key, [childFoldFromSession(session)])
    }
  }
  return index
}

/// Children of one parent, resolved to the turn that launched each. `byTurnIndex`
/// keys align with the parent's `turns` array indices; `unlinked` children
/// resolved to no turn and fold into the parent's unattributed spend.
export type TurnFolds = { byTurnIndex: Map<number, ChildFold[]>; unlinked: ChildFold[] }

function turnStartTs(turn: { timestamp?: string; assistantCalls: Array<{ timestamp?: string }> }): string {
  return turn.assistantCalls[0]?.timestamp || turn.timestamp || ''
}

/// Resolve each of a parent's children to the turn that launched it:
///   (a) the child's spawn `tool_use` id (`parent.agentSpawnLinks[agentId]`)
///       matched against a turn's `spawnToolUseIds` — the true launch point, so
///       it WINS even when the child's first activity landed during a later turn
///       (an async/background agent whose result returned under a different PR);
///   (b) else the turn whose [start, next-start) span contains the child's first
///       timestamp;
///   (c) else unlinked (folded into the parent's unattributed spend).
export function resolveChildFolds(
  parent: { turns: Array<{ spawnToolUseIds?: string[]; timestamp?: string; assistantCalls: Array<{ timestamp?: string }> }>; agentSpawnLinks?: Record<string, string> },
  children: ChildFold[],
): TurnFolds {
  const byTurnIndex = new Map<number, ChildFold[]>()
  const unlinked: ChildFold[] = []
  const turns = parent.turns
  const spawnTurn = new Map<string, number>()
  turns.forEach((turn, i) => {
    for (const id of turn.spawnToolUseIds ?? []) if (!spawnTurn.has(id)) spawnTurn.set(id, i)
  })
  const push = (i: number, child: ChildFold): void => {
    const list = byTurnIndex.get(i)
    if (list) list.push(child)
    else byTurnIndex.set(i, [child])
  }
  for (const child of children) {
    const spawnId = parent.agentSpawnLinks?.[child.agentId]
    if (spawnId !== undefined && spawnTurn.has(spawnId)) { push(spawnTurn.get(spawnId)!, child); continue }
    const ts = child.spawnAt
    let idx = -1
    if (ts) {
      for (let i = 0; i < turns.length; i++) {
        const start = turnStartTs(turns[i]!)
        if (!start) continue
        if (start <= ts) idx = i
        else break
      }
    }
    if (idx >= 0) push(idx, child)
    else unlinked.push(child)
  }
  return { byTurnIndex, unlinked }
}

function* allFolds(folds?: TurnFolds): Iterable<ChildFold> {
  if (!folds) return
  for (const list of folds.byTurnIndex.values()) yield* list
  yield* folds.unlinked
}

/// Attribute a session's spend to the PRs it referenced, at TURN granularity.
///
/// Walk the turns in order carrying `current` = the PR set of the most recent
/// turn that referenced any PR (seeded from `prRefsAtRangeStart` so a reference
/// made before the report window still owns its in-range follow-up turns). Each
/// turn's cost/savings are split evenly across a multi-PR set (a merge-sweep turn
/// touching several PRs); calls are split by largest-remainder so they stay whole.
/// Each contribution also records the models of its calls and the turn's task
/// category, both weighted by the same split share. Turns before the first
/// reference land in `unattributed` (genuine session overhead).
///
/// Legacy fallback: a session whose transcript already expired keeps its
/// session-level `prLinks` but has NO per-turn `prRefs`. With no turn boundaries
/// to attribute by, split the whole session evenly across its prLinks, mark every
/// portion `approx`, and carry the session's model union (its calls still name
/// their models) but NO category breakdown, since none can be honestly assigned.
///
/// Subagent folding: `folds` carries the spend of the sidechain sessions this one
/// spawned, resolved to the launching turn (see resolveChildFolds). Each child's
/// cost/calls/savings/models/categories are added into that turn BEFORE the PR
/// split, so the child inherits the turn's PR set; a child on a pre-reference turn
/// (or resolved to no turn) folds into `unattributed`. Children are folded exactly
/// once here and never self-attribute (their own `prLinks` is empty), so no spend
/// is double-counted.
export function attributeSessionPrSpend(session: AttributableSession, folds?: TurnFolds): SessionPrAttribution {
  const perUrl = new Map<string, PrContribution>()
  const unattributed = { cost: 0, calls: 0, savingsUSD: 0 }

  const hasTurnRefs = session.turns.some(t => t.prRefs?.length) || !!session.prRefsAtRangeStart?.length
  if (!hasTurnRefs) {
    const links = session.prLinks
    if (links?.length) {
      const legacyModels = new Map<string, number>()
      for (const turn of session.turns) {
        for (const call of turn.assistantCalls) {
          if (call.model) addToMap(legacyModels, call.model, call.costUSD)
        }
      }
      // Fold subagent spend into the same even split so it is not dropped. Rare:
      // a legacy (expired-transcript) parent almost never has live children, but
      // if it does their spend must still land somewhere honest.
      let extraCost = 0, extraCalls = 0, extraSavings = 0
      for (const child of allFolds(folds)) {
        extraCost += child.cost; extraCalls += child.calls; extraSavings += child.savingsUSD
        for (const [m, mc] of child.models) addToMap(legacyModels, m, mc)
      }
      const share = 1 / links.length
      const callAlloc = allocateEven(session.apiCalls + extraCalls, links.length)
      links.forEach((url, i) => {
        const e = ensureContribution(perUrl, url)
        e.cost += (session.totalCostUSD + extraCost) * share
        e.calls += callAlloc[i]!
        e.savingsUSD += (session.totalSavingsUSD + extraSavings) * share
        e.approx = true
        for (const [m, mc] of legacyModels) addToMap(e.models, m, mc * share)
      })
    }
    return { perUrl, unattributed }
  }

  let current: string[] | null = session.prRefsAtRangeStart?.length ? session.prRefsAtRangeStart : null
  for (let index = 0; index < session.turns.length; index++) {
    const turn = session.turns[index]!
    if (turn.prRefs?.length) current = turn.prRefs
    let cost = 0, calls = 0, savings = 0
    let ownCost = 0
    const modelCostInTurn = new Map<string, number>()
    const categoryCostInTurn = new Map<string, number>()
    for (const call of turn.assistantCalls) {
      cost += call.costUSD; ownCost += call.costUSD; calls += 1; savings += call.savingsUSD ?? 0
      if (call.model) addToMap(modelCostInTurn, call.model, call.costUSD)
    }
    // The turn's own spend lands under its single classified category; each folded
    // child contributes its OWN per-turn category breakdown (cheaply available
    // from the child's turns), so opus/haiku work shows under the categories the
    // subagent actually did rather than the parent turn's label.
    if (turn.category) addToMap(categoryCostInTurn, turn.category, ownCost)
    for (const child of folds?.byTurnIndex.get(index) ?? []) {
      cost += child.cost; calls += child.calls; savings += child.savingsUSD
      for (const [m, mc] of child.models) addToMap(modelCostInTurn, m, mc)
      for (const [cat, cc] of child.categories) addToMap(categoryCostInTurn, cat, cc)
    }
    if (cost === 0 && calls === 0 && savings === 0) continue
    if (current === null) {
      unattributed.cost += cost
      unattributed.calls += calls
      unattributed.savingsUSD += savings
      continue
    }
    const share = 1 / current.length
    const callAlloc = allocateEven(calls, current.length)
    current.forEach((url, i) => {
      const e = ensureContribution(perUrl, url)
      e.cost += cost * share
      e.calls += callAlloc[i]!
      e.savingsUSD += savings * share
      for (const [cat, cc] of categoryCostInTurn) addToMap(e.categories, cat, cc * share)
      for (const [m, mc] of modelCostInTurn) addToMap(e.models, m, mc * share)
    })
  }
  // A child that resolved to no turn (no spawn link and its first activity fell
  // outside every turn span) is genuine parent-session overhead: unattributed.
  for (const child of folds?.unlinked ?? []) {
    unattributed.cost += child.cost
    unattributed.calls += child.calls
    unattributed.savingsUSD += child.savingsUSD
  }
  return { perUrl, unattributed }
}

/// Spend attributed to each pull request at turn granularity (see
/// attributeSessionPrSpend). Rows carry ATTRIBUTED cost/calls and ARE summable;
/// `sessions` counts the distinct sessions that contributed any spend to the PR;
/// `approx` marks rows fed by the legacy even-split fallback; `models` and
/// `categories` are the attributed model/category breakdowns. Sorted by cost, desc.
export function aggregateByPr(projects: ProjectSummary[]): PrRow[] {
  const byUrl = new Map<string, {
    cost: number; savingsUSD: number; calls: number; approx: boolean
    legacyCost: number
    sessions: Set<string>; firstStarted: string; lastEnded: string
    models: Map<string, number>; categories: Map<string, number>
  }>()
  const subagentIndex = buildSubagentIndex(projects)
  for (const project of projects) {
    for (const session of project.sessions) {
      if (!session.prLinks?.length) continue
      // Key on project + sessionId: a transcript basename (sessionId) can repeat
      // across projects, so sessionId alone would undercount distinct sessions.
      const sessionKey = `${session.project} ${session.sessionId}`
      const children = subagentIndex.get(subagentKey(session.project, session.sessionId))
      const folds = children?.length ? resolveChildFolds(session, children) : undefined
      const { perUrl } = attributeSessionPrSpend(session, folds)
      for (const [url, c] of perUrl) {
        if (c.cost === 0 && c.calls === 0 && c.savingsUSD === 0) continue
        const row = byUrl.get(url) ?? {
          cost: 0, savingsUSD: 0, calls: 0, approx: false, legacyCost: 0,
          sessions: new Set<string>(), firstStarted: session.firstTimestamp, lastEnded: session.lastTimestamp,
          models: new Map<string, number>(), categories: new Map<string, number>(),
        }
        row.cost += c.cost
        row.savingsUSD += c.savingsUSD
        row.calls += c.calls
        row.sessions.add(sessionKey)
        // A legacy (approx) contribution carries no per-turn categories; track its
        // cost so a mixed row can reconcile its category breakdown to the total.
        if (c.approx) { row.approx = true; row.legacyCost += c.cost }
        for (const [m, mc] of c.models) addToMap(row.models, m, mc)
        for (const [cat, cc] of c.categories) addToMap(row.categories, cat, cc)
        if (session.firstTimestamp < row.firstStarted) row.firstStarted = session.firstTimestamp
        if (session.lastTimestamp > row.lastEnded) row.lastEnded = session.lastTimestamp
        byUrl.set(url, row)
      }
    }
  }
  return [...byUrl.entries()]
    .map(([url, r]) => {
      // Collapse raw model names to short display names, summing costs that map
      // to the same short name, then order by attributed cost (name asc breaks
      // ties for a stable order) and cap at the top 4 to bound the payload.
      const shortCosts = new Map<string, number>()
      for (const [raw, mc] of r.models) addToMap(shortCosts, getShortModelName(raw), mc)
      const models = [...shortCosts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 4)
        .map(([name]) => name)
      const categories = [...r.categories.entries()]
        .map(([cat, cost]) => ({ name: CATEGORY_LABELS[cat as TaskCategory] ?? cat, cost }))
      // Mixed row: live per-turn categories exist AND part of the row came from a
      // legacy even-split (no turn data). Add a synthetic line for the legacy
      // share so the expansion reconciles with the row cost instead of silently
      // dropping it. A legacy-only row keeps no categories (it surfaces as "no
      // per-turn detail"), so there is nothing to reconcile there.
      if (categories.length > 0 && r.legacyCost > 0) {
        categories.push({ name: 'Legacy estimate (no per-turn detail)', cost: r.legacyCost })
      }
      categories.sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name))
      return {
        url, label: shortenPrUrl(url),
        cost: r.cost, savingsUSD: r.savingsUSD,
        sessions: r.sessions.size, calls: r.calls,
        firstStarted: r.firstStarted, lastEnded: r.lastEnded,
        approx: r.approx,
        models,
        ...(categories.length ? { categories } : {}),
      }
    })
    .sort((a, b) => b.cost - a.cost)
}

/// Totals across every PR-linked session. `attributedCost` is the sum of the
/// per-PR rows (a summable total, unlike the old by-reference rows);
/// `unattributedCost` is the pre-reference overhead not tied to any specific PR.
/// `cost` = attributed + unattributed = the PR-linked spend, now INCLUDING the
/// subagent runs folded into those sessions, so it exceeds the parents' own spend.
/// `sessions` counts distinct PR-linked PARENT sessions; `subagentSessions` counts
/// the child runs folded into them (each still a standalone row in the sessions
/// list). Report both so the footer is honest about what the total covers.
export function prLinkedTotals(projects: ProjectSummary[]): { cost: number; sessions: number; subagentSessions: number; attributedCost: number; unattributedCost: number } {
  let attributedCost = 0
  let unattributedCost = 0
  let sessions = 0
  let subagentSessions = 0
  const subagentIndex = buildSubagentIndex(projects)
  for (const project of projects) {
    for (const session of project.sessions) {
      if (!session.prLinks?.length) continue
      sessions += 1
      const children = subagentIndex.get(subagentKey(session.project, session.sessionId))
      const folds = children?.length ? resolveChildFolds(session, children) : undefined
      if (children?.length) subagentSessions += children.length
      const { perUrl, unattributed } = attributeSessionPrSpend(session, folds)
      for (const c of perUrl.values()) attributedCost += c.cost
      unattributedCost += unattributed.cost
    }
  }
  return { cost: attributedCost + unattributedCost, sessions, subagentSessions, attributedCost, unattributedCost }
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
