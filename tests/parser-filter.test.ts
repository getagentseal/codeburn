import { homedir } from 'node:os'

import { describe, it, expect } from 'vitest'

import { filterProjectsByName } from '../src/parser.js'
import type { ProjectSummary } from '../src/types.js'

function makeProject(project: string, projectPath = project): ProjectSummary {
  return {
    project,
    projectPath,
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

  it('include uses OR semantics across patterns', () => {
    const result = filterProjectsByName(projects, ['codeburn', 'sandbox'])
    expect(result.map(p => p.project).sort()).toEqual(['codeburn', 'sandbox'])
  })

  it('exclude removes matching projects (AND-negation across patterns)', () => {
    const result = filterProjectsByName(projects, undefined, ['codeburn', 'sandbox'])
    expect(result.map(p => p.project).sort()).toEqual(['AgentSeal', 'dashboard'])
  })

  it('an absolute-path pattern does not swallow a sibling sharing its prefix', () => {
    const siblings = [
      makeProject('my-company', '/Users/alice/work/my-company'),
      makeProject('my-company-kit', '/Users/alice/work/my-company-kit'),
      makeProject('client', '/Users/alice/work/my-company/packages/client'),
    ]
    const result = filterProjectsByName(siblings, undefined, ['/Users/alice/work/my-company'])
    expect(result.map(p => p.project)).toEqual(['my-company-kit'])
  })

  it('anchors an absolute-path include the same way', () => {
    const siblings = [
      makeProject('my-company', '/Users/alice/work/my-company'),
      makeProject('my-company-kit', '/Users/alice/work/my-company-kit'),
    ]
    expect(filterProjectsByName(siblings, ['/Users/alice/work/my-company']).map(p => p.project)).toEqual(['my-company'])
  })

  it('keeps a plain word loose, so it still spans siblings and worktrees', () => {
    const siblings = [
      makeProject('my-company', '/Users/alice/work/my-company'),
      makeProject('my-company-kit', '/Users/alice/work/my-company-kit'),
      makeProject('other', '/Users/alice/work/other'),
    ]
    expect(filterProjectsByName(siblings, ['my-company']).map(p => p.project)).toEqual(['my-company', 'my-company-kit'])
  })

  it('is trailing-slash and backslash tolerant on an absolute pattern', () => {
    const win = [makeProject('app', 'C:\\Users\\alice\\app'), makeProject('app-two', 'C:\\Users\\alice\\app-two')]
    expect(filterProjectsByName(win, undefined, ['C:/Users/alice/app/']).map(p => p.project)).toEqual(['app-two'])
  })

  it('folds case on an identified Windows pattern and keeps POSIX case identity', () => {
    const posix = [makeProject('Vault', '/a/Vault'), makeProject('vault', '/a/vault')]
    expect(filterProjectsByName(posix, ['/a/Vault']).map(p => p.project)).toEqual(['Vault'])
    const win = [makeProject('vault', 'C:\\Work\\Vault')]
    expect(filterProjectsByName(win, ['c:/work/vault']).map(p => p.project)).toEqual(['vault'])
    const unc = [makeProject('vault', '\\\\Server\\Share\\Vault')]
    expect(filterProjectsByName(unc, ['//server/share']).map(p => p.project)).toEqual(['vault'])
  })

  it('anchors a POSIX pattern against a Codex-style stripped absolute path', () => {
    const codex = [makeProject('vault', 'root/vault'), makeProject('vault-ui', 'root/vault-ui')]
    expect(filterProjectsByName(codex, undefined, ['/root/vault']).map(p => p.project)).toEqual(['vault-ui'])
  })

  it('names no project for a rooted pattern that keys to nothing', () => {
    expect(filterProjectsByName(projects, ['/'])).toEqual([])
    expect(filterProjectsByName(projects, undefined, ['/'])).toEqual(projects)
    expect(filterProjectsByName(projects, undefined, ['//'])).toEqual(projects)
  })

  it('expands a leading ~ the shell did not, and anchors it', () => {
    const home = homedir().replace(/\\/g, '/')
    const mine = [makeProject('app', `${home}/work/app`), makeProject('app-kit', `${home}/work/app-kit`)]
    expect(filterProjectsByName(mine, ['~/work/app']).map(p => p.project)).toEqual(['app'])
    expect(filterProjectsByName(mine, undefined, ['~/work/app']).map(p => p.project)).toEqual(['app-kit'])
    expect(filterProjectsByName(mine, ['~/nowhere'])).toEqual([])
  })

  it('exclude matches path substring', () => {
    const result = filterProjectsByName(projects, undefined, ['/tmp'])
    expect(result.map(p => p.project)).not.toContain('sandbox')
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
