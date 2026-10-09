import { describe, expect, it } from 'vitest'

import { aggregateSessions, foldedSessionRows, foldSubagentRows, renderJson, renderTable, renderWorkUnitJson, renderWorkUnitTable } from '../src/sessions-report.js'
import { foldContributionRows, withContributions } from '../src/session-contributions.js'
import { inferSessionProvider } from '../src/session-output.js'
import { deriveTraceId } from '../src/sync/otlp.js'
import { resolveWorkUnits, workUnitSessionKey } from '../src/work-units.js'
import type { WorkUnitResolution, WorkUnitSession } from '../src/work-units.js'
import type { ClassifiedTurn, ProjectSummary, SessionLineage, SessionSummary } from '../src/types.js'

const recorded = (role: 'root' | 'child', parentSessionId?: string): SessionLineage => ({
  ...(parentSessionId !== undefined ? { parentSessionId } : {}),
  role,
  evidence: 'provider-recorded',
})

const s = (sessionId: string, lineage?: SessionLineage, provider = 'claude'): WorkUnitSession => ({
  sessionId, provider, ...(lineage ? { lineage } : {}),
})

/// Canonical serialization of a resolution (Maps do not JSON-serialize), used
/// to pin determinism under shuffled input.
function canonical(resolution: WorkUnitResolution): string {
  return JSON.stringify({
    units: resolution.units,
    bySession: [...resolution.bySession.entries()].sort(),
  })
}

