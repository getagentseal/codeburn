import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  parseUsageResponse,
  readSamplesInfo,
  sampledRecently,
  usageSamplesPath,
  SAMPLE_MIN_INTERVAL_MS,
} from '../src/usage-sampler.js'

const TS = new Date('2026-08-12T12:00:00Z')

// Captured shape of the oauth/usage endpoint (mirrors the menubar's decoder).
const RESPONSE = JSON.stringify({
  five_hour: { utilization: 37, resets_at: '2026-08-12T15:00:00Z' },
  seven_day: { utilization: 90, resets_at: '2026-08-14T00:00:00Z' },
  seven_day_opus: { utilization: 12 },
  limits: [
    { kind: 'weekly_scoped', percent: 100, resets_at: '2026-08-14T00:00:00Z', scope: { model: { display_name: 'Fable 5' } } },
    { kind: 'something_else', percent: 5 },
  ],
})

describe('parseUsageResponse', () => {
  it('maps windows and model-scoped weekly limits', () => {
    const sample = parseUsageResponse(RESPONSE, TS)
    expect(sample).toEqual({
      ts: TS.toISOString(),
      fiveHour: { pct: 37, resetsAt: '2026-08-12T15:00:00Z' },
      sevenDay: { pct: 90, resetsAt: '2026-08-14T00:00:00Z' },
      sevenDayOpus: { pct: 12 },
      scoped: [{ label: 'Fable 5', pct: 100, resetsAt: '2026-08-14T00:00:00Z' }],
    })
  })

  it('rejects malformed bodies and empty responses', () => {
    expect(parseUsageResponse('not json', TS)).toBeUndefined()
    expect(parseUsageResponse('{}', TS)).toBeUndefined()
    expect(parseUsageResponse(JSON.stringify({ five_hour: {} }), TS)).toBeUndefined()
  })
})

describe('sampling state on disk', () => {
  let dir: string
  let prevCacheDir: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'codeburn-sampler-'))
    prevCacheDir = process.env['CODEBURN_CACHE_DIR']
    process.env['CODEBURN_CACHE_DIR'] = dir
  })

  afterEach(async () => {
    if (prevCacheDir === undefined) delete process.env['CODEBURN_CACHE_DIR']
    else process.env['CODEBURN_CACHE_DIR'] = prevCacheDir
    await rm(dir, { recursive: true, force: true })
  })

  it('throttles on a fresh samples file, allows on a stale or missing one', async () => {
    expect(await sampledRecently()).toBe(false)

    await writeFile(usageSamplesPath(), '{"ts":"2026-08-12T11:59:00Z"}\n')
    expect(await sampledRecently()).toBe(true)

    const stale = new Date(Date.now() - SAMPLE_MIN_INTERVAL_MS - 1000)
    await utimes(usageSamplesPath(), stale, stale)
    expect(await sampledRecently()).toBe(false)
  })

  it('summarizes recorded samples', async () => {
    expect(await readSamplesInfo()).toEqual({ count: 0 })

    await writeFile(
      usageSamplesPath(),
      '{"ts":"2026-08-12T10:00:00Z"}\n{"ts":"2026-08-12T11:00:00Z"}\n',
    )
    expect(await readSamplesInfo()).toEqual({
      count: 2,
      firstTs: '2026-08-12T10:00:00Z',
      lastTs: '2026-08-12T11:00:00Z',
    })
  })
})
