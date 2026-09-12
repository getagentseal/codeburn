/**
 * Tests for cursor-agent store.db discovery and reconstruction (issue #986).
 *
 * Covers all acceptance-criteria items and the test matrix from the issue:
 *   - Empty chats directory
 *   - Valid minimal store (single-turn)
 *   - Multi-turn blob graph
 *   - Malformed hex metadata
 *   - Missing / invalid root-blob references
 *   - Unknown protobuf fields and message block types
 *   - Seconds vs milliseconds timestamp normalization
 *   - Exact, partial, gauge-only, and absent token data
 *   - Store + transcript deduplication (one set of calls per session)
 *   - Transcript fallback after store decoding fails
 *   - WAL-aware cache invalidation
 *   - blobEncryptionKey redaction (must never surface)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { createCursorAgentProvider } from '../../src/providers/cursor-agent.js'
import { isSqliteAvailable } from '../../src/sqlite.js'
import type { ParsedProviderCall, Provider, SessionSource } from '../../src/providers/types.js'
import { estimateTokensFromChars } from '../../src/token-estimate.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const skipUnlessSqlite = isSqliteAvailable() ? describe : describe.skip

/** A real 64-hex-char blob ID used throughout the tests. */
const ROOT_BLOB_ID = 'a'.repeat(64)
const SECOND_BLOB_ID = 'b'.repeat(64)
const THIRD_BLOB_ID = 'c'.repeat(64)
const FOURTH_BLOB_ID = 'd'.repeat(64)

/** A valid-looking UUID used as the session ID. */
const SESSION_UUID = '11111111-2222-3333-4444-555555555555'
/** A second session UUID for multi-session tests. */
const SESSION_UUID_2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

type TestDb = {
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): void }
  close(): void
}

function openWritableDb(dbPath: string): TestDb {
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (p: string) => TestDb }
  return new DatabaseSync(dbPath)
}

/** Hex-encodes a UTF-8 string to produce the wire format used in meta['0']. */
function hexEncodeJson(obj: unknown): string {
  const json = JSON.stringify(obj)
  return Buffer.from(json, 'utf-8').toString('hex')
}

/** Creates a minimal valid store.db at the given path. */
function createMinimalStore(
  dbPath: string,
  opts: {
    agentId?: string
    latestRootBlobId?: string
    createdAt?: number
    lastUsedModel?: string
    blobs?: Array<{ id: string; data: unknown }>
    blobEncryptionKey?: string
  } = {},
): void {
  const db = openWritableDb(dbPath)
  // Use DROP TABLE + CREATE to support re-writing the same path in tests.
  db.exec('DROP TABLE IF EXISTS meta')
  db.exec('DROP TABLE IF EXISTS blobs')
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)')

  const metaValue = hexEncodeJson({
    agentId: opts.agentId ?? SESSION_UUID,
    latestRootBlobId: opts.latestRootBlobId ?? ROOT_BLOB_ID,
    name: 'Test session',
    mode: 'agent',
    createdAt: opts.createdAt ?? 1_700_000_000_000,
    lastUsedModel: opts.lastUsedModel ?? 'claude-4.6-sonnet',
    // Include blobEncryptionKey in the raw DB data to test that it never
    // leaks out of the provider.
    ...(opts.blobEncryptionKey !== undefined ? { blobEncryptionKey: opts.blobEncryptionKey } : { blobEncryptionKey: 'super-secret-key-do-not-leak' }),
  })
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('0', metaValue)

  for (const blob of opts.blobs ?? []) {
    db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run(blob.id, JSON.stringify(blob.data))
  }

  db.close()
}

/** Creates a single-turn store with one user blob + one assistant blob. */
function createSingleTurnStore(
  dbPath: string,
  opts: {
    agentId?: string
    userText?: string
    assistantText?: string
    model?: string
    inputTokens?: number
    outputTokens?: number
    timestamp?: number
  } = {},
): void {
  const userText = opts.userText ?? 'Hello from user'
  const assistantText = opts.assistantText ?? 'Hello from assistant'
  const model = opts.model ?? 'claude-4.6-sonnet'

  createMinimalStore(dbPath, {
    agentId: opts.agentId,
    latestRootBlobId: ROOT_BLOB_ID,
    blobs: [
      {
        id: ROOT_BLOB_ID,
        data: {
          role: 'user',
          text: userText,
          timestamp: opts.timestamp ?? 1_700_000_000_000,
          nextBlobId: SECOND_BLOB_ID,
        },
      },
      {
        id: SECOND_BLOB_ID,
        data: {
          role: 'assistant',
          text: assistantText,
          model,
          ...(opts.inputTokens !== undefined ? { inputTokens: opts.inputTokens } : {}),
          ...(opts.outputTokens !== undefined ? { outputTokens: opts.outputTokens } : {}),
          timestamp: opts.timestamp ?? 1_700_000_000_001,
        },
      },
    ],
  })
}

let tempRoots: string[] = []

beforeEach(() => {
  tempRoots = []
})

