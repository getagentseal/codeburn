// Regression test for the OTel multi-conversation cache overwrite bug.
//
// Root cause: `parseProviderSources` in parser.ts calls
//   `delete section.files[source.path]`
// at the START of every loop iteration over changedSources. When multiple OTel
// conversations from the same agent-traces.db share the same path key, each
// iteration wiped the merged turns accumulated by all previous iterations, so
// only the LAST conversation's data survived — a ~434x cost undercount in
// practice (observed: $0.19 vs ~$85 ground truth from OTel DB).
//
// This test exercises the full `parseAllSessions` pipeline to catch any future
// regression at the aggregation layer, not just the provider-level parser.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRequire } from 'node:module'

import { isSqliteAvailable } from '../src/sqlite.js'
import { clearSessionCache, parseAllSessions } from '../src/parser.js'

const requireForTest = createRequire(import.meta.url)

type TestDb = {
  exec(sql: string): void
  prepare(sql: string): { run(...p: unknown[]): void }
  close(): void
}

function createOtelDb(dbPath: string): void {
  const { DatabaseSync } = requireForTest('node:sqlite') as { DatabaseSync: new (path: string) => TestDb }
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE spans (
      span_id        TEXT    PRIMARY KEY NOT NULL,
      trace_id       TEXT    NOT NULL,
      operation_name TEXT,
      start_time_ms  INTEGER NOT NULL DEFAULT 0,
      response_model TEXT
    );
    CREATE TABLE span_attributes (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      span_id TEXT    NOT NULL,
      key     TEXT    NOT NULL,
      value   TEXT
    );
  `)
  db.close()
}

interface ConvSpec {
  spanId: string
  traceId: string
  convId: string
  model: string
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  startTimeMs?: number
}

function insertConversation(dbPath: string, spec: ConvSpec): void {
  const { DatabaseSync } = requireForTest('node:sqlite') as { DatabaseSync: new (path: string) => TestDb }
  const db = new DatabaseSync(dbPath)
  db.prepare(
    `INSERT INTO spans (span_id, trace_id, operation_name, start_time_ms, response_model)
     VALUES (?, ?, ?, ?, ?)`
  ).run(spec.spanId, spec.traceId, 'chat', spec.startTimeMs ?? Date.now(), spec.model)

  const attrStmt = db.prepare(
    `INSERT INTO span_attributes (span_id, key, value) VALUES (?, ?, ?)`
  )
  const attrs: Record<string, string | number> = {
    'gen_ai.conversation.id':                   spec.convId,
    'gen_ai.response.model':                    spec.model,
    'gen_ai.usage.input_tokens':                spec.input,
    'gen_ai.usage.output_tokens':               spec.output,
    'gen_ai.usage.cache_read.input_tokens':     spec.cacheRead,
    'gen_ai.usage.cache_creation.input_tokens': spec.cacheCreate,
  }
  for (const [key, value] of Object.entries(attrs)) {
    attrStmt.run(spec.spanId, key, String(value))
  }
  db.close()
}

describe.skipIf(!isSqliteAvailable())(
  'OTel multi-conversation cache aggregation (regression for 434x undercount)',
  () => {
    let tmpHome: string
    let tmpCache: string
    let dbPath: string

    beforeEach(async () => {
      tmpHome  = await mkdtemp(join(tmpdir(), 'cb-otel-agg-home-'))
      tmpCache = await mkdtemp(join(tmpdir(), 'cb-otel-agg-cache-'))
      dbPath   = join(tmpHome, 'agent-traces.db')

      process.env['HOME']              = tmpHome
      process.env['CODEBURN_CACHE_DIR'] = tmpCache

      vi.stubEnv('CODEBURN_COPILOT_OTEL_DB', dbPath)
      vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '')
      // Redirect JSONL and transcript dirs to nonexistent paths so real
      // developer session files don't contaminate the test results.
      vi.stubEnv('CODEBURN_COPILOT_SESSION_STATE_DIR', join(tmpHome, 'no-jsonl'))
      vi.stubEnv('CODEBURN_COPILOT_WS_STORAGE_DIR',   join(tmpHome, 'no-ws'))
    })

    afterEach(async () => {
      clearSessionCache()
      vi.unstubAllEnvs()
      await rm(tmpHome,  { recursive: true, force: true })
      await rm(tmpCache, { recursive: true, force: true })
    })

    it('preserves cache tokens from all conversations, not just the last one', async () => {
      // Pricing for claude-haiku-4-5 (per litellm-snapshot.json):
      //   input:       $1.00 / M  → 1e-6
      //   output:      $5.00 / M  → 5e-6
      //   cache_read:  $0.10 / M  → 1e-7
      //   cache_write: $1.25 / M  → 1.25e-6
      createOtelDb(dbPath)

      const conversations: ConvSpec[] = [
        { spanId: 'span-1', traceId: 'trace-1', convId: 'conv-1', model: 'claude-haiku-4-5-20251001',
          input: 1_000, output: 100, cacheRead: 50_000, cacheCreate: 500 },
        { spanId: 'span-2', traceId: 'trace-2', convId: 'conv-2', model: 'claude-haiku-4-5-20251001',
          input: 2_000, output: 200, cacheRead: 60_000, cacheCreate: 600 },
        { spanId: 'span-3', traceId: 'trace-3', convId: 'conv-3', model: 'claude-haiku-4-5-20251001',
          input: 3_000, output: 300, cacheRead: 70_000, cacheCreate: 700 },
      ]
      for (const c of conversations) insertConversation(dbPath, c)

      const projects = await parseAllSessions(undefined, 'copilot')
      const allCalls = projects
        .flatMap(p => p.sessions)
        .flatMap(s => s.turns)
        .flatMap(t => t.assistantCalls)

      // All three conversations must be present — before the fix only 1 survived.
      expect(allCalls).toHaveLength(3)

      const totalInput      = allCalls.reduce((s, c) => s + c.usage.inputTokens,                 0)
      const totalOutput     = allCalls.reduce((s, c) => s + c.usage.outputTokens,                0)
      const totalCacheRead  = allCalls.reduce((s, c) => s + c.usage.cacheReadInputTokens,        0)
      const totalCacheCreate = allCalls.reduce((s, c) => s + c.usage.cacheCreationInputTokens,   0)

      expect(totalInput).toBe(6_000)    // 1 000 + 2 000 + 3 000
      expect(totalOutput).toBe(600)     // 100 + 200 + 300
      expect(totalCacheRead).toBe(180_000)  // 50k + 60k + 70k — all must survive
      expect(totalCacheCreate).toBe(1_800)  // 500 + 600 + 700

      // Pre-fix regression check: if only the last conversation survived,
      // totalCacheRead would be 70 000 (the last one). Assert it's 180 000.
      expect(totalCacheRead).toBeGreaterThan(100_000)

      // Cost sanity: input+output+cacheRead+cacheCreate with haiku-4-5 pricing
      //   6000 * 1e-6   = 0.006
      //   600  * 5e-6   = 0.003
      //   180k * 1e-7   = 0.018
      //   1800 * 1.25e-6 = 0.00225
      //   total ≈ $0.029
      const totalCostUSD = allCalls.reduce((s, c) => s + c.costUSD, 0)
      expect(totalCostUSD).toBeCloseTo(0.029, 2)
    })

    it('second run from disk cache also delivers all conversations', async () => {
      // Ensures the merged result written to the session-cache.json survives
      // a reload and yields the same aggregated data on repeat invocations.
      createOtelDb(dbPath)

      const conversations: ConvSpec[] = [
        { spanId: 'span-a', traceId: 'trace-a', convId: 'conv-a', model: 'claude-haiku-4-5-20251001',
          input: 500, output: 50, cacheRead: 25_000, cacheCreate: 250 },
        { spanId: 'span-b', traceId: 'trace-b', convId: 'conv-b', model: 'claude-haiku-4-5-20251001',
          input: 500, output: 50, cacheRead: 25_000, cacheCreate: 250 },
      ]
      for (const c of conversations) insertConversation(dbPath, c)

      // First run — parses and writes disk cache
      await parseAllSessions(undefined, 'copilot')

      // Clear in-memory cache only, leaving disk cache intact
      clearSessionCache()

      // Second run — should read from disk cache
      const projects = await parseAllSessions(undefined, 'copilot')
      const allCalls = projects
        .flatMap(p => p.sessions)
        .flatMap(s => s.turns)
        .flatMap(t => t.assistantCalls)

      expect(allCalls).toHaveLength(2)

      const totalCacheRead = allCalls.reduce((s, c) => s + c.usage.cacheReadInputTokens, 0)
      expect(totalCacheRead).toBe(50_000)  // 25k + 25k from both conversations
    })
  }
)
