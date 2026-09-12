import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { ProjectSummary, SessionSummary } from '../src/types.js'
import { computeYield } from '../src/yield.js'

const { parseAllSessionsMock } = vi.hoisted(() => ({
  parseAllSessionsMock: vi.fn(),
}))

vi.mock('../src/parser.js', () => ({
  parseAllSessions: parseAllSessionsMock,
  filterProjectsByName: (projects: unknown[]) => projects,
  unmatchedRootedPatterns: () => [],
  isInteractiveScanUI: () => false,
}))

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  }).trim()
}

function initRepo(dir: string): void {
  git(dir, ['init', '-b', 'main'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
}

function commitAt(dir: string, message: string, iso: string): void {
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', message], {
    GIT_AUTHOR_DATE: iso,
    GIT_COMMITTER_DATE: iso,
  })
}

function makeSession(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    sessionId: 'session',
    project: 'app',
    firstTimestamp: '2026-01-01T10:00:00.000Z',
    lastTimestamp: '2026-01-01T11:00:00.000Z',
    totalCostUSD: 1,
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
    categoryBreakdown: {} as SessionSummary['categoryBreakdown'],
    skillBreakdown: {},
    subagentBreakdown: {},
    ...overrides,
  }
}

const range = {
  start: new Date('2026-01-01T00:00:00.000Z'),
  end: new Date('2026-01-02T00:00:00.000Z'),
}

// Tighter window (span 1.5h): 10:15 -> 10:45 (+1h = 11:45). Wins any commit it shares.
const tightWindow = {
  firstTimestamp: '2026-01-01T10:15:00.000Z',
  lastTimestamp: '2026-01-01T10:45:00.000Z',
}
// Broader window (span 2h): 10:00 -> 11:00 (+1h = 12:00). Loses the shared commit.
const broadWindow = {
  firstTimestamp: '2026-01-01T10:00:00.000Z',
  lastTimestamp: '2026-01-01T11:00:00.000Z',
}

