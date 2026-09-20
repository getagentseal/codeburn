// Bounded codex result-cache loads (OOM fix, second half): the 227MB
// codex-results file must stream-decode with range filtering like session
// shards do, instead of whole-file JSON.parse on every lookup. Entries whose
// file predates the range AND whose calls all predate it are dropped (their
// files are mtime-floor-skipped before any lookup); everything else is kept
// WHOLE — codex entries are never call-projected, so an exact hit yields all
// calls with keys exactly as today (pinned below).
//
// Flush merges dirty overlay entries over the published bytes (streaming,
// bounded) instead of rewriting from memory; project labels come from a small
// streaming index so discovery never loads the calls map.
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  __setAfterDetachForTests,
  clearCodexMemCaches,
  codexCacheFileName,
  fingerprintFile,
  flushCodexCache,
  readCachedCodexResults,
  getCachedCodexProject,
  retainCodexEntry,
  loadCacheFilteredFromDisk,
  scanRetainedCodexKeys,
  streamCodexEntryMetadata,
  writeCachedCodexResults,
  CODEX_CACHE_VERSION,
} from '../src/codex-cache.js'
import { __setAfterStreamOpenForTests } from '../src/shard-stream.js'

const originalCacheDir = process.env['CODEBURN_CACHE_DIR']
let root: string

function codexCall(key: string, timestamp: string): ParsedProviderCall {
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
    timestamp,
    speed: 'standard',
    deduplicationKey: `codex:${key}`,
    userMessage: '',
    sessionId: key,
  }
}

const DAY_START = new Date('2026-07-15T00:00:00Z').getTime()

async function backdate(path: string, ms: number): Promise<void> {
  const at = new Date(ms)
  await utimes(path, at, at)
}

async function seedSource(name: string, content: string, mtimeMs?: number): Promise<string> {
  const path = join(root, name)
  await writeFile(path, content)
  if (mtimeMs !== undefined) await backdate(path, mtimeMs)
  return path
}

async function seedResults(entries: Record<string, unknown>): Promise<string> {
  const cachePath = join(root, codexCacheFileName())
  await writeFile(cachePath, JSON.stringify({ version: CODEX_CACHE_VERSION, files: entries }))
  return cachePath
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codeburn-codex-range-'))
  process.env['CODEBURN_CACHE_DIR'] = root
  clearCodexMemCaches()
})

afterEach(async () => {
  if (originalCacheDir === undefined) delete process.env['CODEBURN_CACHE_DIR']
  else process.env['CODEBURN_CACHE_DIR'] = originalCacheDir
  clearCodexMemCaches()
  await rm(root, { recursive: true, force: true })
})

