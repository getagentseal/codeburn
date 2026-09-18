import { mkdir, mkdtemp, rm, unlink } from 'fs/promises'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { createRequire } from 'node:module'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHermesProvider } from '../../src/providers/hermes.js'
import { isSqliteAvailable } from '../../src/sqlite.js'
import { aggregateProjectsIntoDays, dateKey } from '../../src/day-aggregator.js'
import { behavioralTurnCount } from '../../src/behavioral-weight.js'
import {
  getHermesCursor,
  hermesSessionLedgerPath,
  loadHermesSessionLedger,
  resetHermesSessionLedgerForTests,
} from '../../src/hermes-session-ledger.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

const requireForTest = createRequire(import.meta.url)

type TestDb = {
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): void }
  close(): void
}

const CLEANHOME_ROOT = '/tmp/cb-cleanhome'
const REAL_HERMES_HOME = resolve(join(homedir(), '.hermes'))

let hermesHome: string
let cacheDir: string
let originalHermesHome: string | undefined
let originalCodeburnCacheDir: string | undefined

beforeEach(async () => {
  await mkdir(CLEANHOME_ROOT, { recursive: true })
  hermesHome = await mkdtemp(join(CLEANHOME_ROOT, 'home-'))
  cacheDir = await mkdtemp(join(CLEANHOME_ROOT, 'cache-'))
  expect(resolve(hermesHome)).not.toBe(REAL_HERMES_HOME)
  originalHermesHome = process.env['HERMES_HOME']
  originalCodeburnCacheDir = process.env['CODEBURN_CACHE_DIR']
  process.env['HERMES_HOME'] = hermesHome
  process.env['CODEBURN_CACHE_DIR'] = cacheDir
  resetHermesSessionLedgerForTests()
})

afterEach(async () => {
  resetHermesSessionLedgerForTests()
  if (originalHermesHome === undefined) delete process.env['HERMES_HOME']
  else process.env['HERMES_HOME'] = originalHermesHome
  if (originalCodeburnCacheDir === undefined) delete process.env['CODEBURN_CACHE_DIR']
  else process.env['CODEBURN_CACHE_DIR'] = originalCodeburnCacheDir
  await rm(hermesHome, { recursive: true, force: true })
  await rm(cacheDir, { recursive: true, force: true })
})

function createHermesDb(homeDir: string): string {
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const dbPath = join(homeDir, 'state.db')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT,
      model TEXT,
      cwd TEXT,
      git_repo_root TEXT,
      billing_provider TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      estimated_cost_usd REAL,
      actual_cost_usd REAL,
      cost_status TEXT,
      cost_source TEXT,
      api_call_count INTEGER DEFAULT 0,
      tool_call_count INTEGER DEFAULT 0,
      started_at REAL,
      ended_at REAL,
      title TEXT
    )
  `)
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_call_id TEXT,
      tool_calls TEXT,
      tool_name TEXT,
      timestamp REAL NOT NULL
    )
  `)
  db.close()
  return dbPath
}

async function createProfileHermesDb(home: string, profile: string): Promise<string> {
  const profileDir = join(home, 'profiles', profile)
  await mkdir(profileDir, { recursive: true })
  return createHermesDb(profileDir)
}

function withTestDb(dbPath: string, fn: (db: TestDb) => void): void {
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath)
  try {
    fn(db)
  } finally {
    db.close()
  }
}

function insertSession(db: TestDb, values: {
  id: string
  inputTokens: number
  outputTokens?: number
  actualCost?: number | null
  estimatedCost?: number | null
  costStatus?: string | null
  costSource?: string | null
  startedAt: number
  model?: string
}): void {
  db.prepare(
    `INSERT INTO sessions (
      id, source, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      reasoning_tokens, estimated_cost_usd, actual_cost_usd, cost_status, cost_source,
      api_call_count, tool_call_count, started_at, title
    ) VALUES (?, 'cli', ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, 1, 0, ?, ?)`,
  ).run(
    values.id,
    values.model ?? 'gpt-5.5',
    values.inputTokens,
    values.outputTokens ?? 0,
    values.estimatedCost ?? null,
    values.actualCost ?? null,
    values.costStatus ?? null,
    values.costSource ?? null,
    values.startedAt,
    values.id,
  )
}

