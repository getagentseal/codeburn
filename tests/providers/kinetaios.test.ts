import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { kinetaios, createKinetAiosProvider } from '../../src/providers/kinetaios.js'
import { isSqliteAvailable } from '../../src/sqlite.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

type TestDb = {
  prepare(sql: string): { run(...params: unknown[]): unknown }
  exec(sql: string): void
  close(): void
}

function requireSqlite(): (new (path: string) => TestDb) | null {
  if (!isSqliteAvailable()) return null
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => TestDb }
  return DatabaseSync
}

function makeDb(dbPath: string): TestDb {
  const DatabaseSync = requireSqlite()
  if (!DatabaseSync) throw new Error('node:sqlite unavailable')
  const db = new DatabaseSync(dbPath)
  // Mirrors KinetAios v3.7+ schema (the app migrates idempotently; the
  // tokens_in/tokens_out columns were added after 3.6.x wrote whole totals).
  db.exec(`CREATE TABLE IF NOT EXISTS conversations(
      id TEXT PRIMARY KEY, engine TEXT, cwd TEXT, created_at REAL, custom_title TEXT,
      model TEXT, updated_at REAL)`)
  db.exec(`CREATE TABLE IF NOT EXISTS cost_log(
      id TEXT PRIMARY KEY, conv_id TEXT, engine TEXT, amount REAL, tokens INTEGER, ts REAL,
      tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0)`)
  return db
}

type InsertRow = {
  id: string
  convId?: string | null
  engine?: string
  amount?: number | null
  tokens?: number
  ts: number
  tokensIn?: number
  tokensOut?: number
}

