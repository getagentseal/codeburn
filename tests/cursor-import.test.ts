import { beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'fs/promises'
import { existsSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { homedir, tmpdir } from 'os'

import {
  CURSOR_CSV_HEADER,
  cursorImportPath,
  importCursorCsv,
  parseBoundary,
  parseCursorUsageCsv,
  removeCursorImport,
  replacedProviders,
} from '../src/cursor-import.js'
import { ensureCacheHydrated, invalidateProviderDays, loadDailyCache, saveDailyCache, emptyCache, toDateString, type DailyEntry } from '../src/daily-cache.js'
import { aggregateProjectsIntoDays } from '../src/day-aggregator.js'
import { calculateCost, loadPricing } from '../src/models.js'
import { clearSessionCache, parseAllSessions } from '../src/parser.js'
import type { DateRange, ProjectSummary } from '../src/types.js'

const DAY = 86_400_000
// Relative to now so every fixture day sits inside the daily cache's backfill
// window and before yesterday, where days are sealed.
const base = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) - 20 * DAY
const iso = (offsetDays: number, hour = 12) => new Date(base + offsetDays * DAY + hour * 3_600_000).toISOString()
const dayOf = (offsetDays: number) => iso(offsetDays).slice(0, 10)

type Row = { date: string; model: string; cw?: number; input?: number; cr?: number; out?: number; cost?: string; kind?: string }

function csv(rows: Row[]): string {
  const q = (v: string | number) => `"${v}"`
  return [
    CURSOR_CSV_HEADER.join(','),
    ...rows.map(r => {
      const t = [r.cw ?? 0, r.input ?? 0, r.cr ?? 0, r.out ?? 0]
      return [r.date, '', '', r.kind ?? 'Included', r.model, 'No', ...t, t.reduce((a, b) => a + b, 0), r.cost ?? 'Included'].map(q).join(',')
    }),
  ].join('\n') + '\n'
}

const ROWS: Row[] = [
  { date: iso(0, 1), model: 'auto', cw: 10, input: 100, cr: 5000, out: 50 },
  { date: iso(0, 13), model: 'claude-opus-5-thinking-high', input: 200, cr: 8000, out: 90, cost: '$1.25', kind: 'On-Demand' },
  { date: iso(1, 9), model: 'cursor-grok-4.6-high', input: 300, cr: 1000, out: 20 },
  { date: iso(1, 10), model: 'grok-bot-automation', input: 40, cr: 70000, out: 7 },
  { date: iso(2, 22), model: 'composer-2.5-fast', cost: 'Free' },
]

const HOME = mkdtempSync(join(tmpdir(), 'cursor-import-home-'))
let root: string
let csvPath: string

async function writeCsv(rows: Row[], name = 'usage.csv', savedAt = base + 30 * DAY): Promise<string> {
  const path = join(root, name)
  await writeFile(path, csv(rows))
  await utimes(path, savedAt / 1000, savedAt / 1000)
  return path
}

// Cursor Agent transcripts carry no timestamps without their summary db, so
// each one is stamped with its file mtime.
async function writeAgentTranscript(id: string, mtimeMs: number): Promise<void> {
  const dir = join(homedir(), '.cursor', 'projects', 'proj', 'agent-transcripts')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${id}.txt`)
  await writeFile(path, `user:\n<user_query>question ${id}</user_query>\nA:\nanswer ${'x'.repeat(400)}\n`)
  await utimes(path, mtimeMs / 1000, mtimeMs / 1000)
}

type Totals = { calls: number; tokens: number; cost: number }

function byProvider(projects: ProjectSummary[]): Record<string, Totals> {
  const out: Record<string, Totals> = {}
  for (const p of projects) for (const s of p.sessions) for (const t of s.turns) for (const c of t.assistantCalls) {
    const acc = out[c.provider] ??= { calls: 0, tokens: 0, cost: 0 }
    acc.calls++
    acc.tokens += c.usage.inputTokens + c.usage.outputTokens + c.usage.cacheReadInputTokens + c.usage.cacheCreationInputTokens
    acc.cost += c.costUSD
  }
  return out
}

async function parse(range: DateRange): Promise<Record<string, Totals>> {
  clearSessionCache()
  return byProvider(await parseAllSessions(range, 'all'))
}

const whole: DateRange = { start: new Date(base - 10 * DAY), end: new Date(base + 10 * DAY) }

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cursor-import-test-'))
  process.env['CODEBURN_CACHE_DIR'] = join(root, 'cache')
  // The Cursor Agent provider resolves its home once, when it first loads,
  // so every test shares one home and starts from an empty one.
  // os.homedir() reads USERPROFILE on Windows and HOME elsewhere.
  process.env['HOME'] = HOME
  process.env['USERPROFILE'] = HOME
  await rm(HOME, { recursive: true, force: true })
  await loadPricing()
  csvPath = await writeCsv(ROWS)
})

describe('parseCursorUsageCsv', () => {
  it('rejects a file that is not a Cursor usage export', () => {
    expect(() => parseCursorUsageCsv('Date,Model,Cost\n"2026-01-01T00:00:00Z","auto","1"\n')).toThrow(/not a Cursor usage export/)
  })

  it('rejects a row whose Total Tokens disagrees with its parts', () => {
    const bad = csv(ROWS.slice(0, 1)).replace('"5160","Included"', '"5161","Included"')
    expect(() => parseCursorUsageCsv(bad)).toThrow(/Total Tokens/)
  })

  it('reads empty token cells as zero', () => {
    const [free] = parseCursorUsageCsv(`${CURSOR_CSV_HEADER.join(',')}\n"${iso(0)}","","","Included","auto","No","","","","","","Free"\n`)
    expect(free).toMatchObject({ input: 0, output: 0, cacheRead: 0, inputCacheWrite: 0, cost: 'Free' })
  })

  it('reads the export URL boundaries as epoch milliseconds', () => {
    expect(new Date(parseBoundary('1787788800000', 'from')).toISOString()).toBe('2026-08-27T00:00:00.000Z')
    expect(new Date(parseBoundary('2026-09-25', 'to')).toISOString()).toBe('2026-09-25T23:59:59.999Z')
  })
})

describe('importCursorCsv', () => {
  it('re-importing an overlapping export never double counts', async () => {
    const first = await importCursorCsv(csvPath)
    expect(first).toMatchObject({ added: 5, skipped: 0, total: 5 })
    const savedAt = (await stat(cursorImportPath())).mtimeMs
    const again = await importCursorCsv(csvPath)
    expect(again).toMatchObject({ changed: false, added: 0, skipped: 5, total: 5 })
    expect((await stat(cursorImportPath())).mtimeMs).toBe(savedAt)
    const overlap = await writeCsv([...ROWS.slice(3), { date: iso(3, 8), model: 'auto', input: 7 }], 'later.csv')
    expect(await importCursorCsv(overlap)).toMatchObject({ added: 1, skipped: 2, total: 6 })
    const stored = JSON.parse(await readFile(cursorImportPath(), 'utf-8'))
    expect(stored.ranges).toEqual([{ start: `${dayOf(0)}T00:00:00.000Z`, end: `${dayOf(3)}T23:59:59.999Z` }])
  })

  it('takes an explicit range and refuses events outside it', async () => {
    const s = await importCursorCsv(csvPath, { from: base - 3 * DAY, to: base + 5 * DAY - 1 })
    expect(s.coverage).toMatchObject({ start: new Date(base - 3 * DAY).toISOString(), inferred: false })
    await expect(importCursorCsv(csvPath, { from: base + DAY })).rejects.toThrow(/outside/)
  })

  it('ends coverage when the file was saved, not at the end of its last day', async () => {
    const saved = base + 2 * DAY + 23 * 3_600_000
    const s = await importCursorCsv(await writeCsv(ROWS, 'fresh.csv', saved), { to: base + 3 * DAY - 1 })
    expect(s.coverage.end).toBe(new Date(saved).toISOString())
  })
})

describe('Cursor import through the report pipeline', () => {
  it('replaces local estimates inside coverage only, and removal restores them', async () => {
    await writeAgentTranscript('inside', base + DAY + 5 * 3_600_000)
    await writeAgentTranscript('outside', base - 5 * DAY)
    const before = await parse(whole)
    expect(before['cursor-agent']!.calls).toBe(2)

    await importCursorCsv(csvPath)
    const after = await parse(whole)
    const outsideOnly = await parse({ start: whole.start, end: new Date(base - 1) })
    expect(after['cursor-agent']).toEqual(outsideOnly['cursor-agent'])
    expect(after['cursor-agent']!.calls).toBe(1)

    // Every imported event is served exactly once: IDE work under Cursor,
    // Grok Bot cloud work under Grok Bot.
    expect(after['cursor']).toMatchObject({ calls: 4, tokens: 5160 + 8290 + 1320 + 0 })
    expect(after['grokbot']).toMatchObject({ calls: 1, tokens: 70047 })
    const opus = calculateCost('cursor-auto', 100, 50, 10, 5000, 0)
      + 1.25
      + calculateCost('grok-4.6-high', 300, 20, 0, 1000, 0)
    expect(after['cursor']!.cost).toBeCloseTo(opus, 10)

    // Additive and monotonic across the coverage boundary.
    const inside = await parse({ start: new Date(base), end: whole.end })
    for (const p of ['cursor', 'cursor-agent', 'grokbot']) {
      const sum = (inside[p]?.tokens ?? 0) + (outsideOnly[p]?.tokens ?? 0)
      expect(after[p]?.tokens ?? 0).toBe(sum)
    }

    await removeCursorImport()
    expect(existsSync(cursorImportPath())).toBe(false)
    expect(await parse(whole)).toEqual(before)
  })

  it('the daily cache re-derives the covered days after an import and after removal', async () => {
    await writeAgentTranscript('inside', base + DAY + 5 * 3_600_000)
    await writeAgentTranscript('outside', base - 5 * DAY)
    const hydrate = () => {
      clearSessionCache()
      return ensureCacheHydrated((range) => parseAllSessions(range, 'all'), aggregateProjectsIntoDays)
    }
    const slice = (days: DailyEntry[], date: string, provider: string) => days.find(d => d.date === date)?.providers[provider]

    const sealed = await hydrate()
    const coveredDay = toDateString(new Date(base + DAY + 5 * 3_600_000))
    expect(slice(sealed.days, coveredDay, 'cursor-agent')?.calls).toBe(1)

    const s = await importCursorCsv(csvPath)
    await invalidateProviderDays(replacedProviders(), toDateString(new Date(s.coverage.start)), toDateString(new Date(s.coverage.end)))
    const imported = await hydrate()
    expect(slice(imported.days, coveredDay, 'cursor-agent')).toBeUndefined()
    expect(slice(imported.days, coveredDay, 'grokbot')?.calls).toBe(1)
    const cursorCalls = imported.days.reduce((n, d) => n + (d.providers['cursor']?.calls ?? 0), 0)
    expect(cursorCalls).toBe(4)
    expect(slice(imported.days, toDateString(new Date(base - 5 * DAY)), 'cursor-agent')?.calls).toBe(1)

    const ranges = (await removeCursorImport())!
    for (const r of ranges) await invalidateProviderDays(replacedProviders(), toDateString(new Date(r.start)), toDateString(new Date(r.end)))
    const restored = await hydrate()
    expect(restored.days).toEqual(sealed.days)
  })
})

describe('invalidateProviderDays', () => {
  it('drops only the named providers on the named days and pulls the watermark back', async () => {
    const day = (date: string): DailyEntry => ({
      date, cost: 3, savingsUSD: 0, calls: 3, sessions: 2, inputTokens: 30, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      editTurns: 0, oneShotTurns: 0, models: {}, categories: {},
      providers: {
        cursor: { calls: 1, cost: 1, savingsUSD: 0, sessions: 1, inputTokens: 10 },
        claude: { calls: 2, cost: 2, savingsUSD: 0, sessions: 1, inputTokens: 20 },
      },
    })
    await saveDailyCache({ ...emptyCache(), complete: true, lastComputedDate: dayOf(5), days: [day(dayOf(0)), day(dayOf(2)), day(dayOf(4))] })
    await invalidateProviderDays(['cursor'], dayOf(1), dayOf(3))
    const c = await loadDailyCache()
    expect(c.lastComputedDate).toBe(dayOf(0))
    expect(c.days.map(d => [d.date, Object.keys(d.providers), d.cost])).toEqual([
      [dayOf(0), ['cursor', 'claude'], 3],
      [dayOf(2), ['claude'], 2],
      [dayOf(4), ['cursor', 'claude'], 3],
    ])
  })
})
