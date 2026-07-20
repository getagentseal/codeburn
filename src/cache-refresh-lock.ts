import { randomBytes } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, open, readFile, stat, unlink, utimes, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

const LOCK_FILE = 'session-refresh.lock'
const TAKEOVER_FILE = `${LOCK_FILE}.takeover`
const DEFAULT_HEARTBEAT_MS = 10_000
const DEFAULT_STALE_MS = 90_000
const DEFAULT_WAIT_MS = 30_000
const DEFAULT_POLL_MS = 100
const WINDOWS_RETRIES = 3

type LockRecord = { pid: number; token: string; at: number }

export type RefreshLockClock = {
  monotonicNow: () => number
  wallNow: () => number
}

export type RefreshLockOptions = {
  cacheDir?: string
  clock?: RefreshLockClock
  heartbeatMs?: number
  staleMs?: number
  waitMs?: number
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
}

export type RefreshLockHandle = {
  token: string
  release: () => Promise<void>
  verifyStillOwner: () => Promise<boolean>
}

export type RefreshLockOutcome =
  | { outcome: 'acquired'; handle: RefreshLockHandle }
  | { outcome: 'completed-by-other' }
  | { outcome: 'timed-out' }
  | { outcome: 'unavailable' }

const defaultClock: RefreshLockClock = {
  monotonicNow: () => Number(process.hrtime.bigint()) / 1_000_000,
  wallNow: () => Date.now(),
}

function defaultCacheDir(): string {
  return process.env['CODEBURN_CACHE_DIR'] ?? join(homedir(), '.cache', 'codeburn')
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

function isBusyError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'EPERM' || code === 'EBUSY'
}

function isExistsError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'EEXIST'
}

function isMissingError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

async function retryWindowsMutation(operation: () => Promise<void>, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  for (let attempt = 0; attempt < WINDOWS_RETRIES; attempt++) {
    try {
      await operation()
      return true
    } catch (err) {
      if (isMissingError(err)) return true
      if (!isBusyError(err) || attempt === WINDOWS_RETRIES - 1) return false
      await sleep(10 * (attempt + 1))
    }
  }
  return false
}

async function createExclusive(path: string, body: string): Promise<'created' | 'exists' | 'unavailable'> {
  try {
    const handle = await open(path, 'wx', 0o600)
    try { await handle.writeFile(body, { encoding: 'utf-8' }) }
    finally { await handle.close() }
    return 'created'
  } catch (err) {
    return isExistsError(err) ? 'exists' : 'unavailable'
  }
}

type Observation = { record: LockRecord; mtimeMs: number }
type ObservationResult = Observation | 'missing' | 'changing' | 'unavailable'

async function observe(path: string): Promise<ObservationResult> {
  // Exclusive create exposes the directory entry just before its small body is
  // written, and heartbeat rewrites briefly truncate it. Treat that bounded
  // transition as contention, not broken infrastructure.
  let sawChange = false
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const before = await stat(path)
      const raw = await readFile(path, 'utf-8')
      const after = await stat(path)
      if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) {
        sawChange = true
        await delay(1)
        continue
      }
      const parsed = JSON.parse(raw) as Partial<LockRecord>
      if (typeof parsed.pid === 'number' && typeof parsed.token === 'string' && typeof parsed.at === 'number') {
        return { record: { pid: parsed.pid, token: parsed.token, at: parsed.at }, mtimeMs: after.mtimeMs }
      }
    } catch (err) {
      if (isMissingError(err)) return 'missing'
      const code = (err as NodeJS.ErrnoException | undefined)?.code
      if (code === 'EACCES' || code === 'EPERM') return 'unavailable'
    }
    await delay(1)
  }
  return sawChange ? 'changing' : 'unavailable'
}

function sameObservation(a: Observation, b: Observation): boolean {
  return a.record.token === b.record.token && a.mtimeMs === b.mtimeMs
}

let singleFlightTail: Promise<void> = Promise.resolve()

async function enterSingleFlight(): Promise<() => void> {
  const previous = singleFlightTail
  let leave!: () => void
  singleFlightTail = new Promise<void>(resolve => { leave = resolve })
  await previous
  return leave
}

