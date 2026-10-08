import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadDailyCache, projectDayIdentity, type DailyEntry } from '../src/daily-cache.js'
import { aggregateProjectsIntoDays } from '../src/day-aggregator.js'
import { __resetGitOriginCache, __setTempRoots, folderNameOriginKey, projectOriginKey, saveGitOrigins } from '../src/git-origin.js'
import { filterProjectsByName, makeProjectFilter, setExactProjectPaths } from '../src/parser.js'
import { spendProjectIdentity } from '../src/spend-flow.js'
import type { ProjectSummary, SessionSummary } from '../src/types.js'
import { buildPayloadProjects } from '../src/usage-aggregator.js'
import { renderOverview } from '../src/overview.js'

let root: string
// Checkout ids are spend identities: on Windows, lower-cased with forward slashes.
const id = (path: string) => spendProjectIdentity({ project: '', projectPath: path }).id
const savedCacheDir = process.env['CODEBURN_CACHE_DIR']

function repo(dir: string, origin: string): string {
  mkdirSync(join(dir, '.git'), { recursive: true })
  writeFileSync(join(dir, '.git', 'config'), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${origin}\n`)
  return dir
}

function worktree(main: string, dir: string): string {
  const admin = join(main, '.git', 'worktrees', 'wt')
  mkdirSync(admin, { recursive: true })
  writeFileSync(join(admin, 'commondir'), '../..\n')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.git'), `gitdir: ${admin}\n`)
  return dir
}

function session(id: string, project: string, cost: number): SessionSummary {
  return {
    sessionId: id,
    project,
    firstTimestamp: '2026-09-07T12:00:00.000Z',
    lastTimestamp: '2026-09-07T12:01:00.000Z',
    totalCostUSD: cost,
    totalSavingsUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalReasoningTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: 1,
    turns: [],
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {},
    skillBreakdown: {},
    subagentBreakdown: {},
  } as SessionSummary
}

function live(projectPath: string, cost: number): ProjectSummary {
  const name = projectPath.split('/').pop()!
  return {
    project: name,
    projectPath,
    sessions: [session(`s-${name}`, name, cost)],
    totalCostUSD: cost,
    totalSavingsUSD: 0,
    totalApiCalls: 1,
    totalProxiedCostUSD: 0,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'repo-grouping-'))
  process.env['CODEBURN_CACHE_DIR'] = join(root, 'cache')
  mkdirSync(join(root, 'cache'))
  __resetGitOriginCache()
  setExactProjectPaths(false)
  // The fixtures live under the OS temp dir; only root/tmp counts as temporary here.
  __setTempRoots([join(root, 'tmp')])
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  if (savedCacheDir === undefined) delete process.env['CODEBURN_CACHE_DIR']
  else process.env['CODEBURN_CACHE_DIR'] = savedCacheDir
  __resetGitOriginCache()
  setExactProjectPaths(false)
  __setTempRoots(null)
})

function fixtures() {
  const a1 = repo(join(root, 'work', 'codeburn'), 'git@github.com:getagentseal/codeburn.git')
  const a2 = repo(join(root, 'scratch', 'clone-7'), 'https://github.com/getagentseal/codeburn')
  const awt = worktree(a1, join(root, 'scratch', 'review-wt'))
  const other = repo(join(root, 'work', 'codeburn-app'), 'git@github.com:getagentseal/codeburn-app.git')
  const plain = join(root, 'work', 'codeburn-marketing')
  mkdirSync(plain, { recursive: true })
  return { a1, a2, awt, other, plain }
}

describe('projects grouped by git repository', () => {
  it('folds two clones and a worktree into one row and keeps everything else apart', () => {
    const { a1, a2, awt, other, plain } = fixtures()
    const rows = buildPayloadProjects([live(a1, 5), live(a2, 3), live(awt, 2), live(other, 4), live(plain, 1)], null, homedir())

    expect(rows.map(r => [r.name, r.cost])).toEqual([['codeburn', 10], ['codeburn-app', 4], ['codeburn-marketing', 1]])
    const group = rows[0]!
    expect(group.path).toBe(a1)
    expect(group.sessions).toBe(3)
    expect(group.checkouts?.map(c => c.id).sort()).toEqual([a1, a2, awt].map(id).sort())
    expect(rows[1]!.checkouts).toBeUndefined()
    expect(rows[2]!.path).toBe(plain)
    // Folding never moves money.
    expect(rows.reduce((s, r) => s + r.cost, 0)).toBe(15)
  })

  it('keeps a deleted clone in its repository', () => {
    const { a1, a2 } = fixtures()
    const days = aggregateProjectsIntoDays([live(a2, 3)])
    expect(Object.values(days[0]!.projects!)[0]!.originKey).toBe('github.com/getagentseal/codeburn')
    saveGitOrigins()

    __resetGitOriginCache()
    rmSync(a2, { recursive: true, force: true })
    expect(projectOriginKey(a2)).toBe('github.com/getagentseal/codeburn')

    // The day entry carries the origin itself, so losing the record changes nothing.
    unlinkSync(join(root, 'cache', 'git-origins.json'))
    __resetGitOriginCache()
    expect(projectOriginKey(a2)).toBeNull()
    const cached: DailyEntry = days[0]!
    // Fixture sessions have no turns, so give the day its spend by hand.
    Object.values(cached.projects!)[0]!.cost = 3
    const rows = buildPayloadProjects([live(a1, 5)], [cached], homedir())
    expect(rows.map(r => [r.name, r.cost])).toEqual([['codeburn', 8]])

    const [key, stats] = Object.entries(cached.projects!)[0]!
    expect(makeProjectFilter([a1])(projectDayIdentity(key, stats))).toBe(true)
  })

  it('scopes a path inside one clone to the whole repository', () => {
    const { a1, a2, awt, other, plain } = fixtures()
    mkdirSync(join(a2, 'src'))
    const projects = [live(a1, 5), live(a2, 3), live(awt, 2), live(other, 4), live(plain, 1)]

    expect(filterProjectsByName(projects, [join(a2, 'src')]).map(p => p.projectPath).sort()).toEqual([a1, a2, awt].sort())
    expect(filterProjectsByName(projects, [], [`=${a1}`]).map(p => p.projectPath).sort()).toEqual([other, plain].sort())
    expect(filterProjectsByName(projects, [plain]).map(p => p.projectPath)).toEqual([plain])

    setExactProjectPaths(true)
    expect(filterProjectsByName(projects, [a2]).map(p => p.projectPath)).toEqual([a2])
  })

  it('excludes one checkout by its path without hiding the rest of the repository', () => {
    const { a1, a2, awt, other } = fixtures()
    const projects = [live(a1, 5), live(a2, 3), live(awt, 2), live(other, 4)]
    expect(filterProjectsByName(projects, [], [a2]).map(p => p.projectPath).sort()).toEqual([a1, awt, other].sort())
    expect(filterProjectsByName(projects, [a1], [a2]).map(p => p.projectPath).sort()).toEqual([a1, awt].sort())
  })

  it('takes the subfolders of a repository path whose origin they never recorded', () => {
    const { a1, other } = fixtures()
    const gone = join(a1, 'packages', 'deleted')
    const projects = [live(a1, 5), live(gone, 1), live(other, 4)]
    expect(filterProjectsByName(projects, [a1]).map(p => p.projectPath).sort()).toEqual([a1, gone].sort())
    expect(makeProjectFilter([a1])({ project: 'deleted', projectPath: gone })).toBe(true)
  })

  it('counts a session with slices in two checkouts once on the repository row', () => {
    const { a1, a2, awt } = fixtures()
    const slice = (projectPath: string, cost: number, primary: boolean): ProjectSummary => {
      const p = live(projectPath, cost)
      p.sessions[0]!.sessionId = 'moved'
      p.sessions[0]!.projectSplit = { primaryProject: 'codeburn', primaryProjectPath: a1, primary }
      return p
    }
    const rows = buildPayloadProjects([slice(a1, 5, true), slice(a2, 3, false), live(awt, 1)], null, homedir())
    expect(rows.find(r => r.name === 'codeburn')!.sessions).toBe(2)
  })

  it('takes one list row for a "=" path: the repository, or the folder without its sub-folders', () => {
    const { a1, a2, awt, plain } = fixtures()
    mkdirSync(join(plain, 'site'))
    const projects = [live(a1, 5), live(a2, 3), live(awt, 2), live(plain, 1), live(join(plain, 'site'), 1)]

    expect(filterProjectsByName(projects, [`=${a2}`]).map(p => p.projectPath).sort()).toEqual([a1, a2, awt].sort())
    expect(filterProjectsByName(projects, [`=${plain}`]).map(p => p.projectPath)).toEqual([plain])
    expect(filterProjectsByName(projects, [plain]).map(p => p.projectPath)).toEqual([plain, join(plain, 'site')])
  })

  it('collapses temp-root folders outside a repository into one row, and scopes to all of them', () => {
    const { a1, plain } = fixtures()
    const tmpClone = repo(join(root, 'tmp', 'agent-1', 'codeburn'), 'git@github.com:getagentseal/codeburn.git')
    const s1 = join(root, 'tmp', 'agent-2', 'scratch')
    const s2 = join(root, 'tmp', 'agent-3')
    mkdirSync(s1, { recursive: true })
    const gone = join(root, 'tmp', 'agent-4')
    const projects = [live(a1, 5), live(tmpClone, 1), live(s1, 2), live(s2, 3), live(gone, 0.5), live(plain, 1)]

    const rows = buildPayloadProjects(projects, null, homedir())
    expect(rows.map(r => [r.name, r.cost, r.path])).toEqual([['codeburn', 6, a1], ['Temporary folders', 5.5, '@temp'], ['codeburn-marketing', 1, plain]])
    expect(rows[1]!.temporary).toBe(true)
    expect(rows[1]!.checkoutCount).toBe(3)

    expect(filterProjectsByName(projects, ['=@temp']).map(p => p.projectPath).sort()).toEqual([s1, s2, gone].sort())
    expect(filterProjectsByName(projects, [], ['@temp']).map(p => p.projectPath).sort()).toEqual([a1, tmpClone, plain].sort())
  })

  it('stamps the repository on days adopted from an older cache while the folder exists', async () => {
    const { a2 } = fixtures()
    const day = { date: '2026-09-07', cost: 3, savingsUSD: 0, calls: 1, sessions: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, editTurns: 0, oneShotTurns: 0, models: {}, categories: {}, providers: {}, projects: { [`clone-7\u0000${a2}`]: { cost: 3, calls: 1, savingsUSD: 0, sessions: 1, path: a2 } } }
    writeFileSync(join(root, 'cache', 'daily-cache.v68.json'), JSON.stringify({ version: 68, savingsConfigHash: '', lastComputedDate: '2026-09-07', days: [day], complete: true }))

    const cache = await loadDailyCache()
    expect(Object.values(cache.days[0]!.projects!)[0]!.originKey).toBe('github.com/getagentseal/codeburn')
  })

  describe('deleted folders matched by folder name', () => {
    it('joins a deleted <checkout>-<suffix> or <checkout>_<suffix> sibling to that repository, flagged', () => {
      const { a1, other } = fixtures()
      const dash = join(root, 'work', 'codeburn-fix-123')
      const under = join(root, 'work', 'codeburn_old')
      const projects = [live(dash, 2), live(under, 1), live(a1, 5), live(other, 4)]
      for (const p of projects) projectOriginKey(p.projectPath)

      expect(folderNameOriginKey(dash)).toBe('github.com/getagentseal/codeburn')
      const rows = buildPayloadProjects(projects, null, homedir())
      expect(rows.map(r => [r.name, r.cost])).toEqual([['codeburn', 8], ['codeburn-app', 4]])
      const checkouts = rows[0]!.checkouts!
      expect(checkouts.find(c => c.id === id(a1))!.matchedByFolderName).toBeUndefined()
      expect(checkouts.filter(c => c.matchedByFolderName).map(c => c.id).sort()).toEqual([dash, under].map(id).sort())
      expect(filterProjectsByName(projects, [a1]).map(p => p.projectPath).sort()).toEqual([a1, dash, under].sort())
      expect(filterProjectsByName(projects, [], [a1]).map(p => p.projectPath).sort()).toEqual([dash, under, other].sort())

      const report = renderOverview(projects, { label: 'p', color: false })
      expect(report).toMatch(/codeburn \*/)
      expect(report).toContain('* includes deleted folders matched by folder name')
      expect(renderOverview([live(a1, 5), live(other, 4)], { label: 'p', color: false })).not.toContain('matched by folder name')
    })

    it('never applies to a folder that still exists', () => {
      const { a1 } = fixtures()
      const notes = join(root, 'work', 'codeburn-notes')
      mkdirSync(notes, { recursive: true })
      projectOriginKey(a1)

      expect(folderNameOriginKey(notes)).toBeNull()
      const rows = buildPayloadProjects([live(a1, 5), live(notes, 1)], null, homedir())
      expect(rows.map(r => [r.name, r.cost])).toEqual([['codeburn', 5], ['codeburn-notes', 1]])
    })

    it('picks the longest checkout name when several fit', () => {
      const { a1, other } = fixtures()
      const gone = join(root, 'work', 'codeburn-app-old')
      projectOriginKey(a1)
      projectOriginKey(other)

      expect(folderNameOriginKey(gone)).toBe('github.com/getagentseal/codeburn-app')
      const rows = buildPayloadProjects([live(a1, 5), live(other, 4), live(gone, 1)], null, homedir())
      expect(rows.map(r => [r.name, r.cost])).toEqual([['codeburn', 5], ['codeburn-app', 5]])
      expect(rows[1]!.checkouts!.find(c => c.id === id(gone))!.matchedByFolderName).toBe(true)
    })

    it('skips a name whose longest fits belong to two repositories', () => {
      const work = join(root, 'work')
      writeFileSync(join(root, 'cache', 'git-origins.json'), JSON.stringify({ version: 1, paths: {
        [join(work, 'shared')]: 'github.com/org/one',
        [`${join(work, 'shared')}/`]: 'github.com/org/two',
        [join(work, 'sha')]: 'github.com/org/three',
      } }))
      __resetGitOriginCache()

      expect(folderNameOriginKey(join(work, 'shared-copy'))).toBeNull()
    })

    it('leaves unrelated names alone', () => {
      const { a1 } = fixtures()
      projectOriginKey(a1)
      for (const name of [join(root, 'work', 'codeburnx'), join(root, 'work', 'my-codeburn'), join(root, 'work', 'codeburn-'), join(root, 'elsewhere', 'codeburn-fix')]) {
        expect(folderNameOriginKey(name)).toBeNull()
      }
    })
  })
})
