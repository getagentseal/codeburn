import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rm } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { DateRange, ProjectSummary } from '../src/types.js'
import { aggregateProjectsIntoDays, dateKey, dateKeyInTz } from '../src/day-aggregator.js'

import {
  DAILY_CACHE_VERSION,
  type DailyCache,
  type DailyEntry,
  type ProviderDaySlice,
  currentTzKey,
  ensureCacheHydrated,
  mergeDayEntries,
  saveDailyCache,
  toDateString,
} from '../src/daily-cache.js'

const TMP_CACHE_ROOT = join(tmpdir(), `codeburn-tz-dedup-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)

beforeEach(() => {
  process.env['CODEBURN_CACHE_DIR'] = TMP_CACHE_ROOT
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'))
})

afterEach(async () => {
  vi.useRealTimers()
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

function makeCall(timestamp: string, costUSD: number, provider = 'codex') {
  return {
    provider,
    model: 'codex-1',
    usage: {
      inputTokens: 100,
      outputTokens: 200,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 50,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
    },
    costUSD,
    tools: [],
    mcpTools: [],
    skills: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard' as const,
    timestamp,
    bashCommands: [],
    deduplicationKey: `dk-${timestamp}-${costUSD}`,
  }
}

function makeProject(calls: ReturnType<typeof makeCall>[]): ProjectSummary {
  const timestamp = calls[0]!.timestamp
  const totalCostUSD = calls.reduce((s, c) => s + c.costUSD, 0)
  return {
    project: 'p',
    projectPath: '/p',
    totalCostUSD,
    totalApiCalls: calls.length,
    sessions: [{
      sessionId: 's1',
      project: 'p',
      firstTimestamp: timestamp,
      lastTimestamp: calls.at(-1)!.timestamp,
      totalCostUSD,
      totalInputTokens: calls.reduce((s, c) => s + c.usage.inputTokens, 0),
      totalOutputTokens: calls.reduce((s, c) => s + c.usage.outputTokens, 0),
      totalCacheReadTokens: calls.reduce((s, c) => s + c.usage.cacheReadInputTokens, 0),
      totalCacheWriteTokens: calls.reduce((s, c) => s + c.usage.cacheCreationInputTokens, 0),
      apiCalls: calls.length,
      turns: [{
        userMessage: 'hi',
        timestamp,
        sessionId: 's1',
        category: 'coding',
        retries: 0,
        hasEdits: true,
        assistantCalls: calls,
      }],
      modelBreakdown: {},
      toolBreakdown: {},
      mcpBreakdown: {},
      bashBreakdown: {},
      categoryBreakdown: {} as never,
      skillBreakdown: {} as never,
    }],
  }
}

/// A real IANA zone guaranteed to differ from the machine's current one, so the
/// seeded cache reads as a genuine tz change. Kiritimati (UTC+14) differs from
/// every other zone; if the machine itself is Kiritimati, Pago Pago (UTC-11) is
/// 25h away, so a straddling timestamp still exists.
function otherTz(): string {
  return currentTzKey() === 'Pacific/Kiritimati' ? 'Pacific/Pago_Pago' : 'Pacific/Kiritimati'
}

/// A 2026-06-13 UTC timestamp that lands on DIFFERENT calendar days under the
/// machine's local tz and `tz` (i.e. a turn that migrates across local midnight
/// when the timezone changes). Deterministic for any machine; two zones with
/// different UTC offsets always have a straddle somewhere in the day.
function straddlingTimestamp(tz: string): string {
  for (let h = 0; h < 24; h++) {
    const iso = `2026-06-13T${String(h).padStart(2, '0')}:30:00.000Z`
    if (dateKey(iso) !== dateKeyInTz(iso, tz)) return iso
  }
  throw new Error(`no straddling timestamp between local tz and ${tz}`)
}

/// The production-shaped tz-aware aggregator: re-aggregate under an explicit tz.
function aggregateInTz(projects: ProjectSummary[], tz: string): DailyEntry[] {
  return aggregateProjectsIntoDays(projects, (iso) => dateKeyInTz(iso, tz))
}

const OLD_TZ = otherTz()
// A fixed day whose sources are entirely gone (no fixture turn buckets to it
// under either tz): the issue #770 "sources-gone day" that must survive.
const GONE_DAY = '2026-06-10'

async function seed(days: DailyEntry[], overrides: Partial<DailyCache> = {}): Promise<void> {
  await saveDailyCache({
    version: DAILY_CACHE_VERSION,
    savingsConfigHash: 'cfg-A',
    tzKey: OLD_TZ,
    lastComputedDate: '2026-06-13',
    days,
    complete: true,
    watermarkTrusted: true,
    ...overrides,
  })
}

/// A real IANA zone guaranteed to be BEHIND the machine's local timezone, so a
/// call early in the NEW tz's today is still the OLD tz's YESTERDAY - the
/// boundary-day direction the history parse range excludes (its calls fall past
/// yesterdayEnd). Etc/GMT+N == UTC-N; pick one ~6h behind so a straddling gap
/// timestamp always exists inside the fake-time window.
function behindTz(): string {
  const offsetHours = -new Date().getTimezoneOffset() / 60
  const gmtIndex = Math.max(-12, Math.min(12, 6 - offsetHours))
  return `Etc/GMT${gmtIndex < 0 ? '-' : '+'}${Math.abs(gmtIndex)}`
}

/// A timestamp in the re-derive's GAP: dated TODAY under the new tz (so the
/// history parse through yesterday excludes it) but YESTERDAY under `tz` (so
/// the baseline cache holds it), and still <= the fake `now` (so a parse
/// through now includes it).
function gapTimestamp(tz: string): { ts: string; oldDate: string } {
  const now = new Date()
  const todayStr = toDateString(now)
  const yesterdayStr = toDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
  for (let h = 0; h <= now.getUTCHours(); h++) {
    const iso = `2026-06-15T${String(h).padStart(2, '0')}:00:00.000Z`
    if (dateKey(iso) !== todayStr) continue
    const oldDate = dateKeyInTz(iso, tz)
    if (oldDate === yesterdayStr) return { ts: iso, oldDate }
  }
  throw new Error(`no gap timestamp for ${tz} (today=${todayStr} yesterday=${yesterdayStr})`)
}

/// A parse mock that RESPECTS its range: calls whose timestamps fall outside
/// [start, end] are dropped. The real parser slices straddling turns per range;
/// this keeps the test's assertion that the boundary call is excluded from a
/// history-only parse honest.
function rangeAwareParse(projects: ProjectSummary[]) {
  return async (range: DateRange): Promise<ProjectSummary[]> => {
    const startMs = range.start.getTime()
    const endMs = range.end.getTime()
    const inRange: ProjectSummary[] = []
    for (const p of projects) {
      const sessions = p.sessions
        .map(s => ({
          ...s,
          turns: s.turns
            .map(t => ({
              ...t,
              assistantCalls: t.assistantCalls.filter(c => {
                const ms = new Date(c.timestamp).getTime()
                return ms >= startMs && ms <= endMs
              }),
            }))
            .filter(t => t.assistantCalls.length > 0),
        }))
        .filter(s => s.turns.length > 0)
      if (sessions.length > 0) inRange.push({ ...p, sessions })
    }
    return inRange
  }
}

describe('dateKeyInTz', () => {
  it('buckets a timestamp under an explicit timezone (machine tz irrelevant)', () => {
    // 23:30Z on 06-13 is still 06-13 in New York (19:30 EDT) but already
    // 06-14 in Kiritimati (01:30, UTC+14).
    expect(dateKeyInTz('2026-06-13T23:30:00.000Z', 'America/New_York')).toBe('2026-06-13')
    expect(dateKeyInTz('2026-06-13T23:30:00.000Z', 'Pacific/Kiritimati')).toBe('2026-06-14')
  })
})

describe('tz-change re-derive: subtract what the fresh parse re-bucketed (issue #770)', () => {
  it('(a) a turn that migrated across local midnight counts once, not twice', async () => {
    const ts = straddlingTimestamp(OLD_TZ)
    const oldDay = dateKeyInTz(ts, OLD_TZ)
    const newDay = dateKey(ts)
    expect(newDay).not.toBe(oldDay)

    const fixture = [makeProject([makeCall(ts, 10)])]
    await seed([day(oldDay, { codex: slice(10, 1) })])

    let parseCalls = 0
    const out = await ensureCacheHydrated(
      async () => { parseCalls += 1; return fixture },
      aggregateProjectsIntoDays,
      'cfg-A',
      () => true,
      aggregateInTz,
    )

    // The history parse was aggregated twice (current tz + old tz); the fix
    // round 1 subtraction adds a second through-now parse scoped to the
    // subtraction, so the tz path parses twice total.
    expect(parseCalls).toBe(2)
    const total = out.days.reduce((s, d) => s + d.cost, 0)
    const codexTotal = out.days.reduce((s, d) => s + (d.providers['codex']?.cost ?? 0), 0)
    expect(total).toBeCloseTo(10, 5)
    expect(codexTotal).toBeCloseTo(10, 5)
    // The old day is fully explained away (its only turn migrated) → dropped.
    expect(out.days.find(d => d.date === oldDay)).toBeUndefined()
    const newDayEntry = out.days.find(d => d.date === newDay)
    expect(newDayEntry).toBeDefined()
    expect(newDayEntry!.providers['codex']!.cost).toBeCloseTo(10, 5)
  })

  it('(b) a sources-gone day survives a tz re-derive unchanged', async () => {
    const ts = straddlingTimestamp(OLD_TZ)
    const oldDay = dateKeyInTz(ts, OLD_TZ)
    const newDay = dateKey(ts)

    const fixture = [makeProject([makeCall(ts, 10)])]
    await seed([
      day(GONE_DAY, { claude: slice(399.70, 1572) }),
      day(oldDay, { codex: slice(10, 1) }),
    ])

    const out = await ensureCacheHydrated(
      async () => fixture,
      aggregateProjectsIntoDays,
      'cfg-A',
      () => true,
      aggregateInTz,
    )

    // The vanished-source day is untouched, carried exactly as before.
    const gone = out.days.find(d => d.date === GONE_DAY)
    expect(gone).toMatchObject({ cost: 399.70, calls: 1572, carried: true })
    expect(gone!.providers['claude']!.cost).toBe(399.70)
    // The migrated turn left its old day entirely; it now lives on newDay only.
    expect(out.days.find(d => d.date === oldDay)).toBeUndefined()
    const newDayEntry = out.days.find(d => d.date === newDay)
    expect(newDayEntry!.providers['codex']!.cost).toBeCloseTo(10, 5)
    const total = out.days.reduce((s, d) => s + d.cost, 0)
    expect(total).toBeCloseTo(399.70 + 10, 5)
  })

  it('(c) a mixed slice subtracts only the migrated part; the remainder is carried', async () => {
    const ts = straddlingTimestamp(OLD_TZ)
    const oldDay = dateKeyInTz(ts, OLD_TZ)
    const newDay = dateKey(ts)

    // Baseline day holds TWO codex turns' worth (20): one is the live turn that
    // migrates to newDay, the other's source is gone. Only the live 10 is
    // subtracted; the sources-gone 10 is carried forward.
    const fixture = [makeProject([makeCall(ts, 10)])]
    await seed([day(oldDay, { codex: slice(20, 2) })])

    const out = await ensureCacheHydrated(
      async () => fixture,
      aggregateProjectsIntoDays,
      'cfg-A',
      () => true,
      aggregateInTz,
    )

    const carried = out.days.find(d => d.date === oldDay)
    expect(carried).toBeDefined()
    expect(carried!.carried).toBe(true)
    expect(carried!.providers['codex']!.cost).toBeCloseTo(10, 5)
    expect(carried!.providers['codex']!.calls).toBe(1)
    const migrated = out.days.find(d => d.date === newDay)
    expect(migrated!.providers['codex']!.cost).toBeCloseTo(10, 5)
    const total = out.days.reduce((s, d) => s + d.cost, 0)
    expect(total).toBeCloseTo(20, 5)
  })

  it('(d) a non-tz re-derive (savings-hash change) preserves a mid-range source hole exactly', async () => {
    // No tz change: seed under the machine's own tz. A savings-hash change
    // re-derives; the mid-range hole (codex sources gone) must carry at exactly
    // 50, byte-identical to the pre-fix behavior.
    const fixture = [makeProject([makeCall('2026-06-12T10:00:00.000Z', 100, 'claude')])]
    const aggregateToJune12 = (projects: ProjectSummary[]): DailyEntry[] =>
      aggregateProjectsIntoDays(projects, () => '2026-06-12')
    const unexpectedTzAggregation = (): DailyEntry[] => {
      throw new Error('aggregateDaysInTz must not be called on a non-tz re-derive')
    }
    await seed(
      [day('2026-06-12', { claude: slice(100, 100), codex: slice(50, 50) })],
      { tzKey: currentTzKey() },
    )

    const out = await ensureCacheHydrated(
      async () => fixture,
      aggregateToJune12,
      'cfg-B',
      () => true,
      unexpectedTzAggregation,
    )

    expect(out.savingsConfigHash).toBe('cfg-B')
    const kept = out.days.find(d => d.date === '2026-06-12')!
    expect(kept.providers['claude']!.cost).toBe(100)
    expect(kept.providers['codex']!.cost).toBe(50)
    expect(kept.cost).toBeCloseTo(150, 5)
    expect(kept.carried).toBe(true)
  })

  it('(e) tzChanged AND savingsConfigHash changed together: no subtraction', async () => {
    const ts = straddlingTimestamp(OLD_TZ)
    const oldDay = dateKeyInTz(ts, OLD_TZ)
    const newDay = dateKey(ts)

    const fixture = [makeProject([makeCall(ts, 10)])]
    await seed([day(oldDay, { codex: slice(10, 1) })])

    const out = await ensureCacheHydrated(
      async () => fixture,
      aggregateProjectsIntoDays,
      'cfg-B', // hash changed in the same re-derive
      () => true,
      aggregateInTz,
    )

    // Re-pricing drift must not masquerade as re-bucketing spend: the carry is
    // unchanged (the double count stays, exactly as on main today).
    const carried = out.days.find(d => d.date === oldDay)
    expect(carried).toBeDefined()
    expect(carried!.providers['codex']!.cost).toBeCloseTo(10, 5)
    const migrated = out.days.find(d => d.date === newDay)
    expect(migrated!.providers['codex']!.cost).toBeCloseTo(10, 5)
    const total = out.days.reduce((s, d) => s + d.cost, 0)
    expect(total).toBeCloseTo(20, 5)
  })
})

describe('fix round 1', () => {
  it('(f) a call that re-buckets to TODAY (past the history parse) is subtracted from its old day', async () => {
    // The boundary-day direction the history parse misses: OLD_TZ is BEHIND the
    // machine, so a call early in NEW-tz today is still OLD-tz YESTERDAY - a
    // date the baseline cache holds. The re-derive parse used to stop at
    // yesterdayEnd, which is BEFORE this call's timestamp, so the old-tz
    // re-aggregation never saw it: the baseline slice was carried un-subtracted
    // while today's live parse counted it again. The fix parses through NOW for
    // the subtraction; the merged cache still stops at yesterday.
    const oldTz = behindTz()
    const { ts, oldDate } = gapTimestamp(oldTz)
    const now = new Date()
    const todayStr = toDateString(now)
    const yesterdayStr = toDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
    expect(dateKey(ts)).toBe(todayStr)
    expect(dateKeyInTz(ts, oldTz)).toBe(oldDate)

    const fixture = [makeProject([makeCall(ts, 10)])]
    await seed([day(oldDate, { codex: slice(10, 1) })], { tzKey: oldTz })

    const out = await ensureCacheHydrated(
      rangeAwareParse(fixture),
      aggregateProjectsIntoDays,
      'cfg-A',
      () => true,
      aggregateInTz,
    )

    // The migrated call was explained away from its old day: nothing on oldDate
    // is carried to be double-counted by today's live parse.
    expect(out.days.find(d => d.date === oldDate)).toBeUndefined()
    // The cache still holds ONLY history days - today is not finalized, and the
    // watermark did not move.
    expect(out.days.some(d => d.date >= todayStr)).toBe(false)
    expect(out.lastComputedDate).toBe(yesterdayStr)
    expect(out.days.reduce((s, d) => s + d.cost, 0)).toBeCloseTo(0, 5)
  })

  it('(g) subtraction residual sessions ADD to a fresh sessions-only placeholder (source-gone sessions survive)', () => {
    // A fresh day carries a sessions-only placeholder (sessions=1, cost=0) for a
    // session that started on that day; the baseline slice held TWO sessions (that
    // one plus a source-gone one). The tz subtraction removes the fresh-explained
    // session from the carried slice, leaving a residual of sessions=1. The
    // placeholder max-dedup clamps max(1, 1) = 1, permanently dropping the
    // source-gone session; the residual must ADD instead.
    const fresh = day('2026-06-13', { codex: slice(0, 0, { sessions: 1 }) }, { sessions: 1 })
    const baseline = day('2026-06-13', { codex: slice(0, 0, { sessions: 2 }) }, { sessions: 2 })
    const subtract = new Map<string, Map<string, ProviderDaySlice>>([
      ['2026-06-13', new Map([['codex', { sessions: 1, cost: 0, calls: 0 }]])],
    ])
    const merged = mergeDayEntries([fresh], [baseline], true, subtract)
    const m = merged[0]!
    expect(m.providers['codex']!.sessions).toBe(2)
    expect(m.sessions).toBe(2)
  })

  it('(h) day totals subtract the EFFECTIVE removal, not the raw sub (skew)', () => {
    // Skew: the fresh-old-tz content for provider A (cost 10) EXCEEDS what the
    // cached baseline slice holds (cost 5). The slice clamps to zero, so the day
    // loses exactly 5 - NOT 10, which would eat provider B's carried history at
    // the day level and leave the day total failing to sum to its surviving
    // slices (2 with B still 7).
    const a = slice(5, 1, {
      models: { 'shared-model': { calls: 1, cost: 5, savingsUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    })
    const b = slice(7, 1, {
      models: { 'shared-model': { calls: 1, cost: 7, savingsUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    })
    const baseline = day('2026-06-13', { A: a, B: b }, {
      models: {
        'shared-model': { calls: 2, cost: 12, savingsUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    })
    const subtract = new Map<string, Map<string, ProviderDaySlice>>([
      ['2026-06-13', new Map([
        ['A', slice(10, 1, {
          models: { 'shared-model': { calls: 1, cost: 10, savingsUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
        })],
        // A subtraction entry for a provider the day does not have must be a
        // no-op (effective removal is zero) - it cannot eat day totals.
        ['C', slice(999, 99)],
      ])],
    ])
    const merged = mergeDayEntries([], [baseline], true, subtract)
    const m = merged[0]!
    // Day totals equal the surviving slice (B): 7, not 2 (12 - raw 10).
    expect(m.cost).toBeCloseTo(7, 5)
    expect(m.calls).toBe(1)
    expect(m.providers['A']).toBeUndefined()
    expect(m.providers['C']).toBeUndefined()
    expect(m.providers['B']).toMatchObject({ cost: 7, calls: 1 })
    // The day-level model split lost only A's effective share, not B's.
    expect(m.models['shared-model']!.cost).toBeCloseTo(7, 5)
    expect(m.models['shared-model']!.calls).toBe(1)
    // Reconciliation: day totals equal the sum of the surviving slices.
    expect(m.cost).toBeCloseTo(m.providers['B']!.cost, 5)
  })
})