describe('bounded codex decode', () => {
  it('drops out-of-range entries under a range but keeps them on full loads', async () => {
    const oldPath = await seedSource('old.jsonl', '{}\n', new Date('2026-06-10T10:00:00Z').getTime())
    const newPath = await seedSource('new.jsonl', '{}\n')
    const oldFp = (await fingerprintFile(oldPath))!
    const newFp = (await fingerprintFile(newPath))!
    await seedResults({
      [oldPath]: {
        dev: oldFp.dev, ino: oldFp.ino, mtimeMs: oldFp.mtimeMs, sizeBytes: oldFp.sizeBytes,
        project: 'old-proj', calls: [codexCall('old-1', '2026-06-10T10:00:00.000Z')],
      },
      [newPath]: {
        dev: newFp.dev, ino: newFp.ino, mtimeMs: newFp.mtimeMs, sizeBytes: newFp.sizeBytes,
        project: 'new-proj', calls: [codexCall('new-1', '2026-07-15T10:00:00.000Z')],
      },
    })

    // Full load serves both (status quo ante).
    expect((await readCachedCodexResults(oldPath))?.kind).toBe('exact')
    clearCodexMemCaches()

    // Ranged load drops the old entry: genuine miss, not an error.
    expect(await readCachedCodexResults(oldPath, { rangeStartMs: DAY_START })).toBeNull()
    // ...while the in-range entry still hits exactly.
    const hit = await readCachedCodexResults(newPath, { rangeStartMs: DAY_START })
    expect(hit?.kind).toBe('exact')
  })

  it('keeps resume-capable entries and serves resume tails under a range', async () => {
    const sourcePath = await seedSource('roll.jsonl', 'line1\n')
    const fp = (await fingerprintFile(sourcePath))!
    await seedResults({
      [sourcePath]: {
        dev: fp.dev, ino: fp.ino, mtimeMs: fp.mtimeMs, sizeBytes: fp.sizeBytes,
        project: 'p', calls: [codexCall('c1', '2026-07-15T10:00:00.000Z')],
        resumeOffset: 6, resumeState: { sessionId: 's' }, resumeCallCount: 1,
      },
    })
    // Grow the file: exact misses, resume must still hit under a range.
    await writeFile(sourcePath, 'line1\nline2\n')
    const hit = await readCachedCodexResults(sourcePath, { rangeStartMs: DAY_START })
    expect(hit?.kind).toBe('resume')
    if (hit && hit.kind === 'resume') {
      expect(hit.offset).toBe(6)
      expect(hit.callCount).toBe(1)
    }
  })

  it('exact hits yield every call with keys, including out-of-range ones (no call projection)', async () => {
    // A kept entry (mtime in range) serves its WHOLE call list: filtering is
    // whole-entry only. If entries were ever call-projected, the June call's
    // key would vanish and cross-file suppression would silently change.
    const sourcePath = await seedSource('mixed.jsonl', '{}\n')
    const fp = (await fingerprintFile(sourcePath))!
    await seedResults({
      [sourcePath]: {
        dev: fp.dev, ino: fp.ino, mtimeMs: fp.mtimeMs, sizeBytes: fp.sizeBytes,
        project: 'p',
        calls: [codexCall('june-1', '2026-06-10T10:00:00.000Z'), codexCall('july-1', '2026-07-15T10:00:00.000Z')],
      },
    })
    const hit = await readCachedCodexResults(sourcePath, { rangeStartMs: DAY_START })
    expect(hit?.kind).toBe('exact')
    const keys = hit && 'calls' in hit ? hit.calls.map(c => c.deduplicationKey) : []
    expect(keys).toEqual(['codex:june-1', 'codex:july-1'])
  })

  it('isolates sequential and concurrent loads by range identity', async () => {
    const oldPath = await seedSource('o.jsonl', '{}\n', new Date('2026-06-10T10:00:00Z').getTime())
    const newPath = await seedSource('n.jsonl', '{}\n')
    const oldFp = (await fingerprintFile(oldPath))!
    const newFp = (await fingerprintFile(newPath))!
    await seedResults({
      [oldPath]: {
        dev: oldFp.dev, ino: oldFp.ino, mtimeMs: oldFp.mtimeMs, sizeBytes: oldFp.sizeBytes,
        project: 'o', calls: [codexCall('o1', '2026-06-10T10:00:00.000Z')],
      },
      [newPath]: {
        dev: newFp.dev, ino: newFp.ino, mtimeMs: newFp.mtimeMs, sizeBytes: newFp.sizeBytes,
        project: 'n', calls: [codexCall('n1', '2026-07-15T10:00:00.000Z')],
      },
    })
    const juneStart = new Date('2026-06-01T00:00:00Z').getTime()
    // Sequential: each range sees its own slice after the other ran.
    expect(await readCachedCodexResults(oldPath, { rangeStartMs: DAY_START })).toBeNull()
    expect((await readCachedCodexResults(oldPath, { rangeStartMs: juneStart }))?.kind).toBe('exact')
    expect((await readCachedCodexResults(newPath, { rangeStartMs: DAY_START }))?.kind).toBe('exact')
    // Concurrent: neither projection leaks into the other.
    const [a, b] = await Promise.all([
      readCachedCodexResults(oldPath, { rangeStartMs: DAY_START }),
      readCachedCodexResults(newPath, { rangeStartMs: DAY_START }),
    ])
    expect(a).toBeNull()
    expect(b?.kind).toBe('exact')
  })
})