afterEach(async () => {
  // On Windows, SQLite may hold a brief lock on closed DB files. Retry the
  // cleanup a few times before giving up rather than failing the test suite.
  for (const dir of tempRoots) {
    if (!existsSync(dir)) continue
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true })
        break
      } catch {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
  }
})

async function makeBaseDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cursor-agent-store-test-'))
  tempRoots.push(dir)
  return dir
}

async function collectCalls(
  provider: Provider,
  source: SessionSource,
  seenKeys: Set<string> = new Set(),
): Promise<ParsedProviderCall[]> {
  const calls: ParsedProviderCall[] = []
  for await (const call of provider.createSessionParser(source, seenKeys).parse()) {
    calls.push(call)
  }
  return calls
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

skipUnlessSqlite('cursor-agent store.db: discovery', () => {
  it('returns no store sources when chats dir is absent', async () => {
    const baseDir = await makeBaseDir()
    const provider = createCursorAgentProvider(baseDir)
    const sources = await provider.discoverSessions()
    const storeSources = sources.filter(s => s.path.startsWith('cursor-agent-store:'))
    expect(storeSources).toHaveLength(0)
  })

  it('returns no store sources when chats dir is empty', async () => {
    const baseDir = await makeBaseDir()
    await mkdir(join(baseDir, 'chats'), { recursive: true })
    const provider = createCursorAgentProvider(baseDir)
    const sources = await provider.discoverSessions()
    const storeSources = sources.filter(s => s.path.startsWith('cursor-agent-store:'))
    expect(storeSources).toHaveLength(0)
  })

  it('discovers a store.db under chats/<hash>/<uuid>/store.db', async () => {
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'abc123', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })
    createSingleTurnStore(join(storeDir, 'store.db'))

    const provider = createCursorAgentProvider(baseDir)
    const sources = await provider.discoverSessions()
    const storeSources = sources.filter(s => s.path.startsWith('cursor-agent-store:'))

    expect(storeSources).toHaveLength(1)
    expect(storeSources[0]!.provider).toBe('cursor-agent')
    expect(storeSources[0]!.path).toContain(SESSION_UUID)
  })

  it('discovers multiple sessions across different hash dirs', async () => {
    const baseDir = await makeBaseDir()

    for (const [hash, uuid] of [['hash1', SESSION_UUID], ['hash2', SESSION_UUID_2]]) {
      const storeDir = join(baseDir, 'chats', hash, uuid)
      await mkdir(storeDir, { recursive: true })
      createSingleTurnStore(join(storeDir, 'store.db'), { agentId: uuid })
    }

    const provider = createCursorAgentProvider(baseDir)
    const sources = await provider.discoverSessions()
    const storeSources = sources.filter(s => s.path.startsWith('cursor-agent-store:'))

    expect(storeSources).toHaveLength(2)
  })

  it('skips directories whose name is not a UUID', async () => {
    const baseDir = await makeBaseDir()
    const hashDir = join(baseDir, 'chats', 'hashXYZ')
    await mkdir(join(hashDir, 'not-a-uuid'), { recursive: true })
    writeFileSync(join(hashDir, 'not-a-uuid', 'store.db'), '')

    const provider = createCursorAgentProvider(baseDir)
    const sources = await provider.discoverSessions()
    const storeSources = sources.filter(s => s.path.startsWith('cursor-agent-store:'))
    expect(storeSources).toHaveLength(0)
  })

  it('skips session dirs with no store.db file', async () => {
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'hashABC', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })
    // No store.db written

    const provider = createCursorAgentProvider(baseDir)
    const sources = await provider.discoverSessions()
    const storeSources = sources.filter(s => s.path.startsWith('cursor-agent-store:'))
    expect(storeSources).toHaveLength(0)
  })

  it('probeRoots includes the chats directory', async () => {
    const baseDir = await makeBaseDir()
    const provider = createCursorAgentProvider(baseDir)
    const roots = await provider.probeRoots!()
    const chatsRoot = roots.find(r => r.label === 'chats')
    expect(chatsRoot).toBeDefined()
    expect(chatsRoot!.path).toContain('chats')
  })
})