function insertCostLog(db: TestDb, row: InsertRow): void {
  db.prepare(
    `INSERT INTO cost_log (id, conv_id, engine, amount, tokens, ts, tokens_in, tokens_out)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.convId ?? null,
    row.engine ?? 'direct',
    row.amount ?? null,
    row.tokens ?? (row.tokensIn ?? 0) + (row.tokensOut ?? 0),
    row.ts,
    row.tokensIn ?? 0,
    row.tokensOut ?? 0,
  )
}

function insertConv(db: TestDb, id: string, cwd: string, model: string): void {
  db.prepare(
    `INSERT INTO conversations (id, engine, cwd, created_at, custom_title, model, updated_at)
     VALUES (?, 'direct', ?, ?, NULL, ?, ?)`,
  ).run(id, cwd, 0, model, 0)
}

async function collect(provider: ReturnType<typeof createKinetAiosProvider>, dbPath: string, seen?: Set<string>): Promise<ParsedProviderCall[]> {
  const sources = await provider.discoverSessions()
  expect(sources).toHaveLength(1)
  expect(sources[0]!.provider).toBe('kinetaios')
  const calls: ParsedProviderCall[] = []
  for await (const call of provider.createSessionParser(sources[0]!, seen ?? new Set()).parse()) calls.push(call)
  void dbPath
  return calls
}

describe('kinetaios provider', () => {
  let tmpDir: string
  let dbPath: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'kinetaios-test-'))
    dbPath = join(tmpDir, 'history.db')
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('has correct name and displayName', () => {
    expect(kinetaios.name).toBe('kinetaios')
    expect(kinetaios.displayName).toBe('KinetAios')
  })

  it('discovers the db when present and nothing when absent', async () => {
    const provider = createKinetAiosProvider(dbPath)
    expect(await provider.discoverSessions()).toHaveLength(0)

    const db = makeDb(dbPath)
    insertCostLog(db, { id: 'row-1', ts: 1727000000000, tokensIn: 100, tokensOut: 20, amount: 0.01 })
    db.close()

    const sources = await provider.discoverSessions()
    expect(sources).toHaveLength(1)
    expect(sources[0]!.path.endsWith(':kinetaios')).toBe(true)
    const roots = await provider.probeRoots()
    expect(roots).toEqual([{ path: dbPath, label: 'sqlite' }])
  })

  it('yields one call per cost_log row with reported cost and joined model/cwd', async () => {
    const db = makeDb(dbPath)
    insertConv(db, 'conv-a', '/Users/x/kinet/KinetAiosWin', 'glm-5.3-flash')
    insertCostLog(db, { id: 'row-1', convId: 'conv-a', ts: 1727000000000, tokensIn: 500000, tokensOut: 10000, amount: 0.25 })
    insertCostLog(db, { id: 'row-2', convId: 'conv-a', ts: 1727000060000, tokensIn: 600000, tokensOut: 20000, amount: 0.4 })
    db.close()

    const provider = createKinetAiosProvider(dbPath)
    const calls = await collect(provider, dbPath)
    expect(calls).toHaveLength(2)

    expect(calls[0]!.provider).toBe('kinetaios')
    expect(calls[0]!.model).toBe('glm-5.3-flash')
    expect(calls[0]!.inputTokens).toBe(500000)
    expect(calls[0]!.outputTokens).toBe(10000)
    expect(calls[0]!.costUSD).toBeCloseTo(0.25, 6)
    expect(calls[0]!.deduplicationKey).toBe('kinetaios:kinetaios:row-1')
    expect(calls[0]!.sessionId).toBe('kinetaios')
    expect(calls[0]!.timestamp).toBe(new Date(1727000000000).toISOString())
  })

  it('skips seen dedup keys on rescan (incremental idempotence)', async () => {
    const db = makeDb(dbPath)
    insertCostLog(db, { id: 'row-1', ts: 1727000000000, tokensIn: 100, tokensOut: 20, amount: 0.01 })
    db.close()

    const provider = createKinetAiosProvider(dbPath)
    const sources = await provider.discoverSessions()
    const seen = new Set<string>()
    const first: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(sources[0]!, seen).parse()) first.push(call)
    expect(first).toHaveLength(1)

    const second: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(sources[0]!, seen).parse()) second.push(call)
    expect(second).toHaveLength(0)
  })

  it('maps legacy whole-total rows (tokens_in/out = 0) onto input', async () => {
    const db = makeDb(dbPath)
    insertCostLog(db, { id: 'legacy-1', tokens: 189754, ts: 1727000000000, tokensIn: 0, tokensOut: 0, amount: 0.05 })
    db.close()

    const provider = createKinetAiosProvider(dbPath)
    const calls = await collect(provider, dbPath)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(189754)
    expect(calls[0]!.outputTokens).toBe(0)
    expect(calls[0]!.costUSD).toBeCloseTo(0.05, 6)
    expect(calls[0]!.costFromBilling).toBe(true)
  })

  it('falls back to table pricing when amount is missing, flagged via cache-relevant fields', async () => {
    const db = makeDb(dbPath)
    insertConv(db, 'conv-b', '/tmp/some-project', 'claude-sonnet-4-5')
    insertCostLog(db, { id: 'noprice-1', convId: 'conv-b', tokens: 1000, ts: 1727000000000, tokensIn: 900, tokensOut: 100, amount: null })
    db.close()

    const provider = createKinetAiosProvider(dbPath)
    const calls = await collect(provider, dbPath)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.costUSD).toBeCloseTo(0.0042, 6)
    expect(calls[0]!.costFromBilling).toBeUndefined()
  })

  it('survives a conversation deleted after logging (LEFT JOIN miss)', async () => {
    const db = makeDb(dbPath)
    insertCostLog(db, { id: 'orphan-1', convId: 'deleted-conv', tokens: 500, ts: 1727000000000, tokensIn: 400, tokensOut: 100, amount: 0.02 })
    db.close()

    const provider = createKinetAiosProvider(dbPath)
    const calls = await collect(provider, dbPath)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe('kinetaios-auto')
    expect(calls[0]!.costUSD).toBeCloseTo(0.02, 6)
  })

  it('parses nothing on a non-KinetAios sqlite file', async () => {
    const DatabaseSync = requireSqlite()
    if (!DatabaseSync) return
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE unrelated(id TEXT)')
    db.close()

    const provider = createKinetAiosProvider(dbPath)
    const calls = await collect(provider, dbPath)
    expect(calls).toHaveLength(0)
  })
})
