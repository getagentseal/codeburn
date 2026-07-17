import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { describe, expect, it, vi } from 'vitest'

import type { DateRange, ProjectSummary, SessionSummary, TokenUsage } from '../src/types.js'

const parserMock = vi.hoisted(() => ({
  parseAllSessions: vi.fn(),
}))

vi.mock('../src/parser.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/parser.js')>()),
  parseAllSessions: parserMock.parseAllSessions,
}))

const emptyTokens: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  webSearchRequests: 0,
}

function session(id: string, project: string, costs: Record<string, number>): SessionSummary {
  const modelBreakdown = Object.fromEntries(
    Object.entries(costs).map(([model, costUSD]) => [
      model,
      { calls: 1, costUSD, savingsUSD: 0, tokens: emptyTokens },
    ]),
  )
  return {
    sessionId: id,
    project,
    firstTimestamp: '2026-04-10T00:00:00.000Z',
    lastTimestamp: '2026-04-10T00:01:00.000Z',
    totalCostUSD: Object.values(costs).reduce((sum, cost) => sum + cost, 0),
    totalSavingsUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalReasoningTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: Object.keys(costs).length,
    turns: [],
    modelBreakdown,
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {},
    skillBreakdown: {},
    subagentBreakdown: {},
  } as SessionSummary
}

function project(name: string, sessions: SessionSummary[]): ProjectSummary {
  return {
    project: name,
    projectPath: `/tmp/${name}`,
    sessions,
    totalCostUSD: sessions.reduce((sum, s) => sum + s.totalCostUSD, 0),
    totalSavingsUSD: 0,
    totalApiCalls: sessions.reduce((sum, s) => sum + s.apiCalls, 0),
    totalProxiedCostUSD: 0,
  }
}

function sumLinksBy<T extends 'model' | 'project'>(
  links: Array<{ model: string; project: string; cost: number }>,
  key: T,
): Map<string, number> {
  const totals = new Map<string, number>()
  for (const link of links) totals.set(link[key], (totals.get(link[key]) ?? 0) + link.cost)
  return totals
}

function expectTotalsReconcile(nodes: Array<{ id: string; cost: number }>, totals: Map<string, number>): void {
  for (const node of nodes) expect(totals.get(node.id)).toBeCloseTo(node.cost, 10)
}

function runCli(args: string[], home: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CODEBURN_CACHE_DIR: join(home, '.cache', 'codeburn'),
      HOME: home,
      TZ: 'UTC',
    },
    encoding: 'utf-8',
    timeout: 30_000,
  })
}

function userLine(sessionId: string, timestamp: string): string {
  return JSON.stringify({
    type: 'user',
    sessionId,
    timestamp,
    message: { role: 'user', content: 'build feature' },
  })
}

function assistantLine(sessionId: string, timestamp: string, messageId: string, model: string): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    timestamp,
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 1000, output_tokens: 100 },
    },
  })
}