skipUnlessSqlite('cursor-agent store.db: valid minimal store', () => {
  it('parses a single-turn store and yields one call', async () => {
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })
    createSingleTurnStore(join(storeDir, 'store.db'))

    const provider = createCursorAgentProvider(baseDir)
    const sources = await provider.discoverSessions()
    const storeSources = sources.filter(s => s.path.startsWith('cursor-agent-store:'))
    expect(storeSources).toHaveLength(1)

    const calls = await collectCalls(provider, storeSources[0]!)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.provider).toBe('cursor-agent')
    expect(calls[0]!.sessionId).toBe(SESSION_UUID)
    expect(calls[0]!.userMessage).toBe('Hello from user')
    expect(calls[0]!.outputTokens).toBeGreaterThan(0)
  })

  it('uses lastUsedModel from metadata when blob has no model', async () => {
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })

    createMinimalStore(join(storeDir, 'store.db'), {
      lastUsedModel: 'claude-4.6-sonnet',
      blobs: [
        { id: ROOT_BLOB_ID, data: { role: 'user', text: 'hi', nextBlobId: SECOND_BLOB_ID } },
        { id: SECOND_BLOB_ID, data: { role: 'assistant', text: 'hello' } },
      ],
    })

    const provider = createCursorAgentProvider(baseDir)
    const sources = (await provider.discoverSessions()).filter(s => s.path.startsWith('cursor-agent-store:'))
    const calls = await collectCalls(provider, sources[0]!)
    expect(calls).toHaveLength(1)
    // Model in blob takes precedence; if absent the session model is used
    expect(calls[0]!.model).not.toBe('')
  })

  it('emits costUSD > 0 for a turn with tokens', async () => {
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })
    createSingleTurnStore(join(storeDir, 'store.db'), { inputTokens: 100, outputTokens: 200 })

    const provider = createCursorAgentProvider(baseDir)
    const sources = (await provider.discoverSessions()).filter(s => s.path.startsWith('cursor-agent-store:'))
    const calls = await collectCalls(provider, sources[0]!)
    expect(calls[0]!.costUSD).toBeGreaterThan(0)
  })
})

skipUnlessSqlite('cursor-agent store.db: multi-turn blob graph', () => {
  it('reconstructs three turns in order', async () => {
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })

    createMinimalStore(join(storeDir, 'store.db'), {
      latestRootBlobId: ROOT_BLOB_ID,
      blobs: [
        {
          id: ROOT_BLOB_ID,
          data: { role: 'user', text: 'Turn 1 user', nextBlobId: SECOND_BLOB_ID },
        },
        {
          id: SECOND_BLOB_ID,
          data: { role: 'assistant', text: 'Turn 1 assistant', nextBlobId: THIRD_BLOB_ID },
        },
        {
          id: THIRD_BLOB_ID,
          data: { role: 'user', text: 'Turn 2 user', nextBlobId: FOURTH_BLOB_ID },
        },
        {
          id: FOURTH_BLOB_ID,
          data: { role: 'assistant', text: 'Turn 2 assistant' },
        },
      ],
    })

    const provider = createCursorAgentProvider(baseDir)
    const sources = (await provider.discoverSessions()).filter(s => s.path.startsWith('cursor-agent-store:'))
    const calls = await collectCalls(provider, sources[0]!)

    expect(calls).toHaveLength(2)
    expect(calls[0]!.userMessage).toBe('Turn 1 user')
    expect(calls[1]!.userMessage).toBe('Turn 2 user')
  })

  it('follows childBlobIds for branching graphs', async () => {
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })

    // Root is a container blob with childBlobIds instead of nextBlobId
    createMinimalStore(join(storeDir, 'store.db'), {
      latestRootBlobId: ROOT_BLOB_ID,
      blobs: [
        {
          id: ROOT_BLOB_ID,
          data: { childBlobIds: [SECOND_BLOB_ID, THIRD_BLOB_ID] },
        },
        {
          id: SECOND_BLOB_ID,
          data: { role: 'user', text: 'child user' },
        },
        {
          id: THIRD_BLOB_ID,
          data: { role: 'assistant', text: 'child assistant' },
        },
      ],
    })

    const provider = createCursorAgentProvider(baseDir)
    const sources = (await provider.discoverSessions()).filter(s => s.path.startsWith('cursor-agent-store:'))
    const calls = await collectCalls(provider, sources[0]!)
    // Should reconstruct at least one turn from the children
    expect(calls.length).toBeGreaterThanOrEqual(1)
  })

  it('deduplication keys are stable across re-parses', async () => {
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })
    createSingleTurnStore(join(storeDir, 'store.db'))

    const provider = createCursorAgentProvider(baseDir)
    const sources = (await provider.discoverSessions()).filter(s => s.path.startsWith('cursor-agent-store:'))

    const calls1 = await collectCalls(provider, sources[0]!)
    const calls2 = await collectCalls(provider, sources[0]!, new Set())
    expect(calls1[0]!.deduplicationKey).toBe(calls2[0]!.deduplicationKey)
  })

  it('respects seenKeys and does not re-yield already-seen dedup keys', async () => {
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })
    createSingleTurnStore(join(storeDir, 'store.db'))

    const provider = createCursorAgentProvider(baseDir)
    const sources = (await provider.discoverSessions()).filter(s => s.path.startsWith('cursor-agent-store:'))

    // First parse builds the seenKeys set
    const seenKeys = new Set<string>()
    const calls1 = await collectCalls(provider, sources[0]!, seenKeys)
    expect(calls1).toHaveLength(1)

    // Second parse reuses the same seenKeys — already consumed
    const calls2 = await collectCalls(provider, sources[0]!, seenKeys)
    expect(calls2).toHaveLength(0)
  })
})

