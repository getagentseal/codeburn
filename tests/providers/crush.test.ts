import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'node:module'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { isSqliteAvailable } from '../../src/sqlite.js'
import { createCrushProvider } from '../../src/providers/crush.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

const requireForTest = createRequire(import.meta.url)

type TestDb = {
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): void }
  close(): void
}

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'crush-test-'))
})

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

// CREATE TABLE statements taken verbatim from charmbracelet/crush@v0.66.1
// internal/db/migrations/20250424200609_initial.sql, with subsequent ALTERs
// folded in (summary_message_id, provider on messages, is_summary_message,
// todos on sessions). Keeping the literal upstream column ordering and
// constraints makes drift easy to spot.
function createCrushDb(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, 'crush.db')
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      parent_session_id TEXT,
      title TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
      prompt_tokens INTEGER NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
      completion_tokens INTEGER NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
      cost REAL NOT NULL DEFAULT 0.0 CHECK (cost >= 0.0),
      updated_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      summary_message_id TEXT,
      todos TEXT
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      parts TEXT NOT NULL DEFAULT '[]',
      model TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER,
      provider TEXT,
      is_summary_message INTEGER DEFAULT 0 NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
    )
  `)
  db.close()
  return dbPath
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

type SessionFixture = {
  id: string
  parentId?: string | null
  promptTokens?: number
  completionTokens?: number
  cost?: number
  createdAt?: number
  updatedAt?: number
  messageCount?: number
}

function insertSession(db: TestDb, s: SessionFixture): void {
  db.prepare(`
    INSERT INTO sessions (id, parent_session_id, title, message_count, prompt_tokens, completion_tokens, cost, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    s.id,
    s.parentId ?? null,
    'test session',
    s.messageCount ?? 0,
    s.promptTokens ?? 0,
    s.completionTokens ?? 0,
    s.cost ?? 0,
    s.createdAt ?? 1_700_000_000,
    s.updatedAt ?? s.createdAt ?? 1_700_000_000,
  )
}

function insertMessage(db: TestDb, sessionId: string, role: string, model: string | null, id: string): void {
  db.prepare(`
    INSERT INTO messages (id, session_id, role, parts, model, created_at, updated_at)
    VALUES (?, ?, ?, '[]', ?, ?, ?)
  `).run(id, sessionId, role, model, 1_700_000_000, 1_700_000_000)
}

async function writeRegistry(globalDataDir: string, entries: Record<string, { path: string; data_dir: string }>): Promise<void> {
  await mkdir(globalDataDir, { recursive: true })
  await writeFile(join(globalDataDir, 'projects.json'), JSON.stringify(entries))
}

async function collect(parser: { parse(): AsyncGenerator<ParsedProviderCall> }): Promise<ParsedProviderCall[]> {
  const out: ParsedProviderCall[] = []
  for await (const call of parser.parse()) out.push(call)
  return out
}

