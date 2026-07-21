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

/// A subagent (sidechain) session's spend plus its non-self-linking descendants,
/// pre-aggregated for folding into the PR its launching parent turn was working
/// on. `models` keys are RAW model names (the row builder collapses them to short
/// names, exactly like a turn's own calls); `categories` are TaskCategory. All
/// three sum to `cost` (derived from the same sessions), so folding never adds a
/// rounding gap. `foldedSessions` counts the subtree (self plus folded
/// descendants); `spawnAtMs` is the TOP child's first-activity epoch (the whole
/// subtree resolves against the top parent through the top child's spawn);
/// `firstTs`/`lastTs` are the subtree's real activity span, used for the PR row's
/// date range when the parent has no in-range turns of its own.
export type ChildFold = {
  agentId: string
  cost: number
  calls: number
  savingsUSD: number
  spawnAtMs: number
  firstTs: string
  lastTs: string
  models: Map<string, number>
  categories: Map<string, number>
  foldedSessions: number
}

function parseMs(ts: string | undefined): number {
  return ts ? Date.parse(ts) : NaN
}

// A child "self-links" when it referenced its own PR: it then attributes
// standalone (its own turn-level attribution is more precise) and is NEVER folded
// into a parent, so its spend is counted exactly once. A child with no links is
// folded only. This mutual exclusion is what prevents a double-charge.
function selfLinks(session: { prLinks?: string[] }): boolean {
  return !!session.prLinks?.length
}

// A session id alone is NOT globally unique: imported or duplicated transcripts,
// or two providers, can reuse one id, letting two parents claim one child and
// corrupting the attribution map. Key parents (and a child's parent reference) by
// provider + id so linkage stays one-to-one; the ambiguity skip in
// resolveSubagentAttribution handles a genuine same-provider id collision.
// Subagent linkage (parentSessionId / agentSpawnLinks / spawnPrSets) is Claude
// only, and a fold ANCHOR has no in-range turns to infer a provider from, so a
// linkage-bearing session is always attributed to 'claude'; this keeps a parent
// and its child on the same key.
function linkageProvider(session: SessionSummary): string {
  if (session.parentSessionId || session.agentSpawnLinks || session.spawnPrSets) return 'claude'
  return inferProvider(session)
}
function providerSessionKey(session: SessionSummary): string {
  return `${linkageProvider(session)} ${session.sessionId}`
}
function providerParentKey(session: SessionSummary): string {
  return `${linkageProvider(session)} ${session.parentSessionId ?? ''}`
}

/// Index every sidechain (subagent) session by the parent that spawned it, keyed
/// by provider + `parentSessionId`. A child whose parent is absent from the scan
/// is never looked up, so it stays a standalone orphan.
export function buildSubagentIndex(projects: ProjectSummary[]): Map<string, SessionSummary[]> {
  const index = new Map<string, SessionSummary[]>()
  for (const project of projects)
    for (const session of project.sessions) {
      if (!session.parentSessionId) continue
      const key = providerParentKey(session)
      const list = index.get(key)
      if (list) list.push(session)
      else index.set(key, [session])
    }
  return index
}

// Aggregate a child session and its non-self-linking descendants, depth-first.
// `claimed` is ONE set per parent resolution (shared across all direct children),
// so a descendant reachable through two paths (duplicate/diamond ids) folds
// exactly once and a parent-link cycle terminates. A self-linking descendant is
// skipped: it attributes standalone. `spawnAtMs` stays the TOP child's, since the
// whole subtree resolves against the top parent.
function buildChildFold(child: SessionSummary, index: Map<string, SessionSummary[]>, claimed: Set<string>): ChildFold {
  claimed.add(child.sessionId)
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
  const fold: ChildFold = {
    agentId: child.agentId ?? child.sessionId,
    cost: child.totalCostUSD, calls: child.apiCalls, savingsUSD: child.totalSavingsUSD,
    spawnAtMs: parseMs(child.firstTimestamp),
    firstTs: child.firstTimestamp, lastTs: child.lastTimestamp,
    models, categories, foldedSessions: 1,
  }
  for (const gc of index.get(providerSessionKey(child)) ?? []) {
    if (claimed.has(gc.sessionId) || selfLinks(gc)) continue
    const gcf = buildChildFold(gc, index, claimed)
    fold.cost += gcf.cost; fold.calls += gcf.calls; fold.savingsUSD += gcf.savingsUSD
    fold.foldedSessions += gcf.foldedSessions
    for (const [m, c] of gcf.models) addToMap(fold.models, m, c)
    for (const [cat, c] of gcf.categories) addToMap(fold.categories, cat, c)
    if (gcf.firstTs && (!fold.firstTs || gcf.firstTs < fold.firstTs)) fold.firstTs = gcf.firstTs
    if (gcf.lastTs > fold.lastTs) fold.lastTs = gcf.lastTs
  }
  return fold
}

