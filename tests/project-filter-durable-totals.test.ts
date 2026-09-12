import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { DAILY_CACHE_VERSION, currentTzKey, type DailyCache, type DailyEntry, type ProjectDayStats, type ProviderDaySlice } from '../src/daily-cache.js'
import { loadPricing } from '../src/models.js'
import { buildDurablePeriod, buildMenubarPayloadForRange, buildPeriodData, getDailyCacheConfigHash } from '../src/usage-aggregator.js'
import { parseAllSessions, filterProjectsByName, clearSessionCache } from '../src/parser.js'
import { renderOverview } from '../src/overview.js'
import type { DateRange } from '../src/types.js'
import { setHome } from './setup/home.js'

// The durable headline (overview / report Overview panel / menubar current) is
// built from the carry-forward daily cache unioned with today's live parse, so
// days whose session files expired still count. Historical days were sliced to
// the requested PROVIDER but never to the requested PROJECT, so
// `--project` / `--exclude` were silently ignored for every day except today:
// the Overview total counted excluded projects while every detail panel (By
// Project / By Activity / By Model, all built from the name-filtered live
// parse) left them out, and the two panels could not be reconciled.
//
// Per-project day stats exist in the cache since v15 (DailyEntry.projects), so
// the historical days CAN be sliced — that is what these tests pin down.

