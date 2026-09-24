// Day pieces (CACHE_VERSION 10): a ranged load reads the index, the key files,
// and only the members the range reports on; an append that crosses a day
// moves the file between pieces; v9 month shards re-lay out losslessly; and a
// narrow query no longer re-parses cached transcripts outside its months.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, readFile, readdir, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  CACHE_VERSION,
  cacheStubs,
  clearLoadCacheMemo,
  computeEnvFingerprint,
  loadCache,
  loadCacheStubs,
  markCacheDirty,
  monthScopeForRange,
  saveCache,
  sessionCacheDir,
  type CachedFile,
  type SessionCache,
} from '../src/session-cache.js'
import { clearSessionCache, parseAllSessions } from '../src/parser.js'

let TMP_DIR: string

beforeEach(async () => {
  TMP_DIR = join(tmpdir(), `codeburn-pieces-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  process.env['CODEBURN_CACHE_DIR'] = TMP_DIR
  await mkdir(TMP_DIR, { recursive: true })
  clearLoadCacheMemo()
})

afterEach(async () => {
  clearLoadCacheMemo()
  if (existsSync(TMP_DIR)) await rm(TMP_DIR, { recursive: true })
})

function fileAt(days: string[], key: string): CachedFile {
  return {
    fingerprint: { dev: 1, ino: key.length, mtimeMs: 3, sizeBytes: 4 },
    lastCompleteLineOffset: 9,
    mcpInventory: [],
    turns: days.map((day, i) => {
      const timestamp = `2026-05-${day}T10:00:00.000Z`
      return {
        timestamp,
        sessionId: key,
        userMessage: 'go',
        calls: [{
          provider: 'claude',
          model: 'claude-sonnet-4-20250514',
          usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0, cacheCreationOneHourTokens: 0 },
          costUSD: 0.01,
          speed: 'standard',
          timestamp,
          tools: [],
          bashCommands: [],
          skills: [],
          subagentTypes: [],
          deduplicationKey: `${key}-${i}`,
        }],
      }
    }),
  }
}

const may = (day: string) => monthScopeForRange(new Date(`2026-05-${day}T00:00:00.000Z`), new Date(`2026-05-${day}T23:59:59.999Z`))

async function publish(files: Record<string, CachedFile>): Promise<void> {
  const cache: SessionCache = { version: CACHE_VERSION, complete: true, providers: { claude: { envFingerprint: computeEnvFingerprint('claude'), files } } }
  markCacheDirty(cache, 'claude')
  expect(await saveCache(cache)).toBe(true)
  clearLoadCacheMemo()
}

async function pieces(): Promise<Record<string, string>> {
  const dir = sessionCacheDir()
  const envelope = JSON.parse(await readFile(join(dir, 'envelope.json'), 'utf-8'))
  return JSON.parse(await readFile(join(dir, envelope.providers.claude.index), 'utf-8')).pieces
}

describe('piece selection', () => {
  it('reads members only from the pieces the range reports on; the rest come from key files', async () => {
    const files = { '/p/a.jsonl': fileAt(['01'], 'a'), '/p/b.jsonl': fileAt(['05', '06'], 'b'), '/p/c.jsonl': fileAt(['20'], 'c') }
    await publish(files)
    const named = await pieces()
    expect(Object.keys(named).sort()).toEqual(['2026-05-01', '2026-05-06', '2026-05-20'])
    // Wreck the members of every piece but the 20th's: a load that read them
    // would lose those files.
    for (const day of ['2026-05-01', '2026-05-06']) await writeFile(join(sessionCacheDir(), named[day]!), 'not json')

    const cache = await loadCache(may('20'))
    expect(cache.providers['claude']!.files).toEqual({ '/p/c.jsonl': files['/p/c.jsonl'] })
    const stubs = cacheStubs(cache, 'claude')!
    expect([...stubs.keys()]).toEqual(['/p/a.jsonl', '/p/b.jsonl'])
    expect(stubs.get('/p/b.jsonl')!.keys).toEqual([['b-0'], ['b-1']])
    expect(stubs.get('/p/b.jsonl')!.fingerprint).toEqual(files['/p/b.jsonl'].fingerprint)
  })

  it('rebuilds stub keys from the piece when its key file is gone (key files are not synced)', async () => {
    const files = { '/p/a.jsonl': fileAt(['01'], 'a'), '/p/c.jsonl': fileAt(['20'], 'c') }
    await publish(files)
    await rm(join(sessionCacheDir(), (await pieces())['2026-05-01']!.replace(/\.json$/, '.keys.json')))
    const cache = await loadCache(may('20'))
    expect(cacheStubs(cache, 'claude')!.get('/p/a.jsonl')!.keys).toEqual([['a-0']])
  })
})

describe('an append that crosses a day', () => {
  it('moves the file to its new piece and rewrites the old one without it', async () => {
    await publish({ '/p/y.jsonl': fileAt(['02'], 'y'), '/p/v.jsonl': fileAt(['02'], 'v'), '/p/x.jsonl': fileAt(['20'], 'x') })
    const before = await pieces()
    const oldPiece = await readFile(join(sessionCacheDir(), before['2026-05-02']!), 'utf-8')

    const cache = await loadCache(may('20'))
    await loadCacheStubs(cache, 'claude', ['/p/y.jsonl'])
    cache.providers['claude']!.files['/p/y.jsonl'] = fileAt(['02', '20'], 'y')
    markCacheDirty(cache, 'claude', '/p/y.jsonl')
    expect(await saveCache(cache)).toBe(true)

    const after = await pieces()
    const dir = sessionCacheDir()
    const day02 = await readFile(join(dir, after['2026-05-02']!), 'utf-8')
    const day20 = JSON.parse(await readFile(join(dir, after['2026-05-20']!), 'utf-8'))
    expect(after['2026-05-02']).not.toBe(before['2026-05-02'])
    expect(existsSync(join(dir, before['2026-05-02']!))).toBe(false)
    expect(Object.keys(JSON.parse(day02))).toEqual(['/p/v.jsonl'])
    // The neighbour's line is copied, byte for byte.
    const line = (text: string) => text.split('\n').find(l => l.startsWith('"/p/v.jsonl":'))!.replace(/,$/, '')
    expect(line(day02)).toBe(line(oldPiece))
    expect(Object.keys(day20).sort()).toEqual(['/p/x.jsonl', '/p/y.jsonl'])

    clearLoadCacheMemo()
    const full = await loadCache()
    // The rewritten entry follows the loaded ones, where a re-parse puts it on v9.
    expect(Object.keys(full.providers['claude']!.files)).toEqual(['/p/v.jsonl', '/p/x.jsonl', '/p/y.jsonl'])
    expect(full.providers['claude']!.files['/p/y.jsonl']).toEqual(fileAt(['02', '20'], 'y'))
  })
})

describe('v9 -> v10 migration', () => {
  const v9 = () => join(TMP_DIR, 'session-cache.v9')

  async function writeV9(): Promise<Record<string, CachedFile>> {
    await mkdir(v9(), { recursive: true })
    const may = { '/p/b.jsonl': fileAt(['09'], 'b'), '/p/a.jsonl': fileAt(['01', '21'], 'a') }
    const undated: Record<string, CachedFile> = { '/p/failed.jsonl': { fingerprint: { dev: 1, ino: 9, mtimeMs: 3, sizeBytes: 4 }, mcpInventory: [], turns: [], failed: true } }
    // The month shard as stage 1 wrote it (one member per line), the undated
    // one as main wrote it (one line).
    const lines = Object.entries(may).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`)
    await writeFile(join(v9(), 'claude.2026-05.aa.json'), `{\n${lines.join(',\n')}\n}`)
    await writeFile(join(v9(), 'claude.0000-00.bb.json'), JSON.stringify(undated))
    await writeFile(join(v9(), 'envelope.json'), JSON.stringify({ version: 9, complete: true, nonce: 'n', providers: {
      claude: { envFingerprint: computeEnvFingerprint('claude'), complete: true, completeFrom: 5, shards: {
        '0000-00': { name: 'claude.0000-00.bb.json', until: '0000-00' },
        '2026-05': { name: 'claude.2026-05.aa.json', until: '2026-05' },
      } },
    } }))
    return { ...undated, ...may }
  }

  it('is lossless, keeps v9 load order, and retires v9 once v10 is published', async () => {
    const expected = await writeV9()
    const cache = await loadCache()
    expect(existsSync(v9())).toBe(false)
    expect(cache.complete).toBe(true)
    expect(cache.providers['claude']!.complete).toBe(true)
    expect(cache.providers['claude']!.completeFrom).toBe(5)
    expect(Object.keys(cache.providers['claude']!.files)).toEqual(['/p/failed.jsonl', '/p/b.jsonl', '/p/a.jsonl'])
    expect(cache.providers['claude']!.files).toEqual(expected)
    expect(Object.keys(await pieces()).sort()).toEqual(['0000-00-00', '2026-05-09', '2026-05-21'])
    // Members moved verbatim.
    const a = await readFile(join(sessionCacheDir(), (await pieces())['2026-05-21']!), 'utf-8')
    expect(a).toBe(`{\n${JSON.stringify('/p/a.jsonl')}:${JSON.stringify(expected['/p/a.jsonl'])}\n}`)
  })

  it('leaves v9 in place when the v10 directory cannot be written', async () => {
    await writeV9()
    await writeFile(join(TMP_DIR, `session-cache.v${CACHE_VERSION}`), 'in the way')
    await loadCache().catch(() => null)
    expect(existsSync(join(v9(), 'envelope.json'))).toBe(true)
    expect(await readdir(v9())).toHaveLength(3)
  })
})

