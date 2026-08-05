import { afterEach, describe, expect, it } from 'vitest'
import { writeFileSync, utimesSync } from 'fs'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  acquireCacheRefreshLock,
  type RefreshLockClock,
} from '../src/cache-refresh-lock.js'
import { emptyCache, loadCache, saveCache, sessionCachePath } from '../src/session-cache.js'
import { clearSessionCache, parseAllSessions } from '../src/parser.js'

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cb-refresh-lock-'))
  dirs.push(dir)
  return dir
}

function lockPath(dir: string): string {
  return join(dir, 'session-refresh.lock')
}

function fakeClock(start = 1_000): RefreshLockClock & { advance: (ms: number) => void } {
  let wall = start
  let monotonic = start
  return {
    wallNow: () => wall,
    monotonicNow: () => monotonic,
    advance: ms => { wall += ms; monotonic += ms },
  }
}

afterEach(async () => {
  delete process.env['CODEBURN_CACHE_DIR']
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('warm session-cache refresh lock', () => {
  it('returns acquired and releases its own token', async () => {
    const dir = await tempDir()
    const result = await acquireCacheRefreshLock({ cacheDir: dir })
    expect(result.outcome).toBe('acquired')
    if (result.outcome !== 'acquired') return

    const record = JSON.parse(await readFile(lockPath(dir), 'utf-8'))
    expect(record).toMatchObject({ pid: process.pid, token: result.handle.token })
    expect(typeof record.at).toBe('number')
    await result.handle.release()
    await expect(stat(lockPath(dir))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports completed-by-other after a clean release', async () => {
    const dir = await tempDir()
    const path = lockPath(dir)
    await writeFile(path, JSON.stringify({ pid: 1, token: 'holder', at: Date.now() }))
    let polls = 0
    const result = await acquireCacheRefreshLock({
      cacheDir: dir,
      waitMs: 100,
      pollMs: 1,
      sleep: async () => {
        if (++polls === 1) await unlink(path)
      },
    })
    expect(result).toEqual({ outcome: 'completed-by-other' })
  })

  it('uses a monotonic deadline and times out without invalidating the holder', async () => {
    const dir = await tempDir()
    const clock = fakeClock()
    const path = lockPath(dir)
    await writeFile(path, JSON.stringify({ pid: 1, token: 'holder', at: clock.wallNow() }))
    const now = new Date(clock.wallNow())
    await utimes(path, now, now)

    const result = await acquireCacheRefreshLock({
      cacheDir: dir,
      clock,
      waitMs: 30,
      staleMs: 90,
      pollMs: 10,
      sleep: async ms => { clock.advance(ms) },
    })
    expect(result).toEqual({ outcome: 'timed-out' })
    expect(JSON.parse(await readFile(path, 'utf-8')).token).toBe('holder')
  })

  it('reports unavailable when lock infrastructure is unusable', async () => {
    const dir = await tempDir()
    const notDirectory = join(dir, 'file')
    await writeFile(notDirectory, 'x')
    expect(await acquireCacheRefreshLock({ cacheDir: notDirectory })).toEqual({ outcome: 'unavailable' })
  })

  it('serializes same-process acquisitions before touching the filesystem lock', async () => {
    const dir = await tempDir()
    const first = await acquireCacheRefreshLock({ cacheDir: dir })
    expect(first.outcome).toBe('acquired')
    if (first.outcome !== 'acquired') return

    let settled = false
    const secondPromise = acquireCacheRefreshLock({ cacheDir: dir }).then(result => {
      settled = true
      return result
    })
    await new Promise(resolve => { setTimeout(resolve, 20) })
    expect(settled).toBe(false)

    await first.handle.release()
    const second = await secondPromise
    expect(second.outcome).toBe('acquired')
    if (second.outcome === 'acquired') {
      expect(second.handle.token).not.toBe(first.handle.token)
      await second.handle.release()
    }
  })

  it('does not take over a heartbeating owner', async () => {
    const dir = await tempDir()
    const path = lockPath(dir)
    await writeFile(path, JSON.stringify({ pid: 1, token: 'holder', at: Date.now() }))
    const heartbeat = setInterval(() => {
      const now = new Date()
      void utimes(path, now, now)
    }, 5)
    try {
      const result = await acquireCacheRefreshLock({ cacheDir: dir, staleMs: 20, waitMs: 60, pollMs: 5 })
      expect(result).toEqual({ outcome: 'timed-out' })
      expect(JSON.parse(await readFile(path, 'utf-8')).token).toBe('holder')
    } finally {
      clearInterval(heartbeat)
    }
  })

  it('heartbeats its own lock body and mtime with the injected clock', async () => {
    const dir = await tempDir()
    const clock = fakeClock(10_000)
    const result = await acquireCacheRefreshLock({ cacheDir: dir, clock, heartbeatMs: 5 })
    expect(result.outcome).toBe('acquired')
    if (result.outcome !== 'acquired') return
    try {
      const before = (await stat(lockPath(dir))).mtimeMs
      clock.advance(1_000)
      await new Promise(resolve => { setTimeout(resolve, 100) })
      const record = JSON.parse(await readFile(lockPath(dir), 'utf-8'))
      expect(record.at).toBe(clock.wallNow())
      expect((await stat(lockPath(dir))).mtimeMs).not.toBe(before)
    } finally {
      await result.handle.release()
    }
  })

  it('takes over only after re-verifying a stale token and mtime', async () => {
    const dir = await tempDir()
    const clock = fakeClock(100_000)
    const path = lockPath(dir)
    await writeFile(path, JSON.stringify({ pid: 1, token: 'stale', at: 1 }))
    const old = new Date(1)
    await utimes(path, old, old)

    const result = await acquireCacheRefreshLock({ cacheDir: dir, clock, staleMs: 90, waitMs: 100 })
    expect(result.outcome).toBe('acquired')
    if (result.outcome !== 'acquired') return
    expect(JSON.parse(await readFile(path, 'utf-8')).token).toBe(result.handle.token)
    await result.handle.release()
    await expect(stat(join(dir, 'session-refresh.lock.takeover'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reclaims an abandoned stale takeover guard', async () => {
    const dir = await tempDir()
    const clock = fakeClock(100_000)
    await writeFile(lockPath(dir), JSON.stringify({ pid: 1, token: 'stale', at: 1 }))
    await writeFile(join(dir, 'session-refresh.lock.takeover'), JSON.stringify({ pid: 2, token: 'stale-guard', at: 1 }))
    const old = new Date(1)
    await utimes(lockPath(dir), old, old)
    await utimes(join(dir, 'session-refresh.lock.takeover'), old, old)

    const result = await acquireCacheRefreshLock({ cacheDir: dir, clock, staleMs: 90, waitMs: 100 })
    expect(result.outcome).toBe('acquired')
    if (result.outcome === 'acquired') await result.handle.release()
  })

  it('fences publication and release removes only its own token', async () => {
    const dir = await tempDir()
    process.env['CODEBURN_CACHE_DIR'] = dir
    const original = emptyCache()
    original.complete = true
    await saveCache(original)

    const result = await acquireCacheRefreshLock({ cacheDir: dir, heartbeatMs: 60_000 })
    expect(result.outcome).toBe('acquired')
    if (result.outcome !== 'acquired') return

    await writeFile(lockPath(dir), JSON.stringify({ pid: 999, token: 'successor', at: Date.now() }))
    const changed = emptyCache()
    changed.complete = true
    changed.providers['claude'] = { parseVersion: 'test', envFingerprint: 'test', files: {} }
    expect(await saveCache(changed, result.handle.verifyStillOwner)).toBe(false)
    expect((await loadCache()).providers['claude']).toBeUndefined()

    await result.handle.release()
    expect(JSON.parse(await readFile(lockPath(dir), 'utf-8')).token).toBe('successor')
    expect(sessionCachePath()).toContain(dir)
  })

  // retry shields environmental fd/CPU starvation in a saturated full-suite
  // run (fs 'unavailable' makes the fence fail CLOSED, which is correct but
  // not what this test measures); the actual race fails ~6% per verify, so a
  // mutated build cannot pass any attempt.
  it('the fence never loses to its own heartbeat (in-process serialization)', { retry: 5 }, async () => {
    // Regression: verifyStillOwner and the heartbeat tick both take the
    // takeover guard; without in-process serialization the fence could observe
    // its own heartbeat's guard file and abort a legitimate publication.
    // At a 1ms heartbeat this raced ~6% of the time before the fix.
    const dir = await mkdtemp(join(tmpdir(), 'refresh-lock-'))
    const result = await acquireCacheRefreshLock({ cacheDir: dir, heartbeatMs: 1 })
    if (result.outcome !== 'acquired') throw new Error(`expected acquired, got ${result.outcome}`)
    for (let i = 0; i < 120; i++) {
      expect(await result.handle.verifyStillOwner()).toBe(true)
    }
    await result.handle.release()
    await rm(dir, { recursive: true, force: true })
  })
})

// A lock body that never parses into a record is a corrupt leftover, not an
// unusable filesystem: classifying it as 'unavailable' routed every subsequent
// refresh to the read-only path and froze ingestion permanently.
// Real-fs recovery tests: under a saturated full-suite run an fs op can starve
// and the acquire fails closed (correct, but not what these measure), so they
// retry to ride out the environmental blip. A real regression fails every
// attempt because the takeover assertion is deterministic given the fixture.
describe('warm session-cache refresh lock: corrupt lock recovery', { retry: 6 }, () => {
  it('takes over a stale zero-byte lock', async () => {
    const dir = await tempDir()
    const clock = fakeClock(100_000)
    const path = lockPath(dir)
    await writeFile(path, '')
    const old = new Date(1)
    await utimes(path, old, old)

    const result = await acquireCacheRefreshLock({ cacheDir: dir, clock, staleMs: 90, waitMs: 100, pollMs: 1 })
    expect(result.outcome).toBe('acquired')
    if (result.outcome !== 'acquired') return
    expect(JSON.parse(await readFile(path, 'utf-8')).token).toBe(result.handle.token)
    await result.handle.release()
    await expect(stat(join(dir, 'session-refresh.lock.takeover'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('takes over a stale malformed-JSON lock', async () => {
    const dir = await tempDir()
    const clock = fakeClock(100_000)
    const path = lockPath(dir)
    await writeFile(path, '{"pid":1,"token":')
    const old = new Date(1)
    await utimes(path, old, old)

    const result = await acquireCacheRefreshLock({ cacheDir: dir, clock, staleMs: 90, waitMs: 100, pollMs: 1 })
    expect(result.outcome).toBe('acquired')
    if (result.outcome !== 'acquired') return
    expect(JSON.parse(await readFile(path, 'utf-8')).token).toBe(result.handle.token)
    await result.handle.release()
  })

  it('takes over a stale lock whose body parses but has the wrong shape', async () => {
    const dir = await tempDir()
    const clock = fakeClock(100_000)
    const path = lockPath(dir)
    await writeFile(path, JSON.stringify({ pid: 'one', token: 7 }))
    const old = new Date(1)
    await utimes(path, old, old)

    const result = await acquireCacheRefreshLock({ cacheDir: dir, clock, staleMs: 90, waitMs: 100, pollMs: 1 })
    expect(result.outcome).toBe('acquired')
    if (result.outcome === 'acquired') await result.handle.release()
  })

  // Staleness is never waived for a corrupt body, so a FRESH one is waited out
  // and left alone. No owner repairs its own corrupt body (the heartbeat
  // refuses to rewrite what it cannot prove is its own), so the wait is not
  // about repair: a fresh mtime is evidence something live is touching the
  // file — a successor's body write still landing, or a foreign-version owner
  // heartbeating a shape we cannot parse. The resulting freeze is bounded by
  // staleMs rather than permanent, which is the whole of the reported defect.
  it('waits out a fresh malformed lock, then recovers it once it ages past staleMs', async () => {
    const dir = await tempDir()
    const clock = fakeClock(100_000)
    const path = lockPath(dir)
    await writeFile(path, '')
    const now = new Date(clock.wallNow())
    await utimes(path, now, now)

    let polls = 0
    const fresh = await acquireCacheRefreshLock({
      cacheDir: dir,
      clock,
      staleMs: 90_000,
      waitMs: 50,
      pollMs: 10,
      sleep: async ms => { polls++; clock.advance(ms) },
    })
    expect(polls).toBeGreaterThan(0)
    expect(fresh).toEqual({ outcome: 'timed-out' })
    expect(await readFile(path, 'utf-8')).toBe('')

    // Nothing rewrote the body, so its mtime is still frozen. One stale window
    // later the very next run recovers it through the unmodified age gate.
    clock.advance(90_001)
    const later = await acquireCacheRefreshLock({ cacheDir: dir, clock, staleMs: 90_000, waitMs: 50, pollMs: 10 })
    expect(later.outcome).toBe('acquired')
    if (later.outcome !== 'acquired') return
    expect(JSON.parse(await readFile(path, 'utf-8')).token).toBe(later.handle.token)
    await later.handle.release()
  })

  it('never steals a fresh malformed lock whose valid body lands mid-wait', async () => {
    const dir = await tempDir()
    const clock = fakeClock(100_000)
    const path = lockPath(dir)
    await writeFile(path, '')
    const now = new Date(clock.wallNow())
    await utimes(path, now, now)

    let polls = 0
    const result = await acquireCacheRefreshLock({
      cacheDir: dir,
      clock,
      staleMs: 90_000,
      waitMs: 50,
      pollMs: 10,
      sleep: async ms => {
        if (++polls === 1) {
          await writeFile(path, JSON.stringify({ pid: 1, token: 'holder', at: clock.wallNow() }))
          const t = new Date(clock.wallNow())
          await utimes(path, t, t)
        }
        clock.advance(ms)
      },
    })
    expect(result).toEqual({ outcome: 'timed-out' })
    expect(JSON.parse(await readFile(path, 'utf-8')).token).toBe('holder')
  })

  // The digest half of the takeover stability check: on a coarse-mtime
  // filesystem a live owner's heartbeat can rewrite the body without moving
  // mtime, so between the wait loop's observe and tryTakeover's re-observe the
  // file can change to bytes that share the token AND the mtime — only the
  // digest still says "rewritten". Pins sameObservation's digest comparison:
  // deleting it leaves every other lock test green because they never rewrite
  // inside that window.
  it('aborts the takeover when the body is rewritten with the same mtime and token between observe and re-observe', async () => {
    const dir = await tempDir()
    const clock = fakeClock(100_000)
    const path = lockPath(dir)
    // Two VALID records, same token, same length — a coarse-filesystem
    // heartbeat rewrite in miniature: size and (via utimes) mtime both hold,
    // only the bytes differ. token+mtime equality says "unchanged"; only the
    // digest can tell them apart.
    const first = JSON.stringify({ pid: 1, token: 'holder', at: 1 })
    const second = JSON.stringify({ pid: 1, token: 'holder', at: 2 })
    expect(second.length).toBe(first.length)
    await writeFile(path, first)
    const old = new Date(1)
    await utimes(path, old, old)

    // Inject the rewrite at the first wallNow call AFTER the wait loop's
    // observe of the stale lock — that is the age check, which is wallNow
    // call #2 (call #1 is the discarded tryCreateOwner body). The rewrite is
    // synchronous, so the re-observe inside tryTakeover deterministically
    // sees the new bytes.
    let wallCalls = 0
    let rewrote = false
    const triggerClock: RefreshLockClock = {
      wallNow: () => {
        wallCalls++
        if (wallCalls === 2 && !rewrote) {
          rewrote = true
          writeFileSync(path, second)
          utimesSync(path, old, old)
        }
        return clock.wallNow()
      },
      monotonicNow: () => clock.monotonicNow(),
    }

    let polls = 0
    const result = await acquireCacheRefreshLock({
      cacheDir: dir,
      clock: triggerClock,
      staleMs: 90,
      waitMs: 100,
      pollMs: 10,
      sleep: async ms => { polls++; clock.advance(ms) },
    })
    expect(result.outcome).toBe('acquired')
    if (result.outcome !== 'acquired') return
    try {
      // The first attempt must have aborted on the digest mismatch (same
      // token, same mtime, different bytes): one poll separates it from the
      // stable re-takeover. Without the digest comparison the takeover would
      // succeed on the first attempt and polls would be 0.
      expect(polls).toBe(1)
      expect(JSON.parse(await readFile(path, 'utf-8')).token).toBe(result.handle.token)
    } finally {
      await result.handle.release()
    }
  })

  it('treats a body truncated mid-heartbeat as contention, not corruption', async () => {
    const dir = await tempDir()
    const path = lockPath(dir)
    const record = (): string => JSON.stringify({ pid: 1, token: 'holder', at: Date.now() })
    await writeFile(path, record())
    // A real heartbeat rewrite exposes a zero-length body for an instant. The
    // waiter must keep polling and leave the live owner alone.
    const heartbeat = setInterval(() => {
      void (async () => {
        try {
          await writeFile(path, '')
          await writeFile(path, record())
        } catch { /* the winner may have replaced the file */ }
      })()
    }, 1)
    let result
    try {
      result = await acquireCacheRefreshLock({ cacheDir: dir, staleMs: 30, waitMs: 120, pollMs: 5 })
    } finally {
      clearInterval(heartbeat)
    }
    await new Promise(resolve => { setTimeout(resolve, 20) })
    expect(result).toEqual({ outcome: 'timed-out' })
    expect(JSON.parse(await readFile(path, 'utf-8')).token).toBe('holder')
  })

  // The sidecar is created by the same createExclusive as the lock, so it can be
  // left 0-byte by exactly the same crash. Before observe() separated corrupt
  // from unreadable this returned 'unavailable' from acquireTakeoverGuard and
  // froze recovery even when the primary lock was perfectly fine.
  it('reclaims a stale zero-byte takeover sidecar', async () => {
    const dir = await tempDir()
    const path = lockPath(dir)
    const sidecar = join(dir, 'session-refresh.lock.takeover')
    await writeFile(path, '')
    await writeFile(sidecar, '')
    const old = new Date(1)
    await utimes(path, old, old)
    await utimes(sidecar, old, old)

    const result = await acquireCacheRefreshLock({ cacheDir: dir, staleMs: 90, waitMs: 200, pollMs: 5 })
    expect(result.outcome).toBe('acquired')
    if (result.outcome !== 'acquired') return
    expect(JSON.parse(await readFile(path, 'utf-8')).token).toBe(result.handle.token)
    await result.handle.release()
    await expect(stat(sidecar)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('still reports unavailable when the lock body cannot be read', async () => {
    if (process.getuid?.() === 0) return
    const dir = await tempDir()
    const path = lockPath(dir)
    await writeFile(path, '')
    await chmod(path, 0o000)
    const old = new Date(1)
    await utimes(path, old, old)
    try {
      const result = await acquireCacheRefreshLock({ cacheDir: dir, staleMs: 1, waitMs: 50, pollMs: 5 })
      expect(result).toEqual({ outcome: 'unavailable' })
    } finally {
      await chmod(path, 0o600)
    }
  })

  it('resumes ingesting changed sources after a corrupt lock froze the refresh', async () => {
    const root = await tempDir()
    const cacheDir = join(root, 'cache')
    const config = join(root, 'claude')
    const projectDir = join(config, 'projects', 'frozen-proj')
    await mkdir(cacheDir, { recursive: true })
    await mkdir(projectDir, { recursive: true })
    process.env['CODEBURN_CACHE_DIR'] = cacheDir
    process.env['CLAUDE_CONFIG_DIR'] = config
    process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(root, 'desktop-sessions')

    const session = (id: string, ts: string): string => [
      JSON.stringify({ type: 'user', sessionId: id, timestamp: ts, cwd: '/tmp/frozen-proj', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({
        type: 'assistant', sessionId: id, timestamp: ts, cwd: '/tmp/frozen-proj',
        message: { id: `msg-${id}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: 100, output_tokens: 20 } },
      }),
    ].join('\n') + '\n'

    await writeFile(join(projectDir, 'sess-1.jsonl'), session('sess-1', '2026-05-01T10:00:00.000Z'))
    clearSessionCache()
    const warm = await parseAllSessions()
    expect(warm[0]?.sessions.map(s => s.sessionId)).toEqual(['sess-1'])

    // The field state: a 0-byte lock AND the takeover sidecar of the dead owner
    // that was mid-recovery when it died, both older than the stale window.
    // Nothing else on the machine ever repairs either file, so on every later
    // run the lock read as 'unavailable', the parser fell back to a read-only
    // re-parse, and sess-2 was never ingested.
    const old = new Date(1)
    for (const name of ['session-refresh.lock', 'session-refresh.lock.takeover']) {
      await writeFile(join(cacheDir, name), name.endsWith('.takeover') ? JSON.stringify({ pid: 999_999, token: 'dead-owner', at: 1 }) : '')
      await utimes(join(cacheDir, name), old, old)
    }

    await writeFile(join(projectDir, 'sess-2.jsonl'), session('sess-2', '2026-05-01T11:00:00.000Z'))
    clearSessionCache()
    const after = await parseAllSessions()
    expect(after[0]?.sessions.map(s => s.sessionId).sort()).toEqual(['sess-1', 'sess-2'])
    expect(Object.keys((await loadCache()).providers['claude']?.files ?? {}).length).toBe(2)

    clearSessionCache()
    delete process.env['CLAUDE_CONFIG_DIR']
    delete process.env['CODEBURN_DESKTOP_SESSIONS_DIR']
  })
})