/// A folded child resolved against its parent: to a PR set (`prSet` non-empty), to
/// the parent's unattributed spend (`prSet` null, `unlinked` false), or unlinked
/// (`unlinked` true, contributes NOTHING to by-PR, the orphan semantics).
export type ResolvedChild = { fold: ChildFold; prSet: string[] | null; unlinked: boolean }

function turnStartTs(turn: { timestamp?: string; assistantCalls: Array<{ timestamp?: string }> }): string {
  return turn.assistantCalls[0]?.timestamp || turn.timestamp || ''
}

/// Resolve a fold to the PR its launching parent turn was working on, using the
/// parent's UNFILTERED turn data so a date range cannot misattribute:
///   1. spawn `tool_use` id to `parent.spawnPrSets` (built at assembly from the
///      FULL turn list), so a spawn in a pre-range turn still yields the right PR;
///      an empty set there means the spawn had no active PR, so unattributed.
///   2. else the child's first-activity epoch bucketed into the parent's turn PR
///      carry (seeded from `prRefsAtRangeStart`). Timestamps compare as epoch ms
///      (mixed UTC offsets order correctly). Activity strictly AFTER the parent's
///      last timestamp is unlinked (contributes nothing); before the first turn it
///      carries the pre-range set (or unattributed).
function resolveChild(parent: SessionSummary, fold: ChildFold): ResolvedChild {
  const spawnId = parent.agentSpawnLinks?.[fold.agentId]
  if (spawnId !== undefined && parent.spawnPrSets && Object.prototype.hasOwnProperty.call(parent.spawnPrSets, spawnId)) {
    const prs = parent.spawnPrSets[spawnId]!
    return { fold, prSet: prs.length ? prs : null, unlinked: false }
  }
  const ms = fold.spawnAtMs
  if (Number.isNaN(ms)) return { fold, prSet: null, unlinked: true }
  const lastMs = parseMs(parent.lastTimestamp)
  if (!Number.isNaN(lastMs) && ms > lastMs) return { fold, prSet: null, unlinked: true }
  let current: string[] | null = parent.prRefsAtRangeStart?.length ? parent.prRefsAtRangeStart : null
  for (const turn of parent.turns) {
    const tMs = parseMs(turnStartTs(turn))
    if (Number.isNaN(tMs)) continue
    if (tMs <= ms) { if (turn.prRefs?.length) current = turn.prRefs }
    else break
  }
  return { fold, prSet: current, unlinked: false }
}

/// Resolve every folded child to its parent's PR set, once. Keyed by the parent's
/// provider + sessionId. Parents come from each project's `sessions` AND its
/// `subagentAnchors` (PR-linked parents kept only for folding). When two DISTINCT
/// parents share a key (true duplicate data), the child is folded into NEITHER
/// (deterministic skip, stays standalone): correctness over coverage.
export type SubagentAttribution = Map<string, ResolvedChild[]>

