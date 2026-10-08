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
  loadDailyCache,
  saveDailyCache,
  toDateString,
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

/// A day whose only content is turn-anchored residue: one straddling turn's
/// category counts, zero cost/calls/sessions/tokens (isTurnResidueOnly).
function residueDay(date: string): DailyEntry {
  return day(date, {}, {
    categories: { conversation: { turns: 1, cost: 0, savingsUSD: 0, editTurns: 0, oneShotTurns: 0 } },
  })
}

describe('daily cache: the gap path never shrinks a populated baseline day', () => {
  // A populated baseline day inside the gap window (carried there by an older
  // cache generation while the watermark sat behind it). The gap parse
  // under-reads it: 5 calls / $5 where the baseline holds 500 / $50.
  async function seedGapDay(): Promise<void> {
    await seed({
      days: [
        VANISHED,
        day(daysAgoStr(4), { claude: slice(120, 900) }),
        day(daysAgoStr(2), { claude: slice(50, 500), grok: slice(9, 60) }),
      ],
    })
  }

  it('a partial gap parse only fills what the baseline lacks', async () => {
    await seedGapDay()
    const underRead = [day(daysAgoStr(2), { claude: slice(5, 10) })]
    const out = await ensureCacheHydrated(noSessions, () => underRead, 'cfg-A', () => false)
    const kept = out.days.find(d => d.date === daysAgoStr(2))!
    // Baseline wins wholesale: the partial parse's undercount must not replace it.
    expect(kept.cost).toBe(59)
    expect(kept.calls).toBe(560)
    expect(kept.providers['claude']).toMatchObject({ cost: 50, calls: 500 })
    expect(kept.providers['grok']).toMatchObject({ cost: 9, calls: 60 })
    // Watermark held and not finalized, so a later complete parse re-covers the gap.
    expect(out.lastComputedDate).toBe(daysAgoStr(4))
    expect(out.complete).toBe(false)
    expectPreserved(out)
  })

  it('a complete gap parse still wins per (date, provider)', async () => {
    await seedGapDay()
    const fresh = [day(daysAgoStr(2), { claude: slice(75, 620) })]
    const out = await ensureCacheHydrated(noSessions, () => fresh, 'cfg-A', () => true)
    const rederived = out.days.find(d => d.date === daysAgoStr(2))!
    // The fresh claude slice replaces the baseline one; the grok slice the
    // parse did not produce is carried, not wiped.
    expect(rederived.providers['claude']).toMatchObject({ cost: 75, calls: 620 })
    expect(rederived.providers['grok']).toMatchObject({ cost: 9, calls: 60 })
    expect(rederived.cost).toBe(84)
    expect(rederived.calls).toBe(680)
    expect(out.days.map(d => d.date)).toEqual([daysAgoStr(40), daysAgoStr(4), daysAgoStr(2)])
    expect(out.lastComputedDate).toBe(daysAgoStr(1))
    expect(out.complete).toBe(true)
    expectPreserved(out)
  })
})

describe('daily cache: a residue-only day is re-derived, not served', () => {
  it('pulls the watermark back to just before the residue day so the gap parse re-derives it', async () => {
    // The broken-cache shape issue #1127 leaves behind: complete and stamped,
    // watermark at yesterday, and a residue-only day sealed behind it. The
    // oldest-day exemption does not apply (an older populated day exists) and
    // the residue day is inside the settle window.
    await seed({
      lastComputedDate: daysAgoStr(1),
      watermarkTrusted: true,
      days: [day(daysAgoStr(10), { claude: slice(80, 700) }), residueDay(daysAgoStr(3))],
    })
    const ranges: DateRange[] = []
    const rederived = [day(daysAgoStr(3), { claude: slice(33, 210) })]
    const out = await ensureCacheHydrated(
      async (range) => { ranges.push(range); return [] },
      () => rederived,
      'cfg-A',
      () => true,
    )
    // The watermark moved back to daysAgoStr(4), so the gap parse covers the
    // residue day instead of skipping it forever.
    expect(ranges).toHaveLength(1)
    expect(toDateString(ranges[0]!.start) <= daysAgoStr(3)).toBe(true)
    const healed = out.days.find(d => d.date === daysAgoStr(3))!
    expect(healed.providers['claude']).toMatchObject({ cost: 33, calls: 210 })
    expect(healed.cost).toBe(33)
    expect(healed.calls).toBe(210)
    expect(out.days.find(d => d.date === daysAgoStr(10))).toMatchObject({ cost: 80, calls: 700 })
    expect(out.lastComputedDate).toBe(daysAgoStr(1))
    expect(out.complete).toBe(true)
  })
})