skipUnlessSqlite('cursor-agent store.db: malformed metadata', () => {
  it('skips a store where meta["0"] is not hex', async () => {
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })

    const db = openWritableDb(join(storeDir, 'store.db'))
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
    db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)')
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('0', '!!not-hex!!')
    db.close()

    const provider = createCursorAgentProvider(baseDir)
    const sources = (await provider.discoverSessions()).filter(s => s.path.startsWith('cursor-agent-store:'))
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const calls = await collectCalls(provider, sources[0]!)
    stderrSpy.mockRestore()
    expect(calls).toHaveLength(0)
  })

  it('skips a store where hex decodes to invalid JSON', async () => {
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })

    const db = openWritableDb(join(storeDir, 'store.db'))
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
    db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)')
    // Hex encodes '{not json' (invalid JSON)
    const badHex = Buffer.from('{not json', 'utf-8').toString('hex')
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('0', badHex)
    db.close()

    const provider = createCursorAgentProvider(baseDir)
    const sources = (await provider.discoverSessions()).filter(s => s.path.startsWith('cursor-agent-store:'))
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const calls = await collectCalls(provider, sources[0]!)
    stderrSpy.mockRestore()
    expect(calls).toHaveLength(0)
  })

  it('skips a store where agentId is missing from metadata', async () => {
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })

    const db = openWritableDb(join(storeDir, 'store.db'))
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
    db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)')
    // Valid hex JSON but missing agentId
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      '0',
      hexEncodeJson({ latestRootBlobId: ROOT_BLOB_ID, name: 'no-agent-id' }),
    )
    db.close()

    const provider = createCursorAgentProvider(baseDir)
    const sources = (await provider.discoverSessions()).filter(s => s.path.startsWith('cursor-agent-store:'))
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const calls = await collectCalls(provider, sources[0]!)
    stderrSpy.mockRestore()
    expect(calls).toHaveLength(0)
  })

  it('skips a store where latestRootBlobId is not 64 hex chars', async () => {
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })

    createMinimalStore(join(storeDir, 'store.db'), {
      latestRootBlobId: 'short-invalid-id',
    })

    const provider = createCursorAgentProvider(baseDir)
    const sources = (await provider.discoverSessions()).filter(s => s.path.startsWith('cursor-agent-store:'))
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const calls = await collectCalls(provider, sources[0]!)
    stderrSpy.mockRestore()
    expect(calls).toHaveLength(0)
  })

  it('skips a store where agentId mismatches the directory UUID', async () => {
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })

    // Write a store with a different agentId than the directory UUID
    createSingleTurnStore(join(storeDir, 'store.db'), { agentId: SESSION_UUID_2 })

    const provider = createCursorAgentProvider(baseDir)
    const sources = (await provider.discoverSessions()).filter(s => s.path.startsWith('cursor-agent-store:'))
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const calls = await collectCalls(provider, sources[0]!)
    stderrSpy.mockRestore()
    expect(calls).toHaveLength(0)
  })

  it('skips a store missing the meta table', async () => {
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })

    const db = openWritableDb(join(storeDir, 'store.db'))
    db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)')
    // No meta table
    db.close()

    const provider = createCursorAgentProvider(baseDir)
    const sources = (await provider.discoverSessions()).filter(s => s.path.startsWith('cursor-agent-store:'))
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const calls = await collectCalls(provider, sources[0]!)
    stderrSpy.mockRestore()
    expect(calls).toHaveLength(0)
  })

  it('skips a store missing the blobs table', async () => {
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })

    const db = openWritableDb(join(storeDir, 'store.db'))
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
    // No blobs table
    db.close()

    const provider = createCursorAgentProvider(baseDir)
    const sources = (await provider.discoverSessions()).filter(s => s.path.startsWith('cursor-agent-store:'))
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const calls = await collectCalls(provider, sources[0]!)
    stderrSpy.mockRestore()
    expect(calls).toHaveLength(0)
  })
})

skipUnlessSqlite('cursor-agent store.db: missing or invalid blobs', () => {
  it('yields no calls when root blob is absent from blobs table', async () => {
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })

    // meta points to ROOT_BLOB_ID but blobs table is empty
    createMinimalStore(join(storeDir, 'store.db'), { blobs: [] })

    const provider = createCursorAgentProvider(baseDir)
    const sources = (await provider.discoverSessions()).filter(s => s.path.startsWith('cursor-agent-store:'))
    const calls = await collectCalls(provider, sources[0]!)
    expect(calls).toHaveLength(0)
  })

  it('tolerates a broken nextBlobId reference and still yields turns from reachable blobs', async () => {
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })

    const MISSING_BLOB = 'f'.repeat(64)
    createMinimalStore(join(storeDir, 'store.db'), {
      blobs: [
        {
          id: ROOT_BLOB_ID,
          data: { role: 'user', text: 'first turn', nextBlobId: SECOND_BLOB_ID },
        },
        {
          id: SECOND_BLOB_ID,
          data: {
            role: 'assistant',
            text: 'first reply',
            // Points to a blob that does not exist
            nextBlobId: MISSING_BLOB,
          },
        },
        // MISSING_BLOB is intentionally absent
      ],
    })

    const provider = createCursorAgentProvider(baseDir)
    const sources = (await provider.discoverSessions()).filter(s => s.path.startsWith('cursor-agent-store:'))
    const calls = await collectCalls(provider, sources[0]!)
    // Should still yield the one turn we could reconstruct
    expect(calls).toHaveLength(1)
  })

  it('silently skips blobs with invalid JSON data', async () => {
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })

    const db = openWritableDb(join(storeDir, 'store.db'))
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
    db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)')
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      '0',
      hexEncodeJson({
        agentId: SESSION_UUID,
        latestRootBlobId: ROOT_BLOB_ID,
        name: 'test',
        createdAt: 1_700_000_000_000,
      }),
    )
    // First blob has corrupt JSON
    db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run(ROOT_BLOB_ID, '{corrupt json')
    db.close()

    const provider = createCursorAgentProvider(baseDir)
    const sources = (await provider.discoverSessions()).filter(s => s.path.startsWith('cursor-agent-store:'))
    const calls = await collectCalls(provider, sources[0]!)
    expect(calls).toHaveLength(0)
  })
})