describe('yield repo grouping by canonical repository identity (issue #713)', () => {
  it('groups path casing variants on case-insensitive filesystems', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'codeburn-yield-path-case-'))
    try {
      initRepo(repoDir)
      await writeFile(join(repoDir, 'file.txt'), 'hello\n')
      commitAt(repoDir, 'feat: shipped once', '2026-01-01T10:30:00Z')

      const caseAlteredRepoDir = join(repoDir, '..', repoDir.split('/').pop()!.toUpperCase())
      if (!existsSync(caseAlteredRepoDir)) return

      const sessionOriginal = makeSession({ sessionId: 'case-original', project: 'app', ...tightWindow, totalCostUSD: 5 })
      const sessionAltered = makeSession({ sessionId: 'case-altered', project: 'app', ...broadWindow, totalCostUSD: 3 })

      parseAllSessionsMock.mockResolvedValue([
        { project: 'app', projectPath: repoDir, sessions: [sessionOriginal] } as ProjectSummary,
        { project: 'app', projectPath: caseAlteredRepoDir, sessions: [sessionAltered] } as ProjectSummary,
      ])

      const summary = await computeYield(range, repoDir)

      const productive = summary.details.filter(d => d.category === 'productive')
      expect(productive.map(d => d.sessionId)).toEqual(['case-original'])
      expect(productive[0]!.commitCount).toBe(1)

      const detailAltered = summary.details.find(d => d.sessionId === 'case-altered')!
      expect(detailAltered.category).toBe('ambiguous')
      expect(detailAltered.commitCount).toBe(0)
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  it('credits one commit once across two monorepo subdirectory sessions', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'codeburn-yield-monorepo-'))
    try {
      initRepo(repoDir)
      // Two package subdirectories of ONE repo. `git rev-parse --is-inside-work-tree`
      // is true in both, and `git log --all` returns the same repo-wide commit
      // list from either, so keying groups by the raw subdir path double-credits.
      await writeFile(join(repoDir, 'a.txt'), 'a\n')
      await writeFile(join(repoDir, 'b.txt'), 'b\n')
      commitAt(repoDir, 'feat: shipped once', '2026-01-01T10:30:00Z')

      const subA = join(repoDir, 'packages', 'a')
      const subB = join(repoDir, 'packages', 'b')
      await mkdir(subA, { recursive: true })
      await mkdir(subB, { recursive: true })

      const sessionA = makeSession({ sessionId: 'sub-a', project: 'pkg-a', ...tightWindow, totalCostUSD: 5 })
      const sessionB = makeSession({ sessionId: 'sub-b', project: 'pkg-b', ...broadWindow, totalCostUSD: 3 })

      parseAllSessionsMock.mockResolvedValue([
        { project: 'pkg-a', projectPath: subA, sessions: [sessionA] } as ProjectSummary,
        { project: 'pkg-b', projectPath: subB, sessions: [sessionB] } as ProjectSummary,
      ])

      const summary = await computeYield(range, repoDir)

      const productive = summary.details.filter(d => d.category === 'productive')
      expect(productive.map(d => d.sessionId)).toEqual(['sub-a'])
      expect(productive[0]!.commitCount).toBe(1)

      const detailB = summary.details.find(d => d.sessionId === 'sub-b')!
      expect(detailB.category).toBe('ambiguous')
      expect(detailB.commitCount).toBe(0)
      expect(summary.ambiguous).toEqual({ cost: 3, sessions: 1 })
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  it('credits one commit once across two worktrees of one repo', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'codeburn-yield-worktree-'))
    let wtDir = ''
    try {
      initRepo(repoDir)
      await writeFile(join(repoDir, 'file.txt'), 'hello\n')
      commitAt(repoDir, 'feat: shipped once', '2026-01-01T10:30:00Z')

      // Linked worktree on a different branch, sharing the same object store.
      wtDir = join(repoDir, '..', `${basename(repoDir)}-wt`)
      git(repoDir, ['worktree', 'add', wtDir, '-b', 'feature'])

      const sessionMain = makeSession({ sessionId: 'wt-main', project: 'app', ...tightWindow, totalCostUSD: 5 })
      const sessionLinked = makeSession({ sessionId: 'wt-linked', project: 'app', ...broadWindow, totalCostUSD: 3 })

      parseAllSessionsMock.mockResolvedValue([
        { project: 'app', projectPath: repoDir, sessions: [sessionMain] } as ProjectSummary,
        { project: 'app', projectPath: wtDir, sessions: [sessionLinked] } as ProjectSummary,
      ])

      const summary = await computeYield(range, repoDir)

      const productive = summary.details.filter(d => d.category === 'productive')
      expect(productive.map(d => d.sessionId)).toEqual(['wt-main'])
      expect(productive[0]!.commitCount).toBe(1)

      const detailLinked = summary.details.find(d => d.sessionId === 'wt-linked')!
      expect(detailLinked.category).toBe('ambiguous')
      expect(detailLinked.commitCount).toBe(0)
    } finally {
      if (wtDir) await rm(wtDir, { recursive: true, force: true })
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  it('keeps two genuinely separate repos as independent groups (no over-merge)', async () => {
    const repo1 = await mkdtemp(join(tmpdir(), 'codeburn-yield-sep1-'))
    const repo2 = await mkdtemp(join(tmpdir(), 'codeburn-yield-sep2-'))
    try {
      for (const [dir, name] of [[repo1, 'first'], [repo2, 'second']] as const) {
        initRepo(dir)
        await writeFile(join(dir, 'file.txt'), `${name}\n`)
        commitAt(dir, `feat: ${name}`, '2026-01-01T10:30:00Z')
      }

      // Identical overlapping windows: only correct because the repos are distinct.
      const session1 = makeSession({ sessionId: 'repo1-session', project: 'r1', ...broadWindow, totalCostUSD: 4 })
      const session2 = makeSession({ sessionId: 'repo2-session', project: 'r2', ...broadWindow, totalCostUSD: 4 })

      parseAllSessionsMock.mockResolvedValue([
        { project: 'r1', projectPath: repo1, sessions: [session1] } as ProjectSummary,
        { project: 'r2', projectPath: repo2, sessions: [session2] } as ProjectSummary,
      ])

      const summary = await computeYield(range, repo1)

      const productive = summary.details.filter(d => d.category === 'productive')
      expect(productive.map(d => d.sessionId).sort()).toEqual(['repo1-session', 'repo2-session'])
      expect(productive.every(d => d.commitCount === 1)).toBe(true)
      expect(summary.ambiguous).toEqual({ cost: 0, sessions: 0 })
    } finally {
      await rm(repo1, { recursive: true, force: true })
      await rm(repo2, { recursive: true, force: true })
    }
  })
})