function updateSession(db: TestDb, id: string, values: {
  inputTokens: number
  actualCost?: number | null
}): void {
  db.prepare('UPDATE sessions SET input_tokens = ?, actual_cost_usd = ? WHERE id = ?')
    .run(values.inputTokens, values.actualCost ?? null, id)
}

function localDay(offsetDays: number, hour = 10): { date: Date; unixSec: number; key: string; iso: string } {
  const date = new Date()
  date.setHours(hour, 0, 0, 0)
  date.setDate(date.getDate() + offsetDays)
  return {
    date,
    unixSec: date.getTime() / 1000,
    key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
    iso: date.toISOString(),
  }
}

async function loadParser() {
  process.env['HERMES_HOME'] = hermesHome
  process.env['CODEBURN_CACHE_DIR'] = cacheDir
  vi.resetModules()
  resetHermesSessionLedgerForTests()
  return import('../../src/parser.js')
}

async function parseDiscovered(): Promise<{ sources: { path: string }[]; calls: ParsedProviderCall[] }> {
  const provider = createHermesProvider(hermesHome)
  const sources = await provider.discoverSessions()
  const calls: ParsedProviderCall[] = []
  const seen = new Set<string>()
  for (const source of sources) {
    for await (const call of provider.createSessionParser(source, seen).parse()) {
      calls.push(call)
    }
  }
  return { sources, calls }
}

const skipUnlessSqlite = isSqliteAvailable() ? describe : describe.skip

