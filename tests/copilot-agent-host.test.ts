// VS Code's agent host (and Copilot CLI 1.0.8x) write assistant.message events
// with no outputTokens. The fixture is a real redacted session; its
// session.shutdown rollup is the ground truth.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import { copilot } from '../src/providers/copilot.js'
import { calculateCost } from '../src/models.js'
import { clearSessionCache, parseAllSessions } from '../src/parser.js'
import { clearLoadCacheMemo } from '../src/session-cache.js'
import { behavioralCallCount } from '../src/behavioral-weight.js'
import { copilotCreditSpend } from '../src/plan-usage.js'
import { isSqliteAvailable } from '../src/sqlite.js'
import type { ParsedProviderCall } from '../src/providers/types.js'

const SID = 'd700c59c-59d8-4928-bdd6-142587956874'
const FIXTURE = fileURLToPath(new URL('./fixtures/copilot/agent-host-session/events.jsonl', import.meta.url))

const TRUTH = { calls: 10, input: 76_541, output: 2_171, cacheRead: 169_728, cacheWrite: 0, reasoning: 576, nanoAiu: 2_772_045_000 }

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'copilot-agent-host-'))
  vi.stubEnv('CODEBURN_COPILOT_SESSION_STORE_DB', join(tmp, 'no-store.db'))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(tmp, { recursive: true, force: true })
})

async function fixtureLines(): Promise<string[]> {
  return (await readFile(FIXTURE, 'utf-8')).split('\n').filter(l => l.trim())
}

async function writeSession(lines: string[], sid = SID, cwd = '/home/dev/cb-verify/copilot-test'): Promise<string> {
  const dir = join(tmp, 'session-state', sid)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'workspace.yaml'), `id: ${sid}\ncwd: ${cwd}\n`)
  const path = join(dir, 'events.jsonl')
  await writeFile(path, lines.join('\n') + '\n')
  return path
}

async function parse(lines: string[]): Promise<ParsedProviderCall[]> {
  const path = await writeSession(lines)
  const calls: ParsedProviderCall[] = []
  for await (const c of copilot.createSessionParser({ path, project: 'copilot-test', provider: 'copilot' }, new Set()).parse()) calls.push(c)
  return calls
}

const sum = (calls: ParsedProviderCall[], k: keyof ParsedProviderCall) => calls.reduce((s, c) => s + (c[k] as number), 0)

