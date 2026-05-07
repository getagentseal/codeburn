import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  addNewDays,
  DAILY_CACHE_VERSION,
  type DailyCache,
  type DailyEntry,
  getDaysInRange,
  loadDailyCache,
  saveDailyCache,
  withDailyCacheLock,
} from '../src/daily-cache.js'

function emptyDay(date: string, cost = 0, calls = 0): DailyEntry {
  return {
    date,
    cost,
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
  delete process.env['CODEBURN_CACHE_DIR']
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

  it('returns an empty cache and backs up when version is too old to migrate', async () => {
    const saved = {
      version: 1,
      lastComputedDate: '2026-04-10',
      days: [{ date: '2026-04-10', cost: 10, calls: 5 }],
    }
    const { writeFile, mkdir } = await import('fs/promises')
    await mkdir(TMP_CACHE_ROOT, { recursive: true })
    await writeFile(join(TMP_CACHE_ROOT, 'daily-cache.json'), JSON.stringify(saved), 'utf-8')
    const cache = await loadDailyCache()
    expect(cache.days).toEqual([])
    expect(cache.lastComputedDate).toBeNull()
    expect(existsSync(join(TMP_CACHE_ROOT, 'daily-cache.json.v1.bak'))).toBe(true)
  })

  it('migrates an older supported version by filling missing fields', async () => {
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
    await writeFile(join(TMP_CACHE_ROOT, 'daily-cache.json'), JSON.stringify(saved), 'utf-8')
    const cache = await loadDailyCache()
    expect(cache.version).toBe(DAILY_CACHE_VERSION)
    expect(cache.days).toHaveLength(1)
    expect(cache.days[0].date).toBe('2026-04-10')
    expect(cache.days[0].cost).toBe(10)
    expect(cache.days[0].editTurns).toBe(0)
    expect(cache.days[0].oneShotTurns).toBe(0)
    expect(cache.days[0].categories).toEqual({})
    expect(cache.days[0].providers).toEqual({})
    expect(cache.days[0].models['claude-opus-4-6'].calls).toBe(5)
  })

  it('round-trips a valid cache through save and load', async () => {
    const saved: DailyCache = {
      version: DAILY_CACHE_VERSION,
      lastComputedDate: '2026-04-10',
      days: [emptyDay('2026-04-09', 12.5, 40), emptyDay('2026-04-10', 7.25, 28)],
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
      lastComputedDate: '2026-04-10',
      days: [emptyDay('2026-04-10', 5)],
    }
    await saveDailyCache(saved)
    const { readdir } = await import('fs/promises')
    const files = await readdir(TMP_CACHE_ROOT)
    const tempLeftovers = files.filter(f => f.endsWith('.tmp'))
    expect(tempLeftovers).toEqual([])
    const finalFile = await readFile(join(TMP_CACHE_ROOT, 'daily-cache.json'), 'utf-8')
    expect(JSON.parse(finalFile)).toEqual(saved)
  })
})

describe('addNewDays', () => {
  it('returns a new cache with the added days sorted ascending by date', () => {
    const base: DailyCache = {
      version: DAILY_CACHE_VERSION,
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
