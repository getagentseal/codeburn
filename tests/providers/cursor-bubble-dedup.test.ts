import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { isSqliteAvailable, openDatabase } from '../../src/sqlite.js'
import { getAllProviders } from '../../src/providers/index.js'
import type { Provider, ParsedProviderCall } from '../../src/providers/types.js'

/// Pinned regression for the v3 bubble-dedup fix. The previous (v2) code used
/// the bubble row's mutable token counts as part of the deduplication key, so
/// the same bubble was counted twice once Cursor wrote the streaming-complete
/// final token totals on top of the streaming-in-progress row. v3 switched to
/// the SQLite primary `key` column (which is the stable bubbleId:<id>:<id>
/// path) so re-parsing the same DB after token updates produces zero new
/// calls. This test:
///   1. Builds a tmp SQLite DB with the cursorDiskKV schema and one bubble row
///      with low token counts (the streaming-in-progress shape).
///   2. Parses it through the cursor provider. Asserts one call.
///   3. Mutates the row in place to higher token counts (the streaming-complete
///      shape) without changing the SQLite key.
///   4. Re-parses with the SAME seenKeys set. Asserts zero new calls.
/// If a future refactor brings back token-count-based dedup, the second parse
/// will produce a duplicate call and this test will fail.

const skipReason = isSqliteAvailable()
  ? null
  : 'node:sqlite not available — needs Node 22+; skipping'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'cursor-dedup-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function buildBubbleValue(opts: {
  conversationId: string
  text: string
  inputTokens: number
  outputTokens: number
  type: 1 | 2
  createdAt?: string
}): string {
  return JSON.stringify({
    type: opts.type,
    conversationId: opts.conversationId,
    text: opts.text,
    tokenCount: {
      inputTokens: opts.inputTokens,
      outputTokens: opts.outputTokens,
    },
    createdAt: opts.createdAt ?? new Date().toISOString(),
    modelId: 'gpt-5',
    capabilityType: 'composer',
  })
}

async function createCursorTestDb(): Promise<string> {
  // Cursor uses a non-extension state DB filename (state.vscdb in the real app);
  // any path works for openDatabase as long as we set up the schema and the
  // directory layout the parser expects. The parser only checks the DB
  // contents — discovery is bypassed because we hand it the path directly.
  const dbPath = join(tmpDir, 'state.vscdb')
  await writeFile(dbPath, '')
  // Use the underlying node:sqlite to create the schema.
  // We need cursorDiskKV with key + value columns.
  const Module = await import('node:module')
  const requireForSqlite = Module.createRequire(import.meta.url)
  const { DatabaseSync } = requireForSqlite('node:sqlite') as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void
      prepare(sql: string): { run(...p: unknown[]): unknown }
      close(): void
    }
  }
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)')

  // Single assistant bubble (type=2). The parser yields one ParsedProviderCall
  // per bubbleId:% row, so a multi-row fixture would muddy the dedup count;
  // we keep the test surface minimal — one bubble through one parse, then
  // the same bubble again after token mutation.
  const bubbleKey = 'bubbleId:abc-123:bubble-xyz'
  db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
    bubbleKey,
    buildBubbleValue({
      conversationId: 'abc-123',
      text: 'def hello(): pass',
      inputTokens: 100,
      outputTokens: 20,
      type: 2,
    })
  )

  db.close()
  return dbPath
}

async function updateAssistantBubbleTokens(dbPath: string, inputTokens: number, outputTokens: number): Promise<void> {
  const Module = await import('node:module')
  const requireForSqlite = Module.createRequire(import.meta.url)
  const { DatabaseSync } = requireForSqlite('node:sqlite') as {
    DatabaseSync: new (path: string) => {
      prepare(sql: string): { run(...p: unknown[]): unknown }
      close(): void
    }
  }
  const db = new DatabaseSync(dbPath)
  db.prepare('UPDATE cursorDiskKV SET value = ? WHERE key = ?').run(
    buildBubbleValue({
      conversationId: 'abc-123',
      text: 'def hello(): pass',
      inputTokens,
      outputTokens,
      type: 2,
    }),
    'bubbleId:abc-123:bubble-xyz'
  )
  db.close()
}

async function getCursorProvider(): Promise<Provider> {
  const all = await getAllProviders()
  const p = all.find(p => p.name === 'cursor')
  if (!p) throw new Error('cursor provider not registered')
  return p
}

describe.skipIf(skipReason !== null)('cursor bubble dedup (regression for v3 fix)', () => {
  it('does not double-count when bubble token counts mutate between parses', async () => {
    const dbPath = await createCursorTestDb()
    const provider = await getCursorProvider()

    // First parse: streaming-in-progress shape.
    const seenKeys = new Set<string>()
    const source = { path: dbPath, project: 'test-project', provider: 'cursor' }
    const firstRunCalls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, seenKeys).parse()) {
      firstRunCalls.push(call)
    }
    expect(firstRunCalls.length).toBe(1)

    // Cursor mutates the same bubble row to its final token totals when the
    // stream completes. Simulate by updating in place. The SQLite primary
    // key stays the same.
    await updateAssistantBubbleTokens(dbPath, 250, 80)

    // Second parse with the SAME seenKeys: must yield zero new calls. If the
    // dedup key were derived from token counts (the v2 bug), this would
    // produce a duplicate.
    const secondRunCalls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, seenKeys).parse()) {
      secondRunCalls.push(call)
    }
    expect(secondRunCalls.length).toBe(0)
  })

  it('does not yield the same bubble twice within a single parser run', async () => {
    const dbPath = await createCursorTestDb()
    const provider = await getCursorProvider()
    const seenKeys = new Set<string>()
    const source = { path: dbPath, project: 'test-project', provider: 'cursor' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, seenKeys).parse()) {
      calls.push(call)
    }
    // One bubble in the DB → one call. (The user message row at type=1 is
    // not surfaced as a separate ParsedProviderCall; it's threaded into the
    // assistant call's userMessage field.)
    expect(calls.length).toBe(1)
  })
})
