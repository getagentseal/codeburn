import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  DAILY_CACHE_VERSION,
  currentTzKey,
  mergeDayEntries,
  type DailyCache,
  type DailyEntry,
  type ProviderDaySlice,
} from '../src/daily-cache.js'
import { loadPricing } from '../src/models.js'
import { buildDurablePeriod, buildPeriodData, getDailyCacheConfigHash } from '../src/usage-aggregator.js'
import { parseAllSessions, filterProjectsByName, clearSessionCache } from '../src/parser.js'
import type { DateRange } from '../src/types.js'

// #1217. A day is derived into the durable cache once and then frozen behind
// the watermark, while `isPartialSurvival` lets a fresh derivation SHRINK a day
// inside the settle window. One parse that missed sources therefore became
// permanent: the Overview headline sat 27% below the Daily Activity rows
// printed underneath it, on days whose transcripts were intact the whole time.
// The headline must never report less than the parse it is standing on.

const ROOT = join(tmpdir(), `codeburn-underread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
const ENV_KEYS = ['HOME', 'CODEBURN_CACHE_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CONFIG_DIRS', 'CODEX_HOME', 'USERPROFILE', 'KIMI_CODE_HOME', 'CODEBURN_DESKTOP_SESSIONS_DIR'] as const
let savedEnv: Record<string, string | undefined>

// The codex provider captures its home at import time, so redirect it before
// module evaluation — otherwise a real ~/.codex leaks into these counts.
vi.hoisted(() => {
  process.env['CODEX_HOME'] = `${process.env['TMPDIR'] || '/tmp'}/codeburn-underread-codex-${process.pid}-${Date.now()}`
})

function daysAgoStr(n: number): string {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function slice(cost: number, calls: number, extra: Partial<ProviderDaySlice> = {}): ProviderDaySlice {
  return { cost, calls, savingsUSD: 0, ...extra }
}

function dayEntry(date: string, providers: Record<string, ProviderDaySlice>, extra: Partial<DailyEntry> = {}): DailyEntry {
  return {
    date,
    cost: Object.values(providers).reduce((s, p) => s + p.cost, 0),
    savingsUSD: 0,
    calls: Object.values(providers).reduce((s, p) => s + p.calls, 0),
    sessions: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    editTurns: 0,
    oneShotTurns: 0,
    models: {},
    categories: {},
    providers,
    ...extra,
  }
}

/// Four priced assistant turns on a past date — the day the cache under-read.
async function seedHistoricalSession(date: string): Promise<void> {
  const projectDir = join(ROOT, 'home', '.claude', 'projects', 'p')
  await mkdir(projectDir, { recursive: true })
  const at = (hour: number): string => new Date(`${date}T0${hour}:30:00`).toISOString()
  const line = (id: string, hour: number): string => JSON.stringify({
    type: 'assistant',
    timestamp: at(hour),
    sessionId: 's-past',
    message: {
      type: 'message', role: 'assistant', model: 'claude-3-5-sonnet-20241022', id,
      content: [],
      usage: { input_tokens: 90000, output_tokens: 12000, cache_creation_input_tokens: 0, cache_read_input_tokens: 300000 },
    },
  })
  await writeFile(
    join(projectDir, 's-past.jsonl'),
    [line('m1', 1), line('m2', 2), line('m3', 3), line('m4', 4)].join('\n') + '\n',
    'utf-8',
  )
}

async function seedCache(days: DailyEntry[]): Promise<void> {
  const cache: DailyCache = {
    version: DAILY_CACHE_VERSION,
    savingsConfigHash: getDailyCacheConfigHash(),
    tzKey: currentTzKey(),
    lastComputedDate: daysAgoStr(1),
    days,
    complete: true,
    watermarkTrusted: true,
  }
  await writeFile(join(ROOT, 'cache', `daily-cache.v${DAILY_CACHE_VERSION}.json`), JSON.stringify(cache), 'utf-8')
}

async function liveOnly(range: DateRange): Promise<{ cost: number; calls: number }> {
  clearSessionCache()
  const projects = filterProjectsByName(await parseAllSessions(range, 'all'), [], [])
  const data = buildPeriodData('live', projects)
  return { cost: data.cost, calls: data.calls }
}

function weekRange(): DateRange {
  const now = new Date()
  return {
    start: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7),
    end: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999),
  }
}

beforeAll(async () => {
  await loadPricing()
})

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
  await mkdir(join(ROOT, 'home', '.claude'), { recursive: true })
  await mkdir(join(ROOT, 'cache'), { recursive: true })
  await mkdir(join(ROOT, 'no-desktop-sessions'), { recursive: true })
  await mkdir(join(ROOT, 'no-kimi-home'), { recursive: true })
  process.env['HOME'] = join(ROOT, 'home')
  process.env['USERPROFILE'] = join(ROOT, 'home')
  process.env['CODEBURN_CACHE_DIR'] = join(ROOT, 'cache')
  process.env['CLAUDE_CONFIG_DIR'] = join(ROOT, 'home', '.claude')
  delete process.env['CLAUDE_CONFIG_DIRS']
  process.env['KIMI_CODE_HOME'] = join(ROOT, 'no-kimi-home')
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(ROOT, 'no-desktop-sessions')
  clearSessionCache()
})

afterEach(async () => {
  clearSessionCache()
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  if (existsSync(ROOT)) await rm(ROOT, { recursive: true, force: true })
})

describe('a frozen under-read no longer suppresses the sources on disk', () => {
  const past = daysAgoStr(3)

  it('reports the live day when the cached row explains less of it', async () => {
    await seedHistoricalSession(past)
    const live = await liveOnly(weekRange())
    expect(live.calls).toBe(4) // the fixture, proving the parse sees the whole day

    // What the bad derivation froze: one of the day's four calls.
    await seedCache([dayEntry(past, { claude: slice(live.cost / 4, 1) })])

    clearSessionCache()
    const durable = await buildDurablePeriod({ range: weekRange(), label: 'p' })

    expect(durable.data.calls).toBe(live.calls)
    expect(durable.data.cost).toBeCloseTo(live.cost, 6)
  })

  it('drops the "preserved from expired logs" mark from a day the sources fully explain', async () => {
    await seedHistoricalSession(past)
    const live = await liveOnly(weekRange())
    await seedCache([dayEntry(past, { claude: slice(live.cost / 4, 1) }, { carried: true })])

    clearSessionCache()
    const durable = await buildDurablePeriod({ range: weekRange(), label: 'p' })

    // The footnote claimed this day's money was preserved from expired logs
    // while its transcript sat on disk the whole time.
    expect(durable.carriedCostUSD).toBe(0)
  })

  it('still carries a day whose sources really are gone', async () => {
    await seedHistoricalSession(past)
    const live = await liveOnly(weekRange())
    const expired = daysAgoStr(5)
    await seedCache([
      dayEntry(past, { claude: slice(live.cost / 4, 1) }),
      dayEntry(expired, { claude: slice(100, 40) }, { carried: true }),
    ])

    clearSessionCache()
    const durable = await buildDurablePeriod({ range: weekRange(), label: 'p' })

    // Nothing live can outbid a day with no surviving source, so the carried
    // day is untouched — and the healed day is added on top of it.
    expect(durable.data.calls).toBe(live.calls + 40)
    expect(durable.data.cost).toBeCloseTo(live.cost + 100, 6)
    expect(durable.carriedCostUSD).toBe(100)
  })

  it('keeps a richer cached slice when the live parse only partly explains the day', async () => {
    await seedHistoricalSession(past)
    const live = await liveOnly(weekRange())
    // The cache holds MORE than the sources can still produce: a genuine
    // partial expiry, which must not be dragged down to the live figure.
    await seedCache([dayEntry(past, { claude: slice(live.cost * 3, 40) })])

    clearSessionCache()
    const durable = await buildDurablePeriod({ range: weekRange(), label: 'p' })

    expect(durable.data.calls).toBe(40)
    expect(durable.data.cost).toBeCloseTo(live.cost * 3, 6)
  })
})

describe("mergeDayEntries 'prefer-richer' guard mode", () => {
  const recent = daysAgoStr(2)

  it('keeps the richer slice on a recent day, where the write path takes the fresh one', () => {
    const fresh = [dayEntry(recent, { claude: slice(20, 4) })]
    const cached = [dayEntry(recent, { claude: slice(90, 40) })]

    // Write path: a still-settling day is defined by its fresh derivation.
    const written = mergeDayEntries(fresh, cached, true, undefined, true)[0]!
    expect(written.providers['claude']).toMatchObject({ cost: 20, calls: 4 })

    // Read path: reporting a thinner derivation is never the better answer.
    const read = mergeDayEntries(fresh, cached, true, undefined, 'prefer-richer')[0]!
    expect(read.providers['claude']).toMatchObject({ cost: 90, calls: 40 })
    expect(read.cost).toBe(90)
    expect(read.calls).toBe(40)
  })

  it('leaves the durable value alone on equal calls — re-pricing lands in the write path', () => {
    // The same Grok re-pricing the write path applies (a cheaper cached slice,
    // same call count) must NOT be re-applied while reporting: the read union
    // corrects under-reads only, and the cached row stays authoritative for
    // everything else. `dashboard-period-truth` pins the same expectation.
    const fresh = [dayEntry(recent, { grok: slice(11.89, 21) })]
    const cached = [dayEntry(recent, { grok: slice(3.29, 21) })]
    const read = mergeDayEntries(fresh, cached, true, undefined, 'prefer-richer')[0]!
    expect(read.providers['grok']).toMatchObject({ cost: 3.29, calls: 21 })

    // The write path is where the new price does land.
    const written = mergeDayEntries(fresh, cached, true, undefined, true)[0]!
    expect(written.providers['grok']).toMatchObject({ cost: 11.89, calls: 21 })
  })
})