/**
 * Strict gate for the warm session-cache read/reconcile/parse/save transaction.
 * Lock ordering, when the daily-cache follow-up lands, is daily → session.
 */
export async function acquireCacheRefreshLock(options: RefreshLockOptions = {}): Promise<RefreshLockOutcome> {
  const leaveSingleFlight = await enterSingleFlight()
  let ownsSingleFlight = true
  const leave = (): void => {
    if (!ownsSingleFlight) return
    ownsSingleFlight = false
    leaveSingleFlight()
  }

  const cacheDir = options.cacheDir ?? defaultCacheDir()
  const clock = options.clock ?? defaultClock
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const sleep = options.sleep ?? delay
  const lockPath = join(cacheDir, LOCK_FILE)
  const takeoverPath = join(cacheDir, TAKEOVER_FILE)
  const token = randomBytes(16).toString('hex')
  const body = (): string => JSON.stringify({ pid: process.pid, token, at: clock.wallNow() })

  // In-process serializer for every operation that takes the takeover guard on
  // behalf of THIS owner (heartbeat tick, publication fence). Without it the
  // fence can observe its own heartbeat's guard file and read "guard held" as
  // "displaced", aborting a legitimate publication — fail-safe but it throws
  // away the parse the lock exists to protect. Cross-process semantics are
  // untouched: the guard file still arbitrates between processes.
  let ownerOpTail: Promise<unknown> = Promise.resolve()
  const serializeOwnerOp = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = ownerOpTail.then(fn)
    ownerOpTail = next.catch(() => undefined)
    return next
  }

  const acquireTakeoverGuard = async (): Promise<'created' | 'exists' | 'unavailable'> => {
    const created = await createExclusive(takeoverPath, body())
    if (created !== 'exists') return created
    const staleGuard = await observe(takeoverPath)
    if (staleGuard === 'missing') return createExclusive(takeoverPath, body())
    if (staleGuard === 'changing') return 'exists'
    if (staleGuard === 'unavailable') return 'unavailable'
    if (Math.max(0, clock.wallNow() - staleGuard.mtimeMs) <= staleMs) return 'exists'
    const reverified = await observe(takeoverPath)
    if (reverified === 'missing') return createExclusive(takeoverPath, body())
    if (reverified === 'changing') return 'exists'
    if (reverified === 'unavailable') return 'unavailable'
    if (!sameObservation(staleGuard, reverified)) return 'exists'
    if (!await retryWindowsMutation(() => unlink(takeoverPath), sleep)) return 'unavailable'
    return createExclusive(takeoverPath, body())
  }

  const removeIfOwned = async (): Promise<boolean> => {
    // A contender holds the takeover guard only for milliseconds at a time;
    // retry briefly rather than abandoning our lock to 90s stale-timeout,
    // which would stall every waiting process for that long.
    let guard: 'created' | 'exists' | 'unavailable' = 'exists'
    for (let attempt = 0; attempt < 20 && guard !== 'created'; attempt++) {
      guard = await acquireTakeoverGuard()
      if (guard === 'unavailable') return false
      if (guard !== 'created') await sleep(pollMs)
    }
    if (guard !== 'created') return false
    try {
      const current = await observe(lockPath)
      if (current === 'missing') return true
      if (current === 'changing') return false
      if (current === 'unavailable') return false
      if (current.record.token !== token) return true
      return retryWindowsMutation(() => unlink(lockPath), sleep)
    } finally {
      await retryWindowsMutation(() => unlink(takeoverPath), sleep)
    }
  }

  const verifyStillOwner = (): Promise<boolean> => serializeOwnerOp(async () => {
    const guard = await acquireTakeoverGuard()
    if (guard !== 'created') return false
    try {
      const current = await observe(lockPath)
      return current !== 'missing' && current !== 'changing' && current !== 'unavailable' && current.record.token === token
    } finally {
      await retryWindowsMutation(() => unlink(takeoverPath), sleep)
    }
  })

  const makeHandle = (): RefreshLockHandle => {
    let released = false
    let heartbeatRunning = false
    const heartbeat = setInterval(() => {
      void serializeOwnerOp(async () => {
        if (released || heartbeatRunning) return
        heartbeatRunning = true
        const guard = await acquireTakeoverGuard()
        if (guard !== 'created') { heartbeatRunning = false; return }
        try {
          const current = await observe(lockPath)
          if (current === 'missing' || current === 'changing' || current === 'unavailable' || current.record.token !== token) return
          await writeFile(lockPath, body(), { encoding: 'utf-8' })
          const now = new Date(clock.wallNow())
          await utimes(lockPath, now, now)
        } catch { /* verify/release will turn displacement or I/O failure into a closed gate */ }
        finally {
          await retryWindowsMutation(() => unlink(takeoverPath), sleep)
          heartbeatRunning = false
        }
      })
    }, heartbeatMs)
    heartbeat.unref()

    return {
      token,
      verifyStillOwner,
      release: async () => {
        if (released) return
        released = true
        clearInterval(heartbeat)
        while (heartbeatRunning) await sleep(1)
        await removeIfOwned()
        leave()
      },
    }
  }

  const tryCreateOwner = async (): Promise<RefreshLockOutcome | null> => {
    const result = await createExclusive(lockPath, body())
    if (result === 'created') return { outcome: 'acquired', handle: makeHandle() }
    if (result === 'unavailable') return { outcome: 'unavailable' }
    return null
  }

  const tryTakeover = async (stale: Observation): Promise<RefreshLockOutcome | null> => {
    const guard = await acquireTakeoverGuard()
    if (guard === 'unavailable') return { outcome: 'unavailable' }
    if (guard === 'exists') return null
    try {
      const current = await observe(lockPath)
      if (current === 'unavailable') return { outcome: 'unavailable' }
      if (current === 'changing') return null
      if (current === 'missing' || !sameObservation(stale, current)) return null
      if (Math.max(0, clock.wallNow() - current.mtimeMs) <= staleMs) return null
      if (!await retryWindowsMutation(() => unlink(lockPath), sleep)) return { outcome: 'unavailable' }
      // Publish the successor while the takeover guard is still canonical.
      // Otherwise a waiter can observe neither file and misclassify the narrow
      // unlink/create gap as a clean completion by the stale owner.
      const successor = await createExclusive(lockPath, body())
      if (successor === 'created') return { outcome: 'acquired', handle: makeHandle() }
      if (successor === 'unavailable') return { outcome: 'unavailable' }
      return null
    } finally {
      // Never override the try-block's outcome from here: returning
      // 'unavailable' after 'acquired' would abandon a live heartbeating
      // handle that then blocks every other process until this one exits.
      // A guard file we fail to remove reads as contention to others and is
      // replaced once stale.
      await retryWindowsMutation(() => unlink(takeoverPath), sleep)
    }
  }

  try {
    if (!existsSync(cacheDir)) await mkdir(cacheDir, { recursive: true })
    const immediate = await tryCreateOwner()
    if (immediate) {
      if (immediate.outcome !== 'acquired') leave()
      return immediate
    }

    const deadline = clock.monotonicNow() + waitMs
    while (clock.monotonicNow() < deadline) {
      const observation = await observe(lockPath)
      if (observation === 'unavailable') { leave(); return { outcome: 'unavailable' } }
      if (observation === 'changing') { await sleep(pollMs); continue }
      if (observation === 'missing') {
        // A stale taker removes the primary while holding the guard, then
        // exclusively creates its successor. Do not misreport that narrow gap
        // as a clean completion by the previous owner.
        const guard = await observe(takeoverPath)
        if (guard === 'unavailable') { leave(); return { outcome: 'unavailable' } }
        if (guard === 'changing') { await sleep(pollMs); continue }
        if (guard === 'missing') { leave(); return { outcome: 'completed-by-other' } }
        await sleep(pollMs)
        continue
      }

      const age = Math.max(0, clock.wallNow() - observation.mtimeMs)
      if (age > staleMs) {
        const takeover = await tryTakeover(observation)
        if (takeover) {
          if (takeover.outcome !== 'acquired') leave()
          return takeover
        }
      }
      await sleep(pollMs)
    }
    leave()
    return { outcome: 'timed-out' }
  } catch {
    leave()
    return { outcome: 'unavailable' }
  }
}