describe('computeSpendFlow', () => {
  it('builds model x project links whose totals reconcile', async () => {
    const { computeSpendFlow } = await import('../src/spend-flow.js')
    const range: DateRange = {
      start: new Date('2026-04-01T00:00:00.000Z'),
      end: new Date('2026-04-30T23:59:59.999Z'),
    }
    parserMock.parseAllSessions.mockResolvedValueOnce([
      project('alpha', [
        session('a1', 'alpha', { sonnet: 1, opus: 2 }),
        session('a2', 'alpha', { haiku: 3 }),
      ]),
      project('beta', [
        session('b1', 'beta', { sonnet: 4, opus: 5, haiku: 6 }),
      ]),
    ])

    const flow = await computeSpendFlow(range, 'claude')

    expect(parserMock.parseAllSessions).toHaveBeenCalledWith(range, 'claude')
    expect(flow.models).toEqual([
      { id: 'haiku', label: 'haiku', cost: 9 },
      { id: 'opus', label: 'opus', cost: 7 },
      { id: 'sonnet', label: 'sonnet', cost: 5 },
    ])
    expect(flow.projects).toEqual([
      { id: 'beta', label: 'beta', cost: 15 },
      { id: 'alpha', label: 'alpha', cost: 6 },
    ])
    expectTotalsReconcile(flow.models, sumLinksBy(flow.links, 'model'))
    expectTotalsReconcile(flow.projects, sumLinksBy(flow.links, 'project'))
    expect(flow.links.reduce((sum, link) => sum + link.cost, 0)).toBeCloseTo(21, 10)
  })

  it('rolls models and projects beyond the top 8 into other without losing cost', async () => {
    const { computeSpendFlow } = await import('../src/spend-flow.js')
    const range: DateRange = {
      start: new Date('2026-05-01T00:00:00.000Z'),
      end: new Date('2026-05-31T23:59:59.999Z'),
    }
    const projects = Array.from({ length: 10 }, (_, projectIndex) => {
      const costs = Object.fromEntries(
        Array.from({ length: 10 }, (_, modelIndex) => [
          `model-${modelIndex + 1}`,
          (10 - projectIndex) * (10 - modelIndex),
        ]),
      )
      return project(`project-${projectIndex + 1}`, [
        session(`s-${projectIndex + 1}`, `project-${projectIndex + 1}`, costs),
      ])
    })
    const expectedTotal = projects.reduce((sum, p) => sum + p.totalCostUSD, 0)
    parserMock.parseAllSessions.mockResolvedValueOnce(projects)

    const flow = await computeSpendFlow(range, 'all')

    expect(flow.models).toHaveLength(9)
    expect(flow.projects).toHaveLength(9)
    expect(flow.models.at(-1)).toMatchObject({ id: '__other__', label: 'Other' })
    expect(flow.projects.at(-1)).toMatchObject({ id: '__other__', label: 'Other' })
    expectTotalsReconcile(flow.models, sumLinksBy(flow.links, 'model'))
    expectTotalsReconcile(flow.projects, sumLinksBy(flow.links, 'project'))
    expect(flow.links.reduce((sum, link) => sum + link.cost, 0)).toBeCloseTo(expectedTotal, 10)
  })

  it('keeps real other nodes separate from the rollup bucket', async () => {
    const { computeSpendFlow } = await import('../src/spend-flow.js')
    const range: DateRange = {
      start: new Date('2026-06-01T00:00:00.000Z'),
      end: new Date('2026-06-30T23:59:59.999Z'),
    }
    parserMock.parseAllSessions.mockResolvedValueOnce([
      project('other', [session('s-other', 'other', { other: 1000 })]),
      ...Array.from({ length: 9 }, (_, index) => {
        const n = index + 1
        return project(`project-${n}`, [session(`s-${n}`, `project-${n}`, { [`model-${n}`]: 100 - n * 10 })])
      }),
    ])

    const flow = await computeSpendFlow(range, 'all')

    expect(flow.models).toContainEqual({ id: 'other', label: 'other', cost: 1000 })
    expect(flow.models).toContainEqual({ id: '__other__', label: 'Other', cost: 30 })
    expect(flow.projects).toContainEqual({ id: 'other', label: 'other', cost: 1000 })
    expect(flow.projects).toContainEqual({ id: '__other__', label: 'Other', cost: 30 })
    expect(flow.links).toContainEqual({ model: 'other', project: 'other', cost: 1000 })
    expect(flow.links).toContainEqual({ model: '__other__', project: '__other__', cost: 30 })
    expectTotalsReconcile(flow.models, sumLinksBy(flow.links, 'model'))
    expectTotalsReconcile(flow.projects, sumLinksBy(flow.links, 'project'))
  })

  it('labels the period with local calendar dates', async () => {
    const previousTz = process.env['TZ']
    process.env['TZ'] = 'America/Los_Angeles'
    try {
      const { computeSpendFlow } = await import('../src/spend-flow.js')
      const range: DateRange = {
        start: new Date(2026, 6, 10, 0, 0, 0, 0),
        end: new Date(2026, 6, 10, 23, 59, 59, 999),
      }
      parserMock.parseAllSessions.mockResolvedValueOnce([])

      const flow = await computeSpendFlow(range, 'all')

      expect(flow.period.label).toBe('2026-07-10 to 2026-07-10')
    } finally {
      if (previousTz === undefined) delete process.env['TZ']
      else process.env['TZ'] = previousTz
    }
  })
})

describe('codeburn spend --format flow-json', () => {
  it('prints a valid SpendFlow payload', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-spend-flow-cli-'))

    try {
      const projectDir = join(home, '.claude', 'projects', 'app')
      await mkdir(projectDir, { recursive: true })
      await writeFile(
        join(projectDir, 'session.jsonl'),
        [
          userLine('s1', '2026-04-10T09:00:00Z'),
          assistantLine('s1', '2026-04-10T09:01:00Z', 'msg-1', 'claude-sonnet-4-5'),
        ].join('\n'),
      )

      const result = runCli(['spend', '--format', 'flow-json', '--period', 'all', '--provider', 'claude'], home)

      expect(result.status, `stderr: ${result.stderr}`).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        period: { start: string; end: string }
        models: Array<{ id: string; label: string; cost: number }>
        projects: Array<{ id: string; label: string; cost: number }>
        links: Array<{ model: string; project: string; cost: number }>
      }
      expect(payload.period.start).toBeTruthy()
      expect(payload.period.end).toBeTruthy()
      expect(payload.models[0]?.id).toBeTruthy()
      expect(payload.projects[0]?.id).toBe('app')
      expect(payload.links[0]).toMatchObject({ model: payload.models[0]?.id, project: 'app' })
      expect(payload.links[0]?.cost).toBeGreaterThan(0)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('prints a friendly error for invalid custom date flags', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-spend-flow-date-error-'))

    try {
      const result = runCli(['spend', '--format', 'flow-json', '--from', 'April 7'], home)

      expect(result.status).not.toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('Error: Invalid date format "April 7": expected YYYY-MM-DD')
      expect(result.stderr).not.toContain('UsageQueryError')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
