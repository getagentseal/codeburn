import type { ContributionSegment, SessionDrillRow, SessionRow } from './types'

/**
 * The shared investigation (drill-through) selection. Serializable by design:
 * it rides the in-app Back/Forward history and a best-effort localStorage
 * snapshot across restarts. One array per dimension; values are normalized
 * (sorted, deduplicated) so two paths that select the same thing produce the
 * same state and the same memo keys.
 *
 * Semantics at the destination: values WITHIN one dimension union with OR;
 * DIFFERENT dimensions intersect with AND. Cost/token contributions are
 * computed per segment (see contributeRow) over the FULL filtered population,
 * never just the visible page.
 */
export type BranchFilter = { project: string; branch: string }
export type SessionFilter = { provider: string; sessionId: string }

export type InvestigationFilters = {
  /** Local day keys (YYYY-MM-DD, same key family as history.daily). */
  days: string[]
  providers: string[]
  /** Canonical project paths — exact matches only, so a project whose path is
   *  a prefix of another never captures the other's sessions. */
  projects: string[]
  /** Short model-name keys (the same canonical display identity every report
   *  uses: modelBreakdown, topModels, PR model chips). */
  models: string[]
  /** Raw TaskCategory keys. */
  categories: string[]
  /** Full PR URLs (the aggregation key of the by-PR report). */
  prs: string[]
  /** Branch is only meaningful as project+branch: two projects share `main`. */
  branches: BranchFilter[]
  /** A specific session (provider + id — an id alone is not globally unique). */
  sessions: SessionFilter[]
}

export const EMPTY_FILTERS: InvestigationFilters = {
  days: [],
  providers: [],
  projects: [],
  models: [],
  categories: [],
  prs: [],
  branches: [],
  sessions: [],
}

const FILTER_DIMENSIONS = ['days', 'providers', 'projects', 'models', 'categories', 'prs'] as const
export type FilterDimension = typeof FILTER_DIMENSIONS[number] | 'branches' | 'sessions'

function dedupeSorted(values: string[]): string[] {
  return [...new Set(values)].sort()
}

/** Normalize every dimension: sort + dedupe, so identical selections compare
 *  equal and serialize identically. */
export function normalizeFilters(filters: InvestigationFilters): InvestigationFilters {
  const normalized: InvestigationFilters = { ...EMPTY_FILTERS }
  for (const dimension of FILTER_DIMENSIONS) {
    normalized[dimension] = dedupeSorted(filters[dimension] ?? [])
  }
  normalized.branches = [...new Map((filters.branches ?? []).map(b => [`${b.project}\u0000${b.branch}`, b])).values()]
    .sort((a, b) => a.project.localeCompare(b.project) || a.branch.localeCompare(b.branch))
  normalized.sessions = [...new Map((filters.sessions ?? []).map(s => [`${s.provider}\u0000${s.sessionId}`, s])).values()]
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.sessionId.localeCompare(b.sessionId))
  return normalized
}

export function filtersEqual(a: InvestigationFilters, b: InvestigationFilters): boolean {
  return filtersToKey(a) === filtersToKey(b)
}

/** Canonical string form — the memoization key for every derived computation
 *  over a selection, and the history/localStorage serialization. */
export function filtersToKey(filters: InvestigationFilters): string {
  const normalized = normalizeFilters(filters)
  return [
    normalized.days.join(','),
    normalized.providers.join(','),
    normalized.projects.join(','),
    normalized.models.join(','),
    normalized.categories.join(','),
    normalized.prs.join(','),
    normalized.branches.map(b => `${b.project}>${b.branch}`).join(','),
    normalized.sessions.map(s => `${s.provider}>${s.sessionId}`).join(','),
  ].join('|')
}

/** True when any dimension carries at least one value. */
export function filtersActive(filters: InvestigationFilters): boolean {
  return filtersToKey(filters) !== filtersToKey(EMPTY_FILTERS)
}

/** Do any SEGMENT dimensions participate (needing contribution segments to
 *  attribute cost honestly)? Session-level dimensions alone can filter plain
 *  rows. */
function segmentDimensionsActive(filters: InvestigationFilters): boolean {
  return filters.days.length > 0 || filters.models.length > 0 || filters.categories.length > 0
    || filters.prs.length > 0 || filters.branches.length > 0
}

// ————— filter builders (the drill-through entry points) —————

export function dayFilters(date: string, ...more: string[]): InvestigationFilters {
  return { ...EMPTY_FILTERS, days: [date, ...more] }
}
export function providerFilters(provider: string): InvestigationFilters {
  return { ...EMPTY_FILTERS, providers: [provider] }
}
export function projectFilters(project: string): InvestigationFilters {
  return { ...EMPTY_FILTERS, projects: [project] }
}
export function modelFilters(models: string[]): InvestigationFilters {
  return { ...EMPTY_FILTERS, models }
}
export function categoryFilters(rawCategory: string): InvestigationFilters {
  return { ...EMPTY_FILTERS, categories: [rawCategory] }
}
export function prFilters(url: string): InvestigationFilters {
  return { ...EMPTY_FILTERS, prs: [url] }
}
export function branchFilters(project: string, branch: string): InvestigationFilters {
  return { ...EMPTY_FILTERS, branches: [{ project, branch }] }
}
/** An expensive-session entry: the destination opens with the drawer already
 *  on that session. The chip dimension keeps it reproducible/removable. */
