// Tests for durable-source monotonic cost behaviour (PR #477 / copilot-otel).
// Five scenarios:
//   (a) file-purge monotonic  — copilot JSONL file deleted → total unchanged
//   (b) OTel-prune monotonic  — OTel DB rows pruned      → total unchanged
//   (c) no double-count       — same source parsed twice  → counted once
//   (d) non-durable evicts    — deleted source for non-durable provider IS removed
//   (e) 90-day age-out        — orphan ≥ 91d old is pruned; ≤ 89d is retained

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRequire } from 'node:module'

import { isSqliteAvailable } from '../src/sqlite.js'
import { clearSessionCache, parseAllSessions } from '../src/parser.js'
import { loadCache, saveCache } from '../src/session-cache.js'
import { renderOverview } from '../src/overview.js'
import type { SessionSource, SessionParser, ParsedProviderCall } from '../src/providers/types.js'

// ── Synthetic provider state ───────────────────────────────────────────────
// Module-level so the vi.mock factory closure captures them by reference and
// tests can mutate them freely without re-creating the mock.
let _synthSources: SessionSource[] = []
let _synthDurable = false
let _synthYields: ParsedProviderCall[] = []

vi.mock('../src/providers/index.js', async (importOriginal) => {
  type Mod = typeof import('../src/providers/index.js')
  const actual = await importOriginal<Mod>()
  return {
    ...actual,
    async discoverAllSessions(filter?: string) {
      // Pass through for specific non-synthetic providers; inject synthetic
      // sources only when filter is undefined/'all'/'test-synthetic'.
      if (filter && filter !== 'all' && filter !== 'test-synthetic') {
        return actual.discoverAllSessions(filter)
      }
      const base = filter === 'test-synthetic'
        ? []
        : await actual.discoverAllSessions(filter)
      return [..._synthSources, ...base]
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
  const lines = [
    JSON.stringify({ type: 'session.model_change', timestamp: '2026-05-01T10:00:00Z', data: { newModel: 'gpt-4.1' } }),
    JSON.stringify({ type: 'user.message', timestamp: '2026-05-01T10:00:05Z', data: { content: 'hello', interactionId: 'int-1' } }),
    JSON.stringify({ type: 'assistant.message', timestamp: '2026-05-01T10:00:10Z', data: { messageId: 'msg-1', outputTokens, interactionId: 'int-1', toolRequests: [] } }),
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

  process.env['HOME']               = tmpHome
  process.env['CODEBURN_CACHE_DIR'] = tmpCache

  // Reset synthetic provider state
  _synthSources = []
  _synthDurable = false
  _synthYields  = []
})

afterEach(async () => {
  clearSessionCache()
  vi.unstubAllEnvs()

  _synthSources = []

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
  it('prunes an orphaned cache entry whose newest call is 91 days old', async () => {
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

    // First parse: cached with 91d-old timestamp → immediately pruned by 90-day check
    const proj1 = await parseAllSessions(undefined, 'test-synthetic')
    expect(totalOutput(proj1)).toBe(0)  // pruned right away

    // Confirm: entry is not in the persistent cache after first parse
    clearSessionCache()
    _synthSources = []  // no longer discovered
    const proj2 = await parseAllSessions(undefined, 'test-synthetic')
    expect(totalOutput(proj2)).toBe(0)
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

describe('estimated provider cost propagation', () => {
  it('marks a session built from an estimated provider call downstream', async () => {
    const synthFile = join(tmpHome, 'synth-estimated.txt')
    await writeFile(synthFile, 'placeholder')

    _synthSources = [{ path: synthFile, project: 'test', provider: 'test-synthetic' }]
    _synthYields = [{
      provider: 'test-synthetic', model: 'gpt-4o',
      inputTokens: 100, outputTokens: 50,
      cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0,
      costUSD: 0.12, costIsEstimated: true, tools: [], bashCommands: [],
      timestamp: '2026-07-16T10:00:00.000Z',
      speed: 'standard', deduplicationKey: 'synth-estimated-cost',
      userMessage: 'estimated cost', sessionId: 'synth-estimated-session',
    }]

    const projects = await parseAllSessions(undefined, 'test-synthetic')
    const session = projects[0]?.sessions[0]

    const overview = renderOverview(projects, { label: 'Today', color: false })
    expect(overview.split('\n').find(line => line.includes('Cost'))).toContain('~')
    expect(session?.estimatedCostUSD).toBe(0.12)
  })

  it('survives a session-cache round-trip', async () => {
    const synthFile = join(tmpHome, 'synth-estimated-cached.txt')
    await writeFile(synthFile, 'placeholder')

    _synthDurable = false
    _synthSources = [{ path: synthFile, project: 'test', provider: 'test-synthetic' }]
    _synthYields = [{
      provider: 'test-synthetic', model: 'gpt-4o',
      inputTokens: 100, outputTokens: 50,
      cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0,
      costUSD: 0.12, costIsEstimated: true, tools: [], bashCommands: [],
      timestamp: '2026-07-16T10:00:00.000Z',
      speed: 'standard', deduplicationKey: 'synth-estimated-roundtrip',
      userMessage: 'estimated cost', sessionId: 'synth-estimated-cached-session',
    }]

    // First parse populates the persistent cache from the provider.
    const proj1 = await parseAllSessions(undefined, 'test-synthetic')
    expect(proj1[0]?.sessions[0]?.estimatedCostUSD).toBe(0.12)

    // Second parse must serve the same session from the cache (the provider
    // yields nothing), and the estimated portion must survive the round-trip.
    clearSessionCache()
    _synthYields = []
    const proj2 = await parseAllSessions(undefined, 'test-synthetic')
    expect(proj2[0]?.sessions[0]?.estimatedCostUSD).toBe(0.12)
  })
})
