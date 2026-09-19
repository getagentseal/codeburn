import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { aggregateProjectsIntoDays } from '../src/day-aggregator.js'
import {
  CARRIED_MODEL_NAME,
  DAILY_CACHE_VERSION,
  type DailyEntry,
  currentTzKey,
  dailyCachePath,
  loadDailyCache,
  saveDailyCache,
} from '../src/daily-cache.js'
import { allProviderNames } from '../src/providers/index.js'
import type { ProjectSummary } from '../src/types.js'

const TMP_CACHE_ROOT = join(tmpdir(), `codeburn-reconcile-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)

beforeEach(async () => {
  process.env['CODEBURN_CACHE_DIR'] = TMP_CACHE_ROOT
  await mkdir(TMP_CACHE_ROOT, { recursive: true })
})

afterEach(async () => {
  if (existsSync(TMP_CACHE_ROOT)) await rm(TMP_CACHE_ROOT, { recursive: true, force: true })
})

function sum(models: Record<string, { calls: number; cost: number }>, key: 'calls' | 'cost'): number {
  return Object.values(models).reduce((s, m) => s + m[key], 0)
}

function callFor(provider: string, model: string, timestamp: string, costUSD: number) {
  return {
    provider,
    model,
    usage: {
      inputTokens: 100, outputTokens: 200, cacheCreationInputTokens: 10,
      cacheReadInputTokens: 50, cachedInputTokens: 0, reasoningTokens: 7, webSearchRequests: 0,
    },
    costUSD,
    tools: [], mcpTools: [], skills: [],
    hasAgentSpawn: false, hasPlanMode: false,
    speed: 'standard' as const,
    timestamp,
    bashCommands: [],
    deduplicationKey: `${provider}-${timestamp}-${costUSD}`,
  }
}

function projectFor(provider: string): ProjectSummary {
  const calls = [
    callFor(provider, 'model-a', '2026-05-06T10:00:00.000Z', 1.5),
    callFor(provider, 'model-b', '2026-05-06T11:00:00.000Z', 2.25),
  ]
  return {
    project: 'p',
    projectPath: '/p',
    totalCostUSD: 3.75,
    totalApiCalls: 2,
    sessions: [{
      sessionId: `${provider}-s1`,
      project: 'p',
      firstTimestamp: calls[0]!.timestamp,
      lastTimestamp: calls[1]!.timestamp,
      totalCostUSD: 3.75,
      totalInputTokens: 200, totalOutputTokens: 400,
      totalCacheReadTokens: 100, totalCacheWriteTokens: 20,
      apiCalls: 2,
      turns: [{
        userMessage: 'do the thing',
        timestamp: calls[0]!.timestamp,
        sessionId: `${provider}-s1`,
        category: 'coding',
        retries: 0,
        hasEdits: true,
        assistantCalls: calls,
      }],
      modelBreakdown: {}, toolBreakdown: {}, mcpBreakdown: {}, bashBreakdown: {},
      categoryBreakdown: {} as never,
      skillBreakdown: {} as never,
    }],
  }
}

describe('provider slices always carry a model breakdown', () => {
  it.each(allProviderNames())('%s writes slice models that sum to the slice', provider => {
    for (const day of aggregateProjectsIntoDays([projectFor(provider)])) {
      expect(sum(day.models, 'calls')).toBe(day.calls)
      expect(sum(day.models, 'cost')).toBeCloseTo(day.cost, 10)
      for (const slice of Object.values(day.providers)) {
        expect(slice.models).toBeDefined()
        expect(sum(slice.models!, 'calls')).toBe(slice.calls)
        expect(sum(slice.models!, 'cost')).toBeCloseTo(slice.cost, 10)
      }
    }
  })
})

async function writeRawCache(days: unknown[]): Promise<void> {
  await writeFile(dailyCachePath(), JSON.stringify({
    version: DAILY_CACHE_VERSION,
    savingsConfigHash: '',
    tzKey: currentTzKey(),
    lastComputedDate: '2026-05-06',
    complete: true,
    watermarkTrusted: true,
    days,
  }), 'utf-8')
}

const MODELLESS_DAY = {
  date: '2026-05-06',
  cost: 30,
  savingsUSD: 0,
  calls: 300,
  sessions: 1,
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  editTurns: 0, oneShotTurns: 0,
  models: { 'Opus 4.7': { calls: 100, cost: 10, savingsUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
  categories: {},
  carried: true,
  providers: {
    // Written before slices carried a per-model split: calls and cost, nothing to attribute them to.
    claude: { calls: 200, cost: 20, savingsUSD: 0 },
    codex: { calls: 100, cost: 10, savingsUSD: 0, models: { 'Opus 4.7': { calls: 100, cost: 10, savingsUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
  },
}

describe('carried days credit their unexplained remainder', () => {
  it('reconciles a day whose provider slice has no models map', async () => {
    await writeRawCache([MODELLESS_DAY])
    const [day] = (await loadDailyCache()).days as [DailyEntry]

    expect(day.models[CARRIED_MODEL_NAME]).toEqual(expect.objectContaining({ calls: 200, cost: 20 }))
    expect(sum(day.models, 'calls')).toBe(day.calls)
    expect(sum(day.models, 'cost')).toBeCloseTo(day.cost, 10)
    for (const slice of Object.values(day.providers)) {
      expect(sum(slice.models!, 'calls')).toBe(slice.calls)
      expect(sum(slice.models!, 'cost')).toBeCloseTo(slice.cost, 10)
    }
    expect(day.providers['codex']!.models![CARRIED_MODEL_NAME]).toBeUndefined()
  })

  it('adds no row to a day that already reconciles', async () => {
    await writeRawCache([{
      ...MODELLESS_DAY,
      calls: 100,
      cost: 10,
      carried: undefined,
      providers: { codex: MODELLESS_DAY.providers.codex },
    }])
    const [day] = (await loadDailyCache()).days as [DailyEntry]

    expect(day.models[CARRIED_MODEL_NAME]).toBeUndefined()
    expect(day.providers['codex']!.models![CARRIED_MODEL_NAME]).toBeUndefined()
    expect(sum(day.models, 'calls')).toBe(day.calls)
  })

  it('credits cost that no row explains even when every call is accounted for', async () => {
    await writeRawCache([{
      ...MODELLESS_DAY,
      calls: 100,
      cost: 19,
      carried: undefined,
      // 100 calls, all named; $9 of the day's $19 belongs to no row.
      providers: { codex: { ...MODELLESS_DAY.providers.codex, cost: 19 } },
    }])
    const [day] = (await loadDailyCache()).days as [DailyEntry]

    expect(day.models[CARRIED_MODEL_NAME]).toEqual(expect.objectContaining({ calls: 0, cost: 9 }))
    expect(day.providers['codex']!.models![CARRIED_MODEL_NAME]).toEqual(expect.objectContaining({ calls: 0, cost: 9 }))
    expect(sum(day.models, 'cost')).toBeCloseTo(day.cost, 10)
  })

  it('credits savings that no row explains', async () => {
    await writeRawCache([{
      ...MODELLESS_DAY,
      calls: 100,
      cost: 10,
      savingsUSD: 7,
      carried: undefined,
      providers: { codex: { ...MODELLESS_DAY.providers.codex, savingsUSD: 7 } },
    }])
    const [day] = (await loadDailyCache()).days as [DailyEntry]

    expect(day.models[CARRIED_MODEL_NAME]).toEqual(expect.objectContaining({ calls: 0, cost: 0, savingsUSD: 7 }))
    expect(day.providers['codex']!.models![CARRIED_MODEL_NAME]!.savingsUSD).toBe(7)
    expect(sum(day.models, 'savingsUSD')).toBeCloseTo(day.savingsUSD, 10)
  })

  it('ignores a sub-cent float residue rather than growing a row for it', async () => {
    await writeRawCache([{
      ...MODELLESS_DAY,
      calls: 100,
      cost: 10 + 1e-13,
      carried: undefined,
      providers: { codex: { ...MODELLESS_DAY.providers.codex, cost: 10 + 1e-13 } },
    }])
    const [day] = (await loadDailyCache()).days as [DailyEntry]

    expect(day.models[CARRIED_MODEL_NAME]).toBeUndefined()
    expect(day.providers['codex']!.models![CARRIED_MODEL_NAME]).toBeUndefined()
  })

  it('is stable when the credited cache is saved and loaded again', async () => {
    await writeRawCache([MODELLESS_DAY])
    const once = await loadDailyCache()
    await saveDailyCache(once)
    const twice = await loadDailyCache()

    expect(twice.days).toEqual(once.days)
  })
})
