// Tests for durable-source monotonic cost behaviour (PR #477 / copilot-otel).
// Five scenarios:
//   (a) file-purge monotonic  — copilot JSONL file deleted → total unchanged
//   (b) OTel-prune monotonic  — OTel DB rows pruned      → total unchanged
//   (c) no double-count       — same source parsed twice  → counted once
//   (d) non-durable evicts    — deleted source for non-durable provider IS removed
//   (e) 90-day age-out        — only ORPHANS ≥ 91d are pruned (#992); a still-
//                               discovered source stays, flagged or not

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRequire } from 'node:module'

import { isSqliteAvailable } from '../src/sqlite.js'
import { calculateCost } from '../src/models.js'
import { aggregateProjectsIntoDays } from '../src/day-aggregator.js'
import { DAILY_CACHE_VERSION, currentTzKey, ensureCacheHydrated, saveDailyCache } from '../src/daily-cache.js'
import { clearSessionCache, isSessionHydrationComplete, parseAllSessions, setParseReuseValidator } from '../src/parser.js'
import { CACHE_VERSION, clearLoadCacheMemo, computeEnvFingerprint, loadCache, PROVIDER_PARSE_VERSIONS, saveCache } from '../src/session-cache.js'
import { cacheDirSnapshot, readCacheOnDisk, writeCacheOnDisk } from './fixtures/session-cache-io.js'
import type { SessionSource, SessionParser, ParsedProviderCall } from '../src/providers/types.js'
import { setHome } from './setup/home.js'

// ── Synthetic provider state ───────────────────────────────────────────────
// Module-level so the vi.mock factory closure captures them by reference and
// tests can mutate them freely without re-creating the mock.
let _synthSources: SessionSource[] = []
let _synthDurable = false
let _synthYields: ParsedProviderCall[] = []
let _synthParseCalls = 0
let _synthOnParse: ((source: SessionSource) => void | Promise<void>) | null = null

vi.mock('../src/providers/index.js', async (importOriginal) => {
  type Mod = typeof import('../src/providers/index.js')
  const actual = await importOriginal<Mod>()
  // Pass through for specific non-synthetic providers; inject synthetic
  // sources only when filter is undefined/'all'/'test-synthetic'.
  const discoverAllSessions = async (filter?: string): Promise<SessionSource[]> => {
    if (filter && filter !== 'all' && filter !== 'test-synthetic') {
      return actual.discoverAllSessions(filter)
    }
    const base = filter === 'test-synthetic'
      ? []
      : await actual.discoverAllSessions(filter)
    return [..._synthSources, ...base]
  }
  return {
    ...actual,
    discoverAllSessions,
    // What the parse path calls. The synthetic provider never fails discovery,
    // so it carries the same sources and no failures.
    async discoverAllSessionsWithFailures(filter?: string) {
      return { sources: await discoverAllSessions(filter), failedProviders: [] }
    },
    async getProvider(name: string) {
      if (name === 'test-synthetic') {
        return {
          name: 'test-synthetic',
          displayName: 'Test Synthetic',
          durableSources: _synthDurable,
          modelDisplayName: (m: string) => m,
          toolDisplayName: (t: string) => t,
          async discoverSessions() { return _synthSources },
          createSessionParser(_s: SessionSource, _k: Set<string>): SessionParser {
            return {
              async *parse(): AsyncGenerator<ParsedProviderCall> {
                _synthParseCalls++
                await _synthOnParse?.(_s)
                for (const call of _synthYields) {
                  // Respect seenKeys so that when multiple sources share the same
                  // dedup key, only the first source yields it (mirrors real parsers).
                  if (_k.has(call.deduplicationKey)) continue
                  _k.add(call.deduplicationKey)
                  yield call
                }
              },
            }
          },
        }
      }
      return actual.getProvider(name)
    },
  }
})

// ── OTel DB helpers ───────────────────────────────────────────────────────
const requireForTest = createRequire(import.meta.url)
type TestDb = {
  exec(sql: string): void
  prepare(sql: string): { run(...p: unknown[]): void }
  close(): void
}

function createOtelDb(dbPath: string): void {
  const { DatabaseSync } = requireForTest('node:sqlite') as {
    DatabaseSync: new (path: string) => TestDb
  }
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

interface OtelConvSpec {
  spanId: string
  traceId: string
  convId: string
  model: string
  input: number
  output: number
  startTimeMs?: number
}

function insertOtelConv(dbPath: string, spec: OtelConvSpec): void {
  const { DatabaseSync } = requireForTest('node:sqlite') as {
    DatabaseSync: new (path: string) => TestDb
  }
  const db = new DatabaseSync(dbPath)
  db.prepare(
    `INSERT INTO spans (span_id, trace_id, operation_name, start_time_ms, response_model)
     VALUES (?, ?, ?, ?, ?)`
  ).run(spec.spanId, spec.traceId, 'chat', spec.startTimeMs ?? Date.now(), spec.model)
  const attr = db.prepare(
    `INSERT INTO span_attributes (span_id, key, value) VALUES (?, ?, ?)`
  )
  const attrs: Record<string, string | number> = {
    'gen_ai.conversation.id':               spec.convId,
    'gen_ai.response.model':                spec.model,
    'gen_ai.usage.input_tokens':            spec.input,
    'gen_ai.usage.output_tokens':           spec.output,
    'gen_ai.usage.cache_read.input_tokens': 0,
    'gen_ai.usage.cache_creation.input_tokens': 0,
  }
  for (const [k, v] of Object.entries(attrs)) attr.run(spec.spanId, k, String(v))
  db.close()
}

// ── Copilot JSONL helpers ─────────────────────────────────────────────────
async function createJsonlSession(
  sessionStateDir: string,
  sessionId: string,
  outputTokens: number,
): Promise<string> {
  const dir = join(sessionStateDir, sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'workspace.yaml'), `id: ${sessionId}\ncwd: /home/user/testproj\n`)
  // Relative timestamps: fixed calendar dates rot. The original '2026-05-01'
  // crossed copilot's durable 90-day age-out on 2026-07-30, at which point the
  // very first parse pruned the freshly-cached session and both durable tests
  // started failing everywhere with "expected +0 to be 200".
  const base = Date.now() - 5 * 24 * 60 * 60 * 1000
  const at = (offsetSec: number): string => new Date(base + offsetSec * 1000).toISOString()
  const lines = [
    JSON.stringify({ type: 'session.model_change', timestamp: at(0), data: { newModel: 'gpt-4.1' } }),
    JSON.stringify({ type: 'user.message', timestamp: at(5), data: { content: 'hello', interactionId: 'int-1' } }),
    JSON.stringify({ type: 'assistant.message', timestamp: at(10), data: { messageId: 'msg-1', outputTokens, interactionId: 'int-1', toolRequests: [] } }),
  ]
  await writeFile(join(dir, 'events.jsonl'), lines.join('\n') + '\n')
  return join(dir, 'events.jsonl')
}

// ── Helpers ───────────────────────────────────────────────────────────────
function totalCost(projects: Awaited<ReturnType<typeof parseAllSessions>>): number {
  return projects
    .flatMap(p => p.sessions)
    .flatMap(s => s.turns)
    .flatMap(t => t.assistantCalls)
    .reduce((s, c) => s + c.costUSD, 0)
}

function totalOutput(projects: Awaited<ReturnType<typeof parseAllSessions>>): number {
  return projects
    .flatMap(p => p.sessions)
    .flatMap(s => s.turns)
    .flatMap(t => t.assistantCalls)
    .reduce((s, c) => s + c.usage.outputTokens, 0)
}

// ── Common env setup ──────────────────────────────────────────────────────
let tmpHome: string
let tmpCache: string

beforeEach(async () => {
  tmpHome  = await mkdtemp(join(tmpdir(), 'cb-parser-test-home-'))
  tmpCache = await mkdtemp(join(tmpdir(), 'cb-parser-test-cache-'))

  setHome(tmpHome)
  process.env['CODEBURN_CACHE_DIR'] = tmpCache

  // Reset synthetic provider state
  _synthSources = []
  _synthDurable = false
  _synthYields  = []
  _synthParseCalls = 0
  _synthOnParse = null
})

afterEach(async () => {
  clearSessionCache()
  setParseReuseValidator(null)
  vi.unstubAllEnvs()

  _synthSources = []
  _synthOnParse = null

  await rm(tmpHome,  { recursive: true, force: true })
  await rm(tmpCache, { recursive: true, force: true })
})

