import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { clearSessionCache, parseAllSessions } from '../src/parser.js'
import { computeEnvFingerprint } from '../src/session-cache.js'
import { currentTzKey, ensureCacheHydrated, toDateString } from '../src/daily-cache.js'
import { aggregateProjectsIntoDays } from '../src/day-aggregator.js'

afterEach(() => {
  clearSessionCache()
  vi.unstubAllEnvs()
})

async function seed(state: string, id: string, input: number, timestamp: string): Promise<void> {
  const sessions = join(state, 'agents', 'fixture-agent', 'sessions')
  await mkdir(sessions, { recursive: true })
  const events = [
    { type: 'session', version: 3, id, timestamp, cwd: '/fixture/project' },
    { type: 'message', id: `${id}-user`, timestamp, message: { role: 'user', content: [{ type: 'text', text: 'Fix the fixture' }] } },
    { type: 'message', id: `${id}-reply`, timestamp, message: {
      role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'Done' }],
      usage: { input, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
    } },
  ]
  await writeFile(join(sessions, `${id}.jsonl`), events.map(event => JSON.stringify(event)).join('\n') + '\n')
}

describe('OpenClaw discovery cache invalidation', () => {
  it.each(['OPENCLAW_STATE_DIR', 'OPENCLAW_HOME', 'HOME', 'USERPROFILE', 'PREFIX', 'ANDROID_DATA'])('fingerprints changes to %s', name => {
    const before = computeEnvFingerprint('openclaw')
    vi.stubEnv(name, '/fixture/relocated')
    expect(computeEnvFingerprint('openclaw')).not.toBe(before)
  })

  it('rediscovers the selected state directory after a warm parse', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openclaw-warm-root-'))
    try {
      vi.stubEnv('CODEBURN_CACHE_DIR', join(root, 'cache'))
      const first = join(root, 'first')
      const second = join(root, 'second')
      const timestamp = '2026-04-20T10:00:00Z'
      await seed(first, 'first', 100, timestamp)
      await seed(second, 'second', 200, timestamp)
      vi.stubEnv('OPENCLAW_STATE_DIR', first)
      const initial = aggregateProjectsIntoDays(await parseAllSessions(undefined, 'openclaw'))
      expect(initial[0]).toMatchObject({ calls: 1, inputTokens: 100, outputTokens: 20 })
      vi.stubEnv('OPENCLAW_STATE_DIR', second)
      // A new CLI invocation has no in-process report memo, but retains the
      // disk session cache produced under the previous environment.
      clearSessionCache()
      const changed = aggregateProjectsIntoDays(await parseAllSessions(undefined, 'openclaw'))
      expect(changed[0]).toMatchObject({ calls: 1, inputTokens: 200, outputTokens: 20 })
      expect(changed).toHaveLength(1)
    } finally {
      clearSessionCache()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['OPENCLAW_STATE_DIR', 'OPENCLAW_HOME', 'cwd'])('refreshes finalized history after a same-version root change (%s) without losing archived usage', async rootSetting => {
    const root = await mkdtemp(join(tmpdir(), 'openclaw-finalized-root-'))
    let cwd: ReturnType<typeof vi.spyOn> | undefined
    try {
      vi.stubEnv('CODEBURN_CACHE_DIR', join(root, 'cache'))
      const first = join(root, 'first')
      const second = join(root, 'second')
      const timestamp = new Date(Date.now() - 30 * 86400000).toISOString()
      const date = toDateString(new Date(timestamp))
      const state = (base: string) => rootSetting === 'OPENCLAW_HOME' ? join(base, '.openclaw') : rootSetting === 'cwd' ? join(base, 'relative-state') : base
      await seed(state(first), 'first', 100, timestamp)
      await seed(state(second), 'second', 200, timestamp)
      const selectRoot = (base: string) => {
        if (rootSetting === 'cwd') {
          vi.stubEnv('OPENCLAW_STATE_DIR', 'relative-state')
          if (!cwd) cwd = vi.spyOn(process, 'cwd')
          cwd.mockReturnValue(base)
        } else vi.stubEnv(rootSetting, base)
      }
      selectRoot(first)
      let includeArchivedUsage = true
      const parse = async () => {
        const projects = await parseAllSessions(undefined, 'openclaw')
        if (!includeArchivedUsage) return projects
        const archived = structuredClone(projects)
        for (const project of archived) for (const session of project.sessions) for (const turn of session.turns) for (const call of turn.assistantCalls) {
          call.provider = 'claude'
          call.usage.inputTokens = 50
          call.costUSD = 0.02
        }
        return [...projects, ...archived]
      }
      const initial = await ensureCacheHydrated(parse, aggregateProjectsIntoDays)
      expect(initial.complete).toBe(true)
      expect(initial.days.find(day => day.date === date)).toMatchObject({ calls: 2, inputTokens: 150 })

      includeArchivedUsage = false
      selectRoot(second)
      clearSessionCache()
      const partial = await ensureCacheHydrated(parse, aggregateProjectsIntoDays, '', () => false)
      expect(partial.complete).toBe(false)
      expect(partial.days.find(day => day.date === date)).toMatchObject({ calls: 2, inputTokens: 150 })
      const refreshed = await ensureCacheHydrated(parse, aggregateProjectsIntoDays)
      const day = refreshed.days.find(day => day.date === date)!
      expect(day).toMatchObject({ calls: 2, inputTokens: 250, outputTokens: 40 })
      expect(day.providers.openclaw).toMatchObject({ calls: 1, inputTokens: 200, cost: 0.01 })
      expect(day.providers.claude).toMatchObject({ calls: 1, inputTokens: 50, cost: 0.02 })
      const warmParse = vi.fn(parse)
      await ensureCacheHydrated(warmParse, aggregateProjectsIntoDays)
      expect(warmParse).not.toHaveBeenCalled()
    } finally {
      cwd?.mockRestore()
      clearSessionCache()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([51, 73])('backfills relocated history from a finalized v%i daily cache and retains archived usage', async version => {
    const root = await mkdtemp(join(tmpdir(), 'openclaw-daily-backfill-'))
    try {
      const cache = join(root, 'cache')
      const state = join(root, 'state')
      vi.stubEnv('CODEBURN_CACHE_DIR', cache)
      vi.stubEnv('OPENCLAW_STATE_DIR', state)
      const timestamp = new Date(Date.now() - 4 * 86400000).toISOString()
      const date = toDateString(new Date(timestamp))
      await seed(state, 'relocated', 100, timestamp)
      const parse = () => parseAllSessions(undefined, 'openclaw')
      const fresh = await parse()
      expect(aggregateProjectsIntoDays(fresh)[0]).toMatchObject({ date, calls: 1, inputTokens: 100 })

      // Simulate an old finalized day with another provider's unavailable log.
      const archived = structuredClone(fresh)
      for (const project of archived) for (const session of project.sessions) for (const turn of session.turns) for (const call of turn.assistantCalls) {
        call.provider = 'claude'
        call.usage.inputTokens = 50
        call.costUSD = 0.02
      }
      await mkdir(cache, { recursive: true })
      await writeFile(join(cache, `daily-cache.v${version}.json`), JSON.stringify({
        version, savingsConfigHash: '', tzKey: currentTzKey(),
        lastComputedDate: toDateString(new Date(Date.now() - 86400000)),
        days: aggregateProjectsIntoDays(archived), complete: true, watermarkTrusted: true,
      }))
      const hydrated = await ensureCacheHydrated(parse, aggregateProjectsIntoDays)
      const day = hydrated.days.find(d => d.date === date)!
      expect(day).toMatchObject({ calls: 2, inputTokens: 150, outputTokens: 40 })
      expect(day.providers.openclaw).toMatchObject({ calls: 1, inputTokens: 100, cost: 0.01 })
      expect(day.providers.claude).toMatchObject({ calls: 1, inputTokens: 50, cost: 0.02 })
    } finally {
      clearSessionCache()
      await rm(root, { recursive: true, force: true })
    }
  })
})
