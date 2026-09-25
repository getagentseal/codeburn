/**
 * Unit tests for sync push orchestration (src/sync/push.ts).
 *
 * Covers the review gaps: partial-success handling, 429 rate limiting,
 * 401 auth rejection, 5xx server errors, and the flatten→filter pipeline.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createServer, type Server } from 'http'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import type { ParsedApiCall, TokenUsage, ProjectSummary } from '../src/types.js'
import type { CallWithSession } from '../src/sync/otlp.js'
import { setHome } from './setup/home.js'

// ── Helpers ───────────────────────────────────────────────────────────

function makeUsage(): TokenUsage {
  return {
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
  }
}

function makeCall(key: string, costUSD = 0.01): ParsedApiCall {
  return {
    provider: 'test',
    model: 'test-model',
    usage: makeUsage(),
    costUSD,
    tools: [],
    mcpTools: [],
    skills: [],
    subagentTypes: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard',
    timestamp: '2026-07-10T10:00:00.000Z',
    bashCommands: [],
    deduplicationKey: key,
  }
}

function makeCws(key: string, costUSD = 0.01): CallWithSession {
  return { call: makeCall(key, costUSD), sessionId: 'sess-1', project: 'proj-1' }
}

/** Minimal mock OTLP server with scriptable responses per request. */
type MockResponse = { status: number; body?: unknown; headers?: Record<string, string> }

function startMockOtlp(responses: MockResponse[]): Promise<{
  url: string
  server: Server
  requests: Array<{ auth: string | undefined; body: unknown }>
}> {
  const requests: Array<{ auth: string | undefined; body: unknown }> = []
  let idx = 0

  return new Promise(resolve => {
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', c => { raw += c })
      req.on('end', () => {
        requests.push({ auth: req.headers.authorization, body: JSON.parse(raw || '{}') })
        const r = responses[Math.min(idx, responses.length - 1)]!
        idx++
        res.writeHead(r.status, { 'Content-Type': 'application/json', ...r.headers })
        res.end(r.body !== undefined ? JSON.stringify(r.body) : '{}')
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({ url: `http://127.0.0.1:${addr.port}/v1/traces`, server, requests })
    })
  })
}

// ── Test env: isolated HOME so ledger writes go to a temp dir ─────────

let tmpDir: string
const originalHome = process.env.HOME

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'codeburn-push-'))
  setHome(tmpDir)
  // env-isolation.ts redirects XDG_CACHE_HOME to a per-worker sandbox shared
  // across tests — the ledger honors XDG, so point it at the per-test dir.
  process.env.XDG_CACHE_HOME = join(tmpDir, '.cache')
  // The ledger prunes entries older than six months; the fixtures are July 2026.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-07-15T12:00:00Z'))
})

afterEach(async () => {
  vi.useRealTimers()
  setHome(originalHome)
  await rm(tmpDir, { recursive: true, force: true })
})

// ── collectUnsentCalls ────────────────────────────────────────────────

