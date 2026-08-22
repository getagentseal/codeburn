// Provider x month shard layout (CACHE_VERSION 9): the on-disk cache is a
// directory holding one envelope plus one shard per provider-month. What matters
// here is that the move off the older layouts loses nothing, that a file's
// bucket never moves when the session is appended to, that a save rewrites only
// the months that changed (including when the load was scoped to a subset of
// them), and that one unreadable shard costs exactly one month.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  CACHE_VERSION,
  cacheBucketMonth,
  cacheFileSpan,
  computeEnvFingerprint,
  cleanupOrphanedTempFiles,
  clearLoadCacheMemo,
  loadCache,
  markCacheDirty,
  monthScopeForRange,
  saveCache,
  sessionCacheDir,
  lookupCachedFile,
  isIndexOnly,
  reconcileIndexedFile,
  type CachedFile,
  type SessionCache,
} from '../src/session-cache.js'

let TMP_DIR: string

beforeEach(async () => {
  TMP_DIR = join(tmpdir(), `codeburn-shard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  process.env['CODEBURN_CACHE_DIR'] = TMP_DIR
  await mkdir(TMP_DIR, { recursive: true })
  clearLoadCacheMemo()
})

afterEach(async () => {
  if (existsSync(TMP_DIR)) await rm(TMP_DIR, { recursive: true })
})

function turnAt(timestamp: string, key = 'msg-1'): CachedFile['turns'][number] {
  const base = cachedFile().turns[0]!
  return { ...base, timestamp, calls: [{ ...base.calls[0]!, timestamp, deduplicationKey: key }] }
}

function fileSpanning(first: string, last?: string): CachedFile {
  return cachedFile({ turns: last ? [turnAt(first, 'a'), turnAt(last, 'b')] : [turnAt(first, 'a')] })
}

function cachedFile(overrides: Partial<CachedFile> = {}): CachedFile {
  return {
    fingerprint: { dev: 1, ino: 2, mtimeMs: 3, sizeBytes: 4 },
    lastCompleteLineOffset: 128,
    mcpInventory: ['mcp__github__list'],
    turns: [{
      timestamp: '2026-05-15T10:00:00Z',
      sessionId: 'sess-1',
      userMessage: 'do the thing',
      calls: [{
        provider: 'claude',
        model: 'claude-sonnet-4-20250514',
        usage: {
          inputTokens: 1000,
          outputTokens: 500,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          webSearchRequests: 0,
          cacheCreationOneHourTokens: 0,
        },
        costUSD: 0.01,
        speed: 'standard',
        timestamp: '2026-05-15T10:00:00Z',
        tools: ['Read'],
        bashCommands: [],
        skills: [],
        subagentTypes: [],
        deduplicationKey: 'msg-1',
      }],
    }],
    ...overrides,
  }
}

function v7Cache(): SessionCache {
  return {
    version: 7,
    complete: true,
    providers: {
      claude: {
        envFingerprint: 'claude-fp',
        files: {
          '/live/a.jsonl': cachedFile(),
          '/live/b.jsonl': cachedFile({ turns: [] }),
          // An orphaned PR-linked entry: its transcript is gone and can never
          // re-parse, so the migration has to carry it across verbatim.
          '/gone/pruned.jsonl': cachedFile({ prLinks: ['https://github.com/o/r/pull/1'] }),
        },
      },
      codex: {
        envFingerprint: 'codex-fp',
        durable: true,
        files: { '/live/rollout.jsonl': cachedFile() },
      },
    },
  }
}

async function shardNames(): Promise<string[]> {
  return (await readdir(sessionCacheDir())).sort()
}

async function envelope(): Promise<{ providers: Record<string, { shards: Record<string, { name: string; until: string }> }> }> {
  return JSON.parse(await readFile(join(sessionCacheDir(), 'envelope.json'), 'utf-8'))
}

/** name -> bytes, for every shard on disk. */
async function shardBytes(): Promise<Map<string, string>> {
  const dir = sessionCacheDir()
  const out = new Map<string, string>()
  for (const name of await shardNames()) out.set(name, await readFile(join(dir, name), 'utf-8'))
  return out
}

describe('v7 -> shard migration', () => {
  it('is lossless: every entry survives, shards replace the v7 file, reload matches', async () => {
    const v7 = v7Cache()
    const v7Path = join(TMP_DIR, 'session-cache.v7.json')
    await writeFile(v7Path, JSON.stringify(v7))

    const loaded = await loadCache()
    // Same content, re-stamped at the current version.
    expect(loaded).toEqual({ ...v7, version: CACHE_VERSION })

    // Shards on disk, v7 blob removed.
    expect(existsSync(v7Path)).toBe(false)
    const names = await shardNames()
    expect(names).toContain('envelope.json')
    // claude's three entries split by month: two dated 2026-05, one turn-less.
    expect(Object.keys((await envelope()).providers['claude']!.shards).sort()).toEqual(['0000-00', '2026-05'])
    expect(Object.keys((await envelope()).providers['codex']!.shards)).toEqual(['2026-05'])

    // A second load reads only the shards and produces the same cache.
    clearLoadCacheMemo()
    expect(await loadCache()).toEqual(loaded)
  })

  it('leaves a corrupt v7 file alone and starts fresh', async () => {
    await writeFile(join(TMP_DIR, 'session-cache.v7.json'), '{broken')
    const loaded = await loadCache()
    expect(loaded.providers).toEqual({})
    expect(existsSync(join(TMP_DIR, 'session-cache.v7.json'))).toBe(true)
  })
})

describe('per-provider dirty tracking', () => {
  it('rewrites only the provider that changed', async () => {
    await writeFile(join(TMP_DIR, 'session-cache.v7.json'), JSON.stringify(v7Cache()))
    const cache = await loadCache()

    const dir = sessionCacheDir()
    const before = new Map<string, string>()
    for (const name of await shardNames()) before.set(name, await readFile(join(dir, name), 'utf-8'))

    cache.providers['codex']!.files['/live/rollout.jsonl'] = cachedFile({ mcpInventory: ['changed'] })
    markCacheDirty(cache, 'codex')
    await saveCache(cache)

    const after = await shardNames()
    const claudeShard = [...before.keys()].find(n => n.startsWith('claude.'))!
    // The untouched provider keeps its exact file, byte for byte.
    expect(after).toContain(claudeShard)
    expect(await readFile(join(dir, claudeShard), 'utf-8')).toBe(before.get(claudeShard))
    // The changed provider is republished under a new name; the old one is gone.
    const codexBefore = [...before.keys()].find(n => n.startsWith('codex.'))!
    const codexAfter = after.find(n => n.startsWith('codex.'))!
    expect(codexAfter).not.toBe(codexBefore)
    expect(after).not.toContain(codexBefore)

    clearLoadCacheMemo()
    const reloaded = await loadCache()
    expect(reloaded.providers['codex']!.files['/live/rollout.jsonl']!.mcpInventory).toEqual(['changed'])
    expect(reloaded.providers['claude']).toEqual(cache.providers['claude'])
  })
})

describe('corrupt shard isolation', () => {
  it('drops only the unreadable month, keeping every other month and provider', async () => {
    const cache: SessionCache = {
      version: CACHE_VERSION,
      complete: true,
      providers: {
        claude: {
          envFingerprint: 'claude-fp',
          files: { '/live/may.jsonl': fileSpanning('2026-05-15T10:00:00Z'), '/live/jun.jsonl': fileSpanning('2026-06-15T10:00:00Z') },
        },
        codex: { envFingerprint: 'codex-fp', files: { '/live/r.jsonl': fileSpanning('2026-05-15T10:00:00Z') } },
      },
    }
    markCacheDirty(cache, 'claude')
    markCacheDirty(cache, 'codex')
    await saveCache(cache)

    const dir = sessionCacheDir()
    await writeFile(join(dir, (await envelope()).providers['claude']!.shards['2026-05']!.name), '{"/x":{"turns":')

    clearLoadCacheMemo()
    const reloaded = await loadCache()
    expect(Object.keys(reloaded.providers['claude']!.files)).toEqual(['/live/jun.jsonl'])
    expect(reloaded.providers['codex']).toEqual(cache.providers['codex'])

    // Self-heals: the unreadable month is republished from whatever re-parses
    // into it rather than being carried forward corrupt forever.
    reloaded.providers['claude']!.files['/live/may.jsonl'] = fileSpanning('2026-05-15T10:00:00Z')
    markCacheDirty(reloaded, 'claude', '/live/may.jsonl')
    await saveCache(reloaded)
    clearLoadCacheMemo()
    expect(Object.keys((await loadCache()).providers['claude']!.files).sort()).toEqual(['/live/jun.jsonl', '/live/may.jsonl'])
  })
})

describe('cleanupOrphanedTempFiles', () => {
  it('sweeps stale shard temps and unreferenced shards, keeping the live ones', async () => {
    await saveCache({ version: CACHE_VERSION, complete: true, providers: {
      claude: { envFingerprint: 'fp', files: { '/a.jsonl': cachedFile() } },
    } })
    const dir = sessionCacheDir()
    const live = (await shardNames()).find(n => n.startsWith('claude.'))!

    const backdate = async (path: string, minutes: number) => {
      const at = new Date(Date.now() - minutes * 60 * 1000)
      await utimes(path, at, at)
    }

    const oldTemp = join(dir, 'claude.deadbeef.json.tmp')
    await writeFile(oldTemp, 'partial')
    await backdate(oldTemp, 10)
    const orphanShard = join(dir, 'codex.deadbeef.json')
    await writeFile(orphanShard, '{}')
    await backdate(orphanShard, 90)
    // Unreferenced but fresh: this is what a CONCURRENT save's shard looks like
    // before its envelope lands, so the sweep must leave it alone.
    const inFlightShard = join(dir, 'codex.c0ffee00.json')
    await writeFile(inFlightShard, '{}')
    const recentTemp = join(dir, 'claude.feedface.json.tmp')
    await writeFile(recentTemp, 'in flight')
    // The live shard is far older than the temp cutoff; being referenced is what
    // protects it, not its age.
    await backdate(join(dir, live), 120)

    await cleanupOrphanedTempFiles()

    expect(existsSync(oldTemp)).toBe(false)
    expect(existsSync(orphanShard)).toBe(false)
    expect(existsSync(inFlightShard)).toBe(true)
    expect(existsSync(recentTemp)).toBe(true)
    expect(existsSync(join(dir, live))).toBe(true)
    expect(existsSync(join(dir, 'envelope.json'))).toBe(true)
  })

  it('retires the pre-v8 single-file layout temps left in the parent directory', async () => {
    await saveCache({ version: CACHE_VERSION, complete: true, providers: {} })
    const legacyTemp = join(TMP_DIR, 'session-cache.v7.json.abc123.tmp')
    await writeFile(legacyTemp, 'orphan from an older build')
    const at = new Date(Date.now() - 10 * 60 * 1000)
    await utimes(legacyTemp, at, at)
    const freshLegacyTemp = join(TMP_DIR, 'session-cache.v7.json.def456.tmp')
    await writeFile(freshLegacyTemp, 'an old binary mid-write')

    await cleanupOrphanedTempFiles()

    expect(existsSync(legacyTemp)).toBe(false)
    expect(existsSync(freshLegacyTemp)).toBe(true)
  })
})

// Two live processes share one cache directory routinely: a one-shot CLI beside
// the resident serve child, or two menubar polls. Neither may publish an
// envelope naming a file that is not there — that reads back as a corrupt
// provider and silently drops its history.
describe('concurrent writers', () => {
  function seed(provider: string, tag: string, files: number): SessionCache {
    const cache: SessionCache = {
      version: CACHE_VERSION,
      complete: true,
      providers: {
        [provider]: {
          envFingerprint: tag,
          files: Object.fromEntries(
            Array.from({ length: files }, (_, i) => [`/f/${provider}/${i}.jsonl`, cachedFile()]),
          ),
        },
      },
    }
    markCacheDirty(cache, provider)
    return cache
  }

  async function assertReferentialIntegrity(expected: string[]): Promise<void> {
    const dir = sessionCacheDir()
    for (const meta of Object.values((await envelope()).providers)) {
      for (const ref of Object.values(meta.shards)) {
        expect(existsSync(join(dir, ref.name)), `envelope names a missing shard: ${ref.name}`).toBe(true)
      }
    }
    clearLoadCacheMemo()
    const loaded = await loadCache()
    expect(Object.keys(loaded.providers).length).toBeGreaterThan(0)
    for (const provider of expected) expect(loaded.providers[provider]).toBeDefined()
  }

  it('never publishes a dangling envelope when two saves race', async () => {
    for (let round = 0; round < 15; round++) {
      await Promise.allSettled([
        saveCache(seed('claude', `a${round}`, 40)),
        saveCache(seed('codex', `b${round}`, 40)),
      ])
      // Whichever won, the published set has to be internally consistent and
      // hold at least the provider that got there last.
      await assertReferentialIntegrity([])
    }
  })

  it('a stale writer rewrites a shard another process retired instead of orphaning it', async () => {
    // Seed: claude holds an expired-source PR orphan no re-parse can recover.
    const initial: SessionCache = {
      version: CACHE_VERSION,
      complete: true,
      providers: {
        claude: { envFingerprint: 'fp', files: { '/gone/pruned.jsonl': cachedFile({ prLinks: ['https://github.com/o/r/pull/1'] }) } },
        codex: { envFingerprint: 'fp', durable: true, files: { '/live/r.jsonl': cachedFile() } },
      },
    }
    markCacheDirty(initial, 'claude')
    markCacheDirty(initial, 'codex')
    await saveCache(initial)

    // Process B loads now, recording claude's current shard name.
    clearLoadCacheMemo()
    const b = await loadCache()

    // Process A independently touches ONLY claude and republishes, retiring the
    // shard file B is still holding a name for.
    clearLoadCacheMemo()
    const a = await loadCache()
    a.providers['claude']!.files['/live/new.jsonl'] = cachedFile()
    markCacheDirty(a, 'claude')
    await saveCache(a)

    // B now saves an unrelated codex change.
    b.providers['codex']!.files['/live/r2.jsonl'] = cachedFile()
    markCacheDirty(b, 'codex')
    await saveCache(b)

    await assertReferentialIntegrity(['claude', 'codex'])
    clearLoadCacheMemo()
    const final = await loadCache()
    expect(final.providers['claude']!.files['/gone/pruned.jsonl']).toBeDefined()
    expect(final.providers['codex']!.files['/live/r2.jsonl']).toBeDefined()
  })
})

describe('month buckets', () => {
  it('keeps a file in its first-turn month when the session is appended to', async () => {
    const cache: SessionCache = {
      version: CACHE_VERSION,
      complete: true,
      providers: { claude: { envFingerprint: 'fp', files: { '/live/long.jsonl': fileSpanning('2026-05-15T10:00:00Z') } } },
    }
    markCacheDirty(cache, 'claude')
    await saveCache(cache)
    expect(Object.keys((await envelope()).providers['claude']!.shards)).toEqual(['2026-05'])

    // Two months of appends later the bucket is unchanged; only `until` moves,
    // which is what lets a ranged load still find this session.
    const appended = fileSpanning('2026-05-15T10:00:00Z', '2026-07-02T10:00:00Z')
    expect(cacheBucketMonth(appended)).toBe('2026-05')
    cache.providers['claude']!.files['/live/long.jsonl'] = appended
    markCacheDirty(cache, 'claude', '/live/long.jsonl')
    await saveCache(cache)
    const shards = (await envelope()).providers['claude']!.shards
    expect(Object.keys(shards)).toEqual(['2026-05'])
    expect(shards['2026-05']!.until).toBe('2026-07')

    // ...and a July query still loads it, despite the May bucket key.
    clearLoadCacheMemo()
    const scoped = await loadCache(monthScopeForRange(new Date('2026-07-01T00:00:00Z'), new Date('2026-07-31T23:59:59Z')))
    expect(scoped.providers['claude']!.files['/live/long.jsonl']).toBeDefined()
  })

  it('rewrites only the month that changed', async () => {
    const cache: SessionCache = {
      version: CACHE_VERSION,
      complete: true,
      providers: {
        claude: {
          envFingerprint: 'fp',
          files: {
            '/live/mar.jsonl': fileSpanning('2026-03-10T10:00:00Z'),
            '/live/apr.jsonl': fileSpanning('2026-04-10T10:00:00Z'),
            '/live/may.jsonl': fileSpanning('2026-05-10T10:00:00Z'),
          },
        },
      },
    }
    markCacheDirty(cache, 'claude')
    await saveCache(cache)
    const before = await shardBytes()
    const untouched = [
      (await envelope()).providers['claude']!.shards['2026-03']!.name,
      (await envelope()).providers['claude']!.shards['2026-04']!.name,
    ]

    cache.providers['claude']!.files['/live/may.jsonl'] = cachedFile({ turns: [turnAt('2026-05-10T10:00:00Z', 'a')], mcpInventory: ['changed'] })
    markCacheDirty(cache, 'claude', '/live/may.jsonl')
    await saveCache(cache)

    const after = await shardBytes()
    for (const name of untouched) expect(after.get(name)).toBe(before.get(name))
    expect(after.has((await envelope()).providers['claude']!.shards['2026-05']!.name)).toBe(true)
  })

  it('dirties the month a deleted file was in', async () => {
    const cache: SessionCache = {
      version: CACHE_VERSION,
      complete: true,
      providers: {
        claude: {
          envFingerprint: 'fp',
          files: { '/live/mar.jsonl': fileSpanning('2026-03-10T10:00:00Z'), '/live/mar2.jsonl': fileSpanning('2026-03-11T10:00:00Z') },
        },
      },
    }
    markCacheDirty(cache, 'claude')
    await saveCache(cache)

    delete cache.providers['claude']!.files['/live/mar2.jsonl']
    markCacheDirty(cache, 'claude', '/live/mar2.jsonl')
    await saveCache(cache)

    clearLoadCacheMemo()
    expect(Object.keys((await loadCache()).providers['claude']!.files)).toEqual(['/live/mar.jsonl'])
  })
})

describe('scoped load', () => {
  async function seedThreeMonths(): Promise<void> {
    const cache: SessionCache = {
      version: CACHE_VERSION,
      complete: true,
      providers: {
        claude: {
          envFingerprint: computeEnvFingerprint('claude'),
          files: {
            '/live/mar.jsonl': fileSpanning('2026-03-10T10:00:00Z'),
            '/live/apr.jsonl': fileSpanning('2026-04-10T10:00:00Z'),
            '/live/jun.jsonl': fileSpanning('2026-06-10T10:00:00Z'),
          },
        },
      },
    }
    markCacheDirty(cache, 'claude')
    await saveCache(cache)
  }

  const juneScope = monthScopeForRange(new Date('2026-06-01T00:00:00Z'), new Date('2026-06-30T23:59:59Z'))

  it('reads only the months the range can report on, plus one of slack', async () => {
    await seedThreeMonths()
    clearLoadCacheMemo()
    const scoped = await loadCache(juneScope)
    // June is in range; May would be the slack month (absent here); March and
    // April cannot contribute a June turn and stay on disk.
    expect(Object.keys(scoped.providers['claude']!.files)).toEqual(['/live/jun.jsonl'])
  })

  it('save from a scoped load leaves the unloaded months byte-identical', async () => {
    await seedThreeMonths()
    const before = await shardBytes()
    const kept = [
      (await envelope()).providers['claude']!.shards['2026-03']!.name,
      (await envelope()).providers['claude']!.shards['2026-04']!.name,
    ]

    clearLoadCacheMemo()
    const scoped = await loadCache(juneScope)
    scoped.providers['claude']!.files['/live/jun2.jsonl'] = fileSpanning('2026-06-20T10:00:00Z')
    markCacheDirty(scoped, 'claude', '/live/jun2.jsonl')
    await saveCache(scoped)

    const after = await shardBytes()
    for (const name of kept) expect(after.get(name), `unloaded month rewritten: ${name}`).toBe(before.get(name))

    clearLoadCacheMemo()
    const full = await loadCache()
    expect(Object.keys(full.providers['claude']!.files).sort())
      .toEqual(['/live/apr.jsonl', '/live/jun.jsonl', '/live/jun2.jsonl', '/live/mar.jsonl'])
  })

  it('keeps the unloaded month\'s shard name when a re-parse re-derives the same entry', async () => {
    await seedThreeMonths()
    // The March entry is invisible to a June-scoped run, so the reconcile
    // re-parses that file and writes the identical entry straight back. Nothing
    // changed, so the March shard must keep its name run after run (#1032).
    const nameOf = async (): Promise<string> => (await envelope()).providers['claude']!.shards['2026-03']!.name
    const before = await nameOf()
    for (let run = 0; run < 2; run++) {
      clearLoadCacheMemo()
      const scoped = await loadCache(juneScope)
      scoped.providers['claude']!.files['/live/mar.jsonl'] = fileSpanning('2026-03-10T10:00:00Z')
      markCacheDirty(scoped, 'claude', '/live/mar.jsonl')
      await saveCache(scoped)
      expect(await nameOf(), `March republished on run ${run + 1}`).toBe(before)
    }

    clearLoadCacheMemo()
    const full = await loadCache()
    expect(Object.keys(full.providers['claude']!.files).sort())
      .toEqual(['/live/apr.jsonl', '/live/jun.jsonl', '/live/mar.jsonl'])
  })

  it('merges rather than replaces when a re-parse lands in an unloaded month', async () => {
    await seedThreeMonths()
    clearLoadCacheMemo()
    const scoped = await loadCache(juneScope)
    // A March session that was never loaded is re-parsed (its mtime moved) and
    // written straight back into the March bucket.
    scoped.providers['claude']!.files['/live/mar.jsonl'] = cachedFile({ turns: [turnAt('2026-03-10T10:00:00Z', 'z')], mcpInventory: ['reparsed'] })
    markCacheDirty(scoped, 'claude', '/live/mar.jsonl')
    await saveCache(scoped)

    clearLoadCacheMemo()
    const full = await loadCache()
    expect(full.providers['claude']!.files['/live/mar.jsonl']!.mcpInventory).toEqual(['reparsed'])
    expect(Object.keys(full.providers['claude']!.files).sort())
      .toEqual(['/live/apr.jsonl', '/live/jun.jsonl', '/live/mar.jsonl'])
  })

  it('CODEBURN_CACHE_SCOPE=all reads every month and memoizes as unscoped', async () => {
    await seedThreeMonths()
    clearLoadCacheMemo()
    const unscoped = await loadCache()

    clearLoadCacheMemo()
    process.env['CODEBURN_CACHE_SCOPE'] = 'all'
    try {
      const forced = await loadCache(juneScope)
      expect(forced).toEqual(unscoped)
      // Memoized as a full load, so a resident serve reuses it for any range.
      delete process.env['CODEBURN_CACHE_SCOPE']
      expect(await loadCache(juneScope)).toBe(forced)
    } finally {
      delete process.env['CODEBURN_CACHE_SCOPE']
    }
  })

  it('never scopes a provider whose fingerprint moved, or a durable one', async () => {
    const cache: SessionCache = {
      version: CACHE_VERSION,
      complete: true,
      providers: {
        claude: { envFingerprint: 'stale-fp', files: { '/live/mar.jsonl': fileSpanning('2026-03-10T10:00:00Z') } },
        copilot: { envFingerprint: computeEnvFingerprint('copilot'), durable: true, files: { '/live/otel.db': fileSpanning('2026-03-10T10:00:00Z') } },
      },
    }
    markCacheDirty(cache, 'claude')
    markCacheDirty(cache, 'copilot')
    await saveCache(cache)

    clearLoadCacheMemo()
    const scoped = await loadCache(juneScope)
    // Both would be skipped on month alone; both are read in full anyway, so the
    // fingerprint reset and the durable orphan carry-forward see every entry.
    expect(scoped.providers['claude']!.files['/live/mar.jsonl']).toBeDefined()
    expect(scoped.providers['copilot']!.files['/live/otel.db']).toBeDefined()
  })
})

describe('v8 -> v9 migration', () => {
  it('re-buckets the v8 provider shards losslessly and retires the v8 directory', async () => {
    const v8Dir = join(TMP_DIR, 'session-cache.v8')
    await mkdir(v8Dir, { recursive: true })
    const section = {
      envFingerprint: 'claude-fp',
      files: {
        '/live/mar.jsonl': fileSpanning('2026-03-10T10:00:00Z'),
        '/live/jun.jsonl': fileSpanning('2026-06-10T10:00:00Z'),
        '/gone/pruned.jsonl': cachedFile({ prLinks: ['https://github.com/o/r/pull/1'] }),
      },
    }
    await writeFile(join(v8Dir, 'claude.abc.json'), JSON.stringify(section))
    await writeFile(join(v8Dir, 'envelope.json'), JSON.stringify({
      version: 8, complete: true, nonce: 'n', shards: { claude: 'claude.abc.json' },
    }))

    const loaded = await loadCache()
    expect(loaded.providers['claude']).toEqual(section)
    expect(loaded.complete).toBe(true)
    expect(existsSync(v8Dir)).toBe(false)
    expect(Object.keys((await envelope()).providers['claude']!.shards).sort()).toEqual(['2026-03', '2026-05', '2026-06'])

    clearLoadCacheMemo()
    expect(await loadCache()).toEqual(loaded)
  })
})

// Several providers emit turns in a non-chronological order (cursor composers by
// ROWID, goose / crush / copilot by a DESC ordering). Reading the span off
// turns[0]/turns[-1] then gives `until < bucket` — an empty span, unreachable at
// every scope.
describe('out-of-order turns', () => {
  const outOfOrder = () => cachedFile({ turns: [turnAt('2026-08-10T10:00:00Z', 'a'), turnAt('2026-03-04T10:00:00Z', 'b')] })

  it('spans oldest to newest whatever order the turns arrive in', () => {
    const span = cacheFileSpan(outOfOrder())
    expect(span).toEqual({ bucket: '2026-03', until: '2026-08' })
    expect(cacheBucketMonth(outOfOrder())).toBe('2026-03')
  })

  it('stays reachable at the scope of either end', async () => {
    const cache: SessionCache = {
      version: CACHE_VERSION,
      complete: true,
      providers: { claude: { envFingerprint: computeEnvFingerprint('claude'), files: { '/live/desc.jsonl': outOfOrder() } } },
    }
    markCacheDirty(cache, 'claude')
    await saveCache(cache)
    expect((await envelope()).providers['claude']!.shards['2026-03']!.until).toBe('2026-08')

    for (const [from, to] of [['2026-03-01', '2026-03-31'], ['2026-08-01', '2026-08-31']] as const) {
      clearLoadCacheMemo()
      const scoped = await loadCache(monthScopeForRange(new Date(`${from}T00:00:00Z`), new Date(`${to}T23:59:59Z`)))
      expect(scoped.providers['claude']!.files['/live/desc.jsonl'], `unreachable at ${from}`).toBeDefined()
    }
  })
})

// A path must never end up in two shards at once: on a later load the two copies
// race and the stale one can win, and nothing sweeps it because the envelope
// names both.
describe('re-bucketing out of an unloaded month', () => {
  const juneScope = monthScopeForRange(new Date('2026-06-01T00:00:00Z'), new Date('2026-06-30T23:59:59Z'))

  async function seed(): Promise<void> {
    const cache: SessionCache = {
      version: CACHE_VERSION,
      complete: true,
      providers: {
        claude: {
          envFingerprint: computeEnvFingerprint('claude'),
          files: {
            '/live/moving.jsonl': fileSpanning('2026-01-10T10:00:00Z'),
            '/live/stay.jsonl': fileSpanning('2026-01-11T10:00:00Z'),
            '/live/jun.jsonl': fileSpanning('2026-06-10T10:00:00Z'),
          },
        },
      },
    }
    markCacheDirty(cache, 'claude')
    await saveCache(cache)
  }

  /** Every shard's view of `path`, so a duplicate is visible directly. */
  async function copiesOf(path: string): Promise<string[]> {
    const dir = sessionCacheDir()
    const found: string[] = []
    for (const [bucket, ref] of Object.entries((await envelope()).providers['claude']!.shards)) {
      const files = JSON.parse(await readFile(join(dir, ref.name), 'utf-8'))
      if (files[path]) found.push(bucket)
    }
    return found.sort()
  }

  it('(a) drops the old copy when a re-parse moves the file to another month', async () => {
    await seed()
    clearLoadCacheMemo()
    const scoped = await loadCache(juneScope)
    expect(scoped.providers['claude']!.files['/live/moving.jsonl']).toBeUndefined()
    // Re-parsed from byte 0 after a rewrite: its oldest turn is now in May.
    scoped.providers['claude']!.files['/live/moving.jsonl'] = cachedFile({ turns: [turnAt('2026-05-02T10:00:00Z', 'new')], mcpInventory: ['reparsed'] })
    markCacheDirty(scoped, 'claude', '/live/moving.jsonl')
    await saveCache(scoped)

    expect(await copiesOf('/live/moving.jsonl')).toEqual(['2026-05'])
    clearLoadCacheMemo()
    const full = await loadCache()
    expect(full.providers['claude']!.files['/live/moving.jsonl']!.mcpInventory).toEqual(['reparsed'])
    expect(full.providers['claude']!.files['/live/stay.jsonl']).toBeDefined()
  })

  it('(b) drops the old copy when a parse failure leaves a turn-less marker', async () => {
    await seed()
    clearLoadCacheMemo()
    const scoped = await loadCache(juneScope)
    // The #441 path: the file threw, so only a failure marker is cached.
    scoped.providers['claude']!.files['/live/moving.jsonl'] = { fingerprint: { dev: 1, ino: 2, mtimeMs: 9, sizeBytes: 4 }, mcpInventory: [], turns: [], failed: true }
    markCacheDirty(scoped, 'claude', '/live/moving.jsonl')
    await saveCache(scoped)

    expect(await copiesOf('/live/moving.jsonl')).toEqual(['0000-00'])
    clearLoadCacheMemo()
    const full = await loadCache()
    expect(full.providers['claude']!.files['/live/moving.jsonl']!.failed).toBe(true)
    expect(full.providers['claude']!.files['/live/stay.jsonl']).toBeDefined()
  })

  it('resolves a duplicate to the freshest copy and prunes it on the next save', async () => {
    await seed()
    // Forge the split state directly: the same path in two shards.
    const dir = sessionCacheDir()
    const env = await envelope()
    const janName = env.providers['claude']!.shards['2026-01']!.name
    const junName = env.providers['claude']!.shards['2026-06']!.name
    const jun = JSON.parse(await readFile(join(dir, junName), 'utf-8'))
    jun['/live/moving.jsonl'] = cachedFile({ turns: [turnAt('2026-06-02T10:00:00Z', 'fresh')], fingerprint: { dev: 1, ino: 2, mtimeMs: 999, sizeBytes: 4 }, mcpInventory: ['fresh'] })
    await writeFile(join(dir, junName), JSON.stringify(jun))

    clearLoadCacheMemo()
    const full = await loadCache()
    // Newest fingerprint wins, whichever shard finished reading first.
    expect(full.providers['claude']!.files['/live/moving.jsonl']!.mcpInventory).toEqual(['fresh'])
    await saveCache(full)
    expect(await copiesOf('/live/moving.jsonl')).toEqual(['2026-06'])
    expect(existsSync(join(dir, janName))).toBe(false)
  })
})

describe('carried months under a concurrent writer', () => {
  it('adopts the current shard rather than dropping an orphan-bearing month', async () => {
    const orphan = cachedFile({ turns: [turnAt('2026-03-10T10:00:00Z', 'm')], prLinks: ['https://github.com/o/r/pull/1'] })
    const initial: SessionCache = {
      version: CACHE_VERSION,
      complete: true,
      providers: {
        claude: {
          envFingerprint: computeEnvFingerprint('claude'),
          files: { '/gone/mar.jsonl': orphan, '/live/jun.jsonl': fileSpanning('2026-06-10T10:00:00Z') },
        },
      },
    }
    markCacheDirty(initial, 'claude')
    await saveCache(initial)

    // Process B loads June-scoped: March is carried, by the name it saw.
    clearLoadCacheMemo()
    const b = await loadCache(monthScopeForRange(new Date('2026-06-01T00:00:00Z'), new Date('2026-06-30T23:59:59Z')))

    // Process A independently republishes March, retiring the file B remembers.
    clearLoadCacheMemo()
    const a = await loadCache(monthScopeForRange(new Date('2026-03-01T00:00:00Z'), new Date('2026-03-31T23:59:59Z')))
    a.providers['claude']!.files['/gone/mar2.jsonl'] = cachedFile({ turns: [turnAt('2026-03-12T10:00:00Z', 'n')], prLinks: ['https://github.com/o/r/pull/2'] })
    markCacheDirty(a, 'claude', '/gone/mar2.jsonl')
    await saveCache(a)

    // B saves its own unrelated June change.
    b.providers['claude']!.files['/live/jun2.jsonl'] = fileSpanning('2026-06-20T10:00:00Z')
    markCacheDirty(b, 'claude', '/live/jun2.jsonl')
    await saveCache(b)

    clearLoadCacheMemo()
    const final = await loadCache()
    // March survived under A's name, with both orphans; June has both files.
    expect(Object.keys(final.providers['claude']!.files).sort())
      .toEqual(['/gone/mar.jsonl', '/gone/mar2.jsonl', '/live/jun.jsonl', '/live/jun2.jsonl'])
    for (const ref of Object.values((await envelope()).providers['claude']!.shards)) {
      expect(existsSync(join(sessionCacheDir(), ref.name))).toBe(true)
    }
  })

  // Two saves merging into the SAME unloaded month are a read-modify-write with
  // no lock between them. In the product they are serialised by the warm refresh
  // lock; this covers what survives when they are not. The optimistic retry in
  // saveCache narrows the window to the envelope publish, and a loser's entries
  // are re-derived by the next parse (the reconcile finds no cache entry and
  // re-reads the file) rather than being lost for good.
  it('two scoped saves merging into the same unloaded month keep the envelope sound', async () => {
    const base: SessionCache = {
      version: CACHE_VERSION,
      complete: true,
      providers: {
        claude: {
          envFingerprint: computeEnvFingerprint('claude'),
          files: { '/live/mar.jsonl': fileSpanning('2026-03-10T10:00:00Z'), '/live/jun.jsonl': fileSpanning('2026-06-10T10:00:00Z') },
        },
      },
    }
    markCacheDirty(base, 'claude')
    await saveCache(base)
    const juneScope = monthScopeForRange(new Date('2026-06-01T00:00:00Z'), new Date('2026-06-30T23:59:59Z'))

    clearLoadCacheMemo()
    const p1 = await loadCache(juneScope)
    clearLoadCacheMemo()
    const p2 = await loadCache(juneScope)
    // Both re-parse a different March session neither of them loaded.
    p1.providers['claude']!.files['/live/mar-a.jsonl'] = fileSpanning('2026-03-20T10:00:00Z')
    markCacheDirty(p1, 'claude', '/live/mar-a.jsonl')
    p2.providers['claude']!.files['/live/mar-b.jsonl'] = fileSpanning('2026-03-21T10:00:00Z')
    markCacheDirty(p2, 'claude', '/live/mar-b.jsonl')
    await Promise.allSettled([saveCache(p1), saveCache(p2)])

    clearLoadCacheMemo()
    const final = await loadCache()
    // The envelope is internally consistent and the pre-existing March session
    // survived; a read-modify-write loser is re-derived by the next parse.
    for (const ref of Object.values((await envelope()).providers['claude']!.shards)) {
      expect(existsSync(join(sessionCacheDir(), ref.name))).toBe(true)
    }
    expect(final.providers['claude']!.files['/live/mar.jsonl']).toBeDefined()
    expect(final.providers['claude']!.files['/live/jun.jsonl']).toBeDefined()
    const landed = ['/live/mar-a.jsonl', '/live/mar-b.jsonl'].filter(p => final.providers['claude']!.files[p])
    expect(landed.length).toBeGreaterThanOrEqual(1)
  })
})

describe('retiring an orphaned prior layout', () => {
  it('sweeps a v8 directory and a v7 file left behind by an interrupted re-layout', async () => {
    await saveCache({ version: CACHE_VERSION, complete: true, providers: {
      claude: { envFingerprint: 'fp', files: { '/a.jsonl': fileSpanning('2026-05-10T10:00:00Z') } },
    } })
    const v8Dir = join(TMP_DIR, 'session-cache.v8')
    await mkdir(v8Dir, { recursive: true })
    await writeFile(join(v8Dir, 'envelope.json'), JSON.stringify({ version: 8, nonce: 'n', shards: {} }))
    await writeFile(join(v8Dir, 'claude.abc.json'), '{}')
    const v7 = join(TMP_DIR, 'session-cache.v7.json')
    await writeFile(v7, '{}')

    // Fresh: an in-flight write by an older binary must be left alone.
    await cleanupOrphanedTempFiles()
    expect(existsSync(v8Dir)).toBe(true)
    expect(existsSync(v7)).toBe(true)

    const old = new Date(Date.now() - 90 * 60 * 1000)
    await utimes(join(v8Dir, 'envelope.json'), old, old)
    await utimes(v7, old, old)
    await cleanupOrphanedTempFiles()
    expect(existsSync(v8Dir)).toBe(false)
    expect(existsSync(v7)).toBe(false)
  })
})

// Envelope fingerprint index (#1034): a scoped load classifies out-of-range
// files `unchanged` without reading those shards' turn bodies. The index is an
// additive v9 envelope field — old envelopes omit it and still load.
describe('scoped-load fingerprints', () => {
  async function seedThreeMonths(): Promise<void> {
    const cache: SessionCache = {
      version: CACHE_VERSION,
      complete: true,
      providers: {
        claude: {
          envFingerprint: computeEnvFingerprint('claude'),
          files: {
            '/live/mar.jsonl': fileSpanning('2026-03-10T10:00:00Z'),
            '/live/apr.jsonl': fileSpanning('2026-04-10T10:00:00Z'),
            '/live/jun.jsonl': fileSpanning('2026-06-10T10:00:00Z'),
          },
        },
      },
    }
    markCacheDirty(cache, 'claude')
    await saveCache(cache)
  }

  const juneScope = monthScopeForRange(new Date('2026-06-01T00:00:00Z'), new Date('2026-06-30T23:59:59Z'))

  async function backfillSkippedIndex(): Promise<void> {
    clearLoadCacheMemo()
    const scoped = await loadCache(juneScope)
    markCacheDirty(scoped, 'claude')
    await saveCache(scoped)
  }

  type EnvelopeShape = {
    providers: Record<string, {
      shards: Record<string, { name: string; until: string }>
      index?: Record<string, { fingerprint: { dev: number; ino: number; mtimeMs: number; sizeBytes: number }; lastCompleteLineOffset?: number; bucket: string }>
    }>
  }

  async function readEnvelopeJson(): Promise<EnvelopeShape> {
    return JSON.parse(await readFile(join(sessionCacheDir(), 'envelope.json'), 'utf-8')) as EnvelopeShape
  }

  it('full save omits the fingerprint index', async () => {
    await seedThreeMonths()
    const index = (await readEnvelopeJson()).providers['claude']!.index
    expect(index).toBeUndefined()
  })

  it('scoped save indexes only skipped buckets, not in-memory files', async () => {
    await seedThreeMonths()
    await backfillSkippedIndex()
    const index = (await readEnvelopeJson()).providers['claude']!.index
    expect(Object.keys(index ?? {}).sort()).toEqual(['/live/apr.jsonl', '/live/mar.jsonl'])
    expect(index!['/live/mar.jsonl']!.bucket).toBe('2026-03')
    expect(index!['/live/mar.jsonl']!.fingerprint).toEqual({ dev: 1, ino: 2, mtimeMs: 3, sizeBytes: 4 })
    expect(index!['/live/mar.jsonl']!.lastCompleteLineOffset).toBeUndefined()
    expect(index!['/live/jun.jsonl']).toBeUndefined()
  })

  it('scoped load keeps skipped files out of section.files but visible to reconcile', async () => {
    await seedThreeMonths()
    await backfillSkippedIndex()
    clearLoadCacheMemo()
    const scoped = await loadCache(juneScope)
    expect(Object.keys(scoped.providers['claude']!.files)).toEqual(['/live/jun.jsonl'])
    expect(isIndexOnly(scoped, 'claude', '/live/mar.jsonl')).toBe(true)
    expect(isIndexOnly(scoped, 'claude', '/live/jun.jsonl')).toBe(false)

    const stub = lookupCachedFile(scoped, 'claude', '/live/mar.jsonl')
    expect(stub?.turns).toEqual([])
    expect(stub?.fingerprint).toEqual({ dev: 1, ino: 2, mtimeMs: 3, sizeBytes: 4 })
    expect(reconcileIndexedFile(stub!.fingerprint, stub, true)).toEqual({ action: 'unchanged' })
    // Installing that stub into section.files would re-bucket it to 0000-00.
    expect(scoped.providers['claude']!.files['/live/mar.jsonl']).toBeUndefined()
  })

  it('a pre-#1034 envelope (no index) still loads; skipped files look uncached', async () => {
    await seedThreeMonths()
    const env = await readEnvelopeJson()
    for (const meta of Object.values(env.providers)) delete meta.index
    await writeFile(join(sessionCacheDir(), 'envelope.json'), JSON.stringify({
      version: CACHE_VERSION, complete: true, nonce: 'old', providers: env.providers,
    }))
    clearLoadCacheMemo()
    const scoped = await loadCache(juneScope)
    expect(Object.keys(scoped.providers['claude']!.files)).toEqual(['/live/jun.jsonl'])
    expect(lookupCachedFile(scoped, 'claude', '/live/mar.jsonl')).toBeUndefined()
    expect(isIndexOnly(scoped, 'claude', '/live/mar.jsonl')).toBe(false)
  })

  it('scoped save of a pre-#1034 envelope backfills the index from carried shards', async () => {
    await seedThreeMonths()
    const env = await readEnvelopeJson()
    for (const meta of Object.values(env.providers)) delete meta.index
    await writeFile(join(sessionCacheDir(), 'envelope.json'), JSON.stringify({
      version: CACHE_VERSION, complete: true, nonce: 'old', providers: env.providers,
    }))
    clearLoadCacheMemo()
    const scoped = await loadCache(juneScope)
    scoped.providers['claude']!.files['/live/jun2.jsonl'] = fileSpanning('2026-06-20T10:00:00Z')
    markCacheDirty(scoped, 'claude', '/live/jun2.jsonl')
    await saveCache(scoped)

    const index = (await readEnvelopeJson()).providers['claude']!.index
    expect(Object.keys(index ?? {}).sort()).toEqual([
      '/live/apr.jsonl', '/live/mar.jsonl',
    ])
    expect(index!['/live/mar.jsonl']!.bucket).toBe('2026-03')
    expect(index!['/live/jun.jsonl']).toBeUndefined()
    expect(index!['/live/jun2.jsonl']).toBeUndefined()

    clearLoadCacheMemo()
    const next = await loadCache(juneScope)
    expect(isIndexOnly(next, 'claude', '/live/mar.jsonl')).toBe(true)
    expect(next.providers['claude']!.files['/live/mar.jsonl']).toBeUndefined()
  })

  it('scoped save never writes an empty-turn stub into a skipped shard', async () => {
    await seedThreeMonths()
    await backfillSkippedIndex()
    clearLoadCacheMemo()
    const scoped = await loadCache(juneScope)
    // Reconcile would see March as unchanged; a buggy install would put the
    // stub in section.files and the save would prune the real March body.
    expect(isIndexOnly(scoped, 'claude', '/live/mar.jsonl')).toBe(true)
    scoped.providers['claude']!.files['/live/jun2.jsonl'] = fileSpanning('2026-06-20T10:00:00Z')
    markCacheDirty(scoped, 'claude', '/live/jun2.jsonl')
    await saveCache(scoped)

    clearLoadCacheMemo()
    const full = await loadCache()
    expect(full.providers['claude']!.files['/live/mar.jsonl']!.turns.length).toBeGreaterThan(0)
    expect(full.providers['claude']!.files['/live/mar.jsonl']!.turns[0]!.timestamp).toBe('2026-03-10T10:00:00Z')
  })

  it('two writers: a scoped save does not drop another provider\'s index entries', async () => {
    const cache: SessionCache = {
      version: CACHE_VERSION,
      complete: true,
      providers: {
        claude: {
          envFingerprint: computeEnvFingerprint('claude'),
          files: {
            '/live/mar.jsonl': fileSpanning('2026-03-10T10:00:00Z'),
            '/live/jun.jsonl': fileSpanning('2026-06-10T10:00:00Z'),
          },
        },
        codex: {
          envFingerprint: computeEnvFingerprint('codex'),
          files: { '/live/r.jsonl': fileSpanning('2026-03-10T10:00:00Z') },
        },
      },
    }
    markCacheDirty(cache, 'claude')
    markCacheDirty(cache, 'codex')
    await saveCache(cache)

    clearLoadCacheMemo()
    const b = await loadCache(juneScope)
    clearLoadCacheMemo()
    const a = await loadCache(juneScope)
    a.providers['claude']!.files['/live/jun2.jsonl'] = fileSpanning('2026-06-20T10:00:00Z')
    markCacheDirty(a, 'claude', '/live/jun2.jsonl')
    await saveCache(a)

    b.providers['codex']!.files['/live/r2.jsonl'] = fileSpanning('2026-06-20T10:00:00Z')
    markCacheDirty(b, 'codex', '/live/r2.jsonl')
    await saveCache(b)

    const env = await readEnvelopeJson()
    expect(env.providers['claude']!.index!['/live/mar.jsonl']!.bucket).toBe('2026-03')
    expect(env.providers['codex']!.index!['/live/r.jsonl']!.bucket).toBe('2026-03')
    expect(env.providers['claude']!.index!['/live/jun.jsonl']).toBeUndefined()
    expect(env.providers['codex']!.index!['/live/r2.jsonl']).toBeUndefined()

    clearLoadCacheMemo()
    const full = await loadCache()
    expect(full.providers['claude']!.files['/live/mar.jsonl']).toBeDefined()
    expect(full.providers['codex']!.files['/live/r.jsonl']).toBeDefined()
    expect(full.providers['codex']!.files['/live/r2.jsonl']).toBeDefined()
  })

  it('stale scoped writer rebuilds skipped index after a concurrent full save omitted it', async () => {
    const cache: SessionCache = {
      version: CACHE_VERSION,
      complete: true,
      providers: {
        claude: {
          envFingerprint: computeEnvFingerprint('claude'),
          files: {
            '/claude/mar.jsonl': fileSpanning('2026-03-10T10:00:00Z'),
            '/claude/jun.jsonl': fileSpanning('2026-06-10T10:00:00Z'),
          },
        },
        codex: {
          envFingerprint: computeEnvFingerprint('codex'),
          files: {
            '/codex/mar-a.jsonl': fileSpanning('2026-03-10T10:00:00Z'),
            '/codex/jun.jsonl': fileSpanning('2026-06-10T10:00:00Z'),
          },
        },
      },
    }
    markCacheDirty(cache, 'claude')
    markCacheDirty(cache, 'codex')
    await saveCache(cache)
    clearLoadCacheMemo()
    const indexSeed = await loadCache(juneScope)
    markCacheDirty(indexSeed, 'claude')
    markCacheDirty(indexSeed, 'codex')
    await saveCache(indexSeed)

    clearLoadCacheMemo()
    const staleScoped = await loadCache(juneScope)

    clearLoadCacheMemo()
    const fullWriter = await loadCache()
    fullWriter.providers['codex']!.files['/codex/mar-b.jsonl'] = fileSpanning('2026-03-20T10:00:00Z')
    markCacheDirty(fullWriter, 'codex', '/codex/mar-b.jsonl')
    await saveCache(fullWriter)
    expect((await readEnvelopeJson()).providers['codex']!.index).toBeUndefined()

    staleScoped.providers['claude']!.files['/claude/jun2.jsonl'] = fileSpanning('2026-06-20T10:00:00Z')
    markCacheDirty(staleScoped, 'claude', '/claude/jun2.jsonl')
    await saveCache(staleScoped)

    const env = await readEnvelopeJson()
    expect(Object.keys(env.providers['codex']!.index ?? {}).sort()).toEqual([
      '/codex/mar-a.jsonl', '/codex/mar-b.jsonl',
    ])
    expect(env.providers['codex']!.index!['/codex/jun.jsonl']).toBeUndefined()
    expect(env.providers['claude']!.index!['/claude/mar.jsonl']!.bucket).toBe('2026-03')
    expect(env.providers['claude']!.index!['/claude/jun.jsonl']).toBeUndefined()

    clearLoadCacheMemo()
    const nextJune = await loadCache(juneScope)
    expect(isIndexOnly(nextJune, 'codex', '/codex/mar-a.jsonl')).toBe(true)
    expect(isIndexOnly(nextJune, 'codex', '/codex/mar-b.jsonl')).toBe(true)
    expect(isIndexOnly(nextJune, 'codex', '/codex/jun.jsonl')).toBe(false)
  })

  it('does not treat a loaded-but-unreadable shard as index-only', async () => {
    await seedThreeMonths()
    await backfillSkippedIndex()
    const env = await readEnvelopeJson()
    const march = env.providers['claude']!.shards['2026-03']!.name
    await writeFile(join(sessionCacheDir(), march), '{"/x":{"turns":')
    clearLoadCacheMemo()
    const marchScope = monthScopeForRange(new Date('2026-03-01T00:00:00Z'), new Date('2026-03-31T23:59:59Z'))
    const scoped = await loadCache(marchScope)
    expect(scoped.providers['claude']!.files['/live/mar.jsonl']).toBeUndefined()
    expect(isIndexOnly(scoped, 'claude', '/live/mar.jsonl')).toBe(false)
    expect(lookupCachedFile(scoped, 'claude', '/live/mar.jsonl')).toBeUndefined()
  })

  it('does not trust an index entry whose bucket the envelope no longer names', async () => {
    await seedThreeMonths()
    await backfillSkippedIndex()
    const env = await readEnvelopeJson()
    delete env.providers['claude']!.shards['2026-03']
    await writeFile(join(sessionCacheDir(), 'envelope.json'), JSON.stringify({
      version: CACHE_VERSION, complete: true, nonce: 'unnamed', providers: env.providers,
    }))
    clearLoadCacheMemo()
    const scoped = await loadCache(juneScope)
    expect(isIndexOnly(scoped, 'claude', '/live/mar.jsonl')).toBe(false)
    expect(lookupCachedFile(scoped, 'claude', '/live/mar.jsonl')).toBeUndefined()
  })

  it('a full load ignores the index even when it names skipped-looking paths', async () => {
    await seedThreeMonths()
    clearLoadCacheMemo()
    const full = await loadCache()
    expect(isIndexOnly(full, 'claude', '/live/mar.jsonl')).toBe(false)
    expect(full.providers['claude']!.files['/live/mar.jsonl']).toBeDefined()
    expect(lookupCachedFile(full, 'claude', '/live/mar.jsonl')?.turns.length).toBeGreaterThan(0)
  })

  it('prunes the prior shard when an index-only file re-buckets into a loaded month', async () => {
    await seedThreeMonths()
    await backfillSkippedIndex()
    clearLoadCacheMemo()
    const scoped = await loadCache(juneScope)
    expect(isIndexOnly(scoped, 'claude', '/live/mar.jsonl')).toBe(true)
    scoped.providers['claude']!.files['/live/mar.jsonl'] = fileSpanning('2026-06-15T10:00:00Z')
    markCacheDirty(scoped, 'claude', '/live/mar.jsonl')
    await saveCache(scoped)

    const env = await readEnvelopeJson()
    expect(env.providers['claude']!.index!['/live/mar.jsonl']).toBeUndefined()
    const marchRef = env.providers['claude']!.shards['2026-03']
    if (marchRef) {
      const marchFiles = JSON.parse(await readFile(join(sessionCacheDir(), marchRef.name), 'utf-8')) as Record<string, unknown>
      expect(marchFiles['/live/mar.jsonl']).toBeUndefined()
    }

    clearLoadCacheMemo()
    const full = await loadCache()
    expect(full.providers['claude']!.files['/live/mar.jsonl']!.turns[0]!.timestamp).toBe('2026-06-15T10:00:00Z')
    expect(full.providers['claude']!.files['/live/mar.jsonl']!.turns.some(t => t.timestamp.startsWith('2026-03'))).toBe(false)
    expect(env.providers['claude']!.shards['2026-06']).toBeDefined()
  })

  it('pre-#1034 backfill indexes every sibling in a carried shard', async () => {
    const cache: SessionCache = {
      version: CACHE_VERSION,
      complete: true,
      providers: {
        claude: {
          envFingerprint: computeEnvFingerprint('claude'),
          files: {
            '/live/mar-a.jsonl': fileSpanning('2026-03-10T10:00:00Z'),
            '/live/mar-b.jsonl': fileSpanning('2026-03-20T10:00:00Z'),
            '/live/jun.jsonl': fileSpanning('2026-06-10T10:00:00Z'),
          },
        },
      },
    }
    markCacheDirty(cache, 'claude')
    await saveCache(cache)
    const env = await readEnvelopeJson()
    for (const meta of Object.values(env.providers)) delete meta.index
    await writeFile(join(sessionCacheDir(), 'envelope.json'), JSON.stringify({
      version: CACHE_VERSION, complete: true, nonce: 'old', providers: env.providers,
    }))
    clearLoadCacheMemo()
    const scoped = await loadCache(juneScope)
    scoped.providers['claude']!.files['/live/mar-a.jsonl'] = fileSpanning('2026-03-10T10:00:00Z')
    scoped.providers['claude']!.files['/live/jun2.jsonl'] = fileSpanning('2026-06-20T10:00:00Z')
    markCacheDirty(scoped, 'claude', '/live/jun2.jsonl')
    await saveCache(scoped)

    const index = (await readEnvelopeJson()).providers['claude']!.index
    expect(Object.keys(index ?? {}).sort()).toEqual([
      '/live/mar-b.jsonl',
    ])
    expect(index!['/live/mar-b.jsonl']!.bucket).toBe('2026-03')
    expect(index!['/live/mar-a.jsonl']).toBeUndefined()
    expect(index!['/live/jun.jsonl']).toBeUndefined()
  })
})
