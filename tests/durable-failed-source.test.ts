// A durable provider's source that fails to parse keeps the turns already
// cached for it (they may be the only record left), is listed by doctor, does
// not hold back daily finalisation, and is retried once a day even when a
// repair left its fingerprint unchanged. Quick Desktop stands in for any
// durable provider other than Copilot.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { clearLoadCacheMemo } from '../src/session-cache.js'
import { clearSessionCache, isSessionHydrationComplete, parseAllSessions } from '../src/parser.js'
import { collectDoctorReport } from '../src/doctor.js'
import { quickdesk } from '../src/providers/quickdesk.js'
import { readCacheOnDisk, writeCacheOnDisk } from './fixtures/session-cache-io.js'

let tmp: string
let metrics: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'durable-failed-'))
  vi.stubEnv('HOME', tmp)
  vi.stubEnv('CODEBURN_CACHE_DIR', join(tmp, 'cache'))
  vi.stubEnv('QUICKWORK_HOME', join(tmp, 'quickwork'))
  await mkdir(join(tmp, 'quickwork', 'metrics'), { recursive: true })
  const day = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10)
  metrics = join(tmp, 'quickwork', 'metrics', `metrics-${day}.jsonl`)
  await writeFile(metrics, JSON.stringify({ Model: 'claude-sonnet-4-5', InputTokens: 12, OutputTokens: 6, CostUSD: 0.002 }) + '\n')
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  clearSessionCache()
  clearLoadCacheMemo()
  await rm(tmp, { recursive: true, force: true })
})

async function servedInputs(): Promise<number[]> {
  clearSessionCache()
  clearLoadCacheMemo()
  const projects = await parseAllSessions(undefined, 'quickdesk')
  return projects.flatMap(p => p.sessions).flatMap(s => s.turns).flatMap(t => t.assistantCalls).map(c => c.usage.inputTokens).sort()
}

const quickdeskEntry = async () => Object.values((await readCacheOnDisk()).providers['quickdesk']!.files)[0]!

it('keeps the cached rows of a failing durable source, lists it in doctor and retries it a day later', async () => {
  expect(await servedInputs()).toEqual([12])

  const parser = vi.spyOn(quickdesk, 'createSessionParser').mockImplementation(() => ({
    async *parse() { throw new Error('unreadable') },
  }))
  await appendFile(metrics, JSON.stringify({ Model: 'claude-sonnet-4-5', InputTokens: 20, OutputTokens: 6, CostUSD: 0.003 }) + '\n')
  expect(await servedInputs()).toEqual([12])
  expect(isSessionHydrationComplete()).toBe(true)
  expect((await quickdeskEntry()).failed).toBe(true)
  const report = await collectDoctorReport('quickdesk', { cache: await readCacheOnDisk(), dailyCacheDays: [], launchers: [] })
  expect(report.cacheHealth?.sessionCacheIssues).toEqual([{ provider: 'quickdesk', path: metrics, reason: 'failed' }])

  // Repaired without touching the file: not retried within the day...
  parser.mockRestore()
  expect(await servedInputs()).toEqual([12])

  // ...but retried once the marker is a day old.
  const cache = await readCacheOnDisk()
  cache.providers['quickdesk']!.files[metrics]!.failedAt = new Date(Date.now() - 2 * 86400000).toISOString()
  await writeCacheOnDisk(cache)
  expect(await servedInputs()).toEqual([12, 20])
  expect((await quickdeskEntry()).failed).toBeUndefined()
})
