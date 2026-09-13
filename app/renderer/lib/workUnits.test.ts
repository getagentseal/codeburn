import { describe, expect, it } from 'vitest'

import { buildWorkUnitEntries, sortWorkUnitEntries, summarizeWorkUnitEntries, workUnitSortValue } from './workUnits'
import type { SessionRow, WorkUnitJson } from './types'

const row = (sessionId: string, cost: number, overrides: Partial<SessionRow> = {}): SessionRow => ({
  sessionId,
  title: sessionId,
  project: '/tmp/project',
  provider: 'claude',
  models: ['sonnet'],
  cost,
  savingsUSD: 0,
  calls: 1,
  turns: 2,
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  startedAt: '2026-08-20T10:00:00.000Z',
  endedAt: '2026-08-20T10:10:00.000Z',
  durationMs: 600_000,
  agentType: null,
  ...overrides,
})

// Mirrors the wire shape: root member first, then children.
const unit = (rootSessionId: string, children: string[], opts: Partial<WorkUnitJson> = {}): WorkUnitJson => ({
  workUnitId: `unit-${rootSessionId}`,
  rootSessionId,
  rootProvider: 'claude',
  childSessionIds: [...children].sort(),
  roles: Object.fromEntries([
    [rootSessionId, children.length > 0 ? 'root' : 'unknown'],
    ...children.map(childId => [childId, 'child']),
  ]) as WorkUnitJson['roles'],
  members: [
    { sessionId: rootSessionId, provider: 'claude', role: children.length > 0 ? 'root' : 'unknown' },
    ...[...children].sort().map(childId => ({ sessionId: childId, provider: 'claude', role: 'child' as const })),
  ],
  ...opts,
})

const always = () => true
const matching = (needle: string) => (row: SessionRow) => (row.title ?? '').toLowerCase().includes(needle)