export function resolveSubagentAttribution(projects: ProjectSummary[]): SubagentAttribution {
  const index = buildSubagentIndex(projects)
  // Count PR-bearing parents per key (real sessions AND anchors) to detect an
  // ambiguous key claimed by more than one distinct parent.
  const parentCount = new Map<string, number>()
  const bump = (s: SessionSummary): void => {
    if (!s.prLinks?.length) return
    const k = providerSessionKey(s)
    parentCount.set(k, (parentCount.get(k) ?? 0) + 1)
  }
  for (const project of projects) {
    for (const s of project.sessions) bump(s)
    for (const a of project.subagentAnchors ?? []) bump(a)
  }
  const out: SubagentAttribution = new Map()
  const resolveParent = (parent: SessionSummary): void => {
    if (!parent.prLinks?.length) return
    const k = providerSessionKey(parent)
    if (out.has(k)) return                                    // already resolved for this key
    if ((parentCount.get(k) ?? 0) > 1) { out.set(k, []); return } // ambiguous: fold nothing
    const direct = index.get(k)
    if (!direct?.length) return
    const claimed = new Set<string>()                          // one claimed set across all direct children
    const resolved: ResolvedChild[] = []
    for (const child of direct) {
      if (claimed.has(child.sessionId) || selfLinks(child)) continue
      resolved.push(resolveChild(parent, buildChildFold(child, index, claimed)))
    }
    if (resolved.length) out.set(k, resolved)
  }
  for (const project of projects) {
    for (const parent of project.sessions) resolveParent(parent)
    for (const anchor of project.subagentAnchors ?? []) resolveParent(anchor)
  }
  return out
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
export function attributeSessionPrSpend(session: AttributableSession): SessionPrAttribution {
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
      const share = 1 / links.length
      const callAlloc = allocateEven(session.apiCalls, links.length)
      links.forEach((url, i) => {
        const e = ensureContribution(perUrl, url)
        e.cost += session.totalCostUSD * share
        e.calls += callAlloc[i]!
        e.savingsUSD += session.totalSavingsUSD * share
        e.approx = true
        for (const [m, mc] of legacyModels) addToMap(e.models, m, mc * share)
      })
    }
    return { perUrl, unattributed }
  }

  let current: string[] | null = session.prRefsAtRangeStart?.length ? session.prRefsAtRangeStart : null
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
    const modelCostInTurn = new Map<string, number>()
    for (const call of turn.assistantCalls) {
      if (call.model) addToMap(modelCostInTurn, call.model, call.costUSD)
    }
    const share = 1 / current.length
    const callAlloc = allocateEven(calls, current.length)
    current.forEach((url, i) => {
      const e = ensureContribution(perUrl, url)
      e.cost += cost * share
      e.calls += callAlloc[i]!
      e.savingsUSD += savings * share
      if (turn.category) addToMap(e.categories, turn.category, cost * share)
      for (const [m, mc] of modelCostInTurn) addToMap(e.models, m, mc * share)
    })
  }
  return { perUrl, unattributed }
}

/// PR-attribution totals. `attributedCost` is the sum of the per-PR rows;
/// `unattributedCost` is pre-reference overhead not tied to any specific PR;
/// `cost` = attributed + unattributed = the PR-linked spend INCLUDING folded
/// subagent runs, so it exceeds the parents' own spend. `sessions` counts distinct
/// PR-linked PARENT sessions ONLY (0-cost fold anchors are excluded); it is
/// `subagentSessions` (folded subtrees: children plus descendants) that explains
/// the extra spend.
export type PrTotals = { cost: number; sessions: number; subagentSessions: number; attributedCost: number; unattributedCost: number }
export type PrAttribution = { rows: PrRow[]; totals: PrTotals }

