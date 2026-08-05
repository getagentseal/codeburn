import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../src/cache-refresh-lock.js', () => ({
  acquireCacheRefreshLock: async () => ({ outcome: 'timed-out' as const }),
}))

import { clearSessionCache, isSessionHydrationComplete, parseAllSessions } from '../src/parser.js'
import { getDashboardScanRange } from '../src/dashboard.js'

let cacheDir: string
const originalFetch = globalThis.fetch
const originalKey = process.env.AI_GATEWAY_API_KEY
const originalCacheDir = process.env.CODEBURN_CACHE_DIR

function reportRow(day: string, cost: number) {
  return {
    day,
    model: 'openai/gpt-4o',
    total_cost: cost,
    input_tokens: 1000,
    output_tokens: 500,
    request_count: 3,
  }
}

function totalCost(projects: Awaited<ReturnType<typeof parseAllSessions>>): number {
  return projects.reduce((sum, p) => sum + p.totalCostUSD, 0)
}

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'cb-network-readonly-'))
  process.env['CODEBURN_CACHE_DIR'] = cacheDir
  process.env['AI_GATEWAY_API_KEY'] = 'test-key'
  clearSessionCache()
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (originalKey === undefined) delete process.env.AI_GATEWAY_API_KEY
  else process.env.AI_GATEWAY_API_KEY = originalKey
  if (originalCacheDir === undefined) delete process.env.CODEBURN_CACHE_DIR
  else process.env.CODEBURN_CACHE_DIR = originalCacheDir
  clearSessionCache()
  vi.restoreAllMocks()
  await rm(cacheDir, { recursive: true, force: true })
})

// The file-backed completeness rule is "a read-only run under which nothing
// changed is equivalent to a full parse". A network-backed source (Vercel AI
// Gateway) has no file to fingerprint, so a read-only run has NO WAY to
// establish "nothing changed": the report lives on the API and moves without
// touching any local mtime, and the read-only path deliberately never
// re-fetches. Unverifiable means partial — a read-only serve of a network
// source must never let the parse report a complete hydration, or a timed-out
// refresh would finalize daily history off network totals frozen at an old
// report (the same freeze this fix bounds for file-backed sources).
describe('network-backed source on the read-only path', () => {
  it('serves the cached rows but never tags the parse complete when the report has moved on', async () => {
    // Relative so the rolling six-month dashboard window always contains it.
    const day = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ results: [reportRow(day, 12.34)] }),
    }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    // Cold first parse: no lock contention, so the report is fetched, the rows
    // are cached, and the hydration is complete.
    const range = getDashboardScanRange('week', null, null)
    const first = await parseAllSessions(range, 'vercel-gateway')
    expect(totalCost(first)).toBeCloseTo(12.34, 2)
    expect(isSessionHydrationComplete(first)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // The gateway now reports newer totals. A timed-out refresh serves the
    // prior snapshot — and the stale serve must report an incomplete hydration,
    // exactly like a changed file on the file-backed path.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [reportRow(day, 99.99)] }),
    })
    clearSessionCache()
    const stale = await parseAllSessions(range, 'vercel-gateway')
    expect(totalCost(stale)).toBeCloseTo(12.34, 2)
    // The snapshot is served, never re-fetched, while the lock is unavailable.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(isSessionHydrationComplete(stale)).toBe(false)
  })

  it('stays incomplete even when the snapshot happens to match the live report', async () => {
    const day = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ results: [reportRow(day, 12.34)] }),
    }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const range = getDashboardScanRange('week', null, null)
    await parseAllSessions(range, 'vercel-gateway')

    // The API has NOT moved on — the report still says 12.34. The read-only
    // serve is still unverifiable: there is no file whose fingerprint proves
    // the cached rows are current, so it must not contribute to a complete
    // tag. (The file-backed path can make that proof; the network path can't.)
    clearSessionCache()
    const stale = await parseAllSessions(range, 'vercel-gateway')
    expect(totalCost(stale)).toBeCloseTo(12.34, 2)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(isSessionHydrationComplete(stale)).toBe(false)
  })
})