skipUnlessSqlite('hermes post-finalization ledger proofs', () => {
  it('P1: sealed day D keeps 100/$0.10/1/1; D+1 is +50/$0.05/0/0', async () => {
    const dayD = localDay(-1)
    const dbPath = createHermesDb(hermesHome)
    withTestDb(dbPath, (db) => {
      insertSession(db, { id: 'p1', inputTokens: 100, actualCost: 0.10, startedAt: dayD.unixSec })
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('p1', 'user', 'keep going', dayD.unixSec + 1)
    })

    const parser = await loadParser()
    parser.clearSessionCache()
    const firstProjects = await parser.parseAllSessions(undefined, 'hermes')
    const { ensureCacheHydrated, loadDailyCache } = await import('../../src/daily-cache.js')
    await ensureCacheHydrated(
      (range) => parser.parseAllSessions(range, 'hermes'),
      aggregateProjectsIntoDays,
      '',
      parser.isSessionHydrationComplete,
    )
    const sealed = await loadDailyCache()
    expect(sealed.lastComputedDate).toBe(dayD.key)
    const sealedDay = sealed.days.find(d => d.date === dayD.key)
    expect(sealedDay?.inputTokens).toBe(100)
    expect(sealedDay?.cost).toBeCloseTo(0.10)
    expect(sealedDay?.calls).toBe(1)
    expect(sealedDay?.sessions).toBe(1)

    withTestDb(dbPath, (db) => {
      updateSession(db, 'p1', { inputTokens: 150, actualCost: 0.15 })
    })
    parser.clearSessionCache()
    const grown = await parser.parseAllSessions(undefined, 'hermes')
    const days = aggregateProjectsIntoDays(grown)
    const todayKey = dateKey(new Date().toISOString())
    const dEntry = days.find(d => d.date === dayD.key)
    const todayEntry = days.find(d => d.date === todayKey)
    expect(dEntry?.inputTokens).toBe(100)
    expect(dEntry?.cost).toBeCloseTo(0.10)
    expect(dEntry?.calls).toBe(1)
    expect(dEntry?.sessions).toBe(1)
    expect(todayEntry?.inputTokens).toBe(50)
    expect(todayEntry?.cost).toBeCloseTo(0.05)
    expect(todayEntry?.calls).toBe(0)
    expect(todayEntry?.sessions ?? 0).toBe(0)

    const session = grown.flatMap(p => p.sessions)[0]!
    expect(session.apiCalls).toBe(1)
    expect(behavioralTurnCount(session.turns)).toBe(1)
    expect(session.totalInputTokens).toBe(150)
    expect(session.totalCostUSD).toBeCloseTo(0.15)

    await ensureCacheHydrated(
      (range) => parser.parseAllSessions(range, 'hermes'),
      aggregateProjectsIntoDays,
      '',
      parser.isSessionHydrationComplete,
    )
    const stillSealed = await loadDailyCache()
    const stillD = stillSealed.days.find(d => d.date === dayD.key)
    expect(stillD?.inputTokens).toBe(100)
    expect(stillD?.calls).toBe(1)
    expect(firstProjects.length).toBeGreaterThan(0)
  })

  it('P2: same sessionId in default and coder are two cursors', async () => {
    const started = localDay(0).unixSec
    const rootDb = createHermesDb(hermesHome)
    const coderDb = await createProfileHermesDb(hermesHome, 'coder')
    withTestDb(rootDb, (db) => {
      insertSession(db, { id: 'shared', inputTokens: 100, actualCost: 0.10, startedAt: started })
    })
    withTestDb(coderDb, (db) => {
      insertSession(db, { id: 'shared', inputTokens: 80, actualCost: 0.08, startedAt: started })
    })

    await parseDiscovered()
    const ledger = loadHermesSessionLedger()
    expect(getHermesCursor(ledger, 'default', 'shared')?.lastSeen.inputTokens).toBe(100)
    expect(getHermesCursor(ledger, 'coder', 'shared')?.lastSeen.inputTokens).toBe(80)

    withTestDb(rootDb, (db) => {
      updateSession(db, 'shared', { inputTokens: 130, actualCost: 0.13 })
    })
    const { calls } = await parseDiscovered()
    const later = loadHermesSessionLedger()
    expect(getHermesCursor(later, 'default', 'shared')?.lastSeen.inputTokens).toBe(130)
    expect(getHermesCursor(later, 'coder', 'shared')?.lastSeen.inputTokens).toBe(80)
    expect(calls.filter(c => c.deduplicationKey.includes(':obs:')).every(c => c.deduplicationKey.startsWith('hermes:default:'))).toBe(true)
  })

  it('P3: 150→0 last-seen 0 no observation; 0→40 one +40 weight-0 via discoverFromDb', async () => {
    const started = localDay(-1).unixSec
    const dbPath = createHermesDb(hermesHome)
    withTestDb(dbPath, (db) => {
      insertSession(db, { id: 'p3', inputTokens: 150, actualCost: 0.15, startedAt: started })
    })

    const first = await parseDiscovered()
    expect(first.sources.some(s => s.path.includes('p3'))).toBe(true)
    expect(first.calls).toHaveLength(1)
    expect(first.calls[0]!.deduplicationKey).toBe('hermes:default:p3')
    expect(getHermesCursor(loadHermesSessionLedger(), 'default', 'p3')?.lastSeen.inputTokens).toBe(150)

    withTestDb(dbPath, (db) => {
      updateSession(db, 'p3', { inputTokens: 0, actualCost: 0 })
    })
    const zeroed = await parseDiscovered()
    expect(zeroed.sources.some(s => s.path.endsWith('#hermes-session=p3') || s.path.includes('hermes-session=p3'))).toBe(true)
    expect(zeroed.calls.filter(c => c.deduplicationKey.includes(':obs:'))).toHaveLength(0)
    expect(getHermesCursor(loadHermesSessionLedger(), 'default', 'p3')?.lastSeen.inputTokens).toBe(0)
    expect(getHermesCursor(loadHermesSessionLedger(), 'default', 'p3')?.observations).toHaveLength(1)

    withTestDb(dbPath, (db) => {
      updateSession(db, 'p3', { inputTokens: 40, actualCost: 0.04 })
    })
    const grown = await parseDiscovered()
    const deltas = grown.calls.filter(c => c.deduplicationKey.includes(':obs:'))
    expect(deltas).toHaveLength(1)
    expect(deltas[0]).toMatchObject({
      inputTokens: 40,
      costUSD: 0.04,
      supplementaryAccounting: true,
      tools: [],
      userMessage: '',
    })
    expect(deltas[0]!.costIsEstimated).toBe(false)
    expect(deltas[0]!.deduplicationKey).toBe('hermes:default:p3:obs:1')
    expect(getHermesCursor(loadHermesSessionLedger(), 'default', 'p3')?.observations).toHaveLength(2)
    expect(getHermesCursor(loadHermesSessionLedger(), 'default', 'p3')?.observations.some(o => o.inputTokens < 0)).toBe(false)
  })

  it('P4: explicit $0 actual is recorded, not LiteLLM fallback', async () => {
    const dbPath = createHermesDb(hermesHome)
    withTestDb(dbPath, (db) => {
      insertSession(db, { id: 'p4', inputTokens: 80, actualCost: 0, startedAt: localDay(0).unixSec })
    })
    const { calls } = await parseDiscovered()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.costUSD).toBe(0)
    expect(calls[0]!.costIsEstimated).toBe(false)
    expect(getHermesCursor(loadHermesSessionLedger(), 'default', 'p4')?.lastSeen.costBasis).toBe('actual')
  })

  it('P5: seed from a cached lifetime call does not dump lifetime at now', async () => {
    const started = localDay(-1)
    const dbPath = createHermesDb(hermesHome)
    withTestDb(dbPath, (db) => {
      insertSession(db, { id: 'p5', inputTokens: 100, actualCost: 0.10, startedAt: started.unixSec })
    })

    const parser = await loadParser()
    const ledgerMod = await import('../../src/hermes-session-ledger.js')
    parser.clearSessionCache()
    await parser.parseAllSessions(undefined, 'hermes')

    await unlink(ledgerMod.hermesSessionLedgerPath())
    ledgerMod.resetHermesSessionLedgerForTests()

    parser.clearSessionCache()
    await parser.parseAllSessions(undefined, 'hermes')
    const seeded = ledgerMod.loadHermesSessionLedger()
    const cursor = ledgerMod.getHermesCursor(seeded, 'default', 'p5')
    expect(cursor?.observations).toHaveLength(1)
    expect(cursor?.observations[0]?.supplementaryAccounting).toBe(false)
    expect(cursor?.observations[0]?.inputTokens).toBe(100)
    expect(dateKey(cursor!.observations[0]!.timestamp)).toBe(started.key)
  })

  it('P5b: a cached included baseline stays subscription-covered after its source row vanishes', async () => {
    const started = localDay(-1)
    const dbPath = createHermesDb(hermesHome)
    withTestDb(dbPath, (db) => {
      insertSession(db, {
        id: 'p5-subscription',
        inputTokens: 100,
        estimatedCost: 0,
        costStatus: 'included',
        costSource: 'provider_reported',
        startedAt: started.unixSec,
      })
    })

    const parser = await loadParser()
    const ledgerMod = await import('../../src/hermes-session-ledger.js')
    const { filterProjectsByBillingRoute } = await import('../../src/billing-filter.js')

    // Pre-patch v3 warm-cache recovery classified every non-estimated baseline
    // as actual. Reproduce that durable cursor before the live included row is
    // parsed under the new code.
    await ledgerMod.recordHermesSnapshot({
      profile: 'default',
      sessionId: 'p5-subscription',
      startedAt: started.iso,
      observedAt: started.iso,
      tokens: { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      costUSD: 0,
      costBasis: 'actual',
    })

    parser.clearSessionCache()
    const upgraded = await parser.parseAllSessions(undefined, 'hermes')
    const upgradedCall = upgraded.flatMap(p => p.sessions).flatMap(s => s.turns).flatMap(t => t.assistantCalls)[0]!
    expect(upgradedCall.billing).toBe('subscription')
    expect(ledgerMod.loadHermesSessionLedger().cursors['default']!['p5-subscription']!.observations[0]!.costBasis).toBe('included')
    ledgerMod.resetHermesSessionLedgerForTests()

    // Once corrected, the observation is the only provenance left if Hermes
    // prunes the source row; the subscription filter must keep it.
    withTestDb(dbPath, (db) => db.prepare('DELETE FROM sessions WHERE id = ?').run('p5-subscription'))
    parser.clearSessionCache()
    const vanished = await parser.parseAllSessions(undefined, 'hermes')
    const call = vanished.flatMap(p => p.sessions).flatMap(s => s.turns).flatMap(t => t.assistantCalls)[0]!
    expect(call.billing).toBe('subscription')
    expect(filterProjectsByBillingRoute(vanished, { billing: 'subscription' }).flatMap(p => p.sessions)).toHaveLength(1)
  })

  it('P6: unwritable ledger is retryable and does not advance lastComputedDate', async () => {
    const dayD = localDay(-1)
    const dbPath = createHermesDb(hermesHome)
    withTestDb(dbPath, (db) => {
      insertSession(db, { id: 'p6', inputTokens: 100, actualCost: 0.10, startedAt: dayD.unixSec })
    })
    await mkdir(hermesSessionLedgerPath())

    const parser = await loadParser()
    parser.clearSessionCache()
    await parser.parseAllSessions(undefined, 'hermes')
    expect(parser.isSessionHydrationComplete()).toBe(false)

    const { ensureCacheHydrated, loadDailyCache } = await import('../../src/daily-cache.js')
    await ensureCacheHydrated(
      (range) => parser.parseAllSessions(range, 'hermes'),
      aggregateProjectsIntoDays,
      '',
      parser.isSessionHydrationComplete,
    )
    const daily = await loadDailyCache()
    expect(daily.lastComputedDate).not.toBe(dayD.key)
    expect(daily.complete).not.toBe(true)
  })

  it('P7: first observation key stays hermes:default:<id> with no :obs:', async () => {
    const dbPath = createHermesDb(hermesHome)
    withTestDb(dbPath, (db) => {
      insertSession(db, { id: 'p7-id', inputTokens: 10, actualCost: 0.01, startedAt: localDay(0).unixSec })
    })
    const { calls } = await parseDiscovered()
    expect(calls[0]!.deduplicationKey).toBe('hermes:default:p7-id')
    expect(calls[0]!.deduplicationKey.includes(':obs:')).toBe(false)
    expect(calls[0]!.turnId).toBe('p7-id:session')
    expect(calls[0]!.supplementaryAccounting).toBeUndefined()
  })

  it('P8: calculated-cost growth stays estimated on fresh and warm-cache reads', async () => {
    const started = localDay(-1).unixSec
    const dbPath = createHermesDb(hermesHome)
    withTestDb(dbPath, (db) => {
      insertSession(db, { id: 'calc-est', inputTokens: 100, startedAt: started })
    })

    const first = await parseDiscovered()
    expect(first.calls).toHaveLength(1)
    expect(first.calls[0]!.deduplicationKey).toBe('hermes:default:calc-est')
    expect(first.calls[0]!.costIsEstimated).toBe(true)
    expect(first.calls[0]!.costUSD).toBeGreaterThan(0)
    expect(getHermesCursor(loadHermesSessionLedger(), 'default', 'calc-est')?.lastSeen.costBasis).toBe('calculated')

    withTestDb(dbPath, (db) => {
      updateSession(db, 'calc-est', { inputTokens: 150 })
    })
    const grown = await parseDiscovered()
    const deltas = grown.calls.filter(c => c.deduplicationKey.includes(':obs:'))
    expect(deltas).toHaveLength(1)
    expect(deltas[0]!.deduplicationKey).toBe('hermes:default:calc-est:obs:1')
    expect(deltas[0]!.inputTokens).toBe(50)
    expect(deltas[0]!.costUSD).toBeGreaterThan(0)
    expect(deltas[0]!.costIsEstimated).toBe(true)
    expect(getHermesCursor(loadHermesSessionLedger(), 'default', 'calc-est')?.observations[1]?.costBasis).toBe('calculated')

    const parser = await loadParser()
    parser.clearSessionCache()
    const fresh = await parser.parseAllSessions(undefined, 'hermes')
    const freshCalls = fresh.flatMap(p => p.sessions.flatMap(s => s.turns.flatMap(t => t.assistantCalls)))
    const freshBaseline = freshCalls.find(c => c.deduplicationKey === 'hermes:default:calc-est')
    const freshDelta = freshCalls.find(c => c.deduplicationKey === 'hermes:default:calc-est:obs:1')
    expect(freshBaseline?.isEstimated).toBe(true)
    expect(freshDelta?.isEstimated).toBe(true)
    expect(freshDelta?.costUSD).toBeGreaterThan(0)

    const warm = await parser.parseAllSessions(undefined, 'hermes')
    const warmCalls = warm.flatMap(p => p.sessions.flatMap(s => s.turns.flatMap(t => t.assistantCalls)))
    const warmBaseline = warmCalls.find(c => c.deduplicationKey === 'hermes:default:calc-est')
    const warmDelta = warmCalls.find(c => c.deduplicationKey === 'hermes:default:calc-est:obs:1')
    expect(warmBaseline?.isEstimated).toBe(true)
    expect(warmDelta?.isEstimated).toBe(true)
    expect(warmDelta?.costUSD).toBeGreaterThan(0)
  })
})