describe('collectUnsentCalls', () => {
  it('flattens projects → sessions → turns → calls', async () => {
    const { collectUnsentCalls } = await import('../src/sync/push.js')

    const projects = [{
      project: 'proj-a',
      sessions: [{
        sessionId: 's1',
        turns: [
          { assistantCalls: [makeCall('k1'), makeCall('k2')] },
          { assistantCalls: [makeCall('k3')] },
        ],
      }],
    }] as unknown as ProjectSummary[]

    const { allCalls, unsent } = collectUnsentCalls(projects)
    expect(allCalls).toHaveLength(3)
    expect(unsent).toHaveLength(3)
    expect(allCalls[0]!.project).toBe('proj-a')
    expect(allCalls[0]!.sessionId).toBe('s1')
  })

  // #988: copilot is the only producer whose SERVED calls change between
  // passes — a residual shrinks as store rows land, a rollup is dropped once
  // rows cover its leg, an unpaired row becomes supplementary when its journal
  // call appears. The ledger is append-once and the span id derives from the
  // same key, so a value sent at an intermediate state is a permanent
  // receiver-side over-count. Hold the session until it can no longer change.
  it('holds a copilot session whose reconciliation can still change', async () => {
    const { collectUnsentCalls, RECONCILE_SETTLE_MS } = await import('../src/sync/push.js')

    const now = Date.parse('2026-07-10T12:00:00.000Z')
    const at = (msAgo: number) => new Date(now - msAgo).toISOString()
    const copilotCall = (key: string, ts: string) => ({ ...makeCall(key), provider: 'copilot', timestamp: ts })

    const projects = [{
      project: 'p',
      sessions: [
        {
          sessionId: 'fresh',
          turns: [{ assistantCalls: [
            copilotCall('copilot-store:fresh:1:aa', at(RECONCILE_SETTLE_MS * 2)),
            copilotCall('copilot:fresh:shutdown-residual:m:1', at(60_000)),
          ] }],
        },
        {
          sessionId: 'settled',
          turns: [{ assistantCalls: [copilotCall('copilot:settled:shutdown:m:1', at(RECONCILE_SETTLE_MS * 2))] }],
        },
      ],
    }] as unknown as ProjectSummary[]

    const { allCalls, unsent, held } = collectUnsentCalls(projects, now)
    expect(allCalls).toHaveLength(3)
    // The whole unsettled session is held, including its old row: holding only
    // the residual would still ship a row whose PAIRING can still flip.
    expect(held.map(h => h.call.deduplicationKey).sort())
      .toEqual(['copilot-store:fresh:1:aa', 'copilot:fresh:shutdown-residual:m:1'])
    expect(unsent.map(u => u.call.deduplicationKey)).toEqual(['copilot:settled:shutdown:m:1'])

    // A holdback, not a drop: once the window passes it pushes normally.
    const later = collectUnsentCalls(projects, now + RECONCILE_SETTLE_MS)
    expect(later.held).toHaveLength(0)
    expect(later.unsent).toHaveLength(3)
  })

  // The forward-only half of #988. This release moves copilot input/cache from
  // one shutdown-rollup span per (session, model) to one span per request.
  // Locally that is a replacement; at an append-once receiver it is an
  // addition, and there is no retraction for a usage span. So a session whose
  // rollup is already in the ledger is frozen at what was sent: the receiver
  // keeps the old, lossier number rather than a permanently doubled one.
  it('freezes the reconciliation output of a session already synced as a rollup', async () => {
    const { collectUnsentCalls, RECONCILE_SETTLE_MS } = await import('../src/sync/push.js')
    const { writeLedger } = await import('../src/sync/ledger.js')

    const now = Date.parse('2026-07-10T12:00:00.000Z')
    const settled = new Date(now - RECONCILE_SETTLE_MS * 2).toISOString()
    const copilotCall = (key: string) => ({ ...makeCall(key), provider: 'copilot', timestamp: settled })

    // Session S was synced by a previous version: its rollup span is out.
    writeLedger([{ key: 'copilot:S:shutdown:claude-sonnet-4-5:1', ts: settled }])

    const projects = [{
      project: 'p',
      sessions: [
        {
          sessionId: 'S',
          turns: [{ assistantCalls: [
            copilotCall('copilot-store:S:1:aa'),
            copilotCall('copilot:S:shutdown-residual:claude-sonnet-4-5:0'),
            // Per-turn output: never part of the rollup, never reconciled.
            copilotCall('copilot:S:msg-1'),
          ] }],
        },
        {
          sessionId: 'T',
          turns: [{ assistantCalls: [copilotCall('copilot-store:T:1:bb')] }],
        },
      ],
    }] as unknown as ProjectSummary[]

    const { unsent, held, frozen } = collectUnsentCalls(projects, now)

    expect(frozen.map(f => f.call.deduplicationKey).sort())
      .toEqual(['copilot-store:S:1:aa', 'copilot:S:shutdown-residual:claude-sonnet-4-5:0'])
    // S's per-turn call still syncs — it carries output the rollup never held.
    // T was never synced, so it takes the per-row path in full.
    expect(unsent.map(u => u.call.deduplicationKey).sort())
      .toEqual(['copilot-store:T:1:bb', 'copilot:S:msg-1'])
    expect(held).toHaveLength(0)

    // Frozen means frozen: no later push releases it.
    const later = collectUnsentCalls(projects, now + RECONCILE_SETTLE_MS * 10)
    expect(later.frozen).toHaveLength(2)
  })

  // B-1: the freeze has to work in BOTH directions. Rows sync first; at the
  // 90-day durable age-out the cached rows are pruned, the rollup stops being
  // dropped and serves again under a key that was never sent. The session is
  // long past settle, so without a symmetric freeze it pushes an aggregate on
  // top of the per-request spans the receiver already has.
  it('freezes the rollup of a session already synced as per-request rows', async () => {
    const { collectUnsentCalls, RECONCILE_SETTLE_MS } = await import('../src/sync/push.js')
    const { writeLedger } = await import('../src/sync/ledger.js')

    const now = Date.parse('2026-07-10T12:00:00.000Z')
    const old = new Date(now - RECONCILE_SETTLE_MS * 100).toISOString()
    const copilotCall = (key: string) => ({ ...makeCall(key), provider: 'copilot', timestamp: old })

    // Session S synced its rows. Then they aged out of the cache.
    writeLedger([{ key: 'copilot-store:S:1:aa', ts: old }])

    const projects = [{
      project: 'p',
      sessions: [{
        sessionId: 'S',
        turns: [{ assistantCalls: [
          copilotCall('copilot:S:shutdown:claude-sonnet-4-5:1'),
          copilotCall('copilot:S:shutdown-residual:claude-sonnet-4-5:1752000000000'),
          copilotCall('copilot:S:msg-1'),          // per-turn output: neither shape
          copilotCall('copilot-store:S:2:bb'),     // a row that survived: same shape, still sends
        ] }],
      }],
    }] as unknown as ProjectSummary[]

    const { unsent, held, frozen } = collectUnsentCalls(projects, now)

    // Only the RAW rollup is frozen. The residual is reconciled output, the
    // same shape as the rows that were sent, and rows+residual are disjoint by
    // construction — so it is additive, not a second copy of anything.
    expect(frozen.map(f => f.call.deduplicationKey))
      .toEqual(['copilot:S:shutdown:claude-sonnet-4-5:1'])
    expect(unsent.map(u => u.call.deduplicationKey).sort()).toEqual([
      'copilot-store:S:2:bb',
      'copilot:S:msg-1',
      'copilot:S:shutdown-residual:claude-sonnet-4-5:1752000000000',
    ])
    expect(held).toHaveLength(0)

    // Frozen means frozen.
    expect(collectUnsentCalls(projects, now + RECONCILE_SETTLE_MS * 10).frozen).toHaveLength(1)
  })

  // B-2: an undatable session was held forever while the CLI promised it would
  // "push once it settles". Nothing can ever settle it, so send it.
  it('sends a session whose timestamps are all unparseable instead of holding it forever', async () => {
    const { collectUnsentCalls } = await import('../src/sync/push.js')

    const now = Date.parse('2026-07-10T12:00:00.000Z')
    const broken = (key: string) => ({ ...makeCall(key), provider: 'copilot', timestamp: 'not-a-date' })

    const projects = [{
      project: 'p',
      sessions: [{ sessionId: 'N', turns: [{ assistantCalls: [broken('copilot-store:N:1:aa')] }] }],
    }] as unknown as ProjectSummary[]

    const { unsent, held } = collectUnsentCalls(projects, now)
    expect(held).toHaveLength(0)
    expect(unsent.map(u => u.call.deduplicationKey)).toEqual(['copilot-store:N:1:aa'])
  })

  it('still holds a session where only SOME stamps are unparseable and the rest are recent', async () => {
    const { collectUnsentCalls } = await import('../src/sync/push.js')

    const now = Date.parse('2026-07-10T12:00:00.000Z')
    const cp = (key: string, timestamp: string) => ({ ...makeCall(key), provider: 'copilot', timestamp })

    const projects = [{
      project: 'p',
      sessions: [{
        sessionId: 'M',
        turns: [{ assistantCalls: [
          cp('copilot-store:M:1:aa', 'not-a-date'),
          cp('copilot-store:M:2:bb', new Date(now - 60_000).toISOString()),
        ] }],
      }],
    }] as unknown as ProjectSummary[]

    const { unsent, held } = collectUnsentCalls(projects, now)
    expect(unsent).toHaveLength(0)
    expect(held).toHaveLength(2)
  })

  // B-3: a stamp far in the future is broken data, not proof the session is
  // live. One of them must not hold a month-old session hostage.
  it('ignores an implausibly future stamp when deciding whether a session settled', async () => {
    const { collectUnsentCalls } = await import('../src/sync/push.js')

    const now = Date.parse('2026-07-10T12:00:00.000Z')
    const cp = (key: string, timestamp: string) => ({ ...makeCall(key), provider: 'copilot', timestamp })
    const thirtyDaysAgo = new Date(now - 30 * 24 * 3600 * 1000).toISOString()
    const yearAhead = new Date(now + 365 * 24 * 3600 * 1000).toISOString()

    const projects = [{
      project: 'p',
      sessions: [{
        sessionId: 'F',
        turns: [{ assistantCalls: [
          cp('copilot-store:F:1:aa', thirtyDaysAgo),
          cp('copilot-store:F:2:bb', yearAhead),
        ] }],
      }],
    }] as unknown as ProjectSummary[]

    const { unsent, held } = collectUnsentCalls(projects, now)
    expect(held).toHaveLength(0)
    expect(unsent).toHaveLength(2)

    // But ordinary clock skew inside the grace window still counts as live.
    const skewed = [{
      project: 'p',
      sessions: [{
        sessionId: 'G',
        turns: [{ assistantCalls: [
          cp('copilot-store:G:1:aa', thirtyDaysAgo),
          cp('copilot-store:G:2:bb', new Date(now + 60_000).toISOString()),
        ] }],
      }],
    }] as unknown as ProjectSummary[]
    expect(collectUnsentCalls(skewed, now).held).toHaveLength(2)
  })

  it('never holds a provider whose served calls are immutable', async () => {
    const { collectUnsentCalls } = await import('../src/sync/push.js')

    const now = Date.parse('2026-07-10T12:00:00.000Z')
    const projects = [{
      project: 'p',
      sessions: [{
        sessionId: 's1',
        turns: [{ assistantCalls: [{ ...makeCall('k1'), timestamp: new Date(now - 1000).toISOString() }] }],
      }],
    }] as unknown as ProjectSummary[]

    const { unsent, held } = collectUnsentCalls(projects, now)
    expect(held).toHaveLength(0)
    expect(unsent).toHaveLength(1)
  })

  it('filters out calls already in the ledger', async () => {
    const { collectUnsentCalls } = await import('../src/sync/push.js')
    const { writeLedger } = await import('../src/sync/ledger.js')

    writeLedger([{ key: 'k1', ts: '2026-07-10T00:00:00Z' }])

    const projects = [{
      project: 'p',
      sessions: [{
        sessionId: 's1',
        turns: [{ assistantCalls: [makeCall('k1'), makeCall('k2')] }],
      }],
    }] as unknown as ProjectSummary[]

    const { allCalls, unsent } = collectUnsentCalls(projects)
    expect(allCalls).toHaveLength(2)
    expect(unsent).toHaveLength(1)
    expect(unsent[0]!.call.deduplicationKey).toBe('k2')
  })
})