skipUnlessSqlite('cursor-agent store.db: unknown fields and future-proofing', () => {
  it('ignores unknown fields in blob objects without crashing', async () => {
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })

    createMinimalStore(join(storeDir, 'store.db'), {
      blobs: [
        {
          id: ROOT_BLOB_ID,
          data: {
            role: 'user',
            text: 'query',
            unknownProtoField: 42,
            futureFeature: { nested: true },
            nextBlobId: SECOND_BLOB_ID,
          },
        },
        {
          id: SECOND_BLOB_ID,
          data: {
            role: 'assistant',
            text: 'response',
            unknownV2Field: 'something',
            anotherFutureField: [1, 2, 3],
          },
        },
      ],
    })

    const provider = createCursorAgentProvider(baseDir)
    const sources = (await provider.discoverSessions()).filter(s => s.path.startsWith('cursor-agent-store:'))
    const calls = await collectCalls(provider, sources[0]!)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.userMessage).toBe('query')
  })

  it('handles content-block array format for text extraction', async () => {
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })

    createMinimalStore(join(storeDir, 'store.db'), {
      blobs: [
        {
          id: ROOT_BLOB_ID,
          data: {
            role: 'user',
            content: [{ type: 'text', text: 'block-format user msg' }],
            nextBlobId: SECOND_BLOB_ID,
          },
        },
        {
          id: SECOND_BLOB_ID,
          data: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'block-format assistant reply' },
              { type: 'tool_use', name: 'read_file' },
            ],
          },
        },
      ],
    })

    const provider = createCursorAgentProvider(baseDir)
    const sources = (await provider.discoverSessions()).filter(s => s.path.startsWith('cursor-agent-store:'))
    const calls = await collectCalls(provider, sources[0]!)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.userMessage).toBe('block-format user msg')
    expect(calls[0]!.tools).toContain('cursor:read_file')
  })

  it('handles toolCalls array format for tool extraction', async () => {
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })

    createMinimalStore(join(storeDir, 'store.db'), {
      blobs: [
        {
          id: ROOT_BLOB_ID,
          data: { role: 'user', text: 'do something', nextBlobId: SECOND_BLOB_ID },
        },
        {
          id: SECOND_BLOB_ID,
          data: {
            role: 'assistant',
            text: 'done',
            toolCalls: [{ name: 'Edit File' }, { name: 'Run Terminal' }],
          },
        },
      ],
    })

    const provider = createCursorAgentProvider(baseDir)
    const sources = (await provider.discoverSessions()).filter(s => s.path.startsWith('cursor-agent-store:'))
    const calls = await collectCalls(provider, sources[0]!)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.tools).toContain('cursor:edit-file')
    expect(calls[0]!.tools).toContain('cursor:run-terminal')
  })
})

skipUnlessSqlite('cursor-agent store.db: timestamp normalization', () => {
  it('uses epoch-milliseconds timestamp (> 1e12)', async () => {
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })

    const MS_TIMESTAMP = 1_700_000_000_000 // 2023-11-14 in ms
    createSingleTurnStore(join(storeDir, 'store.db'), { timestamp: MS_TIMESTAMP })

    const provider = createCursorAgentProvider(baseDir)
    const sources = (await provider.discoverSessions()).filter(s => s.path.startsWith('cursor-agent-store:'))
    const calls = await collectCalls(provider, sources[0]!)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.timestamp).toBe(new Date(MS_TIMESTAMP).toISOString())
  })

  it('converts epoch-seconds timestamp (< 1e12) to ISO', async () => {
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })

    const SEC_TIMESTAMP = 1_700_000_000 // seconds
    createMinimalStore(join(storeDir, 'store.db'), {
      blobs: [
        {
          id: ROOT_BLOB_ID,
          data: { role: 'user', text: 'hi', nextBlobId: SECOND_BLOB_ID },
        },
        {
          id: SECOND_BLOB_ID,
          data: {
            role: 'assistant',
            text: 'hello',
            timestamp: SEC_TIMESTAMP, // seconds — should be promoted to ms
          },
        },
      ],
    })

    const provider = createCursorAgentProvider(baseDir)
    const sources = (await provider.discoverSessions()).filter(s => s.path.startsWith('cursor-agent-store:'))
    const calls = await collectCalls(provider, sources[0]!)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.timestamp).toBe(new Date(SEC_TIMESTAMP * 1000).toISOString())
  })

  it('falls back to session createdAt when no turn-level timestamp exists', async () => {
    const SESSION_CREATED_MS = 1_690_000_000_000
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })

    createMinimalStore(join(storeDir, 'store.db'), {
      createdAt: SESSION_CREATED_MS,
      blobs: [
        { id: ROOT_BLOB_ID, data: { role: 'user', text: 'no ts', nextBlobId: SECOND_BLOB_ID } },
        { id: SECOND_BLOB_ID, data: { role: 'assistant', text: 'no ts either' } },
      ],
    })

    const provider = createCursorAgentProvider(baseDir)
    const sources = (await provider.discoverSessions()).filter(s => s.path.startsWith('cursor-agent-store:'))
    const calls = await collectCalls(provider, sources[0]!)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.timestamp).toBe(new Date(SESSION_CREATED_MS).toISOString())
  })
})