describe('resolveWorkUnits', () => {
  it('groups a two-sided family under the root, standalone sessions stay alone', () => {
    const { units, bySession } = resolveWorkUnits([
      s('root', recorded('root')),
      s('child-2', recorded('child', 'root')),
      s('solo'),
      s('child-1', recorded('child', 'root')),
    ])

    expect(units).toHaveLength(2)
    const family = units.find(unit => unit.rootSessionId === 'root')!
    expect(family.workUnitId).toBe(deriveTraceId('root'))
    expect(family.childSessionIds).toEqual(['child-1', 'child-2'])
    expect(family.roles).toEqual({ root: 'root', 'child-1': 'child', 'child-2': 'child' })
    const solo = units.find(unit => unit.rootSessionId === 'solo')!
    expect(solo.childSessionIds).toEqual([])
    expect(solo.roles).toEqual({ solo: 'unknown' })
    expect(bySession.get(workUnitSessionKey('claude', 'child-1'))).toBe(family.workUnitId)
    expect(bySession.get(workUnitSessionKey('claude', 'solo'))).toBe(solo.workUnitId)
  })

  it('folds a one-sided child under a parent that recorded nothing itself', () => {
    const { units } = resolveWorkUnits([s('parent'), s('child', recorded('child', 'parent'))])
    expect(units).toHaveLength(1)
    expect(units[0]!.rootSessionId).toBe('parent')
    expect(units[0]!.childSessionIds).toEqual(['child'])
    expect(units[0]!.roles).toEqual({ parent: 'root', child: 'child' })
  })

  it('leaves a child ungrouped when its parent is out of window (fail closed)', () => {
    const { units } = resolveWorkUnits([s('child', recorded('child', 'missing'))])
    expect(units).toEqual([{
      workUnitId: deriveTraceId('child'),
      rootSessionId: 'child',
      childSessionIds: [],
      roles: { child: 'unknown' },
    }])
  })

  it('breaks a parent cycle and marks both participants unknown', () => {
    const { units } = resolveWorkUnits([
      s('a', recorded('child', 'b')),
      s('b', recorded('child', 'a')),
    ])
    expect(units).toHaveLength(2)
    for (const unit of units) {
      expect(unit.childSessionIds).toEqual([])
      expect(Object.values(unit.roles)).toEqual(['unknown'])
    }
  })

  it('breaks a self-reference without hanging and marks it unknown', () => {
    const { units } = resolveWorkUnits([s('self', recorded('child', 'self'))])
    expect(units).toHaveLength(1)
    expect(units[0]!.rootSessionId).toBe('self')
    expect(units[0]!.childSessionIds).toEqual([])
    expect(units[0]!.roles).toEqual({ self: 'unknown' })
  })

  it('folds a nested chain under the topmost in-range root', () => {
    const { units } = resolveWorkUnits([
      s('grandchild', recorded('child', 'child')),
      s('child', recorded('child', 'root')),
      s('root', recorded('root')),
    ])
    expect(units).toHaveLength(1)
    expect(units[0]!.rootSessionId).toBe('root')
    expect(units[0]!.childSessionIds).toEqual(['child', 'grandchild'])
    expect(units[0]!.roles).toEqual({ root: 'root', child: 'child', grandchild: 'child' })
  })

  it('never folds across providers on a session-id collision', () => {
    const { units } = resolveWorkUnits([
      s('kid', recorded('child', 'shared-id'), 'claude'),
      s('shared-id', undefined, 'codex'),
    ])
    expect(units).toHaveLength(2)
    const kid = units.find(unit => unit.rootSessionId === 'kid')!
    expect(kid.childSessionIds).toEqual([])
    expect(kid.roles).toEqual({ kid: 'unknown' })
  })

  it('fails closed on duplicate (provider, id) records', () => {
    const { units, bySession } = resolveWorkUnits([
      s('dup', recorded('root')),
      s('dup'),
      s('kid', recorded('child', 'dup')),
    ])
    expect(units).toHaveLength(3)
    for (const unit of units) expect(unit.childSessionIds).toEqual([])
    expect(units.find(unit => unit.rootSessionId === 'kid')!.roles).toEqual({ kid: 'unknown' })
    // The ambiguous key is not registered for presentation grouping at all.
    expect(bySession.has(workUnitSessionKey('claude', 'dup'))).toBe(false)
  })

  it('is deterministic: shuffled input yields identical output, every session in exactly one unit', () => {
    const input = [
      s('root', recorded('root')),
      s('child-1', recorded('child', 'root')),
      s('child-2', recorded('child', 'root')),
      s('parent'),
      s('kid', recorded('child', 'parent')),
      s('orphan', recorded('child', 'missing')),
      s('a', recorded('child', 'b')),
      s('b', recorded('child', 'a')),
      s('solo'),
    ]
    const base = canonical(resolveWorkUnits(input))
    expect(canonical(resolveWorkUnits([...input].reverse()))).toBe(base)
    expect(canonical(resolveWorkUnits([input[4]!, input[8]!, input[0]!, input[6]!, input[2]!, input[7]!, input[1]!, input[5]!, input[3]!]))).toBe(base)

    const { units } = resolveWorkUnits(input)
    const members = units.flatMap(unit => [unit.rootSessionId, ...unit.childSessionIds])
    expect(members.sort()).toEqual(input.map(session => session.sessionId).sort())
  })
})

function makeSession(opts: {
  sessionId: string
  title?: string
  cost: number
  calls: number
  savings?: number
  startedAt: string
  endedAt: string
  lineage?: SessionLineage
}): SessionSummary {
  const usage = {
    inputTokens: 100,
    outputTokens: 20,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
  }
  const turn: ClassifiedTurn = {
    userMessage: 'work',
    timestamp: opts.startedAt,
    sessionId: opts.sessionId,
    category: 'feature',
    retries: 0,
    hasEdits: true,
    assistantCalls: [{
      provider: 'claude',
      model: 'claude-sonnet-4-5',
      usage,
      costUSD: opts.cost,
      tools: [],
      mcpTools: [],
      skills: [],
      subagentTypes: [],
      hasAgentSpawn: false,
      hasPlanMode: false,
      speed: 'standard',
      timestamp: opts.startedAt,
      bashCommands: [],
      deduplicationKey: `call-${opts.sessionId}`,
    }],
  }
  return {
    sessionId: opts.sessionId,
    project: 'codeburn',
    ...(opts.title !== undefined ? { title: opts.title } : {}),
    firstTimestamp: opts.startedAt,
    lastTimestamp: opts.endedAt,
    totalCostUSD: opts.cost,
    totalSavingsUSD: opts.savings ?? 0,
    totalInputTokens: 100,
    totalOutputTokens: 20,
    totalReasoningTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: opts.calls,
    turns: [turn],
    modelBreakdown: {
      'claude-sonnet-4-5': { calls: opts.calls, costUSD: opts.cost, tokens: usage, savingsUSD: opts.savings ?? 0 },
    },
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {} as SessionSummary['categoryBreakdown'],
    skillBreakdown: {},
    subagentBreakdown: {},
    ...(opts.lineage ? { lineage: opts.lineage } : {}),
  }
}

