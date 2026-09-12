import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  DAILY_CACHE_VERSION,
  currentTzKey,
  ensureCacheHydrated,
  loadDailyCache,
  toDateString,
  type DailyEntry,
} from '../src/daily-cache.js'

// One below the current version, so this pins the ADJACENT-version case: v20
// is the SHIPPED predecessor (#1040, codex model attribution), and its days
// must be re-derived rather than adopted as finalized under a number that now
// means different accounting. Anything below MIN_SUPPORTED_VERSION is
// untrusted, which is what makes the re-derivation global rather than
// provider-scoped.
const PRE_FIX_DAILY_VERSION = 20
const cacheRoot = join(tmpdir(), `codeburn-daily-rederive-${process.pid}-${Date.now()}`)

function day(date: string, cost: number): DailyEntry {
  return {
    date,
    cost,
    savingsUSD: 0,
    calls: 1,
    sessions: 1,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 0,
    editTurns: 0,
    oneShotTurns: 0,
    models: {
      'Grok Build': {
        calls: 1,
        cost,
        savingsUSD: 0,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 0,
      },
    },
    categories: {},
    providers: {
      grok: {
        calls: 1,
        cost,
        savingsUSD: 0,
        sessions: 1,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 0,
      },
    },
  }
}

beforeEach(async () => {
  process.env['CODEBURN_CACHE_DIR'] = cacheRoot
  await rm(cacheRoot, { recursive: true, force: true })
  await mkdir(cacheRoot, { recursive: true })
})

afterEach(async () => {
  await rm(cacheRoot, { recursive: true, force: true })
})

// Raising MIN_SUPPORTED_VERSION re-derives EVERY day from EVERY provider - the
// daily cache has no per-provider invalidation. Which provider the seeded day
// belongs to is incidental; the mechanism under test is version-wide.
describe('daily-cache re-derivation on a DAILY_CACHE_VERSION bump', () => {
  it('re-derives a day from a below-minimum v20 cache while preserving the old file', async () => {
    const date = toDateString(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
    const yesterday = toDateString(new Date(Date.now() - 24 * 60 * 60 * 1000))
    const oldPath = join(cacheRoot, `daily-cache.v${PRE_FIX_DAILY_VERSION}.json`)
    const oldCache = {
      version: PRE_FIX_DAILY_VERSION,
      savingsConfigHash: 'cfg',
      tzKey: currentTzKey(),
      lastComputedDate: yesterday,
      days: [day(date, 99)],
      complete: true,
      watermarkTrusted: true,
    }
    await writeFile(oldPath, JSON.stringify(oldCache))

    let parseCount = 0
    const corrected = day(date, 2)
    const hydrated = await ensureCacheHydrated(
      async () => {
        parseCount++
        return []
      },
      () => [corrected],
      'cfg',
      () => true,
    )

    const refreshedDay = hydrated.days.find(entry => entry.date === date)
    expect(parseCount).toBe(1)
    expect(refreshedDay?.providers.grok?.cost).toBe(2)
    expect(refreshedDay?.cost).toBe(2)
    expect(JSON.parse(await readFile(oldPath, 'utf8'))).toEqual(oldCache)
  })
})

// v30 is claimed by two open branches at once: this one and #1132. A v30 file
// on disk therefore carries UNKNOWN accounting, so adopting it as the
// finalized base would serve #1132's numbers under this branch's contract.
describe('daily-cache adoption of a v30 file written under a different accounting', () => {
  it('carries its days forward but never adopts it as the finalized base', async () => {
    const date = toDateString(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
    const yesterday = toDateString(new Date(Date.now() - 24 * 60 * 60 * 1000))
    const foreign = day(date, 42)
    foreign.providers = {
      hermes: {
        calls: 1,
        cost: 42,
        savingsUSD: 0,
        sessions: 1,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 0,
      },
    }
    await writeFile(
      join(cacheRoot, 'daily-cache.v30.json'),
      JSON.stringify({
        version: 30,
        savingsConfigHash: 'cfg',
        tzKey: currentTzKey(),
        lastComputedDate: yesterday,
        days: [foreign],
        complete: true,
        watermarkTrusted: true,
      }),
    )

    const loaded = await loadDailyCache()

    expect(DAILY_CACHE_VERSION).toBe(32)
    expect(loaded.version).toBe(32)
    // A v30 candidate must not satisfy same-version adoption, so its trust
    // markers cannot survive migration to the current cache version.
    expect(loaded.complete).toBe(false)
    expect(loaded.watermarkTrusted).toBe(false)
    const carried = loaded.days.find(entry => entry.date === date)
    expect(carried?.carried).toBe(true)
    expect(loaded.pendingRederive).toContain('hermes')
    expect(loaded.pendingRederive).toContain('dsh')
  })
})
