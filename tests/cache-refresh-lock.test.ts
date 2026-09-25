import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  acquireCacheRefreshLock,
  type RefreshLockClock,
} from '../src/cache-refresh-lock.js'
import { clearSessionCache, parseAllSessions } from '../src/parser.js'
import { emptyCache, loadCache, saveCache, sessionCacheDir } from '../src/session-cache.js'

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

/** The pid of a process that has definitively exited, for the dead-holder gate. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const pid = child.pid
  if (!pid) throw new Error('no pid')
  await new Promise<void>(resolve => { child.once('exit', () => resolve()) })
  return pid
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

  it('allows independent custom lock names to proceed concurrently', async () => {
    const dir = await tempDir()
    const first = await acquireCacheRefreshLock({ cacheDir: dir, lockFile: 'status-snapshot.aaaa.write.lock' })
    expect(first.outcome).toBe('acquired')
    if (first.outcome !== 'acquired') return

    const second = await acquireCacheRefreshLock({ cacheDir: dir, lockFile: 'status-snapshot.bbbb.write.lock' })
    expect(second.outcome).toBe('acquired')
    if (second.outcome === 'acquired') await second.handle.release()
    await first.handle.release()
  })

  it('rejects custom lock paths that could escape the cache directory', async () => {
    const dir = await tempDir()
    for (const lockFile of ['../outside.lock', '/tmp/outside.lock', 'nested/lock', 'x.takeover']) {
      expect(await acquireCacheRefreshLock({ cacheDir: dir, lockFile })).toEqual({ outcome: 'unavailable' })
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

  // #1117: the waiter budget now outlives the stale gate by design, so the
  // live-holder guarantee has to hold for a wait many times longer than staleMs,
  // not just for one shorter than it.
  it('never takes over a heartbeating owner however far the wait outlives staleMs', async () => {
    const dir = await tempDir()
    const path = lockPath(dir)
    const clock = fakeClock()
    await writeFile(path, JSON.stringify({ pid: 1, token: 'holder', at: clock.wallNow() }))
    const beat = async (): Promise<void> => {
      const now = new Date(clock.wallNow())
      await utimes(path, now, now)
    }
    await beat()

    const result = await acquireCacheRefreshLock({
      cacheDir: dir,
      clock,
      staleMs: 500,
      waitMs: 5_000,
      pollMs: 1,
      // pid 1 is alive and the holder keeps pace with the clock, so neither
      // abandonment clause ever opens even though the waiter spends ten stale
      // windows in the loop.
      sleep: async () => { clock.advance(100); await beat() },
    })
    expect(result).toEqual({ outcome: 'timed-out' })
    expect(JSON.parse(await readFile(path, 'utf-8')).token).toBe('holder')
  })

  it('takes over a lock whose holder pid is gone without waiting out the stale window', async () => {
    const dir = await tempDir()
    const path = lockPath(dir)
    // Wall clock frozen so the age gate can NEVER open; monotonic still runs so
    // the waiter budget expires instead of spinning. Only the dead pid can
    // explain a takeover here.
    let monotonic = 1_000
    const clock: RefreshLockClock = { wallNow: () => 1_000, monotonicNow: () => monotonic }
    const gone = await exitedPid()
    await writeFile(path, JSON.stringify({ pid: gone, token: 'killed', at: clock.wallNow() }))
    const now = new Date(clock.wallNow())
    await utimes(path, now, now)

    const result = await acquireCacheRefreshLock({
      cacheDir: dir,
      clock,
      waitMs: 5_000,
      pollMs: 1,
      sleep: async ms => { monotonic += ms },
    })
    expect(result.outcome).toBe('acquired')
    if (result.outcome !== 'acquired') return
    expect(JSON.parse(await readFile(path, 'utf-8'))).toMatchObject({ pid: process.pid, token: result.handle.token })
    await result.handle.release()
  })

  it('takes over a lock whose heartbeat froze even though its holder pid is alive', async () => {
    const dir = await tempDir()
    const path = lockPath(dir)
    // pid 1 always answers signal 0, so only the frozen mtime can explain it.
    await writeFile(path, JSON.stringify({ pid: 1, token: 'frozen', at: 1 }))
    await utimes(path, new Date(1), new Date(1))
    const clock = fakeClock(1_000_000)

    const result = await acquireCacheRefreshLock({
      cacheDir: dir,
      clock,
      staleMs: 90_000,
      waitMs: 5_000,
      pollMs: 1,
      sleep: async ms => { clock.advance(ms) },
    })
    expect(result.outcome).toBe('acquired')
    if (result.outcome !== 'acquired') return
    await result.handle.release()
  })

  it('defaults the waiter budget past the stale gate', async () => {
    const dir = await tempDir()
    const path = lockPath(dir)
    const clock = fakeClock()
    await writeFile(path, JSON.stringify({ pid: 1, token: 'frozen', at: clock.wallNow() }))
    const now = new Date(clock.wallNow())
    await utimes(path, now, now)

    // No waitMs override: the default must be long enough that a lock which goes
    // stale mid-wait is still recovered by THIS waiter rather than timing out
    // and leaving the leftover for the next process to trip over (#1117).
    const result = await acquireCacheRefreshLock({
      cacheDir: dir,
      clock,
      staleMs: 90_000,
      pollMs: 1,
      sleep: async () => { clock.advance(1_000) },
    })
    expect(result.outcome).toBe('acquired')
    if (result.outcome !== 'acquired') return
    await result.handle.release()
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

  it('never exposes a torn lock body to a plain reader while heartbeating', async () => {
    // Regression for #904: the heartbeat used to rewrite the body in place
    // (truncate then write), so a concurrent reader could observe an empty or
    // partial file. The rewrite is now an atomic rename, so every read below
    // must parse, whichever side of a heartbeat it lands on.
    const dir = await tempDir()
    const clock = fakeClock(10_000)
    const result = await acquireCacheRefreshLock({ cacheDir: dir, clock, heartbeatMs: 1 })
    expect(result.outcome).toBe('acquired')
    if (result.outcome !== 'acquired') return
    try {
      for (let i = 0; i < 400; i++) {
        if (i % 20 === 0) clock.advance(100)
        const record = JSON.parse(await readFile(lockPath(dir), 'utf-8'))
        expect(record.token).toBe(result.handle.token)
        if (i % 50 === 0) await new Promise(resolve => { setTimeout(resolve, 2) })
      }
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
    expect(sessionCacheDir()).toContain(dir)
  })

  // retry shields environmental fd/CPU starvation in a saturated full-suite
  // run (fs 'unavailable' makes the fence fail CLOSED, which is correct but
  // not what this test measures); the actual race fails ~6% per verify, so a
  // mutated build cannot pass any attempt.
  it('the fence never loses to its own heartbeat (in-process serialization)', { retry: 10 }, async () => {
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

  it('coalesces heartbeat ticks that fire faster than a tick completes', async () => {
    // Every queued tick used to run in full, so an interval outpacing the
    // tick grew the serializer without bound and the fence waited behind the
    // whole backlog (the 1ms-heartbeat test above then stalled for minutes
    // on a loaded runner). Counting wallNow calls counts lock-file writes.
    const dir = await tempDir()
    let writes = 0
    const clock = { monotonicNow: () => performance.now(), wallNow: () => { writes++; return Date.now() } }
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const result = await acquireCacheRefreshLock({ cacheDir: dir, clock, heartbeatMs: 1_000 })
      if (result.outcome !== 'acquired') throw new Error(`expected acquired, got ${result.outcome}`)
      vi.advanceTimersByTime(50_000)
      writes = 0
      expect(await result.handle.verifyStillOwner()).toBe(true)
      expect(writes).toBeLessThanOrEqual(4)
      await result.handle.release()
    } finally {
      vi.useRealTimers()
    }
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
  // and left alone: it may belong to a live owner whose heartbeat is about to
  // repair it. The resulting freeze is bounded by staleMs rather than
  // permanent, which is the whole of the reported defect.
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

  it('never steals a fresh malformed lock from an owner that repairs it mid-wait', async () => {
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
