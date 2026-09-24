import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { clearSessionCache, sessionMemoPublicationCount } from '../src/parser.js'
import { buildDurablePeriod } from '../src/usage-aggregator.js'
import { getPlanUsages } from '../src/plan-usage.js'
import { savePlan } from '../src/config.js'
import { getDateRange } from '../src/cli-date.js'
import { setHome } from './setup/home.js'

// `sessionMemoPublicationCount` ticks once per parse that actually ran the
// pipeline; a memo, burst or single-pass hit never publishes. Counting it is
// what makes this a parse-count assertion rather than a timing one.
const realParses = async (fn: () => Promise<unknown>): Promise<number> => {
  const before = sessionMemoPublicationCount()
  await fn()
  return sessionMemoPublicationCount() - before
}

const CWD = '/tmp/parse-count-proj'
let tmpDir: string

const at = (h: number, m: number): string => {
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d.toISOString()
}
const userLine = (ts: string) => JSON.stringify({
  type: 'user', sessionId: 'sess-1', timestamp: ts, cwd: CWD,
  message: { role: 'user', content: 'task' },
})
const asstLine = (id: string, ts: string) => JSON.stringify({
  type: 'assistant', sessionId: 'sess-1', timestamp: ts, cwd: CWD,
  message: { id, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: 100, output_tokens: 50 } },
})

beforeEach(async () => {
  clearSessionCache()
  tmpDir = await mkdtemp(join(tmpdir(), 'parse-count-'))
  const projectDir = join(tmpDir, 'projects', 'parse-count-proj')
  await mkdir(projectDir, { recursive: true })
  await writeFile(join(projectDir, 'sess-1.jsonl'), [
    userLine(at(9, 0)), asstLine('msg-a', at(9, 1)),
    userLine(at(11, 0)), asstLine('msg-b', at(11, 1)),
  ].join('\n') + '\n')
  setHome(tmpDir)
  process.env['CLAUDE_CONFIG_DIR'] = tmpDir
  process.env['CODEBURN_CACHE_DIR'] = join(tmpDir, 'cache')
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(tmpDir, 'desktop-sessions')
})

afterEach(async () => {
  clearSessionCache()
  setHome(undefined)
  delete process.env['CLAUDE_CONFIG_DIR']
  delete process.env['CODEBURN_CACHE_DIR']
  delete process.env['CODEBURN_DESKTOP_SESSIONS_DIR']
  await rm(tmpDir, { recursive: true, force: true })
})

// A cold run additionally hydrates the durable daily cache off a lifetime
// parse. Every count below is the steady state a user actually runs in.
const warmCaches = async (): Promise<void> => {
  const { range, label } = getDateRange('today')
  await buildDurablePeriod({ range, label }, { provider: 'all' })
}

describe('parses per command', () => {
  it('report --period today --format json runs one parse for the period and one for the plan window', async () => {
    await savePlan({ id: 'claude-max', monthlyUsd: 200, provider: 'claude', resetDay: 1, setAt: new Date().toISOString() })
    await warmCaches()

    const { range, label } = getDateRange('today')
    const periodParses = await realParses(() => buildDurablePeriod({ range, label }, { provider: 'all' }))
    expect(periodParses).toBe(1)

    // The plan window starts on the reset day, so it is a wider range than the
    // period and cannot be served from the period's parse. One parse, not two.
    const planParses = await realParses(() => getPlanUsages())
    expect(planParses).toBe(1)
  })

  it('report --period today --format json runs no parse at all without a plan', async () => {
    await warmCaches()
    expect(await realParses(() => getPlanUsages())).toBe(0)
  })

  it('a resident poll of the same period parses nothing more', async () => {
    // What `serve --stdio` sets for itself: inside the burst window a poll
    // whose range end moved by less than it reuses the previous parse.
    process.env['CODEBURN_PARSE_BURST_MS'] = '10000'
    try {
      await warmCaches()
      // Re-anchored on a fresh clock the way the next poll would be: the burst
      // has to absorb it, or a resident process re-parses on every tick.
      const again = getDateRange('today')
      expect(await realParses(() => buildDurablePeriod({ range: again.range, label: again.label }, { provider: 'all' }))).toBe(0)
    } finally {
      delete process.env['CODEBURN_PARSE_BURST_MS']
    }
  })
})
