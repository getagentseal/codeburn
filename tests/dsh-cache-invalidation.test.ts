import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'crypto'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'

const testRoot = vi.hoisted(() => {
  const root = `${process.env['TMPDIR'] || '/tmp'}/dsh-cache-inv-${process.pid}-${Date.now()}`
  process.env['DSH_HOME'] = `${root}/dsh`
  return root
})

import { clearSessionCache, parseAllSessions } from '../src/parser.js'
import { billableOutputTokens, calculateCost } from '../src/models.js'
import { aggregateSessions } from '../src/sessions-report.js'
import { aggregateModelStats } from '../src/compare-stats.js'
import { aggregateProjectsIntoDays } from '../src/day-aggregator.js'
import { currentTzKey, ensureCacheHydrated, loadDailyCache } from '../src/daily-cache.js'
import {
  CACHE_VERSION,
  computeEnvFingerprint,
  fingerprintFile,
  type SessionCache,
} from '../src/session-cache.js'
import { readCacheOnDisk, writeCacheOnDisk } from './fixtures/session-cache-io.js'

const DSH_HOME = join(testRoot, 'dsh')
const CACHE_DIR = join(testRoot, 'cache')
const SESSION_DIR = join(DSH_HOME, 'sessions', '--home-u-proj--', 'session-cache')

function header(version: 0 | 3): string {
  return JSON.stringify({
    type: 'session', version, id: 'session-cache', createdAt: 1786707336131,
    cwd: '/home/u/proj', ...(version === 3 ? { isSeeded: false } : {}), delegationDepth: 0,
  })
}

function message(seq: number, step: number, inputTokens: number, reasoningTokens = 0, time = 1786707340000 + seq): string {
  return JSON.stringify({
    type: 'assistant/message', seq, time, surfaceOp: 'append',
    data: {
      turn: 1, step,
      message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'openai', model: 'gpt-5.4' } },
      usage: { inputTokens, outputTokens: 5, reasoningTokens },
      stream: [],
    },
  })
}

async function writeLog(version: 0 | 3, inputs: number[]): Promise<string> {
  await mkdir(SESSION_DIR, { recursive: true })
  const path = join(SESSION_DIR, version === 0 ? 'session.jsonl' : 'session.v3.jsonl')
  await writeFile(path, [header(version), ...inputs.map((input, index) => message(index, index + 1, input))].join('\n') + '\n')
  return path
}

async function calls() {
  return (await parseAllSessions(undefined, 'dsh'))
    .flatMap(project => project.sessions)
    .flatMap(session => session.turns)
    .flatMap(turn => turn.assistantCalls)
}

function preFixFingerprint(): string {
  return createHash('sha256')
    .update([`DSH_HOME=${process.env['DSH_HOME'] ?? ''}`, 'parser=seed-aware-v1'].join('\0'))
    .digest('hex')
    .slice(0, 16)
}

async function seedEmptyCache(path: string, envFingerprint: string): Promise<void> {
  const fingerprint = await fingerprintFile(path)
  if (!fingerprint) throw new Error('failed to fingerprint DSH fixture')
  const cache: SessionCache = {
    version: CACHE_VERSION,
    complete: true,
    providers: {
      dsh: {
        envFingerprint,
        files: { [path]: { fingerprint, mcpInventory: [], turns: [] } },
      },
    },
  }
  await mkdir(CACHE_DIR, { recursive: true })
  await writeCacheOnDisk(cache)
  clearSessionCache()
}

beforeEach(async () => {
  process.env['CODEBURN_CACHE_DIR'] = CACHE_DIR
  process.env['DSH_HOME'] = DSH_HOME
  clearSessionCache()
  await rm(testRoot, { recursive: true, force: true })
})

afterAll(async () => {
  clearSessionCache()
  await rm(testRoot, { recursive: true, force: true })
})

