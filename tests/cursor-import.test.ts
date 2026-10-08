import { beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'fs/promises'
import { existsSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { homedir, tmpdir } from 'os'

import {
  CURSOR_CSV_HEADER,
  cursorImportPath,
  importCursorCsv,
  importCursorCsvText,
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

describe('importCursorCsvText as a sync', () => {
  const from = base
  const stored = async () => JSON.parse(await readFile(cursorImportPath(), 'utf-8')) as { ranges: unknown[]; events: Array<{ hash: string; cost: string; source?: string }> }

  it('dedupes synced rows against a manual import and tags only new rows', async () => {
    await importCursorCsv(csvPath)
    const extra = { date: iso(3, 8), model: 'auto', input: 7 }
    const s = await importCursorCsvText(csv([...ROWS, extra]), base + 30 * DAY, { from, to: base + 30 * DAY, source: 'sync' })
    expect(s).toMatchObject({ changed: true, added: 1, skipped: 5, total: 6 })
    const events = (await stored()).events
    expect(events.filter(e => e.source === 'sync')).toHaveLength(1)
    expect(events.filter(e => e.source === undefined)).toHaveLength(5)
  })

  it('a later sync replaces changed synced rows but never manually imported ones', async () => {
    const manual = await writeCsv([{ date: iso(1, 3), model: 'auto', input: 11 }], 'manual.csv')
    await importCursorCsv(manual)
    await importCursorCsvText(csv(ROWS.slice(0, 2)), base + 30 * DAY, { from, to: base + 30 * DAY, source: 'sync' })
    const repriced = { ...ROWS[1]!, cost: '$2.50' }
    const s = await importCursorCsvText(csv([ROWS[0]!, repriced]), base + 30 * DAY, { from, to: base + 30 * DAY, source: 'sync' })
    expect(s).toMatchObject({ changed: true, added: 1, skipped: 1, total: 3 })
    const events = (await stored()).events
    expect(events.map(e => e.cost).sort()).toEqual(['$2.50', 'Included', 'Included'])
    expect(events.filter(e => e.source === undefined)).toHaveLength(1)

    const again = await importCursorCsvText(csv([ROWS[0]!, repriced]), base + 30 * DAY, { from, to: base + 30 * DAY, source: 'sync' })
    expect(again).toMatchObject({ changed: false, added: 0 })
  })

  it('covers the window start to the newest event, apart from manual coverage', async () => {
    await importCursorCsv(csvPath)
    const s = await importCursorCsvText(csv([{ date: iso(1, 9), model: 'auto', input: 3 }, { date: iso(4, 15), model: 'auto', input: 4 }]), base + 30 * DAY, { from, to: base + 30 * DAY, source: 'sync' })
    expect(s!.coverage).toEqual({ start: new Date(from).toISOString(), end: iso(4, 15), inferred: false })
    expect((await stored()).ranges).toEqual([
      { start: `${dayOf(0)}T00:00:00.000Z`, end: `${dayOf(2)}T23:59:59.999Z` },
      { start: new Date(from).toISOString(), end: iso(4, 15), source: 'sync' },
    ])
    expect(await importCursorCsvText(csv([]), base + 30 * DAY, { from, to: base + 30 * DAY, source: 'sync' })).toBeNull()
  })

  it('drops synced rows from before the window instead of failing', async () => {
    const s = await importCursorCsvText(csv([{ date: iso(-1), model: 'auto', input: 1 }, { date: iso(0, 5), model: 'auto', input: 2 }]), base + DAY, { from, to: base + DAY, source: 'sync' })
    expect(s).toMatchObject({ added: 1, total: 1, firstEvent: iso(0, 5) })
    expect(await importCursorCsvText(csv([{ date: iso(-1), model: 'auto', input: 1 }]), base + DAY, { from, to: base + DAY, source: 'sync' })).toBeNull()
  })

  it('a manual import claims a row a sync stored first, so a later sync cannot delete it', async () => {
    const row = { date: iso(1, 3), model: 'auto', input: 11 }
    await importCursorCsvText(csv([row]), base + 30 * DAY, { from, to: base + 30 * DAY, source: 'sync', account: 'aaaa' })
    const manual = await importCursorCsv(await writeCsv([row], 'manual.csv'))
    expect(manual).toMatchObject({ changed: true, added: 0, skipped: 1, total: 1 })
    expect((await stored()).events).toEqual([expect.not.objectContaining({ source: 'sync' })])
    expect((await stored()).events[0]).not.toHaveProperty('account')

    // Cursor revised the row: manual coverage wins, so only the manual row is priced.
    await importCursorCsvText(csv([{ ...row, cost: '$0.10' }]), base + 30 * DAY, { from, to: base + 30 * DAY, source: 'sync', account: 'aaaa' })
    expect((await stored()).events.map(e => [e.cost, e.source])).toEqual([['Included', undefined]])
  })

  it('a synced row after the manual coverage end is still added', async () => {
    const saved = base + DAY + 6 * 3_600_000
    const manual = await importCursorCsv(await writeCsv([{ date: iso(1, 3), model: 'auto', input: 11 }], 'manual.csv', saved))
    expect(manual.coverage.end).toBe(new Date(saved).toISOString())
    const s = await importCursorCsvText(csv([{ date: iso(1, 5), model: 'auto', input: 1 }, { date: iso(1, 7), model: 'auto', input: 2 }, { date: iso(2, 1), model: 'auto', input: 3 }]), base + 30 * DAY, { from, to: base + 30 * DAY, source: 'sync', account: 'aaaa' })
    expect(s).toMatchObject({ added: 2, skipped: 1, total: 3 })
    expect((await stored()).events.map(e => [e.date, e.source])).toEqual([[iso(1, 3), undefined], [iso(1, 7), 'sync'], [iso(2, 1), 'sync']])
  })

  it('keeps every account\'s synced rows and coverage apart; a sync replaces only its own account\'s rows', async () => {
    const a = { date: iso(1, 9), model: 'auto', input: 3 }
    await importCursorCsvText(csv([a]), base + 30 * DAY, { from, to: base + 30 * DAY, source: 'sync', account: 'aaaa' })
    const b = { date: iso(4, 15), model: 'auto', input: 4 }
    const s = await importCursorCsvText(csv([b]), base + 30 * DAY, { from, to: base + 30 * DAY, source: 'sync', account: 'bbbb' })
    expect(s).toMatchObject({ changed: true, added: 1, total: 2 })
    const after = await stored() as { ranges: unknown[]; events: Array<{ source?: string; account?: string }> }
    expect(after.events.map(e => [e.source, e.account])).toEqual([['sync', 'aaaa'], ['sync', 'bbbb']])
    expect(after.ranges).toEqual([
      { start: new Date(from).toISOString(), end: iso(1, 9), source: 'sync', account: 'aaaa' },
      { start: new Date(from).toISOString(), end: iso(4, 15), source: 'sync', account: 'bbbb' },
    ])
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

  it('a synced export drops a CLI session it billed even when the transcript was written after its newest event', async () => {
    // A `cursor-agent -p` run: one tagged prompt before the export's newest
    // event, its transcript written after it.
    const prompt = new Date(Date.parse(iso(2, 21)))
    const tag = `${prompt.toLocaleString('en-US', { weekday: 'long', timeZone: 'UTC' })}, ${prompt.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })} (UTC)`
    const dir = join(homedir(), '.cursor', 'projects', 'proj', 'agent-transcripts', 'aaaaaaaa-0000-4000-8000-000000000001')
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl')
    const step = JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(400) }] } })
    await writeFile(path, [JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: `<timestamp>${tag}</timestamp>\n<user_query>redacted</user_query>` }] } }), step, step].join('\n') + '\n')
    const written = Date.parse(iso(2, 23))
    await utimes(path, written / 1000, written / 1000)
    expect((await parse(whole))['cursor-agent']!.calls).toBe(2)

    await importCursorCsvText(csv(ROWS), Date.now(), { from: base, source: 'sync', account: 'a' })
    const after = await parse(whole)
    expect(after['cursor-agent']).toBeUndefined()
    expect(after['cursor']!.calls).toBe(4)
  })

  it('marks plan rows estimated only where the export names no real model', async () => {
    await importCursorCsv(csvPath)
    clearSessionCache()
    const flags: Record<string, boolean> = {}
    for (const p of await parseAllSessions(whole, 'all')) for (const s of p.sessions) for (const t of s.turns) for (const c of t.assistantCalls) flags[c.model] = c.isEstimated === true
    expect(flags).toEqual({
      'cursor-auto': true,
      'claude-opus-5-thinking-high': false,
      'grok-4.6-high': false,
      'grok-bot-automation': true,
      'composer-2.5-fast': false,
    })
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

describe('Cursor import coverage in a non-UTC zone', () => {
  it.each(['America/Los_Angeles', 'Asia/Kolkata'])('%s: a local day is wholly imported and its neighbours keep their estimates', async (tz) => {
    process.env.TZ = tz
    const b = new Date(base)
    const at = (dayOffset: number, hour: number, minute = 0) =>
      new Date(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate() + dayOffset, hour, minute).getTime()
    const day = toDateString(new Date(at(0, 12)))

    await writeAgentTranscript('prev-evening', at(-1, 20))
    await writeAgentTranscript('same-day', at(0, 12))
    await writeAgentTranscript('next-night', at(1, 1))
    const path = await writeCsv([
      { date: new Date(at(0, 0, 30)).toISOString(), model: 'auto', input: 100 },
      { date: new Date(at(0, 23, 30)).toISOString(), model: 'auto', input: 200 },
    ], 'tz.csv')

    const s = await importCursorCsv(path)
    expect([toDateString(new Date(s.coverage.start)), toDateString(new Date(s.coverage.end))]).toEqual([day, day])

    clearSessionCache()
    const perDay: Record<string, Record<string, number>> = {}
    for (const p of await parseAllSessions(whole, 'all')) for (const ses of p.sessions) for (const t of ses.turns) for (const c of t.assistantCalls) {
      const d = perDay[toDateString(new Date(c.timestamp))] ??= {}
      d[c.provider] = (d[c.provider] ?? 0) + 1
    }
    expect(perDay).toEqual({
      [toDateString(new Date(at(-1, 20)))]: { 'cursor-agent': 1 },
      [day]: { cursor: 2 },
      [toDateString(new Date(at(1, 1)))]: { 'cursor-agent': 1 },
    })

    // The same day passed as --from/--to is the span inferred above.
    const explicit = await importCursorCsv(path, { from: parseBoundary(day, 'from'), to: parseBoundary(day, 'to') })
    expect(explicit).toMatchObject({ changed: false, coverage: { start: new Date(at(0, 0)).toISOString(), end: new Date(at(1, 0) - 1).toISOString() } })
  })
})

describe('invalidateProviderDays', () => {
  const day = (date: string): DailyEntry => ({
    date, cost: 3, savingsUSD: 0, calls: 3, sessions: 2, inputTokens: 30, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    editTurns: 0, oneShotTurns: 0, models: {}, categories: {},
    providers: {
      cursor: { calls: 1, cost: 1, savingsUSD: 0, sessions: 1, inputTokens: 10 },
      claude: { calls: 2, cost: 2, savingsUSD: 0, sessions: 1, inputTokens: 20 },
    },
  })

  it('drops only the named providers on the named days and pulls the watermark back', async () => {
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

  it('reaches days held only by an older daily-cache file', async () => {
    const dir = process.env['CODEBURN_CACHE_DIR']!
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'daily-cache.v60.json'), JSON.stringify({ ...emptyCache(), version: 60, complete: true, lastComputedDate: dayOf(5), days: [day(dayOf(2))] }))
    await invalidateProviderDays(['cursor'], dayOf(1), dayOf(3))
    const c = await loadDailyCache()
    expect(c.days.map(d => [d.date, Object.keys(d.providers)])).toEqual([[dayOf(2), ['claude']]])
  })
})