export function sessionFilters(row: Pick<SessionRow, 'provider' | 'sessionId'>): InvestigationFilters {
  return { ...EMPTY_FILTERS, sessions: [{ provider: row.provider, sessionId: row.sessionId }] }
}

/** Union one dimension's values into an existing selection (the OR rule): a
 *  second click on another day/day-bar adds that day to the same investigation. */
export function withFilterValue(filters: InvestigationFilters, dimension: FilterDimension, value: string | BranchFilter | SessionFilter): InvestigationFilters {
  const next: InvestigationFilters = { ...filters }
  if (dimension === 'branches') next.branches = [...filters.branches, value as BranchFilter]
  else if (dimension === 'sessions') next.sessions = [...filters.sessions, value as SessionFilter]
  else next[dimension] = [...filters[dimension], value as string]
  return normalizeFilters(next)
}

export function withoutFilterValue(filters: InvestigationFilters, dimension: FilterDimension, value: string | BranchFilter | SessionFilter): InvestigationFilters {
  const next: InvestigationFilters = { ...filters }
  if (dimension === 'branches') next.branches = filters.branches.filter(b => !(b.project === (value as BranchFilter).project && b.branch === (value as BranchFilter).branch))
  else if (dimension === 'sessions') next.sessions = filters.sessions.filter(s => !(s.provider === (value as SessionFilter).provider && s.sessionId === (value as SessionFilter).sessionId))
  else next[dimension] = filters[dimension].filter(v => v !== value)
  return next
}

/** Union two selections dimension-wise (the OR rule at the entry point): a
 *  second click on an aggregate while an investigation is already active adds
 *  that value to the same dimension instead of discarding the selection. */
export function unionFilters(a: InvestigationFilters, b: InvestigationFilters): InvestigationFilters {
  return normalizeFilters({
    days: [...a.days, ...b.days],
    providers: [...a.providers, ...b.providers],
    projects: [...a.projects, ...b.projects],
    models: [...a.models, ...b.models],
    categories: [...a.categories, ...b.categories],
    prs: [...a.prs, ...b.prs],
    branches: [...a.branches, ...b.branches],
    sessions: [...a.sessions, ...b.sessions],
  })
}

// ————— contribution math —————

export type IncludedRow = {
  row: SessionDrillRow
  /** Cost, calls, and input+output tokens this row contributes to the current
   *  selection. Equals the row totals only when the selection covers the whole
   *  session. Full row totals stay available on the row itself. */
  cost: number
  calls: number
  tokens: number
}

export type SelectionSummary = {
  /** Rows included in the selection's list, in input order. */
  included: IncludedRow[]
  /** Sum of contributions — the honest aggregate of the pressed value. */
  cost: number
  calls: number
  tokens: number
  /** Full cost of the LISTED sessions (a separate, clearly-labeled figure). */
  fullCost: number
  /** Rows that matched the session-level dimensions but carry no contribution
   *  segments while segment dimensions are active — excluded, and counted here
   *  so the UI can say "N sessions could not be attributed" instead of
   *  pretending a silent zero. */
  unattributable: number
}

const EPSILON = 1e-9

/** A project chip carries the canonical projectId; a row from an older CLI
 *  that predates projectId falls back to its exact raw project path. Either
 *  way matching is EXACT: prefix-similar projects never capture each other. */
function rowMatchesProject(row: SessionDrillRow, project: string): boolean {
  return row.projectId !== undefined ? row.projectId === project : row.project === project
}

/** Day and category are per-segment values; branch also involves the ROW's
 *  project (two projects share a branch name), so it is checked by the caller
 *  with the row in hand. */
function segmentMatchesDimensions(segment: ContributionSegment, filters: InvestigationFilters): boolean {
  if (filters.days.length > 0 && !(segment.day !== '' && filters.days.includes(segment.day))) return false
  if (filters.categories.length > 0 && !(segment.category !== null && filters.categories.includes(segment.category))) return false
  return true
}

/**
 * Compute one row's contribution to the selection.
 *
 * Session-level dimensions (providers/projects/sessions) gate the whole row.
 * Segment dimensions (days/models/categories/branches/PRs) intersect WITH them
 * and with each other: within a segment each dimension contributes its share of
 * each segment — day/category/branch gate it, models select actual accounting
 * totals, and PRs apply their existing even-share attribution. Model prices
 * never stand in for request or token counts.
 */
