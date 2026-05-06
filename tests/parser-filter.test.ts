import { describe, it, expect } from 'vitest'

import { filterProjectsByName } from '../src/parser.js'
import type { ProjectSummary } from '../src/types.js'

function makeProject(project: string, projectPath = project, account?: string, accountPath?: string): ProjectSummary {
  return {
    project,
    projectPath,
    ...(account ? { account } : {}),
    ...(accountPath ? { accountPath } : {}),
    sessions: [],
    totalCostUSD: 0,
    totalApiCalls: 0,
  }
}

describe('filterProjectsByName', () => {
  const projects = [
    makeProject('codeburn', '/Users/alice/codeburn'),
    makeProject('AgentSeal', '/Users/alice/projects/AgentSeal'),
    makeProject('dashboard', '/Users/alice/AgentSeal/dashboard'),
    makeProject('sandbox', '/tmp/sandbox'),
  ]

  it('returns all projects when no filters given', () => {
    expect(filterProjectsByName(projects)).toEqual(projects)
    expect(filterProjectsByName(projects, [], [])).toEqual(projects)
    expect(filterProjectsByName(projects, undefined, undefined)).toEqual(projects)
  })

  it('include matches project name (case-insensitive substring)', () => {
    const result = filterProjectsByName(projects, ['codeburn'])
    expect(result.map(p => p.project)).toEqual(['codeburn'])
  })

  it('include is case-insensitive', () => {
    const result = filterProjectsByName(projects, ['AGENTSEAL'])
    expect(result.map(p => p.project).sort()).toEqual(['AgentSeal', 'dashboard'])
  })

  it('include matches substring in path when name does not match', () => {
    const result = filterProjectsByName(projects, ['alice/projects'])
    expect(result.map(p => p.project)).toEqual(['AgentSeal'])
  })

  it('include can target a Claude account label', () => {
    const accountProjects = [
      makeProject('-Users-alice-app', '/Users/alice/app', 'work', '/Users/alice/.claude-work'),
      makeProject('-Users-alice-app', '/Users/alice/app', 'personal', '/Users/alice/.claude-personal'),
    ]
    const result = filterProjectsByName(accountProjects, ['work:/users/alice/app'])
    expect(result.map(p => p.account)).toEqual(['work'])
  })

  it('include can match a bare Claude account label', () => {
    const accountProjects = [
      makeProject('-Users-alice-app', '/Users/alice/app', 'work', '/Users/alice/.claude-work'),
      makeProject('-Users-alice-app', '/Users/alice/app', 'personal', '/Users/alice/.claude-personal'),
    ]
    const result = filterProjectsByName(accountProjects, ['work'])
    expect(result.map(p => p.account)).toEqual(['work'])
  })

  it('include uses OR semantics across patterns', () => {
    const result = filterProjectsByName(projects, ['codeburn', 'sandbox'])
    expect(result.map(p => p.project).sort()).toEqual(['codeburn', 'sandbox'])
  })

  it('exclude removes matching projects (AND-negation across patterns)', () => {
    const result = filterProjectsByName(projects, undefined, ['codeburn', 'sandbox'])
    expect(result.map(p => p.project).sort()).toEqual(['AgentSeal', 'dashboard'])
  })

  it('exclude matches path substring', () => {
    const result = filterProjectsByName(projects, undefined, ['/tmp'])
    expect(result.map(p => p.project)).not.toContain('sandbox')
  })

  it('exclude can target a Claude account label', () => {
    const accountProjects = [
      makeProject('-Users-alice-app', '/Users/alice/app', 'work', '/Users/alice/.claude-work'),
      makeProject('-Users-alice-app', '/Users/alice/app', 'personal', '/Users/alice/.claude-personal'),
    ]
    const result = filterProjectsByName(accountProjects, undefined, ['personal'])
    expect(result.map(p => p.account)).toEqual(['work'])
  })

  it('exclude is applied after include', () => {
    const result = filterProjectsByName(projects, ['AgentSeal'], ['dashboard'])
    expect(result.map(p => p.project)).toEqual(['AgentSeal'])
  })

  it('returns empty array when no project matches include', () => {
    expect(filterProjectsByName(projects, ['does-not-exist'])).toEqual([])
  })

  it('empty-string pattern matches every project', () => {
    const resultInclude = filterProjectsByName(projects, [''])
    expect(resultInclude).toHaveLength(projects.length)
    const resultExclude = filterProjectsByName(projects, undefined, [''])
    expect(resultExclude).toEqual([])
  })

  it('does not mutate the input array', () => {
    const input = [makeProject('a'), makeProject('b')]
    const snapshot = [...input]
    filterProjectsByName(input, ['a'], ['b'])
    expect(input).toEqual(snapshot)
  })
})
