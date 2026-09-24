import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { RETIRED_PROVIDER_NAMES } from '../src/cache-dir.js'
import { DAILY_CACHE_VERSION, dailyCachePath, loadDailyCache, type DailyEntry, type ModelDayStats } from '../src/daily-cache.js'
import {
  CACHE_VERSION,
  clearLoadCacheMemo,
  computeEnvFingerprint,
  isCacheDirty,
  loadCache,
  markCacheDirty,
  saveCache,
  sessionCacheDir,
  type CachedFile,
  type SessionCache,
} from '../src/session-cache.js'

const RETIRED = [...RETIRED_PROVIDER_NAMES][0]!
let TMP_DIR: string

beforeEach(async () => {
  TMP_DIR = join(tmpdir(), `codeburn-retired-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  process.env['CODEBURN_CACHE_DIR'] = TMP_DIR
  await mkdir(TMP_DIR, { recursive: true })
  clearLoadCacheMemo()
})

afterEach(async () => {
  clearLoadCacheMemo()
  await rm(TMP_DIR, { recursive: true, force: true })
})

function file(provider: string, key: string): CachedFile {
  const timestamp = '2026-05-10T10:00:00.000Z'
  return {
    fingerprint: { dev: 1, ino: key.length, mtimeMs: 3, sizeBytes: 4 },
    lastCompleteLineOffset: 9,
    mcpInventory: [],
    turns: [{
      timestamp,
      sessionId: key,
      userMessage: 'go',
      calls: [{
        provider,
        model: 'claude-sonnet-4-20250514',
        usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0, cacheCreationOneHourTokens: 0 },
        costUSD: 0.01,
        speed: 'standard',
        timestamp,
        tools: [],
        bashCommands: [],
        skills: [],
        subagentTypes: [],
        deduplicationKey: `${key}-0`,
      }],
    }],
  }
}

describe('retired providers', () => {
  it('drops a retired provider from the session cache and deletes its files on the next save', async () => {
    const cache: SessionCache = {
      version: CACHE_VERSION,
      complete: true,
      providers: {
        claude: { envFingerprint: computeEnvFingerprint('claude'), files: { '/a.jsonl': file('claude', 'a') } },
        [RETIRED]: { envFingerprint: 'old', files: { '/r.json': file(RETIRED, 'r') } },
      },
    }
    markCacheDirty(cache, 'claude')
    markCacheDirty(cache, RETIRED)
    expect(await saveCache(cache)).toBe(true)
    clearLoadCacheMemo()
    const dir = sessionCacheDir()
    const before = await readdir(dir)

    const loaded = await loadCache()
    expect(Object.keys(loaded.providers)).toEqual(['claude'])
    expect(isCacheDirty(loaded)).toBe(true)
    expect(await saveCache(loaded)).toBe(true)

    const envelope = JSON.parse(await readFile(join(dir, 'envelope.json'), 'utf-8')) as { providers: Record<string, unknown> }
    expect(Object.keys(envelope.providers)).toEqual(['claude'])
    const after = await readdir(dir)
    expect(after.length).toBeLessThan(before.length)
    for (const name of after) expect(name).not.toContain(RETIRED)
    clearLoadCacheMemo()
    expect(Object.keys((await loadCache()).providers.claude!.files)).toEqual(['/a.jsonl'])
  })

  it('drops retired slices from daily history and the day totals they fed', async () => {
    const model = (cost: number, calls: number): ModelDayStats => ({ calls, cost, savingsUSD: 0, inputTokens: 10 * calls, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
    const base = { savingsUSD: 0, sessions: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, editTurns: 0, oneShotTurns: 0, categories: {} }
    const days: DailyEntry[] = [
      {
        ...base,
        date: '2026-05-10',
        cost: 2.5,
        calls: 3,
        inputTokens: 30,
        models: { Sonnet: model(2, 2), Other: model(0.5, 1) },
        providers: {
          claude: { cost: 2, calls: 2, savingsUSD: 0, inputTokens: 20, models: { Sonnet: model(2, 2) } },
          [RETIRED]: { cost: 0.5, calls: 1, savingsUSD: 0, inputTokens: 10, models: { Other: model(0.5, 1) } },
        },
      },
      {
        ...base,
        date: '2026-05-11',
        cost: 0.3,
        calls: 1,
        inputTokens: 10,
        models: { Other: model(0.3, 1) },
        providers: { [RETIRED]: { cost: 0.3, calls: 1, savingsUSD: 0, inputTokens: 10, models: { Other: model(0.3, 1) } } },
      },
    ]
    await writeFile(dailyCachePath(), JSON.stringify({ version: DAILY_CACHE_VERSION, savingsConfigHash: '', lastComputedDate: '2026-05-11', days, complete: true }))

    const loaded = await loadDailyCache()
    expect(loaded.days.map(d => d.date)).toEqual(['2026-05-10'])
    const day = loaded.days[0]!
    expect(Object.keys(day.providers)).toEqual(['claude'])
    expect(day.cost).toBe(2)
    expect(day.calls).toBe(2)
    expect(day.inputTokens).toBe(20)
    expect(Object.keys(day.models)).toEqual(['Sonnet'])
  })
})