export function contributeRow(row: SessionDrillRow, filters: InvestigationFilters): IncludedRow | null {
  // Session-level gates first: they apply to the row as a whole.
  if (!rowMatchesSessionDimensions(row, filters)) return null

  // Only session-level dimensions are active: the row contributes its totals.
  if (!segmentDimensionsActive(filters)) {
    return { row, cost: row.cost, calls: row.calls, tokens: row.inputTokens + row.outputTokens }
  }

  // Segment dimensions need segments; a row without them is honestly
  // unattributable (reported in the summary), never silently zero-valued
  // inside the list.
  if (!canAttribute(row, filters)) return null

  let cost = 0
  let calls = 0
  let tokens = 0
  for (const segment of row.contributions!.segments) {
    if (!segmentMatchesDimensions(segment, filters)) continue
    if (filters.branches.length > 0 && !(segment.branch !== null && filters.branches.some(b => b.branch === segment.branch && rowMatchesProject(row, b.project)))) continue
    let share = 1
    let segmentCost = segment.cost
    let segmentCalls = segment.calls
    let segmentTokens = segment.inputTokens + segment.outputTokens
    if (filters.models.length > 0) {
      segmentCost = 0
      segmentCalls = 0
      segmentTokens = 0
      for (const model of new Set(filters.models)) {
        const usage = segment.modelUsage![model]
        if (!usage) continue
        segmentCost += segment.models[model] ?? 0
        segmentCalls += usage.calls
        segmentTokens += usage.inputTokens + usage.outputTokens
      }
    }
    if (filters.prs.length > 0) {
      if (segment.prs.length === 0) continue
      let hits = 0
      for (const url of segment.prs) if (filters.prs.includes(url)) hits++
      if (hits === 0) continue
      share *= hits / segment.prs.length
    }
    if (share <= EPSILON) continue
    cost += segmentCost * share
    calls += segmentCalls * share
    tokens += segmentTokens * share
  }
  if (cost <= EPSILON && calls <= EPSILON && tokens <= EPSILON) return null
  return { row, cost, calls, tokens }
}

function rowMatchesSessionDimensions(row: SessionDrillRow, filters: InvestigationFilters): boolean {
  return (filters.providers.length === 0 || filters.providers.includes(row.provider))
    && (filters.projects.length === 0 || filters.projects.some(project => rowMatchesProject(row, project)))
    && (filters.sessions.length === 0 || filters.sessions.some(s => s.provider === row.provider && s.sessionId === row.sessionId))
}

function canAttribute(row: SessionDrillRow, filters: InvestigationFilters): boolean {
  if (!row.contributions) return false
  // Older reports have model costs only. Exclude them with an explicit
  // coverage count instead of inventing counts or mixing partial accounting.
  return filters.models.length === 0 || row.contributions.segments.every(segment => segment.modelUsage !== undefined)
}

/** Apply the selection over the FULL population (call this before any
 *  pagination/slicing). */
export function applyInvestigation(rows: SessionDrillRow[], filters: InvestigationFilters): SelectionSummary {
  const included: IncludedRow[] = []
  let cost = 0
  let calls = 0
  let tokens = 0
  let fullCost = 0
  let unattributable = 0
  for (const row of rows) {
    const contribution = contributeRow(row, filters)
    if (contribution === null) {
      // A row the session-level gates allowed but that cannot attribute to the
      // active segment dimensions (no contribution segments) — counted so the
      // UI can disclose it instead of silently dropping spend.
      if (rowMatchesSessionDimensions(row, filters) && segmentDimensionsActive(filters) && !canAttribute(row, filters)) unattributable++
      continue
    }
    included.push(contribution)
    cost += contribution.cost
    calls += contribution.calls
    tokens += contribution.tokens
    fullCost += row.cost
  }
  return { included, cost, calls, tokens, fullCost, unattributable }
}

// ————— persistence (best-effort renderer restart restore) —————

const INVESTIGATION_SNAPSHOT_KEY = 'codeburn.investigation.v1'

export function persistInvestigation(value: unknown): void {
  try { globalThis.localStorage?.setItem(INVESTIGATION_SNAPSHOT_KEY, JSON.stringify(value)) } catch { /* storage can be unavailable */ }
}

export function readPersistedInvestigation(): InvestigationFilters | null {
  try {
    const raw = globalThis.localStorage?.getItem(INVESTIGATION_SNAPSHOT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<InvestigationFilters> | null
    if (!parsed || typeof parsed !== 'object') return null
    return normalizeFilters({ ...EMPTY_FILTERS, ...parsed })
  } catch { return null }
}

export function clearPersistedInvestigation(): void {
  try { globalThis.localStorage?.removeItem(INVESTIGATION_SNAPSHOT_KEY) } catch { /* storage can be unavailable */ }
}

/** Display label for a filter chip. Values the destination can resolve from
 *  loaded data pass through; the rest show raw (still honest). */
export function filterChipLabel(dimension: FilterDimension, value: string | BranchFilter | SessionFilter): string {
  if (dimension === 'branches') {
    const b = value as BranchFilter
    const project = b.project.split('/').filter(Boolean).at(-1) ?? b.project
    return `${project} · ${b.branch}`
  }
  if (dimension === 'sessions') {
    const s = value as SessionFilter
    return `${s.provider}:${s.sessionId.slice(0, 12)}${s.sessionId.length > 12 ? '…' : ''}`
  }
  return value as string
}