describe('buildWorkUnitEntries', () => {
  // Acceptance fixture: root 2 + children 3 and 5 + independent 7.
  const acceptanceRows = [
    row('root', 2),
    row('child-a', 3, { startedAt: '2026-08-20T10:05:00.000Z' }),
    row('child-b', 5, { startedAt: '2026-08-20T10:20:00.000Z' }),
    row('independent', 7),
  ]
  const acceptanceUnits = [unit('root', ['child-a', 'child-b']), unit('independent', [])]

  it('groups the family, separates root from children, totals reconcile (17 / 10 / 8)', () => {
    const entries = buildWorkUnitEntries(acceptanceRows, acceptanceUnits, always)

    expect(entries).toHaveLength(2)
    const group = entries.find(entry => entry.kind === 'group')!
    expect(group.root.sessionId).toBe('root')
    expect(group.children.map(child => child.sessionId)).toEqual(['child-b', 'child-a']) // newest first
    expect(group.row.cost).toBe(10)
    expect(group.rootCost).toBe(2)
    expect(group.childrenCost).toBe(8)
    const single = entries.find(entry => entry.kind === 'single')!
    expect(single.root.sessionId).toBe('independent')
    expect(single.row.cost).toBe(7)
    // Global total = group + singles, expand/collapse state cannot move it.
    expect(group.row.cost + single.row.cost).toBe(17)
  })

  it('summary counts sessions and groups separately without re-summing detail', () => {
    const summary = summarizeWorkUnitEntries(buildWorkUnitEntries(acceptanceRows, acceptanceUnits, always))
    expect(summary).toEqual({ sessions: 4, groups: 1, cost: 17, tokens: 4 * 150 })
  })

  it('a grandchild folds under the top root exactly once; no intermediate parent is invented', () => {
    const rows = [row('root', 1), row('child', 2), row('grandchild', 4)]
    const units = [unit('root', ['child', 'grandchild'])]
    const entries = buildWorkUnitEntries(rows, units, always)

    expect(entries).toHaveLength(1)
    expect(entries[0]!.children.map(child => child.sessionId).sort()).toEqual(['child', 'grandchild'])
    expect(entries[0]!.row.cost).toBe(7)
  })

  it('an out-of-window parent leaves the child visible as a standalone single', () => {
    const rows = [row('orphan', 6)]
    const units = [unit('missing', [])] // the parent unit is not part of the wire partition
    const entries = buildWorkUnitEntries(rows, units, always)

    expect(entries).toHaveLength(1)
    expect(entries[0]!.kind).toBe('single')
    expect(entries[0]!.row.cost).toBe(6)
  })

  it('ambiguous duplicate rows never group and never lose spend', () => {
    const rows = [row('dup', 3, { title: 'First record' }), row('dup', 4, { title: 'Second record' })]
    const entries = buildWorkUnitEntries(rows, [], always)

    expect(entries).toHaveLength(2)
    expect(entries.map(entry => entry.row.cost).sort((a, b) => a - b)).toEqual([3, 4])
  })

  it('the same id under two providers stays two singles; provider identity disambiguates', () => {
    const rows = [
      row('shared-id', 3, { provider: 'claude', title: 'claude one' }),
      row('shared-id', 4, { provider: 'codex', title: 'codex one' }),
    ]
    const entries = buildWorkUnitEntries(rows, [
      { ...unit('shared-id', []), rootProvider: 'claude', members: [{ sessionId: 'shared-id', provider: 'claude', role: 'unknown' }], workUnitId: 'claude-unit' },
      { ...unit('shared-id', []), rootProvider: 'codex', members: [{ sessionId: 'shared-id', provider: 'codex', role: 'unknown' }], workUnitId: 'codex-unit' },
    ], always)

    expect(entries).toHaveLength(2)
    expect(new Set(entries.map(entry => entry.row.provider))).toEqual(new Set(['claude', 'codex']))
  })

  it('searching for a member surfaces the whole group and flags only the matches', () => {
    const rows = [
      row('root', 2, { title: 'Ship the parser' }),
      row('child-a', 3, { title: 'Explore indexing' }),
      row('child-b', 5, { title: 'Write tests' }),
    ]
    const entries = buildWorkUnitEntries(rows, [unit('root', ['child-a', 'child-b'])], matching('explore'))

    expect(entries).toHaveLength(1)
    const group = entries[0]!
    expect(group.kind).toBe('group')
    // The whole group is visible…
    expect(group.children).toHaveLength(2)
    expect(group.row.cost).toBe(10)
    // …but only the matched member is flagged.
    expect(group.matchedMemberKeys.size).toBe(1)
    expect([...group.matchedMemberKeys][0]).toContain('child-a')
  })

  it('a group with no matching member is excluded entirely', () => {
    const rows = [row('root', 2), row('child-a', 3), row('unrelated', 9)]
    const entries = buildWorkUnitEntries(rows, [unit('root', ['child-a'])], matching('unrelated'))

    expect(entries).toHaveLength(1)
    expect(entries[0]!.kind).toBe('single')
    expect(entries[0]!.root.sessionId).toBe('unrelated')
  })
})

describe('sortWorkUnitEntries', () => {
  it('ranks by the WHOLE unit cost, not the root row alone', () => {
    // A 2-cost root with an 8-cost child outranks a 9-cost standalone session.
    const entries = buildWorkUnitEntries(
      [row('big-group-root', 2), row('big-group-child', 8), row('expensive-solo', 9)],
      [unit('big-group-root', ['big-group-child'])],
      always,
    )
    const sorted = sortWorkUnitEntries(entries, 'cost')
    expect(sorted.map(entry => entry.key)).toEqual(['unit-big-group-root', 'claude\u0000expensive-solo'])
    expect(workUnitSortValue('cost', sorted[0]!)).toBe(10)
  })

  it('breaks ties deterministically by key', () => {
    const entries = buildWorkUnitEntries([row('a', 5), row('b', 5)], [], always)
    expect(sortWorkUnitEntries(entries, 'cost').map(entry => entry.key)).toEqual(['claude\u0000a', 'claude\u0000b'])
  })
})
