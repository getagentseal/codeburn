import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { parseAllSessions, filterProjectsByName, filterProjectsByDateRange, filterProjectsByDays, clearSessionCache } from '../src/parser.js'
import { buildPrAttribution } from '../src/sessions-report.js'
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
const ENV_KEYS = ['HOME', 'CODEBURN_CACHE_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CONFIG_DIRS', 'CODEX_HOME', 'USERPROFILE', 'KIMI_CODE_HOME', 'CODEBURN_DESKTOP_SESSIONS_DIR'] as const
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
  // Timestamps must be today AND already in the past: the provider-filtered
  // durable path parses a today-range ending at `now`, so a fixed clock time
  // (e.g. noon under the suite's TZ=UTC pin) sits in the future for any run
  // before that hour and gets range-filtered out, failing parity flakily.
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const at = (f: number) => new Date(todayStart.getTime() + (now.getTime() - todayStart.getTime()) * f)
  const ts = at(0.4).toISOString()
  const ts2 = at(0.6).toISOString()
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
  await mkdir(join(ROOT, 'no-desktop-sessions'), { recursive: true })
  await mkdir(join(ROOT, 'no-kimi-home'), { recursive: true })
  process.env['HOME'] = join(ROOT, 'home')
  process.env['CODEBURN_CACHE_DIR'] = join(ROOT, 'cache')
  process.env['CLAUDE_CONFIG_DIR'] = join(ROOT, 'home', '.claude')
  delete process.env['CLAUDE_CONFIG_DIRS']
  delete process.env['CODEX_HOME']
  // Keep real provider data on the machine out of every parse: absolute-count
  // assertions are meaningless when the host's own sessions leak in.
  // USERPROFILE matters on Windows, where os.homedir() ignores HOME;
  // KIMI_CODE_HOME / the desktop-sessions override redirect the two env-aware
  // discovery roots. (The codex provider captures its home at import time, so
  // it is redirected separately in vi.hoisted below.)
  process.env['USERPROFILE'] = join(ROOT, 'home')
  process.env['KIMI_CODE_HOME'] = join(ROOT, 'no-kimi-home')
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(ROOT, 'no-desktop-sessions')
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

// Issue #852 review: per-call slicing is only conservation-correct when day
// bucketing attributes call-derived values to each call's own day. These
// tests pin the straddling-turn case the review reproduced end-to-end through
// buildDurablePeriod: a turn starting the previous day at 23:57 with one call
// before and one after local midnight must keep BOTH calls across a multi-day
// period (cache ≤ yesterday + live today union), each on its own day.
//
// The codex provider captures CODEX_HOME when its module is first imported,
// so the redirect must happen before module evaluation (vi.hoisted) rather
// than in beforeEach. The captured dir is per-test-process and empty except
// for the fixture written below, which also shields the suite from any real
// ~/.codex on the machine running it.
const CODEX_ROOT = vi.hoisted(() => {
  const root = `${process.env['TMPDIR'] || '/tmp'}/codeburn-straddle-codex-${process.pid}-${Date.now()}`
  process.env['CODEX_HOME'] = `${root}/codex`
  return root
})