function makeProjects(sessions: SessionSummary[]): ProjectSummary[] {
  return [{
    project: 'codeburn',
    projectPath: '/tmp/codeburn',
    sessions,
    totalCostUSD: sessions.reduce((sum, session) => sum + session.totalCostUSD, 0),
    totalSavingsUSD: sessions.reduce((sum, session) => sum + session.totalSavingsUSD, 0),
    totalApiCalls: sessions.reduce((sum, session) => sum + session.apiCalls, 0),
    totalProxiedCostUSD: 0,
  }]
}

function resolveProjects(projects: ProjectSummary[]): WorkUnitResolution {
  return resolveWorkUnits(projects.flatMap(project => project.sessions.map(session => ({
    sessionId: session.sessionId,
    provider: inferSessionProvider(session),
    ...(session.lineage ? { lineage: session.lineage } : {}),
  }))))
}

function familyFixture(): ProjectSummary[] {
  return makeProjects([
    makeSession({
      sessionId: 'root', title: 'Build the thing', cost: 1, calls: 4,
      startedAt: '2026-08-20T10:00:00.000Z', endedAt: '2026-08-20T11:00:00.000Z',
      lineage: recorded('root'),
    }),
    makeSession({
      sessionId: 'child-1', cost: 0.25, calls: 1,
      startedAt: '2026-08-20T10:05:00.000Z', endedAt: '2026-08-20T10:10:00.000Z',
      lineage: recorded('child', 'root'),
    }),
    makeSession({
      sessionId: 'child-2', cost: 0.5, calls: 2,
      startedAt: '2026-08-20T10:20:00.000Z', endedAt: '2026-08-20T10:30:00.000Z',
      lineage: recorded('child', 'root'),
    }),
    makeSession({
      sessionId: 'solo', title: 'Unrelated session', cost: 2, calls: 3,
      startedAt: '2026-08-21T09:00:00.000Z', endedAt: '2026-08-21T09:30:00.000Z',
    }),
  ])
}

const totalOf = (output: string): string | undefined => /\$([\d.]+) total/.exec(output)?.[1]

describe('sessions --by-work-unit presentation', () => {
  it('groups a family under one unit row with summed cost/calls and indented children', () => {
    const rows = aggregateSessions(familyFixture())
    const output = renderWorkUnitTable(rows, resolveProjects(familyFixture()), { terminalWidth: 200 })

    const unitLine = output.split('\n').find(line => line.includes('Build the thing'))!
    expect(unitLine).toContain('$1.75') // 1.00 + 0.25 + 0.50
    expect(unitLine).toContain(' 7 ')   // 4 + 1 + 2 calls
    expect(unitLine).toContain(' 2 ')   // child count
    expect(output).toContain('↳ child-1')
    expect(output).toContain('↳ child-2')
    // The standalone session renders as a plain row, never indented.
    const soloLine = output.split('\n').find(line => line.includes('Unrelated session'))!
    expect(soloLine).not.toContain('↳')
    expect(output).toContain('4 sessions')
    expect(output).toContain('1 work unit')
  })

  it('keeps the money invariant: the grouped footer total equals the ungrouped total', () => {
    const rows = aggregateSessions(familyFixture())
    const grouped = renderWorkUnitTable(rows, resolveProjects(familyFixture()), { terminalWidth: 200 })
    const ungrouped = renderTable(rows, { terminalWidth: 200 })
    expect(totalOf(grouped)).toBe('3.75')
    expect(totalOf(grouped)).toBe(totalOf(ungrouped))
  })

  it('extends json with an add-only workUnits array; the sessions rows are unchanged', () => {
    const rows = aggregateSessions(familyFixture())
    const resolution = resolveProjects(familyFixture())
    const parsed = JSON.parse(renderWorkUnitJson(rows, resolution))

    // Add-only: the envelope's sessions are exactly today's json rows.
    expect(parsed.sessions).toEqual(JSON.parse(renderJson(rows)))
    expect(Array.isArray(JSON.parse(renderJson(rows)))).toBe(true)

    expect(parsed.workUnits).toHaveLength(2)
    const family = parsed.workUnits.find((unit: { rootSessionId: string }) => unit.rootSessionId === 'root')
    expect(family.workUnitId).toBe(deriveTraceId('root'))
    expect(family.childSessionIds).toEqual(['child-1', 'child-2'])
    expect(family.roles).toEqual({ root: 'root', 'child-1': 'child', 'child-2': 'child' })
    const solo = parsed.workUnits.find((unit: { rootSessionId: string }) => unit.rootSessionId === 'solo')
    expect(solo.roles).toEqual({ solo: 'unknown' })
  })
})

