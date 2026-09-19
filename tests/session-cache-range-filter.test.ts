// Range-filtered shard loads (OOM fix): a ranged query must be able to decode
// month shards WITHOUT retaining every turn. Out-of-range turns are dropped at
// decode time; their dedup keys are kept for pre-seeding, and every scalar the
// save/evict/orphan paths read is carried on the record, so a filtered load
// can never serialize back as a truncated authoritative shard.
//
// The query range here is deliberately ONE DAY inside a month shard (July 15
// within July): same-month July 1/14/16/31 turns must be discarded while July
// 15 and midnight-straddling turns remain. A month-wide filter would pass
// while `overview -p today` still retained the whole September shard.
//
// Parity proof fixtures (projection applies only when exact; otherwise the
// whole record is kept unflagged):
// - same key in a kept AND a dropped turn of one file -> whole file (a flat
//   key bag cannot preserve intra-file walk order);
// - PR-linked files stay whole (the anchor logic reads spawn sets across the
//   full turn list);
// - kept turns must form ONE contiguous block in file order (carry state is
//   positional; covers append-only suffixes and newest-first prefixes);
// - cross-file suppression relies on file-open-ordered seeding (pinned by the
//   ordering unit test); the serve loops must seed when they open each file.
//
// These tests pin the feature BEFORE the implementation is complete: the
// `opts` argument to loadCache is ignored until then, so the filtering
// assertions fail (red) while the guard assertions already pass.
// Not-yet-existing exports are reached by static namespace import plus an
// existence assertion, so a missing export fails its own test instead of
// the suite.
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  CACHE_VERSION,
  clearLoadCacheMemo,
  clearShardMemo,
  computeEnvFingerprint,
  loadCache,
  loadShardFiltered,
  markCacheDirty,
  monthScopeForRange,
  reconcileFile,
  saveCache,
  seedDroppedKeys,
  sessionCacheDir,
  type CachedFile,
  type SessionCache,
} from '../src/session-cache.js'
import * as parserModule from '../src/parser.js'
import {
  clearCodexMemCaches,
  codexCacheFileName,
  fingerprintFile,
  readCachedCodexResults,
} from '../src/codex-cache.js'
import type { ParsedProviderCall } from '../src/providers/types.js'

let TMP_DIR: string

