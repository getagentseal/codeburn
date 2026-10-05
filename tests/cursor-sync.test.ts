import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync } from 'fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { CURSOR_CSV_HEADER, cursorImportPath, importCursorCsv } from '../src/cursor-import.js'
import { cursorSyncStatePath, maybeSyncCursor } from '../src/cursor-sync.js'
import { isSupersededCacheFile } from '../src/cache-sweep.js'
import { ensureCacheHydrated, toDateString, type DailyEntry } from '../src/daily-cache.js'
import { aggregateProjectsIntoDays } from '../src/day-aggregator.js'
import { collectDoctorReport } from '../src/doctor.js'
import { clearSessionCache, parseAllSessions } from '../src/parser.js'
import { createServer } from '../src/mcp/server.js'
import { cursorDatabasePath } from '../src/quota/cursor.js'
import { isSqliteAvailable } from '../src/sqlite.js'

const requireForTest = createRequire(import.meta.url)
const MIN = 60_000
const HOUR = 60 * MIN
const NOW = Date.parse('2026-09-20T12:00:00Z')
const HOME = mkdtempSync(join(tmpdir(), 'cursor-sync-home-'))
const SUB = 'auth0|user_sync_test'

function jwt(sub = SUB, expiresAt = NOW + 24 * HOUR): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  return `${encode({ alg: 'HS256' })}.${encode({ sub, exp: Math.floor(expiresAt / 1000) })}.signature`
}

function writeToken(token: string): void {
  const path = cursorDatabasePath()
  mkdirSync(dirname(path), { recursive: true })
  const { DatabaseSync } = requireForTest('node:sqlite') as { DatabaseSync: new (file: string) => any }
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)')
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('cursorAuth/accessToken', token)
  db.close()
}

type Row = { date: string; input: number; cost?: string }
function csv(rows: Row[]): string {
  return [CURSOR_CSV_HEADER.join(','), ...rows.map(r =>
    [r.date, '', '', 'Included', 'auto', 'No', 0, r.input, 0, 0, r.input, r.cost ?? 'Included'].map(v => `"${v}"`).join(','))].join('\n') + '\n'
}

const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString()
const ROWS: Row[] = [{ date: at(50), input: 10 }, { date: at(30), input: 20 }, { date: at(2), input: 30 }]

type Reply = { status?: number; body?: string; headers?: Record<string, string> }
function fakeFetch(reply: Reply = { body: csv(ROWS) }) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(reply.body ?? '', { status: reply.status ?? 200, headers: reply.headers }))
}
const firstStartAt = (ms: number) => { const n = new Date(ms); return Math.min(new Date(n.getFullYear(), n.getMonth(), 1).getTime(), new Date(n.getFullYear(), n.getMonth(), n.getDate() - 30).getTime()) }
const firstStart = firstStartAt(NOW)
const urlOf = (f: ReturnType<typeof fakeFetch>, i = 0) => new URL(String(f.mock.calls[i]![0]))
const state = async () => JSON.parse(await readFile(cursorSyncStatePath(), 'utf-8'))
const stored = async () => JSON.parse(await readFile(cursorImportPath(), 'utf-8')) as { ranges: Array<{ source?: string; end: string; account?: string }>; events: Array<{ input: number; source?: string; account?: string }> }

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cursor-sync-test-'))
  process.env['CODEBURN_CACHE_DIR'] = join(root, 'cache')
  process.env['HOME'] = HOME
  process.env['USERPROFILE'] = HOME
  delete process.env['CODEBURN_CURSOR_SYNC']
  await rm(HOME, { recursive: true, force: true })
  writeToken(jwt())
})

afterEach(() => vi.restoreAllMocks())

const dayStart = (ms: number) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() }
const dayBefore = (ms: number) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1).getTime() }

