// A cost the tool itself reported must survive the session cache. Every
// non-Claude/Codex provider's parsed calls reach a report only as CachedCall ->
// cachedCallToApiCall, so a cost that providerCallToCachedCall drops is
// re-priced from tokens on EVERY read, cold and warm alike.
//
// OpenClaw and Pi both write a per-message `usage.cost.total` and both were
// dropping it. Their fallback — an absent or zero reported cost — is a token
// estimate and must keep being re-priced, so the decision is per call
// (`costFromBilling`), not per provider.
//
// Own file because both providers resolve their roots from the home directory
// when their module is first evaluated, so HOME must be set before any import.

import { afterAll, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'

const testRoot = vi.hoisted(() => {
  const root = `${process.env['TMPDIR'] || '/tmp'}/reported-cost-cache-${process.pid}-${Date.now()}`
  process.env['HOME'] = `${root}/home`
  process.env['USERPROFILE'] = `${root}/home`
  return root
})

const HOME = join(testRoot, 'home')
const CACHE_DIR = join(testRoot, 'cache')

// claude-sonnet-4-6 (src/data/litellm-snapshot.json): input 3e-6, output 15e-6,
// cacheRead 3e-7, cacheWrite 3.75e-6.
const SMALL_TOKENS = { input: 500, output: 100, cacheRead: 200, cacheWrite: 50 }
const LARGE_TOKENS = { input: 600, output: 200, cacheRead: 100, cacheWrite: 0 }
const SMALL_FLOOR = 500 * 3e-6 + 100 * 15e-6 + 200 * 3e-7 + 50 * 3.75e-6 // 0.0032475
const LARGE_FLOOR = 600 * 3e-6 + 200 * 15e-6 + 100 * 3e-7 // 0.00483
const OPENCLAW_REPORTED = 0.05 // ~10x its token floor
const PI_REPORTED = 0.4 // ~83x its token floor

const ts = (offsetSec: number) => new Date(Date.UTC(2026, 7, 16, 10, 0, offsetSec)).toISOString()

async function writeOpenClawSession(): Promise<void> {
  const dir = join(HOME, '.openclaw', 'agents', 'ocproj', 'sessions')
  await mkdir(dir, { recursive: true })
  const assistant = (id: string, tokens: typeof SMALL_TOKENS, cost?: number) => ({
    type: 'message', id, timestamp: ts(Number(id.slice(1)) + 2),
    message: {
      role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'ok' }],
      usage: { ...tokens, ...(cost === undefined ? {} : { cost: { total: cost } }) },
    },
  })
  const lines = [
    { type: 'session', version: 3, id: 'oc-sess-1', timestamp: ts(0), cwd: '/tmp/ocproj' },
    { type: 'message', id: 'u1', timestamp: ts(1), message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
    assistant('a1', SMALL_TOKENS),                       // no cost recorded
    assistant('a2', LARGE_TOKENS, OPENCLAW_REPORTED),    // reported
    assistant('a3', SMALL_TOKENS, 0),                    // explicit zero
  ]
  await writeFile(join(dir, 'oc-sess-1.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
}

async function writePiSession(): Promise<void> {
  const dir = join(HOME, '.pi', 'agent', 'sessions', '-tmp-piproj')
  await mkdir(dir, { recursive: true })
  const assistant = (responseId: string, offset: number, tokens: typeof SMALL_TOKENS, cost?: number) => ({
    type: 'message', id: `p${responseId}`, timestamp: ts(offset),
    message: {
      role: 'assistant', model: 'claude-sonnet-4-6', responseId, content: [{ type: 'text', text: 'ok' }],
      usage: { ...tokens, ...(cost === undefined ? {} : { cost: { total: cost } }) },
    },
  })
  const lines = [
    { type: 'session', id: 'pi-sess-1', timestamp: ts(0), cwd: '/tmp/piproj' },
    { type: 'message', id: 'pu1', timestamp: ts(1), message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
    assistant('r1', 3, SMALL_TOKENS, PI_REPORTED),  // reported
    assistant('r2', 4, LARGE_TOKENS, 0),            // zero: the xai-oauth shape
    assistant('r3', 5, LARGE_TOKENS),               // no cost object
  ]
  await writeFile(join(dir, 'pi-sess-1.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
}

async function cachedCostsFor(provider: string): Promise<Map<string, number | undefined>> {
  const { loadCache } = await import('../src/session-cache.js')
  const cache = await loadCache()
  const out = new Map<string, number | undefined>()
  for (const file of Object.values(cache.providers[provider]?.files ?? {})) {
    for (const turn of file.turns) {
      for (const call of turn.calls) out.set(call.deduplicationKey.split(':').pop() ?? '', call.costUSD)
    }
  }
  return out
}

beforeEach(async () => {
  process.env['HOME'] = HOME
  process.env['USERPROFILE'] = HOME
  process.env['CODEBURN_CACHE_DIR'] = CACHE_DIR
  await rm(HOME, { recursive: true, force: true })
  await rm(CACHE_DIR, { recursive: true, force: true })
  await mkdir(CACHE_DIR, { recursive: true })
})

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true })
})

it('keeps an OpenClaw reported cost cold and warm, and re-prices the rest', async () => {
  await writeOpenClawSession()
  const { clearSessionCache, parseAllSessions } = await import('../src/parser.js')

  clearSessionCache()
  const cold = (await parseAllSessions(undefined, 'openclaw')).reduce((s, p) => s + p.totalCostUSD, 0)
  clearSessionCache()
  const warm = (await parseAllSessions(undefined, 'openclaw')).reduce((s, p) => s + p.totalCostUSD, 0)

  // Before the fix both runs reported SMALL_FLOOR + LARGE_FLOOR + SMALL_FLOOR.
  expect(cold).toBeCloseTo(SMALL_FLOOR + OPENCLAW_REPORTED + SMALL_FLOOR, 10)
  expect(warm).toBeCloseTo(cold, 10)

  const costs = await cachedCostsFor('openclaw')
  expect(costs.get('a2')).toBeCloseTo(OPENCLAW_REPORTED, 10)
  // Absent and explicit-zero costs stay unstored, so a pricing update reaches them.
  expect(costs.get('a1')).toBeUndefined()
  expect(costs.get('a3')).toBeUndefined()
})

it('keeps a Pi reported cost cold and warm, and re-prices the rest', async () => {
  await writePiSession()
  const { clearSessionCache, parseAllSessions } = await import('../src/parser.js')

  clearSessionCache()
  const cold = (await parseAllSessions(undefined, 'pi')).reduce((s, p) => s + p.totalCostUSD, 0)
  clearSessionCache()
  const warm = (await parseAllSessions(undefined, 'pi')).reduce((s, p) => s + p.totalCostUSD, 0)

  expect(cold).toBeCloseTo(PI_REPORTED + LARGE_FLOOR + LARGE_FLOOR, 10)
  expect(warm).toBeCloseTo(cold, 10)

  const costs = await cachedCostsFor('pi')
  expect(costs.get('r1')).toBeCloseTo(PI_REPORTED, 10)
  expect(costs.get('r2')).toBeUndefined()
  expect(costs.get('r3')).toBeUndefined()
})

it('holds the reported-cost provider set to its documented membership', async () => {
  const { REPORTED_COST_PROVIDERS } = await import('../src/parser.js')
  // A provider joins this set (or starts setting costFromBilling) only
  // together with a PROVIDER_PARSE_VERSIONS bump, or its already-cached calls
  // keep being re-priced from tokens. Pinned so that pairing stays deliberate.
  expect([...REPORTED_COST_PROVIDERS].sort()).toEqual([
    'antigravity', 'cline-cli', 'codewhale', 'devin', 'hermes',
    'kiro', 'mistral-vibe', 'omp', 'quickdesk', 'vercel-gateway',
  ])
})
