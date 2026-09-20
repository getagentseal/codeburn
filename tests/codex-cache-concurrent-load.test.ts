// The codex result cache is a single (often hundreds-of-MB) JSON file. Discovery
// now asks for it from many concurrent callers, so without a shared in-flight
// index build every one of them would stream-decode the whole file.

import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { PassThrough } from 'node:stream'
const streamSpy = vi.hoisted(() => vi.fn())
const streamGate = vi.hoisted(() => ({ hold: false, opened: 0, constructed: 0, releases: [] as Array<() => void> }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    createReadStream: ((path: unknown, ...rest: unknown[]) => {
      streamSpy(path)
      // Deterministic publish-mid-load staging: while the gate holds, open
      // the real stream immediately (its fd pins the pre-flush inode, so the
      // first decode is deterministically stale) but hand the decoder an
      // unpiped PassThrough — no byte flows until the release pipes it.
      // pause()/resume() cannot stage this: pipeline() resumes a paused
      // stream, so the waiter would finish and memoize v0 before the flush.
      // Streams opened after the hold (the flush's own merge read) pass
      if (streamGate.hold && String(path).includes('codex-results')) {
        const gate = new PassThrough()
        streamGate.constructed++
        const real = (actual.createReadStream as (...args: unknown[]) => NodeJS.ReadableStream)(path, ...rest)
        // Signal on 'open', not on construction: only an opened fd pins the
        // pre-flush inode across the flush's rename, making the first decode
        // deterministically stale. (Signalling synchronously here would let
        // the open land post-rename and the test pass vacuously on fresh
        // bytes with no retry exercised.)
        real.once('open', () => {
          streamGate.opened++
          streamGate.releases.push(() => {
            real.pipe(gate)
          })
        })
        return gate
      }
      return (actual.createReadStream as (...args: unknown[]) => unknown)(path, ...rest)
    }) as typeof actual.createReadStream,
  }
})

const { CODEX_CACHE_VERSION, clearCodexMemCaches, codexCacheFileName, flushCodexCache, getCachedCodexProject, readCachedCodexResults, withCodexCacheDirectory, writeCachedCodexResults } =
  await import('../src/codex-cache.js')
import type { ParsedProviderCall } from '../src/providers/types.js'

let cacheDir: string
let sessionDir: string

beforeEach(async () => {
  streamSpy.mockClear()
  clearCodexMemCaches()
  streamGate.hold = false
  streamGate.opened = 0
  streamGate.releases.length = 0
  const root = await mkdtemp(join(tmpdir(), 'codeburn-codex-cache-'))
  cacheDir = join(root, 'cache')
  sessionDir = join(root, 'sessions')
  await mkdir(cacheDir, { recursive: true })
  await mkdir(sessionDir, { recursive: true })
})

afterEach(async () => {
  clearCodexMemCaches()
  await rm(join(cacheDir, '..'), { recursive: true, force: true })
})

describe('codex result cache under concurrent readers', () => {
  it('reads the cache file once and answers every caller correctly', async () => {
    const paths: string[] = []
    const files: Record<string, unknown> = {}
    for (let i = 0; i < 24; i++) {
      const p = join(sessionDir, `rollout-${i}.jsonl`)
      await writeFile(p, '{}\n')
      paths.push(p)
      const { statSync } = await import('fs')
      const s = statSync(p)
      files[p] = { dev: s.dev, ino: s.ino, mtimeMs: s.mtimeMs, sizeBytes: s.size, project: `proj-${i}`, calls: [] }
    }
    await writeFile(join(cacheDir, codexCacheFileName()), JSON.stringify({ version: CODEX_CACHE_VERSION, files }))

    const projects = await withCodexCacheDirectory(cacheDir, () =>
      Promise.all(paths.map(p => getCachedCodexProject(p))))

    expect(projects).toEqual(paths.map((_, i) => `proj-${i}`))
    expect(streamSpy.mock.calls.filter(([p]) => String(p).includes('codex-results'))).toHaveLength(1)
  })

  it('a publish mid-load reaches the waiter and later readers', async () => {
    const p = join(sessionDir, 'rollout-gated.jsonl')
    await writeFile(p, '{}\n')
    const { statSync } = await import('fs')
    const s = statSync(p)
    const fp = { dev: s.dev, ino: s.ino, mtimeMs: s.mtimeMs, sizeBytes: s.size }
    const files = { [p]: { ...fp, project: 'proj-old', calls: [] } }
    await writeFile(join(cacheDir, codexCacheFileName()), JSON.stringify({ version: CODEX_CACHE_VERSION, files }))
    const marker = { marker: 'post-flush' } as unknown as ParsedProviderCall

    await withCodexCacheDirectory(cacheDir, async () => {
      try {
      // Hold the waiter's decode stream: the release pipes a real stream
      // whose 'open' already fired, so its fd pins the pre-flush inode
      // across the flush's rename and the first decode is deterministically
      // stale — while a write+flush publishes underneath it.
      streamGate.hold = true
      const waiting = readCachedCodexResults(p)
      await vi.waitFor(
        () => {
          if (streamGate.opened === 0) throw new Error(`decode stream not opened yet (constructed=${streamGate.constructed})`)
        },
        { timeout: 10_000 },
      )
      // Release the hold BEFORE the flush: the flush's own merge read must
      // pass through (gating it would deadlock).
      streamGate.hold = false
      await writeCachedCodexResults(p, 'proj-new', [marker], fp)
      await flushCodexCache()
      // Re-arm before releasing: the waiter's retry decode must be gated
      // too, so the open count proves the retry instead of assuming it.
      streamGate.hold = true
      for (const resume of streamGate.releases.splice(0)) resume()
      await vi.waitFor(
        () => {
          if (streamGate.opened < 2) throw new Error('retry decode not opened yet')
        },
        { timeout: 10_000 },
      )
      streamGate.hold = false
      for (const resume of streamGate.releases.splice(0)) resume()
      // Exactly two decode opens (stale first + retry): without the
      // generation loop the waiter would have resolved off one open.
      expect(streamGate.opened).toBe(2)
      // The waiter retried on the new bytes instead of memoizing stale ones…
      await expect(waiting).resolves.toEqual({ kind: 'exact', calls: [marker] })
      // …and the memo holds the fresh snapshot for later readers.
      await expect(readCachedCodexResults(p)).resolves.toEqual({ kind: 'exact', calls: [marker] })
      } finally {
        // Drain any held source on failure: a stuck test must not leave an
        // open fd or a pending pipeline for later tests in this worker.
        streamGate.hold = false
        for (const resume of streamGate.releases.splice(0)) {
          try { resume() } catch { /* release-only; decode already settled */ }
        }
      }
    })
  })
})
