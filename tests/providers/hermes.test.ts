import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'node:module'

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as sqlite from '../../src/sqlite.js'
import { isSqliteAvailable } from '../../src/sqlite.js'
import { calculateCost } from '../../src/models.js'
import { createHermesProvider } from '../../src/providers/hermes.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

const requireForTest = createRequire(import.meta.url)

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'hermes-test-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(tmpRoot, { recursive: true, force: true })
})

// Minimal subset of the real Hermes state.db `sessions` schema covering only
// the columns the provider reads. Schema verified against state.db 2026-06-21.
function createHermesDb(dir: string): string {
  const dbPath = join(dir, 'state.db')
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      model TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      estimated_cost_usd REAL,
      actual_cost_usd REAL,
      cost_status TEXT,
      started_at REAL NOT NULL,
      ended_at REAL,
      cwd TEXT
    )
  `)
  db.close()
  return dbPath
}

interface SeedSession {
  id: string
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  estimated_cost_usd: number | null
  actual_cost_usd: number | null
  cost_status: string | null
  started_at: number
  ended_at: number | null
  cwd: string
}

function seed(dbPath: string, sessions: SeedSession[]): void {
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath)
  try {
    const stmt = db.prepare(
      `INSERT INTO sessions
       (id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, estimated_cost_usd, actual_cost_usd, cost_status, started_at, ended_at, cwd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const s of sessions) {
      stmt.run(
        s.id, s.model, s.input_tokens, s.output_tokens, s.cache_read_tokens, s.cache_write_tokens,
        s.reasoning_tokens, s.estimated_cost_usd, s.actual_cost_usd, s.cost_status,
        s.started_at, s.ended_at, s.cwd,
      )
    }
  } finally {
    db.close()
  }
}

async function collect(parser: { parse(): AsyncGenerator<ParsedProviderCall> }): Promise<ParsedProviderCall[]> {
  const out: ParsedProviderCall[] = []
  for await (const call of parser.parse()) out.push(call)
  return out
}

// Three sessions exercising each cost path:
//  - sess-est:    cost_status='estimated' with a real estimated_cost_usd (honored)
//  - sess-unknown: cost_status='unknown', 0.0 sentinel cost (priced via calculateCost)
//  - sess-actual: actual_cost_usd present (honored as a real, non-estimated cost)
const SESSIONS: SeedSession[] = [
  {
    id: '20260621_204925_21a5ebf0',
    model: 'deepseek-v4-pro',
    input_tokens: 146279,
    output_tokens: 5050,
    cache_read_tokens: 388352,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    estimated_cost_usd: 0.277730564,
    actual_cost_usd: null,
    cost_status: 'estimated',
    started_at: 1782064165.92366,
    ended_at: 1782066522.92487,
    cwd: '/Users/me/proj',
  },
  {
    id: '20260621_231154_3ab434',
    model: 'glm-5.2',
    input_tokens: 40100,
    output_tokens: 1191,
    cache_read_tokens: 60544,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    estimated_cost_usd: 0.0,
    actual_cost_usd: null,
    cost_status: 'unknown',
    started_at: 1782072715.06182,
    ended_at: null,
    cwd: '/private/tmp/work',
  },
  {
    id: '20260621_210414_743275',
    model: 'claude-opus-4-8',
    input_tokens: 26112,
    output_tokens: 282,
    cache_read_tokens: 8704,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    estimated_cost_usd: null,
    actual_cost_usd: 0.05,
    cost_status: 'actual',
    started_at: 1782065054.93198,
    ended_at: 1782066522.91539,
    cwd: '/Users/me/.hermes',
  },
]