// ── sendBatches: success path ─────────────────────────────────────────

describe('sendBatches — success', () => {
  it('sends all batches, ledgers all calls, accumulates cost', async () => {
    const { sendBatches } = await import('../src/sync/push.js')
    const { readLedger } = await import('../src/sync/ledger.js')

    const { url, server, requests } = await startMockOtlp([{ status: 200, body: {} }])
    try {
      const batches = [
        [makeCws('a', 0.10), makeCws('b', 0.20)],
        [makeCws('c', 0.30)],
      ]
      const result = await sendBatches({ endpoint: url, accessToken: 'tok-123', batches })

      expect(result.outcome).toBe('complete')
      expect(result.totalSent).toBe(3)
      expect(result.totalRejected).toBe(0)
      expect(result.totalCostSent).toBeCloseTo(0.60)

      // Two HTTP requests with Bearer auth
      expect(requests).toHaveLength(2)
      expect(requests[0]!.auth).toBe('Bearer tok-123')

      // All three keys ledgered
      const keys = readLedger().map(e => e.key).sort()
      expect(keys).toEqual(['a', 'b', 'c'])
    } finally {
      server.close()
    }
  })
})

// ── sendBatches: partial success ──────────────────────────────────────

describe('sendBatches — partial success', () => {
  it('does NOT ledger a partially-rejected batch (whole batch retries)', async () => {
    const { sendBatches } = await import('../src/sync/push.js')
    const { readLedger } = await import('../src/sync/ledger.js')

    const { url, server } = await startMockOtlp([
      { status: 200, body: { partialSuccess: { rejectedSpans: 1 } } }, // batch 1: partial
      { status: 200, body: {} },                                       // batch 2: full success
    ])
    try {
      const batches = [
        [makeCws('p1'), makeCws('p2')],  // partially rejected — must NOT ledger
        [makeCws('ok1')],                // fully accepted — must ledger
      ]
      const result = await sendBatches({ endpoint: url, accessToken: 't', batches })

      expect(result.outcome).toBe('complete')
      expect(result.totalSent).toBe(1)
      expect(result.totalRejected).toBe(1)

      const keys = readLedger().map(e => e.key)
      expect(keys).toEqual(['ok1'])           // p1/p2 absent → they retry next push
    } finally {
      server.close()
    }
  })
})