describe('a narrow query and an older transcript', () => {
  const home = () => join(TMP_DIR, 'home')
  const saved = { dir: process.env['CLAUDE_CONFIG_DIR'], desktop: process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] }

  beforeEach(() => {
    process.env['CLAUDE_CONFIG_DIR'] = home()
    process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(TMP_DIR, 'no-desktop')
    clearSessionCache()
  })
  afterEach(() => {
    if (saved.dir === undefined) delete process.env['CLAUDE_CONFIG_DIR']; else process.env['CLAUDE_CONFIG_DIR'] = saved.dir
    if (saved.desktop === undefined) delete process.env['CODEBURN_DESKTOP_SESSIONS_DIR']; else process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = saved.desktop
    delete process.env['CODEBURN_PROGRESS']
    clearSessionCache()
  })

  async function session(name: string, iso: string): Promise<void> {
    const dir = join(home(), 'projects', 'proj')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${name}.jsonl`), [
      { type: 'user', uuid: `u-${name}`, sessionId: name, timestamp: iso, cwd: '/tmp/proj', message: { role: 'user', content: 'go' } },
      { type: 'assistant', uuid: `a-${name}`, sessionId: name, timestamp: iso, cwd: '/tmp/proj',
        message: { id: `msg-${name}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: 100, output_tokens: 50 } } },
    ].map(line => JSON.stringify(line)).join('\n') + '\n')
  }

  it('does not re-parse a cached June file on a September day, and writes nothing', async () => {
    await session('june', '2099-06-10T10:00:00Z')
    await session('today', '2099-09-23T10:00:00Z')
    await parseAllSessions()
    const day = { start: new Date('2099-09-23T00:00:00.000Z'), end: new Date('2099-09-23T23:59:59.999Z') }
    const narrow = async (): Promise<number[]> => {
      clearSessionCache()
      clearLoadCacheMemo()
      const totals: number[] = []
      process.env['CODEBURN_PROGRESS'] = '1'
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
        const m = /"kind":"tick","provider":"claude","done":0,"total":(\d+)/.exec(String(chunk))
        if (m) totals.push(Number(m[1]))
        return true
      }) as typeof process.stderr.write)
      try {
        const projects = await parseAllSessions(day, 'claude')
        expect(projects.reduce((n, p) => n + p.totalApiCalls, 0)).toBe(1)
      } finally {
        spy.mockRestore()
        delete process.env['CODEBURN_PROGRESS']
      }
      return totals
    }
    await narrow()
    const envelope = await readFile(join(sessionCacheDir(), 'envelope.json'), 'utf-8')
    expect(await narrow()).toEqual([0])
    expect(await readFile(join(sessionCacheDir(), 'envelope.json'), 'utf-8')).toBe(envelope)
  })
})