// ═══════════════════════════════════════════════════════════════════════════
// (a) File-purge monotonic: copilot JSONL file deleted → total unchanged
// ═══════════════════════════════════════════════════════════════════════════
describe('(a) copilot JSONL file-purge monotonic', () => {
  it('preserves monthly total after events.jsonl is deleted', async () => {
    const sessionStateDir = join(tmpHome, 'session-state')
    await mkdir(sessionStateDir, { recursive: true })

    vi.stubEnv('CODEBURN_COPILOT_SESSION_STATE_DIR', sessionStateDir)
    vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '1')
    vi.stubEnv('CODEBURN_COPILOT_WS_STORAGE_DIR', join(tmpHome, 'no-ws'))

    const eventsPath = await createJsonlSession(sessionStateDir, 'sess-del', 200)

    // First parse: file exists → cached
    const proj1 = await parseAllSessions(undefined, 'copilot')
    const out1 = totalOutput(proj1)
    expect(out1).toBe(200)

    // Delete the source file (simulates VS Code / CLI pruning it)
    await unlink(eventsPath)
    clearSessionCache()

    // Second parse: file gone but copilot is durable → total must not drop
    const proj2 = await parseAllSessions(undefined, 'copilot')
    const out2 = totalOutput(proj2)
    expect(out2).toBeGreaterThanOrEqual(out1)
    expect(out2).toBe(out1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (b) OTel-prune monotonic: OTel DB rows pruned → total unchanged
// ═══════════════════════════════════════════════════════════════════════════
describe.skipIf(!isSqliteAvailable())(
  '(b) OTel DB-prune monotonic',
  () => {
    it('preserves total after one conversation is pruned from the OTel DB', async () => {
      const dbPath = join(tmpHome, 'agent-traces.db')
      vi.stubEnv('CODEBURN_COPILOT_OTEL_DB', dbPath)
      vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '')
      vi.stubEnv('CODEBURN_COPILOT_SESSION_STATE_DIR', join(tmpHome, 'no-jsonl'))
      vi.stubEnv('CODEBURN_COPILOT_WS_STORAGE_DIR',   join(tmpHome, 'no-ws'))

      // DB with two conversations
      createOtelDb(dbPath)
      insertOtelConv(dbPath, { spanId: 's1', traceId: 't1', convId: 'prune-c1', model: 'gpt-4.1', input: 500,  output: 50 })
      insertOtelConv(dbPath, { spanId: 's2', traceId: 't2', convId: 'prune-c2', model: 'gpt-4.1', input: 1000, output: 100 })

      const proj1 = await parseAllSessions(undefined, 'copilot')
      const out1 = totalOutput(proj1)
      expect(out1).toBe(150)  // 50 + 100

      // Simulate OTel pruning conv-1 from the DB: rebuild DB with only conv-2
      clearSessionCache()
      await rm(dbPath)
      createOtelDb(dbPath)
      insertOtelConv(dbPath, { spanId: 's2', traceId: 't2', convId: 'prune-c2', model: 'gpt-4.1', input: 1000, output: 100 })

      // Second parse: DB was rebuilt without conv-1. The union-merge in
      // parseProviderSources keeps conv-1's turns in the cache (since its
      // dedup keys are not re-emitted by the re-parse) → total must not drop.
      const proj2 = await parseAllSessions(undefined, 'copilot')
      const out2 = totalOutput(proj2)
      expect(out2).toBeGreaterThanOrEqual(out1)
      expect(out2).toBe(out1)
    })
  }
)

// ═══════════════════════════════════════════════════════════════════════════
// (c) No double-count: same fully-present source parsed twice → counted once
// ═══════════════════════════════════════════════════════════════════════════
describe.skipIf(!isSqliteAvailable())(
  '(c) OTel source parsed twice is counted once',
  () => {
    it('second parse of unchanged DB yields same total, not double', async () => {
      const dbPath = join(tmpHome, 'agent-traces.db')
      vi.stubEnv('CODEBURN_COPILOT_OTEL_DB', dbPath)
      vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '')
      vi.stubEnv('CODEBURN_COPILOT_SESSION_STATE_DIR', join(tmpHome, 'no-jsonl'))
      vi.stubEnv('CODEBURN_COPILOT_WS_STORAGE_DIR',   join(tmpHome, 'no-ws'))

      createOtelDb(dbPath)
      insertOtelConv(dbPath, { spanId: 'dedup-s1', traceId: 'dedup-t1', convId: 'dedup-c1', model: 'gpt-4.1', input: 300, output: 30 })

      const proj1 = await parseAllSessions(undefined, 'copilot')
      expect(totalOutput(proj1)).toBe(30)

      clearSessionCache()

      // Second parse — disk cache is populated, fingerprint unchanged
      const proj2 = await parseAllSessions(undefined, 'copilot')
      expect(totalOutput(proj2)).toBe(30)  // NOT 60
    })
  }
)

// ═══════════════════════════════════════════════════════════════════════════
// (d) Non-durable evicts: deleted source for non-durable provider is removed
// ═══════════════════════════════════════════════════════════════════════════
describe('(d) non-durable provider evicts deleted sources', () => {
  it('removes cache entry for a path that leaves discoverSessions()', async () => {
    // Two real temp files as source paths (fingerprintFile needs them to exist)
    const fileA = join(tmpHome, 'synth-a.txt')
    const fileB = join(tmpHome, 'synth-b.txt')
    await writeFile(fileA, 'placeholder-a')
    await writeFile(fileB, 'placeholder-b')

    const dedupA = 'synth-dedup-evict-a'
    const dedupB = 'synth-dedup-evict-b'

    const makeCall = (deduplicationKey: string): ParsedProviderCall => ({
      provider: 'test-synthetic', model: 'gpt-4o',
      inputTokens: 10, outputTokens: 5,
      cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0,
      costUSD: 0.001, tools: [], bashCommands: [],
      timestamp: new Date().toISOString(),
      speed: 'standard',
      deduplicationKey,
      userMessage: 'test', sessionId: 'synth-sess',
    })

    _synthDurable = false
    _synthSources = [
      { path: fileA, project: 'test', provider: 'test-synthetic' },
      { path: fileB, project: 'test', provider: 'test-synthetic' },
    ]
    _synthYields = [makeCall(dedupA)]

    // First parse: both sources present → data for A cached
    const proj1 = await parseAllSessions(undefined, 'test-synthetic')
    expect(totalOutput(proj1)).toBeGreaterThan(0)

    clearSessionCache()

    // Remove A from discovered sources (simulates file-gone + discoverSessions skips it).
    // B stays so sources.length > 0 → eviction loop fires.
    _synthSources = [{ path: fileB, project: 'test', provider: 'test-synthetic' }]
    _synthYields  = []  // B yields nothing (empty file)

    const proj2 = await parseAllSessions(undefined, 'test-synthetic')
    // A's cache entry must be evicted → total should be 0
    expect(totalOutput(proj2)).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (e) 90-day age-out: orphan ≥ 91d old is pruned; ≤ 89d is retained
// ═══════════════════════════════════════════════════════════════════════════
describe('(e) 90-day age-out for durable providers', () => {
  it('keeps a discovered 91-day source persisted until discovery removes it', async () => {
    const synthFile = join(tmpHome, 'synth-age.txt')
    await writeFile(synthFile, 'placeholder')

    const ts91dAgo = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString()

    _synthDurable = true
    _synthSources = [{ path: synthFile, project: 'test', provider: 'test-synthetic' }]
    _synthYields  = [{
      provider: 'test-synthetic', model: 'gpt-4o',
      inputTokens: 10, outputTokens: 8,
      cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0,
      costUSD: 0.002, tools: [], bashCommands: [],
      timestamp: ts91dAgo,
      speed: 'standard',
      deduplicationKey: 'synth-age-out-91d',
      userMessage: 'old', sessionId: 'synth-old',
    }]

    // First refresh: a still-discovered durable source is live and persisted,
    // regardless of the age of its newest call.
    const proj1 = await parseAllSessions(undefined, 'test-synthetic')
    expect.soft(totalOutput(proj1)).toBe(8)
    expect.soft(_synthParseCalls).toBe(1)

    const cache1 = await loadCache()
    const persisted1 = cache1.providers['test-synthetic']?.files[synthFile]
    expect.soft(persisted1).toBeDefined()

    // Second refresh: force the public seam through the persisted cache. The
    // unchanged fingerprint must serve the cached parse without invoking the
    // provider parser again.
    clearSessionCache()
    const proj2 = await parseAllSessions(undefined, 'test-synthetic')
    expect.soft(totalOutput(proj2)).toBe(8)
    expect.soft(_synthParseCalls).toBe(1)

    const cache2 = await loadCache()
    expect.soft(cache2.providers['test-synthetic']?.files[synthFile]?.fingerprint)
      .toEqual(persisted1?.fingerprint)

    // Third refresh: once discovery removes the old source, it becomes an
    // orphan and the durable 90-day age-out prunes it from results and disk.
    clearSessionCache()
    _synthSources = []
    const proj3 = await parseAllSessions(undefined, 'test-synthetic')
    expect.soft(totalOutput(proj3)).toBe(0)

    const cache3 = await loadCache()
    expect.soft(cache3.providers['test-synthetic']?.files[synthFile]).toBeUndefined()
  })

  it('keeps a discovered 91-day source through a month-scoped refresh', async () => {
    const synthFile = join(tmpHome, 'synth-scoped.txt')
    await writeFile(synthFile, 'placeholder')

    const ts91dAgo = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString()

    _synthDurable = true
    _synthSources = [{ path: synthFile, project: 'test', provider: 'test-synthetic' }]
    _synthYields  = [{
      provider: 'test-synthetic', model: 'gpt-4o',
      inputTokens: 10, outputTokens: 8,
      cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0,
      costUSD: 0.002, tools: [], bashCommands: [],
      timestamp: ts91dAgo,
      speed: 'standard',
      deduplicationKey: 'synth-age-out-91d-scoped',
      userMessage: 'old', sessionId: 'synth-old-scoped',
    }]

    expect.soft(totalOutput(await parseAllSessions(undefined, 'test-synthetic'))).toBe(8)

    // A today-ranged refresh loads under a month scope that excludes the entry's
    // shard. Durable providers are never scoped, so the age-out still sees the
    // entry as discovered and the save must carry its month across intact.
    clearSessionCache()
    const today = new Date()
    const start = new Date(today); start.setHours(0, 0, 0, 0)
    const end   = new Date(today); end.setHours(23, 59, 59, 999)
    expect.soft(totalOutput(await parseAllSessions({ start, end }, 'test-synthetic'))).toBe(0)

    clearSessionCache()
    expect.soft(totalOutput(await parseAllSessions(undefined, 'test-synthetic'))).toBe(8)
    expect.soft(_synthParseCalls).toBe(1)

    const cache = await loadCache()
    expect.soft(cache.providers['test-synthetic']?.files[synthFile]).toBeDefined()
  })

  it('retains a 91-day-old entry whose still-discovered source declares retainWhilePresent', async () => {
    const synthFile = join(tmpHome, 'synth-retain-flag.txt')
    await writeFile(synthFile, 'placeholder')

    const ts91dAgo = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString()

    _synthDurable = true
    _synthSources = [{ path: synthFile, project: 'test', provider: 'test-synthetic', retainWhilePresent: true }]
    _synthYields  = [{
      provider: 'test-synthetic', model: 'gpt-4o',
      inputTokens: 10, outputTokens: 8,
      cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0,
      costUSD: 0.002, tools: [], bashCommands: [],
      timestamp: ts91dAgo,
      speed: 'standard',
      deduplicationKey: 'synth-retain-flag-91d',
      userMessage: 'old', sessionId: 'synth-flag',
    }]

    // Flagged + discovered: the file is the durable record; pruning it would
    // drop data only it holds. Served and retained across passes.
    const proj1 = await parseAllSessions(undefined, 'test-synthetic')
    expect(totalOutput(proj1)).toBe(8)
    clearSessionCache()
    const proj2 = await parseAllSessions(undefined, 'test-synthetic')
    expect(totalOutput(proj2)).toBe(8)

    // Once ORPHANED the flag no longer applies — orphan age-out prunes.
    clearSessionCache()
    _synthSources = []  // no longer discovered
    const proj3 = await parseAllSessions(undefined, 'test-synthetic')
    expect(totalOutput(proj3)).toBe(0)
  })

  it('retains an orphaned cache entry whose newest call is 89 days old', async () => {
    const synthFile = join(tmpHome, 'synth-retain.txt')
    await writeFile(synthFile, 'placeholder')

    const ts89dAgo = new Date(Date.now() - 89 * 24 * 60 * 60 * 1000).toISOString()

    _synthDurable = true
    _synthSources = [{ path: synthFile, project: 'test', provider: 'test-synthetic' }]
    _synthYields  = [{
      provider: 'test-synthetic', model: 'gpt-4o',
      inputTokens: 10, outputTokens: 7,
      cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0,
      costUSD: 0.002, tools: [], bashCommands: [],
      timestamp: ts89dAgo,
      speed: 'standard',
      deduplicationKey: 'synth-retain-89d',
      userMessage: 'recent-ish', sessionId: 'synth-recent',
    }]

    // First parse: cached with 89d-old timestamp → NOT pruned (within 90d window)
    const proj1 = await parseAllSessions(undefined, 'test-synthetic')
    expect(totalOutput(proj1)).toBe(7)

    // Remove source (simulate it being orphaned)
    clearSessionCache()
    _synthSources = []  // no longer discovered → orphan pass handles it

    // Second parse: orphan with 89d timestamp → retained + counted via orphan pass
    const proj2 = await parseAllSessions(undefined, 'test-synthetic')
    expect(totalOutput(proj2)).toBe(7)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Emission gate: a reasoning-only copilot session still emits
// ═══════════════════════════════════════════════════════════════════════════
// A rollup can carry ONLY reasoning tokens (zero input/cache/output, zero
// cost — copilot reasoning is never priced). The gate admits any
// usage-bearing session; dropping this one would silently lose the only
// record of its usage.
describe('reasoning-only copilot session emission', () => {
  it('emits a session whose sole rollup carries only reasoning tokens', async () => {
    const sessionStateDir = join(tmpHome, 'session-state-reason-only')
    await mkdir(sessionStateDir, { recursive: true })
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STATE_DIR', sessionStateDir)
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STORE_DB', join(tmpHome, 'no-store.db'))
    vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '1')
    vi.stubEnv('CODEBURN_COPILOT_WS_STORAGE_DIR', join(tmpHome, 'no-ws'))
    vi.stubEnv('CODEBURN_COPILOT_GLOBAL_STORAGE_DIR', join(tmpHome, 'no-global'))
    vi.stubEnv('CODEBURN_COPILOT_JETBRAINS_DIR', join(tmpHome, 'no-jb'))

    const ts = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
    const dir = join(sessionStateDir, 'sess-reason')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'workspace.yaml'), 'id: sess-reason\ncwd: /home/user/testproj\n')
    await writeFile(join(dir, 'events.jsonl'), [
      JSON.stringify({ type: 'session.model_change', timestamp: ts, data: { newModel: 'gpt-5' } }),
      JSON.stringify({
        type: 'session.shutdown',
        timestamp: ts,
        data: {
          shutdownType: 'routine',
          modelMetrics: {
            'gpt-5': {
              requests: { count: 1, cost: 0 },
              usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 800 },
            },
          },
        },
      }),
    ].join('\n') + '\n')

    const projects = await parseAllSessions(undefined, 'copilot')
    const sessions = projects.flatMap(p => p.sessions).filter(s => s.sessionId === 'sess-reason')
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.totalReasoningTokens).toBe(800)
    // The rollup is supplementary accounting: usage served, zero call weight.
    expect(sessions[0]!.apiCalls).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (f) Version-bump survival: a PROVIDER_PARSE_VERSIONS bump (or any env
//     fingerprint change) must NOT erase durable orphans. The cache is the
//     only remaining record of usage whose source was pruned; discarding the
//     section wholesale on fingerprint mismatch permanently lost that history
//     (caught in the #684 re-review).
// ═══════════════════════════════════════════════════════════════════════════
describe('(f) durable orphans survive a parse-version bump', () => {
  it('keeps counting a pruned-source orphan after the provider fingerprint changes', async () => {
    const sessionStateDir = join(tmpHome, 'session-state')
    await mkdir(sessionStateDir, { recursive: true })
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STATE_DIR', sessionStateDir)
    vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '1')
    vi.stubEnv('CODEBURN_COPILOT_WS_STORAGE_DIR', join(tmpHome, 'no-ws'))

    // Parse once so the session is cached, then prune the source: the cache
    // entry becomes a durable orphan (its only record).
    const eventsPath = await createJsonlSession(sessionStateDir, 'sess-bump', 200)
    const before = totalOutput(await parseAllSessions(undefined, 'copilot'))
    expect(before).toBe(200)
    await unlink(eventsPath)
    clearSessionCache()

    // Simulate the fingerprint a PREVIOUS release computed (any mismatching
    // value takes the same code path as a real parse-version bump).
    const disk = await readCacheOnDisk()
    expect(disk.providers['copilot']).toBeDefined()
    disk.providers['copilot']!.envFingerprint = '0000000000000000'
    await writeCacheOnDisk(disk)

    // First parse after the "upgrade": the orphan must still be counted and
    // must survive in the rewritten cache, not be erased with the section.
    const after = totalOutput(await parseAllSessions(undefined, 'copilot'))
    expect(after).toBe(200)

    clearSessionCache()
    const again = totalOutput(await parseAllSessions(undefined, 'copilot'))
    expect(again).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (f2) Version-bump survival for an EXTANT-but-pruned durable DB. The orphan
//      carry-forward in (f) keyed on "the source path is gone", but a durable
//      SQLite source keeps its file forever while the CLI prunes rows out of
//      it — so a parse-version bump was deleting exactly the history only the
//      cache still held (#946 review, blocker 1). Also pins the other
//      direction: an intact source re-read under the bump must not DOUBLE,
//      which is the dedup-key-stability contract the union merge rests on.
// ═══════════════════════════════════════════════════════════════════════════
describe.skipIf(!isSqliteAvailable())('(f2) durable history survives a bump on an extant, pruned DB', () => {
  const stubOtelOnly = (dbPath: string): void => {
    vi.stubEnv('CODEBURN_COPILOT_OTEL_DB', dbPath)
    vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '')
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STATE_DIR', join(tmpHome, 'no-jsonl'))
    vi.stubEnv('CODEBURN_COPILOT_WS_STORAGE_DIR', join(tmpHome, 'no-ws'))
  }

  // Take the same code path a real PROVIDER_PARSE_VERSIONS bump takes: any
  // mismatching persisted envFingerprint rebuilds the provider section.
  const simulateVersionBump = async (): Promise<void> => {
    clearSessionCache()
    const disk = await readCacheOnDisk()
    expect(disk.providers['copilot']).toBeDefined()
    // Self-check: a sentinel equal to the real fingerprint would make the
    // section MATCH and the test would pass while exercising nothing.
    expect(disk.providers['copilot']!.envFingerprint).not.toBe('0000000000000000')
    disk.providers['copilot']!.envFingerprint = '0000000000000000'
    await writeCacheOnDisk(disk)
  }

  it('keeps a pruned conversation whose DB file still exists', async () => {
    const dbPath = join(tmpHome, 'agent-traces.db')
    stubOtelOnly(dbPath)

    createOtelDb(dbPath)
    insertOtelConv(dbPath, { spanId: 's1', traceId: 't1', convId: 'bump-c1', model: 'gpt-4.1', input: 500, output: 50 })
    insertOtelConv(dbPath, { spanId: 's2', traceId: 't2', convId: 'bump-c2', model: 'gpt-4.1', input: 1000, output: 100 })
    expect(totalOutput(await parseAllSessions(undefined, 'copilot'))).toBe(150)

    // The CLI prunes conv-1. The DB file is still there, still valid, just
    // smaller — the shape that "carry forward only vanished paths" missed.
    clearSessionCache()
    await rm(dbPath)
    createOtelDb(dbPath)
    insertOtelConv(dbPath, { spanId: 's2', traceId: 't2', convId: 'bump-c2', model: 'gpt-4.1', input: 1000, output: 100 })
    expect(totalOutput(await parseAllSessions(undefined, 'copilot'))).toBe(150)

    await simulateVersionBump()

    // The bump re-reads the live DB (conv-2) and unions it with the cached
    // conv-1 the DB can no longer produce. Nothing is lost, nothing doubles.
    expect(totalOutput(await parseAllSessions(undefined, 'copilot'))).toBe(150)

    // And it is PERSISTED, not just served: a cold read of the rewritten
    // cache still has it, otherwise the loss is merely deferred one run.
    clearSessionCache()
    expect(totalOutput(await parseAllSessions(undefined, 'copilot'))).toBe(150)
    const disk = await readCacheOnDisk()
    const keys = Object.values(disk.providers['copilot']?.files ?? {})
      .flatMap(f => f.turns).flatMap(t => t.calls).map(c => c.deduplicationKey)
    expect(keys).toContain('copilot-otel:s1')
  })

  it('does not double an intact DB re-read under the bump', async () => {
    const dbPath = join(tmpHome, 'agent-traces-intact.db')
    stubOtelOnly(dbPath)

    createOtelDb(dbPath)
    insertOtelConv(dbPath, { spanId: 's1', traceId: 't1', convId: 'intact-c1', model: 'gpt-4.1', input: 500, output: 50 })
    insertOtelConv(dbPath, { spanId: 's2', traceId: 't2', convId: 'intact-c2', model: 'gpt-4.1', input: 1000, output: 100 })
    expect(totalOutput(await parseAllSessions(undefined, 'copilot'))).toBe(150)

    await simulateVersionBump()

    // Every row is still derivable, so the union must recognise all of them
    // by dedup key and append nothing.
    expect(totalOutput(await parseAllSessions(undefined, 'copilot'))).toBe(150)
    clearSessionCache()
    expect(totalOutput(await parseAllSessions(undefined, 'copilot'))).toBe(150)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (f3) Cross-source snapshot ordering for the durable record. Copilot
//      reconciles a session.shutdown rollup against the session-store rows
//      written up to it; the two are different files, so a session that shuts
//      down mid-pass can leave whichever we read first short. Reading the
//      store LAST makes the row set a superset of anything a rollup we read
//      can claim, and a store we did not re-read (unchanged at classification)
//      that moves during the pass is a partial hydration, not a number to
//      seal. (#946 review, blocker 2.)
// ═══════════════════════════════════════════════════════════════════════════
describe('(f3) durable-record read ordering and mid-pass fence', () => {
  it('parses a retainWhilePresent source after every other changed source', async () => {
    const storeFile = join(tmpHome, 'ordering-store.txt')
    const journalA = join(tmpHome, 'ordering-a.txt')
    const journalB = join(tmpHome, 'ordering-b.txt')
    for (const f of [storeFile, journalA, journalB]) await writeFile(f, 'v1')

    // Deliberately listed FIRST: discovery order must not decide this.
    _synthDurable = true
    _synthSources = [
      { path: storeFile, project: 'test', provider: 'test-synthetic', retainWhilePresent: true },
      { path: journalA, project: 'test', provider: 'test-synthetic' },
      { path: journalB, project: 'test', provider: 'test-synthetic' },
    ]
    _synthYields = []

    const order: string[] = []
    _synthOnParse = (source) => { order.push(source.path) }
    await parseAllSessions(undefined, 'test-synthetic')
    _synthOnParse = null

    expect(order).toHaveLength(3)
    expect(order[order.length - 1]).toBe(storeFile)
  })

  it('reports partial hydration when a cache-served store moves during the pass', async () => {
    const storeFile = join(tmpHome, 'fence-store.txt')
    const journal = join(tmpHome, 'fence-journal.txt')
    await writeFile(storeFile, 'rows-v1')
    await writeFile(journal, 'journal-v1')

    _synthDurable = true
    _synthSources = [
      { path: storeFile, project: 'test', provider: 'test-synthetic', retainWhilePresent: true },
      { path: journal, project: 'test', provider: 'test-synthetic' },
    ]
    _synthYields = []

    // Warm both entries so the store can be served from cache next pass.
    await parseAllSessions(undefined, 'test-synthetic')
    expect(isSessionHydrationComplete()).toBe(true)

    // Only the journal changed, so only the journal is re-read — and while it
    // is being read, the store grows. This is the exact window the ordering
    // cannot close: the rows we are about to reconcile the journal against
    // were pinned before the journal was read.
    clearSessionCache()
    await writeFile(journal, 'journal-v2-longer')
    _synthOnParse = async (source) => {
      if (source.path === journal) await writeFile(storeFile, 'rows-v2-longer')
    }
    await parseAllSessions(undefined, 'test-synthetic')
    _synthOnParse = null
    expect(isSessionHydrationComplete()).toBe(false)

    // The next refresh sees the store as changed, re-reads it last, and the
    // fence lifts on its own — it holds a day back, it does not wedge.
    clearSessionCache()
    await parseAllSessions(undefined, 'test-synthetic')
    expect(isSessionHydrationComplete()).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (g) Skill attribution is independent of turn category
// ═══════════════════════════════════════════════════════════════════════════
describe('(g) skill attribution is independent of turn category', () => {
  it('puts a Skill + Edit turn in skillBreakdown while preserving coding category', async () => {
    const synthFile = join(tmpHome, 'synth-skill.txt')
    await writeFile(synthFile, 'placeholder')

    _synthSources = [{ path: synthFile, project: 'test', provider: 'test-synthetic' }]
    _synthYields = [{
      provider: 'test-synthetic', model: 'gpt-4o',
      inputTokens: 10, outputTokens: 5,
      cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0,
      costUSD: 0.001, tools: ['Skill', 'Edit'], bashCommands: [],
      skills: ['telemetry-review'],
      timestamp: '2026-07-18T12:00:00.000Z',
      speed: 'standard',
      deduplicationKey: 'synth-skill-edit',
      userMessage: '', sessionId: 'synth-skill-session',
    }]

    const projects = await parseAllSessions(undefined, 'test-synthetic')
    const session = projects.flatMap(project => project.sessions)[0]

    expect(session).toBeDefined()
    expect(session!.turns[0]!.category).toBe('coding')
    expect(session!.turns[0]!.subCategory).toBe('telemetry-review')
    expect(session!.categoryBreakdown.coding.turns).toBe(1)
    expect(session!.skillBreakdown['telemetry-review']?.turns).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (h) Provider filter isolates claude: a --provider <other> run must not
//     re-surface cached claude sessions through the orphan pass, while a run
//     that DOES include claude still preserves PR-bearing orphans.
// ═══════════════════════════════════════════════════════════════════════════
describe('(h) provider filter excludes claude from the orphan pass', () => {
  const SYNTH_SOURCE = (path: string): SessionSource[] =>
    [{ path, project: 'synth-proj', provider: 'test-synthetic' }]

  // The provider lives on each parsed call, not on SessionSummary.
  const providersOf = (projects: Awaited<ReturnType<typeof parseAllSessions>>): Set<string> =>
    new Set(projects
      .flatMap(p => p.sessions)
      .flatMap(s => s.turns)
      .flatMap(t => t.assistantCalls)
      .map(c => c.provider))

  const SYNTH_CALL: ParsedProviderCall = {
    provider: 'test-synthetic', model: 'gpt-4o',
    inputTokens: 10, outputTokens: 5,
    cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
    cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0,
    costUSD: 0.25, tools: [], bashCommands: [],
    skills: [],
    timestamp: '2026-07-18T12:00:00.000Z',
    speed: 'standard',
    deduplicationKey: 'synth-isolation-call',
    userMessage: '', sessionId: 'synth-isolation-session',
  }

  // A claude transcript carrying a pr-link: `prLinks` is exactly what lets a
  // cached entry survive the write-mode orphan gate, so it is the shape that
  // leaks. Cost is deliberately far larger than the synthetic call's, so a leak
  // is unmistakable rather than a rounding difference.
  async function writeClaudeSessionWithPrLink(): Promise<string> {
    const projectDir = join(tmpHome, '.claude', 'projects', 'leaky-app')
    await mkdir(projectDir, { recursive: true })
    const filePath = join(projectDir, 'session.jsonl')
    await writeFile(filePath, [
      JSON.stringify({
        type: 'user', sessionId: 'claude-leak-1', timestamp: '2026-07-18T12:00:00.000Z',
        message: { role: 'user', content: 'ship it' },
      }),
      JSON.stringify({
        type: 'assistant', sessionId: 'claude-leak-1', timestamp: '2026-07-18T12:00:10.000Z',
        message: {
          id: 'msg-leak-1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'done' }],
          usage: { input_tokens: 900_000, output_tokens: 90_000 },
        },
      }),
      JSON.stringify({
        type: 'pr-link', sessionId: 'claude-leak-1', timestamp: '2026-07-18T12:00:20.000Z',
        prUrl: 'https://github.com/getagentseal/codeburn/pull/1',
      }),
    ].join('\n') + '\n')
    return filePath
  }

  it('does not surface cached claude sessions when filtering to another provider', async () => {
    const synthFile = join(tmpHome, 'synth-isolation.txt')
    await writeFile(synthFile, 'placeholder')
    await writeClaudeSessionWithPrLink()

    _synthSources = SYNTH_SOURCE(synthFile)
    _synthYields = [SYNTH_CALL]

    // Baseline: what the synthetic provider costs on its own, before anything
    // claude-shaped has ever entered the session cache. Self-calibrating, since
    // cost is re-derived from tokens by the pricing engine.
    const baseline = await parseAllSessions(undefined, 'test-synthetic')
    const synthOnlyCost = totalCost(baseline)
    expect([...providersOf(baseline)]).toEqual(['test-synthetic'])
    clearSessionCache()

    // Warm the session cache so the claude file is persisted WITH its prLinks.
    const all = await parseAllSessions(undefined, 'all')
    expect(providersOf(all)).toContain('claude')
    expect(totalCost(all)).toBeGreaterThan(synthOnlyCost)

    clearSessionCache()

    // Filtering to the synthetic provider must yield ONLY its own spend. Before
    // the fix, claudeDirs was empty yet scanProjectDirs still ran, so every
    // cached PR-bearing claude file was treated as a pruned orphan and re-added.
    const filtered = await parseAllSessions(undefined, 'test-synthetic')

    expect([...providersOf(filtered)]).toEqual(['test-synthetic'])
    expect(totalCost(filtered)).toBeCloseTo(synthOnlyCost, 10)
  })

  it('still preserves a PR-bearing claude orphan when claude IS in scope', async () => {
    const filePath = await writeClaudeSessionWithPrLink()
    _synthSources = []
    _synthYields = []

    const before = await parseAllSessions(undefined, 'all')
    const costBefore = totalCost(before)
    expect(costBefore).toBeGreaterThan(0)

    // Every claude transcript disappears from disk. Claude is still in scope, so
    // the orphan pass must keep the PR-attributed spend alive — this is the case
    // a naive `claudeDirs.length > 0` guard would silently break.
    await unlink(filePath)
    clearSessionCache()

    const after = await parseAllSessions(undefined, 'all')
    expect(totalCost(after)).toBeCloseTo(costBefore, 10)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (f) Growing resumed CLI session: durable merge appends only the new leg
// ═══════════════════════════════════════════════════════════════════════════
// Resumed Copilot CLI sessions append one CUMULATIVE session.shutdown per leg
// (#944). The parser emits per-leg deltas keyed by occurrence; this exercises
// the PRODUCTION merge path — the durable union-by-dedup-key merge against the
// on-disk cache when the file grows between parses — which the unit tests
// (which pre-seed seenKeys) cannot reach.
describe('(f) growing resumed CLI session durable merge', () => {
  it('totals equal the final cumulative rollup after the file grows a leg', async () => {
    const sessionStateDir = join(tmpHome, 'session-state')
    await mkdir(sessionStateDir, { recursive: true })
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STATE_DIR', sessionStateDir)
    vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '1')
    vi.stubEnv('CODEBURN_COPILOT_WS_STORAGE_DIR', join(tmpHome, 'no-ws'))
    vi.stubEnv('CODEBURN_COPILOT_GLOBAL_STORAGE_DIR', join(tmpHome, 'no-global'))
    vi.stubEnv('CODEBURN_COPILOT_JETBRAINS_DIR', join(tmpHome, 'no-jb'))

    const base = Date.now() - 5 * 24 * 60 * 60 * 1000
    const at = (offsetSec: number): string => new Date(base + offsetSec * 1000).toISOString()
    const dir = join(sessionStateDir, 'sess-grow')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'workspace.yaml'), 'id: sess-grow\ncwd: /home/user/testproj\n')
    const eventsPath = join(dir, 'events.jsonl')

    // Cumulative rollups from a real resumed CLI 1.0.78 session.
    const shutdown = (ts: string, inputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, outputTokens: number) =>
      JSON.stringify({
        type: 'session.shutdown',
        timestamp: ts,
        data: {
          shutdownType: 'routine',
          modelMetrics: {
            'claude-sonnet-4-5': {
              requests: { count: 1, cost: 1 },
              usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens: 0 },
            },
          },
        },
      })
    const leg1 = [
      JSON.stringify({ type: 'session.model_change', timestamp: at(0), data: { newModel: 'claude-sonnet-4-5' } }),
      JSON.stringify({ type: 'assistant.message', timestamp: at(10), data: { messageId: 'msg-1', outputTokens: 17, toolRequests: [] } }),
      shutdown(at(20), 24672, 0, 24670, 17),
    ]
    await writeFile(eventsPath, leg1.join('\n') + '\n')

    const sumUsage = (projects: Awaited<ReturnType<typeof parseAllSessions>>) => {
      const calls = projects.flatMap(p => p.sessions).flatMap(s => s.turns).flatMap(t => t.assistantCalls)
      return {
        input: calls.reduce((s, c) => s + c.usage.inputTokens, 0),
        cacheRead: calls.reduce((s, c) => s + c.usage.cacheReadInputTokens, 0),
        cacheWrite: calls.reduce((s, c) => s + c.usage.cacheCreationInputTokens, 0),
      }
    }

    const first = sumUsage(await parseAllSessions(undefined, 'copilot'))
    expect(first).toEqual({ input: 2, cacheRead: 0, cacheWrite: 24670 })

    // The session resumes: leg 2 appends per-turn events plus a CUMULATIVE
    // rollup. The cached leg-1 delta must be kept once and only the leg-2
    // delta appended — totals equal the final cumulative rollup exactly.
    clearSessionCache()
    await writeFile(eventsPath, [
      ...leg1,
      JSON.stringify({ type: 'assistant.message', timestamp: at(100), data: { messageId: 'msg-2', outputTokens: 132, toolRequests: [] } }),
      shutdown(at(120), 74463, 49489, 24968, 149),
    ].join('\n') + '\n')

    const second = sumUsage(await parseAllSessions(undefined, 'copilot'))
    expect(second).toEqual({ input: 74463 - 49489 - 24968, cacheRead: 49489, cacheWrite: 24968 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (q) Burst reuse: a through-now range re-anchored seconds later reuses the
//     previous parse instead of re-running discovery (serve fast-path)
// ═══════════════════════════════════════════════════════════════════════════
describe('(q) parse burst reuse (CODEBURN_PARSE_BURST_MS)', () => {
  it('serves a re-anchored range from the previous parse inside the window, never outside it', async () => {
    vi.stubEnv('CODEBURN_PARSE_BURST_MS', '10000')
    clearSessionCache()
    const start = new Date(Date.now() - 60 * 60 * 1000)
    const ts = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const synthFile = join(tmpHome, 'synth-burst.txt')
    await writeFile(synthFile, 'placeholder')
    _synthSources = [{ path: synthFile, project: 'p', provider: 'test-synthetic' }]
    _synthYields = [{
      provider: 'test-synthetic', model: 'synth-model',
      inputTokens: 1, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0,
      costUSD: 0, costIsEstimated: false, tools: [], bashCommands: [], skills: [],
      timestamp: ts, speed: 'standard', deduplicationKey: 'synth-burst-1', userMessage: 'hi', sessionId: 'sb-1',
    }] as never

    const first = await parseAllSessions({ start, end: new Date() }, 'test-synthetic')
    expect(totalOutput(first)).toBe(5)

    // The world changes (a second call appears), but a burst-window re-anchor
    // must serve the PREVIOUS parse: same data, no re-discovery.
    _synthYields = [..._synthYields, {
      ...( _synthYields[0] as object ), deduplicationKey: 'synth-burst-2', outputTokens: 7,
    }] as never
    const second = await parseAllSessions({ start, end: new Date(Date.now() + 1000) }, 'test-synthetic')
    expect(totalOutput(second)).toBe(5)

    // Outside the window (env cleared = burst disabled), the fresh parse sees
    // the new call: proof the reuse was the burst path, not staleness. The
    // source file must actually change, or the fingerprint-keyed disk cache
    // (correctly) serves the old turns.
    vi.stubEnv('CODEBURN_PARSE_BURST_MS', '0')
    await writeFile(synthFile, 'placeholder v2 with a second call')
    clearSessionCache()
    const third = await parseAllSessions({ start, end: new Date(Date.now() + 2000) }, 'test-synthetic')
    expect(totalOutput(third)).toBe(12)
    vi.unstubAllEnvs()
    _synthSources = []
    _synthYields = []
  })
})

describe('(r) validated parse reuse (setParseReuseValidator)', () => {
  it('falls back to the exact TTL when watcher coverage is unknown, but rejects dirty', async () => {
    vi.stubEnv('CODEBURN_PARSE_BURST_MS', '0')
    clearSessionCache()
    const start = new Date(Date.now() - 60 * 60 * 1000)
    const end = new Date()
    const ts = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const synthFile = join(tmpHome, 'synth-unknown-exact.txt')
    await writeFile(synthFile, 'first input')
    _synthSources = [{ path: synthFile, project: 'p', provider: 'test-synthetic' }]
    _synthYields = [{
      provider: 'test-synthetic', model: 'synth-model',
      inputTokens: 1, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0,
      costUSD: 0, costIsEstimated: false, tools: [], bashCommands: [], skills: [],
      timestamp: ts, speed: 'standard', deduplicationKey: 'synth-unknown-exact-1', userMessage: 'hi', sessionId: 'sue-1',
    }] as never

    expect(totalOutput(await parseAllSessions({ start, end }, 'test-synthetic'))).toBe(5)
    _synthYields = [..._synthYields, {
      ...( _synthYields[0] as object ), deduplicationKey: 'synth-unknown-exact-2', outputTokens: 7,
    }] as never
    await writeFile(synthFile, 'second input with changed fingerprint')

    // An unhealthy/pre-arm watcher cannot extend freshness, but it must retain
    // the normal exact-key TTL instead of forcing a full rescan every request.
    setParseReuseValidator(() => 'unknown')
    expect(totalOutput(await parseAllSessions({ start, end }, 'test-synthetic'))).toBe(5)

    // The same entry must be rejected immediately once a real change is known.
    setParseReuseValidator(() => 'dirty')
    expect(totalOutput(await parseAllSessions({ start, end }, 'test-synthetic'))).toBe(12)
  })

  it('falls back to the short burst when watcher coverage is unknown, but dirty wins inside it', async () => {
    vi.stubEnv('CODEBURN_PARSE_BURST_MS', '10000')
    clearSessionCache()
    const start = new Date(Date.now() - 60 * 60 * 1000)
    const firstEnd = new Date()
    const ts = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const synthFile = join(tmpHome, 'synth-unknown-burst.txt')
    await writeFile(synthFile, 'first input')
    _synthSources = [{ path: synthFile, project: 'p', provider: 'test-synthetic' }]
    _synthYields = [{
      provider: 'test-synthetic', model: 'synth-model',
      inputTokens: 1, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0,
      costUSD: 0, costIsEstimated: false, tools: [], bashCommands: [], skills: [],
      timestamp: ts, speed: 'standard', deduplicationKey: 'synth-unknown-burst-1', userMessage: 'hi', sessionId: 'sub-1',
    }] as never

    expect(totalOutput(await parseAllSessions({ start, end: firstEnd }, 'test-synthetic'))).toBe(5)
    _synthYields = [..._synthYields, {
      ...( _synthYields[0] as object ), deduplicationKey: 'synth-unknown-burst-2', outputTokens: 7,
    }] as never
    await writeFile(synthFile, 'second input with changed fingerprint')

    setParseReuseValidator(() => 'unknown')
    expect(totalOutput(await parseAllSessions(
      { start, end: new Date(firstEnd.getTime() + 100) },
      'test-synthetic',
    ))).toBe(5)

    setParseReuseValidator(() => 'dirty')
    expect(totalOutput(await parseAllSessions(
      { start, end: new Date(firstEnd.getTime() + 200) },
      'test-synthetic',
    ))).toBe(12)
  })

  it('reuses past the burst window while the validator reports quiet, never when dirty', async () => {
    vi.stubEnv('CODEBURN_PARSE_BURST_MS', '1')
    clearSessionCache()
    const start = new Date(Date.now() - 60 * 60 * 1000)
    const ts = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const synthFile = join(tmpHome, 'synth-validated.txt')
    await writeFile(synthFile, 'placeholder')
    _synthSources = [{ path: synthFile, project: 'p', provider: 'test-synthetic' }]
    _synthYields = [{
      provider: 'test-synthetic', model: 'synth-model',
      inputTokens: 1, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0,
      costUSD: 0, costIsEstimated: false, tools: [], bashCommands: [], skills: [],
      timestamp: ts, speed: 'standard', deduplicationKey: 'synth-val-1', userMessage: 'hi', sessionId: 'sv-1',
    }] as never

    const first = await parseAllSessions({ start, end: new Date() }, 'test-synthetic')
    expect(totalOutput(first)).toBe(5)

    // 1ms burst window has certainly elapsed; with a quiet validator the
    // previous parse is still served (world changed, result must not).
    await new Promise(r => setTimeout(r, 5))
    setParseReuseValidator(() => 'clean')
    _synthYields = [..._synthYields, { ...( _synthYields[0] as object ), deduplicationKey: 'synth-val-2', outputTokens: 7 }] as never
    await writeFile(synthFile, 'placeholder v2')
    const second = await parseAllSessions({ start, end: new Date(Date.now() + 500) }, 'test-synthetic')
    expect(totalOutput(second)).toBe(5)

    // A dirty validator ends the reuse: fresh parse sees the new call.
    setParseReuseValidator(() => 'dirty')
    const third = await parseAllSessions({ start, end: new Date(Date.now() + 1000) }, 'test-synthetic')
    expect(totalOutput(third)).toBe(12)

    setParseReuseValidator(null)
    vi.unstubAllEnvs()
    _synthSources = []
    _synthYields = []
  })

  it('rejects an exact-key memo when a root event arrived during its parse', async () => {
    clearSessionCache()
    const start = new Date(Date.now() - 60 * 60 * 1000)
    const end = new Date()
    const ts = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const synthFile = join(tmpHome, 'synth-exact-event-during-parse.txt')
    await writeFile(synthFile, 'first input')
    _synthSources = [{ path: synthFile, project: 'p', provider: 'test-synthetic' }]
    _synthYields = [{
      provider: 'test-synthetic', model: 'synth-model',
      inputTokens: 1, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0,
      costUSD: 0, costIsEstimated: false, tools: [], bashCommands: [], skills: [],
      timestamp: ts, speed: 'standard', deduplicationKey: 'synth-exact-event-1', userMessage: 'hi', sessionId: 'see-1',
    }] as never

    let rootEventAt = 0
    setParseReuseValidator(sinceTs => rootEventAt === 0 || rootEventAt < sinceTs ? 'clean' : 'dirty')
    _synthOnParse = async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
      rootEventAt = Date.now()
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const first = await parseAllSessions({ start, end }, 'test-synthetic')
    expect(totalOutput(first)).toBe(5)
    _synthOnParse = null

    _synthYields = [..._synthYields, {
      ...( _synthYields[0] as object ), deduplicationKey: 'synth-exact-event-2', outputTokens: 7,
    }] as never
    await writeFile(synthFile, 'second input')
    const second = await parseAllSessions({ start, end }, 'test-synthetic')
    expect(totalOutput(second)).toBe(12)
  })

  it('does not bless a root event that arrived while the cached parse was running', async () => {
    vi.stubEnv('CODEBURN_PARSE_BURST_MS', '1')
    clearSessionCache()
    const start = new Date(Date.now() - 60 * 60 * 1000)
    const firstEnd = new Date()
    const ts = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const synthFile = join(tmpHome, 'synth-event-during-parse.txt')
    await writeFile(synthFile, 'first input')
    _synthSources = [{ path: synthFile, project: 'p', provider: 'test-synthetic' }]
    _synthYields = [{
      provider: 'test-synthetic', model: 'synth-model',
      inputTokens: 1, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0,
      costUSD: 0, costIsEstimated: false, tools: [], bashCommands: [], skills: [],
      timestamp: ts, speed: 'standard', deduplicationKey: 'synth-event-1', userMessage: 'hi', sessionId: 'se-1',
    }] as never

    let rootEventAt = 0
    _synthOnParse = async () => {
      // Bracket the controlled event so it is strictly after parse start and
      // strictly before completion, independent of same-millisecond clocks.
      await new Promise(resolve => setTimeout(resolve, 10))
      rootEventAt = Date.now()
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const first = await parseAllSessions({ start, end: firstEnd }, 'test-synthetic')
    expect(totalOutput(first)).toBe(5)
    expect(rootEventAt).toBeGreaterThan(0)
    _synthOnParse = null

    // Outside the 1ms burst, old code validated against cachePut completion
    // and reused stale output because the in-parse event appeared older. The
    // parse-start timestamp makes the validator reject reuse and rescan.
    await new Promise(resolve => setTimeout(resolve, 5))
    setParseReuseValidator(sinceTs => rootEventAt < sinceTs ? 'clean' : 'dirty')
    _synthYields = [..._synthYields, {
      ...( _synthYields[0] as object ), deduplicationKey: 'synth-event-2', outputTokens: 7,
    }] as never
    await writeFile(synthFile, 'second input')
    const second = await parseAllSessions(
      { start, end: new Date(firstEnd.getTime() + 500) },
      'test-synthetic',
    )
    expect(totalOutput(second)).toBe(12)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (i) Growing session-store DB: durable merge appends only the new rows
// ═══════════════════════════════════════════════════════════════════════════
// session-store.db records one usage row per API request; rows only ever
// append (AUTOINCREMENT ids). This exercises the PRODUCTION path end to end:
// both representations parse and cache, serve-time precedence
// (parseProviderSources) drops the covered session's shutdown rollup, and a
// re-parse after INSERTs appends exactly the new rows under the durable
// union-by-dedup-key merge — totals must equal the DB, not the rollup, and
// never double-count.
function createStoreDb(dbPath: string): void {
  const { DatabaseSync } = requireForTest('node:sqlite') as { DatabaseSync: new (path: string) => TestDb }
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, created_at TEXT);
    CREATE TABLE assistant_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      reasoning_tokens INTEGER,
      created_at TEXT
    );
  `)
  db.close()
}

function insertStoreRow(
  dbPath: string,
  sessionId: string,
  inputTokens: number,   // cache-inclusive, as the CLI writes it
  cacheRead: number,
  cacheWrite: number,
  createdAt: string,
  reasoning = 0,
  cwd = '/home/user/testproj',
): void {
  const { DatabaseSync } = requireForTest('node:sqlite') as { DatabaseSync: new (path: string) => TestDb }
  const db = new DatabaseSync(dbPath)
  db.prepare(`INSERT OR IGNORE INTO sessions (id, cwd) VALUES (?, ?)`).run(sessionId, cwd)
  db.prepare(
    `INSERT INTO assistant_usage_events
       (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, created_at)
     VALUES (?, 'claude-sonnet-4-5', ?, 0, ?, ?, ?, ?)`
  ).run(sessionId, inputTokens, cacheRead, cacheWrite, reasoning, createdAt)
  db.close()
}

/**
 * Make the store's rows unreadable until the returned callback runs.
 *
 * On Windows chmod only toggles the read-only attribute, so mode 0 still
 * reads; the equivalent there is SQLite's own exclusive lock, which the store
 * parser classifies as the same retryable deferral shape as EACCES.
 */
async function blockStoreReads(dbPath: string): Promise<() => Promise<void>> {
  if (process.platform !== 'win32') {
    const { chmod } = await import('fs/promises')
    await chmod(dbPath, 0o000)
    return async () => { await chmod(dbPath, 0o644) }
  }
  const { DatabaseSync } = requireForTest('node:sqlite') as { DatabaseSync: new (path: string) => TestDb }
  const holder = new DatabaseSync(dbPath)
  holder.exec('BEGIN EXCLUSIVE')
  return async () => {
    holder.exec('ROLLBACK')
    holder.close()
  }
}

/**
 * Make the store's own path fail to stat - present, but unreadable - until the
 * returned callback runs.
 *
 * The POSIX form drops traversal on the parent directory. Windows has no
 * equivalent, so the path becomes a self-referencing junction instead: it
 * stats as ELOOP, which is the "not absent, not readable" shape under test.
 */
async function blockStoreStat(dbPath: string, storeDir: string): Promise<() => Promise<void>> {
  const { chmod, rename, rmdir } = await import('fs/promises')
  if (process.platform !== 'win32') {
    await chmod(storeDir, 0o000)
    return async () => { await chmod(storeDir, 0o755) }
  }
  const { execFileSync } = await import('child_process')
  const hidden = dbPath + '.blocked'
  const loop = dbPath + '.loop'
  await rename(dbPath, hidden)
  execFileSync('cmd', ['/c', 'mklink', '/J', dbPath, loop], { stdio: 'pipe' })
  execFileSync('cmd', ['/c', 'mklink', '/J', loop, dbPath], { stdio: 'pipe' })
  return async () => {
    await rmdir(dbPath)
    await rmdir(loop)
    await rename(hidden, dbPath)
  }
}

describe.skipIf(!isSqliteAvailable())('(i) growing session-store DB durable merge', () => {
  it('totals track the store exactly as rows append, with the rollup reconciled away', async () => {
    const sessionStateDir = join(tmpHome, 'session-state')
    await mkdir(sessionStateDir, { recursive: true })
    const dbPath = join(tmpHome, 'session-store.db')
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STATE_DIR', sessionStateDir)
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STORE_DB', dbPath)
    vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '1')
    vi.stubEnv('CODEBURN_COPILOT_WS_STORAGE_DIR', join(tmpHome, 'no-ws'))
    vi.stubEnv('CODEBURN_COPILOT_GLOBAL_STORAGE_DIR', join(tmpHome, 'no-global'))
    vi.stubEnv('CODEBURN_COPILOT_JETBRAINS_DIR', join(tmpHome, 'no-jb'))

    const base = Date.now() - 5 * 24 * 60 * 60 * 1000
    const at = (offsetSec: number): string => new Date(base + offsetSec * 1000).toISOString()

    // The session's events.jsonl carries per-turn output AND a shutdown
    // rollup summing exactly the two covered requests (the production shape:
    // rows commit before the rollup is written, cache-inclusive on both
    // sides). If reconciliation failed to replace the rollup, totals would
    // double; if it dropped usage, they would fall short of the rows.
    const dir = join(sessionStateDir, 'sess-store')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'workspace.yaml'), 'id: sess-store\ncwd: /home/user/testproj\n')
    await writeFile(join(dir, 'events.jsonl'), [
      JSON.stringify({ type: 'session.model_change', timestamp: at(0), data: { newModel: 'claude-sonnet-4-5' } }),
      JSON.stringify({ type: 'assistant.message', timestamp: at(10), data: { messageId: 'msg-1', outputTokens: 17, toolRequests: [] } }),
      JSON.stringify({
        type: 'session.shutdown',
        timestamp: at(20),
        data: {
          shutdownType: 'routine',
          modelMetrics: {
            'claude-sonnet-4-5': {
              requests: { count: 2, cost: 1 },
              usage: { inputTokens: 20000, outputTokens: 17, cacheReadTokens: 17000, cacheWriteTokens: 2400, reasoningTokens: 40 },
            },
          },
        },
      }),
    ].join('\n') + '\n')

    createStoreDb(dbPath)
    // Row 1 carries reasoning tokens: they are a subset of the session's
    // per-turn output and must ride as metadata WITHOUT entering the
    // query-path cost recompute (cachedCallToApiCall discards the parser's
    // costUSD for copilot and re-derives from tokens — the assertion below
    // is the only guard that exercises that production path).
    insertStoreRow(dbPath, 'sess-store', 12000, 10000, 1500, at(12), 40) // input 500
    insertStoreRow(dbPath, 'sess-store', 8000, 7000, 900, at(15))       // input 100

    const sumUsage = (projects: Awaited<ReturnType<typeof parseAllSessions>>) => {
      const calls = projects.flatMap(p => p.sessions).flatMap(s => s.turns).flatMap(t => t.assistantCalls)
      return {
        input: calls.reduce((s, c) => s + c.usage.inputTokens, 0),
        cacheRead: calls.reduce((s, c) => s + c.usage.cacheReadInputTokens, 0),
        cacheWrite: calls.reduce((s, c) => s + c.usage.cacheCreationInputTokens, 0),
        output: calls.reduce((s, c) => s + c.usage.outputTokens, 0),
        cost: calls.reduce((s, c) => s + c.costUSD, 0),
      }
    }

    // The reasoning-free cost of everything above: per-turn output plus the
    // two store rows priced on input/cache alone. A higher observed cost
    // means the 40 reasoning tokens were billed at the output rate on a call
    // that owns no output — double-billing them against the per-turn call.
    const expectedCost =
      calculateCost('claude-sonnet-4-5', 0, 17, 0, 0, 0) +
      calculateCost('claude-sonnet-4-5', 500, 0, 1500, 10000, 0) +
      calculateCost('claude-sonnet-4-5', 100, 0, 900, 7000, 0)

    // First parse: input/cache equal the DB rows exactly (the rollup is
    // reconciled away, residual zero); output stays with the per-turn event.
    const first = sumUsage(await parseAllSessions(undefined, 'copilot'))
    expect(first.cost).toBeCloseTo(expectedCost, 12)
    expect(first).toEqual({ input: 600, cacheRead: 17000, cacheWrite: 2400, output: 17, cost: first.cost })

    // The session continues: one more API request lands as one more row.
    // Re-parse against the warm disk cache — the durable merge must append
    // only the new row's key, keeping totals equal to the DB.
    clearSessionCache()
    insertStoreRow(dbPath, 'sess-store', 5000, 4600, 300, at(30))    // input 100

    const second = sumUsage(await parseAllSessions(undefined, 'copilot'))
    expect(second.cost).toBeCloseTo(expectedCost + calculateCost('claude-sonnet-4-5', 100, 0, 300, 4600, 0), 12)
    expect(second).toEqual({ input: 700, cacheRead: 21600, cacheWrite: 2700, output: 17, cost: second.cost })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (k) Serve-time precedence heals a durably double-cached session
// ═══════════════════════════════════════════════════════════════════════════
// The union merge never deletes, so a rollup cached while the store was
// unreadable (an unsupported-schema epoch, a runtime without node:sqlite,
// restored files) survives the store later becoming readable — and its
// session's rows would then be cached beside it. Serve-time precedence must
// drop the rollup calls whenever store calls exist for the session, healing
// the state instead of double-counting it forever.
describe.skipIf(!isSqliteAvailable())('(k) serve-time precedence over stale cached rollups', () => {
  it('stops counting a cached rollup once the store covers its session', async () => {
    const sessionStateDir = join(tmpHome, 'session-state')
    await mkdir(sessionStateDir, { recursive: true })
    const dbPath = join(tmpHome, 'session-store.db')
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STATE_DIR', sessionStateDir)
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STORE_DB', dbPath)
    vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '1')
    vi.stubEnv('CODEBURN_COPILOT_WS_STORAGE_DIR', join(tmpHome, 'no-ws'))
    vi.stubEnv('CODEBURN_COPILOT_GLOBAL_STORAGE_DIR', join(tmpHome, 'no-global'))
    vi.stubEnv('CODEBURN_COPILOT_JETBRAINS_DIR', join(tmpHome, 'no-jb'))

    const base = Date.now() - 5 * 24 * 60 * 60 * 1000
    const at = (offsetSec: number): string => new Date(base + offsetSec * 1000).toISOString()
    const dir = join(sessionStateDir, 'sess-stale')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'workspace.yaml'), 'id: sess-stale\ncwd: /home/user/testproj\n')
    await writeFile(join(dir, 'events.jsonl'), [
      JSON.stringify({ type: 'session.model_change', timestamp: at(0), data: { newModel: 'claude-sonnet-4-5' } }),
      JSON.stringify({ type: 'assistant.message', timestamp: at(10), data: { messageId: 'msg-1', outputTokens: 25, toolRequests: [] } }),
      JSON.stringify({
        type: 'session.shutdown',
        timestamp: at(20),
        data: {
          shutdownType: 'routine',
          modelMetrics: {
            'claude-sonnet-4-5': {
              requests: { count: 1, cost: 1 },
              usage: { inputTokens: 20000, outputTokens: 25, cacheReadTokens: 17000, cacheWriteTokens: 2400, reasoningTokens: 0 },
            },
          },
        },
      }),
    ].join('\n') + '\n')

    const sumUsage = (projects: Awaited<ReturnType<typeof parseAllSessions>>) => {
      const calls = projects.flatMap(p => p.sessions).flatMap(s => s.turns).flatMap(t => t.assistantCalls)
      return {
        input: calls.reduce((s, c) => s + c.usage.inputTokens, 0),
        cacheRead: calls.reduce((s, c) => s + c.usage.cacheReadInputTokens, 0),
        output: calls.reduce((s, c) => s + c.usage.outputTokens, 0),
      }
    }

    // Run 1: no store exists — the rollup is legitimately the only record
    // and gets durably cached.
    const first = sumUsage(await parseAllSessions(undefined, 'copilot'))
    expect(first).toEqual({ input: 600, cacheRead: 17000, output: 25 })

    // The store now becomes readable WITH rows for the same session — the
    // uncovered→covered transition no writer ordering protects (schema
    // epoch ending, node:sqlite appearing, restored files). events.jsonl is
    // unchanged, so its cached rollup calls survive the merge untouched.
    clearSessionCache()
    createStoreDb(dbPath)
    insertStoreRow(dbPath, 'sess-stale', 12000, 10000, 1500, at(12)) // input 500
    insertStoreRow(dbPath, 'sess-stale', 8000, 7000, 900, at(15))    // input 100

    // Run 2: totals must equal per-turn output + store rows — the cached
    // rollup (input 600 / cacheRead 17,000) must not ALSO count.
    const second = sumUsage(await parseAllSessions(undefined, 'copilot'))
    expect(second).toEqual({ input: 600, cacheRead: 17000, output: 25 })

    // Run 3 (warm disk cache, nothing changed): still healed, still once.
    clearSessionCache()
    const third = sumUsage(await parseAllSessions(undefined, 'copilot'))
    expect(third).toEqual({ input: 600, cacheRead: 17000, output: 25 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (l) Age-out never expires the still-discovered session store
// ═══════════════════════════════════════════════════════════════════════════
// An idle machine whose session-store rows are all >90 days old: the store is
// still on disk and IS the durable record (crash-only rows have no rollup to
// fall back to), so its discovery declares retainWhilePresent and the age-out
// leaves it alone. Ordinary journal-style sources keep the pre-existing
// schedule — pruned at 90 days whether or not the file remains — and orphaned
// store entries age out normally once the DB itself is gone.
describe.skipIf(!isSqliteAvailable())('(l) age-out exempts still-discovered store data', () => {
  it('serves >90d-old store rows while the store is still on disk', async () => {
    const sessionStateDir = join(tmpHome, 'session-state')
    await mkdir(sessionStateDir, { recursive: true })
    const dbPath = join(tmpHome, 'session-store.db')
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STATE_DIR', sessionStateDir)
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STORE_DB', dbPath)
    vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '1')
    vi.stubEnv('CODEBURN_COPILOT_WS_STORAGE_DIR', join(tmpHome, 'no-ws'))
    vi.stubEnv('CODEBURN_COPILOT_GLOBAL_STORAGE_DIR', join(tmpHome, 'no-global'))
    vi.stubEnv('CODEBURN_COPILOT_JETBRAINS_DIR', join(tmpHome, 'no-jb'))

    const base = Date.now() - 91 * 24 * 60 * 60 * 1000
    const at = (offsetSec: number): string => new Date(base + offsetSec * 1000).toISOString()
    const dir = join(sessionStateDir, 'sess-idle')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'workspace.yaml'), 'id: sess-idle\ncwd: /home/user/testproj\n')
    await writeFile(join(dir, 'events.jsonl'), [
      JSON.stringify({ type: 'session.model_change', timestamp: at(0), data: { newModel: 'claude-sonnet-4-5' } }),
      JSON.stringify({ type: 'assistant.message', timestamp: at(10), data: { messageId: 'msg-1', outputTokens: 25, toolRequests: [] } }),
      JSON.stringify({
        type: 'session.shutdown',
        timestamp: at(20),
        data: {
          shutdownType: 'routine',
          modelMetrics: {
            'claude-sonnet-4-5': {
              requests: { count: 1, cost: 1 },
              usage: { inputTokens: 20000, outputTokens: 25, cacheReadTokens: 17000, cacheWriteTokens: 2400, reasoningTokens: 0 },
            },
          },
        },
      }),
    ].join('\n') + '\n')
    createStoreDb(dbPath)
    insertStoreRow(dbPath, 'sess-idle', 12000, 10000, 1500, at(12)) // input 500
    insertStoreRow(dbPath, 'sess-idle', 8000, 7000, 900, at(15))    // input 100

    const sumUsage = (projects: Awaited<ReturnType<typeof parseAllSessions>>) => {
      const calls = projects.flatMap(p => p.sessions).flatMap(s => s.turns).flatMap(t => t.assistantCalls)
      return {
        input: calls.reduce((s, c) => s + c.usage.inputTokens, 0),
        cacheRead: calls.reduce((s, c) => s + c.usage.cacheReadInputTokens, 0),
        output: calls.reduce((s, c) => s + c.usage.outputTokens, 0),
      }
    }

    // Both runs: the store rows must serve — never zero. Under the orphan-only
    // age-out (#992) the >90d events.jsonl is still discovered, so its per-turn
    // output stays too; the rollup's input/cache is reconciled away against the
    // rows exactly as on a fresh session, which is what makes the >90d case
    // indistinguishable from any other. Idempotent across the cache round-trip.
    const first = sumUsage(await parseAllSessions(undefined, 'copilot'))
    expect(first).toEqual({ input: 600, cacheRead: 17000, output: 25 })
    clearSessionCache()
    const second = sumUsage(await parseAllSessions(undefined, 'copilot'))
    expect(second).toEqual({ input: 600, cacheRead: 17000, output: 25 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Shared setup for the serve-time precedence scenarios (m)/(n)/(o): a CLI
// session-state dir + a session-store.db, all env-pinned into tmpHome.
// ═══════════════════════════════════════════════════════════════════════════
async function setupCopilotStoreEnv(): Promise<{
  dbPath: string
  at: (offsetSec: number) => string
  writeSession: (sessionId: string, opts: { output: number; rollup?: boolean }) => Promise<string>
  sumUsage: (projects: Awaited<ReturnType<typeof parseAllSessions>>) => { input: number; cacheRead: number; cacheWrite: number; output: number }
}> {
  const sessionStateDir = join(tmpHome, 'session-state')
  await mkdir(sessionStateDir, { recursive: true })
  const dbPath = join(tmpHome, 'session-store.db')
  vi.stubEnv('CODEBURN_COPILOT_SESSION_STATE_DIR', sessionStateDir)
  vi.stubEnv('CODEBURN_COPILOT_SESSION_STORE_DB', dbPath)
  vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '1')
  vi.stubEnv('CODEBURN_COPILOT_WS_STORAGE_DIR', join(tmpHome, 'no-ws'))
  vi.stubEnv('CODEBURN_COPILOT_GLOBAL_STORAGE_DIR', join(tmpHome, 'no-global'))
  vi.stubEnv('CODEBURN_COPILOT_JETBRAINS_DIR', join(tmpHome, 'no-jb'))

  const base = Date.now() - 5 * 24 * 60 * 60 * 1000
  const at = (offsetSec: number): string => new Date(base + offsetSec * 1000).toISOString()

  // The rollup always uses the maintainer's repro numbers: cache-inclusive
  // input 20,000 → uncached 600, cacheRead 17,000, cacheWrite 2,400.
  const writeSession = async (sessionId: string, opts: { output: number; rollup?: boolean }): Promise<string> => {
    const dir = join(sessionStateDir, sessionId)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'workspace.yaml'), `id: ${sessionId}\ncwd: /home/user/testproj\n`)
    const lines = [
      JSON.stringify({ type: 'session.model_change', timestamp: at(0), data: { newModel: 'claude-sonnet-4-5' } }),
      JSON.stringify({ type: 'assistant.message', timestamp: at(10), data: { messageId: 'msg-1', outputTokens: opts.output, toolRequests: [] } }),
    ]
    if (opts.rollup) {
      lines.push(JSON.stringify({
        type: 'session.shutdown',
        timestamp: at(20),
        data: {
          shutdownType: 'routine',
          modelMetrics: {
            'claude-sonnet-4-5': {
              requests: { count: 1, cost: 1 },
              usage: { inputTokens: 20000, outputTokens: opts.output, cacheReadTokens: 17000, cacheWriteTokens: 2400, reasoningTokens: 0 },
            },
          },
        },
      }))
    }
    const eventsPath = join(dir, 'events.jsonl')
    await writeFile(eventsPath, lines.join('\n') + '\n')
    return eventsPath
  }

  const sumUsage = (projects: Awaited<ReturnType<typeof parseAllSessions>>) => {
    const calls = projects.flatMap(p => p.sessions).flatMap(s => s.turns).flatMap(t => t.assistantCalls)
    return {
      input: calls.reduce((s, c) => s + c.usage.inputTokens, 0),
      cacheRead: calls.reduce((s, c) => s + c.usage.cacheReadInputTokens, 0),
      cacheWrite: calls.reduce((s, c) => s + c.usage.cacheCreationInputTokens, 0),
      output: calls.reduce((s, c) => s + c.usage.outputTokens, 0),
    }
  }

  return { dbPath, at, writeSession, sumUsage }
}

// ═══════════════════════════════════════════════════════════════════════════
// (m) The probe-to-parse race, at serve level: rows commit, THEN the shutdown
//     line lands — counted once, store side wins
// ═══════════════════════════════════════════════════════════════════════════
// The #946 round-2 repro. Under parse-time suppression, a coverage snapshot
// taken at discovery went stale the moment a session ended between probe and
// parse (rows commit BEFORE the shutdown line is appended), and the rollup
// was emitted beside the rows — doubling input 100 / cacheRead 8,000 /
// cacheWrite 2,000 durably. Serve-time precedence has no snapshot to go
// stale: whatever store rows made it into the serve set drop the session's
// rollups, no matter when either side was parsed or cached.
describe.skipIf(!isSqliteAvailable())('(m) rows-then-shutdown race counted once at serve time', () => {
  it('drops the rollup cached after its session ended mid-run', async () => {
    const { dbPath, at, writeSession, sumUsage } = await setupCopilotStoreEnv()
    createStoreDb(dbPath)
    const eventsPath = await writeSession('sess-race', { output: 345 })

    // Run 1 parses the live session mid-flight: no rows, no rollup yet.
    const first = sumUsage(await parseAllSessions(undefined, 'copilot'))
    expect(first).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0, output: 345 })

    // The session ends: rows committed FIRST (the CLI's write order), the
    // shutdown rollup appended second, both between two codeburn runs.
    clearSessionCache()
    insertStoreRow(dbPath, 'sess-race', 10100, 8000, 2000, at(15)) // input 100
    await writeFile(eventsPath, JSON.stringify({
      type: 'session.shutdown',
      timestamp: at(20),
      data: {
        shutdownType: 'routine',
        modelMetrics: {
          'claude-sonnet-4-5': {
            requests: { count: 1, cost: 1 },
            usage: { inputTokens: 10100, outputTokens: 345, cacheReadTokens: 8000, cacheWriteTokens: 2000, reasoningTokens: 0 },
          },
        },
      },
    }) + '\n', { flag: 'a' })

    // Both representations parse and cache; the serve set holds the row, so
    // the rollup is dropped: 100/8,000/2,000 once, not twice.
    const second = sumUsage(await parseAllSessions(undefined, 'copilot'))
    expect(second).toEqual({ input: 100, cacheRead: 8000, cacheWrite: 2000, output: 345 })

    // Warm re-run: still once.
    clearSessionCache()
    const third = sumUsage(await parseAllSessions(undefined, 'copilot'))
    expect(third).toEqual({ input: 100, cacheRead: 8000, cacheWrite: 2000, output: 345 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (n) A store holding no billable rows for a session never suppresses it
// ═══════════════════════════════════════════════════════════════════════════
// Two scenarios collapse into this serve-set shape. (1) Atomic replacement:
// discovery probes store A, a writer renames store B over it, the parse
// reads B — under a parse-time coverage snapshot, sessions covered by A but
// absent from B would lose their rollups AND their rows; at serve time only
// what the parse actually produced suppresses. (2) The billable predicate:
// all-zero rows emit no calls, so a session with only those must keep its
// rollup — suppression on mere row-existence would zero its input/cache.
describe.skipIf(!isSqliteAvailable())('(n) no billable store rows → the rollup still counts', () => {
  it('keeps the rollup when the served store holds only zero-usage rows for its session', async () => {
    const { dbPath, at, writeSession, sumUsage } = await setupCopilotStoreEnv()
    createStoreDb(dbPath)
    // sess-r: only an all-zero row (emits nothing). sess-other: billable.
    insertStoreRow(dbPath, 'sess-r', 0, 0, 0, at(5))
    insertStoreRow(dbPath, 'sess-other', 5050, 5000, 0, at(6)) // input 50
    await writeSession('sess-r', { output: 25, rollup: true })

    const totals = sumUsage(await parseAllSessions(undefined, 'copilot'))
    // sess-r's rollup (600/17,000/2,400) + sess-other's row (50/5,000/0)
    // + sess-r's per-turn output.
    expect(totals).toEqual({ input: 650, cacheRead: 22000, cacheWrite: 2400, output: 25 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (o) Store-absence epoch: deleting the store changes nothing served
// ═══════════════════════════════════════════════════════════════════════════
// The round-6 finding on the previous design: gating reconciliation on the
// store being DISCOVERED made an absence epoch flip served totals — the
// orphaned rows and the returning rollup both counted, and a daily history
// finalized during the epoch kept the doubled day forever even after the
// store came back. Reconciliation therefore reads only the cached serve set:
// the rows (durable orphans included) keep replacing the rollup, totals are
// identical before and after the deletion, and sealed history can never
// flip. The orphaned rows remain the session's record until the 90-day
// age-out prunes them — at which point the rollup calls, still cached in
// events.jsonl's entry, become the record again with the same exactly-once
// guarantee.
describe.skipIf(!isSqliteAvailable())('(o) absence epoch: served totals are independent of store presence', () => {
  it('serves identical totals before and after the store file is deleted', async () => {
    const { dbPath, at, writeSession, sumUsage } = await setupCopilotStoreEnv()
    createStoreDb(dbPath)
    insertStoreRow(dbPath, 'sess-e', 12000, 10000, 1500, at(12)) // input 500
    insertStoreRow(dbPath, 'sess-e', 8000, 7000, 900, at(15))    // input 100
    await writeSession('sess-e', { output: 25, rollup: true })

    // Store present: rows win, rollup reconciled away.
    const first = sumUsage(await parseAllSessions(undefined, 'copilot'))
    expect(first).toEqual({ input: 600, cacheRead: 17000, cacheWrite: 2400, output: 25 })

    // The store vanishes; its cached rows become durable orphans.
    clearSessionCache()
    await rm(dbPath, { force: true })

    // Nothing changes: the cached rows are still the session's record, the
    // rollup stays reconciled away, and no epoch can double-count a day.
    const second = sumUsage(await parseAllSessions(undefined, 'copilot'))
    expect(second).toEqual({ input: 600, cacheRead: 17000, cacheWrite: 2400, output: 25 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (p) The reverse race: a row committing after the store read never zeroes
//     the refresh
// ═══════════════════════════════════════════════════════════════════════════
// The #946 round-4 finding 3 shape. The store parses before events.jsonl; a
// row can commit after that read but before the jsonl parse reaches the
// shutdown line. Under parse-time suppression the live coverage re-check
// then saw the row and suppressed the rollup — against a store snapshot
// that had emitted nothing — losing the request's input/cache for the whole
// refresh. Serve-time reconciliation cannot outrun the serve set: the
// rollup stands until rows actually land, partially-landed rows are topped
// up by the residual to the rollup's own totals, and full coverage retires
// the residual — counted once at every step and zero at none.
// ═══════════════════════════════════════════════════════════════════════════
// (c5) initiator = 'compaction' identifies the summarization request
// ═══════════════════════════════════════════════════════════════════════════
// The CLI's context-summarization call writes its own assistant_usage_events
// row, labelled `initiator = 'compaction'` where the store carries that
// column. Two consequences, both of which need the label: it has no
// assistant.message, so it must not compete for a per-turn pairing partner,
// and it commits just BEFORE the compaction stamp that anchors the leg's
// interval, so without the label the anchor pushes it outside the subtraction
// while the post-reset rollup still counts it - the documented one-request
// over-serve. The column is optional twice over (absent on older stores, NULL
// on many rows of newer ones), so the unlabelled path must be unchanged.
describe.skipIf(!isSqliteAvailable())('(c5) compaction-initiated store rows', () => {
  const createStoreDbWithInitiator = (dbPath: string): void => {
    const { DatabaseSync } = requireForTest('node:sqlite') as { DatabaseSync: new (p: string) => TestDb }
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, created_at TEXT);
      CREATE TABLE assistant_usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL, model TEXT NOT NULL,
        input_tokens INTEGER, output_tokens INTEGER,
        cache_read_tokens INTEGER, cache_write_tokens INTEGER,
        reasoning_tokens INTEGER, created_at TEXT,
        total_nano_aiu INTEGER, request_multiplier REAL, initiator TEXT);
    `)
    db.close()
  }
  const insertLabelled = (
    dbPath: string,
    sid: string,
    input: number,
    at: string,
    initiator: string | null,
    extra: { output?: number; cacheRead?: number } = {},
  ): void => {
    const { DatabaseSync } = requireForTest('node:sqlite') as { DatabaseSync: new (p: string) => TestDb }
    const db = new DatabaseSync(dbPath)
    db.prepare('INSERT OR IGNORE INTO sessions (id, cwd) VALUES (?, ?)').run(sid, '/home/user/testproj')
    db.prepare(`INSERT INTO assistant_usage_events
      (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       reasoning_tokens, created_at, total_nano_aiu, request_multiplier, initiator)
      VALUES (?, 'claude-sonnet-4-5', ?, ?, ?, 0, 0, ?, 1000, 1, ?)`)
      .run(sid, input, extra.output ?? 0, extra.cacheRead ?? 0, at, initiator)
    db.close()
  }

  const setup = async (name: string) => {
    const sessionStateDir = join(tmpHome, `cmpinit-state-${name}`)
    await mkdir(sessionStateDir, { recursive: true })
    const dbPath = join(tmpHome, `cmpinit-store-${name}.db`)
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STATE_DIR', sessionStateDir)
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STORE_DB', dbPath)
    vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '1')
    vi.stubEnv('CODEBURN_COPILOT_WS_STORAGE_DIR', join(tmpHome, 'no-ws'))
    vi.stubEnv('CODEBURN_COPILOT_GLOBAL_STORAGE_DIR', join(tmpHome, 'no-global'))
    vi.stubEnv('CODEBURN_COPILOT_JETBRAINS_DIR', join(tmpHome, 'no-jb'))
    const base = Date.now() - 3 * 24 * 3600 * 1000
    const at = (sec: number): string => new Date(base + sec * 1000).toISOString()
    createStoreDbWithInitiator(dbPath)
    return { sessionStateDir, dbPath, at }
  }

  // Row A (user request, 100) - compaction row C (50) - compaction stamp -
  // rollup claiming 200 for the post-compaction request whose row is missing.
  const writeSession = async (sessionStateDir: string, at: (s: number) => string): Promise<void> => {
    const dir = join(sessionStateDir, 'sess-ci')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'workspace.yaml'), 'id: sess-ci\ncwd: /home/user/testproj\n')
    await writeFile(join(dir, 'events.jsonl'), [
      JSON.stringify({ type: 'session.model_change', timestamp: at(0), data: { newModel: 'claude-sonnet-4-5' } }),
      JSON.stringify({ type: 'session.compaction_complete', timestamp: at(10), data: { success: true, kind: 'background' } }),
      JSON.stringify({ type: 'session.shutdown', timestamp: at(20), data: {
        shutdownType: 'routine',
        modelMetrics: { 'claude-sonnet-4-5': { requests: { count: 1, cost: 1 },
          usage: { inputTokens: 250, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } } },
      } }),
    ].join('\n') + '\n')
  }

  const totalInput = (projects: Awaited<ReturnType<typeof parseAllSessions>>): number =>
    projects.flatMap(p => p.sessions).flatMap(s => s.turns).flatMap(t => t.assistantCalls)
      .reduce((sum, c) => sum + c.usage.inputTokens, 0)

  it('subtracts a labelled compaction row from the leg it belongs to', async () => {
    const { sessionStateDir, dbPath, at } = await setup('labelled')
    await writeSession(sessionStateDir, at)
    insertLabelled(dbPath, 'sess-ci', 100, at(5), null)          // user request, pre-compaction
    insertLabelled(dbPath, 'sess-ci', 50, at(9), 'compaction')   // the summarization call

    // The rollup resets at the compaction and then counts the summarization
    // call (250 = 50 + a 200 request whose row has not landed). Row A is
    // excluded by the anchor; the compaction row is subtracted by its label.
    // Served: 100 + 50 + residual 200 = 350. Without the label the compaction
    // row would fall outside the interval and serve twice (400).
    expect(totalInput(await parseAllSessions(undefined, 'copilot'))).toBe(350)
  })

  it('leaves an UNLABELLED store on its previous behaviour', async () => {
    const { sessionStateDir, dbPath, at } = await setup('unlabelled')
    await writeSession(sessionStateDir, at)
    insertLabelled(dbPath, 'sess-ci', 100, at(5), null)
    insertLabelled(dbPath, 'sess-ci', 50, at(9), null)  // same row, no label

    // Indistinguishable from a user request: the anchor excludes it, so its
    // 50 is served once as a row and again inside the residual. Over-serve,
    // never lose - the documented bound, one request per compaction.
    expect(totalInput(await parseAllSessions(undefined, 'copilot'))).toBe(400)
  })

  it('keeps a compaction row out of per-turn pairing', async () => {
    const { sessionStateDir, dbPath, at } = await setup('pairing')
    const dir = join(sessionStateDir, 'sess-ci')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'workspace.yaml'), 'id: sess-ci\ncwd: /home/user/testproj\n')
    // One real request with its assistant.message, and a compaction row a few
    // seconds later - inside the 2-minute pairing window.
    await writeFile(join(dir, 'events.jsonl'), [
      JSON.stringify({ type: 'session.model_change', timestamp: at(0), data: { newModel: 'claude-sonnet-4-5' } }),
      JSON.stringify({ type: 'assistant.message', timestamp: at(10), data: { messageId: 'm1', outputTokens: 25, toolRequests: [] } }),
    ].join('\n') + '\n')
    insertLabelled(dbPath, 'sess-ci', 100, at(11), null)
    insertLabelled(dbPath, 'sess-ci', 50, at(13), 'compaction')

    const projects = await parseAllSessions(undefined, 'copilot')
    const calls = projects.flatMap(p => p.sessions).flatMap(s => s.turns).flatMap(t => t.assistantCalls)
    const supp = (k: string) => calls.find(c => c.deduplicationKey.includes(k))?.supplementaryAccounting ?? false
    // The user request's row pairs with m1 and goes supplementary. The
    // compaction row never enters the pairing pass, so it cannot steal that
    // partner and keeps its own weight as the real request it is.
    const storeCalls = calls.filter(c => c.deduplicationKey.startsWith('copilot-store:'))
    expect(storeCalls).toHaveLength(2)
    expect(storeCalls.filter(c => c.supplementaryAccounting)).toHaveLength(1)
    expect(supp('copilot:sess-ci:m1')).toBe(false)
  })

  // Validation round 5, machine B, session f38d4326: the compaction row's
  // prompt side was counted and priced while its 3,085 output tokens were
  // dropped - the only token discrepancy across a 30-session store-matched
  // comparison (540,158,021 served vs 540,161,106 in the store). Its output
  // has no assistant.message anywhere in events.jsonl, so the store row is the
  // only place it exists.
  const totalOutput = (projects: Awaited<ReturnType<typeof parseAllSessions>>): number =>
    projects.flatMap(p => p.sessions).flatMap(s => s.turns).flatMap(t => t.assistantCalls)
      .reduce((sum, c) => sum + c.usage.outputTokens, 0)

  it("counts the compaction row's own output, which no assistant.message owns", async () => {
    const { sessionStateDir, dbPath, at } = await setup('compaction-output')
    const dir = join(sessionStateDir, 'sess-ci')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'workspace.yaml'), 'id: sess-ci\ncwd: /home/user/testproj\n')
    // The real geometry: created_at equals the compaction_complete stamp to
    // the millisecond, and there is no assistant.message for this request.
    await writeFile(join(dir, 'events.jsonl'), [
      JSON.stringify({ type: 'session.model_change', timestamp: at(0), data: { newModel: 'claude-sonnet-4-5' } }),
      JSON.stringify({ type: 'session.compaction_complete', timestamp: at(10), data: { success: true, kind: 'background' } }),
    ].join('\n') + '\n')
    insertLabelled(dbPath, 'sess-ci', 273205, at(10), 'compaction', { output: 3085, cacheRead: 266933 })

    const projects = await parseAllSessions(undefined, 'copilot')
    const storeCalls = projects.flatMap(p => p.sessions).flatMap(s => s.turns)
      .flatMap(t => t.assistantCalls).filter(c => c.deduplicationKey.startsWith('copilot-store:'))
    expect(storeCalls).toHaveLength(1)
    // input_tokens is cache-inclusive: 273,205 - 266,933 = 6,272 uncached.
    expect(storeCalls[0]!.usage).toMatchObject({
      inputTokens: 6272,
      cacheReadInputTokens: 266933,
      outputTokens: 3085,
    })
    expect(totalOutput(projects)).toBe(3085)
  })

  it('leaves an UNLABELLED row at output 0 (its per-turn call owns that output)', async () => {
    const { sessionStateDir, dbPath, at } = await setup('unlabelled-output')
    const dir = join(sessionStateDir, 'sess-ci')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'workspace.yaml'), 'id: sess-ci\ncwd: /home/user/testproj\n')
    await writeFile(join(dir, 'events.jsonl'), [
      JSON.stringify({ type: 'session.model_change', timestamp: at(0), data: { newModel: 'claude-sonnet-4-5' } }),
      JSON.stringify({ type: 'assistant.message', timestamp: at(11), data: { messageId: 'm1', outputTokens: 3085, toolRequests: [] } }),
    ].join('\n') + '\n')
    insertLabelled(dbPath, 'sess-ci', 273205, at(10), null, { output: 3085, cacheRead: 266933 })

    // Counted once, by the per-turn call - never twice.
    expect(totalOutput(await parseAllSessions(undefined, 'copilot'))).toBe(3085)
  })

  // The dedup hazard kelchm flagged: on the same turn index, 1.5 s apart, with
  // near-identical token shapes. Nothing may collapse them - the store dedup
  // key carries the row id, and the content discriminator differs too.
  it('keeps the compaction row and its 1.5s-adjacent twin as two distinct calls', async () => {
    const { sessionStateDir, dbPath, at } = await setup('adjacent-twin')
    const dir = join(sessionStateDir, 'sess-ci')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'workspace.yaml'), 'id: sess-ci\ncwd: /home/user/testproj\n')
    await writeFile(join(dir, 'events.jsonl'), [
      JSON.stringify({ type: 'session.model_change', timestamp: at(0), data: { newModel: 'claude-sonnet-4-5' } }),
      JSON.stringify({ type: 'session.compaction_complete', timestamp: at(10), data: { success: true, kind: 'background' } }),
    ].join('\n') + '\n')
    insertLabelled(dbPath, 'sess-ci', 272139, at(8.5), null, { output: 400, cacheRead: 267005 })
    insertLabelled(dbPath, 'sess-ci', 273205, at(10), 'compaction', { output: 3085, cacheRead: 266933 })

    const projects = await parseAllSessions(undefined, 'copilot')
    const storeCalls = projects.flatMap(p => p.sessions).flatMap(s => s.turns)
      .flatMap(t => t.assistantCalls).filter(c => c.deduplicationKey.startsWith('copilot-store:'))
    expect(storeCalls).toHaveLength(2)
    expect(new Set(storeCalls.map(c => c.deduplicationKey)).size).toBe(2)
    // Both rows' prompt sides survive; only the labelled one contributes output.
    expect(storeCalls.reduce((s, c) => s + c.usage.inputTokens, 0)).toBe((272139 - 267005) + 6272)
    expect(totalOutput(projects)).toBe(3085)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (c6) A migrated cache must reconcile like a virgin one
// ═══════════════════════════════════════════════════════════════════════════
// #946 validation round 6 (@vidoluco): a cache generated by 0.9.20, copied and
// then migrated by this branch, dropped exactly ONE call a virgin cache serves
// - `mai-code-1-flash-picker`, 324 input / 91,136 cache read / $0.01, sitting
// two minutes after the labelled compaction row in its session.
//
// `compactedAt` is a capture-only field this branch adds to the shutdown-ROLLUP
// call, and 0.9.20 already cached that call under the same dedup key. The
// durable union appends only unseen keys, so the bump could not reach it: the
// migrated cache ran the compaction-anchored residual math with no anchor,
// which is exactly the pre-anchor behaviour - the interval opens at -Infinity,
// the PRE-compaction rows are subtracted from a rollup that never counted
// them, and the residual clamps to zero and disappears.
describe.skipIf(!isSqliteAvailable())('(c6) a migrated cache reconciles like a virgin one', () => {
  const MODEL = 'mai-code-1-flash-picker'

  const createStore = (dbPath: string): void => {
    const { DatabaseSync } = requireForTest('node:sqlite') as { DatabaseSync: new (p: string) => TestDb }
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, created_at TEXT);
      CREATE TABLE assistant_usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL, model TEXT NOT NULL,
        input_tokens INTEGER, output_tokens INTEGER,
        cache_read_tokens INTEGER, cache_write_tokens INTEGER,
        reasoning_tokens INTEGER, created_at TEXT,
        total_nano_aiu INTEGER, request_multiplier REAL, initiator TEXT);
    `)
    db.close()
  }
  const insertRow = (dbPath: string, sid: string, input: number, cacheRead: number, at: string, initiator: string | null, output = 0): void => {
    const { DatabaseSync } = requireForTest('node:sqlite') as { DatabaseSync: new (p: string) => TestDb }
    const db = new DatabaseSync(dbPath)
    db.prepare('INSERT OR IGNORE INTO sessions (id, cwd) VALUES (?, ?)').run(sid, '/home/user/pickerproj')
    db.prepare(`INSERT INTO assistant_usage_events
      (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       reasoning_tokens, created_at, total_nano_aiu, request_multiplier, initiator)
      VALUES (?, ?, ?, ?, ?, 0, 0, ?, 1000, 1, ?)`).run(sid, MODEL, input, output, cacheRead, at, initiator)
    db.close()
  }

  const build = async () => {
    const sessionStateDir = join(tmpHome, 'c6-state')
    await mkdir(sessionStateDir, { recursive: true })
    const dbPath = join(tmpHome, 'c6-store.db')
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STATE_DIR', sessionStateDir)
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STORE_DB', dbPath)
    vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '1')
    vi.stubEnv('CODEBURN_COPILOT_WS_STORAGE_DIR', join(tmpHome, 'no-ws'))
    vi.stubEnv('CODEBURN_COPILOT_GLOBAL_STORAGE_DIR', join(tmpHome, 'no-global'))
    vi.stubEnv('CODEBURN_COPILOT_JETBRAINS_DIR', join(tmpHome, 'no-jb'))
    const base = Date.now() - 4 * 24 * 3600 * 1000
    const at = (sec: number): string => new Date(base + sec * 1000).toISOString()
    createStore(dbPath)

    const dir = join(sessionStateDir, 'sess-8acb5587')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'workspace.yaml'), 'id: sess-8acb5587\ncwd: /home/user/pickerproj\n')
    await writeFile(join(dir, 'events.jsonl'), [
      JSON.stringify({ type: 'session.model_change', timestamp: at(0), data: { newModel: MODEL } }),
      JSON.stringify({ type: 'session.compaction_complete', timestamp: at(300), data: { success: true, kind: 'background' } }),
      // The rollup RESET at the compaction, so it claims only the two
      // post-compaction requests (324 + 324 uncached, 91,136 + 91,136 cached).
      JSON.stringify({ type: 'session.shutdown', timestamp: at(600), data: {
        shutdownType: 'routine',
        modelMetrics: { [MODEL]: { requests: { count: 2, cost: 1 },
          usage: { inputTokens: 182920, outputTokens: 0, cacheReadTokens: 182272, cacheWriteTokens: 0, reasoningTokens: 0 } } },
      } }),
    ].join('\n') + '\n')

    // A big PRE-compaction request the rollup never counted...
    insertRow(dbPath, 'sess-8acb5587', 500000, 499000, at(100), null)
    // ...and the post-compaction row, two minutes after the compaction stamp.
    // Its twin never wrote a row, so the residual is exactly one request.
    insertRow(dbPath, 'sess-8acb5587', 91460, 91136, at(420), null)
    return { dbPath, at }
  }

  /// What a 0.9.20-generated cache looks like to this build: the rollup call is
  /// already cached under its (stable) dedup key with the OLD parser's fields -
  /// no `compactedAt` - and the env fingerprint mismatches, which is the code
  /// path a PROVIDER_PARSE_VERSIONS bump takes.
  const ageCacheToPreBumpFields = async (): Promise<void> => {
    clearSessionCache()
    const disk = await readCacheOnDisk()
    const section = disk.providers['copilot']
    expect(section).toBeDefined()
    let stripped = 0
    for (const file of Object.values(section!.files)) {
      for (const turn of file.turns) {
        for (const call of turn.calls) {
          if (call.compactedAt !== undefined) { delete call.compactedAt; stripped++ }
        }
      }
    }
    // Self-check: if nothing was stripped this fixture proves nothing.
    expect(stripped).toBeGreaterThan(0)
    expect(section!.envFingerprint).not.toBe('0000000000000000')
    section!.envFingerprint = '0000000000000000'
    await writeCacheOnDisk(disk)
    clearSessionCache()
  }

  const served = async () => {
    const calls = (await parseAllSessions(undefined, 'copilot'))
      .flatMap(p => p.sessions).flatMap(s => s.turns).flatMap(t => t.assistantCalls)
    return {
      input: calls.reduce((s, c) => s + c.usage.inputTokens, 0),
      cacheRead: calls.reduce((s, c) => s + c.usage.cacheReadInputTokens, 0),
      output: calls.reduce((s, c) => s + c.usage.outputTokens, 0),
      residuals: calls.filter(c => c.deduplicationKey.includes(':shutdown-residual:')).length,
    }
  }

  it('keeps the post-compaction residual after a bump onto a pre-bump cache', async () => {
    await build()
    const virgin = await served()
    // 1,000 (pre-compaction row) + 324 (post row) + 324 (residual).
    expect(virgin).toMatchObject({ input: 1648, cacheRead: 681272, residuals: 1 })

    await ageCacheToPreBumpFields()
    expect(await served()).toEqual(virgin)
    // Persisted, not merely served: the loss must not come back on a cold read.
    clearSessionCache()
    expect(await served()).toEqual(virgin)
  })

  // Same root cause, other direction: the compaction row's output (the round-5
  // fix) has to reach a cache written before ITS bump too, which append-only
  // could never do - the row's dedup key is deliberately stable.
  it('backfills a store row whose fields the bump changed', async () => {
    const { dbPath, at } = await build()
    insertRow(dbPath, 'sess-8acb5587', 6272, 0, at(300), 'compaction', 3085)
    const virgin = await served()
    expect(virgin.output).toBe(3085)

    // Age the cached compaction row to its pre-fix shape (output 0), strip the
    // rollup anchor, and bump - exactly a branch tester's v2 cache.
    clearSessionCache()
    const disk = await readCacheOnDisk()
    for (const file of Object.values(disk.providers['copilot']!.files)) {
      for (const turn of file.turns) {
        for (const call of turn.calls) {
          if (call.initiator === 'compaction') call.usage.outputTokens = 0
          delete call.compactedAt
        }
      }
    }
    disk.providers['copilot']!.envFingerprint = '0000000000000000'
    await writeCacheOnDisk(disk)
    clearSessionCache()
    expect(await served()).toEqual(virgin)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (c4) Attributed cost equals cost recomputed from the served tokens
// ═══════════════════════════════════════════════════════════════════════════
// `codeburn audit` reports both, and a gap between them means some call is
// carrying dollars its tokens do not justify - the shape of a double-served
// request. It is the cheapest end-to-end check there is on copilot's
// reconciliation, so it runs over every combination of the three
// representations a session can be written in.
//
// Magnitudes are a real reported day (2026-08-18, gpt-5.6-terra: 146 store
// rows, net input 17,792 / cache write 501,395 / cache read 12,097,364 /
// output 63,344 / reasoning 24,831, billed $4.47 by GitHub), collapsed to two
// requests. $4.4687 is what those tokens price at, and what the store billed.
describe.skipIf(!isSqliteAvailable())('(c4) attributed cost tracks recomputed cost', () => {
  const MODEL = 'gpt-5.6-terra'
  const BILLED_USD = 4.4687

  const build = async (name: string, opts: { messages: boolean; rollup: boolean; rows: boolean }) => {
    const sessionStateDir = join(tmpHome, `att-state-${name}`)
    await mkdir(sessionStateDir, { recursive: true })
    const dbPath = join(tmpHome, `att-store-${name}.db`)
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STATE_DIR', sessionStateDir)
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STORE_DB', dbPath)
    vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '1')
    vi.stubEnv('CODEBURN_COPILOT_WS_STORAGE_DIR', join(tmpHome, 'no-ws'))
    vi.stubEnv('CODEBURN_COPILOT_GLOBAL_STORAGE_DIR', join(tmpHome, 'no-global'))
    vi.stubEnv('CODEBURN_COPILOT_JETBRAINS_DIR', join(tmpHome, 'no-jb'))

    const base = Date.now() - 3 * 24 * 3600 * 1000
    const at = (sec: number): string => new Date(base + sec * 1000).toISOString()
    createStoreDb(dbPath)

    const dir = join(sessionStateDir, 'sess-att')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'workspace.yaml'), 'id: sess-att\ncwd: /home/user/testproj\n')
    const lines = [JSON.stringify({ type: 'session.model_change', timestamp: at(0), data: { newModel: MODEL } })]
    if (opts.messages) {
      lines.push(JSON.stringify({ type: 'assistant.message', timestamp: at(10), data: { messageId: 'm1', outputTokens: 31672, toolRequests: [] } }))
      lines.push(JSON.stringify({ type: 'assistant.message', timestamp: at(20), data: { messageId: 'm2', outputTokens: 31672, toolRequests: [] } }))
    }
    if (opts.rollup) {
      lines.push(JSON.stringify({
        type: 'session.shutdown', timestamp: at(30), data: {
          shutdownType: 'routine',
          modelMetrics: { [MODEL]: { requests: { count: 2, cost: 1 }, usage: {
            // cache-inclusive, as the CLI writes it
            inputTokens: 17792 + 12097364 + 501395, outputTokens: 63344,
            cacheReadTokens: 12097364, cacheWriteTokens: 501395, reasoningTokens: 24831 } } },
        },
      }))
    }
    await writeFile(join(dir, 'events.jsonl'), lines.join('\n') + '\n')

    if (opts.rows) {
      insertStoreRow(dbPath, 'sess-att', 8896 + 6048682 + 250697, 6048682, 250697, at(11), 12415)
      insertStoreRow(dbPath, 'sess-att', 8896 + 6048682 + 250698, 6048682, 250698, at(21), 12416)
    }
  }

  const audit = async () => {
    const { aggregateAudit } = await import('../src/audit-report.js')
    const rows = await aggregateAudit(await parseAllSessions(undefined, 'copilot'))
    const row = rows.find(r => r.provider === 'copilot' && r.model === MODEL)
    expect(row).toBeDefined()
    return row!
  }

  for (const shape of [
    { name: 'rows+messages+rollup', messages: true, rollup: true, rows: true },
    { name: 'rows+messages', messages: true, rollup: false, rows: true },
    { name: 'rows+rollup', messages: false, rollup: true, rows: true },
    { name: 'messages+rollup', messages: true, rollup: true, rows: false },
  ]) {
    it(`never attributes more than the served tokens price at: ${shape.name}`, async () => {
      await build(shape.name.replace(/\+/g, '-'), shape)
      const row = await audit()
      expect(row.attributedCostUSD).toBeCloseTo(row.cost.recomputedTotalUSD, 6)
    })
  }

  it('lands on the billed amount when the store covers the session', async () => {
    await build('billed', { messages: true, rollup: true, rows: true })
    const row = await audit()
    // Attributed == recomputed == what GitHub billed for these requests.
    expect(row.cost.recomputedTotalUSD).toBeCloseTo(BILLED_USD, 3)
    expect(row.attributedCostUSD).toBeCloseTo(BILLED_USD, 3)
    // Reasoning is inside output and must not be re-priced on top of it:
    // the pre-fix reading showed 63,344 + 24,831 = 88,175.
    expect(row.displayed.outputTokens).toBe(63344)
    expect(row.raw.reasoningTokens).toBe(24831)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (c3) session.shutdown counters are CUMULATIVE across resume legs
// ═══════════════════════════════════════════════════════════════════════════
// Measured on a real 3-leg session (CLI 1.0.80): every counter in a leg,
// billing and tokens alike, includes the legs before it, and the LAST leg of a
// complete session equals the session's store-row total exactly. The parser
// already converts cumulative to per-leg deltas at emission, so the interval
// arithmetic downstream sees per-leg claims - these pin that end to end,
// because reading the raw journal makes it look like the opposite.
describe.skipIf(!isSqliteAvailable())('(c3) cumulative shutdown counters across resume legs', () => {
  const setup = async (name: string) => {
    const sessionStateDir = join(tmpHome, `cum-state-${name}`)
    await mkdir(sessionStateDir, { recursive: true })
    const dbPath = join(tmpHome, `cum-store-${name}.db`)
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STATE_DIR', sessionStateDir)
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STORE_DB', dbPath)
    vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '1')
    vi.stubEnv('CODEBURN_COPILOT_WS_STORAGE_DIR', join(tmpHome, 'no-ws'))
    vi.stubEnv('CODEBURN_COPILOT_GLOBAL_STORAGE_DIR', join(tmpHome, 'no-global'))
    vi.stubEnv('CODEBURN_COPILOT_JETBRAINS_DIR', join(tmpHome, 'no-jb'))
    const base = Date.now() - 4 * 24 * 3600 * 1000
    const at = (sec: number): string => new Date(base + sec * 1000).toISOString()
    createStoreDb(dbPath)
    return { sessionStateDir, dbPath, at }
  }

  const rollup = (ts: string, cumulativeInput: number): string => JSON.stringify({
    type: 'session.shutdown',
    timestamp: ts,
    data: {
      shutdownType: 'routine',
      modelMetrics: {
        'claude-sonnet-4-5': {
          requests: { count: 1, cost: 1 },
          usage: { inputTokens: cumulativeInput, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
        },
      },
    },
  })

  const totalInput = (projects: Awaited<ReturnType<typeof parseAllSessions>>): number =>
    projects.flatMap(p => p.sessions).flatMap(s => s.turns).flatMap(t => t.assistantCalls)
      .reduce((sum, c) => sum + c.usage.inputTokens, 0)

  it('serves a complete 3-leg session at exactly its store total, not the sum of its legs', async () => {
    const { sessionStateDir, dbPath, at } = await setup('complete')
    const dir = join(sessionStateDir, 'sess-cum')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'workspace.yaml'), 'id: sess-cum\ncwd: /home/user/testproj\n')
    // Cumulative legs 100 / 400 / 900. Summing them naively gives 1,400; the
    // truth is 900, which the last leg states and the rows confirm.
    await writeFile(join(dir, 'events.jsonl'), [
      JSON.stringify({ type: 'session.model_change', timestamp: at(0), data: { newModel: 'claude-sonnet-4-5' } }),
      rollup(at(10), 100), rollup(at(20), 400), rollup(at(30), 900),
    ].join('\n') + '\n')

    // Rows covering the session completely, summing to the last leg exactly -
    // the invariant observed on real multi-leg sessions.
    insertStoreRow(dbPath, 'sess-cum', 100, 0, 0, at(5))
    insertStoreRow(dbPath, 'sess-cum', 300, 0, 0, at(15))
    insertStoreRow(dbPath, 'sess-cum', 500, 0, 0, at(25))

    // Complete coverage: every residual retires and the session serves its
    // rows once. A per-leg reading of the journal would serve 1,400.
    expect(totalInput(await parseAllSessions(undefined, 'copilot'))).toBe(900)
  })

  it('serves an uncovered cumulative session once, at its last leg', async () => {
    const { sessionStateDir, dbPath, at } = await setup('uncovered')
    const dir = join(sessionStateDir, 'sess-cum2')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'workspace.yaml'), 'id: sess-cum2\ncwd: /home/user/testproj\n')
    await writeFile(join(dir, 'events.jsonl'), [
      JSON.stringify({ type: 'session.model_change', timestamp: at(0), data: { newModel: 'claude-sonnet-4-5' } }),
      rollup(at(10), 100), rollup(at(20), 400), rollup(at(30), 900),
    ].join('\n') + '\n')
    // One row, far too small to cover anything: the rest serves as residuals.
    insertStoreRow(dbPath, 'sess-cum2', 50, 0, 0, at(5))

    // 50 (row) + 50 (leg 1 residual) + 300 (leg 2 delta) + 500 (leg 3 delta).
    expect(totalInput(await parseAllSessions(undefined, 'copilot'))).toBe(900)
  })

  it('treats a leg SMALLER than its predecessor as a fresh epoch, not a negative delta', async () => {
    const { sessionStateDir, dbPath, at } = await setup('reset')
    const dir = join(sessionStateDir, 'sess-reset')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'workspace.yaml'), 'id: sess-reset\ncwd: /home/user/testproj\n')
    // Leg 2 reports LESS than leg 1. Either an older per-leg CLI or a
    // mid-session counter reset; both mean leg 2 stands on its own. Clamping
    // the delta to 0 would silently drop it.
    await writeFile(join(dir, 'events.jsonl'), [
      JSON.stringify({ type: 'session.model_change', timestamp: at(0), data: { newModel: 'claude-sonnet-4-5' } }),
      rollup(at(10), 900), rollup(at(20), 200),
    ].join('\n') + '\n')
    insertStoreRow(dbPath, 'sess-reset', 10, 0, 0, at(5))

    // 10 (row) + 890 (leg 1 residual) + 200 (leg 2 in full).
    expect(totalInput(await parseAllSessions(undefined, 'copilot'))).toBe(1100)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (c2) Residual dedup keys name the leg's INSTANT, never its position
// ═══════════════════════════════════════════════════════════════════════════
// A residual key used to carry the leg's index into the session's sorted leg
// list. An index is only stable while nothing is ever inserted before it, and
// legs are sorted across every cached file for the session — so an earlier leg
// arriving later would renumber the residuals after it. The sync ledger has
// already sent the old names, and a renamed key is a span the receiver takes a
// second time (there is no retraction for a usage span).
//
// The leg's own timestamp cannot move: session files are append-only, and the
// equal-timestamp coalescing above makes it unique per leg. Pinning that the
// key is DERIVED from it is what forecloses the whole class, which is stronger
// than pinning one insertion scenario — today a second file's leg collides on
// the rollup's own dedup key before it can ever reach the residual sweep, so
// the reachable repro would prove nothing about the next one. (Review B, B-4.)
describe.skipIf(!isSqliteAvailable())('(c2) residual keys are derived from the leg timestamp', () => {
  it('names each residual after its leg instant, not its index', async () => {
    const dayN = Date.now() - 5 * 24 * 60 * 60 * 1000
    const at = (offsetHours: number): string => new Date(dayN + offsetHours * 3600 * 1000).toISOString()
    const sessionStateDir = join(tmpHome, 'reskey-state')
    await mkdir(sessionStateDir, { recursive: true })
    const dbPath = join(tmpHome, 'reskey-store.db')
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STATE_DIR', sessionStateDir)
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STORE_DB', dbPath)
    vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '1')
    vi.stubEnv('CODEBURN_COPILOT_WS_STORAGE_DIR', join(tmpHome, 'no-ws'))
    vi.stubEnv('CODEBURN_COPILOT_GLOBAL_STORAGE_DIR', join(tmpHome, 'no-global'))
    vi.stubEnv('CODEBURN_COPILOT_JETBRAINS_DIR', join(tmpHome, 'no-jb'))

    // Two legs, one partially-covering row: both legs mint a residual.
    const dir = join(sessionStateDir, 'sess-reskey')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'workspace.yaml'), 'id: sess-reskey\ncwd: /home/user/testproj\n')
    const rollup = (ts: string, cumulativeInput: number): string => JSON.stringify({
      type: 'session.shutdown',
      timestamp: ts,
      data: {
        shutdownType: 'routine',
        modelMetrics: {
          'claude-sonnet-4-5': {
            requests: { count: 1, cost: 1 },
            usage: { inputTokens: cumulativeInput, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
          },
        },
      },
    })
    await writeFile(join(dir, 'events.jsonl'), [
      JSON.stringify({ type: 'session.model_change', timestamp: at(0), data: { newModel: 'claude-sonnet-4-5' } }),
      JSON.stringify({ type: 'assistant.message', timestamp: at(1), data: { messageId: 'msg-1', outputTokens: 10, toolRequests: [] } }),
      rollup(at(2), 500),
      rollup(at(26), 800),
    ].join('\n') + '\n')

    createStoreDb(dbPath)
    insertStoreRow(dbPath, 'sess-reskey', 100, 0, 0, at(25))

    const keys = (await parseAllSessions(undefined, 'copilot'))
      .flatMap(p => p.sessions).flatMap(s => s.turns).flatMap(t => t.assistantCalls)
      .map(c => c.deduplicationKey)
      .filter(k => k.includes(':shutdown-residual:'))
      .sort()

    expect(keys).toEqual([
      `copilot:sess-reskey:shutdown-residual:claude-sonnet-4-5:${Date.parse(at(2))}`,
      `copilot:sess-reskey:shutdown-residual:claude-sonnet-4-5:${Date.parse(at(26))}`,
    ].sort())

    // The positional names must be gone: `:0` / `:1` are exactly what a leg
    // insertion would have renumbered.
    expect(keys.some(k => k.endsWith(':0') || k.endsWith(':1'))).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (c1) In-session compaction anchors the leg's store-row interval
// ═══════════════════════════════════════════════════════════════════════════
// The CLI's session.shutdown rollup RESETS its counters at a successful
// in-session compaction (confirmed against @github/copilot 1.0.80:
// `session.compaction_complete` with success:true, whose compactionTokensUsed
// the CLI charges through its own recordUsage path). A leg containing one
// therefore describes only its POST-compaction requests, and subtracting the
// whole pre-compaction conversation from it makes the residual short by
// exactly that much. The floor hides the error while the store is complete;
// a partial snapshot turns it into a permanent undercount once a day seals.
// (#946 review, blocker 2, the half the read-ordering fence cannot reach.)
describe.skipIf(!isSqliteAvailable())('(c1) compaction-anchored residual intervals', () => {
  // One session, one model, laid out as: row(s), an optional compaction, then
  // a single shutdown rollup covering only what follows the compaction.
  const writeCompactedSession = async (
    sessionStateDir: string,
    sessionId: string,
    at: (offsetSec: number) => string,
    opts: { compaction?: { atSec: number; success: boolean }; rollupInput: number },
  ): Promise<void> => {
    const dir = join(sessionStateDir, sessionId)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'workspace.yaml'), `id: ${sessionId}\ncwd: /home/user/testproj\n`)
    const lines = [
      JSON.stringify({ type: 'session.model_change', timestamp: at(0), data: { newModel: 'claude-sonnet-4-5' } }),
    ]
    if (opts.compaction) {
      lines.push(JSON.stringify({
        type: 'session.compaction_start',
        timestamp: at(opts.compaction.atSec - 1),
        data: { currentTokens: 180000, tokenLimit: 200000, trigger: 'automatic' },
      }))
      // Real payload shape, extra fields included on purpose: the parser must
      // read `success` and tolerate everything else.
      lines.push(JSON.stringify({
        type: 'session.compaction_complete',
        timestamp: at(opts.compaction.atSec),
        data: {
          success: opts.compaction.success,
          kind: opts.compaction.success ? 'background' : 'manualFailure',
          compactionTokensUsed: { inputTokens: 1200, outputTokens: 300, copilotUsage: { totalNanoAiu: 4000000 } },
          preCompactionTokens: 180000, postCompactionTokens: 20000,
          messagesRemoved: 42, tokensRemoved: 160000, trigger: 'automatic',
          model: 'claude-sonnet-4-5', requestId: 'req-x', duration: 900,
        },
      }))
    }
    lines.push(JSON.stringify({
      type: 'session.shutdown',
      timestamp: at(20),
      data: {
        shutdownType: 'routine',
        modelMetrics: {
          'claude-sonnet-4-5': {
            requests: { count: 1, cost: 1 },
            usage: { inputTokens: opts.rollupInput, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
          },
        },
      },
    }))
    await writeFile(join(dir, 'events.jsonl'), lines.join('\n') + '\n')
  }

  const setup = async (name: string) => {
    const sessionStateDir = join(tmpHome, `cmp-state-${name}`)
    await mkdir(sessionStateDir, { recursive: true })
    const dbPath = join(tmpHome, `cmp-store-${name}.db`)
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STATE_DIR', sessionStateDir)
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STORE_DB', dbPath)
    vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '1')
    vi.stubEnv('CODEBURN_COPILOT_WS_STORAGE_DIR', join(tmpHome, 'no-ws'))
    vi.stubEnv('CODEBURN_COPILOT_GLOBAL_STORAGE_DIR', join(tmpHome, 'no-global'))
    vi.stubEnv('CODEBURN_COPILOT_JETBRAINS_DIR', join(tmpHome, 'no-jb'))
    const base = Date.now() - 5 * 24 * 60 * 60 * 1000
    const at = (offsetSec: number): string => new Date(base + offsetSec * 1000).toISOString()
    createStoreDb(dbPath)
    return { sessionStateDir, dbPath, at }
  }

  const totalInput = (projects: Awaited<ReturnType<typeof parseAllSessions>>): number =>
    projects.flatMap(p => p.sessions).flatMap(s => s.turns).flatMap(t => t.assistantCalls)
      .reduce((sum, c) => sum + c.usage.inputTokens, 0)

  it("totals the maintainer's compaction repro at 300 with the post-compaction row missing", async () => {
    const { sessionStateDir, dbPath, at } = await setup('repro')
    // Row A: 100 tokens, BEFORE the compaction. Request B's row has not landed
    // in this snapshot. The sole rollup carries 200 — request B only.
    insertStoreRow(dbPath, 'sess-cmp', 100, 0, 0, at(5))
    await writeCompactedSession(sessionStateDir, 'sess-cmp', at, {
      compaction: { atSec: 10, success: true }, rollupInput: 200,
    })

    // A(100) served as a row + a residual of the full 200 the rollup claims,
    // because no row in (compaction, shutdown] can account for any of it.
    // Anchoring at the previous leg instead subtracts A and reports 200.
    expect(totalInput(await parseAllSessions(undefined, 'copilot'))).toBe(300)

    // Idempotent through the cache: compactedAt is persisted with the leg.
    clearSessionCache()
    expect(totalInput(await parseAllSessions(undefined, 'copilot'))).toBe(300)
  })

  it('does not double once the post-compaction row lands', async () => {
    const { sessionStateDir, dbPath, at } = await setup('complete')
    insertStoreRow(dbPath, 'sess-cmp2', 100, 0, 0, at(5))   // pre-compaction
    insertStoreRow(dbPath, 'sess-cmp2', 200, 0, 0, at(15))  // post-compaction, = the rollup
    await writeCompactedSession(sessionStateDir, 'sess-cmp2', at, {
      compaction: { atSec: 10, success: true }, rollupInput: 200,
    })

    // The post-compaction row covers the leg exactly, so the residual retires
    // to zero and the total is the two rows. Same answer the missing-row case
    // converges to, which is the point.
    expect(totalInput(await parseAllSessions(undefined, 'copilot'))).toBe(300)
  })

  it('ignores a FAILED compaction — nothing reset, so nothing to anchor', async () => {
    const { sessionStateDir, dbPath, at } = await setup('failed')
    insertStoreRow(dbPath, 'sess-cmp3', 100, 0, 0, at(5))
    await writeCompactedSession(sessionStateDir, 'sess-cmp3', at, {
      compaction: { atSec: 10, success: false }, rollupInput: 200,
    })

    // A failed compaction leaves the counters alone, so the rollup really does
    // cover row A: 100 (row) + 100 (residual) = 200, unchanged behaviour.
    expect(totalInput(await parseAllSessions(undefined, 'copilot'))).toBe(200)
  })

  it('leaves a leg with no compaction on the previous-leg interval', async () => {
    const { sessionStateDir, dbPath, at } = await setup('none')
    insertStoreRow(dbPath, 'sess-cmp4', 100, 0, 0, at(5))
    await writeCompactedSession(sessionStateDir, 'sess-cmp4', at, { rollupInput: 200 })

    expect(totalInput(await parseAllSessions(undefined, 'copilot'))).toBe(200)
  })
})

describe.skipIf(!isSqliteAvailable())('(p) reconciliation never outruns the served store rows', () => {
  it('serves the rollup total at every stage while rows progressively land', async () => {
    const { dbPath, at, writeSession, sumUsage } = await setupCopilotStoreEnv()
    createStoreDb(dbPath)
    await writeSession('sess-rev', { output: 25, rollup: true })

    // Refresh 1: the store was read before the rows committed — it holds
    // nothing for this session. The rollup is the only record and must
    // count; a zero here is the old design's lost refresh.
    const first = sumUsage(await parseAllSessions(undefined, 'copilot'))
    expect(first).toEqual({ input: 600, cacheRead: 17000, cacheWrite: 2400, output: 25 })

    // The first row lands: it serves per-request, and the rollup usage it
    // does not yet represent serves once as the residual — the total never
    // dips below what the rollup proved happened.
    clearSessionCache()
    insertStoreRow(dbPath, 'sess-rev', 12000, 10000, 1500, at(12)) // input 500

    const second = sumUsage(await parseAllSessions(undefined, 'copilot'))
    expect(second).toEqual({ input: 600, cacheRead: 17000, cacheWrite: 2400, output: 25 })

    // The second row completes coverage: totals unchanged, now served
    // entirely by rows — the residual has retired to zero.
    clearSessionCache()
    insertStoreRow(dbPath, 'sess-rev', 8000, 7000, 900, at(15))    // input 100

    const third = await parseAllSessions(undefined, 'copilot')
    expect(sumUsage(third)).toEqual({ input: 600, cacheRead: 17000, cacheWrite: 2400, output: 25 })
    const keys = third.flatMap(p => p.sessions).flatMap(s => s.turns).flatMap(t => t.assistantCalls).map(c => c.deduplicationKey)
    expect(keys.filter(k => k.startsWith('copilot-store:')).length).toBe(2)
    expect(keys.some(k => k.includes(':shutdown-residual:'))).toBe(false)
    expect(keys.some(k => k.includes(':shutdown:'))).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (s) Behavioral weight: supplementary accounting never fabricates activity
// ═══════════════════════════════════════════════════════════════════════════
// The round-6 finding 1 + the maintainer's weight contract. A shutdown rollup
// is aggregate accounting, never a request; a store row is a real request but
// pairs 1:1 with its served per-turn call when one exists. Blanket weight 1
// fabricated apiCalls/turns/modelCalls for every covered request; blanket
// weight 0 would hide crash-recovered requests. The pinned contract:
// JSONL + matching row = 1 call/turn; JSONL + rollup = the JSONL count only;
// store-only request = 1 call; rollup-only = 0 calls with full usage.
describe.skipIf(!isSqliteAvailable())('(s) behavioral weight of store rows and rollups', () => {
  it('pins call/turn weight across the four review scenarios', async () => {
    const { dbPath, at, writeSession } = await setupCopilotStoreEnv()
    createStoreDb(dbPath)

    // A: one real request, both representations served.
    await writeSession('sess-paired', { output: 25 })
    insertStoreRow(dbPath, 'sess-paired', 12000, 10000, 1500, at(12))
    // B: pre-store session — per-turn call + rollup, no rows.
    await writeSession('sess-rollup', { output: 30, rollup: true })
    // C: store-only request (crash lost the per-turn call; no session-state).
    insertStoreRow(dbPath, 'sess-crash', 8000, 7000, 900, at(15))

    const sessions = (await parseAllSessions(undefined, 'copilot')).flatMap(p => p.sessions)
    const byId = new Map(sessions.map(s => [s.sessionId, s]))
    const modelCalls = (s: NonNullable<ReturnType<typeof byId.get>>): number =>
      Object.values(s.modelBreakdown).reduce((sum, m) => sum + m.calls, 0)

    const paired = byId.get('sess-paired')!
    expect(paired.apiCalls).toBe(1)
    expect(paired.turns.length).toBe(1)
    expect(modelCalls(paired)).toBe(1)
    expect(paired.totalInputTokens).toBe(500)     // the row's tokens count in full
    expect(paired.totalCacheReadTokens).toBe(10000)
    expect(paired.totalOutputTokens).toBe(25)

    const withRollup = byId.get('sess-rollup')!
    expect(withRollup.apiCalls).toBe(1)           // the per-turn call only
    expect(withRollup.turns.length).toBe(1)
    expect(modelCalls(withRollup)).toBe(1)
    expect(withRollup.totalInputTokens).toBe(600) // rollup tokens retained

    const crash = byId.get('sess-crash')!
    expect(crash.apiCalls).toBe(1)                // a real, store-only request
    expect(crash.turns.length).toBe(1)
    expect(crash.totalInputTokens).toBe(100)
  })

  it('pairs rows per model: a subagent row without its per-turn call still counts', async () => {
    const { dbPath, at, writeSession } = await setupCopilotStoreEnv()
    createStoreDb(dbPath)
    // One sonnet request served both ways, plus a haiku subagent request
    // whose per-turn call was lost — the haiku row must not pair against the
    // sonnet call.
    await writeSession('sess-multi', { output: 25 })                    // sonnet per-turn call
    insertStoreRow(dbPath, 'sess-multi', 12000, 10000, 1500, at(12))    // sonnet row → paired
    const { DatabaseSync } = requireForTest('node:sqlite') as { DatabaseSync: new (path: string) => TestDb }
    const db = new DatabaseSync(dbPath)
    db.prepare(
      `INSERT INTO assistant_usage_events
         (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, created_at)
       VALUES ('sess-multi', 'claude-haiku-4-5', 5050, 0, 5000, 0, 0, ?)`
    ).run(at(14))
    db.close()

    const session = (await parseAllSessions(undefined, 'copilot')).flatMap(p => p.sessions)
      .find(s => s.sessionId === 'sess-multi')!
    expect(session.apiCalls).toBe(2)   // the sonnet request + the haiku request
    const calls = Object.fromEntries(Object.entries(session.modelBreakdown).map(([m, b]) => [m, b.calls]))
    expect(Object.values(calls).reduce((a, b) => a + b, 0)).toBe(2)
    expect(session.totalInputTokens).toBe(500 + 50)
  })

  it('serves a rollup-only session with zero call weight but full usage', async () => {
    const { dbPath, at } = await setupCopilotStoreEnv()
    createStoreDb(dbPath)
    // events.jsonl holding ONLY the shutdown rollup — no per-turn events
    // survived. Its tokens are real; its "calls" are not.
    const dir = join(tmpHome, 'session-state', 'sess-agg')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'workspace.yaml'), 'id: sess-agg\ncwd: /home/user/testproj\n')
    await writeFile(join(dir, 'events.jsonl'), [
      JSON.stringify({ type: 'session.model_change', timestamp: at(0), data: { newModel: 'claude-sonnet-4-5' } }),
      JSON.stringify({
        type: 'session.shutdown',
        timestamp: at(20),
        data: {
          shutdownType: 'routine',
          modelMetrics: {
            'claude-sonnet-4-5': {
              requests: { count: 2, cost: 1 },
              usage: { inputTokens: 20000, outputTokens: 0, cacheReadTokens: 17000, cacheWriteTokens: 2400, reasoningTokens: 0 },
            },
          },
        },
      }),
    ].join('\n') + '\n')

    const sessions = (await parseAllSessions(undefined, 'copilot')).flatMap(p => p.sessions)
    const agg = sessions.find(s => s.sessionId === 'sess-agg')
    expect(agg).toBeDefined()
    expect(agg!.apiCalls).toBe(0)
    expect(agg!.totalInputTokens).toBe(600)
    expect(agg!.totalCacheReadTokens).toBe(17000)
    expect(agg!.totalCostUSD).toBeGreaterThan(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (t) A deferred store read marks hydration incomplete
// ═══════════════════════════════════════════════════════════════════════════
// The round-6 finding 2. A changed store whose read defers (busy, EACCES —
// every retryable shape funnels through the same busy-shaped throw) keeps
// serving its cached rows, but the data the read would have added is missing
// from the pass: reporting hydration complete would let the daily backfill
// finalize history without it. The fence must hold until the read lands.
describe.skipIf(!isSqliteAvailable())('(t) deferred store read marks hydration incomplete', () => {
  it.skipIf(process.getuid?.() === 0)('holds the fence while the changed store is unreadable, then recovers', async () => {
    const { dbPath, at, writeSession, sumUsage } = await setupCopilotStoreEnv()
    createStoreDb(dbPath)
    insertStoreRow(dbPath, 'sess-h', 12000, 10000, 1500, at(12)) // input 500
    await writeSession('sess-h', { output: 25 })

    const first = sumUsage(await parseAllSessions(undefined, 'copilot'))
    expect(first).toEqual({ input: 500, cacheRead: 10000, cacheWrite: 1500, output: 25 })
    expect(isSessionHydrationComplete()).toBe(true)

    // The store grows, then becomes unreadable before the refresh reads it.
    clearSessionCache()
    insertStoreRow(dbPath, 'sess-h', 8000, 7000, 900, at(20))    // input 100
    const unblock = await blockStoreReads(dbPath)
    try {
      const second = sumUsage(await parseAllSessions(undefined, 'copilot'))
      // Cached rows keep serving — the deferral is invisible in totals...
      expect(second).toEqual({ input: 500, cacheRead: 10000, cacheWrite: 1500, output: 25 })
      // ...but the pass must not claim full hydration: a row is missing.
      expect(isSessionHydrationComplete()).toBe(false)
    } finally {
      await unblock()
    }

    // Readable again: the deferred row lands and the fence lifts.
    clearSessionCache()
    const third = sumUsage(await parseAllSessions(undefined, 'copilot'))
    expect(third).toEqual({ input: 600, cacheRead: 17000, cacheWrite: 2400, output: 25 })
    expect(isSessionHydrationComplete()).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (t2) The fence actually HOLDS THE DAILY WATERMARK, end to end
// ═══════════════════════════════════════════════════════════════════════════
// The maintainer's refinement asked for a production-path regression proving
// "busy store + unchanged cached JSONL => hydration incomplete AND daily
// watermark held" — the flag alone is not the contract. This wires the REAL
// isSessionHydrationComplete into ensureCacheHydrated (no stub) and asserts
// the daily cache refuses to finalize while the store's re-read is deferred.
describe.skipIf(!isSqliteAvailable())('(t2) deferred store holds the daily watermark', () => {
  it.skipIf(process.getuid?.() === 0)('leaves the daily cache incomplete until the store is readable', async () => {
    const { dbPath, at, writeSession } = await setupCopilotStoreEnv()
    createStoreDb(dbPath)
    insertStoreRow(dbPath, 'sess-wm', 12000, 10000, 1500, at(12))
    await writeSession('sess-wm', { output: 25 })

    // Seed a daily cache whose watermark is deliberately BEHIND yesterday, so
    // every run below faces a real backfill gap to seal while the watermark is
    // non-null and its preservation is observable. The session cache stays
    // warm and the JSONL unchanged — the reviewer's shape, where no
    // session-state parser runs and only the store's own deferral can reach
    // the fence.
    const dayStr = (n: number): string => {
      const d = new Date()
      d.setDate(d.getDate() - n)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    const seededWatermark = dayStr(5)
    const seedDailyCache = async () => {
      await saveDailyCache({
        version: DAILY_CACHE_VERSION,
        savingsConfigHash: '',
        tzKey: currentTzKey(),
        lastComputedDate: seededWatermark,
        complete: true,
        watermarkTrusted: true,
        days: [],
      })
    }
    const hydrate = async () => {
      clearSessionCache()
      return ensureCacheHydrated(
        range => parseAllSessions(range, 'copilot'),
        aggregateProjectsIntoDays,
        '',
        // The production wiring: the real flag, not a stub.
        isSessionHydrationComplete,
      )
    }

    // The store grows and turns unreadable before the refresh reads it.
    await seedDailyCache()
    insertStoreRow(dbPath, 'sess-wm', 8000, 7000, 900, at(20))
    const unblock = await blockStoreReads(dbPath)
    let degraded: Awaited<ReturnType<typeof hydrate>>
    try {
      degraded = await hydrate()
      expect(isSessionHydrationComplete()).toBe(false)
      // The contract the reviewer asked for: history does not seal, and the
      // watermark is HELD where it was — not advanced by a parse that never
      // read the new row, and not reset either.
      expect(degraded.complete).toBe(false)
      expect(degraded.lastComputedDate).toBe(seededWatermark)
    } finally {
      await unblock()
    }

    // Readable again — and healing must happen IN PLACE, against the same
    // persisted incomplete cache the degraded run left behind (no reseed):
    // the deferred row lands, the day seals, and the watermark advances.
    const healed = await hydrate()
    expect(isSessionHydrationComplete()).toBe(true)
    expect(healed.complete).toBe(true)
    expect(healed.lastComputedDate).not.toBe(seededWatermark)
    expect(healed.lastComputedDate! > seededWatermark).toBe(true)
    // The row deferred during the outage is in the sealed history.
    const sealed = healed.days.reduce((s, d) => s + (d.providers['copilot']?.inputTokens ?? 0), 0)
    expect(sealed).toBe(600)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (u) A project learned after rows were cached cannot split the session
// ═══════════════════════════════════════════════════════════════════════════
// The round-6 companion finding. Store rows cached before their session's
// session-state dir existed carry the store's cwd-derived project; when
// events.jsonl later appears (workspace.yaml cwd), the store file itself may
// be unchanged — its cached calls are reused verbatim. Project is part of the
// session grouping key, so without serve-time unification one real session
// splits in two. The serve pass rewrites cached store calls to the
// session-state project whenever the serve set knows it.
describe.skipIf(!isSqliteAvailable())('(u) late-learned project identity unifies cached store rows', () => {
  it('serves one session under the session-state project after it appears', async () => {
    const { dbPath, at, writeSession } = await setupCopilotStoreEnv()
    createStoreDb(dbPath)
    insertStoreRow(dbPath, 'sess-late', 12000, 10000, 1500, at(12), 0, '/home/user/storeproj')

    const s1 = (await parseAllSessions(undefined, 'copilot')).flatMap(p => p.sessions)
      .find(s => s.sessionId === 'sess-late')!
    expect(s1.project).toBe('storeproj')

    // The session-state dir appears; the store file is UNCHANGED, so its
    // cached call still carries 'storeproj' until serve-time unification.
    clearSessionCache()
    await writeSession('sess-late', { output: 25 })

    const sessions = (await parseAllSessions(undefined, 'copilot')).flatMap(p => p.sessions)
      .filter(s => s.sessionId === 'sess-late')
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.project).toBe('testproj')
    expect(sessions[0]!.totalInputTokens).toBe(500)
    expect(sessions[0]!.totalOutputTokens).toBe(25)
    expect(sessions[0]!.apiCalls).toBe(1)
  })

  it('keeps one session when the session-state dir is pruned and the jsonl orphans', async () => {
    // The reverse shape (round-6.5 finding): events.jsonl becomes a durable
    // orphan, losing its source.project, while the store rows live on. Both
    // sides must adopt the surviving label — the store's own — or one real
    // request serves as two sessions with doubled call weight.
    const { dbPath, at, writeSession } = await setupCopilotStoreEnv()
    createStoreDb(dbPath)
    insertStoreRow(dbPath, 'sess-prune', 12000, 10000, 1500, at(12), 0, '/home/user/storeproj')
    await writeSession('sess-prune', { output: 25 })

    const s1 = (await parseAllSessions(undefined, 'copilot')).flatMap(p => p.sessions)
      .filter(s => s.sessionId === 'sess-prune')
    expect(s1).toHaveLength(1)
    expect(s1[0]!.apiCalls).toBe(1)

    clearSessionCache()
    await rm(join(tmpHome, 'session-state', 'sess-prune'), { recursive: true, force: true })

    const s2 = (await parseAllSessions(undefined, 'copilot')).flatMap(p => p.sessions)
      .filter(s => s.sessionId === 'sess-prune')
    expect(s2).toHaveLength(1)
    // The rows were cached carrying the jsonl-derived label, so the session
    // keeps it even after the jsonl orphans — stable, and never split.
    expect(s2[0]!.project).toBe('testproj')
    expect(s2[0]!.apiCalls).toBe(1)
    expect(s2[0]!.totalInputTokens).toBe(500)
    expect(s2[0]!.totalOutputTokens).toBe(25)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (v) A same-path store reset cannot swallow new usage
// ═══════════════════════════════════════════════════════════════════════════
// The round-6 finding 4. Recreating the DB at the same path restarts the
// AUTOINCREMENT sequence; under a bare <sid>:<rowId> key the durable union
// rejected the recreated row as already-cached and its usage vanished. The
// content-discriminated key admits it; the original row remains served as
// real past usage (the durable contract: cached history never shrinks).
describe.skipIf(!isSqliteAvailable())('(v) same-path store reset', () => {
  it('serves the recreated row alongside the durable original', async () => {
    const { dbPath, at, sumUsage } = await setupCopilotStoreEnv()
    createStoreDb(dbPath)
    insertStoreRow(dbPath, 'sess-reset', 12000, 10000, 1500, at(12)) // input 500
    const first = sumUsage(await parseAllSessions(undefined, 'copilot'))
    expect(first).toEqual({ input: 500, cacheRead: 10000, cacheWrite: 1500, output: 0 })

    clearSessionCache()
    await rm(dbPath, { force: true })
    createStoreDb(dbPath)
    insertStoreRow(dbPath, 'sess-reset', 8000, 7000, 900, at(30))    // row id 1 again
    const second = sumUsage(await parseAllSessions(undefined, 'copilot'))
    expect(second).toEqual({ input: 600, cacheRead: 17000, cacheWrite: 2400, output: 0 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (w) Mixed coverage: a crash tail cannot cancel a leg's missing rows
// ═══════════════════════════════════════════════════════════════════════════
// The round-6.5 converging finding (grok + gpt-5.6-sol independently). A
// lifetime `max(0, rollup − allRows)` residual lets store rows the rollup
// never covered (a crash tail, a later reset) cancel usage the rollup DID
// cover whose rows are missing. Residuals are therefore computed per rollup
// leg over only the rows in that leg's interval — rows commit before their
// leg's shutdown line, so a row after the leg belongs to the tail, never to
// the subtraction.
describe.skipIf(!isSqliteAvailable())('(w) per-leg residual under mixed coverage', () => {
  it('serves the covered gap AND the crash tail in full', async () => {
    const { dbPath, at } = await setupCopilotStoreEnv()
    createStoreDb(dbPath)

    const dir = join(tmpHome, 'session-state', 'sess-mix')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'workspace.yaml'), 'id: sess-mix\ncwd: /home/user/testproj\n')
    await writeFile(join(dir, 'events.jsonl'), [
      JSON.stringify({ type: 'session.model_change', timestamp: at(0), data: { newModel: 'claude-sonnet-4-5' } }),
      JSON.stringify({ type: 'assistant.message', timestamp: at(5), data: { messageId: 'msg-1', outputTokens: 25, toolRequests: [] } }),
      // The rollup covers requests R1+R2 (cache-inclusive input 10,200 →
      // uncached 200, cacheRead 10,000).
      JSON.stringify({
        type: 'session.shutdown',
        timestamp: at(20),
        data: {
          shutdownType: 'routine',
          modelMetrics: {
            'claude-sonnet-4-5': {
              requests: { count: 2, cost: 1 },
              usage: { inputTokens: 10200, outputTokens: 25, cacheReadTokens: 10000, cacheWriteTokens: 0, reasoningTokens: 0 },
            },
          },
        },
      }),
    ].join('\n') + '\n')

    // R1's row exists (input 100 / cacheRead 5,000); R2's row is missing
    // (pre-store leg). R3 is a crash-tail row AFTER the shutdown (input 300)
    // that no rollup ever covered.
    insertStoreRow(dbPath, 'sess-mix', 5100, 5000, 0, at(10))  // R1
    insertStoreRow(dbPath, 'sess-mix', 300, 0, 0, at(30))      // R3, after the leg

    const session = (await parseAllSessions(undefined, 'copilot')).flatMap(p => p.sessions)
      .find(s => s.sessionId === 'sess-mix')!
    // Truth: R1 (100/5,000) + R2 (100/5,000, via the leg residual) + R3 (300).
    // A lifetime subtraction would have served input 400 — R3's crash input
    // cancelling R2's missing row.
    expect(session.totalInputTokens).toBe(500)
    expect(session.totalCacheReadTokens).toBe(10000)
    expect(session.totalOutputTokens).toBe(25)
    // Weight: the per-turn call + the unpaired crash row.
    expect(session.apiCalls).toBe(2)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (x) Per-leg residuals keep each leg's gap on that leg's own day
// ═══════════════════════════════════════════════════════════════════════════
// Round-6.5: one residual stamped at the LAST leg moved every earlier leg's
// uncovered usage onto the final day — day 1 sealed 0, day 2 sealed double.
// Each leg's residual is anchored at that leg's own timestamp.
describe.skipIf(!isSqliteAvailable())('(x) multi-leg residual day attribution', () => {
  it('serves each leg\'s uncovered usage on its own day', async () => {
    const dayN = Date.now() - 5 * 24 * 60 * 60 * 1000
    const at = (offsetHours: number): string => new Date(dayN + offsetHours * 3600 * 1000).toISOString()
    const sessionStateDir = join(tmpHome, 'session-state')
    await mkdir(sessionStateDir, { recursive: true })
    const dbPath = join(tmpHome, 'session-store.db')
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STATE_DIR', sessionStateDir)
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STORE_DB', dbPath)
    vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '1')
    vi.stubEnv('CODEBURN_COPILOT_WS_STORAGE_DIR', join(tmpHome, 'no-ws'))
    vi.stubEnv('CODEBURN_COPILOT_GLOBAL_STORAGE_DIR', join(tmpHome, 'no-global'))
    vi.stubEnv('CODEBURN_COPILOT_JETBRAINS_DIR', join(tmpHome, 'no-jb'))

    // A resumed session: leg 1 shuts down on day 1 (cumulative input 500,
    // cache-free for arithmetic clarity), leg 2 the next day (cumulative 800
    // → delta 300). The store has one leg-2 row (100); leg 1 predates the
    // store entirely and leg 2 is only partially covered, so BOTH legs carry
    // a nonzero residual on their own day.
    const dir = join(sessionStateDir, 'sess-legs')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'workspace.yaml'), 'id: sess-legs\ncwd: /home/user/testproj\n')
    const rollup = (ts: string, cumulativeInput: number): string => JSON.stringify({
      type: 'session.shutdown',
      timestamp: ts,
      data: {
        shutdownType: 'routine',
        modelMetrics: {
          'claude-sonnet-4-5': {
            requests: { count: 1, cost: 1 },
            usage: { inputTokens: cumulativeInput, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
          },
        },
      },
    })
    await writeFile(join(dir, 'events.jsonl'), [
      JSON.stringify({ type: 'session.model_change', timestamp: at(0), data: { newModel: 'claude-sonnet-4-5' } }),
      JSON.stringify({ type: 'assistant.message', timestamp: at(1), data: { messageId: 'msg-1', outputTokens: 10, toolRequests: [] } }),
      rollup(at(2), 500),
      rollup(at(26), 800),
    ].join('\n') + '\n')

    createStoreDb(dbPath)
    insertStoreRow(dbPath, 'sess-legs', 100, 0, 0, at(25))

    const inputIn = async (startH: number, endH: number): Promise<number> => {
      const projects = await parseAllSessions(
        { start: new Date(dayN + startH * 3600 * 1000), end: new Date(dayN + endH * 3600 * 1000) }, 'copilot')
      return projects.flatMap(p => p.sessions).flatMap(s => s.turns).flatMap(t => t.assistantCalls)
        .reduce((s, c) => s + c.usage.inputTokens, 0)
    }

    expect(await inputIn(-1, 12)).toBe(500)   // day 1: leg 1's gap, at leg 1's stamp
    expect(await inputIn(12, 36)).toBe(300)   // day 2: the row (100) + leg 2's residual (200)
    expect(await inputIn(-1, 36)).toBe(800)   // both: exactly once

    // A range that excludes every behavioral turn (the per-turn call) but
    // holds residual turns from different days: they must stay SEPARATE
    // turns on their own days — an anchorless merge would re-anchor day-2
    // accounting onto day 1's turn stamp.
    const anchorless = (await parseAllSessions(
      { start: new Date(dayN + 1.5 * 3600 * 1000), end: new Date(dayN + 36 * 3600 * 1000) }, 'copilot'))
      .flatMap(p => p.sessions).filter(s => s.sessionId === 'sess-legs')
    const turnDays = anchorless.flatMap(s => s.turns).map(t => new Date(t.timestamp).toISOString().slice(0, 10))
    expect(new Set(turnDays).size).toBeGreaterThanOrEqual(2)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (w2) Residual edge shapes: equal-timestamp legs, unparseable leg stamps,
//      and crash rows outside the pairing window
// ═══════════════════════════════════════════════════════════════════════════
describe.skipIf(!isSqliteAvailable())('(w2) residual and pairing edge shapes', () => {
  it('coalesces equal-timestamp legs so their shared rows subtract once', async () => {
    const { dbPath, at } = await setupCopilotStoreEnv()
    createStoreDb(dbPath)
    const dir = join(tmpHome, 'session-state', 'sess-ties')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'workspace.yaml'), 'id: sess-ties\ncwd: /home/user/testproj\n')
    const rollup = (ts: string, cumulativeInput: number): string => JSON.stringify({
      type: 'session.shutdown',
      timestamp: ts,
      data: {
        shutdownType: 'routine',
        modelMetrics: {
          'claude-sonnet-4-5': {
            requests: { count: 1, cost: 1 },
            usage: { inputTokens: cumulativeInput, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
          },
        },
      },
    })
    // Two shutdown legs stamped the SAME second (deltas 100 and 200); the
    // store holds one 200-token row at that instant. A strict interval rule
    // hands the row to the first leg and mints a full 200 residual for the
    // second (serving 400); coalescing subtracts it once (serving 300).
    await writeFile(join(dir, 'events.jsonl'), [
      JSON.stringify({ type: 'session.model_change', timestamp: at(0), data: { newModel: 'claude-sonnet-4-5' } }),
      rollup(at(20), 100),
      rollup(at(20), 300),
    ].join('\n') + '\n')
    insertStoreRow(dbPath, 'sess-ties', 200, 0, 0, at(20))

    const input = (await parseAllSessions(undefined, 'copilot')).flatMap(p => p.sessions)
      .filter(s => s.sessionId === 'sess-ties')
      .reduce((s, x) => s + x.totalInputTokens, 0)
    expect(input).toBe(300)
  })

  it('serves a rollup with an unparseable timestamp instead of silently dropping it', async () => {
    const { dbPath, at } = await setupCopilotStoreEnv()
    createStoreDb(dbPath)
    const dir = join(tmpHome, 'session-state', 'sess-badts')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'workspace.yaml'), 'id: sess-badts\ncwd: /home/user/testproj\n')
    // The leg's timestamp cannot parse, so it can never enter the residual
    // sweep — dropping it because rows exist would silently lose its usage.
    // It serves unchanged (weightless); the bounded overlap with the row is
    // the documented corruption-shaped trade (over-serve, never lose).
    await writeFile(join(dir, 'events.jsonl'), [
      JSON.stringify({ type: 'session.model_change', timestamp: at(0), data: { newModel: 'claude-sonnet-4-5' } }),
      JSON.stringify({
        type: 'session.shutdown',
        timestamp: 'not-a-timestamp',
        data: {
          shutdownType: 'routine',
          modelMetrics: {
            'claude-sonnet-4-5': {
              requests: { count: 1, cost: 1 },
              usage: { inputTokens: 500, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
            },
          },
        },
      }),
    ].join('\n') + '\n')
    insertStoreRow(dbPath, 'sess-badts', 100, 0, 0, at(10))

    const sessions = (await parseAllSessions(undefined, 'copilot')).flatMap(p => p.sessions)
      .filter(s => s.sessionId === 'sess-badts')
    const input = sessions.reduce((s, x) => s + x.totalInputTokens, 0)
    expect(input).toBe(600)  // row 100 + un-droppable rollup 500; never 100
    expect(sessions.reduce((s, x) => s + x.apiCalls, 0)).toBe(1)  // the row; the rollup stays weightless

    // The rollup adopted a STABLE valid timestamp (its file's preceding
    // valid stamp, else the session's earliest), so a RANGED query (the
    // shape the daily backfill uses) serves the same 600 — a raw
    // unparseable stamp would be invisible to callsInRange and quietly lose
    // the 500 from every sealed day.
    const base = new Date(at(0)).getTime()
    const rangedInput = async (): Promise<number> =>
      (await parseAllSessions(
        { start: new Date(base - 3600 * 1000), end: new Date(base + 3600 * 1000) }, 'copilot'))
        .flatMap(p => p.sessions).filter(s => s.sessionId === 'sess-badts')
        .reduce((s, x) => s + x.totalInputTokens, 0)
    expect(await rangedInput()).toBe(600)

    // The session resumes a day later: the fallback must NOT move with it —
    // a day sealed with the rollup would otherwise lose it to the new day
    // and the daily union would count it twice.
    clearSessionCache()
    insertStoreRow(dbPath, 'sess-badts', 50, 0, 0, at(86400))
    expect(await rangedInput()).toBe(600)
  })

  it('anchors a timestamp-less shutdown after its rows, not at session start', async () => {
    // Audit finding: the leg's stamp anchors its interval in the residual
    // sweep. A shutdown event with no `timestamp` fell back to
    // sessionStartTime — BEFORE every row — so the leg covered nothing and
    // re-minted its whole usage beside the rows it duplicates (600/17,000
    // served as 1,200/34,000). The fallback now prefers the last event seen,
    // which is at the end of the leg where a shutdown actually happens.
    const { dbPath, at } = await setupCopilotStoreEnv()
    createStoreDb(dbPath)
    const dir = join(tmpHome, 'session-state', 'sess-nots')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'workspace.yaml'), 'id: sess-nots\ncwd: /home/user/testproj\n')
    await writeFile(join(dir, 'events.jsonl'), [
      JSON.stringify({ type: 'session.model_change', timestamp: at(0), data: { newModel: 'claude-sonnet-4-5' } }),
      JSON.stringify({ type: 'assistant.message', timestamp: at(18), data: { messageId: 'msg-1', outputTokens: 25, toolRequests: [] } }),
      // No `timestamp` on the shutdown; sessionStartTime precedes every row.
      JSON.stringify({
        type: 'session.shutdown',
        data: {
          shutdownType: 'routine',
          sessionStartTime: at(0),
          modelMetrics: {
            'claude-sonnet-4-5': {
              requests: { count: 2, cost: 1 },
              usage: { inputTokens: 20000, outputTokens: 25, cacheReadTokens: 17000, cacheWriteTokens: 2400, reasoningTokens: 0 },
            },
          },
        },
      }),
    ].join('\n') + '\n')
    insertStoreRow(dbPath, 'sess-nots', 12000, 10000, 1500, at(12)) // input 500
    insertStoreRow(dbPath, 'sess-nots', 8000, 7000, 900, at(15))    // input 100

    const session = (await parseAllSessions(undefined, 'copilot')).flatMap(p => p.sessions)
      .find(s => s.sessionId === 'sess-nots')!
    expect(session.totalInputTokens).toBe(600)
    expect(session.totalCacheReadTokens).toBe(17000)
    expect(session.totalCacheWriteTokens).toBe(2400)
  })

  it('keeps a crash row\'s call weight when it sits outside the pairing window', async () => {
    const { dbPath, at, writeSession } = await setupCopilotStoreEnv()
    createStoreDb(dbPath)
    // The per-turn call at at(10) lost its own row; a crash-only row lands 5
    // minutes later. A wide pairing window would pair the two and hide the
    // crash request; the tight window leaves the row unpaired and counted.
    await writeSession('sess-far', { output: 25 })
    insertStoreRow(dbPath, 'sess-far', 100, 0, 0, at(310))

    const session = (await parseAllSessions(undefined, 'copilot')).flatMap(p => p.sessions)
      .find(s => s.sessionId === 'sess-far')!
    expect(session.apiCalls).toBe(2)
    expect(session.totalInputTokens).toBe(100)
    expect(session.totalOutputTokens).toBe(25)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (y) Pairing is range-invariant: adjacent day queries stay additive
// ═══════════════════════════════════════════════════════════════════════════
// Round-6.5 (gpt-5.6-sol): weights recomputed from a range slice let a store
// row and its per-turn call each count as a call on opposite sides of a day
// boundary — two calls for one request across adjacent queries. The pairing
// is computed once over the full serve set and arrives as a key set, so a
// slice cannot change a row's verdict.
describe.skipIf(!isSqliteAvailable())('(y) range-invariant behavioral pairing', () => {
  it('counts one call across two adjacent ranges that split row from per-turn call', async () => {
    const { dbPath, at, writeSession } = await setupCopilotStoreEnv()
    createStoreDb(dbPath)
    // writeSession puts the per-turn call at at(10); the row lands at at(60),
    // both within the pairing window.
    await writeSession('sess-split', { output: 25 })
    insertStoreRow(dbPath, 'sess-split', 12000, 10000, 1500, at(60))

    const base = new Date(at(0)).getTime()
    const range = async (fromSec: number, toSec: number) => {
      const projects = await parseAllSessions(
        { start: new Date(base + fromSec * 1000), end: new Date(base + toSec * 1000) }, 'copilot')
      const sessions = projects.flatMap(p => p.sessions).filter(s => s.sessionId === 'sess-split')
      return {
        apiCalls: sessions.reduce((s, x) => s + x.apiCalls, 0),
        input: sessions.reduce((s, x) => s + x.totalInputTokens, 0),
        output: sessions.reduce((s, x) => s + x.totalOutputTokens, 0),
      }
    }

    // Range A holds only the per-turn call; range B only the row.
    const a = await range(0, 30)
    expect(a).toEqual({ apiCalls: 1, input: 0, output: 25 })
    const b = await range(31, 120)
    expect(b).toEqual({ apiCalls: 0, input: 500, output: 0 })

    // The full range pairs them the same way: still exactly one call.
    const full = await range(0, 120)
    expect(full).toEqual({ apiCalls: 1, input: 500, output: 25 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (z) The hydration verdict travels with its result
// ═══════════════════════════════════════════════════════════════════════════
describe.skipIf(!isSqliteAvailable())('(z) hydration verdict integrity', () => {
  // Round-6.5 (gpt-5.6-sol): a memoized partial parse served after a later,
  // complete parse inherited the later parse's `true`, letting the daily
  // backfill seal history around the deferred data.
  it.skipIf(process.getuid?.() === 0)('a memo hit restores the verdict its data was parsed under', async () => {
    const { dbPath, at, writeSession } = await setupCopilotStoreEnv()
    createStoreDb(dbPath)
    insertStoreRow(dbPath, 'sess-memo', 12000, 10000, 1500, at(12))
    await writeSession('sess-memo', { output: 25 })
    await parseAllSessions(undefined, 'copilot')
    expect(isSessionHydrationComplete()).toBe(true)

    // The store grows and becomes unreadable: the re-parse defers (false)
    // and that verdict is memoized with the result.
    clearSessionCache()
    insertStoreRow(dbPath, 'sess-memo', 8000, 7000, 900, at(20))
    const unblock = await blockStoreReads(dbPath)
    try {
      await parseAllSessions(undefined, 'copilot')
      expect(isSessionHydrationComplete()).toBe(false)

      // An unrelated provider parses completely and flips the global to true…
      await parseAllSessions(undefined, 'claude')
      expect(isSessionHydrationComplete()).toBe(true)

      // …but re-serving the deferred copilot result from the memo must
      // restore ITS verdict, not inherit the later parse's.
      await parseAllSessions(undefined, 'copilot')
      expect(isSessionHydrationComplete()).toBe(false)
    } finally {
      await unblock()
    }
  })

  // Round-6.5 (gpt-5.6-sol): a source whose FINGERPRINT cannot be read was
  // skipped before any parser could raise the deferral shape, leaving the
  // fence open while the cached (stale) rows served.
  it.skipIf(process.getuid?.() === 0)('an unreadable fingerprint defers instead of silently skipping', async () => {
    const sessionStateDir = join(tmpHome, 'session-state')
    await mkdir(sessionStateDir, { recursive: true })
    const storeDir = join(tmpHome, 'store-dir')
    await mkdir(storeDir, { recursive: true })
    const dbPath = join(storeDir, 'session-store.db')
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STATE_DIR', sessionStateDir)
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STORE_DB', dbPath)
    vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '1')
    vi.stubEnv('CODEBURN_COPILOT_WS_STORAGE_DIR', join(tmpHome, 'no-ws'))
    vi.stubEnv('CODEBURN_COPILOT_GLOBAL_STORAGE_DIR', join(tmpHome, 'no-global'))
    vi.stubEnv('CODEBURN_COPILOT_JETBRAINS_DIR', join(tmpHome, 'no-jb'))
    const base = Date.now() - 5 * 24 * 60 * 60 * 1000
    const at = (offsetSec: number): string => new Date(base + offsetSec * 1000).toISOString()

    createStoreDb(dbPath)
    insertStoreRow(dbPath, 'sess-fp', 12000, 10000, 1500, at(12))
    const first = await parseAllSessions(undefined, 'copilot')
    expect(first.flatMap(p => p.sessions).find(s => s.sessionId === 'sess-fp')!.totalInputTokens).toBe(500)
    expect(isSessionHydrationComplete()).toBe(true)

    // The store grows, then its parent dir loses traversal: discovery still
    // emits the source (EACCES is not absence), the fingerprint read fails,
    // and the pass must report incomplete hydration — the new row is missing.
    clearSessionCache()
    insertStoreRow(dbPath, 'sess-fp', 8000, 7000, 900, at(20))
    const unblock = await blockStoreStat(dbPath, storeDir)
    try {
      const second = await parseAllSessions(undefined, 'copilot')
      expect(second.flatMap(p => p.sessions).find(s => s.sessionId === 'sess-fp')!.totalInputTokens).toBe(500)
      expect(isSessionHydrationComplete()).toBe(false)
    } finally {
      await unblock()
    }

    clearSessionCache()
    const third = await parseAllSessions(undefined, 'copilot')
    expect(third.flatMap(p => p.sessions).find(s => s.sessionId === 'sess-fp')!.totalInputTokens).toBe(600)
    expect(isSessionHydrationComplete()).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (j) Rollup-day reattribution: usage lands on the request days, not the day
//     the CLI finally shut down
// ═══════════════════════════════════════════════════════════════════════════
// Observed in the wild: a session ran entirely on day N (per-request DB rows)
// but its session.shutdown rollup was stamped the NEXT morning when the CLI
// was closed. The rollup path put the whole session's input/cache on day N+1;
// with the store covering the session, the tokens must land on day N and the
// session must contribute NOTHING to day N+1 — while still counting exactly
// once in an unfiltered (lifetime) parse. This is the per-day attribution
// change the daily-cache v18 bump re-derives for.
describe.skipIf(!isSqliteAvailable())('(j) rollup-day reattribution to request days', () => {
  it('counts a next-morning-shutdown session on its request day only', async () => {
    const sessionStateDir = join(tmpHome, 'session-state')
    await mkdir(sessionStateDir, { recursive: true })
    const dbPath = join(tmpHome, 'session-store.db')
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STATE_DIR', sessionStateDir)
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STORE_DB', dbPath)
    vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '1')
    vi.stubEnv('CODEBURN_COPILOT_WS_STORAGE_DIR', join(tmpHome, 'no-ws'))
    vi.stubEnv('CODEBURN_COPILOT_GLOBAL_STORAGE_DIR', join(tmpHome, 'no-global'))
    vi.stubEnv('CODEBURN_COPILOT_JETBRAINS_DIR', join(tmpHome, 'no-jb'))

    // "Day N" = 5 days ago; the shutdown lands ~19h later ("next morning").
    const dayN = Date.now() - 5 * 24 * 60 * 60 * 1000
    const at = (offsetHours: number): string => new Date(dayN + offsetHours * 3600 * 1000).toISOString()

    const dir = join(sessionStateDir, 'sess-overnight')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'workspace.yaml'), 'id: sess-overnight\ncwd: /home/user/testproj\n')
    await writeFile(join(dir, 'events.jsonl'), [
      JSON.stringify({ type: 'session.model_change', timestamp: at(0), data: { newModel: 'claude-sonnet-4-5' } }),
      JSON.stringify({ type: 'assistant.message', timestamp: at(1), data: { messageId: 'msg-1', outputTokens: 25, toolRequests: [] } }),
      JSON.stringify({
        type: 'session.shutdown',
        timestamp: at(19),
        data: {
          shutdownType: 'routine',
          modelMetrics: {
            'claude-sonnet-4-5': {
              requests: { count: 2, cost: 1 },
              usage: { inputTokens: 20000, outputTokens: 25, cacheReadTokens: 17000, cacheWriteTokens: 2400, reasoningTokens: 0 },
            },
          },
        },
      }),
    ].join('\n') + '\n')

    createStoreDb(dbPath)
    insertStoreRow(dbPath, 'sess-overnight', 12000, 10000, 1500, at(1)) // input 500
    insertStoreRow(dbPath, 'sess-overnight', 8000, 7000, 900, at(2))    // input 100

    const inventory = (projects: Awaited<ReturnType<typeof parseAllSessions>>) => {
      const sessions = projects.flatMap(p => p.sessions).filter(s => s.turns.some(t => t.assistantCalls.length > 0))
      const calls = sessions.flatMap(s => s.turns).flatMap(t => t.assistantCalls)
      return {
        sessions: sessions.length,
        input: calls.reduce((s, c) => s + c.usage.inputTokens, 0),
        cacheRead: calls.reduce((s, c) => s + c.usage.cacheReadInputTokens, 0),
        output: calls.reduce((s, c) => s + c.usage.outputTokens, 0),
      }
    }

    // Lifetime: exactly one session, tokens counted once, from the store.
    const lifetime = inventory(await parseAllSessions(undefined, 'copilot'))
    expect(lifetime).toEqual({ sessions: 1, input: 600, cacheRead: 17000, output: 25 })

    // A range covering only the shutdown stamp (rollup path would have put
    // 600/17000 here): the session must contribute nothing at all.
    const shutdownDay = inventory(await parseAllSessions(
      { start: new Date(dayN + 12 * 3600 * 1000), end: new Date(dayN + 36 * 3600 * 1000) }, 'copilot'))
    expect(shutdownDay).toEqual({ sessions: 0, input: 0, cacheRead: 0, output: 0 })

    // The request day carries everything.
    const requestDay = inventory(await parseAllSessions(
      { start: new Date(dayN - 1 * 3600 * 1000), end: new Date(dayN + 12 * 3600 * 1000) }, 'copilot'))
    expect(requestDay).toEqual({ sessions: 1, input: 600, cacheRead: 17000, output: 25 })
  })
})


// ═══════════════════════════════════════════════════════════════════════════
// (sc) month-sharded cache integration for the copilot serve set
// ═══════════════════════════════════════════════════════════════════════════
// The sharded session cache loads only the month shards a ranged query can
// report on — EXCEPT durable providers, which always load in full. Copilot's
// reconciliation depends on that exemption: pairing, residual subtraction and
// project unification run over the complete cached serve set. These tests pin
// the integration at observable seams (adversarial review killed a first,
// vacuous version of each — the scenarios below were rebuilt so that removing
// the guarded line makes each one fail).
describe.skipIf(!isSqliteAvailable())('(sc) month-sharded cache integration for copilot', () => {
  function stubCopilotEnv(sessionStateDir: string, dbPath: string): void {
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STATE_DIR', sessionStateDir)
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STORE_DB', dbPath)
    vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '1')
    vi.stubEnv('CODEBURN_COPILOT_WS_STORAGE_DIR', join(tmpHome, 'no-ws'))
    vi.stubEnv('CODEBURN_COPILOT_GLOBAL_STORAGE_DIR', join(tmpHome, 'no-global'))
    vi.stubEnv('CODEBURN_COPILOT_JETBRAINS_DIR', join(tmpHome, 'no-jb'))
  }

  const copilotCalls = (projects: Awaited<ReturnType<typeof parseAllSessions>>) =>
    projects.flatMap(p => p.sessions.map(s => ({ project: p.project, session: s })))
      .flatMap(({ project, session }) => session.turns.flatMap(t => t.assistantCalls.map(c => ({ project, call: c }))))

  it('serves scope-skippable months through the durable full-load, with and without the persisted stamp', async () => {
    const sessionStateDir = join(tmpHome, 'session-state-sc1')
    await mkdir(sessionStateDir, { recursive: true })
    const dbPath = join(tmpHome, 'session-store-sc1.db')
    stubCopilotEnv(sessionStateDir, dbPath)

    // Journal activity 75 days ago; a store row 5 days ago. 70 days apart is
    // always ≥2 UTC month boundaries, which beats the loader's one-month
    // scope slack — so a 20-day ranged query's scope can never include the
    // journal's month, and only the durable full-load exemption keeps the
    // journal (and its session-derived project label) in the serve set.
    const tsA = new Date(Date.now() - 75 * 24 * 3600 * 1000)
    const tsB = new Date(Date.now() - 5 * 24 * 3600 * 1000)
    const iso = (d: Date, plusSec = 0): string => new Date(d.getTime() + plusSec * 1000).toISOString()

    const dir = join(sessionStateDir, 'sess-sc1')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'workspace.yaml'), 'id: sess-sc1\ncwd: /home/user/journalproj\n')
    await writeFile(join(dir, 'events.jsonl'), [
      JSON.stringify({ type: 'session.model_change', timestamp: iso(tsA), data: { newModel: 'claude-sonnet-4-5' } }),
      JSON.stringify({ type: 'assistant.message', timestamp: iso(tsA, 10), data: { messageId: 'm-a', outputTokens: 30, toolRequests: [] } }),
    ].join('\n') + '\n')
    // A real 75-day-old journal has a 75-day-old mtime, which the ranged
    // parse's own source filter skips — so under a scoped load, the CACHE is
    // the only place its turns can come from. A fresh mtime would let a
    // spurious re-parse mask a broken durable exemption.
    const { utimes } = await import('fs/promises')
    await utimes(join(dir, 'events.jsonl'), tsA, tsA)
    createStoreDb(dbPath)
    insertStoreRow(dbPath, 'sess-sc1', 800, 200, 100, iso(tsA, 12), 0, '/home/user/storeproj')  // month A, pairs with m-a
    insertStoreRow(dbPath, 'sess-sc1', 400, 250, 50, iso(tsB), 0, '/home/user/storeproj')       // month B, store-only

    // Unranged parse: one session label everywhere — the journal-derived one.
    const full = copilotCalls(await parseAllSessions(undefined, 'copilot'))
    expect(full.length).toBeGreaterThan(0)
    expect(new Set(full.map(c => c.project))).toEqual(new Set(['journalproj']))

    // Ranged parse over the last 20 days: the journal's shard is outside the
    // load scope. The durable exemption must still load it, so the in-range
    // store row keeps the session's label instead of falling back to the
    // store's own cwd.
    clearSessionCache()
    clearLoadCacheMemo()
    const ranged = copilotCalls(await parseAllSessions(
      { start: new Date(Date.now() - 20 * 24 * 3600 * 1000), end: new Date() }, 'copilot'))
    expect(ranged.length).toBeGreaterThan(0)
    expect(new Set(ranged.map(c => c.project))).toEqual(new Set(['journalproj']))
    expect(ranged.reduce((s, c) => s + c.call.usage.inputTokens, 0)).toBe(100)  // 400 − 250 − 50

    // The unstamped-section arm of the exemption (DURABLE_PROVIDER_NAMES by
    // name, no envelope flag) is pinned at the loadCache seam in
    // tests/session-cache.test.ts — the parse pipeline has too many
    // self-healing layers to isolate that one predicate end-to-end.
  })

  it('persists an age-out deletion from a seeded, unchanged entry (the deletion itself must dirty the shard)', async () => {
    const { stat } = await import('fs/promises')
    const synthFile = join(tmpHome, 'synth-shard-age.txt')
    await writeFile(synthFile, 'placeholder')
    const st = await stat(synthFile)
    const ts91dAgo = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString()

    // Seed the >90d entry on disk with a MATCHING fingerprint, so the parse
    // performs no re-parse of the file: the age-out delete is the only cache
    // mutation, and only its own dirty mark can persist the deletion.
    // complete: true, so the parse's own completion flip cannot rewrite the
    // envelope — the age-out delete's dirty mark must be the ONLY thing that
    // publishes the deletion.
    await writeCacheOnDisk({
      version: CACHE_VERSION,
      complete: true,
      providers: {
        'test-synthetic': {
          envFingerprint: computeEnvFingerprint('test-synthetic'),
          durable: true,
          files: {
            [synthFile]: {
              fingerprint: { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, sizeBytes: st.size },
              mcpInventory: [],
              turns: [{
                timestamp: ts91dAgo, sessionId: 'synth-shard-old', userMessage: 'old',
                calls: [{
                  provider: 'test-synthetic', model: 'gpt-4o',
                  usage: { inputTokens: 10, outputTokens: 8, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0, cacheCreationOneHourTokens: 0 },
                  costUSD: 0.002, speed: 'standard', timestamp: ts91dAgo,
                  tools: [], bashCommands: [], skills: [], subagentTypes: [],
                  deduplicationKey: 'synth-shard-age-91d',
                }],
              }],
            },
          },
        },
      },
    })

    _synthDurable = true
    // Orphaned: discovery no longer returns the seeded path, which under the
    // orphan-only age-out (#992) is what makes the entry eligible at all.
    _synthSources = []
    // A fresh-timestamped decoy: if the parse wrongly re-reads the file it
    // no longer discovers, this call would serve and break the zero assertion.
    _synthYields = [{
      provider: 'test-synthetic', model: 'gpt-4o',
      inputTokens: 10, outputTokens: 99,
      cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0,
      costUSD: 0.002, tools: [], bashCommands: [],
      timestamp: new Date().toISOString(),
      speed: 'standard',
      deduplicationKey: 'synth-shard-age-decoy',
      userMessage: 'decoy', sessionId: 'synth-shard-decoy',
    }]

    const proj1 = await parseAllSessions(undefined, 'test-synthetic')
    expect(totalOutput(proj1)).toBe(0)
    const disk1 = await readCacheOnDisk()
    expect(disk1.providers['test-synthetic']?.files?.[synthFile]).toBeUndefined()

    clearSessionCache()
    _synthSources = []
    const proj2 = await parseAllSessions(undefined, 'test-synthetic')
    expect(totalOutput(proj2)).toBe(0)
    const disk2 = await readCacheOnDisk()
    expect(disk2.providers['test-synthetic']?.files?.[synthFile]).toBeUndefined()
  })

  it('re-buckets a retained >90d store on an older append without a duplicate shard copy', async () => {
    const sessionStateDir = join(tmpHome, 'session-state-sc3')
    await mkdir(sessionStateDir, { recursive: true })
    const dbPath = join(tmpHome, 'session-store-sc3.db')
    stubCopilotEnv(sessionStateDir, dbPath)

    const at = (daysAgo: number): string => new Date(Date.now() - daysAgo * 24 * 3600 * 1000).toISOString()
    createStoreDb(dbPath)
    insertStoreRow(dbPath, 'sess-ret', 100, 0, 0, at(95))
    insertStoreRow(dbPath, 'sess-ret', 100, 0, 0, at(95))

    const sumInput = (projects: Awaited<ReturnType<typeof parseAllSessions>>) =>
      projects.flatMap(p => p.sessions).flatMap(s => s.turns).flatMap(t => t.assistantCalls)
        .reduce((s, c) => s + c.usage.inputTokens, 0)

    // retainWhilePresent: >90d rows serve and the entry survives its save.
    expect(sumInput(await parseAllSessions(undefined, 'copilot'))).toBe(200)

    // Appending an OLDER row moves the file's oldest-turn month, which
    // re-buckets the shard. The path must live in exactly ONE shard file —
    // a stale copy in the old bucket would resurrect dropped data on a
    // partial load. cacheDirSnapshot exposes raw shard bytes; the merged
    // loadCache view (which collapses duplicates) cannot see this.
    insertStoreRow(dbPath, 'sess-ret', 150, 0, 0, at(130))
    clearSessionCache()
    clearLoadCacheMemo()
    expect(sumInput(await parseAllSessions(undefined, 'copilot'))).toBe(350)

    const snapshot = await cacheDirSnapshot()
    const shardSections = snapshot.split('\n').filter(s => s.length > 0 && !s.startsWith('envelope.json:'))
    // The shards are JSON, so a Windows path appears with its separators escaped.
    const holding = shardSections.filter(s => s.includes(JSON.stringify(dbPath).slice(1, -1)))
    expect(holding).toHaveLength(1)
    const disk = await readCacheOnDisk()
    expect(disk.providers['copilot']!.files[dbPath]!.turns.flatMap(t => t.calls)).toHaveLength(3)
  })

  it.skipIf(process.getuid?.() === 0)('re-parses an incomplete memo instead of extending it to the validated-clean cap', async () => {
    const sessionStateDir = join(tmpHome, 'session-state-sc4')
    await mkdir(sessionStateDir, { recursive: true })
    const dbPath = join(tmpHome, 'session-store-sc4.db')
    stubCopilotEnv(sessionStateDir, dbPath)

    const recent = new Date(Date.now() - 3600 * 1000).toISOString()
    createStoreDb(dbPath)
    insertStoreRow(dbPath, 'sess-vc', 100, 0, 0, recent)

    // Healthy parse, then the store grows and becomes unreadable: the next
    // parse defers and memoizes an INCOMPLETE result.
    await parseAllSessions(undefined, 'copilot')
    insertStoreRow(dbPath, 'sess-vc', 100, 0, 0, recent)
    const unblock = await blockStoreReads(dbPath)
    clearSessionCache()
    await parseAllSessions(undefined, 'copilot')
    expect(isSessionHydrationComplete()).toBe(false)

    // The lock clears with no further filesystem event. Past the 180s TTL a
    // 'clean' validator would extend a COMPLETE memo to five minutes — but an
    // incomplete one promised a retry, so the same call must RE-PARSE, pick
    // up the deferred row, and report complete.
    await unblock()
    setParseReuseValidator(() => 'clean')
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 4 * 60 * 1000)
    try {
      const retried = await parseAllSessions(undefined, 'copilot')
      expect(isSessionHydrationComplete()).toBe(true)
      const input = retried.flatMap(p => p.sessions).flatMap(s => s.turns).flatMap(t => t.assistantCalls)
        .reduce((s, c) => s + c.usage.inputTokens, 0)
      expect(input).toBe(200)
    } finally {
      vi.useRealTimers()
      setParseReuseValidator(null)
    }
  })
})