// ── sendBatches: error paths ──────────────────────────────────────────

describe('sendBatches — errors', () => {
  it('401 → auth-rejected, stops immediately, ledgers nothing further', async () => {
    const { sendBatches } = await import('../src/sync/push.js')
    const { readLedger } = await import('../src/sync/ledger.js')

    const { url, server, requests } = await startMockOtlp([{ status: 401 }])
    try {
      const result = await sendBatches({
        endpoint: url, accessToken: 'bad',
        batches: [[makeCws('x')], [makeCws('y')]],
      })
      expect(result.outcome).toBe('auth-rejected')
      expect(result.httpStatus).toBe(401)
      expect(result.totalSent).toBe(0)
      expect(requests).toHaveLength(1)         // second batch never sent
      expect(readLedger()).toEqual([])
    } finally {
      server.close()
    }
  })

  it('429 → waits Retry-After and retries the same batch until it succeeds', async () => {
    const { sendBatches } = await import('../src/sync/push.js')
    const { readLedger } = await import('../src/sync/ledger.js')

    const sleeps: number[] = []
    const { url, server, requests } = await startMockOtlp([
      { status: 200, body: {} },                            // batch 1: ok
      { status: 429, headers: { 'Retry-After': '2' } },     // batch 2: limited
      { status: 200, body: {} },                            // batch 2 retry: ok
      { status: 200, body: {} },                            // batch 3: ok
    ])
    try {
      const result = await sendBatches({
        endpoint: url, accessToken: 't',
        batches: [[makeCws('sent')], [makeCws('limited')], [makeCws('third')]],
        sleep: async ms => { sleeps.push(ms) },
      })
      expect(result.outcome).toBe('complete')
      expect(result.totalSent).toBe(3)                     // ALL batches sent
      expect(result.totalWaitMs).toBe(2000)
      expect(sleeps).toEqual([2000])                       // honored Retry-After: 2
      expect(requests).toHaveLength(4)                     // 3 batches + 1 retry
      expect(readLedger().map(e => e.key).sort()).toEqual(['limited', 'sent', 'third'])
    } finally {
      server.close()
    }
  })

  it('persistent 429 → gives up after max retries, remaining deferred', async () => {
    const { sendBatches } = await import('../src/sync/push.js')
    const { readLedger } = await import('../src/sync/ledger.js')

    const sleeps: number[] = []
    const { url, server, requests } = await startMockOtlp([
      { status: 429, headers: { 'Retry-After': '1' } },     // every request limited
    ])
    try {
      const result = await sendBatches({
        endpoint: url, accessToken: 't',
        batches: [[makeCws('stuck')], [makeCws('never')]],
        sleep: async ms => { sleeps.push(ms) },
        max429Retries: 2,
      })
      expect(result.outcome).toBe('rate-limited')
      expect(result.totalSent).toBe(0)
      expect(sleeps).toEqual([1000, 1000])                 // 2 retries = 2 waits
      expect(requests).toHaveLength(3)                     // initial + 2 retries; 2nd batch never sent
      expect(readLedger()).toEqual([])
    } finally {
      server.close()
    }
  })

  it('429 without Retry-After uses 5s default; wait capped at maxWaitMs', async () => {
    const { sendBatches } = await import('../src/sync/push.js')

    const sleeps: number[] = []
    const { url, server } = await startMockOtlp([
      { status: 429 },                                      // no Retry-After → 5s default
      { status: 429, headers: { 'Retry-After': '999' } },   // 999s → capped
      { status: 200, body: {} },
    ])
    try {
      const result = await sendBatches({
        endpoint: url, accessToken: 't',
        batches: [[makeCws('x')]],
        sleep: async ms => { sleeps.push(ms) },
        maxWaitMs: 10_000,
      })
      expect(result.outcome).toBe('complete')
      expect(sleeps).toEqual([5000, 10_000])                // default, then capped
    } finally {
      server.close()
    }
  })

  it('5xx → server-error, batch not ledgered, remaining deferred', async () => {
    const { sendBatches } = await import('../src/sync/push.js')
    const { readLedger } = await import('../src/sync/ledger.js')

    const { url, server, requests } = await startMockOtlp([{ status: 503 }])
    try {
      const result = await sendBatches({
        endpoint: url, accessToken: 't',
        batches: [[makeCws('a')], [makeCws('b')]],
      })
      expect(result.outcome).toBe('server-error')
      expect(result.httpStatus).toBe(503)
      expect(result.totalSent).toBe(0)
      expect(requests).toHaveLength(1)
      expect(readLedger()).toEqual([])
    } finally {
      server.close()
    }
  })

  it('retry after failure re-sends the unledgered calls (idempotent recovery)', async () => {
    const { sendBatches, collectUnsentCalls } = await import('../src/sync/push.js')

    // First attempt: server error → nothing ledgered
    const first = await startMockOtlp([{ status: 500 }])
    try {
      await sendBatches({ endpoint: first.url, accessToken: 't', batches: [[makeCws('r1')]] })
    } finally {
      first.server.close()
    }

    // Simulate the next push: the same call is still unsent
    const projects = [{
      project: 'p',
      sessions: [{ sessionId: 's1', turns: [{ assistantCalls: [makeCall('r1')] }] }],
    }] as unknown as ProjectSummary[]
    const { unsent } = collectUnsentCalls(projects)
    expect(unsent).toHaveLength(1)

    // Second attempt succeeds and ledgers
    const second = await startMockOtlp([{ status: 200, body: {} }])
    try {
      const result = await sendBatches({ endpoint: second.url, accessToken: 't', batches: [unsent] })
      expect(result.outcome).toBe('complete')
      expect(result.totalSent).toBe(1)
    } finally {
      second.server.close()
    }

    // Now filtered out
    const { unsent: after } = collectUnsentCalls(projects)
    expect(after).toHaveLength(0)
  })
})