describe('hermes provider', () => {
  it('discovers the Hermes database once when it has usage', async () => {
    if (!isSqliteAvailable()) return
    const dbPath = createHermesDb(tmpRoot)
    seed(dbPath, SESSIONS)

    const provider = createHermesProvider(dbPath)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions.every(s => s.provider === 'hermes')).toBe(true)
    expect(sessions[0]!.path).toBe(dbPath)
    expect(sessions[0]!.project).toBe('hermes')
  })

  it('honors estimated_cost_usd for estimated rows and prices unknown rows via the table', async () => {
    if (!isSqliteAvailable()) return
    const dbPath = createHermesDb(tmpRoot)
    seed(dbPath, SESSIONS)

    const provider = createHermesProvider(dbPath)
    const sources = await provider.discoverSessions()
    const seen = new Set<string>()
    const calls: ParsedProviderCall[] = []
    for (const source of sources) {
      calls.push(...(await collect(provider.createSessionParser(source, seen))))
    }
    expect(calls).toHaveLength(3)

    const est = calls.find(c => c.sessionId === '20260621_204925_21a5ebf0')!
    expect(est.model).toBe('deepseek-v4-pro')
    expect(est.inputTokens).toBe(146279)
    expect(est.cacheReadInputTokens).toBe(388352)
    expect(est.outputTokens).toBe(5050)
    // Hermes stores fresh input separately from cache reads (no subtraction).
    expect(est.costUSD).toBeCloseTo(0.277730564, 6)
    expect(est.costIsEstimated).toBe(true)

    const unknown = calls.find(c => c.sessionId === '20260621_231154_3ab434')!
    expect(unknown.model).toBe('glm-5.2')
    expect(unknown.inputTokens).toBe(40100)
    // cost_status='unknown' carries a 0.0 sentinel; fall back to codeburn
    // pricing. glm-5.2 aliases to glm-5p1 (BUILTIN_ALIASES in src/models.ts).
    const expected = calculateCost('glm-5.2', 40100, 1191, 0, 60544, 0)
    expect(expected).toBeGreaterThan(0)
    expect(unknown.costUSD).toBeCloseTo(expected, 10)
    expect(unknown.costIsEstimated).toBe(true)
  })

  it('keeps sessions that have cost but zero tokens', async () => {
    if (!isSqliteAvailable()) return
    const dbPath = createHermesDb(tmpRoot)
    seed(dbPath, [
      ...SESSIONS,
      {
        id: '20260621_cost_only',
        model: 'glm-5.2',
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        estimated_cost_usd: 0.042,
        actual_cost_usd: null,
        cost_status: 'estimated',
        started_at: 1782067000.1,
        ended_at: 1782067002.2,
        cwd: '/Users/me/cost-only',
      },
    ])

    const provider = createHermesProvider(dbPath)
    const sources = await provider.discoverSessions()
    const seen = new Set<string>()
    const calls: ParsedProviderCall[] = []
    for (const source of sources) {
      calls.push(...(await collect(provider.createSessionParser(source, seen))))
    }

    const costOnly = calls.find(c => c.sessionId === '20260621_cost_only')
    expect(costOnly).toBeDefined()
    expect(costOnly!.inputTokens).toBe(0)
    expect(costOnly!.outputTokens).toBe(0)
    expect(costOnly!.cacheReadInputTokens).toBe(0)
    expect(costOnly!.cacheCreationInputTokens).toBe(0)
    expect(costOnly!.reasoningTokens).toBe(0)
    expect(costOnly!.costUSD).toBeCloseTo(0.042, 9)
    expect(costOnly!.costIsEstimated).toBe(true)
  })

  it('includes reasoning tokens when pricing unknown-cost rows', async () => {
    if (!isSqliteAvailable()) return
    const dbPath = createHermesDb(tmpRoot)
    seed(dbPath, [
      {
        id: '20260621_reasoning',
        model: 'glm-5.2',
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 300,
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: 'unknown',
        started_at: 1782067100.1,
        ended_at: 1782067102.2,
        cwd: '/Users/me/reasoning',
      },
    ])

    const provider = createHermesProvider(dbPath)
    const [source] = await provider.discoverSessions()
    const [call] = await collect(provider.createSessionParser(source!, new Set()))

    expect(call!.reasoningTokens).toBe(300)
    const withoutReasoning = calculateCost('glm-5.2', 1000, 200, 0, 0, 0)
    const expected = calculateCost('glm-5.2', 1000, 200, 0, 0, 0, 'standard', 0, 300)
    expect(expected).toBeGreaterThan(withoutReasoning)
    expect(call!.costUSD).toBeCloseTo(expected, 12)
  })

  it('parses many rows from one source with one parser-side SQLite open', async () => {
    if (!isSqliteAvailable()) return
    const dbPath = createHermesDb(tmpRoot)
    const manySessions: SeedSession[] = Array.from({ length: 40 }, (_, i) => ({
      id: `20260621_many_${i}`,
      model: 'glm-5.2',
      input_tokens: 100 + i,
      output_tokens: 10 + i,
      cache_read_tokens: i,
      cache_write_tokens: 0,
      reasoning_tokens: i % 3,
      estimated_cost_usd: 0,
      actual_cost_usd: null,
      cost_status: 'unknown',
      started_at: 1782067200 + i,
      ended_at: 1782067300 + i,
      cwd: `/Users/me/many-${i % 4}`,
    }))
    seed(dbPath, manySessions)

    const openSpy = vi.spyOn(sqlite, 'openDatabase')
    const provider = createHermesProvider(dbPath)
    const sources = await provider.discoverSessions()

    expect(sources).toHaveLength(1)
    expect(openSpy).toHaveBeenCalledTimes(1)

    openSpy.mockClear()
    const calls = await collect(provider.createSessionParser(sources[0]!, new Set()))

    expect(calls).toHaveLength(manySessions.length)
    expect(openSpy).toHaveBeenCalledTimes(1)
  })

  it('honors actual_cost_usd as a real (non-estimated) cost', async () => {
    if (!isSqliteAvailable()) return
    const dbPath = createHermesDb(tmpRoot)
    seed(dbPath, SESSIONS)

    const provider = createHermesProvider(dbPath)
    const sources = await provider.discoverSessions()
    const seen = new Set<string>()
    const calls: ParsedProviderCall[] = []
    for (const source of sources) {
      calls.push(...(await collect(provider.createSessionParser(source, seen))))
    }

    const actual = calls.find(c => c.sessionId === '20260621_210414_743275')!
    expect(actual.model).toBe('claude-opus-4-8')
    expect(actual.costUSD).toBeCloseTo(0.05, 9)
    expect(actual.costIsEstimated).toBe(false)
  })

  it('does not re-emit sessions already in the seen set', async () => {
    if (!isSqliteAvailable()) return
    const dbPath = createHermesDb(tmpRoot)
    seed(dbPath, SESSIONS)

    const provider = createHermesProvider(dbPath)
    const [source] = await provider.discoverSessions()
    const seen = new Set<string>()

    const first = await collect(provider.createSessionParser(source!, seen))
    const second = await collect(provider.createSessionParser(source!, seen))

    expect(first).toHaveLength(3)
    expect(second).toHaveLength(0)
  })
})