describe('codex flush merge', () => {
  it('substitutes dirty entries, carries dropped ones, prunes evicted', async () => {
    const keepPath = await seedSource('keep.jsonl', '{}\n', new Date('2026-06-10T10:00:00Z').getTime())
    const dropPath = await seedSource('drop.jsonl', '{}\n')
    await rm(dropPath)
    const keepFp = (await fingerprintFile(keepPath))!
    await seedResults({
      [keepPath]: {
        dev: keepFp.dev, ino: keepFp.ino, mtimeMs: keepFp.mtimeMs, sizeBytes: keepFp.sizeBytes,
        project: 'k', calls: [codexCall('k1', '2026-06-10T10:00:00.000Z')],
      },
      [dropPath]: {
        dev: 1, ino: 2, mtimeMs: 3, sizeBytes: 4,
        project: 'd', calls: [codexCall('d1', '2026-06-10T10:00:00.000Z')],
      },
    })
    // Ranged load drops the June entry from memory; write a fresh one.
    expect(await readCachedCodexResults(keepPath, { rangeStartMs: DAY_START })).toBeNull()
    const freshPath = await seedSource('fresh.jsonl', '{}\n')
    const freshFp = (await fingerprintFile(freshPath))!
    await writeCachedCodexResults(freshPath, 'f', [codexCall('f1', '2026-07-15T10:00:00.000Z')], {
      dev: freshFp.dev, ino: freshFp.ino, mtimeMs: freshFp.mtimeMs, sizeBytes: freshFp.sizeBytes,
    })
    await flushCodexCache()

    // Published bytes: dropped June entry carried verbatim, evicted pruned,
    // fresh entry present — all without ever materializing the file.
    const published = JSON.parse(await readFile(join(root, codexCacheFileName()), 'utf-8'))
    expect(Object.keys(published.files).sort()).toEqual([freshPath, keepPath].sort())
    expect(published.files[keepPath].calls.map((c: { deduplicationKey: string }) => c.deduplicationKey)).toEqual(['codex:k1'])
    expect(published.files[freshPath].project).toBe('f')
  })

  it('write then flush then read observes the publish without a manual clear', async () => {
    const sourcePath = await seedSource('w.jsonl', '{}\n')
    const fp = (await fingerprintFile(sourcePath))!
    await writeCachedCodexResults(sourcePath, 'w', [codexCall('w1', '2026-07-15T10:00:00.000Z')], {
      dev: fp.dev, ino: fp.ino, mtimeMs: fp.mtimeMs, sizeBytes: fp.sizeBytes,
    })
    await flushCodexCache()
    // No clearCodexMemCaches between flush and read: the read must observe
    // the published entry (via overlay/folded snapshots), not a stale miss.
    const hit = await readCachedCodexResults(sourcePath, { rangeStartMs: DAY_START })
    expect(hit?.kind).toBe('exact')
  })

  it('adopts a foreign-version file forward on flush', async () => {
    // v14 on disk (old binary era): a write + flush must establish the v15
    // file with the fresh entry, never deadlock waiting for v15 bytes.
    const sourcePath = await seedSource('v14.jsonl', '{}\n')
    const fp = (await fingerprintFile(sourcePath))!
    await writeFile(join(root, codexCacheFileName()), JSON.stringify({
      version: CODEX_CACHE_VERSION - 1,
      files: {
        [sourcePath]: {
          dev: fp.dev, ino: fp.ino, mtimeMs: fp.mtimeMs, sizeBytes: fp.sizeBytes,
          project: 'legacy', calls: [codexCall('legacy-1', '2026-06-10T10:00:00.000Z')],
        },
      },
    }))
    await writeCachedCodexResults(sourcePath, 'fresh', [codexCall('fresh-1', '2026-07-15T10:00:00.000Z')], {
      dev: fp.dev, ino: fp.ino, mtimeMs: fp.mtimeMs, sizeBytes: fp.sizeBytes,
    })
    await flushCodexCache()
    clearCodexMemCaches()
    const hit = await readCachedCodexResults(sourcePath)
    expect(hit?.kind).toBe('exact')
    const published = JSON.parse(await readFile(join(root, codexCacheFileName()), 'utf-8'))
    expect(published.version).toBe(CODEX_CACHE_VERSION)
  })
})