describe('midnight-straddling turn conservation (issue #852)', () => {
  // Day N = 2026-07-27, day N+1 ("today") = 2026-07-28 — LOCAL dates built
  // from constructor args so the case is machine-TZ independent (dateKey /
  // toDateString use the same local getters).
  const NOW = new Date(2026, 6, 28, 12, 0, 0)
  const DAY_N = '2026-07-27'
  const DAY_N1 = '2026-07-28'

  function fakeNow(): void {
    // Date only: the daily-cache lock and retry helpers must keep real timers.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  }

  beforeEach(async () => {
    await rm(CODEX_ROOT, { recursive: true, force: true })
  })

  afterEach(async () => {
    await rm(CODEX_ROOT, { recursive: true, force: true })
  })

  // One codex turn (the issue's provider) with a token_count call on each
  // side of local midnight: 23:58 (input 1000/output 200), 00:10 (2000/400).
  async function seedStraddlingCodexTurn(): Promise<void> {
    const sessionDir = join(CODEX_ROOT, 'codex', 'sessions', '2026', '07', '27')
    await mkdir(sessionDir, { recursive: true })
    const line = (obj: unknown): string => JSON.stringify(obj)
    await writeFile(join(sessionDir, 'rollout-straddle.jsonl'), [
      line({ type: 'session_meta', timestamp: new Date(2026, 6, 27, 23, 55, 0).toISOString(), payload: { session_id: 'sess-straddle', model: 'gpt-5.5', cwd: '/tmp/straddle-proj', originator: 'codex_cli_rs' } }),
      line({ type: 'response_item', timestamp: new Date(2026, 6, 27, 23, 57, 0).toISOString(), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'work through midnight' }] } }),
      line({ type: 'event_msg', timestamp: new Date(2026, 6, 27, 23, 58, 0).toISOString(), payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1000, output_tokens: 200 }, total_token_usage: { total_tokens: 1200 } } } }),
      line({ type: 'event_msg', timestamp: new Date(2026, 6, 28, 0, 10, 0).toISOString(), payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 2000, output_tokens: 400 }, total_token_usage: { total_tokens: 3600 } } } }),
    ].join('\n') + '\n', 'utf-8')
  }

  // The same straddle through the Claude Code path (scanProjectDirs).
  async function seedStraddlingClaudeTurn(): Promise<void> {
    const projectDir = join(ROOT, 'home', '.claude', 'projects', 'straddle-proj')
    await mkdir(projectDir, { recursive: true })
    const line = (obj: unknown): string => JSON.stringify(obj)
    await writeFile(join(projectDir, 's-straddle.jsonl'), [
      line({ type: 'user', sessionId: 's-straddle', timestamp: new Date(2026, 6, 27, 23, 57, 0).toISOString(), cwd: '/tmp/straddle-proj', message: { role: 'user', content: 'work through midnight' } }),
      line({ type: 'assistant', sessionId: 's-straddle', timestamp: new Date(2026, 6, 27, 23, 58, 0).toISOString(), cwd: '/tmp/straddle-proj', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-3-5-sonnet-20241022', content: [], usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
      line({ type: 'assistant', sessionId: 's-straddle', timestamp: new Date(2026, 6, 28, 0, 10, 0).toISOString(), cwd: '/tmp/straddle-proj', message: { id: 'm2', type: 'message', role: 'assistant', model: 'claude-3-5-sonnet-20241022', content: [], usage: { input_tokens: 2000, output_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
    ].join('\n') + '\n', 'utf-8')
  }

  // The two calls' exact costs from an unfiltered parse (pricing-agnostic truth).
  async function truthCosts(provider: string): Promise<[number, number]> {
    clearSessionCache()
    const projects = await parseAllSessions(undefined, provider)
    const calls = projects.flatMap(p => p.sessions).flatMap(s => s.turns).flatMap(t => t.assistantCalls)
    expect(calls).toHaveLength(2)
    return [calls[0]!.costUSD, calls[1]!.costUSD]
  }

  it('keeps day-N + day-N+1 equal to the whole-range totals through buildDurablePeriod', async () => {
    fakeNow()
    try {
      await seedStraddlingCodexTurn()
      const [costN, costN1] = await truthCosts('codex')
      expect(costN + costN1).toBeGreaterThan(0)

      const range: DateRange = { start: new Date(2026, 6, 27, 0, 0, 0), end: new Date() }
      clearSessionCache()
      const durable = await buildDurablePeriod({ range, label: '2d' }, { provider: 'all' })

      const dayN = durable.days.find(d => d.date === DAY_N)
      const dayN1 = durable.days.find(d => d.date === DAY_N1)
      // Each side of the turn lands on its own day...
      expect(dayN?.calls).toBe(1)
      expect(dayN1?.calls).toBe(1)
      expect(dayN!.cost).toBeCloseTo(costN, 8)
      expect(dayN1!.cost).toBeCloseTo(costN1, 8)
      // ...and the two sides conserve the whole-range totals (the review's
      // week/month leak returned 1 call and only the pre-midnight cost).
      expect(durable.data.calls).toBe(2)
      expect(dayN!.calls + dayN1!.calls).toBe(durable.data.calls)
      expect(durable.data.cost).toBeCloseTo(costN + costN1, 8)
      expect(dayN!.cost + dayN1!.cost).toBeCloseTo(durable.data.cost, 8)
      expect(durable.data.inputTokens).toBe(3000)
      expect(durable.data.outputTokens).toBe(600)
      expect(dayN!.inputTokens + dayN1!.inputTokens).toBe(durable.data.inputTokens)
      expect(dayN!.outputTokens + dayN1!.outputTokens).toBe(durable.data.outputTokens)
    } finally {
      vi.useRealTimers()
    }
  }, 60_000)

  it('shows the post-midnight call in the today-only view on the Claude Code path', async () => {
    fakeNow()
    try {
      await seedStraddlingClaudeTurn()
      const [, costN1] = await truthCosts('claude')

      clearSessionCache()
      const durable = await buildDurablePeriod({ range: getDateRange('today').range, label: 'today' }, { provider: 'all' })
      expect(durable.data.calls).toBe(1)
      expect(durable.data.cost).toBeCloseTo(costN1, 8)
      expect(durable.data.inputTokens).toBe(2000)
      expect(durable.data.outputTokens).toBe(400)
    } finally {
      vi.useRealTimers()
    }
  }, 60_000)

  it('slices the straddling turn per call in the dashboard/menubar surface filters', async () => {
    fakeNow()
    try {
      await seedStraddlingClaudeTurn()
      clearSessionCache()
      const all = await parseAllSessions(undefined, 'claude')
      const callsOf = (ps: typeof all) => ps.flatMap(p => p.sessions).flatMap(s => s.turns).flatMap(t => t.assistantCalls)
      const inputOf = (ps: typeof all) => ps.flatMap(p => p.sessions).reduce((s, sess) => s + sess.totalInputTokens, 0)

      // Dashboard Today/7-Days narrowing over an unfiltered parse.
      const dashToday = filterProjectsByDateRange(all, getDateRange('today').range)
      expect(callsOf(dashToday)).toHaveLength(1)
      expect(inputOf(dashToday)).toBe(2000)

      // Menubar/history day selection, on each side of midnight.
      const menubarToday = filterProjectsByDays(all, new Set([DAY_N1]))
      expect(callsOf(menubarToday)).toHaveLength(1)
      expect(inputOf(menubarToday)).toBe(2000)

      const menubarYesterday = filterProjectsByDays(all, new Set([DAY_N]))
      expect(callsOf(menubarYesterday)).toHaveLength(1)
      expect(inputOf(menubarYesterday)).toBe(1000)
    } finally {
      vi.useRealTimers()
    }
  }, 60_000)

  it('keeps range-start PR attribution when a straddling tail is the first in-range content', async () => {
    // M3: the PR set active at range start (prRefsAtRangeStart) was frozen on
    // the first turn whose UNsliced first call fell in the range. A turn whose
    // tail is the range's first content (first call before the start, later
    // calls inside) never froze it, so a session whose only in-range spend is
    // that tail lost the pre-range PR: the by-PR report emitted NO row.
    const PR_A = 'https://github.com/o/r/pull/1'
    const projectDir = join(ROOT, 'home', '.claude', 'projects', 'pr-straddle-proj')
    await mkdir(projectDir, { recursive: true })
    const line = (obj: unknown): string => JSON.stringify(obj)
    await writeFile(join(projectDir, 's-pr-straddle.jsonl'), [
      // Turn 1, fully BEFORE the range: references PR_A, call at 23:52.
      line({ type: 'user', sessionId: 's-pr-straddle', timestamp: new Date(2026, 6, 27, 23, 50, 0).toISOString(), cwd: '/tmp/pr-straddle-proj', message: { role: 'user', content: `fix ${PR_A}` } }),
      line({ type: 'assistant', sessionId: 's-pr-straddle', timestamp: new Date(2026, 6, 27, 23, 52, 0).toISOString(), cwd: '/tmp/pr-straddle-proj', message: { id: 'm0', type: 'message', role: 'assistant', model: 'claude-3-5-sonnet-20241022', content: [], usage: { input_tokens: 500, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
      // Turn 2, straddles the range start: user message WITHOUT a PR ref, one
      // call before the range (23:59, sliced away) and the tail at 00:10 (in).
      line({ type: 'user', sessionId: 's-pr-straddle', timestamp: new Date(2026, 6, 27, 23, 57, 0).toISOString(), cwd: '/tmp/pr-straddle-proj', message: { role: 'user', content: 'work through midnight' } }),
      line({ type: 'assistant', sessionId: 's-pr-straddle', timestamp: new Date(2026, 6, 27, 23, 59, 0).toISOString(), cwd: '/tmp/pr-straddle-proj', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-3-5-sonnet-20241022', content: [], usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
      line({ type: 'assistant', sessionId: 's-pr-straddle', timestamp: new Date(2026, 6, 28, 0, 10, 0).toISOString(), cwd: '/tmp/pr-straddle-proj', message: { id: 'm2', type: 'message', role: 'assistant', model: 'claude-3-5-sonnet-20241022', content: [], usage: { input_tokens: 2000, output_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
    ].join('\n') + '\n', 'utf-8')

    clearSessionCache()
    const projects = await parseAllSessions({ start: new Date(2026, 6, 28, 0, 0, 0), end: new Date() }, 'claude')
    const session = projects.flatMap(p => p.sessions)[0]!

    // Only the tail survives the range.
    expect(session.apiCalls).toBe(1)
    // The pre-range PR state survived the slice...
    expect(session.prRefsAtRangeStart).toEqual([PR_A])
    // ...and the session counts as PR-linked even though its only PR reference
    // was sliced away, so the by-PR report emits a real (non-approx) row for it.
    const { rows } = buildPrAttribution(projects)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.url).toBe(PR_A)
    expect(rows[0]!.approx).toBe(false)
    expect(rows[0]!.cost).toBeGreaterThan(0)
  }, 60_000)
})