describe('crush provider', () => {
  it('reports correct identity', () => {
    const p = createCrushProvider()
    expect(p.name).toBe('crush')
    expect(p.displayName).toBe('Crush')
    expect(p.modelDisplayName('gpt-5')).toBe('gpt-5')
  })

  it('returns no sessions when registry is missing', async () => {
    const globalData = join(tmpRoot, 'crush-global')
    process.env['CRUSH_GLOBAL_DATA'] = globalData
    const p = createCrushProvider()
    const sessions = await p.discoverSessions()
    expect(sessions).toEqual([])
  })

  it('returns no sessions when registry is malformed JSON', async () => {
    const globalData = join(tmpRoot, 'crush-global')
    await mkdir(globalData, { recursive: true })
    await writeFile(join(globalData, 'projects.json'), '{ not json')
    process.env['CRUSH_GLOBAL_DATA'] = globalData
    const p = createCrushProvider()
    const sessions = await p.discoverSessions()
    expect(sessions).toEqual([])
  })

  it('discovers root sessions with cost or tokens, skipping zero rows and child sessions', async () => {
    if (!isSqliteAvailable()) return

    const projectDir = join(tmpRoot, 'project-a')
    const dbPath = createCrushDb(join(projectDir, '.crush'))
    withTestDb(dbPath, db => {
      insertSession(db, { id: 'root-with-cost', cost: 0.42, promptTokens: 100, completionTokens: 50, createdAt: 1_700_000_001 })
      insertSession(db, { id: 'root-no-spend', cost: 0, promptTokens: 0, completionTokens: 0, createdAt: 1_700_000_002 })
      insertSession(db, { id: 'child', parentId: 'root-with-cost', cost: 0.01, createdAt: 1_700_000_003 })
      insertSession(db, { id: 'root-tokens-only', cost: 0, promptTokens: 5, completionTokens: 5, createdAt: 1_700_000_004 })
    })

    const globalData = join(tmpRoot, 'crush-global')
    await writeRegistry(globalData, {
      'proj-a': { path: projectDir, data_dir: '.crush' },
    })
    process.env['CRUSH_GLOBAL_DATA'] = globalData

    const p = createCrushProvider()
    const sessions = await p.discoverSessions()
    const ids = sessions.map(s => s.path.split(':').pop()).sort()
    expect(ids).toEqual(['root-tokens-only', 'root-with-cost'])
    expect(sessions.every(s => s.provider === 'crush')).toBe(true)
  })

  it('parses a session into a ParsedProviderCall with real tokens, cost, and dominant model', async () => {
    if (!isSqliteAvailable()) return

    const projectDir = join(tmpRoot, 'project-b')
    const dbPath = createCrushDb(join(projectDir, '.crush'))
    withTestDb(dbPath, db => {
      insertSession(db, {
        id: 'sess-1',
        promptTokens: 1234,
        completionTokens: 567,
        cost: 0.0789,
        createdAt: 1_700_000_010,
        updatedAt: 1_700_000_999,
      })
      // Most-used model wins.
      insertMessage(db, 'sess-1', 'assistant', 'claude-sonnet-4-6', 'm1')
      insertMessage(db, 'sess-1', 'assistant', 'claude-sonnet-4-6', 'm2')
      insertMessage(db, 'sess-1', 'assistant', 'gpt-5', 'm3')
    })

    const globalData = join(tmpRoot, 'crush-global')
    await writeRegistry(globalData, {
      'proj-b': { path: projectDir, data_dir: '.crush' },
    })
    process.env['CRUSH_GLOBAL_DATA'] = globalData

    const p = createCrushProvider()
    const sources = await p.discoverSessions()
    expect(sources).toHaveLength(1)

    const calls = await collect(p.createSessionParser(sources[0]!, new Set()))
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.provider).toBe('crush')
    expect(call.model).toBe('claude-sonnet-4-6')
    expect(call.inputTokens).toBe(1234)
    expect(call.outputTokens).toBe(567)
    expect(call.costUSD).toBeCloseTo(0.0789, 6)
    expect(call.sessionId).toBe('sess-1')
    expect(call.deduplicationKey).toBe('crush:sess-1')
    // Crush stores epoch seconds; 1_700_000_999 sec → 2023-11-14T22:29:59.000Z.
    expect(call.timestamp).toBe(new Date(1_700_000_999 * 1000).toISOString())
  })

  it('falls back to "unknown" when no message has a model', async () => {
    if (!isSqliteAvailable()) return

    const projectDir = join(tmpRoot, 'project-c')
    const dbPath = createCrushDb(join(projectDir, '.crush'))
    withTestDb(dbPath, db => {
      insertSession(db, { id: 'sess-no-model', cost: 0.05, promptTokens: 10, completionTokens: 5, createdAt: 1_700_000_500 })
      insertMessage(db, 'sess-no-model', 'user', null, 'm1')
      insertMessage(db, 'sess-no-model', 'assistant', null, 'm2')
    })

    const globalData = join(tmpRoot, 'crush-global')
    await writeRegistry(globalData, {
      'proj-c': { path: projectDir, data_dir: '.crush' },
    })
    process.env['CRUSH_GLOBAL_DATA'] = globalData

    const p = createCrushProvider()
    const sources = await p.discoverSessions()
    const calls = await collect(p.createSessionParser(sources[0]!, new Set()))
    expect(calls[0]!.model).toBe('unknown')
  })

  it('respects seenKeys for deduplication', async () => {
    if (!isSqliteAvailable()) return

    const projectDir = join(tmpRoot, 'project-d')
    const dbPath = createCrushDb(join(projectDir, '.crush'))
    withTestDb(dbPath, db => {
      insertSession(db, { id: 'sess-dup', cost: 0.10, promptTokens: 100, completionTokens: 50, createdAt: 1_700_000_700 })
    })

    const globalData = join(tmpRoot, 'crush-global')
    await writeRegistry(globalData, {
      'proj-d': { path: projectDir, data_dir: '.crush' },
    })
    process.env['CRUSH_GLOBAL_DATA'] = globalData

    const p = createCrushProvider()
    const sources = await p.discoverSessions()
    const seen = new Set<string>()
    const first = await collect(p.createSessionParser(sources[0]!, seen))
    expect(first).toHaveLength(1)

    const second = await collect(p.createSessionParser(sources[0]!, seen))
    expect(second).toHaveLength(0)
  })

  it('accepts an array-shaped projects.json (legacy format)', async () => {
    if (!isSqliteAvailable()) return

    const projectDir = join(tmpRoot, 'project-e')
    const dbPath = createCrushDb(join(projectDir, '.crush'))
    withTestDb(dbPath, db => {
      insertSession(db, { id: 'sess-arr', cost: 0.01, promptTokens: 1, completionTokens: 1, createdAt: 1_700_000_800 })
    })

    const globalData = join(tmpRoot, 'crush-global')
    await mkdir(globalData, { recursive: true })
    await writeFile(
      join(globalData, 'projects.json'),
      JSON.stringify([{ path: projectDir, data_dir: '.crush' }]),
    )
    process.env['CRUSH_GLOBAL_DATA'] = globalData

    const p = createCrushProvider()
    const sources = await p.discoverSessions()
    expect(sources).toHaveLength(1)
  })

  it('ignores registry entries whose db is missing', async () => {
    if (!isSqliteAvailable()) return

    const globalData = join(tmpRoot, 'crush-global')
    await writeRegistry(globalData, {
      'ghost': { path: join(tmpRoot, 'does-not-exist'), data_dir: '.crush' },
    })
    process.env['CRUSH_GLOBAL_DATA'] = globalData

    const p = createCrushProvider()
    const sources = await p.discoverSessions()
    expect(sources).toEqual([])
  })

  it('is registered via getAllProviders', async () => {
    if (!isSqliteAvailable()) return
    const { getAllProviders } = await import('../../src/providers/index.js')
    const providers = await getAllProviders()
    const found = providers.find(p => p.name === 'crush')
    expect(found).toBeDefined()
    expect(found!.displayName).toBe('Crush')
  })
})