describe('codex project index', () => {
  it('serves discovery labels without loading the calls map', async () => {
    const sourcePath = await seedSource('idx.jsonl', '{}\n', new Date('2026-06-10T10:00:00Z').getTime())
    const fp = (await fingerprintFile(sourcePath))!
    await seedResults({
      [sourcePath]: {
        dev: fp.dev, ino: fp.ino, mtimeMs: fp.mtimeMs, sizeBytes: fp.sizeBytes,
        project: 'indexed-proj', calls: [codexCall('i1', '2026-06-10T10:00:00.000Z')],
      },
    })
    // Label served (fp-matched) even though a ranged load would drop the entry.
    expect(await getCachedCodexProject(sourcePath)).toBe('indexed-proj')
    // Stale fingerprint: no label (mirrors the full-map freshness contract).
    await backdate(sourcePath, Date.now())
    expect(await getCachedCodexProject(sourcePath)).toBeNull()
  })

  it('streams metadata without calls even when the path contains dots', async () => {
    // The token-level skip matches the exact stack [path, 'calls'] below the
    // pick re-root: a filename containing ".calls" must not confuse it, and
    // the calls array must never materialize (that is the discovery OOM).
    const sourcePath = await seedSource('weird.calls.v1.jsonl', '{}\n')
    const fp = (await fingerprintFile(sourcePath))!
    const calls = Array.from({ length: 2000 }, (_, i) => codexCall(`bulk-${i}`, '2026-07-15T10:00:00.000Z'))
    await seedResults({
      [sourcePath]: {
        dev: fp.dev, ino: fp.ino, mtimeMs: fp.mtimeMs, sizeBytes: fp.sizeBytes,
        project: 'dotted-proj', calls,
      },
    })
    const seen = new Map<string, unknown>()
    await streamCodexEntryMetadata(join(root, codexCacheFileName()), (key, value) => {
      seen.set(key, value)
    })
    expect(seen.has(sourcePath)).toBe(true)
    const meta = seen.get(sourcePath) as Record<string, unknown>
    expect(meta).not.toHaveProperty('calls')
    expect(meta['project']).toBe('dotted-proj')
    expect(meta['mtimeMs']).toBe(fp.mtimeMs)
    // Labels still served from the metadata-only build.
    expect(await getCachedCodexProject(sourcePath)).toBe('dotted-proj')
  })
})

