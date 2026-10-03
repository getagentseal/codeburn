import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { aggregateProjectsIntoDays } from '../src/day-aggregator.js'
import {
  addNewDays,
  DAILY_CACHE_VERSION,
  dailyCachePath,
  emptyCache,
  loadDailyCache,
  mergeDayEntries,
  type DailyEntry,
} from '../src/daily-cache.js'
import { exactProjectBucketKey, legacyProjectBucketKey } from '../src/project-scope.js'
import { project } from './fixtures/project-scope.js'

const TMP_CACHE_ROOT = join(tmpdir(), `codeburn-project-scope-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)

beforeEach(() => {
  process.env['CODEBURN_CACHE_DIR'] = TMP_CACHE_ROOT
})

afterEach(async () => {
  if (existsSync(TMP_CACHE_ROOT)) await rm(TMP_CACHE_ROOT, { recursive: true, force: true })
})

function rekeyProject(
  day: DailyEntry,
  key: string,
  overrides: Record<string, unknown> = {},
): DailyEntry {
  const source = Object.values(day.projects ?? {})[0] ?? {
    cost: day.cost,
    calls: day.calls,
    savingsUSD: day.savingsUSD,
    sessions: day.sessions,
  }
  const stats = { ...source, ...overrides }
  const projects = { [key]: stats }
  const providers = Object.fromEntries(
    Object.entries(day.providers).map(([provider, slice]) => [provider, { ...slice, projects }]),
  )
  return { ...day, projects, providers }
}

function reconcileFreshAndRetained(fresh: DailyEntry[], retained: DailyEntry[]): DailyEntry[] {
  return mergeDayEntries(fresh, retained, false, undefined, 'prefer-richer')
}

describe('Desktop project scope daily cache', () => {
  it('writes exact namespaced buckets with full project and provider breakdowns', () => {
    const day = aggregateProjectsIntoDays([project('alpha', '/work/alpha', 12.5)])[0]!
    const key = exactProjectBucketKey('path:/work/alpha')

    expect(day.projects?.[key]).toMatchObject({
      canonicalId: 'path:/work/alpha',
      sourceLabel: 'alpha',
      displayName: 'alpha',
      path: '/work/alpha',
      provenance: 'exact',
      cost: 12.5,
      calls: 1,
      savingsUSD: 0,
      sessions: 1,
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
      cacheReadTokens: expect.any(Number),
      cacheWriteTokens: expect.any(Number),
      editTurns: expect.any(Number),
      oneShotTurns: expect.any(Number),
      models: expect.any(Object),
      categories: expect.any(Object),
    })
    expect(day.providers.claude?.projects?.[key]).toMatchObject({
      canonicalId: 'path:/work/alpha',
      provenance: 'exact',
      cost: 12.5,
      inputTokens: expect.any(Number),
      models: expect.any(Object),
      categories: expect.any(Object),
    })
  })

  it('migrates old label-keyed buckets as legacy without inventing a canonical id', async () => {
    await mkdir(TMP_CACHE_ROOT, { recursive: true })
    await writeFile(dailyCachePath(), JSON.stringify({
      version: DAILY_CACHE_VERSION - 1,
      savingsConfigHash: '',
      lastComputedDate: '2026-09-01',
      days: [{
        date: '2026-09-01',
        projects: { alpha: { cost: 3, calls: 1, savingsUSD: 0, sessions: 1, path: '/work/alpha' } },
      }],
    }), 'utf8')

    const migrated = await loadDailyCache()
    const bucket = migrated.days[0]!.projects?.[legacyProjectBucketKey('alpha')]

    expect(bucket).toMatchObject({
      canonicalId: null,
      sourceLabel: 'alpha',
      displayName: 'alpha',
      path: '/work/alpha',
      provenance: 'legacy',
      cost: 3,
      calls: 1,
      sessions: 1,
    })
    expect(migrated.days[0]!.projects?.[exactProjectBucketKey('path:/work/alpha')]).toBeUndefined()
  })

  it('never merges a legacy label bucket into an exact path bucket', () => {
    const legacy = rekeyProject(
      aggregateProjectsIntoDays([project('alpha', undefined, 3, 'claude')])[0]!,
      legacyProjectBucketKey('alpha'),
      {
        canonicalId: null,
        sourceLabel: 'alpha',
        displayName: 'alpha',
        path: null,
        provenance: 'legacy',
      },
    )
    const exact = rekeyProject(
      aggregateProjectsIntoDays([project('alpha', '/work/alpha', 5, 'codex')])[0]!,
      exactProjectBucketKey('path:/work/alpha'),
    )

    const projected = mergeDayEntries([legacy], [exact], false)
    expect(Object.keys(projected[0]!.projects ?? {})).toEqual(expect.arrayContaining([
      legacyProjectBucketKey('alpha'),
      exactProjectBucketKey('path:/work/alpha'),
    ]))
  })

  it('preserves exact buckets through timezone re-aggregation and retention', () => {
    const day = aggregateProjectsIntoDays([project('alpha', '/work/alpha', 5)])[0]!
    const cache = addNewDays(emptyCache(), [day], day.date)

    expect(cache.days[0]!.projects?.[exactProjectBucketKey('path:/work/alpha')]?.cost).toBe(5)
  })

  it('keeps unscoped reconciliation from double-counting fresh and retained project data', () => {
    const fresh = aggregateProjectsIntoDays([project('alpha', '/work/alpha', 5, 'claude')])
    const retained = aggregateProjectsIntoDays([project('alpha', '/work/alpha', 5, 'claude')])

    const result = reconcileFreshAndRetained(fresh, retained)
    expect(result[0]!.cost).toBe(5)
    expect(result[0]!.projects?.[exactProjectBucketKey('path:/work/alpha')]?.cost).toBe(5)
  })
})