skipUnlessSqlite('cursor-agent store.db: token count provenance', () => {
  it('uses exact token counts when both are present and plausible', async () => {
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })

    createSingleTurnStore(join(storeDir, 'store.db'), {
      inputTokens: 150,
      outputTokens: 300,
    })

    const provider = createCursorAgentProvider(baseDir)
    const sources = (await provider.discoverSessions()).filter(s => s.path.startsWith('cursor-agent-store:'))
    const calls = await collectCalls(provider, sources[0]!)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(150)
    expect(calls[0]!.outputTokens).toBe(300)
    // costIsEstimated should be absent or falsy when counts are exact
    expect(calls[0]!.costIsEstimated).toBeFalsy()
  })

  it('estimates input tokens when inputTokens is absent', async () => {
    const userText = 'A'.repeat(400) // 400 chars → 100 estimated tokens
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })

    createMinimalStore(join(storeDir, 'store.db'), {
      blobs: [
        { id: ROOT_BLOB_ID, data: { role: 'user', text: userText, nextBlobId: SECOND_BLOB_ID } },
        { id: SECOND_BLOB_ID, data: { role: 'assistant', text: 'ok', outputTokens: 5 } },
      ],
    })

    const provider = createCursorAgentProvider(baseDir)
    const sources = (await provider.discoverSessions()).filter(s => s.path.startsWith('cursor-agent-store:'))
    const calls = await collectCalls(provider, sources[0]!)
    expect(calls).toHaveLength(1)
    // Estimated input from 400 chars
    expect(calls[0]!.inputTokens).toBe(estimateTokensFromChars(400))
    // Output is exact (5)
    expect(calls[0]!.outputTokens).toBe(5)
    // costIsEstimated should be set because input was estimated
    expect(calls[0]!.costIsEstimated).toBe(true)
  })

  it('estimates output tokens when outputTokens is absent', async () => {
    const assistantText = 'B'.repeat(800)
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })

    createMinimalStore(join(storeDir, 'store.db'), {
      blobs: [
        { id: ROOT_BLOB_ID, data: { role: 'user', text: 'hi', nextBlobId: SECOND_BLOB_ID } },
        {
          id: SECOND_BLOB_ID,
          data: {
            role: 'assistant',
            text: assistantText,
            inputTokens: 10,
            // no outputTokens
          },
        },
      ],
    })

    const provider = createCursorAgentProvider(baseDir)
    const sources = (await provider.discoverSessions()).filter(s => s.path.startsWith('cursor-agent-store:'))
    const calls = await collectCalls(provider, sources[0]!)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(10)
    expect(calls[0]!.outputTokens).toBe(estimateTokensFromChars(assistantText.length))
    expect(calls[0]!.costIsEstimated).toBe(true)
  })

  it('treats implausibly large token count as gauge and estimates instead', async () => {
    const userText = 'C'.repeat(200)
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })

    createMinimalStore(join(storeDir, 'store.db'), {
      blobs: [
        {
          id: ROOT_BLOB_ID,
          data: { role: 'user', text: userText, nextBlobId: SECOND_BLOB_ID },
        },
        {
          id: SECOND_BLOB_ID,
          data: {
            role: 'assistant',
            text: 'response',
            // 3 million tokens is implausible for a single request → treated as gauge
            inputTokens: 3_000_000,
            outputTokens: 100,
          },
        },
      ],
    })

    const provider = createCursorAgentProvider(baseDir)
    const sources = (await provider.discoverSessions()).filter(s => s.path.startsWith('cursor-agent-store:'))
    const calls = await collectCalls(provider, sources[0]!)
    expect(calls).toHaveLength(1)
    // Input is estimated (gauge rejected), output exact
    expect(calls[0]!.inputTokens).toBe(estimateTokensFromChars(userText.length))
    expect(calls[0]!.outputTokens).toBe(100)
    expect(calls[0]!.costIsEstimated).toBe(true)
  })

  it('records cache-read and cache-creation token counts', async () => {
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })

    createMinimalStore(join(storeDir, 'store.db'), {
      blobs: [
        { id: ROOT_BLOB_ID, data: { role: 'user', text: 'cache test', nextBlobId: SECOND_BLOB_ID } },
        {
          id: SECOND_BLOB_ID,
          data: {
            role: 'assistant',
            text: 'cached response',
            inputTokens: 50,
            outputTokens: 80,
            cacheReadInputTokens: 200,
            cacheCreationInputTokens: 100,
          },
        },
      ],
    })

    const provider = createCursorAgentProvider(baseDir)
    const sources = (await provider.discoverSessions()).filter(s => s.path.startsWith('cursor-agent-store:'))
    const calls = await collectCalls(provider, sources[0]!)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.cacheReadInputTokens).toBe(200)
    expect(calls[0]!.cacheCreationInputTokens).toBe(100)
  })

  it('all-absent token data still yields a turn with estimated counts', async () => {
    const userText = 'D'.repeat(120)
    const assistantText = 'E'.repeat(240)
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })

    createMinimalStore(join(storeDir, 'store.db'), {
      blobs: [
        { id: ROOT_BLOB_ID, data: { role: 'user', text: userText, nextBlobId: SECOND_BLOB_ID } },
        { id: SECOND_BLOB_ID, data: { role: 'assistant', text: assistantText } },
      ],
    })

    const provider = createCursorAgentProvider(baseDir)
    const sources = (await provider.discoverSessions()).filter(s => s.path.startsWith('cursor-agent-store:'))
    const calls = await collectCalls(provider, sources[0]!)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(estimateTokensFromChars(userText.length))
    expect(calls[0]!.outputTokens).toBe(estimateTokensFromChars(assistantText.length))
    expect(calls[0]!.costIsEstimated).toBe(true)
  })
})