describe('codex two-pass range load', () => {
  const JUNE = '2026-06-10T10:00:00.000Z'
  const JULY = '2026-07-15T10:00:00.000Z'
  const JUNE_MS = new Date(JUNE).getTime()

  function nastyEntries(): Record<string, unknown> {
    const monster = Array.from({ length: 20000 }, (_, i) => codexCall(`bulk-${i}`, JUNE))
    return {
      // Kept: file mtime in range (calls never inspected).
      'keep-mtime': { mtimeMs: DAY_START + 3600_000, project: 'p', calls: [codexCall('old-1', JUNE)] },
      // Kept: one in-range call keeps the whole entry (with keys intact).
      'keep-call': { mtimeMs: JUNE_MS, project: 'p', calls: [codexCall('c-old', JUNE), codexCall('c-new', JULY)] },
      // Dropped: old file, every call valid and pre-range.
      'drop-clean': { mtimeMs: JUNE_MS, project: 'p', calls: [codexCall('d1', JUNE), codexCall('d2', JUNE)] },
      // Dropped: the boundedness proof — 20k pre-range calls never assemble.
      'drop-monster': { mtimeMs: JUNE_MS, project: 'p', calls: monster },
      // Dropped: dotted key exercises exact-stack matching, not substrings.
      'weird.calls.jsonl': { mtimeMs: JUNE_MS, project: 'p', calls: [codexCall('w1', JUNE)] },
      // Dropped: missing mtimeMs, pre-range calls.
      'drop-no-mtime': { project: 'p', calls: [codexCall('n1', JUNE)] },
      // Dropped: string mtimeMs is not a number, pre-range calls.
      'drop-str-mtime': { mtimeMs: JUNE, project: 'p', calls: [codexCall('s1', JUNE)] },
      // Kept: every unjudgeable shape the full load would carry.
      'keep-empty-calls': { mtimeMs: JUNE_MS, project: 'p', calls: [] },
      'keep-no-calls': { mtimeMs: JUNE_MS, project: 'p' },
      'keep-calls-object': { mtimeMs: JUNE_MS, project: 'p', calls: {} },
      'keep-junk-calls': {
        mtimeMs: JUNE_MS,
        project: 'p',
        calls: [null, 5, { nope: 1 }, { timestamp: 123 }, { timestamp: 'bogus' }, codexCall('j1', JUNE)],
      },
      'keep-bare': {},
    }
  }

  it('scans a real v15 envelope without fallback and matches the retain rule exactly', async () => {
    const entries = nastyEntries()
    await seedResults(entries)
    // Throws if the walker rejects the envelope (e.g. the version scalar):
    // that failure would silently route every load through full assembly.
    const scanned = await scanRetainedCodexKeys(join(root, codexCacheFileName()), DAY_START)
    const oracle = new Set(Object.entries(entries).filter(([, v]) => retainCodexEntry(v, DAY_START)).map(([k]) => k))
    expect(scanned).toEqual(oracle)
    expect(scanned.has('drop-monster')).toBe(false)
    expect(scanned.has('weird.calls.jsonl')).toBe(false)
    expect(scanned.has('keep-call')).toBe(true)
  })
  it('loads exactly the scanned keys, kept entries whole', async () => {
    const entries = nastyEntries()
    await seedResults(entries)
    const loaded = await loadCacheFilteredFromDisk(root, DAY_START)
    const oracle = new Set(Object.entries(entries).filter(([, v]) => retainCodexEntry(v, DAY_START)).map(([k]) => k))
    expect(new Set(Object.keys(loaded.files))).toEqual(oracle)
    // Kept entries arrive whole: every call with keys, no projection.
    const keepCall = loaded.files['keep-call'] as { calls: { deduplicationKey: string }[] }
    expect(keepCall.calls.map(c => c.deduplicationKey)).toEqual(['codex:c-old', 'codex:c-new'])
    expect(loaded.files['keep-junk-calls']).toEqual(entries['keep-junk-calls'])
    expect(loaded.files['keep-bare']).toEqual({})
  })

  it('serializes overlapping flushes without losing a batch', async () => {
    const aPath = await seedSource('a.jsonl', '{}\n')
    const bPath = await seedSource('b.jsonl', '{}\n')
    const aFp = (await fingerprintFile(aPath))!
    const bFp = (await fingerprintFile(bPath))!
    await writeCachedCodexResults(aPath, 'a', [codexCall('a1', '2026-07-15T10:00:00.000Z')], {
      dev: aFp.dev, ino: aFp.ino, mtimeMs: aFp.mtimeMs, sizeBytes: aFp.sizeBytes,
    })
    // Overlapping flushes: the second must wait for the first and publish
    // over its output, not race it on the same base bytes. The detach
    // barrier (not a timer or pump count) proves the first flush detached
    // before the second write lands.
    let releaseFirst!: () => void
    const firstDetached = new Promise<void>(resolve => {
      __setAfterDetachForTests(async () => {
        resolve()
        await new Promise<void>(r => { releaseFirst = r })
      })
    })
    try {
      const first = flushCodexCache()
      await firstDetached
      // Disarm: only the first flush may park here; the second must run free.
      __setAfterDetachForTests(null)
      await writeCachedCodexResults(bPath, 'b', [codexCall('b1', '2026-07-15T10:00:00.000Z')], {
        dev: bFp.dev, ino: bFp.ino, mtimeMs: bFp.mtimeMs, sizeBytes: bFp.sizeBytes,
      })
      const second = flushCodexCache()
      releaseFirst()
      await Promise.all([first, second])
    } finally {
      __setAfterDetachForTests(null)
    }
    clearCodexMemCaches()
    const published = JSON.parse(await readFile(join(root, codexCacheFileName()), 'utf-8'))
    expect(Object.keys(published.files).sort()).toEqual([aPath, bPath].sort())
  })

  it('a load spanning a flush returns post-flush data', async () => {
    // keepme lives ONLY on disk (never overlaid) so the lookup below must
    // decode it; big ballast (40k pre-range calls) keeps that decode in
    // flight while the publish lands. Unlinking forces a fast adopt-forward
    // publish (milliseconds) mid-decode (hundreds of ms). The stream-open
    // rendezvous (not pump counts) proves the load holds pre-unlink bytes
    // before anything is unlinked.
    const juneMs = new Date('2026-06-10T10:00:00Z').getTime()
    const bigPath = await seedSource('big.jsonl', '{}\n', juneMs)
    const bigFp = (await fingerprintFile(bigPath))!
    const keepPath = await seedSource('keepme.jsonl', '{}\n')
    const keepFp = (await fingerprintFile(keepPath))!
    const bulk = Array.from({ length: 40000 }, (_, i) => codexCall(`bulk-${i}`, '2026-06-10T10:00:00.000Z'))
    const cachePath = join(root, codexCacheFileName())
    await seedResults({
      [bigPath]: {
        dev: bigFp.dev, ino: bigFp.ino, mtimeMs: bigFp.mtimeMs, sizeBytes: bigFp.sizeBytes,
        project: 'big', calls: bulk,
      },
      [keepPath]: {
        dev: keepFp.dev, ino: keepFp.ino, mtimeMs: keepFp.mtimeMs, sizeBytes: keepFp.sizeBytes,
        project: 'keep', calls: [codexCall('v1', '2026-07-15T10:00:00.000Z')],
      },
    })
    let opened!: () => void
    const streamOpened = new Promise<void>(resolve => { opened = resolve })
    __setAfterStreamOpenForTests(() => opened())
    const load = readCachedCodexResults(keepPath, { rangeStartMs: DAY_START })
    try {
      await streamOpened
      await writeCachedCodexResults(keepPath, 'keep', [codexCall('v2', '2026-07-15T10:00:00.000Z')], {
        dev: keepFp.dev, ino: keepFp.ino, mtimeMs: keepFp.mtimeMs, sizeBytes: keepFp.sizeBytes,
      })
      await rm(cachePath)
      await flushCodexCache()
    } finally {
      __setAfterStreamOpenForTests(null)
    }
    const hit = await load
    // Post-flush data: the generation change forced a redecode on the new
    // bytes (never a stale memo: the flush invalidated snapshots too).
    expect(hit?.kind).toBe('exact')
    if (hit && hit.kind === 'exact') {
      expect(hit.calls.map(c => c.deduplicationKey)).toEqual(['codex:v2'])
    }
  })
})
