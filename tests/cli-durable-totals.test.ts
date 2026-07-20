import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { DAILY_CACHE_VERSION, currentTzKey, type DailyCache, type DailyEntry } from '../src/daily-cache.js'
import { getDateRange } from '../src/cli-date.js'
import { loadPricing } from '../src/models.js'
import {
  buildMenubarPayloadForRange,
  buildDurablePeriod,
  buildPeriodData,
  getDailyCacheConfigHash,
} from '../src/usage-aggregator.js'
import { parseAllSessions, filterProjectsByName, clearSessionCache } from '../src/parser.js'
import { renderOverview } from '../src/overview.js'
import type { DateRange } from '../src/types.js'

// The point of #755: Claude deletes transcripts after ~30 days, so a day that
// can no longer be re-derived from session files exists ONLY in the durable
// daily cache. The bug this suite guards: the CLI report / overview / TUI
// live-parsed the surviving files and dropped those carried days, so their
// totals fell short of the menubar (which unions the cache). Every surface now
// routes totals through the ONE shared builder (buildDurablePeriod), so the CLI
// report totals must equal the menubar payload totals EXACTLY — carried day
// included — across all-provider, provider-filtered, custom-range, and lifetime
// queries, and in the plain live regime with no carried days at all.

const ROOT = join(tmpdir(), `codeburn-durable-totals-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
const ENV_KEYS = ['HOME', 'CODEBURN_CACHE_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CONFIG_DIRS', 'CODEX_HOME'] as const
let savedEnv: Record<string, string | undefined>

const CARRIED_COST = 100

function daysAgoStr(n: number): string {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** A day the cache holds but no session file can reproduce (sources aged out). */
function carriedDay(date: string): DailyEntry {
  return {
    date,
    cost: CARRIED_COST,
    savingsUSD: 0,
    calls: 40,
    sessions: 3,
    inputTokens: 5000,
    outputTokens: 2000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    editTurns: 4,
    oneShotTurns: 2,
    models: { 'Opus 4.8': { calls: 40, cost: CARRIED_COST, savingsUSD: 0, inputTokens: 5000, outputTokens: 2000, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    categories: { coding: { turns: 10, cost: CARRIED_COST, savingsUSD: 0, editTurns: 4, oneShotTurns: 2 } },
    providers: {
      claude: {
        calls: 40, cost: CARRIED_COST, savingsUSD: 0, sessions: 3,
        inputTokens: 5000, outputTokens: 2000, cacheReadTokens: 0, cacheWriteTokens: 0,
        editTurns: 4, oneShotTurns: 2,
        models: { 'Opus 4.8': { calls: 40, cost: CARRIED_COST, savingsUSD: 0, inputTokens: 5000, outputTokens: 2000, cacheReadTokens: 0, cacheWriteTokens: 0 } },
        categories: { coding: { turns: 10, cost: CARRIED_COST, savingsUSD: 0, editTurns: 4, oneShotTurns: 2 } },
        projects: { 'proj-x': { cost: CARRIED_COST, calls: 40, savingsUSD: 0, sessions: 3, path: '/Users/gone/proj-x' } },
      },
    },
    projects: { 'proj-x': { cost: CARRIED_COST, calls: 40, savingsUSD: 0, sessions: 3, path: '/Users/gone/proj-x' } },
    carried: true,
  }
}

/** Write a cache whose only historical day is carried (no source files exist). */
async function seedCarriedCache(): Promise<string> {
  const day = daysAgoStr(10)
  const cache: DailyCache = {
    version: DAILY_CACHE_VERSION,
    savingsConfigHash: getDailyCacheConfigHash(),
    tzKey: currentTzKey(),
    lastComputedDate: daysAgoStr(1),
    days: [carriedDay(day)],
    complete: true,
  }
  await writeFile(join(ROOT, 'cache', `daily-cache.v${DAILY_CACHE_VERSION}.json`), JSON.stringify(cache), 'utf-8')
  return day
}

/** Seed a real, priced Claude session dated TODAY (the live, surviving half). */
async function seedLiveTodaySession(): Promise<void> {
  const projectDir = join(ROOT, 'home', '.claude', 'projects', 'p')
  await mkdir(projectDir, { recursive: true })
  const now = new Date()
  const ts = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0).toISOString()
  const ts2 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 30, 0).toISOString()
  const line = (id: string, t: string): string => JSON.stringify({
    type: 'assistant',
    timestamp: t,
    sessionId: 's-today',
    message: {
      type: 'message', role: 'assistant', model: 'claude-3-5-sonnet-20241022', id,
      content: [],
      usage: { input_tokens: 90000, output_tokens: 12000, cache_creation_input_tokens: 0, cache_read_input_tokens: 300000 },
    },
  })
  await writeFile(join(projectDir, 's-today.jsonl'), [line('m1', ts), line('m2', ts2)].join('\n') + '\n', 'utf-8')
}

/** Live-only headline over the surviving files for the range (no cache union). */
async function liveOnly(range: DateRange): Promise<{ cost: number; calls: number }> {
  clearSessionCache()
  const projects = filterProjectsByName(await parseAllSessions(range, 'all'), [], [])
  const data = buildPeriodData('live', projects)
  return { cost: data.cost, calls: data.calls }
}

beforeAll(async () => {
  await loadPricing()
})

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
  await mkdir(join(ROOT, 'home', '.claude'), { recursive: true })
  await mkdir(join(ROOT, 'cache'), { recursive: true })
  process.env['HOME'] = join(ROOT, 'home')
  process.env['CODEBURN_CACHE_DIR'] = join(ROOT, 'cache')
  process.env['CLAUDE_CONFIG_DIR'] = join(ROOT, 'home', '.claude')
  delete process.env['CLAUDE_CONFIG_DIRS']
  delete process.env['CODEX_HOME']
  clearSessionCache()
})

afterEach(async () => {
  clearSessionCache()
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  if (existsSync(ROOT)) await rm(ROOT, { recursive: true, force: true })
})

/** The full report-vs-menubar equality for one resolved range + provider. */
async function assertParity(range: DateRange, provider: string): Promise<{ menubarCost: number; carried: number }> {
  clearSessionCache()
  const menubar = await buildMenubarPayloadForRange({ range, label: 'p' }, { provider, optimize: false, timeline: false })
  clearSessionCache()
  const durable = await buildDurablePeriod({ range, label: 'p' }, { provider })
  // The report / overview / TUI headline IS durable.data; the menubar payload's
  // current IS the same builder. They must agree bit-for-bit.
  expect(menubar.current.cost).toBe(durable.data.cost)
  expect(menubar.current.calls).toBe(durable.data.calls)
  expect(menubar.current.sessions).toBe(durable.data.sessions)
  expect(menubar.current.inputTokens).toBe(durable.data.inputTokens)
  expect(menubar.current.outputTokens).toBe(durable.data.outputTokens)
  return { menubarCost: menubar.current.cost, carried: durable.carriedCostUSD }
}

describe('CLI totals ↔ menubar parity through the durable daily cache', () => {
  it('counts the carried day equally on both paths for all-provider, custom-range, and lifetime', async () => {
    await seedCarriedCache()
    await seedLiveTodaySession()

    const custom: DateRange = { start: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000), end: new Date() }
    for (const range of [getDateRange('all').range, getDateRange('lifetime').range, custom]) {
      const { menubarCost, carried } = await assertParity(range, 'all')
      // The carried day is genuinely in the total: it equals the surviving-file
      // parse PLUS the $100 carried day, and strictly exceeds the live-only view.
      const live = await liveOnly(range)
      expect(carried).toBeCloseTo(CARRIED_COST, 6)
      expect(menubarCost).toBeGreaterThan(live.cost)
      expect(menubarCost).toBeCloseTo(live.cost + CARRIED_COST, 6)
    }
  })

  it('resolves provider filters identically on both paths, slicing the carried day per provider', async () => {
    await seedCarriedCache()
    await seedLiveTodaySession()
    const range = getDateRange('all').range

    // The corpus is entirely Claude, so the claude slice equals the all total.
    const claude = await assertParity(range, 'claude')
    clearSessionCache()
    const all = await buildDurablePeriod({ range, label: 'p' }, { provider: 'all' })
    expect(claude.menubarCost).toBeCloseTo(all.data.cost, 6)
    expect(claude.carried).toBeCloseTo(CARRIED_COST, 6)

    // A provider with no data is zero on both paths (no carried leak).
    clearSessionCache()
    const codexMenubar = await buildMenubarPayloadForRange({ range, label: 'p' }, { provider: 'codex', optimize: false, timeline: false })
    clearSessionCache()
    const codexDurable = await buildDurablePeriod({ range, label: 'p' }, { provider: 'codex' })
    expect(codexMenubar.current.cost).toBe(codexDurable.data.cost)
    expect(codexDurable.data.cost).toBe(0)
    expect(codexDurable.carriedCostUSD).toBe(0)
  })

  it('holds the equality in the plain live regime with no carried days', async () => {
    // No cache seeded: the only data is today's surviving session.
    await seedLiveTodaySession()
    const range = getDateRange('all').range

    const { menubarCost, carried } = await assertParity(range, 'all')
    const live = await liveOnly(range)
    expect(carried).toBe(0)
    expect(menubarCost).toBeGreaterThan(0)
    expect(menubarCost).toBeCloseTo(live.cost, 6)
  })
})

describe('terminal overview carried-day footnote', () => {
  it('appends the preserved-cost footnote exactly when carried > 0', async () => {
    await seedCarriedCache()
    await seedLiveTodaySession()
    const range = getDateRange('all').range

    clearSessionCache()
    const durable = await buildDurablePeriod({ range, label: 'Last 6 months' }, { provider: 'all' })
    expect(durable.carriedCostUSD).toBeGreaterThan(0)
    const withCarried = renderOverview(durable.liveProjects, {
      label: 'Last 6 months',
      color: false,
      durable: {
        cost: durable.data.cost,
        savingsUSD: durable.data.savingsUSD,
        calls: durable.data.calls,
        sessions: durable.data.sessions,
        inputTokens: durable.data.inputTokens,
        outputTokens: durable.data.outputTokens,
        cacheReadTokens: durable.data.cacheReadTokens,
        cacheWriteTokens: durable.data.cacheWriteTokens,
        days: durable.days,
        carriedCostUSD: durable.carriedCostUSD,
      },
    })
    expect(withCarried).toContain('preserved from expired session logs')
  })

  it('omits the footnote when nothing was carried', async () => {
    await seedLiveTodaySession()
    const range = getDateRange('all').range

    clearSessionCache()
    const durable = await buildDurablePeriod({ range, label: 'Last 6 months' }, { provider: 'all' })
    expect(durable.carriedCostUSD).toBe(0)
    const noCarried = renderOverview(durable.liveProjects, {
      label: 'Last 6 months',
      color: false,
      durable: {
        cost: durable.data.cost,
        savingsUSD: durable.data.savingsUSD,
        calls: durable.data.calls,
        sessions: durable.data.sessions,
        inputTokens: durable.data.inputTokens,
        outputTokens: durable.data.outputTokens,
        cacheReadTokens: durable.data.cacheReadTokens,
        cacheWriteTokens: durable.data.cacheWriteTokens,
        days: durable.days,
        carriedCostUSD: durable.carriedCostUSD,
      },
    })
    expect(noCarried).not.toContain('preserved from expired session logs')
  })
})