describe('DSH multi-generation session cache', () => {
  it('reparses v4 caches that stored exclusive output before the shared inclusive rule', async () => {
    const path = await writeLog(3, [])
    await writeFile(path, [header(3), message(0, 1, 100, 3)].join('\n') + '\n')
    await calls()
    const cache = await readCacheOnDisk()
    const section = cache.providers.dsh!
    section.envFingerprint = createHash('sha256').update([
      `DSH_HOME=${DSH_HOME}`, 'parser=session-formats-v0-v3-attempts-v4',
    ].join('\0')).digest('hex').slice(0, 16)
    for (const turn of section.files[path]!.turns) {
      for (const call of turn.calls) call.usage.outputTokens = 2
    }
    await writeCacheOnDisk(cache)
    clearSessionCache()
    const corrected = await calls()
    expect(corrected[0]!.usage).toMatchObject({ outputTokens: 5, reasoningTokens: 3 })
    expect(corrected[0]!.costUSD).toBeCloseTo(calculateCost('gpt-5.4', 100, 5, 0, 0, 0), 12)
  })

  it('counts separate legacy and current sessions while counting migrated history only once, cold and warm', async () => {
    const versions = [0, 1, 2, 3] as const
    for (const version of versions) {
      const content = await readFile(join(import.meta.dirname, `fixtures/dsh/v${version}.jsonl`), 'utf8')
      for (const id of [`independent-v${version}`, ...(version === 0 || version === 3 ? ['migrated'] : [])]) {
        const rows = content.trim().split('\n')
        const metadata = JSON.parse(rows[0]!)
        rows[0] = JSON.stringify({ ...metadata, id })
        const dir = join(DSH_HOME, 'sessions', '--fixture--', id)
        await mkdir(dir, { recursive: true })
        const filename = version === 0 ? 'session.jsonl' : `session.v${version}.jsonl`
        await writeFile(join(dir, filename), rows.join('\n') + '\n')
      }
    }

    // Six files represent five sessions. All four independent versions count;
    // only the migrated session's v0 file is superseded by its own v3 file.
    for (const phase of ['cold', 'warm', 'reloaded']) {
      if (phase === 'reloaded') clearSessionCache()
      const projects = await parseAllSessions(undefined, 'dsh')
      const sessions = projects.flatMap(project => project.sessions)
      expect(sessions.map(session => session.sessionId).sort()).toEqual([
        'independent-v0', 'independent-v1', 'independent-v2', 'independent-v3', 'migrated',
      ])
      const parsed = sessions.flatMap(session => session.turns).flatMap(turn => turn.assistantCalls)
      expect(parsed).toHaveLength(5)
      expect(parsed.reduce((sum, call) => sum + call.usage.inputTokens, 0)).toBe(500)
      expect(parsed.reduce((sum, call) => sum + billableOutputTokens('dsh', call.usage.outputTokens, call.usage.reasoningTokens), 0)).toBe(100)
      expect(parsed.reduce((sum, call) => sum + call.usage.cacheReadInputTokens, 0)).toBe(150)
      expect(parsed.reduce((sum, call) => sum + call.usage.cacheCreationInputTokens, 0)).toBe(25)
    }
  })
  it('re-derives finalized v31 days from the authoritative generation even when the call count falls', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-16T12:00:00Z'))
    try {
      await writeLog(0, [100, 200])
      const staleDays = aggregateProjectsIntoDays(await parseAllSessions(undefined, 'dsh'))
      expect(staleDays[0]!.calls).toBe(2)
      const oldCache = {
        version: 31, savingsConfigHash: 'dsh-test', tzKey: currentTzKey(),
        lastComputedDate: '2026-08-15', days: staleDays, complete: true, watermarkTrusted: true,
      }
      const oldPath = join(CACHE_DIR, 'daily-cache.v31.json')
      await writeFile(oldPath, JSON.stringify(oldCache))
      await writeLog(3, [20])
      clearSessionCache()
      expect((await loadDailyCache()).pendingRederive).toContain('dsh')

      const parse = vi.fn(range => parseAllSessions(range, 'dsh'))
      const hydrated = await ensureCacheHydrated(parse, aggregateProjectsIntoDays, 'dsh-test')
      expect(parse).toHaveBeenCalledTimes(1)
      expect(hydrated.complete).toBe(true)
      expect(hydrated.pendingRederive).toBeUndefined()
      expect(hydrated.days).toEqual([expect.objectContaining({
        inputTokens: 20, outputTokens: 5, calls: 1,
        providers: expect.objectContaining({ dsh: expect.objectContaining({ inputTokens: 20, calls: 1 }) }),
      })])
      expect(JSON.parse(await readFile(oldPath, 'utf8'))).toEqual(oldCache)

      parse.mockClear()
      expect((await ensureCacheHydrated(parse, aggregateProjectsIntoDays, 'dsh-test')).days).toEqual(hydrated.days)
      expect(parse).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('filters a cross-day session identically before and after a disk-cache reload', async () => {
    const path = await writeLog(3, [])
    await writeFile(path, [header(3),
      message(0, 1, 10, 0, Date.parse('2026-08-14T23:59:00Z')),
      message(1, 2, 20, 0, Date.parse('2026-08-15T00:01:00Z')),
    ].join('\n') + '\n')
    const range = { start: new Date('2026-08-15T00:00:00Z'), end: new Date('2026-08-15T23:59:59Z') }
    for (const reload of [false, true]) {
      if (reload) clearSessionCache()
      const projects = await parseAllSessions(range, 'dsh')
      expect(aggregateSessions(projects)).toEqual([expect.objectContaining({ inputTokens: 20, outputTokens: 5, calls: 1 })])
      expect(aggregateProjectsIntoDays(projects)).toEqual([expect.objectContaining({ date: '2026-08-15', inputTokens: 20, calls: 1 })])
    }
  })

  it.each(['unknown', 'corrupt'])('does not revive a cached older generation when its successor is %s', async (kind) => {
    await writeLog(0, [100])
    expect(await calls()).toHaveLength(1)
    const successor = kind === 'unknown' ? 'session.v4.jsonl' : 'session.v3.jsonl'
    await writeFile(join(SESSION_DIR, successor), kind === 'unknown'
      ? JSON.stringify({ type: 'session', version: 4 }) + '\n'
      : '{broken\n')
    clearSessionCache()
    expect(await calls()).toEqual([])
    clearSessionCache()
    expect(await calls()).toEqual([])
  })

  it('preserves inclusive reasoning buckets and shared totals through cold and hot caches', async () => {
    const path = await writeLog(3, [])
    await writeFile(path, [header(3), message(0, 1, 100, 3)].join('\n') + '\n')
    const expectedCost = calculateCost('gpt-5.4', 100, 5, 0, 0, 0)

    for (const reload of [false, false, true]) {
      if (reload) clearSessionCache()
      const projects = await parseAllSessions(undefined, 'dsh')
      const parsedCalls = projects.flatMap(project => project.sessions)
        .flatMap(session => session.turns).flatMap(turn => turn.assistantCalls)
      expect(parsedCalls).toHaveLength(1)
      expect(parsedCalls[0]!.usage).toMatchObject({ inputTokens: 100, outputTokens: 5, reasoningTokens: 3 })
      expect(parsedCalls[0]!.costUSD).toBeCloseTo(expectedCost, 12)
      expect(aggregateSessions(projects)).toEqual([expect.objectContaining({ outputTokens: 5, cost: expectedCost })])
      expect(aggregateModelStats(projects)).toEqual([expect.objectContaining({ outputTokens: 5, cost: expectedCost })])
      expect(aggregateProjectsIntoDays(projects)).toEqual([expect.objectContaining({ outputTokens: 5 })])
    }
  })

  it('invalidates a pre-v3 parser fingerprint instead of trusting stale empty results', async () => {
    const path = await writeLog(3, [100])
    expect(computeEnvFingerprint('dsh')).not.toBe(preFixFingerprint())

    await seedEmptyCache(path, computeEnvFingerprint('dsh'))
    expect(await calls()).toHaveLength(0)

    await seedEmptyCache(path, preFixFingerprint())
    expect((await calls()).map(call => call.usage.inputTokens)).toEqual([100])
  })

  it('switches generations without double counting, reparses appends, and survives a cold reload', async () => {
    await writeLog(0, [10])
    expect((await calls()).map(call => call.usage.inputTokens)).toEqual([10])

    const v3Path = await writeLog(3, [20])
    clearSessionCache()
    expect((await calls()).map(call => call.usage.inputTokens)).toEqual([20])

    await writeFile(v3Path, [header(3), message(0, 1, 20), message(1, 2, 30)].join('\n') + '\n')
    clearSessionCache()
    expect((await calls()).map(call => call.usage.inputTokens)).toEqual([20, 30])

    clearSessionCache()
    expect((await calls()).map(call => call.usage.inputTokens)).toEqual([20, 30])
  })
})