describe('daily cache: sealing a day re-derives the still-settling ones', () => {
  it('a day sealed before a late call or a re-price reads the same as a live parse of it', async () => {
    // The field case: Oct 4 sealed at $376.71 / 5563 calls; a live parse of it
    // later finds 5564 calls at a new price ($356.17). report --day used the
    // live parse, history.daily the sealed day.
    await seed({
      lastComputedDate: daysAgoStr(2),
      watermarkTrusted: true,
      days: [day(daysAgoStr(10), { claude: slice(80, 700) }), day(daysAgoStr(4), { claude: slice(376.71, 5563) })],
    })
    const out = await ensureCacheHydrated(
      async () => [],
      () => [day(daysAgoStr(4), { claude: slice(356.17, 5564) }), day(daysAgoStr(1), { claude: slice(10, 50) })],
      'cfg-A',
      () => true,
    )
    expect(out.days.find(d => d.date === daysAgoStr(4))).toMatchObject({ cost: 356.17, calls: 5564 })
    expect(out.days.find(d => d.date === daysAgoStr(1))).toMatchObject({ cost: 10 })
    expect(out.days.find(d => d.date === daysAgoStr(10))).toMatchObject({ cost: 80, calls: 700 })
  })
})

describe('daily cache: a re-derived sealed day never shrinks', () => {
  it('keeps a sealed day whose fresh parse lost calls, re-prices one with the same calls', async () => {
    await seed({
      lastComputedDate: daysAgoStr(2),
      watermarkTrusted: true,
      days: [
        day(daysAgoStr(4), { claude: slice(200, 1000) }),
        day(daysAgoStr(3), { claude: slice(376.71, 5563) }),
      ],
    })
    const out = await ensureCacheHydrated(
      async () => [],
      () => [
        day(daysAgoStr(4), { claude: slice(15, 40) }),
        day(daysAgoStr(3), { claude: slice(356.17, 5563) }),
        day(daysAgoStr(1), { claude: slice(10, 50) }),
      ],
      'cfg-A',
      () => true,
    )
    expect(out.days.find(d => d.date === daysAgoStr(4))).toMatchObject({ cost: 200, calls: 1000 })
    expect(out.days.find(d => d.date === daysAgoStr(3))).toMatchObject({ cost: 356.17, calls: 5563 })
    expect(out.days.find(d => d.date === daysAgoStr(1))).toMatchObject({ cost: 10 })
  })
})

describe('daily cache: out-of-range residue days never reach the gap merge', () => {
  it('a straddling turn anchored before the gap leaves the cached day untouched', async () => {
    // Issue #1130: the gap range starts on D+1, but a turn anchored on day D
    // survives range slicing whole, so the aggregator emits a residue day for
    // D — outside the parsed range. Previously the merge guard had to defuse
    // it; now the range filter drops it before the merge runs at all.
    const populatedD = day(daysAgoStr(9), { claude: slice(120, 900) })
    await seed({ days: [VANISHED, populatedD], lastComputedDate: daysAgoStr(9) })
    const before = (await loadDailyCache()).days.find(d => d.date === daysAgoStr(9))!
    const residue = residueDay(daysAgoStr(9))
    const inRange = day(daysAgoStr(2), { claude: slice(30, 300) })
    const out = await ensureCacheHydrated(noSessions, () => [residue, inRange], 'cfg-A', () => true)
    // Day D persisted untouched: no residue categories leaked in.
    const kept = out.days.find(d => d.date === daysAgoStr(9))!
    expect(kept).toEqual(before)
    expect(out.days.map(d => d.date)).toEqual([daysAgoStr(40), daysAgoStr(9), daysAgoStr(2)])
    expect(out.lastComputedDate).toBe(daysAgoStr(1))
    expect(out.complete).toBe(true)
  })
})
