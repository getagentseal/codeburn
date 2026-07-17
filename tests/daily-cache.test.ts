import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { ProjectSummary } from '../src/types.js'

import {
  addNewDays,
  currentTzKey,
  dailyCachePath,
  DAILY_CACHE_VERSION,
  type DailyCache,
  type DailyEntry,
  getDaysInRange,
  ensureCacheHydrated,
  loadDailyCache,
  saveDailyCache,
  withDailyCacheLock,
} from '../src/daily-cache.js'

function emptyDay(date: string, cost = 0, calls = 0): DailyEntry {
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
    providers: {},
  }
}

const TMP_CACHE_ROOT = join(tmpdir(), `codeburn-cache-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)

beforeEach(() => {
  process.env['CODEBURN_CACHE_DIR'] = TMP_CACHE_ROOT
})

afterEach(async () => {
  vi.useRealTimers()
  if (existsSync(TMP_CACHE_ROOT)) {
    await rm(TMP_CACHE_ROOT, { recursive: true, force: true })
  }
})

describe('loadDailyCache', () => {
  it('returns an empty cache when the file does not exist', async () => {
    const cache = await loadDailyCache()
    expect(cache.version).toBe(DAILY_CACHE_VERSION)
    expect(cache.lastComputedDate).toBeNull()
    expect(cache.days).toEqual([])
  })

  it('returns an empty cache when the file contains invalid JSON', async () => {
    const { writeFile, mkdir } = await import('fs/promises')
    await mkdir(TMP_CACHE_ROOT, { recursive: true })
    await writeFile(join(TMP_CACHE_ROOT, 'daily-cache.json'), 'not valid json{{', 'utf-8')
    const cache = await loadDailyCache()
    expect(cache.days).toEqual([])
  })

  // With version-suffixed filenames, a legacy unversioned file whose version is
  // not the current one is simply IGNORED — never migrated, never backed up,
  // never touched (old binaries still own it). Load returns an empty cache and
  // the legacy file is left intact on disk.
  it('ignores (and never rewrites) a legacy file too old to migrate', async () => {
    const saved = {
      version: 1,
      lastComputedDate: '2026-04-10',
      days: [{ date: '2026-04-10', cost: 10, calls: 5 }],
    }
    const { writeFile, mkdir } = await import('fs/promises')
    await mkdir(TMP_CACHE_ROOT, { recursive: true })
    const legacy = join(TMP_CACHE_ROOT, 'daily-cache.json')
    await writeFile(legacy, JSON.stringify(saved), 'utf-8')
    const cache = await loadDailyCache()
    expect(cache.days).toEqual([])
    expect(cache.lastComputedDate).toBeNull()
    // Legacy file untouched (no .bak, contents intact); no versioned file written.
    expect(existsSync(join(TMP_CACHE_ROOT, 'daily-cache.json.v1.bak'))).toBe(false)
    expect(JSON.parse(await readFile(legacy, 'utf-8'))).toEqual(saved)
    expect(existsSync(dailyCachePath())).toBe(false)
  })

  it('ignores a legacy v2 cache (provider rollups would be stale) and leaves it intact', async () => {
    const saved = {
      version: 2,
      lastComputedDate: '2026-04-10',
      days: [{
        date: '2026-04-10', cost: 10, calls: 5, sessions: 2,
        inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 100,
        models: { 'claude-opus-4-6': { calls: 5, cost: 10, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 100 } },
      }],
    }
    const { writeFile, mkdir } = await import('fs/promises')
    await mkdir(TMP_CACHE_ROOT, { recursive: true })
    const legacy = join(TMP_CACHE_ROOT, 'daily-cache.json')
    await writeFile(legacy, JSON.stringify(saved), 'utf-8')
    const cache = await loadDailyCache()
    expect(cache.version).toBe(DAILY_CACHE_VERSION)
    expect(cache.days).toEqual([])
    expect(cache.lastComputedDate).toBeNull()
    expect(existsSync(join(TMP_CACHE_ROOT, 'daily-cache.json.v2.bak'))).toBe(false)
    expect(JSON.parse(await readFile(legacy, 'utf-8'))).toEqual(saved)
  })

  it('ignores a legacy v5 cache (predates 1-hour cache pricing) and leaves it intact', async () => {
    const saved = {
      version: 5,
      lastComputedDate: '2026-05-01',
      days: [{
        date: '2026-05-01',
        cost: 0.37575,
        calls: 1,
        sessions: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 60_120,
        editTurns: 0,
        oneShotTurns: 0,
        models: { 'Opus 4.7': { calls: 1, cost: 0.37575, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 60_120 } },
        categories: {},
        providers: { claude: { calls: 1, cost: 0.37575 } },
      }],
    }
    const { writeFile, mkdir } = await import('fs/promises')
    await mkdir(TMP_CACHE_ROOT, { recursive: true })
    const legacy = join(TMP_CACHE_ROOT, 'daily-cache.json')
    await writeFile(legacy, JSON.stringify(saved), 'utf-8')
    const cache = await loadDailyCache()
    expect(cache.version).toBe(DAILY_CACHE_VERSION)
    expect(cache.days).toEqual([])
    expect(cache.lastComputedDate).toBeNull()
    expect(existsSync(join(TMP_CACHE_ROOT, 'daily-cache.json.v5.bak'))).toBe(false)
    expect(JSON.parse(await readFile(legacy, 'utf-8'))).toEqual(saved)
  })

  it('adopts a legacy file whose version matches the current one, once, without deleting it', async () => {
    const saved = {
      version: DAILY_CACHE_VERSION,
      savingsConfigHash: 'legacy-hash',
      lastComputedDate: '2026-05-01',
      days: [emptyDay('2026-05-01', 3.5, 9)],
    }
    const { writeFile, mkdir } = await import('fs/promises')
    await mkdir(TMP_CACHE_ROOT, { recursive: true })
    const legacy = join(TMP_CACHE_ROOT, 'daily-cache.json')
    await writeFile(legacy, JSON.stringify(saved), 'utf-8')

    // First load: versioned file absent → adopt-copy from legacy.
    const first = await loadDailyCache()
    expect(first.days).toEqual(saved.days)
    expect(first.savingsConfigHash).toBe('legacy-hash')
    expect(existsSync(dailyCachePath())).toBe(true)
    // Legacy file is NOT deleted.
    expect(existsSync(legacy)).toBe(true)

    // Adoption is one-time: mutate the legacy file, load again — the versioned
    // file now wins and the stale legacy edit is never re-adopted.
    await writeFile(legacy, JSON.stringify({ ...saved, days: [emptyDay('2000-01-01', 999)] }), 'utf-8')
    const second = await loadDailyCache()
    expect(second.days).toEqual(saved.days)
  })

  it('round-trips a valid cache through save and load', async () => {
    const saved: DailyCache = {
      version: DAILY_CACHE_VERSION,
      savingsConfigHash: 'cfg-hash-1',
      lastComputedDate: '2026-04-10',
      days: [emptyDay('2026-04-09', 12.5, 40), emptyDay('2026-04-10', 7.25, 28)],
      complete: true,
    }
    await saveDailyCache(saved)
    const loaded = await loadDailyCache()
    expect(loaded).toEqual(saved)
  })
})

describe('saveDailyCache', () => {
  it('writes atomically so no temp file is left after a successful save', async () => {
    const saved: DailyCache = {
      version: DAILY_CACHE_VERSION,
      savingsConfigHash: 'cfg-hash-1',
      lastComputedDate: '2026-04-10',
      days: [emptyDay('2026-04-10', 5)],
    }
    await saveDailyCache(saved)
    const { readdir } = await import('fs/promises')
    const files = await readdir(TMP_CACHE_ROOT)
    const tempLeftovers = files.filter(f => f.endsWith('.tmp'))
    expect(tempLeftovers).toEqual([])
    const finalFile = await readFile(dailyCachePath(), 'utf-8')
    expect(JSON.parse(finalFile)).toEqual(saved)
  })
})

describe('addNewDays', () => {
  it('returns a new cache with the added days sorted ascending by date', () => {
    const base: DailyCache = {
      version: DAILY_CACHE_VERSION,
      savingsConfigHash: '',
      lastComputedDate: '2026-04-08',
      days: [emptyDay('2026-04-07', 3), emptyDay('2026-04-08', 5)],
    }
    const updated = addNewDays(base, [emptyDay('2026-04-10', 9), emptyDay('2026-04-09', 7)], '2026-04-10')
    expect(updated.days.map(d => d.date)).toEqual(['2026-04-07', '2026-04-08', '2026-04-09', '2026-04-10'])
    expect(updated.lastComputedDate).toBe('2026-04-10')
  })

  it('replaces existing days with incoming data (last write wins)', () => {
    const base: DailyCache = {
      version: DAILY_CACHE_VERSION,
      savingsConfigHash: '',
      lastComputedDate: '2026-04-08',
      days: [emptyDay('2026-04-08', 5)],
    }
    const updated = addNewDays(base, [emptyDay('2026-04-08', 99)], '2026-04-08')
    const aprilEight = updated.days.find(d => d.date === '2026-04-08')!
    expect(aprilEight.cost).toBe(99)
  })

  it('does not regress lastComputedDate if incoming newestDate is older', () => {
    const base: DailyCache = {
      version: DAILY_CACHE_VERSION,
      savingsConfigHash: '',
      lastComputedDate: '2026-04-10',
      days: [emptyDay('2026-04-10', 5)],
    }
    const updated = addNewDays(base, [emptyDay('2026-04-05', 3)], '2026-04-05')
    expect(updated.lastComputedDate).toBe('2026-04-10')
  })

  it('skips prune when newestDate is malformed (does not silently drop all days)', () => {
    // Regression guard: a corrupt newestDate string used to produce a NaN
    // cutoff, which made `d.date >= "Invalid Date"` always false and
    // wiped every cached day on the next merge. The guard now leaves
    // the entries untouched so the next valid run can prune normally.
    const base: DailyCache = {
      version: DAILY_CACHE_VERSION,
      savingsConfigHash: '',
      lastComputedDate: '2026-04-10',
      days: [emptyDay('2026-04-08', 1), emptyDay('2026-04-09', 2), emptyDay('2026-04-10', 3)],
    }
    const updated = addNewDays(base, [], 'not-a-date')
    expect(updated.days.map(d => d.date)).toEqual(['2026-04-08', '2026-04-09', '2026-04-10'])
  })

  it('still prunes when newestDate is valid', () => {
    const old = '2020-01-01'
    const recent = '2026-04-10'
    const base: DailyCache = {
      version: DAILY_CACHE_VERSION,
      savingsConfigHash: '',
      lastComputedDate: recent,
      days: [emptyDay(old, 1), emptyDay(recent, 2)],
    }
    const updated = addNewDays(base, [], recent)
    // 730-day retention from 2026-04-10 → cutoff ~2024-04-11; 2020-01-01 must be gone.
    expect(updated.days.find(d => d.date === old)).toBeUndefined()
    expect(updated.days.find(d => d.date === recent)).toBeDefined()
  })
})

describe('getDaysInRange', () => {
  const cache: DailyCache = {
    version: DAILY_CACHE_VERSION,
    savingsConfigHash: '',
    lastComputedDate: '2026-04-10',
    days: [
      emptyDay('2026-04-05', 1),
      emptyDay('2026-04-06', 2),
      emptyDay('2026-04-07', 3),
      emptyDay('2026-04-08', 4),
      emptyDay('2026-04-09', 5),
      emptyDay('2026-04-10', 6),
    ],
  }

  it('returns inclusive start and end range', () => {
    const days = getDaysInRange(cache, '2026-04-07', '2026-04-09')
    expect(days.map(d => d.date)).toEqual(['2026-04-07', '2026-04-08', '2026-04-09'])
  })

  it('returns empty when range is entirely outside cache', () => {
    expect(getDaysInRange(cache, '2026-03-01', '2026-03-10')).toEqual([])
    expect(getDaysInRange(cache, '2026-05-01', '2026-05-10')).toEqual([])
  })

  it('clips to available cache days when range extends beyond', () => {
    const days = getDaysInRange(cache, '2026-04-09', '2026-04-20')
    expect(days.map(d => d.date)).toEqual(['2026-04-09', '2026-04-10'])
  })
})

describe('ensureCacheHydrated', () => {
  it('does not recompute yesterday after it has already been cached', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-12T12:00:00.000Z'))

    const saved: DailyCache = {
      version: DAILY_CACHE_VERSION,
      savingsConfigHash: '',
      tzKey: currentTzKey(),
      lastComputedDate: '2026-06-11',
      days: [emptyDay('2026-06-11', 5, 10)],
      complete: true,
    }
    await saveDailyCache(saved)

    let parseCalls = 0
    const hydrated = await ensureCacheHydrated(
      async () => {
        parseCalls += 1
        return []
      },
      () => [],
    )

    expect(parseCalls).toBe(0)
    expect(hydrated).toEqual(saved)
  })

  it('drops a cached today/future entry so it is recomputed live, keeping yesterday cached', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-12T12:00:00.000Z'))

    // A "today" entry can only exist via a backward clock change or a stale
    // cache; it must be purged so today is served live, not from a frozen entry.
    const saved: DailyCache = {
      version: DAILY_CACHE_VERSION,
      savingsConfigHash: '',
      lastComputedDate: '2026-06-12',
      days: [emptyDay('2026-06-11', 5, 10), emptyDay('2026-06-12', 9, 20)],
      complete: true,
    }
    await saveDailyCache(saved)

    let parseCalls = 0
    const hydrated = await ensureCacheHydrated(
      async () => {
        parseCalls += 1
        return []
      },
      () => [],
    )

    expect(parseCalls).toBe(0)
    expect(hydrated.days.map(d => d.date)).toEqual(['2026-06-11'])
    expect(hydrated.lastComputedDate).toBe('2026-06-11')
  })
})

describe('withDailyCacheLock', () => {
  it('serializes concurrent operations', async () => {
    const sequence: string[] = []
    const op = async (tag: string): Promise<void> => {
      await withDailyCacheLock(async () => {
        sequence.push(`start-${tag}`)
        await new Promise(r => setTimeout(r, 20))
        sequence.push(`end-${tag}`)
      })
    }
    await Promise.all([op('a'), op('b'), op('c')])
    for (let i = 0; i < sequence.length; i += 2) {
      expect(sequence[i]?.startsWith('start-')).toBe(true)
      expect(sequence[i + 1]?.startsWith('end-')).toBe(true)
      expect(sequence[i]!.slice(6)).toBe(sequence[i + 1]!.slice(4))
    }
  })
})

describe('ensureCacheHydrated: savings config invalidation', () => {
  it('discards cached days when the savingsConfigHash changes between calls', async () => {
    // Seed a cache with a day OLDER than yesterday so the hydration window
    // (which keeps `d.date < yesterdayStr`) actually retains it.
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    const twoDaysAgoStr = `${twoDaysAgo.getFullYear()}-${String(twoDaysAgo.getMonth() + 1).padStart(2, '0')}-${String(twoDaysAgo.getDate()).padStart(2, '0')}`
    const seeded: DailyCache = {
      version: DAILY_CACHE_VERSION,
      savingsConfigHash: 'cfg-A',
      lastComputedDate: twoDaysAgoStr,
      days: [emptyDay(twoDaysAgoStr, 1.5, 3)],
      complete: true,
    }
    await saveDailyCache(seeded)

    const parseSessions = async (): Promise<ProjectSummary[]> => []
    const aggregateDays = (): DailyEntry[] => []

    // Hash mismatch → ensureCacheHydrated must drop the stale day and start fresh.
    const rehydrated = await ensureCacheHydrated(parseSessions, aggregateDays, 'cfg-B')
    expect(rehydrated.savingsConfigHash).toBe('cfg-B')
    expect(rehydrated.days).toEqual([])

    // Same hash → cached days survive.
    const seeded2: DailyCache = {
      version: DAILY_CACHE_VERSION,
      savingsConfigHash: 'cfg-C',
      lastComputedDate: twoDaysAgoStr,
      days: [emptyDay(twoDaysAgoStr, 1.5, 3)],
      complete: true,
    }
    await saveDailyCache(seeded2)
    const preserved = await ensureCacheHydrated(parseSessions, aggregateDays, 'cfg-C')
    expect(preserved.days).toHaveLength(1)
    expect(preserved.days[0]!.date).toBe(twoDaysAgoStr)
  })
})

describe('ensureCacheHydrated: timezone invalidation', () => {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
  const twoDaysAgoStr = `${twoDaysAgo.getFullYear()}-${String(twoDaysAgo.getMonth() + 1).padStart(2, '0')}-${String(twoDaysAgo.getDate()).padStart(2, '0')}`
  const parseSessions = async (): Promise<ProjectSummary[]> => []
  const aggregateDays = (): DailyEntry[] => []

  it('re-hydrates when the cached tzKey differs from the current timezone', async () => {
    // Days are bucketed by local midnight, so a cache tagged under a different
    // timezone mis-buckets every day and must be discarded (like a savings-hash
    // mismatch). 'Test/OtherZone' can never equal a real IANA zone.
    const seeded: DailyCache = {
      version: DAILY_CACHE_VERSION,
      savingsConfigHash: '',
      tzKey: 'Test/OtherZone',
      lastComputedDate: twoDaysAgoStr,
      days: [emptyDay(twoDaysAgoStr, 1.5, 3)],
      complete: true,
    }
    await saveDailyCache(seeded)
    const rehydrated = await ensureCacheHydrated(parseSessions, aggregateDays, '')
    expect(rehydrated.tzKey).toBe(currentTzKey())
    expect(rehydrated.days).toEqual([])
  })

  it('keeps cached days when the tzKey matches the current timezone', async () => {
    const seeded: DailyCache = {
      version: DAILY_CACHE_VERSION,
      savingsConfigHash: '',
      tzKey: currentTzKey(),
      lastComputedDate: twoDaysAgoStr,
      days: [emptyDay(twoDaysAgoStr, 1.5, 3)],
      complete: true,
    }
    await saveDailyCache(seeded)
    const preserved = await ensureCacheHydrated(parseSessions, aggregateDays, '')
    expect(preserved.days).toHaveLength(1)
    expect(preserved.days[0]!.date).toBe(twoDaysAgoStr)
  })
})
