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
import { loadCache, saveCache, sessionCachePath } from '../src/session-cache.js'
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
    const { readFile, writeFile: writeFileFs } = await import('fs/promises')
    const cachePath = sessionCachePath()
    const disk = JSON.parse(await readFile(cachePath, 'utf-8')) as { providers: Record<string, { envFingerprint: string }> }
    expect(disk.providers['copilot']).toBeDefined()
    disk.providers['copilot']!.envFingerprint = '0000000000000000'
    await writeFileFs(cachePath, JSON.stringify(disk), 'utf-8')

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
