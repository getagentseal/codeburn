import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { fetchVercelGatewayReport, vercelGateway } from '../../src/providers/vercel-gateway.js'
import { parseAllSessions, clearSessionCache } from '../../src/parser.js'
import { getDashboardScanRange } from '../../src/dashboard.js'

describe('vercel-gateway provider', () => {
  const originalFetch = globalThis.fetch
  const originalKey = process.env.AI_GATEWAY_API_KEY

  beforeEach(() => {
    process.env.AI_GATEWAY_API_KEY = 'test-key'
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.AI_GATEWAY_API_KEY
    else process.env.AI_GATEWAY_API_KEY = originalKey
    vi.restoreAllMocks()
  })

  it('discovers a session when API key is set', async () => {
    const sessions = await vercelGateway.discoverSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.provider).toBe('vercel-gateway')
  })

  it('returns empty discovery without API key', async () => {
    delete process.env.AI_GATEWAY_API_KEY
    delete process.env.VERCEL_OIDC_TOKEN
    const sessions = await vercelGateway.discoverSessions()
    expect(sessions).toEqual([])
  })

  it('maps report rows to parsed calls', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        results: [{
          day: '2026-06-01',
          model: 'anthropic/claude-sonnet-4.6',
          total_cost: 1.25,
          input_tokens: 1000,
          output_tokens: 200,
          request_count: 3,
        }],
      }),
    })) as typeof fetch

    const range = {
      start: new Date('2026-06-01T00:00:00.000Z'),
      end: new Date('2026-06-02T23:59:59.999Z'),
    }
    const rows = await fetchVercelGatewayReport(range)
    expect(rows).toHaveLength(1)

    const source = { path: 'vercel-ai-gateway:report', project: 'Vercel AI Gateway', provider: 'vercel-gateway' }
    const seen = new Set<string>()
    const calls = []
    for await (const call of vercelGateway.createSessionParser(source, seen, range).parse()) {
      calls.push(call)
    }
    expect(calls).toHaveLength(1)
    expect(calls[0]?.costUSD).toBe(1.25)
    expect(calls[0]?.model).toBe('anthropic/claude-sonnet-4.6')
  })
})

describe('vercel-gateway end-to-end (parseAllSessions network path)', () => {
  const originalFetch = globalThis.fetch
  const originalKey = process.env.AI_GATEWAY_API_KEY
  const originalCacheDir = process.env.CODEBURN_CACHE_DIR
  let cacheDir: string

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'cb-vercel-cache-'))
    process.env.CODEBURN_CACHE_DIR = cacheDir
    process.env.AI_GATEWAY_API_KEY = 'test-key'
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

  // Regression: the synthetic source path `vercel-ai-gateway:report` has no file
  // on disk, so it was dropped by the fingerprintFile gate in parseProviderSources
  // and the provider always reported $0. Network providers must survive that gate
  // and contribute their fetched cost through the real aggregation pipeline.
  it('network source survives the fingerprint gate and contributes cost', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        results: [
          { day: '2026-06-01', model: 'openai/gpt-4o', total_cost: 12.34, input_tokens: 1000, output_tokens: 500, request_count: 3 },
        ],
      }),
    })) as typeof fetch

    const range = getDashboardScanRange('week', null, null)
    const projects = await parseAllSessions(range, 'vercel-gateway')
    const total = projects.reduce((sum, p) => sum + p.totalCostUSD, 0)

    expect(total).toBeCloseTo(12.34, 2)
  })
})
