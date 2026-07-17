import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { ProjectSummary, SessionSummary } from '../src/types.js'
import { computeYield } from '../src/yield.js'

const { parseAllSessionsMock } = vi.hoisted(() => ({
  parseAllSessionsMock: vi.fn(),
}))

vi.mock('../src/parser.js', () => ({
  parseAllSessions: parseAllSessionsMock,
}))

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  }).trim()
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

describe('yield attribution for overlapping sessions (issue #641)', () => {
  let repoDir: string

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'codeburn-yield-overlap-'))
    git(repoDir, ['init', '-b', 'main'])
    git(repoDir, ['config', 'user.email', 'test@example.com'])
    git(repoDir, ['config', 'user.name', 'Test'])
    await writeFile(join(repoDir, 'file.txt'), 'hello\n')
    git(repoDir, ['add', '.'])
    // One commit on main at 10:30, inside both sessions' time windows.
    git(repoDir, ['commit', '-m', 'feat: shipped by session A'], {
      GIT_AUTHOR_DATE: '2026-01-01T10:30:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T10:30:00Z',
    })
  })

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true })
  })

  it('does not credit a session that made no commits with an overlapping session\'s commit', async () => {
    // Session A ran 10:15-10:45 and made the 10:30 commit.
    // Session B ran 10:00-11:00 in the same repo and shipped nothing.
    const sessionA = makeSession({
      sessionId: 'session-a',
      firstTimestamp: '2026-01-01T10:15:00.000Z',
      lastTimestamp: '2026-01-01T10:45:00.000Z',
      totalCostUSD: 5,
    })
    const sessionB = makeSession({
      sessionId: 'session-b',
      firstTimestamp: '2026-01-01T10:00:00.000Z',
      lastTimestamp: '2026-01-01T11:00:00.000Z',
      totalCostUSD: 3,
    })

    const project: Partial<ProjectSummary> = {
      project: 'app',
      projectPath: repoDir,
      // Keep the broader session first so attribution must use window span,
      // not project/session order.
      sessions: [sessionB, sessionA],
    }
    parseAllSessionsMock.mockResolvedValue([project as ProjectSummary])

    const summary = await computeYield(
      {
        start: new Date('2026-01-01T00:00:00.000Z'),
        end: new Date('2026-01-02T00:00:00.000Z'),
      },
      repoDir,
    )

    const detailB = summary.details.find(d => d.sessionId === 'session-b')
    expect(detailB).toBeDefined()

    // Session B shipped nothing: it must not land in the "productive" bucket
    // on the strength of session A's commit.
    expect(detailB!.category).toBe('ambiguous')
    expect(detailB!.category).not.toBe('productive')
    expect(detailB!.commitCount).toBe(0)

    // The single commit should be credited to exactly one session.
    const productiveSessions = summary.details.filter(d => d.category === 'productive')
    expect(productiveSessions.map(d => d.sessionId)).toEqual(['session-a'])
    expect(summary.ambiguous).toEqual({ cost: 3, sessions: 1 })
  })

  it('classifies a lone session with its commit as productive (single-session pin)', async () => {
    const session = makeSession({
      sessionId: 'solo',
      firstTimestamp: '2026-01-01T10:15:00.000Z',
      lastTimestamp: '2026-01-01T10:45:00.000Z',
      totalCostUSD: 2,
    })
    parseAllSessionsMock.mockResolvedValue([
      { project: 'app', projectPath: repoDir, sessions: [session] } as ProjectSummary,
    ])

    const summary = await computeYield(
      { start: new Date('2026-01-01T00:00:00.000Z'), end: new Date('2026-01-02T00:00:00.000Z') },
      repoDir,
    )

    expect(summary.details).toHaveLength(1)
    expect(summary.details[0]).toMatchObject({ sessionId: 'solo', category: 'productive', commitCount: 1 })
    expect(summary.productive).toEqual({ cost: 2, sessions: 1 })
    expect(summary.ambiguous).toEqual({ cost: 0, sessions: 0 })
  })

  it('breaks equal-window ties deterministically by sessionId, not array order', async () => {
    const windowFields = {
      firstTimestamp: '2026-01-01T10:15:00.000Z',
      lastTimestamp: '2026-01-01T10:45:00.000Z',
    }
    const first = makeSession({ sessionId: 'aaa-session', ...windowFields, totalCostUSD: 1 })
    const second = makeSession({ sessionId: 'zzz-session', ...windowFields, totalCostUSD: 1 })

    for (const order of [[first, second], [second, first]]) {
      parseAllSessionsMock.mockResolvedValue([
        { project: 'app', projectPath: repoDir, sessions: order } as ProjectSummary,
      ])
      const summary = await computeYield(
        { start: new Date('2026-01-01T00:00:00.000Z'), end: new Date('2026-01-02T00:00:00.000Z') },
        repoDir,
      )
      const productive = summary.details.filter(d => d.category === 'productive')
      expect(productive.map(d => d.sessionId)).toEqual(['aaa-session'])
      expect(summary.details.find(d => d.sessionId === 'zzz-session')!.category).toBe('ambiguous')
    }
  })

  it('holds the single-owner invariant across project entries sharing the cwd fallback', async () => {
    // Two project entries with no usable projectPath both resolve to the same
    // cwd and share one commit list; the commit must still be credited once.
    const sessionX = makeSession({
      sessionId: 'proj1-session',
      project: 'proj1',
      firstTimestamp: '2026-01-01T10:15:00.000Z',
      lastTimestamp: '2026-01-01T10:45:00.000Z',
      totalCostUSD: 1,
    })
    const sessionY = makeSession({
      sessionId: 'proj2-session',
      project: 'proj2',
      firstTimestamp: '2026-01-01T10:00:00.000Z',
      lastTimestamp: '2026-01-01T11:00:00.000Z',
      totalCostUSD: 1,
    })
    parseAllSessionsMock.mockResolvedValue([
      { project: 'proj1', projectPath: undefined, sessions: [sessionX] } as unknown as ProjectSummary,
      { project: 'proj2', projectPath: undefined, sessions: [sessionY] } as unknown as ProjectSummary,
    ])

    const summary = await computeYield(
      { start: new Date('2026-01-01T00:00:00.000Z'), end: new Date('2026-01-02T00:00:00.000Z') },
      repoDir,
    )

    const productive = summary.details.filter(d => d.category === 'productive')
    expect(productive.map(d => d.sessionId)).toEqual(['proj1-session'])
    expect(productive[0]!.commitCount).toBe(1)
    expect(summary.details.find(d => d.sessionId === 'proj2-session')!.category).toBe('ambiguous')
  })
})
