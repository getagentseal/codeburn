// A ranged load holds the cached files its range cannot report on as stubs.
// These pin what that must never cost: a save rewrites a bucket holding stubs
// without losing or rebuilding their members, a single-line shard from an
// older build converts on the next save, and a wider request in the same
// process loads the members it now needs.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  CACHE_VERSION,
  cacheStubs,
  clearLoadCacheMemo,
  computeEnvFingerprint,
  loadCache,
  markCacheDirty,
  monthScopeForRange,
  saveCache,
  sessionCacheDir,
  type CachedFile,
  type SessionCache,
} from '../src/session-cache.js'

let TMP_DIR: string

beforeEach(async () => {
  TMP_DIR = join(tmpdir(), `codeburn-bounded-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  process.env['CODEBURN_CACHE_DIR'] = TMP_DIR
  await mkdir(TMP_DIR, { recursive: true })
  clearLoadCacheMemo()
})

afterEach(async () => {
  if (existsSync(TMP_DIR)) await rm(TMP_DIR, { recursive: true })
})

function fileAt(day: string, key: string, extraTurns = 0): CachedFile {
  const turn = (i: number): CachedFile['turns'][number] => {
    const timestamp = `2026-05-${day}T1${i}:00:00.000Z`
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
  }
  return { fingerprint: { dev: 1, ino: key.length, mtimeMs: 3, sizeBytes: 4 }, lastCompleteLineOffset: 9, mcpInventory: [], turns: Array.from({ length: 1 + extraTurns }, (_, i) => turn(i)) }
}

const day20 = monthScopeForRange(new Date('2026-05-20T00:00:00.000Z'), new Date('2026-05-20T23:59:59.999Z'))

async function publish(files: Record<string, CachedFile>): Promise<void> {
  const cache: SessionCache = { version: CACHE_VERSION, complete: true, providers: { claude: { envFingerprint: computeEnvFingerprint('claude'), files } } }
  markCacheDirty(cache, 'claude')
  expect(await saveCache(cache)).toBe(true)
  clearLoadCacheMemo()
}

async function mayShard(): Promise<{ name: string; text: string }> {
  const envelope = JSON.parse(await readFile(join(sessionCacheDir(), 'envelope.json'), 'utf-8'))
  const name = envelope.providers.claude.shards['2026-05'].name as string
  return { name, text: await readFile(join(sessionCacheDir(), name), 'utf-8') }
}

function memberLine(text: string, path: string): string | undefined {
  return text.split('\n').find(line => line.startsWith(JSON.stringify(path) + ':'))?.replace(/,$/, '')
}

describe('bounded ranged load', () => {
  it('rewrites a bucket holding stubs by copying their lines, in full-load order', async () => {
    await publish({ '/p/x.jsonl': fileAt('20', 'x'), '/p/y.jsonl': fileAt('02', 'y'), '/p/w.jsonl': fileAt('03', 'w') })
    const before = await mayShard()
    expect(before.text.startsWith('{\n')).toBe(true)
    expect(JSON.parse(before.text)).toEqual({ '/p/x.jsonl': fileAt('20', 'x'), '/p/y.jsonl': fileAt('02', 'y'), '/p/w.jsonl': fileAt('03', 'w') })

    const cache = await loadCache(day20)
    const section = cache.providers['claude']!
    expect(Object.keys(section.files)).toEqual(['/p/x.jsonl'])
    expect([...cacheStubs(cache, 'claude')!.keys()]).toEqual(['/p/y.jsonl', '/p/w.jsonl'])

    // What a re-parse does: delete, then install; plus one new file.
    delete section.files['/p/x.jsonl']
    section.files['/p/x.jsonl'] = fileAt('20', 'x', 1)
    section.files['/p/z.jsonl'] = fileAt('21', 'z')
    markCacheDirty(cache, 'claude', '/p/x.jsonl')
    markCacheDirty(cache, 'claude', '/p/z.jsonl')
    expect(await saveCache(cache)).toBe(true)

    const after = await mayShard()
    expect(after.name).not.toBe(before.name)
    expect(memberLine(after.text, '/p/y.jsonl')).toBe(memberLine(before.text, '/p/y.jsonl'))
    expect(memberLine(after.text, '/p/w.jsonl')).toBe(memberLine(before.text, '/p/w.jsonl'))
    const parsed = JSON.parse(after.text) as Record<string, CachedFile>
    // A full load would hold the re-parsed file after the loaded ones.
    expect(Object.keys(parsed)).toEqual(['/p/y.jsonl', '/p/w.jsonl', '/p/x.jsonl', '/p/z.jsonl'])
    expect(parsed['/p/x.jsonl']).toEqual(fileAt('20', 'x', 1))
    expect(parsed['/p/y.jsonl']).toEqual(fileAt('02', 'y'))

    // Dirty but unchanged: the published shard is kept.
    markCacheDirty(cache, 'claude', '/p/x.jsonl')
    expect(await saveCache(cache)).toBe(true)
    expect((await mayShard()).name).toBe(after.name)

    clearLoadCacheMemo()
    const full = await loadCache()
    expect(full.providers['claude']!.files).toEqual(parsed)
  })

  it('converts a single-line shard from an older build on the next save and still loads stubs from it', async () => {
    const files = { '/p/x.jsonl': fileAt('20', 'x'), '/p/y.jsonl': fileAt('02', 'y') }
    const dir = sessionCacheDir()
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'claude.2026-05.0123456789abcdef.json'), JSON.stringify(files))
    await writeFile(join(dir, 'envelope.json'), JSON.stringify({
      version: CACHE_VERSION, complete: true, nonce: 'legacy',
      providers: { claude: { envFingerprint: computeEnvFingerprint('claude'), complete: true, shards: { '2026-05': { name: 'claude.2026-05.0123456789abcdef.json', until: '2026-05' } } } },
    }))

    const cache = await loadCache(day20)
    expect([...cacheStubs(cache, 'claude')!.keys()]).toEqual(['/p/y.jsonl'])
    // Any save rewrites it, even one whose only change is elsewhere.
    cache.providers['codex'] = { envFingerprint: computeEnvFingerprint('codex'), files: { '/c/r.jsonl': fileAt('20', 'r') } }
    markCacheDirty(cache, 'codex', '/c/r.jsonl')
    expect(await saveCache(cache)).toBe(true)

    const after = await mayShard()
    expect(after.name).not.toBe('claude.2026-05.0123456789abcdef.json')
    expect(after.text.startsWith('{\n')).toBe(true)
    expect(JSON.parse(after.text)).toEqual(files)

    // A wider request in this process loads the stub from its new line.
    const wider = await loadCache(monthScopeForRange(new Date('2026-05-01T00:00:00.000Z'), new Date('2026-05-20T23:59:59.999Z')))
    expect(wider).toBe(cache)
    expect(cacheStubs(cache, 'claude')!.size).toBe(0)
    expect(cache.providers['claude']!.files['/p/y.jsonl']).toEqual(fileAt('02', 'y'))
  })

  it('reads the same members as a full load for every range', async () => {
    const files = { '/p/a.jsonl': fileAt('01', 'a'), '/p/b.jsonl': fileAt('15', 'b', 2), '/p/c.jsonl': fileAt('20', 'c') }
    await publish(files)
    for (const [from, to] of [['01', '01'], ['15', '15'], ['02', '14'], ['01', '31']]) {
      clearLoadCacheMemo()
      const cache = await loadCache(monthScopeForRange(new Date(`2026-05-${from}T00:00:00.000Z`), new Date(`2026-05-${to}T23:59:59.999Z`)))
      const held = { ...cache.providers['claude']!.files }
      for (const [path, stub] of cacheStubs(cache, 'claude') ?? []) {
        expect(stub.keys).toEqual(files[path as keyof typeof files].turns.map(t => t.calls.map(c => c.deduplicationKey)))
        expect(stub.fingerprint).toEqual(files[path as keyof typeof files].fingerprint)
        held[path] = files[path as keyof typeof files]
      }
      expect(held).toEqual(files)
    }
  })
})
