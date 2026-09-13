import type { SessionRow, WorkUnitJson } from './types'

// Renderer-side presentation of the CLI's work-unit envelope
// (`sessions --by-work-unit --format json` → { sessions, workUnits }). This is
// pure arithmetic over the JSON payload — the parsing and lineage resolution
// live in the CLI; the renderer only regroups what the resolver already
// decided and never invents a link the wire does not carry.
//
// Mirrors the CLI table's rules (src/sessions-report.ts renderWorkUnitTable):
// - only units whose members are present AND include the root row become
//   groups; everything else renders standalone;
// - the aggregate sums the whole unit while the root/children split stays
//   explicit, so a top-level total never re-sums member detail rows;
// - rows the resolver left unmapped (ambiguous duplicates, out-of-window
//   parents) stay visible as singles — no link is invented, no spend dropped.

export type WorkUnitEntry = {
  kind: 'group' | 'single'
  /** Stable identity: the unit's workUnitId for groups, the provider-scoped
   *  row key for singles. Keys an expanded/collapsed panel across polls. */
  key: string
  /** The root row for groups, the row itself for singles. */
  root: SessionRow
  /** Groups only: non-root members, newest first. */
  children: SessionRow[]
  /** Whole-unit aggregate for groups, the row itself for singles. Top-level
   *  totals and cost sorting read THIS row, never the member detail. */
  row: SessionRow
  /** The root's own contribution, kept separate from the descendants'. */
  rootCost: number
  childrenCost: number
  /** provider\0sessionId keys of members matching the active search. Empty
   *  when nothing was searched; a group is visible when this is non-empty
   *  (or when no search is active) without implying every member matched. */
  matchedMemberKeys: Set<string>
}

export const rowKey = (row: Pick<SessionRow, 'provider' | 'sessionId'>): string => `${row.provider}\u0000${row.sessionId}`

function endedAtTime(row: SessionRow): number {
  const time = new Date(row.endedAt).getTime()
  return Number.isNaN(time) ? 0 : time
}

/**
 * Regroup a full (unfiltered) session population into visible entries under
 * the active match predicate. `matches` is the search predicate over rows —
 * pass `() => true` for the unsearched view. A group is included when ANY
 * member matches (the whole group then renders, matches flagged), a single
 * row when it matches itself.
 */
export function buildWorkUnitEntries(
  rows: SessionRow[],
  units: WorkUnitJson[],
  matches: (row: SessionRow) => boolean,
): WorkUnitEntry[] {
  const byKey = new Map<string, SessionRow[]>()
  for (const row of rows) {
    const key = rowKey(row)
    const list = byKey.get(key)
    if (list) list.push(row)
    else byKey.set(key, [row])
  }

  const entries: WorkUnitEntry[] = []
  const claimed = new Set<string>()
  for (const unit of units) {
    const memberRows: SessionRow[] = []
    for (const member of unit.members) {
      const row = byKey.get(rowKey(member))?.[0]
      if (row) memberRows.push(row)
    }
    // Presentation contract: members[0] is the root. Resolve it by identity so
    // a provider-scoped duplicate can never masquerade as the root.
    const root = memberRows.find(row => row.sessionId === unit.rootSessionId && row.provider === unit.rootProvider)
    if (!root || memberRows.length < 2) continue // members stay unclaimed → eligible singles
    const matchedMemberKeys = new Set(memberRows.filter(matches).map(rowKey))
    if (matchedMemberKeys.size === 0) continue // no member matched → the whole group stays out of this view
    const children = memberRows
      .filter(row => row !== root)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.sessionId.localeCompare(b.sessionId))
    const models: string[] = []
    for (const member of [root, ...children]) {
      for (const model of member.models) if (!models.includes(model)) models.push(model)
    }
    const startedAt = memberRows.reduce((min, row) => (row.startedAt < min ? row.startedAt : min), root.startedAt)
    const endedAt = memberRows.reduce((max, row) => (row.endedAt > max ? row.endedAt : max), root.endedAt)
    const sum = (pick: (row: SessionRow) => number): number => memberRows.reduce((total, row) => total + pick(row), 0)
    const aggregate: SessionRow = {
      ...root,
      models,
      cost: sum(row => row.cost),
      savingsUSD: sum(row => row.savingsUSD),
      calls: sum(row => row.calls),
      turns: sum(row => row.turns),
      inputTokens: sum(row => row.inputTokens),
      outputTokens: sum(row => row.outputTokens),
      cacheReadTokens: sum(row => row.cacheReadTokens),
      cacheWriteTokens: sum(row => row.cacheWriteTokens),
      startedAt,
      endedAt,
      durationMs: Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime()) || 0,
    }
    for (const row of memberRows) claimed.add(rowKey(row))
    entries.push({
      kind: 'group',
      key: unit.workUnitId,
      root,
      children,
      row: aggregate,
      rootCost: root.cost,
      childrenCost: aggregate.cost - root.cost,
      matchedMemberKeys,
    })
  }

  for (const row of rows) {
    const key = rowKey(row)
    if (claimed.has(key)) continue
    if (!matches(row)) continue
    entries.push({
      kind: 'single',
      key,
      root: row,
      children: [],
      row,
      rootCost: row.cost,
      childrenCost: 0,
      matchedMemberKeys: new Set([key]),
    })
  }

  return entries
}

export type WorkUnitSort = 'cost' | 'recent' | 'turns' | 'tokens'

/** Sort value over WHOLE entries: groups rank by their aggregate, never by the
 *  root row alone, so cost order is the order of full unit spend. */
export function workUnitSortValue(sort: WorkUnitSort, entry: WorkUnitEntry): number {
  const row = entry.row
  if (sort === 'cost') return row.cost
  if (sort === 'turns') return row.turns
  if (sort === 'tokens') return row.inputTokens + row.outputTokens
  return endedAtTime(row)
}

export function sortWorkUnitEntries(entries: WorkUnitEntry[], sort: WorkUnitSort): WorkUnitEntry[] {
  return [...entries].sort((a, b) =>
    workUnitSortValue(sort, b) - workUnitSortValue(sort, a) || a.key.localeCompare(b.key))
}

/** Top-level summary over the visible entries. `sessions` counts every member
 *  of every included entry exactly once; `groups` counts multi-session units;
 *  cost/tokens sum only the top-level aggregates (never re-summed detail). */
export function summarizeWorkUnitEntries(entries: WorkUnitEntry[]): {
  sessions: number
  groups: number
  cost: number
  tokens: number
} {
  let sessions = 0
  let groups = 0
  let cost = 0
  let tokens = 0
  for (const entry of entries) {
    sessions += entry.kind === 'group' ? 1 + entry.children.length : 1
    if (entry.kind === 'group' && entry.children.length > 0) groups++
    cost += entry.row.cost
    tokens += entry.row.inputTokens + entry.row.outputTokens
  }
  return { sessions, groups, cost, tokens }
}