const ROOT = join(tmpdir(), `codeburn-project-filter-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
const ENV_KEYS = ['HOME', 'CODEBURN_CACHE_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CONFIG_DIRS', 'CODEX_HOME'] as const
let savedEnv: Record<string, string | undefined>

// One carried day, split across two projects. The day totals are the sum, so a
// correct project slice returns strictly less than the whole day.
const KEEP = { cost: 30, calls: 10, sessions: 1 }
const DROP = { cost: 70, calls: 30, sessions: 2 }
const DAY_COST = KEEP.cost + DROP.cost
const DAY_CALLS = KEEP.calls + DROP.calls
const DAY_SESSIONS = KEEP.sessions + DROP.sessions

function daysAgoStr(n: number): string {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** A day only the cache holds (sources aged out), split across two projects. */
function carriedDayWithProjects(date: string): DailyEntry {
  const projects = {
    'keep-me': { cost: KEEP.cost, calls: KEEP.calls, savingsUSD: 0, sessions: KEEP.sessions, path: '/Users/gone/keep-me' },
    'drop-me': { cost: DROP.cost, calls: DROP.calls, savingsUSD: 0, sessions: DROP.sessions, path: '/Users/gone/drop-me' },
  }
  return {
    date,
    cost: DAY_COST,
    savingsUSD: 0,
    calls: DAY_CALLS,
    sessions: DAY_SESSIONS,
    inputTokens: 5000,
    outputTokens: 2000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    editTurns: 4,
    oneShotTurns: 2,
    models: { 'Opus 4.8': { calls: DAY_CALLS, cost: DAY_COST, savingsUSD: 0, inputTokens: 5000, outputTokens: 2000, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    categories: { coding: { turns: 10, cost: DAY_COST, savingsUSD: 0, editTurns: 4, oneShotTurns: 2 } },
    providers: {
      claude: {
        calls: DAY_CALLS, cost: DAY_COST, savingsUSD: 0, sessions: DAY_SESSIONS,
        inputTokens: 5000, outputTokens: 2000, cacheReadTokens: 0, cacheWriteTokens: 0,
        editTurns: 4, oneShotTurns: 2,
        models: { 'Opus 4.8': { calls: DAY_CALLS, cost: DAY_COST, savingsUSD: 0, inputTokens: 5000, outputTokens: 2000, cacheReadTokens: 0, cacheWriteTokens: 0 } },
        categories: { coding: { turns: 10, cost: DAY_COST, savingsUSD: 0, editTurns: 4, oneShotTurns: 2 } },
        projects,
      },
    },
    projects,
    carried: true,
  }
}

/** A carried day recorded before v15: totals, but no per-project split at all. */
function carriedDayWithoutProjects(date: string): DailyEntry {
  const day = carriedDayWithProjects(date)
  delete day.projects
  delete day.providers['claude']!.projects
  return day
}

/**
 * A carried day whose two providers own disjoint projects: claude spent only on
 * `keep-me`, codex only on `drop-me`. Filtering `drop-me` out must therefore take
 * codex's whole contribution with it, which is what makes the provider list's
 * project slicing observable.
 */
function carriedDayTwoProviders(date: string): DailyEntry {
  const day = carriedDayWithProjects(date)
  const keepProjects = { 'keep-me': { cost: KEEP.cost, calls: KEEP.calls, savingsUSD: 0, sessions: KEEP.sessions, path: '/Users/gone/keep-me' } }
  const dropProjects = { 'drop-me': { cost: DROP.cost, calls: DROP.calls, savingsUSD: 0, sessions: DROP.sessions, path: '/Users/gone/drop-me' } }
  const slice = (
    stats: { cost: number; calls: number; sessions: number },
    projects: Record<string, ProjectDayStats>,
  ): ProviderDaySlice => ({
    calls: stats.calls, cost: stats.cost, savingsUSD: 0, sessions: stats.sessions,
    inputTokens: 2500, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0,
    editTurns: 2, oneShotTurns: 1,
    models: { 'Opus 4.8': { calls: stats.calls, cost: stats.cost, savingsUSD: 0, inputTokens: 2500, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    categories: { coding: { turns: 5, cost: stats.cost, savingsUSD: 0, editTurns: 2, oneShotTurns: 1 } },
    projects,
  })
  day.providers = {
    claude: slice(KEEP, keepProjects),
    codex: slice(DROP, dropProjects),
  }
  return day
}

/** The same carried day, with the two projects as path siblings sharing a prefix. */
function carriedDaySiblingProjects(date: string): DailyEntry {
  const day = carriedDayWithProjects(date)
  const projects = {
    app: { cost: KEEP.cost, calls: KEEP.calls, savingsUSD: 0, sessions: KEEP.sessions, path: '/Users/gone/app' },
    'app-kit': { cost: DROP.cost, calls: DROP.calls, savingsUSD: 0, sessions: DROP.sessions, path: '/Users/gone/app-kit' },
  }
  day.projects = projects
  day.providers['claude']!.projects = projects
  return day
}

async function seedCache(...days: DailyEntry[]): Promise<void> {
  const cache: DailyCache = {
    version: DAILY_CACHE_VERSION,
    savingsConfigHash: getDailyCacheConfigHash(),
    tzKey: currentTzKey(),
    lastComputedDate: daysAgoStr(1),
    days,
    complete: true,
  }
  await writeFile(join(ROOT, 'cache', `daily-cache.v${DAILY_CACHE_VERSION}.json`), JSON.stringify(cache), 'utf-8')
}

/** A real, priced Claude session dated TODAY, under project dir `live-proj`. */
async function seedLiveTodaySession(): Promise<void> {
  const projectDir = join(ROOT, 'home', '.claude', 'projects', 'live-proj')
  await mkdir(projectDir, { recursive: true })
  const now = new Date()
  // Timestamps a few minutes OLD, clamped into today: a wall-clock hour (12:00)
  // is in the future whenever the suite runs before noon, and the periods here
  // end at `new Date()`, so a fixed hour made the live half of the union vanish
  // for a morning run. Relative-and-clamped keeps the session inside today and
  // in the past at every hour.
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const minutesAgo = (m: number): string => new Date(Math.max(midnight, now.getTime() - m * 60_000)).toISOString()
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
  await writeFile(join(projectDir, 's-today.jsonl'), [line('m1', minutesAgo(10)), line('m2', minutesAgo(5))].join('\n') + '\n', 'utf-8')
}

/** What the name-filtered live parse alone reports — the By Project panel's source. */
async function liveOnly(range: DateRange, include: string[], exclude: string[]): Promise<{ cost: number; calls: number }> {
  clearSessionCache()
  const projects = filterProjectsByName(await parseAllSessions(range, 'all'), include, exclude)
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
  setHome(join(ROOT, 'home'))
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

// A fixed 20-day window back from now: it always spans the carried day (10 days
// ago) and today, so the period never depends on where "now" falls in the
// calendar. A real `month` range drops the 10-days-ago day whenever today is
// within 10 days of the 1st, which made these tests flake early in each month.
const coveringRange = (): DateRange => ({
  start: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
  end: new Date(),
})

describe('durable headline honours --project / --exclude on carried days', () => {
  it('drops an excluded project from the headline so it reconciles with the By Project panel', async () => {
    await seedCache(carriedDayWithProjects(daysAgoStr(10)))
    await seedLiveTodaySession()
    const range = coveringRange()

    const live = await liveOnly(range, [], ['drop-me'])
    clearSessionCache()
    const durable = await buildDurablePeriod({ range, label: 'p' }, { provider: 'all', exclude: ['drop-me'] })

    // The headline counts the surviving sessions plus ONLY the kept project's
    // carried cost — not the whole carried day.
    expect(durable.data.cost).toBeCloseTo(live.cost + KEEP.cost, 6)
    expect(durable.data.calls).toBe(live.calls + KEEP.calls)
    // And it reconciles with the detail panels, which see the same live parse.
    const byProject = durable.liveProjects.reduce((s, p) => s + p.totalCostUSD, 0)
    expect(durable.data.cost).toBeCloseTo(byProject + KEEP.cost, 6)
  })

  it('keeps only the named project when --project is given', async () => {
    await seedCache(carriedDayWithProjects(daysAgoStr(10)))
    await seedLiveTodaySession()
    const range = coveringRange()

    const live = await liveOnly(range, ['keep-me'], [])
    clearSessionCache()
    const durable = await buildDurablePeriod({ range, label: 'p' }, { provider: 'all', project: ['keep-me'] })

    expect(durable.data.cost).toBeCloseTo(live.cost + KEEP.cost, 6)
    expect(durable.data.calls).toBe(live.calls + KEEP.calls)
  })

  it('matches a filter against the project path as well as its name', async () => {
    await seedCache(carriedDayWithProjects(daysAgoStr(10)))
    await seedLiveTodaySession()
    const range = coveringRange()

    const live = await liveOnly(range, [], ['/Users/gone/drop-me'])
    clearSessionCache()
    const durable = await buildDurablePeriod({ range, label: 'p' }, { provider: 'all', exclude: ['/Users/gone/drop-me'] })

    expect(durable.data.cost).toBeCloseTo(live.cost + KEEP.cost, 6)
  })

  // A cached day and a live day must answer the same pattern the same way. The
  // two below are the shapes where a substring copy of the rule diverges from
  // the anchored one, inside a single headline total.
  it('anchors an absolute pattern on a carried day, so the sibling survives', async () => {
    await seedCache(carriedDaySiblingProjects(daysAgoStr(10)))
    await seedLiveTodaySession()
    const range = coveringRange()

    const live = await liveOnly(range, [], ['/Users/gone/app'])
    clearSessionCache()
    const durable = await buildDurablePeriod({ range, label: 'p' }, { provider: 'all', exclude: ['/Users/gone/app'] })

    expect(durable.data.cost).toBeCloseTo(live.cost + DROP.cost, 6)
    expect(durable.data.calls).toBe(live.calls + DROP.calls)
  })

  it('keeps POSIX case identity on a carried day, so a wrong-case path selects nothing', async () => {
    await seedCache(carriedDaySiblingProjects(daysAgoStr(10)))
    await seedLiveTodaySession()
    const range = coveringRange()

    const live = await liveOnly(range, [], ['/users/gone/app'])
    clearSessionCache()
    const durable = await buildDurablePeriod({ range, label: 'p' }, { provider: 'all', exclude: ['/users/gone/app'] })

    expect(durable.data.cost).toBeCloseTo(live.cost + DAY_COST, 6)
    expect(durable.data.calls).toBe(live.calls + DAY_CALLS)
  })

  it('keeps a project whose name is a prototype member (constructor) in the sliced total', async () => {
    // A project directory can legitimately be named "constructor"/"valueOf"/etc.
    // The day cache must carry it as an own key: if the load path drops it, the
    // day's per-project split no longer sums to the day cost, and the sliced
    // headline silently loses that project's spend.
    const day = carriedDayWithProjects(daysAgoStr(10))
    const protoName = 'constructor'
    Object.defineProperty(day.projects!, protoName, {
      value: { cost: 25, calls: 5, savingsUSD: 0, sessions: 1, path: '/Users/gone/constructor' },
      enumerable: true, writable: true, configurable: true,
    })
    day.cost += 25
    day.calls += 5
    await seedCache(day)
    await seedLiveTodaySession()
    const range = coveringRange()

    // Keep everything (exclude a non-matching term): the constructor project's
    // $25 must be present alongside keep-me and drop-me.
    const durable = await buildDurablePeriod({ range, label: 'p' }, { provider: 'all', exclude: ['zzz-nomatch'] })
    const live = await liveOnly(range, [], ['zzz-nomatch'])
    expect(durable.data.cost).toBeCloseTo(live.cost + DAY_COST + 25, 6)
    expect(durable.unattributedCostUSD).toBe(0)
  })

  it('contributes nothing from a carried day whose every project is excluded', async () => {
    await seedCache(carriedDayWithProjects(daysAgoStr(10)))
    await seedLiveTodaySession()
    const range = coveringRange()

    const live = await liveOnly(range, [], ['keep-me', 'drop-me'])
    clearSessionCache()
    const durable = await buildDurablePeriod({ range, label: 'p' }, { provider: 'all', exclude: ['keep-me', 'drop-me'] })

    expect(durable.data.cost).toBeCloseTo(live.cost, 6)
    expect(durable.carriedCostUSD).toBe(0)
  })

  it('applies the project filter underneath a provider filter', async () => {
    await seedCache(carriedDayWithProjects(daysAgoStr(10)))
    await seedLiveTodaySession()
    const range = coveringRange()

    // Stated as the delta the filter must produce, so the assertion holds
    // whatever the provider-scoped live parse contributes.
    clearSessionCache()
    const unfiltered = await buildDurablePeriod({ range, label: 'p' }, { provider: 'claude' })
    clearSessionCache()
    const filtered = await buildDurablePeriod({ range, label: 'p' }, { provider: 'claude', exclude: ['drop-me'] })

    expect(unfiltered.data.cost - filtered.data.cost).toBeCloseTo(DROP.cost, 6)
    expect(unfiltered.data.calls - filtered.data.calls).toBe(DROP.calls)
  })

  it('keeps the menubar payload in step with the report under a project filter', async () => {
    await seedCache(carriedDayWithProjects(daysAgoStr(10)))
    await seedLiveTodaySession()
    const range = coveringRange()

    clearSessionCache()
    const menubar = await buildMenubarPayloadForRange({ range, label: 'p' }, { provider: 'all', exclude: ['drop-me'], optimize: false, timeline: false })
    clearSessionCache()
    const durable = await buildDurablePeriod({ range, label: 'p' }, { provider: 'all', exclude: ['drop-me'] })

    // Both surfaces route the headline through the one shared builder, so a
    // project filter must land on them identically.
    expect(menubar.current.cost).toBe(durable.data.cost)
    expect(menubar.current.calls).toBe(durable.data.calls)
    expect(menubar.current.inputTokens).toBe(durable.data.inputTokens)
  })

  it('slices the provider list by the project filter so it reconciles with the headline', async () => {
    await seedCache(carriedDayTwoProviders(daysAgoStr(10)))
    const range = coveringRange()

    clearSessionCache()
    const menubar = await buildMenubarPayloadForRange({ range, label: 'p' }, { provider: 'all', exclude: ['drop-me'], optimize: false, timeline: false })

    const providers = menubar.current.providers
    const providerSum = Object.values(providers).reduce((a, b) => a + b, 0)

    // The headline already honours the filter; the provider list used to be built
    // from unfiltered cache days, so it kept reporting codex's excluded spend.
    expect(menubar.current.cost).toBeCloseTo(KEEP.cost, 6)
    expect(providerSum).toBeCloseTo(menubar.current.cost, 6)
    expect(providers['claude']).toBeCloseTo(KEEP.cost, 6)
    expect(providers['codex'] ?? 0).toBeCloseTo(0, 6)
  })

  it('leaves the provider list untouched when no project filter is given', async () => {
    await seedCache(carriedDayTwoProviders(daysAgoStr(10)))
    const range = coveringRange()

    clearSessionCache()
    const menubar = await buildMenubarPayloadForRange({ range, label: 'p' }, { provider: 'all', optimize: false, timeline: false })

    expect(menubar.current.providers['claude']).toBeCloseTo(KEEP.cost, 6)
    expect(menubar.current.providers['codex']).toBeCloseTo(DROP.cost, 6)
    expect(menubar.current.cost).toBeCloseTo(DAY_COST, 6)
  })

  it('leaves the unfiltered headline exactly as it was', async () => {
    await seedCache(carriedDayWithProjects(daysAgoStr(10)))
    await seedLiveTodaySession()
    const range = coveringRange()

    const live = await liveOnly(range, [], [])
    clearSessionCache()
    const durable = await buildDurablePeriod({ range, label: 'p' }, { provider: 'all' })

    expect(durable.data.cost).toBeCloseTo(live.cost + DAY_COST, 6)
    expect(durable.data.calls).toBe(live.calls + DAY_CALLS)
    expect(durable.carriedCostUSD).toBeCloseTo(DAY_COST, 6)
  })
})

describe('carried days with no per-project split (pre-v15)', () => {
  it('sets the unfilterable day aside instead of leaking it into a filtered headline', async () => {
    await seedCache(carriedDayWithoutProjects(daysAgoStr(10)))
    await seedLiveTodaySession()
    const range = coveringRange()

    const live = await liveOnly(range, [], ['drop-me'])
    clearSessionCache()
    const durable = await buildDurablePeriod({ range, label: 'p' }, { provider: 'all', exclude: ['drop-me'] })

    // The day cannot be attributed to any project, so a project-filtered total
    // cannot claim it. It is reported separately rather than silently folded in.
    expect(durable.data.cost).toBeCloseTo(live.cost, 6)
    expect(durable.unattributedCostUSD).toBeCloseTo(DAY_COST, 6)
  })

  it('reports a provider slice with no project split as unattributed too', async () => {
    // A v14-era provider slice carried into a v15 day: the day knows its project
    // split, that provider's slice does not. Under --provider the headline reads
    // the slice, so the day drops out — say how much rather than lose it quietly.
    const day = carriedDayWithProjects(daysAgoStr(10))
    delete day.providers['claude']!.projects
    await seedCache(day)
    await seedLiveTodaySession()
    const range = coveringRange()

    clearSessionCache()
    const durable = await buildDurablePeriod({ range, label: 'p' }, { provider: 'claude', exclude: ['drop-me'] })

    expect(durable.unattributedCostUSD).toBeCloseTo(DAY_COST, 6)
    expect(durable.carriedCostUSD).toBe(0)
  })

  it('says so in the overview instead of just showing a short total', async () => {
    // Two cached days: one that cannot be attributed (the footnote's subject) and
    // one that can. The attributable day keeps the headline non-zero from the
    // CACHE alone, so the assertion tests the footnote rather than depending on
    // the live parse to keep renderOverview off its "No usage found" path.
    await seedCache(carriedDayWithoutProjects(daysAgoStr(10)), carriedDayWithProjects(daysAgoStr(5)))
    await seedLiveTodaySession()
    const range = coveringRange()

    clearSessionCache()
    const durable = await buildDurablePeriod({ range, label: 'This month' }, { provider: 'all', exclude: ['drop-me'] })
    expect(durable.unattributedCostUSD).toBeGreaterThan(0)
    expect(durable.data.cost).toBeGreaterThan(0)

    const rendered = renderOverview(durable.liveProjects, {
      label: 'This month',
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
        unattributedCostUSD: durable.unattributedCostUSD,
      },
    })
    expect(rendered).toContain('no per-project history')
  })

  it('still counts the day in full when no project filter is active', async () => {
    await seedCache(carriedDayWithoutProjects(daysAgoStr(10)))
    await seedLiveTodaySession()
    const range = coveringRange()

    const live = await liveOnly(range, [], [])
    clearSessionCache()
    const durable = await buildDurablePeriod({ range, label: 'p' }, { provider: 'all' })

    expect(durable.data.cost).toBeCloseTo(live.cost + DAY_COST, 6)
    expect(durable.unattributedCostUSD).toBe(0)
  })
})