describe('copilot VS Code agent-host sessions', () => {
  it('closed session: one call per request, rollup totals equal the ground truth', async () => {
    const calls = await parse(await fixtureLines())
    const perTurn = calls.filter(c => !c.deduplicationKey.includes(':shutdown:'))
    const rollup = calls.filter(c => c.deduplicationKey.includes(':shutdown:'))

    expect(perTurn).toHaveLength(TRUTH.calls)
    expect(perTurn.every(c => c.model === 'gpt-5-mini' && c.costUSD === 0 && c.outputTokens === 0)).toBe(true)
    expect(perTurn.some(c => c.costIsEstimated)).toBe(false)
    expect(perTurn.flatMap(c => c.tools)).toHaveLength(8)

    expect(rollup).toHaveLength(1)
    expect(sum(calls, 'inputTokens')).toBe(TRUTH.input)
    expect(sum(calls, 'outputTokens')).toBe(TRUTH.output)
    expect(sum(calls, 'cacheReadInputTokens')).toBe(TRUTH.cacheRead)
    expect(sum(calls, 'cacheCreationInputTokens')).toBe(TRUTH.cacheWrite)
    expect(sum(calls, 'reasoningTokens')).toBe(TRUTH.reasoning)
    expect(rollup[0]!.nanoAiu).toBe(TRUTH.nanoAiu)
    expect(sum(calls, 'costUSD')).toBeCloseTo(
      calculateCost('gpt-5-mini', TRUTH.input, TRUTH.output, 0, TRUTH.cacheRead, 0), 12)
  })

  it('open session: requests count as calls, no tokens or credits before shutdown', async () => {
    const lines = (await fixtureLines()).filter(l => JSON.parse(l).type !== 'session.shutdown')
    expect(lines.filter(l => JSON.parse(l).type === 'session.usage_checkpoint')).toHaveLength(2)

    const calls = await parse(lines)
    expect(calls).toHaveLength(TRUTH.calls)
    for (const k of ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'costUSD'] as const) expect(sum(calls, k)).toBe(0)
    expect(calls.some(c => c.nanoAiu !== undefined || c.costIsEstimated)).toBe(false)
  })

  // Synthetic: no real resumed-and-compacted session was available. Token
  // counters reset at compaction; totalNanoAiu keeps running like a bill.
  it('resumed + compacted session: token deltas restart, nanoAiu stays a running total', async () => {
    const ev = (type: string, timestamp: string, data: Record<string, unknown>) => JSON.stringify({ type, timestamp, data })
    const msg = (id: string, ts: string) => ev('assistant.message', ts, { messageId: id, model: 'claude-haiku-4.5', toolRequests: [] })
    const shutdown = (ts: string, input: number, output: number, nano: number) => ev('session.shutdown', ts, {
      shutdownType: 'routine',
      modelMetrics: { 'claude-haiku-4.5': { usage: { inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 }, totalNanoAiu: nano } },
    })
    const calls = await parse([
      ev('session.start', '2026-08-31T10:00:00Z', { selectedModel: 'claude-haiku-4.5' }),
      msg('m1', '2026-08-31T10:00:10Z'),
      shutdown('2026-08-31T10:01:00Z', 1_000, 100, 1_000_000_000),
      msg('m2', '2026-08-31T10:02:00Z'),
      ev('session.compaction_complete', '2026-08-31T10:03:00Z', { success: true }),
      msg('m3', '2026-08-31T10:04:00Z'),
      shutdown('2026-08-31T10:05:00Z', 300, 40, 1_500_000_000),
    ])
    const legs = calls.filter(c => c.deduplicationKey.includes(':shutdown:'))

    expect(calls.length - legs.length).toBe(3)
    expect(legs.map(c => [c.inputTokens, c.outputTokens, c.nanoAiu])).toEqual([[1_000, 100, 1_000_000_000], [300, 40, 500_000_000]])
  })

  it('older CLI with per-turn outputTokens: the rollup does not count output again', async () => {
    let n = 0
    const lines = (await fixtureLines()).map(l => {
      const e = JSON.parse(l)
      if (e.type !== 'assistant.message') return l
      e.data.outputTokens = n++ === 0 ? 217 + 1 : 217
      return JSON.stringify(e)
    })
    const calls = await parse(lines)
    const rollup = calls.find(c => c.deduplicationKey.includes(':shutdown:'))!

    expect(calls.filter(c => c !== rollup)).toHaveLength(TRUTH.calls)
    expect(rollup.outputTokens).toBe(0)
    expect(sum(calls, 'outputTokens')).toBe(TRUTH.output)
    expect(sum(calls, 'inputTokens')).toBe(TRUTH.input)
  })

  async function serve(lines: string[], sid = SID, cwd?: string) {
    await writeSession(lines, sid, cwd)
    vi.stubEnv('HOME', tmp)
    vi.stubEnv('USERPROFILE', tmp)
    vi.stubEnv('CODEBURN_CACHE_DIR', join(tmp, 'cache'))
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STATE_DIR', join(tmp, 'session-state'))
    vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '1')
    vi.stubEnv('CODEBURN_COPILOT_WS_STORAGE_DIR', join(tmp, 'no-ws'))
    vi.stubEnv('CODEBURN_COPILOT_GLOBAL_STORAGE_DIR', join(tmp, 'no-global'))
    vi.stubEnv('CODEBURN_COPILOT_JETBRAINS_DIR', join(tmp, 'no-jb'))
    clearSessionCache()
    clearLoadCacheMemo()
    try {
      const projects = await parseAllSessions(undefined, 'copilot')
      const calls = projects.flatMap(p => p.sessions).flatMap(s => s.turns).flatMap(t => t.assistantCalls)
      return { projects, calls }
    } finally {
      clearSessionCache()
      clearLoadCacheMemo()
    }
  }

  it('serves 10 calls and exact credits for the closed session', async () => {
    const { projects, calls } = await serve(await fixtureLines())
    expect(projects.map(p => p.project)).toEqual(['copilot-test'])
    expect(behavioralCallCount(calls)).toBe(TRUTH.calls)
    expect(calls.reduce((s, c) => s + c.usage.outputTokens, 0)).toBe(TRUTH.output)
    expect(calls.reduce((s, c) => s + c.usage.inputTokens, 0)).toBe(TRUTH.input)
    expect(calls.reduce((s, c) => s + c.usage.cacheReadInputTokens, 0)).toBe(TRUTH.cacheRead)
    expect(copilotCreditSpend(projects)).toMatchObject({ spentCredits: 2.772045, creditRatedCalls: 10, creditUnratedCalls: 0 })
  })

  it('serves an open session as 10 calls with no tokens', async () => {
    const lines = (await fixtureLines()).filter(l => JSON.parse(l).type !== 'session.shutdown')
    const { projects, calls } = await serve(lines)
    expect(projects.map(p => p.project)).toEqual(['copilot-test'])
    expect(behavioralCallCount(calls)).toBe(TRUTH.calls)
    expect(calls.reduce((s, c) => s + c.usage.inputTokens + c.usage.outputTokens + c.costUSD, 0)).toBe(0)
  })

  function writeStore(sid: string, cwd: string, rows: Array<Record<string, string | number | null>>): string {
    const dbPath = join(tmp, 'session-store.db')
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { run(...p: unknown[]): void }; close(): void }
    }
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, created_at TEXT);
      CREATE TABLE IF NOT EXISTS assistant_usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, model TEXT,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
        reasoning_tokens INTEGER, total_nano_aiu INTEGER, request_multiplier REAL, initiator TEXT, created_at TEXT);
    `)
    db.prepare('INSERT INTO sessions (id, cwd) VALUES (?, ?)').run(sid, cwd)
    const insert = db.prepare(`INSERT INTO assistant_usage_events (session_id, model, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens, reasoning_tokens, total_nano_aiu, request_multiplier, initiator, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    for (const r of rows) {
      insert.run(sid, r['model'], r['input_tokens'], r['output_tokens'], r['cache_read_tokens'], r['cache_write_tokens'],
        r['reasoning_tokens'], r['total_nano_aiu'], r['request_multiplier'], r['initiator'], r['created_at'])
    }
    db.close()
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STORE_DB', dbPath)
    return dbPath
  }

  type ServedCall = Awaited<ReturnType<typeof serve>>['calls'][number]

  // GitHub's own per-request charge is total_nano_aiu / 1e11 USD at list
  // rates, so a model whose tokens are all counted and correctly priced costs
  // exactly its rows' nanoAiu.
  function expectCostEqualsNanoAiu(calls: ServedCall[], rows: Array<Record<string, string | number | null>>): void {
    const models = new Set(rows.map(r => r['model'] as string))
    for (const model of models) {
      const cost = calls.filter(c => c.model === model).reduce((s, c) => s + c.costUSD, 0)
      const nano = rows.filter(r => r['model'] === model).reduce((s, r) => s + (r['total_nano_aiu'] as number), 0)
      expect({ model, cost: Number(cost.toFixed(12)) }).toEqual({ model, cost: Number((nano / 1e11).toFixed(12)) })
    }
  }

  // CLI 1.0.82: tokenless messages plus session-store rows. Rollup ground
  // truth: inputTokens 310,703 cache-inclusive, output 3,254, 9.334625 credits.
  const STORE_SID = 'e61538c6-6e3e-4607-b468-b38972f2ba35'
  const STORE_CWD = '/home/dev/codeburn/app'
  const storeDir = fileURLToPath(new URL('./fixtures/copilot/cli-store-session/', import.meta.url))
  const storeRows = async () => JSON.parse(await readFile(join(storeDir, 'store-rows.json'), 'utf-8')) as Array<Record<string, string | number>>
  const storeLines = async () => (await readFile(join(storeDir, 'events.jsonl'), 'utf-8')).split('\n').filter(l => l.trim())

  async function serveStore(lines: string[]) {
    const rows = await storeRows()
    writeStore(STORE_SID, STORE_CWD, rows)
    const served = await serve(lines, STORE_SID, STORE_CWD)
    const usage = (k: keyof ServedCall['usage']) => served.calls.reduce((s, c) => s + c.usage[k], 0)
    expect(behavioralCallCount(served.calls)).toBe(11)
    expect(usage('outputTokens')).toBe(3_254)
    expect(usage('inputTokens')).toBe(82)
    expect(usage('cacheReadInputTokens')).toBe(270_680)
    expect(usage('cacheCreationInputTokens')).toBe(39_941)
    expect(served.calls.reduce((s, c) => s + c.costUSD, 0)).toBeCloseTo(calculateCost('claude-haiku-4.5', 82, 3_254, 39_941, 270_680, 0), 12)
    expectCostEqualsNanoAiu(served.calls, rows)
    expect(copilotCreditSpend(served.projects)).toMatchObject({ spentCredits: 9.334625, creditRatedCalls: 11, creditUnratedCalls: 0 })
    return served
  }

  it.skipIf(!isSqliteAvailable())('store rows + shutdown: rows carry the output, the residual carries none', async () => {
    const { calls } = await serveStore(await storeLines())
    expect(calls.filter(c => c.deduplicationKey.includes(':shutdown-residual:'))).toEqual([])
  })

  it.skipIf(!isSqliteAvailable())('store rows, no shutdown: exact from the rows alone', async () => {
    await serveStore((await storeLines()).filter(l => JSON.parse(l).type !== 'session.shutdown'))
  })

  it.skipIf(!isSqliteAvailable())('older CLI with per-turn outputTokens and store rows: output counted once', async () => {
    const out = (await storeRows()).map(r => r['output_tokens'] as number)
    let n = 0
    const lines = (await storeLines()).map(l => {
      const e = JSON.parse(l)
      if (e.type !== 'assistant.message') return l
      e.data.outputTokens = out[n++]
      return JSON.stringify(e)
    })
    expect(n).toBe(11)
    const { calls } = await serveStore(lines)
    expect(calls.filter(c => c.deduplicationKey.startsWith('copilot-store:')).every(c => c.usage.outputTokens === 0)).toBe(true)
  })

  // Synthetic split of the real session into two legs: a shutdown after the
  // sixth request carries the cumulative totals of rows 1-6.
  it.skipIf(!isSqliteAvailable())('resumed two-leg session: exact with or without the second leg\'s shutdown', async () => {
    const rows = await storeRows()
    const first = rows.slice(0, 6)
    const total = (k: string) => first.reduce((s, r) => s + (r[k] as number), 0)
    const legShutdown = JSON.stringify({
      type: 'session.shutdown', timestamp: '2026-08-31T10:02:40.000Z',
      data: { shutdownType: 'routine', modelMetrics: { 'claude-haiku-4.5': {
        usage: { inputTokens: total('input_tokens'), outputTokens: total('output_tokens'), cacheReadTokens: total('cache_read_tokens'),
          cacheWriteTokens: total('cache_write_tokens'), reasoningTokens: total('reasoning_tokens') },
        totalNanoAiu: total('total_nano_aiu') } } },
    })
    const lines = await storeLines()
    const resume = lines.findIndex(l => JSON.parse(l).timestamp > '2026-08-31T10:02:40.000Z')
    const twoLegs = [...lines.slice(0, resume), legShutdown, ...lines.slice(resume)]
    await serveStore(twoLegs)
    await rm(join(tmp, 'session-store.db'), { force: true })
    await rm(join(tmp, 'cache'), { recursive: true, force: true })
    await serveStore(twoLegs.filter((l, i) => i <= resume || JSON.parse(l).type !== 'session.shutdown'))
  })

  // Real per-request rows (numbers only) from a PyCharm AI Chat session over
  // ACP (`copilot --acp`, CLI 1.0.85) that never wrote session.shutdown,
  // plus the three grok-4.6 rows of a JetBrains plugin session. Each model's
  // cost must equal GitHub's charge for its rows.
  it.skipIf(!isSqliteAvailable())('ACP session with no shutdown: every model costs exactly its nanoAiu', async () => {
    const sid = '760f62f7-0000-4000-8000-000000000000'
    const cols = ['model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'total_nano_aiu', 'initiator', 'created_at'] as const
    const rows = ([
      ['gpt-5.6-terra', 15109, 201, 0, 15106, 39, 4018300000, 'user', '2026-10-06T16:13:10.192Z'],
      ['gpt-5.6-terra', 15594, 134, 15106, 485, 11, 584770000, 'agent', '2026-10-06T16:13:15.509Z'],
      ['gpt-5.6-terra', 15967, 118, 15591, 373, 77, 547270000, 'agent', '2026-10-06T16:14:54.382Z'],
      ['gpt-5.6-terra', 16125, 69, 15964, 158, 0, 442180000, 'agent', '2026-10-06T16:15:18.027Z'],
      ['kimi-k3', 17124, 124, 0, 0, 19, 5323200000, 'user', '2026-10-06T16:15:32.820Z'],
      ['kimi-k3', 27977, 257, 4096, 0, 0, 7672680000, 'agent', '2026-10-06T16:15:40.575Z'],
      ['kimi-k3', 28324, 188, 27976, 0, 0, 1225680000, 'agent', '2026-10-06T16:16:02.145Z'],
      ['kimi-k3', 28562, 102, 28323, 0, 0, 1074390000, 'agent', '2026-10-06T16:16:19.210Z'],
      ['kimi-k3', 28722, 66, 28561, 0, 0, 1004130000, 'agent', '2026-10-06T16:16:49.485Z'],
      ['grok-4.6', 28321, 876, 0, 0, 532, 6189800000, 'user', '2026-10-06T16:17:23.490Z'],
      ['grok-4.6', 29292, 29, 28288, 0, 5, 1632600000, 'agent', '2026-10-06T16:17:25.372Z'],
      ['grok-4.6', 29408, 41, 29184, 0, 0, 1528600000, 'agent', '2026-10-06T16:17:35.539Z'],
    ] as const).map(r => ({ ...Object.fromEntries(cols.map((c, i) => [c, r[i]])), request_multiplier: 1 }))
    const ev = (type: string, timestamp: string, data: Record<string, unknown>) => JSON.stringify({ type, timestamp, data })
    const lines = [ev('session.start', '2026-10-06T16:13:02.845Z', { producer: 'copilot-agent', copilotVersion: '1.0.85' })]
    rows.forEach((r, i) => {
      const at = new Date(Date.parse(r.created_at) + 3).toISOString()
      if (r.model !== rows[i - 1]?.model) lines.push(ev('session.model_change', r.created_at, { newModel: r.model }))
      lines.push(ev('assistant.message', at, { messageId: `m${i}`, model: r.model, toolRequests: [] }))
    })
    lines.push(ev('session.usage_checkpoint', '2026-10-06T16:17:35.600Z', { totalNanoAiu: 31_243_600_000, totalPremiumRequests: 3 }))

    writeStore(sid, '/home/dev/pycharm-demo', rows)
    const { projects, calls } = await serve(lines, sid, '/home/dev/pycharm-demo')
    expect(behavioralCallCount(calls)).toBe(12)
    expect(calls.reduce((s, c) => s + c.usage.outputTokens, 0)).toBe(522 + 737 + 946)
    expectCostEqualsNanoAiu(calls, rows)
    expect(copilotCreditSpend(projects)).toMatchObject({ spentCredits: 31.2436, creditRatedCalls: 12, creditUnratedCalls: 0 })
  })
})
