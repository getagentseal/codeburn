import { describe, expect, it } from 'vitest'

import { groupProjects } from './projectGroups'
import type { BranchSpendProjectReport, BranchSpendRow } from './types'

const NO_TOKENS = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

function row(branch: string | null, cost: number, sessions = 1): BranchSpendRow {
  return {
    projectId: 'x',
    projectLabel: 'x',
    branch,
    cost,
    calls: sessions * 10,
    sessions,
    tokens: { ...NO_TOKENS },
    firstActive: '2026-09-01T00:00:00.000Z',
    lastActive: '2026-09-02T00:00:00.000Z',
    worktrees: [],
    sessionRows: [],
  }
}

function project(id: string, originKey: string | null, branches: BranchSpendRow[]): BranchSpendProjectReport {
  return {
    id,
    label: id.split('/').pop()!,
    originKey,
    totalCost: branches.reduce((sum, b) => sum + b.cost, 0),
    branches,
    coverage: {
      branchKnownCost: branches.reduce((sum, b) => sum + b.cost, 0),
      branchUnknownCost: 0,
      noBranchDataCost: 0,
      noBranchDataSessions: 0,
      noBranchDataProviders: [],
      distinctSessions: branches.reduce((sum, b) => sum + b.sessions, 0),
    },
  }
}

describe('groupProjects', () => {
  it('folds every checkout of one origin into a single entry with a checkout count', () => {
    const groups = groupProjects([
      project('/Users/me/Projects/codeburn', 'github.com/org/codeburn', [row('main', 6)]),
      project('/private/tmp/wt-a/clone', 'github.com/org/codeburn', [row('main', 3)]),
      project('/private/tmp/wt-b/clone', 'github.com/org/codeburn', [row('fix/x', 1)]),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('codeburn')
    expect(groups[0].note).toBe('3 checkouts')
    expect(groups[0].paths).toHaveLength(3)
  })

  it('sums a branch worked on in several checkouts into one row', () => {
    const groups = groupProjects([
      project('/a/repo', 'github.com/org/repo', [row('main', 6, 2)]),
      project('/b/repo', 'github.com/org/repo', [row('main', 3, 1), row(null, 1, 1)]),
    ])
    const main = groups[0].branches.find(b => b.branch === 'main')!
    expect(main.cost).toBe(9)
    expect(main.sessions).toBe(3)
    // The Unknown row still sinks below the named branches.
    expect(groups[0].branches.at(-1)!.branch).toBeNull()
    expect(groups[0].branches.reduce((sum, b) => sum + b.cost, 0)).toBe(10)
    expect(groups[0].coverage.distinctSessions).toBe(4)
  })

  it('treats an exact temp root as temporary, not only paths under it', () => {
    const groups = groupProjects([
      project('/private/tmp', null, [row('main', 2)]),
      project('/tmp', null, [row('main', 1)]),
      project('/Users/me/Projects/real', null, [row('main', 5)]),
    ])
    expect(groups.map(g => g.id)).toEqual(['Projects/real', '__temporary__'])
    expect(groups.at(-1)!.note).toBe('2 projects')
  })

  it('marks a repo whose checkouts all live in a temp dir', () => {
    const groups = groupProjects([
      project('/private/tmp/bench-1/thing', 'github.com/org/thing', [row('main', 2)]),
      project('/tmp/bench-2/thing', 'github.com/org/thing', [row('main', 1)]),
    ])
    expect(groups[0].note).toBe('2 checkouts · temporary')
  })

  it('keeps checkouts without an origin apart, under their own path', () => {
    const groups = groupProjects([
      project('/a/scratch', null, [row('main', 2)]),
      project('/b/scratch', null, [row('main', 1)]),
    ])
    expect(groups.map(g => g.id)).toEqual(['a/scratch', 'b/scratch'])
    expect(groups.map(g => g.label)).toEqual(['a/scratch', 'b/scratch'])
    expect(groups.every(g => g.note === '')).toBe(true)
  })

  it('leaves out identities that are session titles rather than directories', () => {
    const groups = groupProjects([
      project('/Users/me/Projects/real', null, [row('main', 1)]),
      project('Search for Postgres MCP servers', null, [row('main', 9)]),
      project('codeburn-teams', null, [row('main', 4)]),
    ])
    expect(groups.map(g => g.label)).toEqual(['Projects/real'])
  })

  it('collects throwaway checkouts with no origin into one bucket at the bottom', () => {
    const groups = groupProjects([
      project('/private/tmp/run-1/lab', null, [row('main', 9)]),
      project('/Users/me/.claude/worktrees/agent-ab18ca3a19232d748', null, [row('main', 4)]),
      project('/Users/me/Projects/real', null, [row('main', 1)]),
    ])
    expect(groups.map(g => g.id)).toEqual(['Projects/real', '__temporary__'])
    expect(groups[0].label).toBe('Projects/real')
    expect(groups.at(-1)!.label).toBe('Temporary checkouts')
    expect(groups.at(-1)!.note).toBe('2 projects')
  })

  it('leaves out projects with no branch row in the range', () => {
    const groups = groupProjects([
      project('/Users/me/Projects/real', null, [row('main', 1)]),
      project('/Users/me/Projects/bots', null, []),
    ])
    expect(groups.map(g => g.label)).toEqual(['Projects/real'])
  })
})