describe.skipIf(!isSqliteAvailable())('maybeSyncCursor', () => {
  it('syncs the first month once, then only from the day before the newest synced event, at most hourly', async () => {
    const timeouts = vi.spyOn(AbortSignal, 'timeout')
    const f = fakeFetch()
    const s = await maybeSyncCursor({ now: NOW, fetchImpl: f })
    expect(s).toMatchObject({ changed: true, added: 3 })
    expect(urlOf(f).origin + urlOf(f).pathname).toBe('https://cursor.com/api/dashboard/export-usage-events-csv')
    expect(Object.fromEntries(urlOf(f).searchParams)).toEqual({ startDate: String(firstStart), endDate: String(NOW), strategy: 'tokens' })
    const headers = f.mock.calls[0]![1]!.headers as Record<string, string>
    expect(headers['Cookie']).toBe(`WorkosCursorSessionToken=user_sync_test%3A%3A${jwt()}`)
    expect(headers['Origin']).toBe('https://cursor.com')

    // Coverage ends at the newest event, so later local usage keeps its estimate.
    const account = (await state()).account
    expect((await stored()).ranges).toEqual([{ start: new Date(firstStart).toISOString(), end: at(2), source: 'sync', account }])
    const saved = await state()
    expect(saved).toMatchObject({ lastAttemptAt: NOW, lastSuccessAt: NOW, account: expect.stringMatching(/^[0-9a-f]{16}$/) })
    expect(saved.nextAttemptAt).toBeGreaterThanOrEqual(NOW + HOUR)
    expect(saved.nextAttemptAt).toBeLessThan(NOW + HOUR + 5 * MIN)
    expect(JSON.stringify(saved)).not.toContain('user_sync_test')

    const g = fakeFetch({ body: csv([...ROWS.filter(r => Date.parse(r.date) >= dayBefore(Date.parse(at(2)))), { date: at(-1), input: 40 }]) })
    expect(await maybeSyncCursor({ now: NOW + 59 * MIN, fetchImpl: g })).toBeNull()
    expect(g).not.toHaveBeenCalled()
    await maybeSyncCursor({ now: NOW + 2 * HOUR, fetchImpl: g })
    expect(urlOf(g).searchParams.get('startDate')).toBe(String(dayBefore(Date.parse(at(2)))))
    expect((await stored()).events).toHaveLength(4)
    // The month-long first backfill gets 45s, an incremental sync 15s.
    expect(timeouts.mock.calls.map(c => c[0])).toEqual([45_000, 15_000])

    const h = fakeFetch({ body: csv([]) })
    await maybeSyncCursor({ now: NOW + 4 * HOUR, fetchImpl: h })
    expect(urlOf(h).searchParams.get('startDate')).toBe(String(dayBefore(Date.parse(at(-1)))))
  })

  it('a quiet account is not downloaded from scratch again; a missing store is', async () => {
    const f = fakeFetch({ body: csv([]) })
    expect(await maybeSyncCursor({ now: NOW, fetchImpl: f })).toBeNull()
    expect(existsSync(cursorImportPath())).toBe(true)
    await maybeSyncCursor({ now: NOW + 2 * HOUR, fetchImpl: f })
    expect(urlOf(f, 1).searchParams.get('startDate')).toBe(String(dayBefore(dayStart(NOW))))
    await rm(cursorImportPath())
    await maybeSyncCursor({ now: NOW + 4 * HOUR, fetchImpl: f })
    expect(urlOf(f, 2).searchParams.get('startDate')).toBe(String(firstStartAt(NOW + 4 * HOUR)))
  })

  it('401 backs off for 6 hours unless the token changes', async () => {
    await maybeSyncCursor({ now: NOW, fetchImpl: fakeFetch({ status: 401 }) })
    expect(await state()).toMatchObject({ backoffUntil: NOW + 6 * HOUR, lastError: expect.stringContaining('401') })
    const f = fakeFetch()
    await maybeSyncCursor({ now: NOW + 2 * HOUR, fetchImpl: f })
    expect(f).not.toHaveBeenCalled()
    writeToken(jwt(SUB, NOW + 48 * HOUR))
    await maybeSyncCursor({ now: NOW + 2 * HOUR, fetchImpl: f })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('429 honours Retry-After', async () => {
    await maybeSyncCursor({ now: NOW, fetchImpl: fakeFetch({ status: 429, headers: { 'Retry-After': String(3 * 3600) } }) })
    expect((await state()).backoffUntil).toBe(NOW + 3 * HOUR)
    const f = fakeFetch()
    await maybeSyncCursor({ now: NOW + 2 * HOUR, fetchImpl: f })
    expect(f).not.toHaveBeenCalled()
    await maybeSyncCursor({ now: NOW + 3 * HOUR + MIN, fetchImpl: f })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('a 5xx, a network error or a foreign body keeps the stored usage; three in a row back off 6 hours', async () => {
    await maybeSyncCursor({ now: NOW, fetchImpl: fakeFetch() })
    const before = await readFile(cursorImportPath(), 'utf-8')
    const mtime = (await stat(cursorImportPath())).mtimeMs
    let t = NOW
    for (const f of [
      fakeFetch({ status: 503 }),
      vi.fn(async () => { throw new TypeError('fetch failed') }),
      fakeFetch({ body: '{"email":"someone@example.com"}\n' }),
    ]) {
      t += 2 * HOUR
      expect(await maybeSyncCursor({ now: t, fetchImpl: f as unknown as typeof fetch })).toBeNull()
      expect(f).toHaveBeenCalledTimes(1)
      expect((await state()).lastError).toBeTruthy()
    }
    expect(await state()).toMatchObject({ failures: 3, backoffUntil: t + 6 * HOUR, lastError: expect.stringMatching(/not a Cursor usage export/) })
    expect(JSON.stringify(await state())).not.toContain('example.com')
    expect(await readFile(cursorImportPath(), 'utf-8')).toBe(before)
    expect((await stat(cursorImportPath())).mtimeMs).toBe(mtime)

    const f = fakeFetch({ body: csv([ROWS[2]!]) })
    await maybeSyncCursor({ now: t + 2 * HOUR, fetchImpl: f })
    expect(f).not.toHaveBeenCalled()
    await maybeSyncCursor({ now: t + 6 * HOUR, fetchImpl: f })
    expect(f).toHaveBeenCalledTimes(1)
    const reset = await state()
    expect(reset.failures).toBeUndefined()
    expect(reset.backoffUntil).toBeUndefined()
  })

  it('makes no request for a token about to expire, or without one', async () => {
    writeToken(jwt(SUB, NOW + 30_000))
    const f = fakeFetch()
    expect(await maybeSyncCursor({ now: NOW, fetchImpl: f })).toBeNull()
    await expect(maybeSyncCursor({ now: NOW, fetchImpl: f, force: true })).rejects.toThrow(/expired/)
    await rm(cursorDatabasePath())
    expect(await maybeSyncCursor({ now: NOW, fetchImpl: f })).toBeNull()
    expect(f).not.toHaveBeenCalled()
    expect(existsSync(cursorSyncStatePath())).toBe(false)
  })

  it('an account change keeps the earlier account\'s synced usage and starts after its coverage', async () => {
    const manual = join(root, 'manual.csv')
    await writeFile(manual, csv([{ date: at(100), input: 1 }]))
    await importCursorCsv(manual)
    await maybeSyncCursor({ now: NOW, fetchImpl: fakeFetch() })
    const first = (await state()).account
    writeToken(jwt('auth0|someone_else'))
    const f = fakeFetch({ body: csv([{ date: at(1), input: 99 }]) })
    await maybeSyncCursor({ now: NOW + 2 * HOUR, fetchImpl: f })
    expect(urlOf(f).searchParams.get('startDate')).toBe(String(Date.parse(at(2)) + 1))
    const second = (await state()).account
    expect(second).not.toBe(first)
    const s = await stored()
    expect(s.events.map(e => [e.input, e.source, e.account])).toEqual([
      [1, undefined, undefined], [10, 'sync', first], [20, 'sync', first], [30, 'sync', first], [99, 'sync', second],
    ])
    expect(s.ranges.filter(r => r.source === 'sync')).toEqual([
      { start: new Date(firstStart).toISOString(), end: at(2), source: 'sync', account: first },
      { start: new Date(Date.parse(at(2)) + 1).toISOString(), end: at(1), source: 'sync', account: second },
    ])
  })

  it('skips when the provider filter leaves out every Cursor provider', async () => {
    const f = fakeFetch()
    expect(await maybeSyncCursor({ now: NOW, fetchImpl: f, provider: 'claude' })).toBeNull()
    expect(f).not.toHaveBeenCalled()
    expect(await maybeSyncCursor({ now: NOW, fetchImpl: f, provider: 'grokbot' })).toMatchObject({ added: 3 })
  })

  it('the off switch (env or config) stops automatic syncs, not a forced one', async () => {
    const f = fakeFetch()
    process.env['CODEBURN_CURSOR_SYNC'] = '0'
    expect(await maybeSyncCursor({ now: NOW, fetchImpl: f })).toBeNull()
    delete process.env['CODEBURN_CURSOR_SYNC']
    await mkdir(join(HOME, '.config', 'codeburn'), { recursive: true })
    await writeFile(join(HOME, '.config', 'codeburn', 'config.json'), JSON.stringify({ cursorSync: false }))
    expect(await maybeSyncCursor({ now: NOW, fetchImpl: f })).toBeNull()
    expect(f).not.toHaveBeenCalled()
    expect(await maybeSyncCursor({ now: NOW, fetchImpl: f, force: true })).toMatchObject({ added: 3 })
  })
})

describe.skipIf(!isSqliteAvailable())('synced history is kept', () => {
  it('the cache sweep never matches the import store or the sync state', () => {
    for (const name of ['cursor-usage.v0.json', 'cursor-usage.v1.json', 'cursor-sync.v0.json', 'cursor-sync.v1.json']) {
      expect(isSupersededCacheFile(name)).toBe(false)
    }
  })

  it('a closed synced day stays in the daily cache through a failed sync and a missing store', async () => {
    const now = Date.now()
    writeToken(jwt(SUB, now + 24 * HOUR))
    const closed = new Date(now - 3 * 24 * HOUR)
    const rows = [{ date: closed.toISOString(), input: 500, cost: '$1.25' }, { date: new Date(closed.getTime() + MIN).toISOString(), input: 700, cost: '$0.75' }]
    const hydrate = () => {
      clearSessionCache()
      return ensureCacheHydrated((range) => parseAllSessions(range, 'all'), aggregateProjectsIntoDays)
    }
    const slice = (days: DailyEntry[]) => days.find(d => d.date === toDateString(closed))?.providers['cursor']

    expect(await maybeSyncCursor({ now, fetchImpl: fakeFetch({ body: csv(rows) }) })).toMatchObject({ added: 2 })
    const synced = slice((await hydrate()).days)
    expect(synced).toMatchObject({ calls: 2, cost: 2 })

    const offline = vi.fn(async () => { throw new TypeError('fetch failed') })
    expect(await maybeSyncCursor({ now: now + 2 * HOUR, fetchImpl: offline as unknown as typeof fetch })).toBeNull()
    expect(offline).toHaveBeenCalledTimes(1)
    expect(slice((await hydrate()).days)).toEqual(synced)

    await rm(cursorImportPath())
    expect(slice((await hydrate()).days)).toEqual(synced)
  })
})

describe.skipIf(!isSqliteAvailable())('offline commands', () => {
  it('mcp and doctor never reach cursor.com, while a sync with the same session does', async () => {
    writeToken(jwt(SUB, Date.now() + 24 * HOUR))
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 503 }))
    const cursorCalls = () => spy.mock.calls.filter(c => String(c[0]).includes('cursor.com')).length

    const server = createServer({ version: 'test' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '1' })
    await Promise.all([server.connect(a), client.connect(b)])
    await client.callTool({ name: 'get_usage', arguments: { period: 'today' } })
    await collectDoctorReport('cursor')
    expect(cursorCalls()).toBe(0)

    await maybeSyncCursor()
    expect(cursorCalls()).toBe(1)
  })
})
