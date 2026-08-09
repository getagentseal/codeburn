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
}) => void, opts: { legacySchema?: boolean } = {}): string {
  const dbPath = join(tmpDir, 'threads.db')
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath)
  if (opts.legacySchema) {
    // Older Zed writes only the base columns; `folder_paths` was added later
    // via ALTER TABLE, so databases opened by old versions lack it.
    db.exec(`CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      data_type TEXT NOT NULL,
      data BLOB NOT NULL
    )`)
  } else {
    db.exec(`CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      data_type TEXT NOT NULL,
      data BLOB NOT NULL,
      parent_id TEXT, folder_paths TEXT, folder_paths_order TEXT, created_at TEXT
    )`)
  }
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
  folderPaths?: string[]
}): void {
  const data = opts.rawData ?? zstd!(Buffer.from(JSON.stringify(opts.thread ?? {})))
  const summary = opts.summary ?? 'a thread'
  const updatedAt = opts.updatedAt ?? '2026-06-20T10:00:00Z'
  const dataType = opts.dataType ?? 'zstd'
  if (opts.folderPaths !== undefined) {
    db.prepare('INSERT INTO threads (id, summary, updated_at, data_type, data, folder_paths) VALUES (?, ?, ?, ?, ?, ?)').run(
      opts.id, summary, updatedAt, dataType, data, opts.folderPaths.join('\n'),
    )
  } else {
    db.prepare('INSERT INTO threads (id, summary, updated_at, data_type, data) VALUES (?, ?, ?, ?, ?)').run(
      opts.id, summary, updatedAt, dataType, data,
    )
  }
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
    expect(calls[0]!.deduplicationKey).toBe('zed:thread-2:cumulative-remainder')
    expect(calls[0]!.inputTokens).toBe(5400)
    expect(calls[0]!.cacheReadInputTokens).toBe(20000)
  })

  it('tops threads up to the cumulative counter when the per-request map undercounts', async () => {
    // Mirrors a real thread: the map (keyed by user message) covered only some
    // requests while cumulative carried ~3x the tokens.
    const dbPath = buildDb((db) => {
      insertThread(db, {
        id: 'thread-real',
        thread: {
          model: { provider: 'zed.dev', model: 'gpt-5.4' },
          request_token_usage: {
            'msg-1': { input_tokens: 9514, output_tokens: 19 },
            'msg-2': { input_tokens: 2757, output_tokens: 310, cache_read_input_tokens: 33408 },
          },
          cumulative_token_usage: { input_tokens: 35464, output_tokens: 1868, cache_read_input_tokens: 140288 },
        },
      })
    })

    const calls = await collectCalls(dbPath)
    expect(calls.length).toBe(3)
    const remainder = calls.find(c => c.deduplicationKey === 'zed:thread-real:cumulative-remainder')
    expect(remainder).toBeDefined()
    expect(calls.reduce((s, c) => s + c.inputTokens, 0)).toBe(35464)
    expect(calls.reduce((s, c) => s + c.outputTokens, 0)).toBe(1868)
    expect(calls.reduce((s, c) => s + c.cacheReadInputTokens, 0)).toBe(140288)
  })

  it('skips non-zstd rows and malformed blobs without dropping healthy threads', async () => {
    const dbPath = buildDb((db) => {
      insertThread(db, { id: 'bad-type', dataType: 'protobuf', rawData: Buffer.from('{}') })
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

  it('reads legacy uncompressed json rows alongside zstd rows', async () => {
    const dbPath = buildDb((db) => {
      insertThread(db, {
        id: 'legacy',
        dataType: 'json',
        rawData: Buffer.from(JSON.stringify({
          model: { model: 'claude-sonnet-4-6' },
          request_token_usage: { 'req-1': { input_tokens: 40, output_tokens: 8 } },
        })),
      })
    })

    const calls = await collectCalls(dbPath)
    expect(calls.length).toBe(1)
    expect(calls[0]!.inputTokens).toBe(40)
    expect(calls[0]!.model).toBe('claude-sonnet-4-6')
  })

  it('attributes a single-folder thread to the recorded folder', async () => {
    const dbPath = buildDb((db) => {
      insertThread(db, {
        id: 'thread-single',
        folderPaths: ['/Users/dev/codeburn'],
        thread: {
          model: { provider: 'anthropic', model: 'claude-opus-4-8' },
          request_token_usage: { 'req-1': { input_tokens: 1200, output_tokens: 300 } },
        },
      })
    })

    const calls = await collectCalls(dbPath)
    expect(calls.length).toBe(1)
    expect(calls[0]!.projectPath).toBe('/Users/dev/codeburn')
    expect(calls[0]!.projectIdentity).toBe('/Users/dev/codeburn')
    expect(calls[0]!.project).toBe('codeburn')
  })

  it('groups multi-folder threads under a joined-basename project name', async () => {
    const dbPath = buildDb((db) => {
      insertThread(db, {
        id: 'thread-multi',
        folderPaths: ['/Users/dev/codeburn', '/Users/dev/website'],
        thread: {
          model: { model: 'claude-opus-4-8' },
          request_token_usage: { 'req-1': { input_tokens: 100, output_tokens: 50 } },
        },
      })
    })

    const calls = await collectCalls(dbPath)
    expect(calls.length).toBe(1)
    expect(calls[0]!.project).toBe('codeburn, website')
    expect(calls[0]!.projectPath).toBeUndefined()
    expect(calls[0]!.projectIdentity).toBe('/Users/dev/codeburn\n/Users/dev/website')
  })

  it('keeps the root-set identity sorted and normalized independently of the display label', async () => {
    const dbPath = buildDb((db) => {
      insertThread(db, {
        id: 'thread-unsorted',
        folderPaths: ['/Users/zeta/website', '/Users/alpha/codeburn/'],
        thread: {
          model: { model: 'claude-opus-4-8' },
          request_token_usage: { 'req-1': { input_tokens: 100, output_tokens: 50 } },
        },
      })
      insertThread(db, {
        id: 'thread-dup',
        folderPaths: ['/Users/alpha/codeburn', '/Users/alpha/codeburn'],
        thread: {
          model: { model: 'claude-opus-4-8' },
          request_token_usage: { 'req-1': { input_tokens: 100, output_tokens: 50 } },
        },
      })
    })

    const calls = await collectCalls(dbPath)
    expect(calls.find(c => c.sessionId === 'thread-dup')!.projectPath).toBe('/Users/alpha/codeburn')
    expect(calls.find(c => c.sessionId === 'thread-dup')!.projectIdentity).toBe('/Users/alpha/codeburn')
    // Stored order is preserved for the display label; the identity sorts the
    // roots so the same workspace is unambiguously keyed on any machine.
    expect(calls.find(c => c.sessionId === 'thread-unsorted')!.project).toBe('website, codeburn')
    expect(calls.find(c => c.sessionId === 'thread-unsorted')!.projectPath).toBeUndefined()
    expect(calls.find(c => c.sessionId === 'thread-unsorted')!.projectIdentity).toBe('/Users/alpha/codeburn\n/Users/zeta/website')
  })

  it('carries identical basenames under distinct roots as distinct identities', async () => {
    const dbPath = buildDb((db) => {
      insertThread(db, {
        id: 'thread-alice',
        folderPaths: ['/Users/alice/repo'],
        thread: {
          model: { model: 'claude-opus-4-8' },
          request_token_usage: { 'req-1': { input_tokens: 100, output_tokens: 50 } },
        },
      })
      insertThread(db, {
        id: 'thread-bob',
        folderPaths: ['/Users/bob/repo'],
        thread: {
          model: { model: 'claude-opus-4-8' },
          request_token_usage: { 'req-1': { input_tokens: 100, output_tokens: 50 } },
        },
      })
    })

    const calls = await collectCalls(dbPath)
    expect(calls.length).toBe(2)
    const alice = calls.find(c => c.sessionId === 'thread-alice')!
    const bob = calls.find(c => c.sessionId === 'thread-bob')!
    expect(alice.project).toBe('repo')
    expect(bob.project).toBe('repo')
    expect(alice.projectPath).toBe('/Users/alice/repo')
    expect(bob.projectPath).toBe('/Users/bob/repo')
    expect(alice.projectIdentity).toBe('/Users/alice/repo')
    expect(bob.projectIdentity).toBe('/Users/bob/repo')
    expect(alice.projectPath).not.toBe(bob.projectPath)
  })

  it('joins multi-folder basenames in stored order and drops empty names', async () => {
    const dbPath = buildDb((db) => {
      insertThread(db, {
        id: 'thread-triple',
        folderPaths: ['/Users/dev/codeburn', '/Users/dev/design', '/Users/dev/website'],
        thread: {
          model: { model: 'claude-opus-4-8' },
          request_token_usage: { 'req-1': { input_tokens: 100, output_tokens: 50 } },
        },
      })
      insertThread(db, {
        id: 'thread-root-only',
        folderPaths: ['/', '/Users/dev/website'],
        thread: {
          model: { model: 'claude-opus-4-8' },
          request_token_usage: { 'req-1': { input_tokens: 100, output_tokens: 50 } },
        },
      })
    })

    const calls = await collectCalls(dbPath)
    expect(calls.length).toBe(2)
    expect(calls.find(c => c.sessionId === 'thread-triple')!.project).toBe('codeburn, design, website')
    expect(calls.find(c => c.sessionId === 'thread-triple')!.projectPath).toBeUndefined()
    expect(calls.find(c => c.sessionId === 'thread-triple')!.projectIdentity).toBe('/Users/dev/codeburn\n/Users/dev/design\n/Users/dev/website')
    expect(calls.find(c => c.sessionId === 'thread-root-only')!.project).toBe('website')
    // A bare '/' root keeps itself in the identity (it is the filesystem
    // root, not an empty string) so root-only workspaces stay keyable.
    expect(calls.find(c => c.sessionId === 'thread-root-only')!.projectPath).toBeUndefined()
    expect(calls.find(c => c.sessionId === 'thread-root-only')!.projectIdentity).toBe('/\n/Users/dev/website')
  })

  it('falls back to the zed bucket when folder_paths is empty or absent', async () => {
    const dbPath = buildDb((db) => {
      insertThread(db, {
        id: 'thread-empty',
        folderPaths: [],
        thread: {
          model: { model: 'claude-opus-4-8' },
          request_token_usage: { 'req-1': { input_tokens: 100, output_tokens: 50 } },
        },
      })
      insertThread(db, {
        id: 'thread-absent',
        thread: {
          model: { model: 'claude-opus-4-8' },
          request_token_usage: { 'req-1': { input_tokens: 100, output_tokens: 50 } },
        },
      })
    })

    const calls = await collectCalls(dbPath)
    expect(calls.length).toBe(2)
    expect(calls.every(c => c.projectPath === undefined && c.project === undefined)).toBe(true)
  })

  it('tolerates whitespace and trailing newlines in folder_paths', async () => {
    const dbPath = buildDb((db) => {
      insertThread(db, {
        id: 'thread-messy',
        folderPaths: ['  /Users/dev/codeburn  ', ''],
        thread: {
          model: { model: 'claude-opus-4-8' },
          request_token_usage: { 'req-1': { input_tokens: 100, output_tokens: 50 } },
        },
      })
    })

    const calls = await collectCalls(dbPath)
    expect(calls.length).toBe(1)
    expect(calls[0]!.projectPath).toBe('/Users/dev/codeburn')
    expect(calls[0]!.project).toBe('codeburn')
  })

  it('still parses databases without the folder_paths column (older Zed schemas)', async () => {
    const dbPath = buildDb((db) => {
      insertThread(db, {
        id: 'thread-old-schema',
        thread: {
          model: { model: 'claude-sonnet-4-6' },
          request_token_usage: { 'req-1': { input_tokens: 40, output_tokens: 8 } },
        },
      })
    }, { legacySchema: true })

    const calls = await collectCalls(dbPath)
    expect(calls.length).toBe(1)
    expect(calls[0]!.model).toBe('claude-sonnet-4-6')
    expect(calls[0]!.projectPath).toBeUndefined()
    expect(calls[0]!.project).toBeUndefined()
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
