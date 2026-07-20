import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { ProjectSummary } from '../src/types.js'
import { buildPeriodDataFromDays } from '../src/day-aggregator.js'

import {
  DAILY_CACHE_VERSION,
  type DailyCache,
  type DailyEntry,
  type ProviderDaySlice,
  currentTzKey,
  dailyCachePath,
  ensureCacheHydrated,
  loadDailyCache,
  mergeDayEntries,
  saveDailyCache,
} from '../src/daily-cache.js'

const TMP_CACHE_ROOT = join(tmpdir(), `codeburn-carry-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)

beforeEach(async () => {
  process.env['CODEBURN_CACHE_DIR'] = TMP_CACHE_ROOT
  await mkdir(TMP_CACHE_ROOT, { recursive: true })
})

afterEach(async () => {
  if (existsSync(TMP_CACHE_ROOT)) {
    await rm(TMP_CACHE_ROOT, { recursive: true, force: true })
  }
})

function slice(cost: number, calls: number, extra: Partial<ProviderDaySlice> = {}): ProviderDaySlice {
  return { cost, calls, savingsUSD: 0, ...extra }
}

function day(date: string, providers: Record<string, ProviderDaySlice>, overrides: Partial<DailyEntry> = {}): DailyEntry {
  const cost = Object.values(providers).reduce((s, p) => s + p.cost, 0)
  const calls = Object.values(providers).reduce((s, p) => s + p.calls, 0)
  return {
    date,
    cost,
    savingsUSD: 0,
    calls,
    sessions: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    editTurns: 0,
    oneShotTurns: 0,
    models: {},
    categories: {},
    providers,
    ...overrides,
  }
}

function daysAgoStr(n: number): string {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const noSessions = async (): Promise<ProjectSummary[]> => []

describe('mergeDayEntries', () => {
  it('keeps primary-only and secondary-only days; secondary days get the carried mark', () => {
    const merged = mergeDayEntries(
      [day('2026-06-01', { claude: slice(10, 2) })],
      [day('2026-05-01', { claude: slice(5, 1) })],
      true,
    )
    expect(merged.map(d => d.date)).toEqual(['2026-05-01', '2026-06-01'])
    expect(merged[0]!.carried).toBe(true)
    expect(merged[1]!.carried).toBeUndefined()
  })

  it('primary wins per provider on shared dates — no overwrite, no double count', () => {
    const merged = mergeDayEntries(
      [day('2026-06-01', { claude: slice(50, 5) })],
      [day('2026-06-01', { claude: slice(100, 10) })],
      true,
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]!.cost).toBe(50)
    expect(merged[0]!.providers['claude']!.cost).toBe(50)
    expect(merged[0]!.carried).toBeUndefined()
  })

  it('fills provider slices missing from primary on shared dates and sums day totals', () => {
    // The real 2026-04-26 case: rebuild found only codex, the old cache still
    // had the claude slice — the merged day must hold both.
    const merged = mergeDayEntries(
      [day('2026-04-26', { codex: slice(3.28, 4) })],
      [day('2026-04-26', { codex: slice(3.28, 4), claude: slice(54.08, 120) })],
      true,
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]!.providers['codex']!.cost).toBe(3.28)
    expect(merged[0]!.providers['claude']!.cost).toBe(54.08)
    expect(merged[0]!.cost).toBeCloseTo(57.36, 5)
    expect(merged[0]!.calls).toBe(124)
    expect(merged[0]!.carried).toBe(true)
  })

  it('a rich slice carries its tokens, models, categories, and projects into the day', () => {
    const rich = slice(20, 3, {
      sessions: 2,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheWriteTokens: 100,
      editTurns: 2,
      oneShotTurns: 1,
      models: { 'opus-4-8': { calls: 3, cost: 20, savingsUSD: 0, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 100 } },
      categories: { coding: { turns: 3, cost: 20, savingsUSD: 0, editTurns: 2, oneShotTurns: 1 } },
      projects: { eywa: { cost: 15, calls: 2, savingsUSD: 0, sessions: 1 }, codeburn: { cost: 5, calls: 1, savingsUSD: 0, sessions: 1 } },
    })
    const merged = mergeDayEntries(
      [day('2026-06-01', { codex: slice(1, 1, { projects: { codeburn: { cost: 1, calls: 1, savingsUSD: 0, sessions: 1 } } }) }, { projects: { codeburn: { cost: 1, calls: 1, savingsUSD: 0, sessions: 1 } } })],
      [day('2026-06-01', { claude: rich })],
      true,
    )
    const m = merged[0]!
    expect(m.cost).toBe(21)
    expect(m.sessions).toBe(2)
    expect(m.inputTokens).toBe(1000)
    expect(m.outputTokens).toBe(500)
    expect(m.editTurns).toBe(2)
    expect(m.oneShotTurns).toBe(1)
    expect(m.models['opus-4-8']!.cost).toBe(20)
    expect(m.categories['coding']!.turns).toBe(3)
    // Projects from the carried claude slice fold into the day's project map,
    // summing with the fresh codex contribution on the shared project.
    expect(m.projects!['eywa']).toEqual({ cost: 15, calls: 2, savingsUSD: 0, sessions: 1 })
    expect(m.projects!['codeburn']).toEqual({ cost: 6, calls: 2, savingsUSD: 0, sessions: 2 })
  })

  it('a skinny pre-v14 slice still restores exact cost/calls/savings', () => {
    const merged = mergeDayEntries(
      [day('2026-06-01', { codex: slice(1, 1) })],
      [day('2026-06-01', { claude: { calls: 7, cost: 13.42, savingsUSD: 2 } })],
      true,
    )
    expect(merged[0]!.cost).toBeCloseTo(14.42, 5)
    expect(merged[0]!.calls).toBe(8)
    expect(merged[0]!.savingsUSD).toBe(2)
  })

  it('an empty-providers secondary day cannot contribute to an existing date', () => {
    const merged = mergeDayEntries(
      [day('2026-06-01', { claude: slice(10, 2) })],
      [day('2026-06-01', {}, { cost: 999, calls: 999 })],
      true,
    )
    expect(merged[0]!.cost).toBe(10)
    expect(merged[0]!.carried).toBeUndefined()
  })

  it('never slice-fills an OPAQUE day (totals but empty providers) — no double count', () => {
    // Adversarial-review finding: an adopted pre-v5 day has day totals that
    // already CONTAIN every provider's share, but no slices to dedupe against.
    // Filling a codex slice into it would double-count codex.
    const opaque = day('2026-07-15', {}, { cost: 10, calls: 5 })
    const merged = mergeDayEntries([opaque], [day('2026-07-15', { codex: slice(3, 1) })], false)
    expect(merged).toHaveLength(1)
    expect(merged[0]!.cost).toBe(10)
    expect(merged[0]!.calls).toBe(5)
    expect(merged[0]!.providers).toEqual({})
  })

  it('a zero-data placeholder slice does not block a carried slice', () => {
    // Adversarial-review finding: a session that starts on day X with all its
    // turns landing on X+1 leaves a {sessions: 1, calls: 0, cost: 0} slice on
    // X. That placeholder must not suppress the baseline's real X data.
    const placeholder = day('2026-07-10', { claude: slice(0, 0, { sessions: 1 }) }, { sessions: 1 })
    const baseline = day('2026-07-10', { claude: slice(8, 2, { sessions: 1 }) }, { sessions: 1 })
    const merged = mergeDayEntries([placeholder], [baseline], true)
    expect(merged[0]!.providers['claude']).toMatchObject({ cost: 8, calls: 2 })
    // The same real session may be counted on both sides — deduplicated by max.
    expect(merged[0]!.providers['claude']!.sessions).toBe(1)
    expect(merged[0]!.sessions).toBe(1)
    expect(merged[0]!.cost).toBe(8)
    expect(merged[0]!.carried).toBe(true)
  })

  it('does not double-count a project session across a placeholder merge', () => {
    // v15-review finding: the placeholder's project sessions were already
    // counted into the fresh day; folding the carried slice must only add the
    // excess, and day/provider/project session totals must reconcile.
    const placeholder = day('2026-06-01', {
      claude: slice(0, 0, { sessions: 1, projects: { P: { cost: 0, calls: 0, savingsUSD: 0, sessions: 1 } } }),
    }, { sessions: 1, projects: { P: { cost: 0, calls: 0, savingsUSD: 0, sessions: 1 } } })
    const carried = day('2026-06-01', {
      claude: slice(0, 0, { sessions: 1, projects: { P: { cost: 0, calls: 0, savingsUSD: 0, sessions: 1 } } }),
    }, { sessions: 1, projects: { P: { cost: 0, calls: 0, savingsUSD: 0, sessions: 1 } } })
    const merged = mergeDayEntries([placeholder], [carried], true)
    expect(merged[0]!.sessions).toBe(1)
    expect(merged[0]!.projects!['P']!.sessions).toBe(1)
    expect(merged[0]!.providers['claude']!.sessions).toBe(1)
  })

  it('survives junk project data from foreign caches without crashing or corrupting', () => {
    const junkSlice = slice(5, 2, {
      projects: { good: { cost: 5, calls: 2, savingsUSD: 0, sessions: 1 }, bad: null, worse: [1, 2], strings: { cost: 'x', calls: 2 } } as never,
    })
    const merged = mergeDayEntries([day('2026-06-01', { codex: slice(1, 1) })], [day('2026-06-01', { claude: junkSlice })], true)
    expect(merged[0]!.projects!['good']).toEqual({ cost: 5, calls: 2, savingsUSD: 0, sessions: 1 })
    expect(merged[0]!.projects!['bad']).toBeUndefined()
    expect(merged[0]!.projects!['worse']).toBeUndefined()
    expect(merged[0]!.projects!['strings']).toEqual({ cost: 0, calls: 2, savingsUSD: 0, sessions: 0 })
  })

  it('a project named __proto__ becomes an own key, never prototype pollution', () => {
    const evil = slice(3, 1, { projects: { ['__proto__']: { cost: 3, calls: 1, savingsUSD: 0, sessions: 1 } } })
    const merged = mergeDayEntries([day('2026-06-01', { codex: slice(1, 1) })], [day('2026-06-01', { claude: evil })], true)
    expect(Object.hasOwn(merged[0]!.projects!, '__proto__')).toBe(true)
    expect(merged[0]!.projects!['__proto__' as string]).toMatchObject({ cost: 3 })
    expect(({} as Record<string, unknown>)['cost']).toBeUndefined()
  })

  it('a hostile __proto__ provider/model/category key becomes an own key on merge', () => {
    const hostile = day('2026-06-01', Object.defineProperty({}, '__proto__', {
      value: slice(4, 2, {
        models: { ['__proto__']: { calls: 2, cost: 4, savingsUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } as never,
        categories: { ['__proto__']: { turns: 1, cost: 4, savingsUSD: 0, editTurns: 0, oneShotTurns: 0 } } as never,
      }),
      enumerable: true, writable: true, configurable: true,
    }) as Record<string, ProviderDaySlice>)
    const merged = mergeDayEntries([day('2026-06-01', { codex: slice(1, 1) })], [hostile], true)
    expect(Object.hasOwn(merged[0]!.providers, '__proto__')).toBe(true)
    expect(Object.hasOwn(merged[0]!.models, '__proto__')).toBe(true)
    expect(Object.hasOwn(merged[0]!.categories, '__proto__')).toBe(true)
    expect(merged[0]!.cost).toBe(5)
    expect(({} as Record<string, unknown>)['cost']).toBeUndefined()
    expect(({} as Record<string, unknown>)['calls']).toBeUndefined()
  })

  it('does not mutate its inputs', () => {
    const primary = [day('2026-06-01', { codex: slice(1, 1) })]
    const secondary = [day('2026-06-01', { claude: slice(5, 2) })]
    mergeDayEntries(primary, secondary, true)
    expect(primary[0]!.cost).toBe(1)
    expect(Object.keys(primary[0]!.providers)).toEqual(['codex'])
    expect(secondary[0]!.carried).toBeUndefined()
  })
})

describe('never-lose invariant: invalidations with vanished sources', () => {
  const seededDay = () => day(daysAgoStr(30), { claude: slice(230.06, 400), codex: slice(79.29, 60) })

  async function seed(overrides: Partial<DailyCache> = {}): Promise<DailyEntry> {
    const d = seededDay()
    const cache: DailyCache = {
      version: DAILY_CACHE_VERSION,
      savingsConfigHash: 'cfg-A',
      tzKey: currentTzKey(),
      lastComputedDate: daysAgoStr(1),
      days: [d],
      complete: true,
      ...overrides,
    }
    await saveDailyCache(cache)
    return d
  }

  it('savings-hash change with an empty re-parse keeps the day (carried)', async () => {
    const d = await seed()
    const out = await ensureCacheHydrated(noSessions, () => [], 'cfg-B')
    expect(out.days).toHaveLength(1)
    expect(out.days[0]).toMatchObject({ date: d.date, cost: d.cost, calls: d.calls, carried: true })
    expect(out.days[0]!.providers['claude']!.cost).toBe(230.06)
    expect(out.days[0]!.providers['codex']!.cost).toBe(79.29)
  })

  it('timezone change with an empty re-parse keeps the day (carried)', async () => {
    const d = await seed({ tzKey: 'Test/OtherZone' })
    const out = await ensureCacheHydrated(noSessions, () => [], 'cfg-A')
    expect(out.days[0]).toMatchObject({ date: d.date, cost: d.cost, carried: true })
    expect(out.tzKey).toBe(currentTzKey())
  })

  it('incomplete-cache retry with an empty re-parse keeps the day', async () => {
    const d = await seed({ complete: false })
    const out = await ensureCacheHydrated(noSessions, () => [], 'cfg-A')
    expect(out.days[0]).toMatchObject({ date: d.date, cost: d.cost, carried: true })
    expect(out.complete).toBe(true)
  })

  it('a version bump (current file absent, old-version file remains) keeps the day', async () => {
    const d = await seed()
    // Simulate the upgrade: the new binary's filename does not exist yet; the
    // previous version's file (older internal schema version) is still in the
    // cache dir under its old name.
    const oldContent = JSON.parse(await readFile(dailyCachePath(), 'utf-8'))
    oldContent.version = DAILY_CACHE_VERSION - 1
    await writeFile(join(TMP_CACHE_ROOT, `daily-cache.v${DAILY_CACHE_VERSION - 1}.json`), JSON.stringify(oldContent), 'utf-8')
    await rm(dailyCachePath())
    const out = await ensureCacheHydrated(noSessions, () => [], 'cfg-A')
    expect(out.days).toHaveLength(1)
    expect(out.days[0]).toMatchObject({ date: d.date, cost: d.cost, calls: d.calls, carried: true })
  })

  it('a same-version file found under an old name is trusted as-is (no spurious rebuild)', async () => {
    const d = await seed()
    await rename(dailyCachePath(), join(TMP_CACHE_ROOT, 'daily-cache.json'))
    const out = await ensureCacheHydrated(noSessions, () => [], 'cfg-A')
    expect(out.days).toHaveLength(1)
    expect(out.days[0]).toMatchObject({ date: d.date, cost: d.cost, calls: d.calls })
    expect(out.days[0]!.carried).toBeUndefined()
    expect(out.complete).toBe(true)
  })

  it('survives a whole gauntlet: version bump, then hash change, then tz change', async () => {
    const d = await seed()
    await rename(dailyCachePath(), join(TMP_CACHE_ROOT, 'daily-cache.v9.json.bak'))
    await ensureCacheHydrated(noSessions, () => [], 'cfg-B')
    await ensureCacheHydrated(noSessions, () => [], 'cfg-C')
    const tampered = await loadDailyCache()
    await saveDailyCache({ ...tampered, tzKey: 'Test/OtherZone' })
    const out = await ensureCacheHydrated(noSessions, () => [], 'cfg-C')
    expect(out.days).toHaveLength(1)
    expect(out.days[0]).toMatchObject({ date: d.date, cost: d.cost, calls: d.calls })
    expect(out.days[0]!.providers['claude']!.cost).toBe(230.06)
  })

  it('corrections still land: a re-derivable day takes the fresh (lower) value, not the old one', async () => {
    const target = daysAgoStr(30)
    await seed()
    // The kiro-style correction: the fresh parse re-derives this day at a much
    // lower, correct cost. Fresh must WIN for the provider it re-derived.
    const corrected = [day(target, { claude: slice(14.0, 400) })]
    const out = await ensureCacheHydrated(noSessions, () => corrected, 'cfg-B')
    expect(out.days).toHaveLength(1)
    expect(out.days[0]!.providers['claude']!.cost).toBe(14.0)
    // codex was NOT re-derived (its files are gone) → carried forward.
    expect(out.days[0]!.providers['codex']!.cost).toBe(79.29)
    expect(out.days[0]!.cost).toBeCloseTo(14.0 + 79.29, 5)
    expect(out.days[0]!.carried).toBe(true)
  })

  it('a PARTIAL session parse cannot overwrite finalized days with undercounts', async () => {
    const target = daysAgoStr(30)
    await seed({ complete: false })
    // Interrupted hydration: the parse only saw half the claude turns.
    const partial = [day(target, { claude: slice(100.0, 150) })]
    const out = await ensureCacheHydrated(noSessions, () => partial, 'cfg-A', () => false)
    // Baseline wins per (date, provider); the undercount is discarded.
    expect(out.days[0]!.providers['claude']!.cost).toBe(230.06)
    expect(out.days[0]!.providers['codex']!.cost).toBe(79.29)
    // Still not finalized — the next complete parse gets to correct for real.
    expect(out.complete).toBe(false)
  })

  it('a partial parse still fills days the baseline lacks entirely', async () => {
    await seed({ complete: false })
    const newDate = daysAgoStr(10)
    const partial = [day(newDate, { grok: slice(6.29, 9) })]
    const out = await ensureCacheHydrated(noSessions, () => partial, 'cfg-A', () => false)
    expect(out.days.map(d => d.date)).toEqual([daysAgoStr(30), newDate])
    expect(out.days[1]!.providers['grok']!.cost).toBe(6.29)
  })

  it('a partial parse cannot double into an opaque adopted day', async () => {
    // The full adversarial-review repro: a pre-v5 cache day with totals but no
    // provider slices is adopted, then a PARTIAL parse produces a codex slice
    // for the same date. The opaque day must stand untouched at $10/5.
    const target = daysAgoStr(5)
    const ancient = { version: 2, days: [{ date: target, cost: 10, calls: 5 }] }
    await writeFile(join(TMP_CACHE_ROOT, 'daily-cache.json'), JSON.stringify(ancient), 'utf-8')
    const partial = [day(target, { codex: slice(3, 1) })]
    const out = await ensureCacheHydrated(noSessions, () => partial, '', () => false)
    const merged = out.days.find(d => d.date === target)!
    expect(merged.cost).toBe(10)
    expect(merged.calls).toBe(5)
    expect(merged.providers).toEqual({})
    expect(out.complete).toBe(false)
  })

  it('carried days cannot resurrect a today/future entry', async () => {
    const today = daysAgoStr(0)
    await seed({ days: [seededDay(), day(today, { claude: slice(99, 9) })], complete: false })
    const out = await ensureCacheHydrated(noSessions, () => [], 'cfg-A')
    expect(out.days.map(d => d.date)).toEqual([daysAgoStr(30)])
  })

  it('retention still prunes ancient carried days after a rebuild', async () => {
    await seed({ days: [seededDay(), day('2020-01-01', { claude: slice(1, 1) })], complete: false })
    const out = await ensureCacheHydrated(noSessions, () => [], 'cfg-A')
    expect(out.days.map(d => d.date)).toEqual([daysAgoStr(30)])
  })
})

describe('adoption union across older cache files', () => {
  it('reconstructs the fullest history from every older daily-cache file, .bak included', async () => {
    // The real machine scenario, miniaturized: a v13 file whose rebuild lost
    // the old claude slices, a v9 .bak that still has them, and a legacy v10
    // written by an installed app. Higher version wins per (date, provider);
    // lower versions only extend.
    const v13 = {
      version: 13,
      savingsConfigHash: '',
      lastComputedDate: '2026-07-17',
      complete: true,
      days: [
        day('2026-04-26', { codex: slice(3.28, 4) }),
        day('2026-06-13', { claude: slice(230.06, 400), codex: slice(79.29, 60) }),
      ],
    }
    const v9bak = {
      version: 9,
      lastComputedDate: '2026-07-02',
      days: [
        day('2026-04-26', { codex: slice(3.9, 5), claude: slice(54.08, 120) }),
        day('2026-05-03', { claude: slice(9.27, 15) }),
      ],
    }
    const legacyV10 = {
      version: 10,
      lastComputedDate: '2026-07-19',
      days: [
        day('2026-05-20', { cursor: slice(0.01, 1) }),
      ],
    }
    await writeFile(join(TMP_CACHE_ROOT, 'daily-cache.v13.json'), JSON.stringify(v13), 'utf-8')
    await writeFile(join(TMP_CACHE_ROOT, 'daily-cache.json.v9.bak'), JSON.stringify(v9bak), 'utf-8')
    await writeFile(join(TMP_CACHE_ROOT, 'daily-cache.json'), JSON.stringify(legacyV10), 'utf-8')

    const cache = await loadDailyCache()
    expect(cache.version).toBe(DAILY_CACHE_VERSION)
    expect(cache.days.map(d => d.date)).toEqual(['2026-04-26', '2026-05-03', '2026-05-20', '2026-06-13'])
    const apr26 = cache.days[0]!
    // codex from v13 (higher version wins), claude rescued from the v9 .bak.
    expect(apr26.providers['codex']!.cost).toBe(3.28)
    expect(apr26.providers['claude']!.cost).toBe(54.08)
    expect(apr26.cost).toBeCloseTo(57.36, 5)
    expect(apr26.carried).toBe(true)
    expect(cache.days[1]!.providers['claude']!.cost).toBe(9.27)
    expect(cache.days[2]!.providers['cursor']!.cost).toBe(0.01)
    // Adopted history is pending re-derivation.
    expect(cache.complete).not.toBe(true)
    // The v14 file is persisted so adoption is one-time.
    expect(existsSync(dailyCachePath())).toBe(true)
    // None of the source files were touched.
    expect(JSON.parse(await readFile(join(TMP_CACHE_ROOT, 'daily-cache.v13.json'), 'utf-8'))).toEqual(JSON.parse(JSON.stringify(v13)))
    expect(JSON.parse(await readFile(join(TMP_CACHE_ROOT, 'daily-cache.json.v9.bak'), 'utf-8'))).toEqual(JSON.parse(JSON.stringify(v9bak)))
  })

  it('skips malformed candidates without failing the adoption', async () => {
    const good = {
      version: 12,
      lastComputedDate: '2026-07-01',
      days: [day('2026-06-01', { claude: slice(10, 2) })],
    }
    await writeFile(join(TMP_CACHE_ROOT, 'daily-cache.v12.json'), JSON.stringify(good), 'utf-8')
    await writeFile(join(TMP_CACHE_ROOT, 'daily-cache.v13.json'), 'not json at all {{', 'utf-8')
    await writeFile(join(TMP_CACHE_ROOT, 'daily-cache.v14.json.deadbeef.tmp'), 'truncated{', 'utf-8')
    const cache = await loadDailyCache()
    expect(cache.days).toHaveLength(1)
    expect(cache.days[0]).toMatchObject({ date: '2026-06-01', cost: 10, carried: true })
  })

  it('rescues a fully-written .tmp left by a crash before rename', async () => {
    // Adversarial-review finding: the atomic write completes (content synced)
    // but the process dies before rename. The .tmp is then the ONLY copy of
    // the newest state; a parseable one must be adopted.
    const onlyCopy = {
      version: 13,
      days: [day(daysAgoStr(15), { claude: slice(88, 11) })],
    }
    await writeFile(join(TMP_CACHE_ROOT, 'daily-cache.v13.json.a1b2c3d4.tmp'), JSON.stringify(onlyCopy), 'utf-8')
    const cache = await loadDailyCache()
    expect(cache.days).toHaveLength(1)
    expect(cache.days[0]).toMatchObject({ date: daysAgoStr(15), cost: 88, carried: true })
  })

  it('adoption purges today/future entries and applies retention before persisting', async () => {
    // Adversarial-review finding: loadDailyCache has standalone readers, so a
    // frozen today entry or a 2023 day must not survive adoption itself.
    const old = {
      version: 13,
      days: [
        day('2023-01-01', { claude: slice(1, 1) }),
        day(daysAgoStr(15), { claude: slice(5, 2) }),
        day(daysAgoStr(0), { claude: slice(99, 9) }),
      ],
    }
    await writeFile(join(TMP_CACHE_ROOT, 'daily-cache.v13.json'), JSON.stringify(old), 'utf-8')
    const cache = await loadDailyCache()
    expect(cache.days.map(d => d.date)).toEqual([daysAgoStr(15)])
  })

  it('drops malformed day entries but keeps the valid ones', async () => {
    const mixed = {
      version: 11,
      days: [
        day('2026-06-01', { claude: slice(10, 2) }),
        { date: 'garbage', cost: 5 },
        { cost: 7 },
        { date: '2026-06-02', cost: 'NaN-ish' },
      ],
    }
    await writeFile(join(TMP_CACHE_ROOT, 'daily-cache.v11.json'), JSON.stringify(mixed), 'utf-8')
    const cache = await loadDailyCache()
    expect(cache.days.map(d => d.date)).toEqual(['2026-06-01', '2026-06-02'])
    expect(cache.days[0]!.cost).toBe(10)
    expect(cache.days[1]!.cost).toBe(0)
  })

  it('sanitizes junk inside provider slices at migration, not just at fold time', async () => {
    // v15-closure finding: slice-level junk survived structuredClone into the
    // next cache generation. Migration must scrub it.
    const dirty = {
      version: 13,
      days: [{
        date: daysAgoStr(20), cost: 5, calls: 2,
        providers: {
          claude: { calls: 2, cost: '5', savingsUSD: null, projects: { good: { cost: 5, calls: 2 }, bad: [1] } },
          junk: [1, 2],
        },
      }],
    }
    await writeFile(join(TMP_CACHE_ROOT, 'daily-cache.v13.json'), JSON.stringify(dirty), 'utf-8')
    const cache = await loadDailyCache()
    const claude = cache.days[0]!.providers['claude']!
    expect(claude).toMatchObject({ calls: 2, cost: 0, savingsUSD: 0 })
    expect(claude.projects).toEqual({ good: { cost: 5, calls: 2, savingsUSD: 0, sessions: 0 } })
    expect(cache.days[0]!.providers['junk']).toBeUndefined()
  })

  it('rescues older files even when the current versioned file is corrupt', async () => {
    const old = {
      version: 13,
      days: [day('2026-06-01', { claude: slice(42, 7) })],
    }
    await writeFile(join(TMP_CACHE_ROOT, 'daily-cache.v13.json'), JSON.stringify(old), 'utf-8')
    await writeFile(dailyCachePath(), 'corrupted{{{', 'utf-8')
    const cache = await loadDailyCache()
    expect(cache.days).toHaveLength(1)
    expect(cache.days[0]).toMatchObject({ date: '2026-06-01', cost: 42, carried: true })
  })

  it('adopted carried days then survive a hydration whose parse finds nothing', async () => {
    const old = {
      version: 13,
      days: [day(daysAgoStr(40), { claude: slice(409.62, 900) })],
    }
    await writeFile(join(TMP_CACHE_ROOT, 'daily-cache.v13.json'), JSON.stringify(old), 'utf-8')
    const out = await ensureCacheHydrated(noSessions, () => [], '')
    expect(out.days).toHaveLength(1)
    expect(out.days[0]).toMatchObject({ date: daysAgoStr(40), cost: 409.62, carried: true })
    expect(out.complete).toBe(true)

    // And KEEP surviving on subsequent normal hydrations.
    const again = await ensureCacheHydrated(noSessions, () => [], '')
    expect(again.days).toHaveLength(1)
    expect(again.days[0]!.cost).toBe(409.62)
  })

  it('clamps a stale lastComputedDate when adoption purges a frozen today entry', async () => {
    // Verification-pass finding: a trusted same-version candidate carrying
    // lastComputedDate = today (clock skew) would make hydration skip the gap
    // parse forever after the today entry is purged.
    const today = daysAgoStr(0)
    const trusted = {
      version: DAILY_CACHE_VERSION,
      savingsConfigHash: '',
      tzKey: currentTzKey(),
      lastComputedDate: today,
      complete: true,
      days: [day(daysAgoStr(3), { claude: slice(5, 2) }), day(today, { claude: slice(9, 1) })],
    }
    await writeFile(join(TMP_CACHE_ROOT, 'daily-cache.json'), JSON.stringify(trusted), 'utf-8')
    const cache = await loadDailyCache()
    expect(cache.days.map(d => d.date)).toEqual([daysAgoStr(3)])
    expect(cache.lastComputedDate).toBe(daysAgoStr(3))
    // Hydration can now fill the gap up to yesterday instead of skipping it.
    let parsed = 0
    await ensureCacheHydrated(async () => { parsed += 1; return [] }, () => [], '')
    expect(parsed).toBe(1)
  })

  it('preserves a carried sessions-only slice (its calls landed on the next day)', () => {
    const fresh = day('2026-07-10', { codex: slice(3, 1) })
    const baseline = day('2026-07-10', { claude: slice(0, 0, { sessions: 1 }) }, { sessions: 1 })
    const merged = mergeDayEntries([fresh], [baseline], true)
    expect(merged[0]!.providers['claude']!.sessions).toBe(1)
    expect(merged[0]!.sessions).toBe(1)
    expect(merged[0]!.cost).toBe(3)
    expect(merged[0]!.carried).toBe(true)
  })

  it('round-trips carried marks and rich slices through save/load', async () => {
    const rich = day(daysAgoStr(20), {
      claude: slice(20, 3, {
        sessions: 2,
        inputTokens: 1000,
        models: { 'opus-4-8': { calls: 3, cost: 20, savingsUSD: 0, inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
        categories: { coding: { turns: 3, cost: 20, savingsUSD: 0, editTurns: 1, oneShotTurns: 1 } },
      }),
    }, { carried: true })
    const cache: DailyCache = {
      version: DAILY_CACHE_VERSION,
      savingsConfigHash: '',
      tzKey: currentTzKey(),
      lastComputedDate: daysAgoStr(1),
      days: [rich],
      complete: true,
    }
    await saveDailyCache(cache)
    const loaded = await loadDailyCache()
    expect(loaded).toEqual(cache)
  })

  it('sanitizes malformed day-level model and category maps during load', async () => {
    const target = daysAgoStr(20)
    const dirty = {
      version: DAILY_CACHE_VERSION,
      savingsConfigHash: '',
      tzKey: currentTzKey(),
      lastComputedDate: daysAgoStr(1),
      complete: true,
      days: [{
        ...day(target, { claude: slice(5, 2) }),
        models: 'bad',
        categories: 9,
      }],
    }
    await writeFile(dailyCachePath(), JSON.stringify(dirty), 'utf-8')

    const loaded = await loadDailyCache()

    expect(loaded.days[0]!.models).toEqual({})
    expect(loaded.days[0]!.categories).toEqual({})
  })

  it('drops inherited provider and model keys before period aggregation', async () => {
    const target = daysAgoStr(20)
    const modelStats = {
      calls: 1,
      cost: 2,
      savingsUSD: 0,
      inputTokens: 3,
      outputTokens: 4,
      cacheReadTokens: 5,
      cacheWriteTokens: 6,
    }
    const dirty = {
      version: DAILY_CACHE_VERSION,
      savingsConfigHash: '',
      tzKey: currentTzKey(),
      lastComputedDate: daysAgoStr(1),
      complete: true,
      days: [{
        ...day(target, {
          toString: slice(2, 1),
          safeProvider: slice(3, 1),
        }),
        models: {
          constructor: modelStats,
          safeModel: modelStats,
        },
      }],
    }
    await writeFile(dailyCachePath(), JSON.stringify(dirty), 'utf-8')

    const loaded = await loadDailyCache()
    const loadedDay = loaded.days[0]!
    let period: ReturnType<typeof buildPeriodDataFromDays>
    try {
      period = buildPeriodDataFromDays(loaded.days, 'loaded')
    } finally {
      const objectConstructor = Object as typeof Object & Record<string, unknown>
      delete objectConstructor.calls
      delete objectConstructor.cost
      delete objectConstructor.savingsUSD
    }

    expect(Object.hasOwn(loadedDay.providers, 'toString')).toBe(false)
    expect(Object.hasOwn(loadedDay.models, 'constructor')).toBe(false)
    const assertFiniteNumbers = (value: unknown): void => {
      if (typeof value === 'number') {
        expect(Number.isFinite(value)).toBe(true)
      } else if (value && typeof value === 'object') {
        for (const child of Object.values(value)) assertFiniteNumbers(child)
      }
    }
    assertFiniteNumbers(period)
  })

  it('sanitizes a non-string lastComputedDate before hydration parses it', async () => {
    const dirty = {
      version: DAILY_CACHE_VERSION,
      savingsConfigHash: '',
      tzKey: currentTzKey(),
      lastComputedDate: 42,
      complete: true,
      days: [],
    }
    await writeFile(dailyCachePath(), JSON.stringify(dirty), 'utf-8')

    const loaded = await loadDailyCache()
    expect(loaded.days).toEqual([])

    const hydrated = await ensureCacheHydrated(noSessions, () => [], '')

    expect(loaded.lastComputedDate).toBeNull()
    expect(hydrated.complete).toBe(true)
  })
})