describe('default sessions list folds subagents under their parent', () => {
  it('returns one row per parent with its subagents summed in and listed', () => {
    const projects = familyFixture()
    const rows = aggregateSessions(projects)
    const folded = foldSubagentRows(rows, resolveProjects(projects))

    expect(folded.map(row => row.sessionId)).toEqual(['root', 'solo'])
    const root = folded[0]!
    expect(root.cost).toBeCloseTo(1.75)
    expect(root.calls).toBe(7)
    expect(root.startedAt).toBe('2026-08-20T10:00:00.000Z')
    expect(root.subagents!.map(row => row.sessionId)).toEqual(['child-2', 'child-1'])
    expect(folded[1]!.subagents).toBeUndefined()

    const sum = (list: typeof rows, pick: (row: (typeof rows)[number]) => number) => list.reduce((total, row) => total + pick(row), 0)
    expect(sum(folded, row => row.cost)).toBeCloseTo(sum(rows, row => row.cost))
    expect(sum(folded, row => row.calls)).toBe(sum(rows, row => row.calls))
    expect(totalOf(renderTable(folded, { terminalWidth: 200 }))).toBe(totalOf(renderTable(rows, { terminalWidth: 200 })))
  })

  it('ranks top sessions by cost including subagents, never listing a folded subagent', () => {
    const projects = familyFixture()
    projects[0]!.sessions.find(session => session.sessionId === 'solo')!.totalCostUSD = 1.5
    const ranked = foldedSessionRows(projects).sort((a, b) => b.cost - a.cost)

    expect(ranked.map(row => row.sessionId)).toEqual(['root', 'solo'])
    expect(ranked[0]!.cost).toBeCloseTo(1.75)
    expect(ranked[0]!.calls).toBe(7)
    expect(ranked[0]!.summary).toBe(projects[0])
  })

  it('leaves a subagent whose parent is not in view as its own row', () => {
    const projects = familyFixture()
    projects[0]!.sessions = projects[0]!.sessions.filter(session => session.sessionId !== 'root')
    const folded = foldSubagentRows(aggregateSessions(projects), resolveProjects(projects))
    expect(folded.map(row => row.sessionId).sort()).toEqual(['child-1', 'child-2', 'solo'])
    expect(folded.every(row => row.subagents === undefined)).toBe(true)
  })

  it('folds the contributions report the same way, keeping segments a partition of the row', () => {
    const projects = familyFixture()
    const rows = aggregateSessions(projects)
    const folded = foldContributionRows(withContributions(rows, projects), resolveProjects(projects))

    expect(folded.map(row => row.sessionId)).toEqual(['root', 'solo'])
    const root = folded[0]!
    const segmentCost = root.contributions!.segments.reduce((total, segment) => total + segment.cost, 0)
    expect(segmentCost).toBeCloseTo(root.cost)
    expect(root.subagents!.every(child => !('contributions' in child))).toBe(true)
  })
})
