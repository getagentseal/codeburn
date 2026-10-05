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
import { collectDoctorReport } from '../src/doctor.js'
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
const n = new Date(NOW)
const firstStart = Math.min(new Date(n.getFullYear(), n.getMonth(), 1).getTime(), new Date(n.getFullYear(), n.getMonth(), n.getDate() - 30).getTime())
const urlOf = (f: ReturnType<typeof fakeFetch>, i = 0) => new URL(String(f.mock.calls[i]![0]))
const state = async () => JSON.parse(await readFile(cursorSyncStatePath(), 'utf-8'))
const stored = async () => JSON.parse(await readFile(cursorImportPath(), 'utf-8')) as { ranges: Array<{ source?: string; end: string }>; events: Array<{ input: number; source?: string }> }

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

describe.skipIf(!isSqliteAvailable())('maybeSyncCursor', () => {
  it('first sync downloads from the earlier of month start or 30 days back, then only from the last covered day', async () => {
    const f = fakeFetch()
    const s = await maybeSyncCursor({ now: NOW, fetchImpl: f })
    expect(s).toMatchObject({ changed: true, added: 3 })
    expect(urlOf(f).origin + urlOf(f).pathname).toBe('https://cursor.com/api/dashboard/export-usage-events-csv')
    expect(Object.fromEntries(urlOf(f).searchParams)).toEqual({ startDate: String(firstStart), endDate: String(NOW), strategy: 'tokens' })
    const headers = f.mock.calls[0]![1]!.headers as Record<string, string>
    expect(headers['Cookie']).toBe(`WorkosCursorSessionToken=user_sync_test%3A%3A${jwt()}`)
    expect(headers['Origin']).toBe('https://cursor.com')

    // Coverage ends at the newest event, so later local usage keeps its estimate.
    expect((await stored()).ranges).toEqual([{ start: new Date(firstStart).toISOString(), end: at(2), source: 'sync' }])
    const saved = await state()
    expect(saved).toMatchObject({ lastAttemptAt: NOW, lastSuccessAt: NOW, account: expect.stringMatching(/^[0-9a-f]{16}$/) })
    expect(JSON.stringify(saved)).not.toContain('user_sync_test')

    const g = fakeFetch({ body: csv([ROWS[2]!, { date: at(-1), input: 40 }]) })
    expect(await maybeSyncCursor({ now: NOW + 10 * MIN, fetchImpl: g })).toBeNull()
    expect(g).not.toHaveBeenCalled()
    await maybeSyncCursor({ now: NOW + 2 * HOUR, fetchImpl: g })
    const newest = new Date(at(2))
    expect(urlOf(g).searchParams.get('startDate')).toBe(String(new Date(newest.getFullYear(), newest.getMonth(), newest.getDate()).getTime()))
    expect((await stored()).events).toHaveLength(4)
  })

  it('401 backs off for 6 hours unless the token changes', async () => {
    await maybeSyncCursor({ now: NOW, fetchImpl: fakeFetch({ status: 401 }) })
    expect(await state()).toMatchObject({ backoffUntil: NOW + 6 * HOUR, lastError: expect.stringContaining('401') })
    const f = fakeFetch()
    await maybeSyncCursor({ now: NOW + HOUR, fetchImpl: f })
    expect(f).not.toHaveBeenCalled()
    writeToken(jwt(SUB, NOW + 48 * HOUR))
    await maybeSyncCursor({ now: NOW + HOUR, fetchImpl: f })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('429 honours Retry-After', async () => {
    await maybeSyncCursor({ now: NOW, fetchImpl: fakeFetch({ status: 429, headers: { 'Retry-After': '3600' } }) })
    expect((await state()).backoffUntil).toBe(NOW + HOUR)
    const f = fakeFetch()
    await maybeSyncCursor({ now: NOW + 30 * MIN, fetchImpl: f })
    expect(f).not.toHaveBeenCalled()
    await maybeSyncCursor({ now: NOW + 61 * MIN, fetchImpl: f })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('a 5xx, a network error or a foreign body keeps the stored usage', async () => {
    await maybeSyncCursor({ now: NOW, fetchImpl: fakeFetch() })
    const before = await readFile(cursorImportPath(), 'utf-8')
    const mtime = (await stat(cursorImportPath())).mtimeMs
    let t = NOW
    for (const f of [
      fakeFetch({ status: 503 }),
      vi.fn(async () => { throw new TypeError('fetch failed') }),
      fakeFetch({ body: '{"email":"someone@example.com"}\n' }),
    ]) {
      t += 16 * MIN
      expect(await maybeSyncCursor({ now: t, fetchImpl: f as unknown as typeof fetch })).toBeNull()
      expect(f).toHaveBeenCalledTimes(1)
      expect((await state()).lastError).toBeTruthy()
    }
    expect((await state()).lastError).toMatch(/not a Cursor usage export/)
    expect(JSON.stringify(await state())).not.toContain('example.com')
    expect(await readFile(cursorImportPath(), 'utf-8')).toBe(before)
    expect((await stat(cursorImportPath())).mtimeMs).toBe(mtime)
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

  it('an account change drops the previous account\'s synced usage but keeps manual imports', async () => {
    const manual = join(root, 'manual.csv')
    await writeFile(manual, csv([{ date: at(100), input: 1 }]))
    await importCursorCsv(manual)
    await maybeSyncCursor({ now: NOW, fetchImpl: fakeFetch() })
    writeToken(jwt('auth0|someone_else'))
    const f = fakeFetch({ body: csv([{ date: at(1), input: 99 }]) })
    await maybeSyncCursor({ now: NOW + 16 * MIN, fetchImpl: f })
    expect(urlOf(f).searchParams.get('startDate')).toBe(String(firstStart))
    const s = await stored()
    expect(s.events.map(e => [e.input, e.source])).toEqual([[1, undefined], [99, 'sync']])
    expect(s.ranges.filter(r => r.source === 'sync')).toEqual([expect.objectContaining({ end: at(1) })])
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