/// Spend by pull request, at turn granularity, with subagent runs folded into the
/// PR each was working on. Computed in ONE pass so `aggregateByPr` (rows) and
/// `prLinkedTotals` (totals) never disagree; the payload builder should call this
/// once and read both. Rows carry ATTRIBUTED cost/calls and ARE summable; `approx`
/// marks legacy even-split rows; `models`/`categories` are the attributed
/// breakdowns. Sorted by cost, descending.
export function buildPrAttribution(projects: ProjectSummary[]): PrAttribution {
  const byUrl = new Map<string, {
    cost: number; savingsUSD: number; calls: number; approx: boolean
    legacyCost: number
    sessions: Set<string>; firstStarted: string; lastEnded: string
    models: Map<string, number>; categories: Map<string, number>
  }>()
  const attribution = resolveSubagentAttribution(projects)
  let attributedCost = 0
  let unattributedCost = 0
  let sessions = 0
  let subagentSessions = 0

  // Add one contribution (a parent turn's share, or a folded child's share) to a
  // PR row. `sessionKey` is the contributing PARENT's identity, so a folded child
  // does not inflate the row's distinct-session count beyond its parent. Empty
  // timestamps (a 0-turn anchor) never widen the span; folded children pass their
  // OWN activity span, which is what dates an anchor-only row.
  const addTo = (
    url: string, sessionKey: string, firstTs: string, lastTs: string,
    cost: number, savings: number, calls: number, approx: boolean,
    models: Map<string, number>, categories: Map<string, number>,
  ): void => {
    if (cost === 0 && calls === 0 && savings === 0) return
    const row = byUrl.get(url) ?? {
      cost: 0, savingsUSD: 0, calls: 0, approx: false, legacyCost: 0,
      sessions: new Set<string>(), firstStarted: firstTs, lastEnded: lastTs,
      models: new Map<string, number>(), categories: new Map<string, number>(),
    }
    row.cost += cost
    row.savingsUSD += savings
    row.calls += calls
    row.sessions.add(sessionKey)
    if (approx) { row.approx = true; row.legacyCost += cost }
    for (const [m, mc] of models) addToMap(row.models, m, mc)
    for (const [cat, cc] of categories) addToMap(row.categories, cat, cc)
    if (firstTs && (!row.firstStarted || firstTs < row.firstStarted)) row.firstStarted = firstTs
    if (lastTs && lastTs > row.lastEnded) row.lastEnded = lastTs
    byUrl.set(url, row)
  }

  // Fold one parent's resolved children into rows + totals. An unlinked child
  // contributes nothing; a child with no active PR goes to unattributed (no row).
  const foldChildren = (parent: SessionSummary): void => {
    const sessionKey = `${parent.project} ${parent.sessionId}`
    for (const rc of attribution.get(providerSessionKey(parent)) ?? []) {
      if (rc.unlinked) continue
      subagentSessions += rc.fold.foldedSessions
      if (!rc.prSet?.length) { unattributedCost += rc.fold.cost; continue }
      attributedCost += rc.fold.cost
      const prs = rc.prSet
      const share = 1 / prs.length
      const callAlloc = allocateEven(rc.fold.calls, prs.length)
      prs.forEach((url, i) => {
        const models = new Map<string, number>()
        for (const [m, mc] of rc.fold.models) models.set(m, mc * share)
        const categories = new Map<string, number>()
        for (const [cat, cc] of rc.fold.categories) categories.set(cat, cc * share)
        addTo(url, sessionKey, rc.fold.firstTs, rc.fold.lastTs,
          rc.fold.cost * share, rc.fold.savingsUSD * share, callAlloc[i]!, false, models, categories)
      })
    }
  }

  for (const project of projects) {
    for (const session of project.sessions) {
      if (!session.prLinks?.length) continue
      sessions += 1
      const sessionKey = `${session.project} ${session.sessionId}`
      const { perUrl, unattributed } = attributeSessionPrSpend(session)
      for (const [url, c] of perUrl) {
        attributedCost += c.cost
        addTo(url, sessionKey, session.firstTimestamp, session.lastTimestamp, c.cost, c.savingsUSD, c.calls, c.approx, c.models, c.categories)
      }
      unattributedCost += unattributed.cost
      foldChildren(session)
    }
    // Anchor parents: fold their children only. NOT counted in `sessions`, and no
    // own spend (they have no in-range turns).
    for (const anchor of project.subagentAnchors ?? []) {
      if (!anchor.prLinks?.length) continue
      foldChildren(anchor)
    }
  }

  const rows = [...byUrl.entries()]
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

  return { rows, totals: { cost: attributedCost + unattributedCost, sessions, subagentSessions, attributedCost, unattributedCost } }
}

/// Spend attributed to each pull request (thin wrapper over buildPrAttribution).
export function aggregateByPr(projects: ProjectSummary[]): PrRow[] {
  return buildPrAttribution(projects).rows
}

/// Totals across every PR-linked session (thin wrapper over buildPrAttribution).
export function prLinkedTotals(projects: ProjectSummary[]): PrTotals {
  return buildPrAttribution(projects).totals
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
