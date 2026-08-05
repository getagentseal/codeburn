/**
 * Unit tests for sync ledger and OTLP payload builder.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  deriveSpanId,
  deriveTraceId,
  buildOtlpPayload,
  batchCalls,
  getDeviceId,
  deriveDeviceId,
  type CallWithSession,
} from '../src/sync/otlp.js'

import type { ParsedApiCall, TokenUsage } from '../src/types.js'

// ── Helpers ───────────────────────────────────────────────────────────

function makeCall(overrides: Partial<ParsedApiCall> & { deduplicationKey: string }): ParsedApiCall {
  const usage: TokenUsage = {
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
  }
  return {
    provider: 'kiro',
    model: 'claude-sonnet-4-6',
    usage,
    costUSD: 0.05,
    tools: ['Edit', 'Bash'],
    mcpTools: [],
    skills: [],
    subagentTypes: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard',
    timestamp: '2026-07-10T10:00:00.000Z',
    bashCommands: [],
    deduplicationKey: 'test:key:1',
    ...overrides,
  }
}

function makeCallWithSession(overrides?: Partial<ParsedApiCall> & { deduplicationKey?: string }): CallWithSession {
  return {
    call: makeCall({ deduplicationKey: overrides?.deduplicationKey ?? 'test:key:1', ...overrides }),
    sessionId: 'session-abc',
    project: 'my-project',
  }
}

// ── OTLP Span/Trace ID Derivation ────────────────────────────────────

// Fixed key for the golden pins: 64 hex chars, the same shape as the real
// per-install key from privacy-key.ts. A golden pins the FULL encoding
// (domain prefix + HMAC-SHA256 + truncation), so an accidental construction
// change fails loudly instead of silently re-keying every emitted id.
const TEST_KEY = 'c0deb00c'.repeat(8)

describe('deriveSpanId', () => {
  it('returns 16 hex chars', () => {
    const id = deriveSpanId(TEST_KEY, 'cursor:bubble:abc123')
    expect(id).toMatch(/^[0-9a-f]{16}$/)
  })

  it('is deterministic (same input = same output)', () => {
    const a = deriveSpanId(TEST_KEY, 'my:dedup:key')
    const b = deriveSpanId(TEST_KEY, 'my:dedup:key')
    expect(a).toBe(b)
  })

  it('different inputs produce different IDs', () => {
    const a = deriveSpanId(TEST_KEY, 'key-1')
    const b = deriveSpanId(TEST_KEY, 'key-2')
    expect(a).not.toBe(b)
  })

  it('same input under different keys produces different IDs', () => {
    const a = deriveSpanId(TEST_KEY, 'same:key')
    const b = deriveSpanId('f'.repeat(64), 'same:key')
    expect(a).not.toBe(b)
  })

  it('throws on an empty key (decision D1)', () => {
    expect(() => deriveSpanId('', 'x')).toThrow(/privacyKey is required/)
  })

  // GOLDEN — deliberately updated in the keyed-encoding change. The old pin
  // (ec3ca28cceacf381, plain SHA-256 of the dedup key) is retired because the
  // construction it pinned was the dictionary-attackable one. Previously-sent
  // span ids no longer correlate with new ones for the same dedup key — the
  // host-side ledger is keyed by the raw deduplicationKey, not the span id, so
  // re-push filtering is unaffected. If this test fails, revert the encoding
  // change (or design an explicit migration).
  it('golden: HMAC-SHA256(privacyKey, "sync-span:golden-dedup-key") first 8 bytes as hex', () => {
    expect(deriveSpanId(TEST_KEY, 'golden-dedup-key')).toBe('517d8367a13d6124')
  })
})

describe('deriveTraceId', () => {
  it('returns 32 hex chars', () => {
    const id = deriveTraceId(TEST_KEY, 'session-xyz')
    expect(id).toMatch(/^[0-9a-f]{32}$/)
  })

  it('is deterministic', () => {
    const a = deriveTraceId(TEST_KEY, 'session-1')
    const b = deriveTraceId(TEST_KEY, 'session-1')
    expect(a).toBe(b)
  })

  it('same input under different keys produces different IDs', () => {
    const a = deriveTraceId(TEST_KEY, 'session-1')
    const b = deriveTraceId('f'.repeat(64), 'session-1')
    expect(a).not.toBe(b)
  })

  // GOLDEN — deliberately updated with the same keyed-encoding change as the
  // span-id pin above; session ids can embed path-derived material for some
  // providers, so they get the same construction.
  it('golden: HMAC-SHA256(privacyKey, "sync-trace:golden-session-id") first 16 bytes as hex', () => {
    expect(deriveTraceId(TEST_KEY, 'golden-session-id')).toBe('7a3483584b8b6bd1b07d8a347549b1b7')
  })
})

describe('getDeviceId', () => {
  it('returns 16 hex chars', () => {
    const id = getDeviceId()
    expect(id).toMatch(/^[0-9a-f]{16}$/)
  })

  it('is stable across calls', () => {
    expect(getDeviceId()).toBe(getDeviceId())
  })
})

describe('deriveDeviceId', () => {
  it('returns 16 hex chars', () => {
    const id = deriveDeviceId(TEST_KEY, 'host.example', 'alice')
    expect(id).toMatch(/^[0-9a-f]{16}$/)
  })

  it('is deterministic across calls', () => {
    const a = deriveDeviceId(TEST_KEY, 'host.example', 'alice')
    const b = deriveDeviceId(TEST_KEY, 'host.example', 'alice')
    expect(a).toBe(b)
  })

  it('same host/user under different keys produces different IDs', () => {
    const a = deriveDeviceId(TEST_KEY, 'host.example', 'alice')
    const b = deriveDeviceId('f'.repeat(64), 'host.example', 'alice')
    expect(a).not.toBe(b)
  })

  // GOLDEN — deliberately updated with the same keyed-encoding change as the
  // span/trace pins: the old pin (10f57c433adc234f) pinned the colon-joined
  // construction `sync-device:host.example:alice`. The host/username join now
  // uses the same ASCII Unit Separator (0x1f) as core/fingerprint.ts so a
  // username containing ':' cannot forge a host/user boundary.
  it('golden: HMAC-SHA256(privacyKey, "sync-device:" + host + US + username) first 8 bytes as hex', () => {
    expect(deriveDeviceId(TEST_KEY, 'host.example', 'alice')).toBe('f829295f3e76896f')
  })

  // F3: field-boundary collision — ':' is not a valid separator for composite
  // inputs. host 'a' + user 'b:c' must differ from host 'a:b' + user 'c'.
  it('separates host and username with US, not ":" (no boundary collision)', () => {
    expect(deriveDeviceId(TEST_KEY, 'a', 'b:c')).not.toBe(deriveDeviceId(TEST_KEY, 'a:b', 'c'))
  })
})

// ── OTLP Payload Builder ──────────────────────────────────────────────

describe('buildOtlpPayload', () => {
  it('builds valid OTLP structure with one span', () => {
    const payload = buildOtlpPayload([makeCallWithSession()])

    expect(payload.resourceSpans).toHaveLength(1)
    expect(payload.resourceSpans[0]!.resource.attributes).toEqual([
      { key: 'codeburn.device_id', value: { stringValue: expect.stringMatching(/^[0-9a-f]{16}$/) } },
    ])

    const spans = payload.resourceSpans[0]!.scopeSpans[0]!.spans
    expect(spans).toHaveLength(1)

    const span = spans[0]!
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/)
    expect(span.name).toBe('kiro/claude-sonnet-4-6')
    expect(span.startTimeUnixNano).toBe('1783677600000000000')
  })

  it('includes correct span attributes', () => {
    const payload = buildOtlpPayload([makeCallWithSession()])
    const attrs = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes
    const attrMap = Object.fromEntries(attrs.map(a => [a.key, a.value]))

    expect(attrMap['ai.provider']).toEqual({ stringValue: 'kiro' })
    expect(attrMap['ai.model']).toEqual({ stringValue: 'claude-sonnet-4-6' })
    expect(attrMap['ai.input_tokens']).toEqual({ intValue: '1000' })
    expect(attrMap['ai.output_tokens']).toEqual({ intValue: '500' })
    expect(attrMap['ai.cost_usd']).toEqual({ doubleValue: 0.05 })
    expect(attrMap['ai.project']).toEqual({ stringValue: 'my-project' })
    expect(attrMap['ai.speed']).toEqual({ stringValue: 'standard' })
  })

  it('includes tools as array attribute', () => {
    const payload = buildOtlpPayload([makeCallWithSession()])
    const attrs = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes
    const toolsAttr = attrs.find(a => a.key === 'ai.tools')

    expect(toolsAttr).toBeDefined()
    expect(toolsAttr!.value).toEqual({
      arrayValue: { values: [{ stringValue: 'Edit' }, { stringValue: 'Bash' }] },
    })
  })

  it('omits tools attribute when empty', () => {
    const call = makeCallWithSession({ tools: [] as string[] } as any)
    const payload = buildOtlpPayload([call])
    const attrs = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes
    const toolsAttr = attrs.find(a => a.key === 'ai.tools')
    expect(toolsAttr).toBeUndefined()
  })

  it('multiple calls produce multiple spans', () => {
    const calls = [
      makeCallWithSession({ deduplicationKey: 'k1' }),
      makeCallWithSession({ deduplicationKey: 'k2' }),
      makeCallWithSession({ deduplicationKey: 'k3' }),
    ]
    const payload = buildOtlpPayload(calls)
    const spans = payload.resourceSpans[0]!.scopeSpans[0]!.spans
    expect(spans).toHaveLength(3)
    // Each span has a unique spanId
    const ids = new Set(spans.map(s => s.spanId))
    expect(ids.size).toBe(3)
  })

  it('same deduplicationKey produces same spanId (idempotent re-send)', () => {
    const call = makeCallWithSession({ deduplicationKey: 'stable-key' })
    const p1 = buildOtlpPayload([call])
    const p2 = buildOtlpPayload([call])
    expect(p1.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.spanId)
      .toBe(p2.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.spanId)
  })
})

// ── Batching ──────────────────────────────────────────────────────────

describe('batchCalls', () => {
  it('returns single batch when under limit', () => {
    const calls = Array.from({ length: 5 }, (_, i) =>
      makeCallWithSession({ deduplicationKey: `k${i}` })
    )
    const batches = batchCalls(calls, 1000)
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(5)
  })

  it('splits into multiple batches at the limit', () => {
    const calls = Array.from({ length: 2500 }, (_, i) =>
      makeCallWithSession({ deduplicationKey: `k${i}` })
    )
    const batches = batchCalls(calls, 1000)
    expect(batches).toHaveLength(3)
    expect(batches[0]).toHaveLength(1000)
    expect(batches[1]).toHaveLength(1000)
    expect(batches[2]).toHaveLength(500)
  })

  it('empty input returns empty array', () => {
    expect(batchCalls([], 1000)).toEqual([])
  })
})

// ── Ledger ────────────────────────────────────────────────────────────

describe('ledger', () => {
  let tmpDir: string
  const originalHome = process.env.HOME

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'codeburn-ledger-'))
    process.env.HOME = tmpDir
    // env-isolation.ts redirects XDG_CACHE_HOME to a per-worker sandbox shared
    // across tests — the ledger honors XDG, so point it at the per-test dir.
    process.env.XDG_CACHE_HOME = join(tmpDir, '.cache')
  })

  afterEach(async () => {
    process.env.HOME = originalHome
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('readLedger returns empty array when no file', async () => {
    const { readLedger } = await import('../src/sync/ledger.js')
    expect(readLedger()).toEqual([])
  })

  it('writeLedger + readLedger round-trips', async () => {
    const { writeLedger, readLedger } = await import('../src/sync/ledger.js')
    const entries = [
      { key: 'k1', ts: '2026-07-10T00:00:00Z' },
      { key: 'k2', ts: '2026-07-11T00:00:00Z' },
    ]
    writeLedger(entries)
    expect(readLedger()).toEqual(entries)
  })

  it('appendToLedger adds new entries and deduplicates', async () => {
    const { writeLedger, appendToLedger, readLedger } = await import('../src/sync/ledger.js')
    writeLedger([{ key: 'existing', ts: '2026-07-01T00:00:00Z' }])
    appendToLedger([
      { key: 'existing', ts: '2026-07-01T00:00:00Z' },  // duplicate
      { key: 'new-one', ts: '2026-07-10T00:00:00Z' },
    ])
    const result = readLedger()
    expect(result).toHaveLength(2)
    expect(result.map(e => e.key).sort()).toEqual(['existing', 'new-one'])
  })

  it('appendToLedger prunes entries older than 6 months', async () => {
    const { writeLedger, appendToLedger, readLedger } = await import('../src/sync/ledger.js')
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString() // 200 days ago
    writeLedger([{ key: 'old-entry', ts: old }])
    appendToLedger([{ key: 'fresh', ts: new Date().toISOString() }])
    const result = readLedger()
    expect(result.map(e => e.key)).toEqual(['fresh'])
  })

  it('ledgerKeySet returns set of keys', async () => {
    const { writeLedger, ledgerKeySet } = await import('../src/sync/ledger.js')
    writeLedger([
      { key: 'a', ts: '2026-07-01T00:00:00Z' },
      { key: 'b', ts: '2026-07-02T00:00:00Z' },
    ])
    const keys = ledgerKeySet()
    expect(keys.has('a')).toBe(true)
    expect(keys.has('b')).toBe(true)
    expect(keys.has('c')).toBe(false)
  })

  it('clearLedger removes the file and returns count', async () => {
    const { writeLedger, clearLedger, readLedger } = await import('../src/sync/ledger.js')
    writeLedger([{ key: 'x', ts: '2026-07-01T00:00:00Z' }])
    const count = clearLedger()
    expect(count).toBe(1)
    expect(readLedger()).toEqual([])
  })

  it('clearLedger returns 0 when no file', async () => {
    const { clearLedger } = await import('../src/sync/ledger.js')
    expect(clearLedger()).toBe(0)
  })

  it('corrupt ledger file reads as empty (crash-safe recovery)', async () => {
    const { readLedger } = await import('../src/sync/ledger.js')
    const { mkdirSync, writeFileSync } = await import('fs')
    const { join } = await import('path')
    const dir = join(process.env.HOME!, '.cache', 'codeburn')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'sync-ledger.json'), '{"truncated mid-wri')
    expect(readLedger()).toEqual([])
  })

  it('writes are atomic — no .tmp file left behind', async () => {
    const { writeLedger } = await import('../src/sync/ledger.js')
    const { existsSync } = await import('fs')
    const { join } = await import('path')
    writeLedger([{ key: 'a', ts: '2026-07-01T00:00:00Z' }])
    const dir = join(process.env.HOME!, '.cache', 'codeburn')
    expect(existsSync(join(dir, 'sync-ledger.json'))).toBe(true)
    expect(existsSync(join(dir, 'sync-ledger.json.tmp'))).toBe(false)
  })

  it('honors XDG_CACHE_HOME when set', async () => {
    const { writeLedger, readLedger } = await import('../src/sync/ledger.js')
    const { existsSync } = await import('fs')
    const { join } = await import('path')
    const xdgDir = join(process.env.HOME!, 'xdg-cache')
    const original = process.env.XDG_CACHE_HOME
    process.env.XDG_CACHE_HOME = xdgDir
    try {
      writeLedger([{ key: 'xdg-entry', ts: '2026-07-01T00:00:00Z' }])
      expect(existsSync(join(xdgDir, 'codeburn', 'sync-ledger.json'))).toBe(true)
      expect(readLedger().map(e => e.key)).toEqual(['xdg-entry'])
    } finally {
      if (original === undefined) delete process.env.XDG_CACHE_HOME
      else process.env.XDG_CACHE_HOME = original
    }
  })
})

// ── assertHttps (RFC 8252 §8.3) ───────────────────────────────────────

describe('assertHttps', () => {
  it('accepts https URLs', async () => {
    const { assertHttps } = await import('../src/sync/discovery.js')
    expect(() => assertHttps('https://telemetry.example.com', 'Base URL')).not.toThrow()
  })

  it('accepts http on loopback (offline tests, local dev)', async () => {
    const { assertHttps } = await import('../src/sync/discovery.js')
    expect(() => assertHttps('http://127.0.0.1:8080/x', 'Base URL')).not.toThrow()
    expect(() => assertHttps('http://localhost:3000', 'Base URL')).not.toThrow()
    expect(() => assertHttps('http://[::1]:9999', 'Base URL')).not.toThrow()
  })

  it('rejects plain http on non-loopback hosts', async () => {
    const { assertHttps } = await import('../src/sync/discovery.js')
    expect(() => assertHttps('http://telemetry.example.com', 'Base URL')).toThrow(/must use https/)
    expect(() => assertHttps('http://192.168.1.10', 'Issuer')).toThrow(/must use https/)
  })

  it('rejects non-http(s) schemes and garbage', async () => {
    const { assertHttps } = await import('../src/sync/discovery.js')
    expect(() => assertHttps('ftp://example.com', 'Base URL')).toThrow(/must use https/)
    expect(() => assertHttps('not a url', 'Base URL')).toThrow(/not a valid URL/)
  })
})
