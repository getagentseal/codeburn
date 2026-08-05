import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { DateRange, ProjectSummary } from '../src/types.js'

import {
  DAILY_CACHE_VERSION,
  type DailyCache,
  type DailyEntry,
  type ProviderDaySlice,
  currentTzKey,
  ensureCacheHydrated,
  saveDailyCache,
} from '../src/daily-cache.js'

const TMP_CACHE_ROOT = join(tmpdir(), `codeburn-degraded-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)

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
  const d = new Date()
  d.setDate(d.getDate() - n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const noSessions = async (): Promise<ProjectSummary[]> => []

/// The day whose session files are long gone: it exists in the daily cache and
/// nowhere else, so every path below must still hand it back untouched.
const VANISHED = day(daysAgoStr(40), { claude: slice(399.70, 1572) }, { carried: true })

async function seed(overrides: Partial<DailyCache> = {}): Promise<void> {
  await saveDailyCache({
    version: DAILY_CACHE_VERSION,
    savingsConfigHash: 'cfg-A',
    tzKey: currentTzKey(),
    lastComputedDate: daysAgoStr(4),
    days: [VANISHED, day(daysAgoStr(4), { claude: slice(120, 900) })],
    complete: true,
    ...overrides,
  })
}

/** The vanished-sources day is still there, with its original accounting. */
function expectPreserved(cache: DailyCache): void {
  const kept = cache.days.find(d => d.date === VANISHED.date)
  expect(kept).toMatchObject({ cost: 399.70, calls: 1572 })
  expect(kept!.providers['claude']!.cost).toBe(399.70)
}

describe('daily cache: a degraded session parse never finalizes history', () => {
  it('does not publish complete, and does not advance the watermark past what it covered', async () => {
    await seed()
    const out = await ensureCacheHydrated(noSessions, () => [], 'cfg-A', () => false)
    // The parse covered nothing it can vouch for, so the watermark stays put:
    // advancing it to yesterday would put the missed days behind gapStart
    // (lastComputedDate + 1) forever.
    expect(out.lastComputedDate).toBe(daysAgoStr(4))
    expect(out.complete).toBe(false)
    expectPreserved(out)
  })

  it('does not advance the watermark on the full re-derive path either', async () => {
    await seed({ complete: false })
    const out = await ensureCacheHydrated(noSessions, () => [], 'cfg-A', () => false)
    expect(out.lastComputedDate).toBe(daysAgoStr(4))
    expect(out.complete).toBe(false)
    expectPreserved(out)
  })

  it('a later healthy run rebuilds the days the degraded run missed', async () => {
    await seed()
    await ensureCacheHydrated(noSessions, () => [], 'cfg-A', () => false)
    const missed = [1, 2, 3].map(n => day(daysAgoStr(n), { claude: slice(n * 10, n * 100) }))
    const healed = await ensureCacheHydrated(noSessions, () => missed, 'cfg-A', () => true)
    expect(healed.days.map(d => d.date)).toEqual([
      daysAgoStr(40), daysAgoStr(4), daysAgoStr(3), daysAgoStr(2), daysAgoStr(1),
    ])
    expect(healed.lastComputedDate).toBe(daysAgoStr(1))
    expect(healed.complete).toBe(true)
    expectPreserved(healed)
  })
})

describe('daily cache: a complete cache that outruns its own data is not trusted', () => {
  it('re-derives the days between the newest entry and the watermark', async () => {
    // The field artifact: complete: true, lastComputedDate yesterday, entries
    // stopping four days earlier — written by a run that finalized off a parse
    // which never covered those days.
    await seed({ lastComputedDate: daysAgoStr(1) })
    const ranges: DateRange[] = []
    const missed = [1, 2, 3].map(n => day(daysAgoStr(n), { claude: slice(n * 10, n * 100) }))
    const out = await ensureCacheHydrated(
      async (range) => { ranges.push(range); return [] },
      () => missed,
      'cfg-A',
      () => true,
    )
    expect(ranges).toHaveLength(1)
    expect(out.days.map(d => d.date)).toEqual([
      daysAgoStr(40), daysAgoStr(4), daysAgoStr(3), daysAgoStr(2), daysAgoStr(1),
    ])
    expect(out.days.find(d => d.date === daysAgoStr(2))!.cost).toBe(20)
    expect(out.complete).toBe(true)
    expectPreserved(out)
  })

  it('trusts a stamped watermark over an idle tail — no re-derive treadmill', async () => {
    // Same shape as the corrupt case above (watermark past the newest populated
    // day), but stamped by a COMPLETE parse: the recent days are genuinely
    // empty, not a frozen hole. A degraded parse can no longer produce this
    // state, so the stamp means the watermark is trustworthy and re-deriving the
    // empty tail on every launch (the perf regression) must not happen.
    await seed({ lastComputedDate: daysAgoStr(1), watermarkTrusted: true })
    let parses = 0
    const out = await ensureCacheHydrated(
      async () => { parses += 1; return [] },
      () => [],
      'cfg-A',
      () => true,
    )
    expect(parses).toBe(0)
    expect(out.lastComputedDate).toBe(daysAgoStr(1))
    expect(out.complete).toBe(true)
    expectPreserved(out)
  })

  it('a degraded re-derivation of those days still keeps every carried day', async () => {
    await seed({ lastComputedDate: daysAgoStr(1) })
    const out = await ensureCacheHydrated(noSessions, () => [], 'cfg-A', () => false)
    expect(out.complete).toBe(false)
    expect(out.days.map(d => d.date)).toEqual([daysAgoStr(40), daysAgoStr(4)])
    expectPreserved(out)
  })

  it('an empty cache still finalizes — no re-parse treadmill on a machine with no history', async () => {
    await seed({ days: [], lastComputedDate: daysAgoStr(1) })
    let parses = 0
    const out = await ensureCacheHydrated(
      async () => { parses += 1; return [] },
      () => [],
      'cfg-A',
      () => true,
    )
    expect(parses).toBe(0)
    expect(out.lastComputedDate).toBe(daysAgoStr(1))
    expect(out.complete).toBe(true)
  })
})