skipUnlessSqlite('cursor-agent store.db: store + transcript deduplication', () => {
  it('store and matching transcript produce one set of calls', async () => {
    const baseDir = await makeBaseDir()

    // Set up store.db
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })
    createSingleTurnStore(join(storeDir, 'store.db'))

    // Set up matching transcript (same session UUID)
    const transcriptDir = join(baseDir, 'projects', 'my-proj', 'agent-transcripts', SESSION_UUID)
    await mkdir(transcriptDir, { recursive: true })
    await writeFile(
      join(transcriptDir, `${SESSION_UUID}.jsonl`),
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>transcript query</user_query>' }] } }) + '\n' +
      JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'transcript answer' }] } }) + '\n',
    )

    const provider = createCursorAgentProvider(baseDir)
    const sources = await provider.discoverSessions()

    // Parse ALL sources with a single shared seenKeys set (as the real parser does)
    const seenKeys = new Set<string>()
    const allCalls: ParsedProviderCall[] = []
    for (const source of sources) {
      for await (const call of provider.createSessionParser(source, seenKeys).parse()) {
        allCalls.push(call)
      }
    }

    // Store sources yield calls, transcript is suppressed by the sentinel
    const storeCalls = allCalls.filter(c => c.deduplicationKey.startsWith('cursor-agent-store:'))
    const transcriptCalls = allCalls.filter(c => c.deduplicationKey.startsWith('cursor-agent:'))
    expect(storeCalls.length).toBeGreaterThan(0)
    expect(transcriptCalls).toHaveLength(0)
  })

  it('transcript is used when store decoding fails (schema missing)', async () => {
    const baseDir = await makeBaseDir()

    // Create a broken store (no meta table)
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })
    const db = openWritableDb(join(storeDir, 'store.db'))
    db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)')
    // No meta table — schema invalid
    db.close()

    // Set up matching transcript
    const transcriptDir = join(baseDir, 'projects', 'fallback-proj', 'agent-transcripts', SESSION_UUID)
    await mkdir(transcriptDir, { recursive: true })
    await writeFile(
      join(transcriptDir, `${SESSION_UUID}.jsonl`),
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>fallback query</user_query>' }] } }) + '\n' +
      JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'fallback answer' }] } }) + '\n',
    )

    const provider = createCursorAgentProvider(baseDir)
    const sources = await provider.discoverSessions()

    const seenKeys = new Set<string>()
    const allCalls: ParsedProviderCall[] = []
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    for (const source of sources) {
      for await (const call of provider.createSessionParser(source, seenKeys).parse()) {
        allCalls.push(call)
      }
    }
    stderrSpy.mockRestore()

    // Store failed → transcript should produce calls
    const transcriptCalls = allCalls.filter(c => c.deduplicationKey.startsWith('cursor-agent:'))
    expect(transcriptCalls).toHaveLength(1)
    expect(transcriptCalls[0]!.userMessage).toBe('fallback query')
  })

  it('store-only session (no matching transcript) appears in results', async () => {
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })
    createSingleTurnStore(join(storeDir, 'store.db'))

    const provider = createCursorAgentProvider(baseDir)
    const sources = await provider.discoverSessions()

    const seenKeys = new Set<string>()
    const allCalls: ParsedProviderCall[] = []
    for (const source of sources) {
      for await (const call of provider.createSessionParser(source, seenKeys).parse()) {
        allCalls.push(call)
      }
    }

    expect(allCalls.length).toBeGreaterThan(0)
    expect(allCalls[0]!.sessionId).toBe(SESSION_UUID)
  })
})

