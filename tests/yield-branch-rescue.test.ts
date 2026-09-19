import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { ClassifiedTurn, ProjectSummary, SessionSummary } from '../src/types.js'
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

/** A real (non-empty) commit: writes `file`, commits at `date`. */
function realCommit(cwd: string, message: string, file: string, content: string, date: string): void {
  writeFileSync(join(cwd, file), content)
  git(cwd, ['add', '.'])
  git(cwd, ['commit', '-m', message], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  })
}

function makeSession(overrides: Partial<SessionSummary> & { branch?: string }): SessionSummary {
  const turns: ClassifiedTurn[] = overrides.branch
    ? [{ userMessage: 'work', assistantCalls: [], timestamp: '2026-01-01T10:10:00.000Z', sessionId: overrides.sessionId ?? 'session', category: 'other', retries: 0, hasEdits: true, gitBranch: overrides.branch }]
    : []
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
    turns,
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

function projectOf(sessions: SessionSummary[]): ProjectSummary[] {
  return [{
    project: 'app',
    projectPath: '',
    sessions,
    totalCostUSD: sessions.reduce((sum, s) => sum + s.totalCostUSD, 0),
  } as unknown as ProjectSummary]
}

const RANGE = {
  start: new Date('2026-01-01T00:00:00.000Z'),
  end: new Date('2026-01-02T00:00:00.000Z'),
}

async function categorize(repoDir: string, session: SessionSummary): Promise<string> {
  parseAllSessionsMock.mockResolvedValue(projectOf([session]))
  const summary = await computeYield(RANGE, repoDir)
  expect(summary.details).toHaveLength(1)
  return summary.details[0]!.category
}

describe('yield merged-branch rescue (issue #1442)', () => {
  let repoDir: string

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'codeburn-yield-rescue-'))
    git(repoDir, ['init', '-b', 'main'])
    git(repoDir, ['config', 'user.email', 'test@example.com'])
    git(repoDir, ['config', 'user.name', 'Test'])
    // Base commit on main, before the session window.
    realCommit(repoDir, 'chore: base', 'base.txt', 'base\n', '2025-12-01T09:00:00Z')
    // Feature branch with real work committed INSIDE the session window.
    git(repoDir, ['switch', '-c', 'feature-x'])
    realCommit(repoDir, 'feat: session work', 'feature.txt', 'shipped work\n', '2026-01-01T10:30:00Z')
    // The session ran on the branch; commits exist in the window but (for the
    // squash case) their SHAs never reach main.
  })

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true })
  })

  it('rescues an abandoned session whose branch was merged into main after the window (squash merge)', async () => {
    // Squash-merge feature-x into main after the range: one new SHA on main
    // carrying the branch tip's exact tree.
    git(repoDir, ['switch', 'main'])
    git(repoDir, ['merge', '--squash', 'feature-x'], {
      GIT_AUTHOR_DATE: '2026-01-05T09:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-05T09:00:00Z',
    })
    git(repoDir, ['commit', '-m', 'feat: session work (#1)'], {
      GIT_AUTHOR_DATE: '2026-01-05T09:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-05T09:00:00Z',
    })

    // The window-attributed commit is on feature-x, whose SHA is not in main:
    // pre-rescue this session read abandoned.
    const category = await categorize(repoDir, makeSession({ sessionId: 'squash-session', branch: 'feature-x' }))
    expect(category).toBe('productive')
  })

  it('keeps an abandoned session abandoned when its branch never merged', async () => {
    git(repoDir, ['switch', '-c', 'feature-unmerged'])
    realCommit(repoDir, 'feat: never ships', 'unmerged.txt', 'wip\n', '2026-01-01T10:40:00Z')
    git(repoDir, ['switch', 'main'])

    const category = await categorize(repoDir, makeSession({ sessionId: 'unmerged-session', branch: 'feature-unmerged' }))
    expect(category).toBe('abandoned')
  })

  it('never rescues through the main branch itself', async () => {
    // A branch-less session that shipped nothing stays abandoned; a session
    // recorded on main must not be rescued just because main is merged into main.
    const category = await categorize(repoDir, makeSession({ sessionId: 'main-session', branch: 'main' }))
    expect(category).toBe('abandoned')
  })

  it('never rescues through a ref parked inside main history (review: the parked-ref trap)', async () => {
    // A branch cut from main and never advanced is an ancestor of main by
    // construction and its tip tree is an OLD main tree. It must not rescue:
    // on the reviewer's corpus, 567 of 600 first-draft rescues came from one
    // such ref ($6,705 of $6,970 mislabeled productive).
    git(repoDir, ['switch', '-c', 'feature-parked', 'main'])
    git(repoDir, ['switch', 'main'])

    const category = await categorize(repoDir, makeSession({ sessionId: 'parked-branch-session', branch: 'feature-parked' }))
    expect(category).toBe('abandoned')
  })

  it('rescues on a master-based repository (main-branch resolution path)', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'codeburn-yield-master-'))
    try {
      git(repo, ['init', '-b', 'master'])
      git(repo, ['config', 'user.email', 'test@example.com'])
      git(repo, ['config', 'user.name', 'Test'])
      realCommit(repo, 'chore: base', 'base.txt', 'base\n', '2025-12-01T09:00:00Z')
      git(repo, ['switch', '-c', 'feature-m'])
      realCommit(repo, 'feat: work', 'work.txt', 'work\n', '2026-01-01T10:30:00Z')
      git(repo, ['switch', 'master'])
      git(repo, ['merge', '--no-ff', 'feature-m', '-m', 'chore: merge'], {
        GIT_AUTHOR_DATE: '2026-01-05T09:00:00Z',
        GIT_COMMITTER_DATE: '2026-01-05T09:00:00Z',
      })

      const category = await categorize(repo, makeSession({ sessionId: 'master-session', branch: 'feature-m' }))
      expect(category).toBe('productive')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('does not rescue a session whose window contains none of the branch\'s commits (review: per-session contribution)', async () => {
    git(repoDir, ['merge', '--no-ff', 'feature-x', '-m', 'chore: merge feature-x'], {
      GIT_AUTHOR_DATE: '2026-01-06T09:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-06T09:00:00Z',
    })

    // The branch shipped (its tip tree is the merge commit's tree, which is on
    // main), but this session ran 15:00-16:00 while every branch commit was
    // made at 10:30: nothing ties the session to the work, so it stays
    // abandoned — riding a shipped branch is not contributing to it.
    const lateSession = makeSession({
      sessionId: 'late-session',
      branch: 'feature-x',
      firstTimestamp: '2026-01-01T15:00:00.000Z',
      lastTimestamp: '2026-01-01T16:00:00.000Z',
    })
    const category = await categorize(repoDir, lateSession)
    expect(category).toBe('abandoned')
  })

  it('rescues a true-merge session whose window overlaps the branch\'s own commits', async () => {
    // Same repository state: the 10:00-11:00 session overlapped the 10:30
    // branch commit, and the merge left the branch tip's tree on main, so the
    // squash rule's evidence (tip tree on main + own commits + window overlap)
    // holds for true merges too.
    const worker = makeSession({ sessionId: 'worker-session', branch: 'feature-x' })
    const category = await categorize(repoDir, worker)
    expect(category).toBe('productive')
  })

  it('examines every matching ref: a stale local copy cannot hide a merged remote-tracking ref (review)', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'codeburn-yield-candidates-'))
    try {
      git(repo, ['init', '-b', 'main'])
      git(repo, ['config', 'user.email', 'test@example.com'])
      git(repo, ['config', 'user.name', 'Test'])
      realCommit(repo, 'chore: base', 'base.txt', 'base\n', '2025-12-01T09:00:00Z')
      git(repo, ['switch', '-c', 'feature-r'])
      realCommit(repo, 'feat: real work', 'work.txt', 'real\n', '2026-01-01T10:30:00Z')
      // Simulate the remote-tracking ref holding the merged work...
      const tip = git(repo, ['rev-parse', 'HEAD'])
      git(repo, ['update-ref', `refs/remotes/origin/feature-r`, tip])
      // ...while the local ref is reset back to the branch point (stale copy).
      git(repo, ['reset', '--hard', 'main'])
      git(repo, ['switch', 'main'])
      // Squash-merge the work so only the tree signature survives.
      git(repo, ['merge', '--squash', 'origin/feature-r'], {
        GIT_AUTHOR_DATE: '2026-01-05T09:00:00Z',
        GIT_COMMITTER_DATE: '2026-01-05T09:00:00Z',
      })
      git(repo, ['commit', '-m', 'feat: real work (#2)'], {
        GIT_AUTHOR_DATE: '2026-01-05T09:00:00Z',
        GIT_COMMITTER_DATE: '2026-01-05T09:00:00Z',
      })

      const category = await categorize(repo, makeSession({ sessionId: 'r-session', branch: 'feature-r' }))
      expect(category).toBe('productive')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('leaves sessions without branch metadata untouched', async () => {
    // A window with no commits of its own and no recorded branch: no rescue
    // input exists, so abandoned stands however the repo evolved around it.
    const lateNoBranch = makeSession({
      sessionId: 'no-branch-session',
      firstTimestamp: '2026-01-01T15:00:00.000Z',
      lastTimestamp: '2026-01-01T16:00:00.000Z',
    })
    const category = await categorize(repoDir, lateNoBranch)
    expect(category).toBe('abandoned')
  })
})
