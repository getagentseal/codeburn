import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadPricing } from '../src/models.js'
import { parseAllSessions, clearSessionCache } from '../src/parser.js'
import { buildPeriodDiffReport, diffSessions } from '../src/period-diff.js'
import type { DateRange } from '../src/types.js'

// End-to-end proof that a session with activity on BOTH sides of the A/B
// boundary is attributed at the parser's real granularity (per call, issue
// #852), and that the period-diff engine joins the two halves into one row.

let base: string

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'codeburn-period-diff-'))
  process.env['CLAUDE_CONFIG_DIR'] = base
  await loadPricing()
})

afterEach(async () => {
  delete process.env['CLAUDE_CONFIG_DIR']
  clearSessionCache()
  await rm(base, { recursive: true, force: true })
})

function line(timestamp: string, messageId: string, inputTokens: number): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 'straddle',
    timestamp,
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: inputTokens, output_tokens: 100 },
    },
  })
}

// One session, two turns: local Apr 16 10:00 (side A) and Apr 17 10:00 (side B).
async function writeStraddlingSession(): Promise<void> {
  const projectDir = join(base, 'projects', 'work')
  await mkdir(projectDir, { recursive: true })
  const tsA = new Date(2026, 3, 16, 10, 0, 0).toISOString()
  const tsB = new Date(2026, 3, 17, 10, 0, 0).toISOString()
  await writeFile(
    join(projectDir, 'straddle.jsonl'),
    [line(tsA, 'msg-a', 1000), line(tsB, 'msg-b', 3000)].join('\n') + '\n',
    'utf-8',
  )
}

function dayRange(y: number, m: number, d: number): DateRange {
  return { start: new Date(y, m, d), end: new Date(y, m, d, 23, 59, 59, 999) }
}

describe('period diff over a real parse', () => {
  it('splits a boundary-straddling session by call and reconciles the diff', async () => {
    await writeStraddlingSession()
    const rangeA = dayRange(2026, 3, 16)
    const rangeB = dayRange(2026, 3, 17)

    const projectsA = await parseAllSessions(rangeA, 'all')
    const projectsB = await parseAllSessions(rangeB, 'all')

    // Each range holds the SAME session with only ITS calls (post-slice).
    const sessionA = projectsA[0]!.sessions[0]!
    const sessionB = projectsB[0]!.sessions[0]!
    expect(sessionA.sessionId).toBe('straddle')
    expect(sessionB.sessionId).toBe('straddle')
    const costA = sessionA.totalCostUSD
    const costB = sessionB.totalCostUSD
    expect(costA).toBeGreaterThan(0)
    expect(costB).toBeGreaterThan(costA) // Apr 17's call carries more input tokens.

    const report = buildPeriodDiffReport({
      provider: 'all',
      rangeA: { from: '2026-04-16', to: '2026-04-16' },
      rangeB: { from: '2026-04-17', to: '2026-04-17' },
      projectsA,
      projectsB,
    })
    // Same canonical project on both sides → one contribution row, diff = B − A.
    expect(report.projects).toHaveLength(1)
    expect(report.projects[0]!.costA).toBeCloseTo(costA, 10)
    expect(report.projects[0]!.costB).toBeCloseTo(costB, 10)
    expect(report.totals.diff.cost).toBeCloseTo(costB - costA, 10)
    expect(lensSum(report.projects)).toBeCloseTo(report.totals.diff.cost, 10)

    // Drill-down: ONE row for the straddling session, cost on both sides.
    const rows = diffSessions(projectsA, projectsB, 'project', projectsA[0]!.project)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.sessionId).toBe('straddle')
    expect(rows[0]!.costA).toBeCloseTo(costA, 10)
    expect(rows[0]!.costB).toBeCloseTo(costB, 10)
  })
})

function lensSum(rows: Array<{ diff: number }>): number {
  return rows.reduce((s, row) => s + row.diff, 0)
}
