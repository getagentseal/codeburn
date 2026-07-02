import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRequire } from 'node:module'
import zlib from 'zlib'

import { createZedProvider } from '../../src/providers/zed.js'
import { isSqliteAvailable } from '../../src/sqlite.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

const requireForTest = createRequire(import.meta.url)

const zstd = (zlib as { zstdCompressSync?: (buf: Buffer) => Buffer }).zstdCompressSync

const skipReason = !isSqliteAvailable()
  ? 'node:sqlite not available — needs Node 22+; skipping'
  : !zstd
    ? 'zlib zstd not available — needs Node 22.15+; skipping'
    : null

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'zed-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function buildDb(fn: (db: {
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): void }
  close(): void
}) => void): string {
  const dbPath = join(tmpDir, 'threads.db')
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath)
  db.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    data_type TEXT NOT NULL,
    data BLOB NOT NULL,
    parent_id TEXT, folder_paths TEXT, folder_paths_order TEXT, created_at TEXT
  )`)
  fn(db)
  db.close()
  return dbPath
}

function insertThread(db: {
  prepare(sql: string): { run(...params: unknown[]): void }
}, opts: {
  id: string
  summary?: string
  updatedAt?: string
  dataType?: string
  thread?: unknown
  rawData?: Buffer
}): void {
  const data = opts.rawData ?? zstd!(Buffer.from(JSON.stringify(opts.thread ?? {})))
  db.prepare('INSERT INTO threads (id, summary, updated_at, data_type, data) VALUES (?, ?, ?, ?, ?)').run(
    opts.id,
    opts.summary ?? 'a thread',
    opts.updatedAt ?? '2026-06-20T10:00:00Z',
    opts.dataType ?? 'zstd',
    data,
  )
}

async function collectCalls(dbPath: string, seenKeys = new Set<string>()): Promise<ParsedProviderCall[]> {
  const provider = createZedProvider(dbPath)
  const sources = await provider.discoverSessions()
  const calls: ParsedProviderCall[] = []
  for (const source of sources) {
    for await (const call of provider.createSessionParser(source, seenKeys).parse()) {
      calls.push(call)
    }
  }
  return calls
}

describe.skipIf(skipReason !== null)('zed provider (#480)', () => {
  it('emits one call per request with exact Anthropic-shaped token fields', async () => {
    const dbPath = buildDb((db) => {
      insertThread(db, {
        id: 'thread-1',
        summary: 'refactor the parser',
        updatedAt: '2026-06-21T09:30:00Z',
        thread: {
          model: { provider: 'anthropic', model: 'claude-opus-4-8' },
          request_token_usage: {
            'req-1': { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 5000, cache_read_input_tokens: 90000 },
            'req-2': { input_tokens: 800, output_tokens: 150, cache_creation_input_tokens: 0, cache_read_input_tokens: 95000 },
          },
          cumulative_token_usage: { input_tokens: 2000, output_tokens: 450 },
        },
      })
    })

    const calls = await collectCalls(dbPath)
    expect(calls.length).toBe(2)
    const first = calls.find(c => c.deduplicationKey === 'zed:thread-1:req-1')
    expect(first).toBeDefined()
    expect(first!.inputTokens).toBe(1200)
    expect(first!.outputTokens).toBe(300)
    expect(first!.cacheCreationInputTokens).toBe(5000)
    expect(first!.cacheReadInputTokens).toBe(90000)
    expect(first!.model).toBe('claude-opus-4-8')
    expect(first!.costUSD).toBeGreaterThan(0)
    expect(first!.sessionId).toBe('thread-1')
    expect(first!.userMessage).toBe('refactor the parser')
    expect(first!.timestamp).toBe('2026-06-21T09:30:00.000Z')
    // Cumulative must not be counted on top of per-request entries.
    expect(calls.reduce((s, c) => s + c.inputTokens, 0)).toBe(2000)
  })

  it('falls back to cumulative_token_usage when the per-request map is empty', async () => {
    const dbPath = buildDb((db) => {
      insertThread(db, {
        id: 'thread-2',
        thread: {
          model: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
          request_token_usage: {},
          cumulative_token_usage: { input_tokens: 5400, output_tokens: 900, cache_read_input_tokens: 20000 },
        },
      })
    })

    const calls = await collectCalls(dbPath)
    expect(calls.length).toBe(1)
    expect(calls[0]!.deduplicationKey).toBe('zed:thread-2:cumulative')
    expect(calls[0]!.inputTokens).toBe(5400)
    expect(calls[0]!.cacheReadInputTokens).toBe(20000)
  })

  it('skips non-zstd rows and malformed blobs without dropping healthy threads', async () => {
    const dbPath = buildDb((db) => {
      insertThread(db, { id: 'bad-type', dataType: 'json', rawData: Buffer.from('{}') })
      insertThread(db, { id: 'bad-blob', rawData: Buffer.from('not zstd at all') })
      insertThread(db, {
        id: 'good',
        thread: {
          model: { model: 'claude-opus-4-8' },
          request_token_usage: { 'req-1': { input_tokens: 10, output_tokens: 5 } },
        },
      })
    })

    const calls = await collectCalls(dbPath)
    expect(calls.length).toBe(1)
    expect(calls[0]!.sessionId).toBe('good')
  })

  it('dedupes across repeat parses via the shared seenKeys set', async () => {
    const dbPath = buildDb((db) => {
      insertThread(db, {
        id: 'thread-3',
        thread: {
          model: { model: 'claude-opus-4-8' },
          request_token_usage: { 'req-1': { input_tokens: 100, output_tokens: 50 } },
        },
      })
    })

    const seen = new Set<string>()
    expect((await collectCalls(dbPath, seen)).length).toBe(1)
    expect((await collectCalls(dbPath, seen)).length).toBe(0)
  })

  it('skips threads whose usage is entirely zero instead of emitting empty calls', async () => {
    const dbPath = buildDb((db) => {
      insertThread(db, {
        id: 'thread-4',
        thread: {
          model: { model: 'claude-opus-4-8' },
          request_token_usage: { 'req-1': { input_tokens: 0, output_tokens: 0 } },
          cumulative_token_usage: { input_tokens: 0, output_tokens: 0 },
        },
      })
    })

    expect((await collectCalls(dbPath)).length).toBe(0)
  })

  it('discovers nothing when the database does not exist', async () => {
    const provider = createZedProvider(join(tmpDir, 'missing.db'))
    expect(await provider.discoverSessions()).toEqual([])
  })
})
