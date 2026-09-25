import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

// End-to-end proof for the peak-hours split: two DSH DeepSeek sessions, one
// stamped in a peak window (Mon 2026-09-28 02:00 UTC) and one off-peak
// (same day 12:00 UTC). `codeburn models --format json` must report one
// deepseek-chat row whose peakUSD/offPeakUSD split the stored list-rate cost.
function runCli(args: string[], home: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      DSH_HOME: join(home, '.dsh'),
      HOME: home, USERPROFILE: home,
      TZ: 'UTC',
      CODEBURN_PRICING_SNAPSHOT_ONLY: '1',
    },
    encoding: 'utf-8',
    timeout: 60_000,
  })
}

function header(id: string, createdAt: number): string {
  return JSON.stringify({
    type: 'session',
    version: 0,
    id,
    createdAt,
    cwd: '/tmp/peak-proof',
    delegationDepth: 0,
  })
}

function reqHeader(model: string, time: number): string {
  return JSON.stringify({
    type: 'request/header',
    seq: 10,
    time,
    data: { header: { config: { provider: 'deepseek-official', model } } },
  })
}

function assistantMsg(turn: number, usage: Record<string, number>, time: number): string {
  return JSON.stringify({
    type: 'assistant/message',
    seq: 4,
    time,
    data: {
      turn,
      step: 0,
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      usage,
    },
  })
}

describe('CLI peak-hours split (DeepSeek)', () => {
  it('reports peakUSD/offPeakUSD on the deepseek-chat row', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-peak-cli-'))
    try {
      const usage = { inputTokens: 1_000_000, outputTokens: 100_000 }
      // Past Monday 2026-09-21: 02:00 UTC = peak, 12:00 UTC = off-peak.
      // Past dates because `models --period all` covers history, not the future.
      const peakMs = Date.parse('2026-09-21T02:00:00Z')
      const offPeakMs = Date.parse('2026-09-21T12:00:00Z')
      for (const [name, at] of [['peak', peakMs], ['offpeak', offPeakMs]] as const) {
        const dir = join(home, '.dsh', 'sessions', 'proj', name)
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, 'session.jsonl'), [
          header(`session-${name}`, at),
          reqHeader('deepseek-chat', at),
          assistantMsg(1, usage, at),
        ].join('\n') + '\n')
      }

      const result = runCli(['models', '--provider', 'dsh', '--format', 'json', '--period', 'all'], home)
      expect(result.status).toBe(0)
      const rows = JSON.parse(result.stdout) as Array<Record<string, unknown>>
      const chat = rows.find(r => String(r['model']).includes('deepseek-chat'))
      expect(chat).toBeDefined()
      // Snapshot list rate: input 2.8e-7, output 4.2e-7 per token.
      // One session = 1M in + 100k out = $0.28 + $0.042 = $0.322 list.
      expect(chat!['costUSD']).toBeCloseTo(0.644, 6)
      expect(chat!['peakUSD']).toBeCloseTo(0.322, 6)
      // Off-peak bills at 0.5x.
      expect(chat!['offPeakUSD']).toBeCloseTo(0.161, 6)
      expect(chat!['peakKind']).toBe('deepseek-usd')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