beforeEach(async () => {
  TMP_DIR = join(tmpdir(), `codeburn-rangefilter-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  process.env['CODEBURN_CACHE_DIR'] = TMP_DIR
  await mkdir(TMP_DIR, { recursive: true })
  clearLoadCacheMemo()
  clearShardMemo()
  clearCodexMemCaches()
})

afterEach(async () => {
  clearCodexMemCaches()
  if (existsSync(TMP_DIR)) await rm(TMP_DIR, { recursive: true })
})

type Turn = CachedFile['turns'][number]

function callAt(timestamp: string, key: string): Turn['calls'][number] {
  return {
    provider: 'omp',
    model: 'm',
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      cacheCreationOneHourTokens: 0,
    },
    speed: 'standard',
    timestamp,
    tools: [],
    bashCommands: [],
    skills: [],
    subagentTypes: [],
    deduplicationKey: key,
  }
}

function turnAt(timestamp: string, key: string, extraCalls: Array<{ timestamp: string; key: string }> = []): Turn {
  return {
    timestamp,
    sessionId: 'sess-1',
    userMessage: 'do the thing',
    calls: [callAt(timestamp, key), ...extraCalls.map(e => callAt(e.timestamp, e.key))],
  }
}

function cachedFile(overrides: Partial<CachedFile> = {}): CachedFile {
  return {
    fingerprint: { dev: 1, ino: 2, mtimeMs: 3, sizeBytes: 4 },
    lastCompleteLineOffset: 128,
    mcpInventory: [],
    turns: [turnAt('2026-07-15T10:00:00Z', 'day15-1')],
    ...overrides,
  }
}

// The query under test: ONE day. The scope stays month-wide (that is the
// production shape: monthScopeForRange over a today range selects the current
// month shard), so same-month turns outside the day must still be discarded.
const DAY = { start: new Date('2026-07-15T00:00:00Z'), end: new Date('2026-07-15T23:59:59.999Z') }

// Local copy of the keep-predicate semantics (any call timestamp in range).
// The implementation must behave identically to turnSlicedToRange's null rule;
// a parity test below pins the real export against this oracle.
function keepDay(turn: Turn): boolean {
  return turn.calls.some(c => {
    const ts = new Date(c.timestamp).getTime()
    return !Number.isNaN(ts) && ts >= DAY.start.getTime() && ts <= DAY.end.getTime()
  })
}

async function seedJulyCorpus(): Promise<Record<string, CachedFile>> {
  const files: Record<string, CachedFile> = {
    '/live/june.jsonl': cachedFile({ turns: [turnAt('2026-06-10T10:00:00Z', 'june-1')] }),
    '/live/span.jsonl': cachedFile({
      // Dropped June prefix carries branch + PR state into the kept straddle;
      // the straddling turn is kept WHOLE (all calls), never call-trimmed.
      turns: [
        { ...turnAt('2026-06-20T10:00:00Z', 'juneb-1'), gitBranch: 'main', prRefs: ['https://github.com/o/r/pull/1'] },
        {
          ...turnAt('2026-07-14T23:59:00Z', 'span-14', [{ timestamp: '2026-07-15T00:01:00Z', key: 'span-15' }]),
          userMessage: 'long night 😀日本語',
        },
        turnAt('2026-07-14T10:00:00Z', 'july14-only'),
      ],
    }),
    '/live/july.jsonl': cachedFile({
      // Same-month decoys around the query day: only day15-1 survives.
      turns: [
        turnAt('2026-07-01T10:00:00Z', 'july1-1'),
        turnAt('2026-07-15T10:00:00Z', 'day15-1'),
        turnAt('2026-07-16T10:00:00Z', 'july16-1'),
        turnAt('2026-07-31T10:00:00Z', 'july31-1'),
      ],
    }),
    // PR-linked files stay whole: the anchor logic reads spawn sets across
    // the full turn list, which a slice cannot reproduce.
    '/live/pr.jsonl': cachedFile({
      prLinks: ['https://github.com/o/r/pull/9'],
      turns: [turnAt('2026-06-11T10:00:00Z', 'pr-june'), turnAt('2026-07-16T10:00:00Z', 'pr-july')],
    }),
    // Same key on both sides of the boundary: the whole file stays whole, so
    // no retained turn is ever suppressed differently than the full walk.
    '/live/dup.jsonl': cachedFile({
      turns: [turnAt('2026-07-15T10:00:00Z', 'shared-x'), turnAt('2026-07-20T10:00:00Z', 'shared-x')],
    }),
    // Interleaved kept/dropped/kept: carry state would be positional
    // guesswork, so the whole file stays whole.
    '/live/noncontig.jsonl': cachedFile({
      turns: [
        turnAt('2026-07-15T08:00:00Z', 'nc-1'),
        turnAt('2026-07-16T08:00:00Z', 'nc-drop'),
        turnAt('2026-07-15T18:00:00Z', 'nc-2'),
      ],
    }),
  }
  const cache: SessionCache = {
    version: CACHE_VERSION,
    complete: true,
    providers: { omp: { envFingerprint: computeEnvFingerprint('omp'), files } },
  }
  markCacheDirty(cache, 'omp')
  await saveCache(cache)
  clearLoadCacheMemo()
  clearShardMemo()
  return files
}

function julyMonthScope() {
  return monthScopeForRange(new Date('2026-07-15T00:00:00Z'), new Date('2026-07-15T23:59:59.999Z'))
}

describe('range-filtered shard load', () => {
  it('keeps whole intersecting turns and drops the rest with keys collected', async () => {
    await seedJulyCorpus()
    const loaded = await loadCache(julyMonthScope(), { turnFilter: keepDay })
    const files = loaded.providers['omp']!.files

    // June-only file: no turns retained, keys + scalars carried.
    expect(files['/live/june.jsonl']!.turns).toEqual([])
    expect(files['/live/june.jsonl']!.rangeFiltered?.droppedKeys).toEqual(['june-1'])
    expect(files['/live/june.jsonl']!.fingerprint).toEqual({ dev: 1, ino: 2, mtimeMs: 3, sizeBytes: 4 })

    // Span file: prefix carry captured, straddling turn kept WHOLE (both
    // calls), July-14-only dropped.
    const span = files['/live/span.jsonl']!
    expect(span.turns.map(t => t.calls.map(c => c.deduplicationKey))).toEqual([['span-14', 'span-15']])
    expect(span.rangeFiltered?.droppedKeys).toEqual(['juneb-1', 'july14-only'])
    expect(span.rangeFiltered?.carryBranch).toBe('main')
    expect(span.rangeFiltered?.carryPrRefs).toEqual(['https://github.com/o/r/pull/1'])
    expect(span.rangeFiltered?.droppedHadBranch).toBe(true)

    // July file: same-month decoys dropped in walk order, query day kept.
    const july = files['/live/july.jsonl']!
    expect(july.turns.map(t => t.calls.map(c => c.deduplicationKey))).toEqual([['day15-1']])
    expect(july.rangeFiltered?.droppedKeys).toEqual(['july1-1', 'july16-1', 'july31-1'])
  })

  it('keeps PR-linked, key-overlap and interleaved files whole', async () => {
    await seedJulyCorpus()
    const loaded = await loadCache(julyMonthScope(), { turnFilter: keepDay })
    const files = loaded.providers['omp']!.files
    for (const path of ['/live/pr.jsonl', '/live/dup.jsonl', '/live/noncontig.jsonl']) {
      expect(files[path]!.rangeFiltered).toBeUndefined()
    }
    expect(files['/live/pr.jsonl']!.turns).toHaveLength(2)
    expect(files['/live/dup.jsonl']!.turns.map(t => t.calls.map(c => c.deduplicationKey))).toEqual([['shared-x'], ['shared-x']])
    expect(files['/live/noncontig.jsonl']!.turns).toHaveLength(3)
  })

  it('matches turnSlicedToRange null-rule exactly, including straddles', async () => {
    const parserExports = parserModule as unknown as {
      turnIntersectsRange?: (turn: Turn, range: { start: Date; end: Date }) => boolean
    }
    expect(typeof parserExports.turnIntersectsRange).toBe('function')
    const intersects = parserExports.turnIntersectsRange!
    const cases: Array<[Turn, boolean]> = [
      [turnAt('2026-07-15T10:00:00Z', 'a'), true],
      [turnAt('2026-07-16T10:00:00Z', 'b'), false],
      [turnAt('2026-07-01T10:00:00Z', 'c'), false],
      // Straddling turn: one call each side — kept (serve trims calls itself).
      [turnAt('2026-07-14T23:59:00Z', 'd', [{ timestamp: '2026-07-15T00:01:00Z', key: 'e' }]), true],
      // Unparseable timestamps never intersect.
      [{ ...turnAt('2026-07-15T10:00:00Z', 'f'), calls: [{ ...callAt('not-a-date', 'f') }] }, false],
      // Empty call list intersects nothing.
      [{ ...turnAt('2026-07-15T10:00:00Z', 'g'), calls: [] }, false],
    ]
    for (const [turn, expected] of cases) {
      expect(intersects(turn, DAY)).toBe(expected)
      expect(keepDay(turn)).toBe(expected)
    }
  })

  it('seeds dropped keys in file-open walk order (cross-file suppression contract)', async () => {
    const fileA = cachedFile({
      turns: [],
      rangeFiltered: {
        span: { bucket: '2026-07', until: '2026-07' },
        newestCallMs: 1,
        droppedKeys: ['shared-x'],
      },
    })
    const fileB = cachedFile({ turns: [turnAt('2026-07-15T10:00:00Z', 'shared-x')] })
    // Walk order A then B (the serve loops must seed when they open each
    // file): B's kept turn suppresses exactly as the full walk would, where
    // A's out-of-range turn would have added the key at A's position.
    const seen = new Set<string>()
    seedDroppedKeys(seen, fileA)
    const suppressed = fileB.turns[0]!.calls.some(c => seen.has(c.deduplicationKey))
    expect(suppressed).toBe(true)
    // Reversed: B first counts (nothing seeded yet) — order is load-bearing.
    const seen2 = new Set<string>()
    const counted = !fileB.turns[0]!.calls.some(c => seen2.has(c.deduplicationKey))
    expect(counted).toBe(true)
  })

  it('leaves full loads untouched (no flags, complete turns)', async () => {
    await seedJulyCorpus()
    const loaded = await loadCache(julyMonthScope())
    for (const file of Object.values(loaded.providers['omp']!.files)) {
      expect(file.rangeFiltered).toBeUndefined()
    }
    expect(loaded.providers['omp']!.files['/live/span.jsonl']!.turns).toHaveLength(3)
  })

  it('does not let a filtered load poison a later full load (memo hygiene)', async () => {
    await seedJulyCorpus()
    await loadCache(julyMonthScope(), { turnFilter: keepDay })
    const full = await loadCache(julyMonthScope())
    expect(full.providers['omp']!.files['/live/june.jsonl']!.turns).toHaveLength(1)
    expect(full.providers['omp']!.files['/live/june.jsonl']!.rangeFiltered).toBeUndefined()
  })

  it('isolates concurrent filtered loads by range (no shared mutable projection)', async () => {
    await seedJulyCorpus()
    const june = { start: new Date('2026-06-01T00:00:00Z'), end: new Date('2026-06-30T23:59:59.999Z') }
    const keepJune = (turn: Turn): boolean => turn.calls.some(c => {
      const ts = new Date(c.timestamp).getTime()
      return !Number.isNaN(ts) && ts >= june.start.getTime() && ts <= june.end.getTime()
    })
    const [dayLoad, juneLoad] = await Promise.all([
      loadCache(julyMonthScope(), { turnFilter: keepDay }),
      loadCache(monthScopeForRange(new Date('2026-06-01T00:00:00Z'), new Date('2026-06-30T23:59:59.999Z')), { turnFilter: keepJune }),
    ])
    expect(dayLoad.providers['omp']!.files['/live/july.jsonl']!.turns.map(t => t.calls.map(c => c.deduplicationKey))).toEqual([['day15-1']])
    expect(juneLoad.providers['omp']!.files['/live/june.jsonl']!.turns).toHaveLength(1)
    expect(juneLoad.providers['omp']!.files['/live/july.jsonl']).toBeUndefined()
  })

  it('loads mismatch sections whole under a ranged query instead of projecting them', async () => {
    // A parse-version bump changes the fingerprint; the section is discarded
    // at parse time, but the load still reads it in full (never scoped, never
    // projected) so the fingerprint reset and orphan carry-forward see every
    // entry. Projecting a section the parse is about to discard would save
    // nothing and would hide orphaned paths from the reset.
    const cache: SessionCache = {
      version: CACHE_VERSION,
      complete: true,
      providers: {
        omp: {
          envFingerprint: 'stale-fingerprint',
          files: { '/live/july.jsonl': cachedFile({ turns: [turnAt('2026-07-15T10:00:00Z', 'x')] }) },
        },
      },
    }
    markCacheDirty(cache, 'omp')
    await saveCache(cache)
    clearLoadCacheMemo()
    clearShardMemo()
    const loaded = await loadCache(julyMonthScope(), { turnFilter: keepDay })
    expect(loaded.providers['omp']).toBeDefined()
    const file = loaded.providers['omp']!.files['/live/july.jsonl']!
    expect(file.turns.map(t => t.calls.map(c => c.deduplicationKey))).toEqual([['x']])
    expect(file.rangeFiltered).toBeUndefined()
  })

  it('retires old-only paths on mismatch save instead of merging them forward', async () => {
    // Seed with a stale fingerprint, then simulate what the parse does on a
    // reset (see getOrCreateProviderSection): replace the section with fresh
    // records under the current fingerprint and save. The old shard must be
    // retired and its paths gone — never merged into the reset, never reused.
    const cache: SessionCache = {
      version: CACHE_VERSION,
      complete: true,
      providers: {
        omp: {
          envFingerprint: 'stale-fingerprint',
          files: { '/live/old.jsonl': cachedFile({ turns: [turnAt('2026-07-15T10:00:00Z', 'old-1')] }) },
        },
      },
    }
    markCacheDirty(cache, 'omp')
    await saveCache(cache)
    clearLoadCacheMemo()
    clearShardMemo()
    const before = (await readdir(sessionCacheDir())).filter(n => n.startsWith('omp.')).sort()
    expect(before.length).toBeGreaterThan(0)

    const loaded = await loadCache(julyMonthScope(), { turnFilter: keepDay })
    // Mismatched sections load whole (see above); the parse replacement below
    // is what discards them, and the save retires the old shards.
    expect(Object.keys(loaded.providers['omp']!.files)).toEqual(['/live/old.jsonl'])
    // Parse replacement: fresh section under the current fingerprint.
    loaded.providers['omp'] = {
      envFingerprint: computeEnvFingerprint('omp'),
      files: { '/live/new.jsonl': cachedFile({ turns: [turnAt('2026-07-15T10:00:00Z', 'new-1')] }) },
    }
    markCacheDirty(loaded, 'omp')
    expect(await saveCache(loaded)).toBe(true)

    clearLoadCacheMemo()
    clearShardMemo()
    const reloaded = await loadCache()
    expect(Object.keys(reloaded.providers['omp']!.files).sort()).toEqual(['/live/new.jsonl'])
    const after = (await readdir(sessionCacheDir())).filter(n => n.startsWith('omp.')).sort()
    for (const name of before) expect(after).not.toContain(name)
  })
})

describe('reconcile forces full re-parse on flagged change (blocker: no append onto a slice)', () => {
  it('flagged + changed fingerprint reports modified, never appended', () => {
    const flagged = cachedFile({
      turns: [],
      rangeFiltered: {
        span: { bucket: '2026-07', until: '2026-07' },
        newestCallMs: 1,
        droppedKeys: ['old-1'],
      },
    })
    expect(reconcileFile({ dev: 1, ino: 2, mtimeMs: 3, sizeBytes: 4 }, flagged).action).toBe('unchanged')
    expect(reconcileFile({ dev: 1, ino: 2, mtimeMs: 4, sizeBytes: 4096 }, flagged).action).toBe('modified')
    const full = cachedFile()
    expect(reconcileFile({ dev: 1, ino: 2, mtimeMs: 4, sizeBytes: 4096 }, full).action).not.toBe('unchanged')
  })
})

describe('filtered save round-trip (blocker: no silent truncation)', () => {
  it('mutate/save one in-range file, full-reload: every out-of-range turn preserved', async () => {
    const original = await seedJulyCorpus()
    const filtered = await loadCache(julyMonthScope(), { turnFilter: keepDay })
    // The filter visibly engaged: fully out-of-range files carry the marker.
    expect(filtered.providers['omp']!.files['/live/june.jsonl']!.rangeFiltered).toBeDefined()

    // Simulate this run re-parsing one in-range file: fresh FULL record.
    const omp = filtered.providers['omp']!
    omp.files['/live/july.jsonl'] = cachedFile({
      fingerprint: { dev: 1, ino: 2, mtimeMs: 999, sizeBytes: 4096 },
      turns: [turnAt('2026-07-15T12:00:00Z', 'day15-fresh')],
    })
    markCacheDirty(filtered, 'omp', '/live/july.jsonl')
    await saveCache(filtered)

    clearLoadCacheMemo()
    clearShardMemo()
    const reloaded = await loadCache()
    const files = reloaded.providers['omp']!.files

    // Untouched files: byte/semantically identical, no filter residue —
    // including same-month decoys, the straddling turn's June call, and the
    // whole-kept PR/dup/noncontig files.
    expect(files['/live/june.jsonl']).toEqual(original['/live/june.jsonl'])
    expect(files['/live/span.jsonl']).toEqual(original['/live/span.jsonl'])
    expect(files['/live/pr.jsonl']).toEqual(original['/live/pr.jsonl'])
    expect(files['/live/dup.jsonl']).toEqual(original['/live/dup.jsonl'])
    expect(files['/live/noncontig.jsonl']).toEqual(original['/live/noncontig.jsonl'])
    expect(files['/live/june.jsonl']!.rangeFiltered).toBeUndefined()
    // Mutated file carries the fresh content.
    expect(files['/live/july.jsonl']!.turns.map(t => t.calls.map(c => c.deduplicationKey))).toEqual([['day15-fresh']])
    // Totals across the corpus: 1 June + 3 span + 1 fresh + 2 PR + 2 dup + 3 noncontig.
    const turnCount = Object.values(files).reduce((n, f) => n + f.turns.length, 0)
    expect(turnCount).toBe(1 + 3 + 1 + 2 + 2 + 3)
  })

  it('streaming merge preserves flagged bytes while substituting dirty records', async () => {
    // Dirty July bucket WITH a flagged file still in it: the save must merge
    // (streaming, bounded) rather than rewrite from memory, and a full reload
    // of the newly published shard must validate every record.
    await seedJulyCorpus()
    const filtered = await loadCache(julyMonthScope(), { turnFilter: keepDay })
    expect(filtered.providers['omp']!.files['/live/july.jsonl']!.rangeFiltered).toBeDefined()

    // Add a large fresh file (multi-megabyte content exercises partial-write
    // safety in the merge writer) and dirty only its path.
    const bigMessage = `merge payload 😀日本語 x `.repeat(200000)
    const omp = filtered.providers['omp']!
    omp.files['/live/july2.jsonl'] = cachedFile({
      fingerprint: { dev: 9, ino: 9, mtimeMs: 999, sizeBytes: 4096 },
      turns: [{ ...turnAt('2026-07-15T12:00:00Z', 'july2-fresh'), userMessage: bigMessage }],
    })
    markCacheDirty(filtered, 'omp', '/live/july2.jsonl')
    await saveCache(filtered)

    clearLoadCacheMemo()
    clearShardMemo()
    const reloaded = await loadCache()
    const files = reloaded.providers['omp']!.files
    // Flagged file's published full turns survived the merge byte-identical.
    expect(files['/live/july.jsonl']!.turns.map(t => t.calls.map(c => c.deduplicationKey))).toEqual([
      ['july1-1'], ['day15-1'], ['july16-1'], ['july31-1'],
    ])
    expect(files['/live/july.jsonl']!.rangeFiltered).toBeUndefined()
    // Fresh multi-megabyte record round-tripped exactly (reload validation).
    expect(files['/live/july2.jsonl']!.turns[0]!.userMessage).toBe(bigMessage)
    expect(files['/live/span.jsonl']!.turns).toHaveLength(3)
  })

  it('missing authority aborts the save instead of publishing a truncation', async () => {
    await seedJulyCorpus()
    const filtered = await loadCache(julyMonthScope(), { turnFilter: keepDay })
    // Dirty the July bucket WITHOUT replacing its flagged file: add a fresh
    // file so the flagged july.jsonl must merge against published bytes.
    const omp = filtered.providers['omp']!
    omp.files['/live/july2.jsonl'] = cachedFile({
      fingerprint: { dev: 9, ino: 9, mtimeMs: 999, sizeBytes: 4096 },
      turns: [turnAt('2026-07-15T12:00:00Z', 'july2-fresh')],
    })
    markCacheDirty(filtered, 'omp', '/live/july2.jsonl')
    // Delete every published July shard: the merge has no authority left.
    const dir = sessionCacheDir()
    const names = (await readdir(dir)).filter(n => n.startsWith('omp.2026-07'))
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) await rm(join(dir, name))
    const envelopeBefore = await readFile(join(dir, 'envelope.json'), 'utf-8')
    const published = await saveCache(filtered)
    expect(published).toBe(false)
    // No truncated envelope went out: the envelope still names the (now
    // unlinked) prior shards, and no replacement shard was published.
    expect(await readFile(join(dir, 'envelope.json'), 'utf-8')).toBe(envelopeBefore)
    expect((await readdir(dir)).filter(n => n.startsWith('omp.2026-07') && !names.includes(n))).toEqual([])
  })

  it('torn shards fail closed: truncation drops the shard, keeps the month', async () => {
    await seedJulyCorpus()
    const dir = sessionCacheDir()
    const names = (await readdir(dir)).filter(n => n.startsWith('omp.2026-07'))
    expect(names.length).toBeGreaterThan(0)
    const shardPath = join(dir, names[0]!)
    const raw = await readFile(shardPath, 'utf-8')
    // Truncate mid-object (valid prefix, cut inside a turn).
    await writeFile(shardPath, raw.slice(0, Math.floor(raw.length / 2)))

    clearLoadCacheMemo()
    clearShardMemo()
    const loaded = await loadCache(julyMonthScope(), { turnFilter: keepDay })
    // Mirrors the existing corrupt-shard path: the torn shard is dropped
    // whole (zero partial entries committed) while the intact June shard
    // still serves (june + span + pr live in June buckets).
    expect(Object.keys(loaded.providers['omp']?.files ?? {}).sort()).toEqual([
      '/live/june.jsonl',
      '/live/pr.jsonl',
      '/live/span.jsonl',
    ])
  })

  it('large multi-byte content decodes identically to JSON.parse', async () => {
    const big = `emoji 😀 CJK 日本語 surrogate pair 𝌆 tail `.repeat(4000)
    const cache: SessionCache = {
      version: CACHE_VERSION,
      complete: true,
      providers: {
        omp: {
          envFingerprint: computeEnvFingerprint('omp'),
          files: { '/live/big.jsonl': cachedFile({ turns: [{ ...turnAt('2026-07-15T10:00:00Z', 'big-1'), userMessage: big }] }) },
        },
      },
    }
    markCacheDirty(cache, 'omp')
    await saveCache(cache)
    clearLoadCacheMemo()
    clearShardMemo()
    const loaded = await loadCache(julyMonthScope(), { turnFilter: keepDay })
    expect(loaded.providers['omp']!.files['/live/big.jsonl']!.turns[0]!.userMessage).toBe(big)
  })
})

describe('codex-results guard (blocker: resume state survives filtered session runs)', () => {
  function codexCall(key: string): ParsedProviderCall {
    return {
      provider: 'codex',
      model: 'm',
      inputTokens: 1,
      outputTokens: 1,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costUSD: 0,
      tools: [],
      bashCommands: [],
      timestamp: '2026-07-15T00:00:00.000Z',
      speed: 'standard',
      deduplicationKey: `codex:${key}`,
      userMessage: '',
      sessionId: key,
    }
  }

  it('leaves the codex result cache byte-identical with exact hits intact', async () => {
    // Real source file so the fingerprint matches and the lookup is genuine
    // (an invented fingerprint misses and proves nothing).
    const sourcePath = join(TMP_DIR, 'rollout.jsonl')
    await writeFile(sourcePath, '{}\n')
    const fp = await fingerprintFile(sourcePath)
    expect(fp).not.toBeNull()
    const cachePath = join(TMP_DIR, codexCacheFileName())
    const entry = {
      dev: fp!.dev,
      ino: fp!.ino,
      mtimeMs: fp!.mtimeMs,
      sizeBytes: fp!.sizeBytes,
      project: 'fixture',
      calls: [codexCall('cx-1')],
      resumeOffset: 3,
      resumeState: { sessionId: 's' },
      resumeCallCount: 1,
    }
    await writeFile(cachePath, JSON.stringify({ version: 15, files: { [sourcePath]: entry } }))
    const before = await readFile(cachePath, 'utf-8')

    // Exact hit works before the session-cache cycle (genuine, fp-matched).
    const hitBefore = await readCachedCodexResults(sourcePath)
    expect(hitBefore?.kind).toBe('exact')
    const callsBefore = hitBefore && 'calls' in hitBefore ? hitBefore.calls.map(c => c.deduplicationKey) : []
    expect(callsBefore).toEqual(['codex:cx-1'])
    clearCodexMemCaches()

    // A filtered session-cache load+save cycle must not touch codex-results.
    await seedJulyCorpus()
    await loadCache(julyMonthScope(), { turnFilter: keepDay })

    expect(await readFile(cachePath, 'utf-8')).toBe(before)
    const st = await stat(sourcePath)
    expect(st.size).toBeGreaterThan(0)
    const hitAfter = await readCachedCodexResults(sourcePath)
    expect(hitAfter?.kind).toBe('exact')
    const callsAfter = hitAfter && 'calls' in hitAfter ? hitAfter.calls.map(c => c.deduplicationKey) : []
    expect(callsAfter).toEqual(['codex:cx-1'])
    // Resume fields round-trip byte-identically (not just the served calls).
    expect(JSON.parse(await readFile(cachePath, 'utf-8')).files[sourcePath]).toEqual(entry)
  })
})

describe('range-filtered load at record scale', () => {
  it('decodes a 30k-turn record per-turn with an exact marker', async () => {
    // The overview-today OOM: one record holds far more turns than the query
    // keeps. The load must stream it (never assemble the whole turns array)
    // and still project exactly: kept suffix, walk-ordered dropped keys,
    // full-list span/newest carried on the marker.
    const dir = sessionCacheDir()
    await mkdir(dir, { recursive: true })
    const turns: Turn[] = []
    for (let i = 0; i < 15000; i++) turns.push(turnAt('2026-06-10T10:00:00Z', `june-${i}`))
    for (let i = 0; i < 14999; i++) turns.push(turnAt('2026-07-01T10:00:00Z', `july1-${i}`))
    turns.push(turnAt('2026-07-15T12:00:00Z', 'kept-1'))
    const name = 'omp.2026-06.scale.json'
    await writeFile(join(dir, name), JSON.stringify({ '/live/big.jsonl': cachedFile({ turns }) }))
    const files = (await loadShardFiltered(dir, name, keepDay))!
    expect(Object.keys(files)).toEqual(['/live/big.jsonl'])
    const file = files['/live/big.jsonl']!
    expect(file.turns.length).toBe(1)
    expect(file.turns[0]!.calls[0]!.deduplicationKey).toBe('kept-1')
    const marker = file.rangeFiltered!
    expect(marker.droppedKeys.length).toBe(29999)
    expect(marker.droppedKeys[0]).toBe('june-0')
    expect(marker.droppedKeys[15000]).toBe('july1-0')
    expect(marker.droppedKeys[29998]).toBe('july1-14998')
    expect(marker.span).toEqual({ bucket: '2026-06', until: '2026-07' })
    expect(marker.newestCallMs).toBe(new Date('2026-07-15T12:00:00Z').getTime())
    expect(marker).not.toHaveProperty('carryBranch')
    expect(marker).not.toHaveProperty('firstTurnProject')
  })
  it('omits carry fields when every turn is dropped', async () => {
    // Old prefix loop ran zero times when firstKept stayed -1: carryBranch
    // and carryPrRefs must be absent (there is no kept block to carry
    // into), while droppedHadBranch still reports the dropped branches.
    const dir = sessionCacheDir()
    await mkdir(dir, { recursive: true })
    const turns: Turn[] = [
      { ...turnAt('2026-06-10T10:00:00Z', 'june-0'), gitBranch: 'main', prRefs: ['x#1'] },
      { ...turnAt('2026-06-11T10:00:00Z', 'june-1'), gitBranch: 'main' },
    ]
    const name = 'omp.2026-06.alldropped.json'
    await writeFile(join(dir, name), JSON.stringify({ '/live/old.jsonl': cachedFile({ turns }) }))
    const files = (await loadShardFiltered(dir, name, keepDay))!
    const file = files['/live/old.jsonl']!
    expect(file.turns).toEqual([])
    const marker = file.rangeFiltered!
    expect(marker.droppedKeys).toEqual(['june-0', 'june-1'])
    expect(marker).not.toHaveProperty('carryBranch')
    expect(marker).not.toHaveProperty('carryPrRefs')
    expect(marker.droppedHadBranch).toBe(true)
  })
  it('leaves all-kept and empty files unmarked', async () => {
    // No marker unless turns were actually dropped: all-kept (and empty)
    // records serve their turns with rangeFiltered undefined.
    const dir = sessionCacheDir()
    await mkdir(dir, { recursive: true })
    const name = 'omp.2026-07.allkept.json'
    await writeFile(join(dir, name), JSON.stringify({
      '/live/kept.jsonl': cachedFile({ turns: [turnAt('2026-07-15T10:00:00Z', 'k-1'), turnAt('2026-07-15T11:00:00Z', 'k-2')] }),
      '/live/empty.jsonl': cachedFile({ turns: [] }),
    }))
    const files = (await loadShardFiltered(dir, name, keepDay))!
    expect(files['/live/kept.jsonl']!.turns.length).toBe(2)
    expect(files['/live/kept.jsonl']!.rangeFiltered).toBeUndefined()
    expect(files['/live/empty.jsonl']!.turns).toEqual([])
    expect(files['/live/empty.jsonl']!.rangeFiltered).toBeUndefined()
  })
})

