import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

function runCli(args: string[], home: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CODEBURN_CACHE_DIR: join(home, '.cache', 'codeburn'),
      HOME: home, USERPROFILE: home,
      TZ: 'UTC',
    },
    encoding: 'utf-8',
  })
}

function userLine(sessionId: string, timestamp: string): string {
  return JSON.stringify({
    type: 'user',
    sessionId,
    timestamp,
    message: { role: 'user', content: 'add feature' },
  })
}

function assistantLine(sessionId: string, timestamp: string, messageId: string, inputTokens: number): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    timestamp,
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: inputTokens, output_tokens: 100 },
    },
  })
}

// Two sessions on two consecutive local days (UTC runner): 'a-side' on
// 2026-04-16, 'b-side' on 2026-04-17. Session 'straddle' has one call on
// EACH day, proving the drill-down joins its two sliced halves.
async function writeFixture(home: string): Promise<void> {
  const projectDir = join(home, '.claude', 'projects', 'work')
  await mkdir(projectDir, { recursive: true })
  await writeFile(
    join(projectDir, 'a-side.jsonl'),
    [
      userLine('a-side', '2026-04-16T10:00:00Z'),
      assistantLine('a-side', '2026-04-16T10:01:00Z', 'msg-a', 1000),
    ].join('\n'),
  )
  await writeFile(
    join(projectDir, 'b-side.jsonl'),
    [
      userLine('b-side', '2026-04-17T10:00:00Z'),
      assistantLine('b-side', '2026-04-17T10:01:00Z', 'msg-b', 3000),
    ].join('\n'),
  )
  await writeFile(
    join(projectDir, 'straddle.jsonl'),
    [
      userLine('straddle', '2026-04-16T20:00:00Z'),
      assistantLine('straddle', '2026-04-16T20:01:00Z', 'msg-s1', 1000),
      userLine('straddle', '2026-04-17T09:00:00Z'),
      assistantLine('straddle', '2026-04-17T09:01:00Z', 'msg-s2', 2000),
    ].join('\n'),
  )
}

const ARGS_A = ['--from-a', '2026-04-16', '--to-a', '2026-04-16', '--from-b', '2026-04-17', '--to-b', '2026-04-17']

describe('codeburn compare-periods (CLI)', () => {
  it('reports the B − A difference with reconciling lenses on a real fixture', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-cli-periods-'))
    try {
      await writeFixture(home)
      const run = runCli(['compare-periods', '--format', 'json', ...ARGS_A], home)
      expect(run.status).toBe(0)
      const report = JSON.parse(run.stdout)

      expect(report.schema).toBe(1)
      expect(report.rangeA).toMatchObject({ from: '2026-04-16', to: '2026-04-16', days: 1 })
      expect(report.rangeB).toMatchObject({ from: '2026-04-17', to: '2026-04-17', days: 1 })

      const totalA = report.totals.A.cost
      const totalB = report.totals.B.cost
      expect(totalA).toBeGreaterThan(0)
      expect(totalB).toBeGreaterThan(totalA)
      expect(report.totals.diff.cost).toBeCloseTo(totalB - totalA, 10)

      const lensSum = (rows: Array<{ diff: number }>) => rows.reduce((s, r) => s + r.diff, 0)
      expect(report.projects).toHaveLength(1)
      expect(report.projects[0].key.endsWith('work') || report.projects[0].key.includes('work')).toBe(true)
      expect(lensSum(report.projects)).toBeCloseTo(report.totals.diff.cost, 10)
      expect(lensSum(report.models)).toBeCloseTo(report.totals.diff.cost, 10)

      // The boundary-straddling session must be visible in the drill-down
      // with a cost on BOTH sides, joined into one canonical row.
      const drill = runCli(
        ['compare-periods', '--format', 'sessions', '--dimension', 'project', '--key', report.projects[0].key, ...ARGS_A],
        home,
      )
      expect(drill.status).toBe(0)
      const sessions = JSON.parse(drill.stdout)
      const straddle = sessions.sessions.find((s: { sessionId: string }) => s.sessionId === 'straddle')
      expect(straddle).toBeDefined()
      expect(straddle.costA).toBeGreaterThan(0)
      expect(straddle.costB).toBeGreaterThan(0)
      // Same-session drill rows must not duplicate the straddler.
      expect(sessions.sessions.filter((s: { sessionId: string }) => s.sessionId === 'straddle')).toHaveLength(1)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('defaults to the last seven complete days vs the seven before', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-cli-periods-default-'))
    try {
      await writeFixture(home)
      const run = runCli(['compare-periods', '--format', 'json'], home)
      expect(run.status).toBe(0)
      const report = JSON.parse(run.stdout)
      expect(report.rangeB.days).toBe(7)
      expect(report.rangeA.days).toBe(7)
      // Today (Apr 18 in the fixture's world, but really the runner's today)
      // must not be inside either range: both are complete days only.
      const today = new Date()
      const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      expect(report.rangeB.to).not.toBe(todayKey)
      expect(report.rangeB.to < todayKey).toBe(true)
      expect(report.rangeA.to < report.rangeB.from).toBe(true)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('rejects partial explicit ranges loudly', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-cli-periods-bad-'))
    try {
      await writeFixture(home)
      const run = runCli(['compare-periods', '--from-a', '2026-04-16'], home)
      expect(run.status).not.toBe(0)
      expect(run.stderr).toContain('must be provided together')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('rejects an impossible date instead of rolling it forward', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-cli-periods-bad2-'))
    try {
      await writeFixture(home)
      const run = runCli(['compare-periods', '--from-a', '2026-02-31', '--to-a', '2026-03-05', '--from-b', '2026-04-16', '--to-b', '2026-04-17'], home)
      expect(run.status).not.toBe(0)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