skipUnlessSqlite('cursor-agent store.db: WAL-aware cache invalidation', () => {
  it('re-parses the store when the main file changes', async () => {
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })
    const storePath = join(storeDir, 'store.db')
    createSingleTurnStore(storePath, { userText: 'first version' })

    const provider = createCursorAgentProvider(baseDir)
    const sources = (await provider.discoverSessions()).filter(s => s.path.startsWith('cursor-agent-store:'))

    const calls1 = await collectCalls(provider, sources[0]!, new Set())
    expect(calls1[0]!.userMessage).toBe('first version')

    // Overwrite with a new store (different size ensures fingerprint changes).
    // createMinimalStore uses DROP TABLE IF EXISTS so writing to the same path works.
    createSingleTurnStore(storePath, {
      userText: 'second version — updated content with extra padding to guarantee a different file size',
    })

    const calls2 = await collectCalls(provider, sources[0]!, new Set())
    expect(calls2[0]!.userMessage).toBe(
      'second version — updated content with extra padding to guarantee a different file size',
    )
  })

  it('reuses the in-memory cache when fingerprint is unchanged', async () => {
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })
    const storePath = join(storeDir, 'store.db')
    createSingleTurnStore(storePath)

    const provider = createCursorAgentProvider(baseDir)
    const sources = (await provider.discoverSessions()).filter(s => s.path.startsWith('cursor-agent-store:'))

    // Spy on openDatabase to count how many times the store is opened
    const sqliteModule = await import('../../src/sqlite.js')
    const openSpy = vi.spyOn(sqliteModule, 'openDatabase')

    await collectCalls(provider, sources[0]!, new Set())
    const openCount1 = openSpy.mock.calls.length

    // Second parse on the same provider instance should hit the cache
    await collectCalls(provider, sources[0]!, new Set())
    const openCount2 = openSpy.mock.calls.length

    // The DB should not be re-opened on the second call
    expect(openCount2).toBe(openCount1)
    openSpy.mockRestore()
  })
})

skipUnlessSqlite('cursor-agent store.db: blobEncryptionKey redaction', () => {
  it('does not include blobEncryptionKey in any emitted call field', async () => {
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })

    const SECRET_KEY = 'super-secret-encryption-key-12345'
    // Write directly with blobEncryptionKey present (no double-write needed)
    createMinimalStore(join(storeDir, 'store.db'), {
      blobEncryptionKey: SECRET_KEY,
      blobs: [
        { id: ROOT_BLOB_ID, data: { role: 'user', text: 'redact test', nextBlobId: SECOND_BLOB_ID } },
        { id: SECOND_BLOB_ID, data: { role: 'assistant', text: 'answer', inputTokens: 10, outputTokens: 20 } },
      ],
    })

    const provider = createCursorAgentProvider(baseDir)
    const sources = (await provider.discoverSessions()).filter(s => s.path.startsWith('cursor-agent-store:'))
    const calls = await collectCalls(provider, sources[0]!)

    // The secret must not appear in any field of any emitted call
    for (const call of calls) {
      const serialized = JSON.stringify(call)
      expect(serialized).not.toContain(SECRET_KEY)
    }
  })

  it('does not write blobEncryptionKey to stderr', async () => {
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })

    const SECRET_KEY = 'leak-test-key-xyz-98765'
    createMinimalStore(join(storeDir, 'store.db'), {
      blobEncryptionKey: SECRET_KEY,
      blobs: [
        { id: ROOT_BLOB_ID, data: { role: 'user', text: 'hi', nextBlobId: SECOND_BLOB_ID } },
        { id: SECOND_BLOB_ID, data: { role: 'assistant', text: 'ok' } },
      ],
    })

    const provider = createCursorAgentProvider(baseDir)
    const sources = (await provider.discoverSessions()).filter(s => s.path.startsWith('cursor-agent-store:'))

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    await collectCalls(provider, sources[0]!)
    const stderrOutput = stderrSpy.mock.calls.map(c => String(c[0] ?? '')).join('')
    stderrSpy.mockRestore()

    expect(stderrOutput).not.toContain(SECRET_KEY)
  })

  it('does not include blobEncryptionKey in the source path', async () => {
    const baseDir = await makeBaseDir()
    const storeDir = join(baseDir, 'chats', 'h1', SESSION_UUID)
    await mkdir(storeDir, { recursive: true })

    const SECRET_KEY = 'path-leak-test-key-99999'
    createMinimalStore(join(storeDir, 'store.db'), {
      blobEncryptionKey: SECRET_KEY,
      blobs: [],
    })

    const provider = createCursorAgentProvider(baseDir)
    const sources = await provider.discoverSessions()

    for (const source of sources) {
      expect(source.path).not.toContain(SECRET_KEY)
    }
  })
})