// ── MAX_PER_PUSH safety valve ─────────────────────────────────────────

describe('MAX_PER_PUSH', () => {
  it('is a 50K safety valve (pushes run to completion, not capped at 5K)', async () => {
    const { MAX_PER_PUSH } = await import('../src/sync/push.js')
    expect(MAX_PER_PUSH).toBe(50_000)
  })
})

// ── parseRetryAfterMs ─────────────────────────────────────────────────

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds', async () => {
    const { parseRetryAfterMs } = await import('../src/sync/push.js')
    expect(parseRetryAfterMs('30')).toBe(30_000)
    expect(parseRetryAfterMs('0')).toBe(0)
  })

  it('parses HTTP-date', async () => {
    const { parseRetryAfterMs } = await import('../src/sync/push.js')
    const future = new Date(Date.now() + 10_000).toUTCString()
    const ms = parseRetryAfterMs(future)
    expect(ms).toBeGreaterThan(8_000)
    expect(ms).toBeLessThanOrEqual(10_500)
  })

  it('past HTTP-date clamps to 0', async () => {
    const { parseRetryAfterMs } = await import('../src/sync/push.js')
    const past = new Date(Date.now() - 60_000).toUTCString()
    expect(parseRetryAfterMs(past)).toBe(0)
  })

  it('returns null for missing or garbage values', async () => {
    const { parseRetryAfterMs } = await import('../src/sync/push.js')
    expect(parseRetryAfterMs(null)).toBeNull()
    expect(parseRetryAfterMs('soon™')).toBeNull()
    expect(parseRetryAfterMs('-5')).toBeNull()
  })
})
