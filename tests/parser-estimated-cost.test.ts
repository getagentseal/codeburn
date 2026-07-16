import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { loadPricing } from '../src/models.js'
import { parseAllSessions, clearSessionCache } from '../src/parser.js'
import type { DateRange, ProjectSummary } from '../src/types.js'

// End-to-end proof for issue #639: a provider that sets `costIsEstimated` on its
// parsed calls must carry that truth all the way onto ParsedApiCall and into the
// session/model aggregates, surviving the session-cache round trip. CodeWhale is
// used because the same provider yields a measured call (metadata carries a real
// `cost`) or an estimated one (no `cost`, so tokens are priced) purely from the
// fixture, which keeps the measured-vs-estimated contrast in one code path.

const FIXTURE_DAY = Date.UTC(2026, 6, 14)
const RANGE: DateRange = {
  start: new Date(FIXTURE_DAY - 24 * 60 * 60 * 1000),
  end: new Date(FIXTURE_DAY + 24 * 60 * 60 * 1000),
}

let home: string
let cacheDir: string
let prevHome: string | undefined
let prevCache: string | undefined

beforeAll(async () => {
  await loadPricing()
})

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'codeburn-est-home-'))
  cacheDir = await mkdtemp(join(tmpdir(), 'codeburn-est-cache-'))
  prevHome = process.env['CODEWHALE_HOME']
  prevCache = process.env['CODEBURN_CACHE_DIR']
  process.env['CODEWHALE_HOME'] = home
  process.env['CODEBURN_CACHE_DIR'] = cacheDir
  clearSessionCache()
})

afterEach(async () => {
  clearSessionCache()
  if (prevHome === undefined) delete process.env['CODEWHALE_HOME']
  else process.env['CODEWHALE_HOME'] = prevHome
  if (prevCache === undefined) delete process.env['CODEBURN_CACHE_DIR']
  else process.env['CODEBURN_CACHE_DIR'] = prevCache
  await rm(home, { recursive: true, force: true })
  await rm(cacheDir, { recursive: true, force: true })
})

async function writeSession(id: string, opts: { cost?: Record<string, number> | null; model?: string }): Promise<void> {
  const sessions = join(home, 'sessions')
  await mkdir(sessions, { recursive: true })
  const metadata: Record<string, unknown> = {
    id,
    title: 'estimated-cost fixture',
    created_at: '2026-07-14T10:00:00.000Z',
    updated_at: '2026-07-14T11:00:00.000Z',
    message_count: 0,
    total_tokens: 200_000,
    model: opts.model ?? 'gpt-4o',
    model_provider: 'openai',
    workspace: '/repos/est-fixture',
    mode: 'agent',
  }
  if (opts.cost !== null && opts.cost !== undefined) metadata.cost = opts.cost
  await writeFile(join(sessions, `${id}.json`), JSON.stringify({ schema_version: 1, metadata, messages: [] }))
}

function onlyCall(projects: ProjectSummary[]) {
  const calls = projects.flatMap(p => p.sessions.flatMap(s => s.turns.flatMap(t => t.assistantCalls)))
  expect(calls).toHaveLength(1)
  return calls[0]!
}

function onlySession(projects: ProjectSummary[]) {
  const sessions = projects.flatMap(p => p.sessions)
  expect(sessions).toHaveLength(1)
  return sessions[0]!
}

describe('estimated cost propagation (#639)', () => {
  it('flags an estimated call and rolls the estimated dollars up through session/model/project', async () => {
    await writeSession('estimated', { cost: null })
    const projects = await parseAllSessions(RANGE, 'codewhale')

    const call = onlyCall(projects)
    expect(call.costUSD).toBeGreaterThan(0)
    expect(call.isEstimated).toBe(true)

    const session = onlySession(projects)
    expect(session.totalEstimatedCostUSD).toBeCloseTo(call.costUSD)
    const modelEntry = Object.values(session.modelBreakdown)[0]!
    expect(modelEntry.estimatedCostUSD).toBeCloseTo(call.costUSD)

    expect(projects[0]!.totalEstimatedCostUSD).toBeCloseTo(call.costUSD)
    // Metadata only: the estimated portion is never subtracted from cost.
    expect(session.totalCostUSD).toBeCloseTo(call.costUSD)
  })

  it('does not flag a measured call (real cost in metadata)', async () => {
    await writeSession('measured', { cost: { session_cost_usd: 0.25 } })
    const projects = await parseAllSessions(RANGE, 'codewhale')

    const call = onlyCall(projects)
    expect(call.costUSD).toBeCloseTo(0.25)
    expect(call.isEstimated).toBeFalsy()

    const session = onlySession(projects)
    expect(session.totalEstimatedCostUSD ?? 0).toBe(0)
    expect(Object.values(session.modelBreakdown)[0]!.estimatedCostUSD ?? 0).toBe(0)
    expect(projects[0]!.totalEstimatedCostUSD ?? 0).toBe(0)
  })

  it('keeps the flag after the session-cache round trip (second parse is cache-served)', async () => {
    await writeSession('estimated', { cost: null })
    const first = await parseAllSessions(RANGE, 'codewhale')
    const firstCost = onlyCall(first).costUSD

    // Do NOT clear the cache: the second parse hydrates the call from
    // session-cache.json, exercising CachedCall.isEstimated persistence.
    const second = await parseAllSessions(RANGE, 'codewhale')
    const call = onlyCall(second)
    expect(call.isEstimated).toBe(true)
    expect(call.costUSD).toBeCloseTo(firstCost)
    expect(onlySession(second).totalEstimatedCostUSD).toBeCloseTo(firstCost)
  })
})
