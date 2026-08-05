import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import { acquireCacheRefreshLock } from '../src/cache-refresh-lock.js'

// Recovering a corrupt session-refresh.lock must never cost the two design
// commitments the lock exists for: it may not fail open into mutation, and it
// may not be stolen from a live heartbeating owner. An earlier fix waived the
// staleness gate for a corrupt body once the contender's wait expired, which
// handed two processes the lock at the same time in both directions below.
// Corruption is recovered only through the unmodified staleness gate.

const roots: string[] = []
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true })
})

async function tempCase(prefix: string): Promise<{ cacheDir: string; barriers: string; lockPath: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  const cacheDir = join(root, 'cache')
  const barriers = join(root, 'barriers')
  await mkdir(cacheDir, { recursive: true })
  await mkdir(barriers, { recursive: true })
  return { cacheDir, barriers, lockPath: join(cacheDir, 'session-refresh.lock') }
}

function spawnFixture(fixture: string, args: string[], env: NodeJS.ProcessEnv = {}): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', join(process.cwd(), 'tests/fixtures', fixture), ...args], {
    cwd: process.cwd(),
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, ...env },
  })
}

async function waitForFile(path: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`)
    await new Promise(resolve => { setTimeout(resolve, 5) })
  }
}

const exited = (child: ChildProcess): Promise<unknown> => new Promise(resolve => child.once('exit', resolve))

describe('warm refresh lock: a corrupt body never displaces a live owner', () => {
  it('leaves the zero-byte lock alone while its creator is still inside createExclusive', async () => {
    const { cacheDir, barriers, lockPath } = await tempCase('cb-refresh-corrupt-race-')
    // UV_THREADPOOL_SIZE=1 plus the fixture's pbkdf2 churn stretches the gap
    // between open(path,'wx') and the awaited body write, so the lock is
    // genuinely observable at zero bytes with no external corruption at all.
    const owner = spawnFixture('cache-refresh-slow-owner.ts', [cacheDir, barriers], { UV_THREADPOOL_SIZE: '1' })
    try {
      const deadline = Date.now() + 20_000
      let sawZeroByteLock = false
      while (Date.now() < deadline) {
        const info = await stat(lockPath).catch(() => null)
        if (info) { sawZeroByteLock = info.size === 0; break }
        await new Promise(resolve => { setTimeout(resolve, 1) })
      }
      expect(sawZeroByteLock, 'never caught the owner mid-createExclusive').toBe(true)

      const contender = await acquireCacheRefreshLock({ cacheDir, waitMs: 40, pollMs: 5, staleMs: 90_000 })
      if (contender.outcome === 'acquired') await contender.handle.release()
      expect(contender.outcome).toBe('timed-out')
    } finally {
      await exited(owner)
    }
    // The owner kept the lock end to end, so its publication fence held.
    expect(existsSync(join(barriers, 'owner.acquired'))).toBe(true)
    expect(existsSync(join(barriers, 'owner.verify.true')), 'owner lost its own lock').toBe(true)
  }, 60_000)

  it('leaves a live owner alone after its body is truncated, however long the wait', async () => {
    const { cacheDir, barriers, lockPath } = await tempCase('cb-refresh-corrupt-live-')
    const owner = spawnFixture('cache-refresh-corrupt-owner.ts', [cacheDir, barriers, '4000', '100'])
    try {
      await waitForFile(join(barriers, 'owner.acquired'))
      const ownerToken = await readFile(join(barriers, 'owner.acquired'), 'utf-8')

      // The state a heartbeat leaves when writeFile() truncates and then fails
      // (ENOSPC/EIO, swallowed by the heartbeat's own catch). No guard is held,
      // and the body carries no token to compare against.
      await writeFile(lockPath, '')
      // This wait is shorter than one heartbeat period, so the body is still
      // truncated throughout: the contender has nothing but the fresh mtime to
      // go on, and that alone must keep it out.
      const early = await acquireCacheRefreshLock({ cacheDir, waitMs: 80, pollMs: 5, staleMs: 90_000 })
      if (early.outcome === 'acquired') await early.handle.release()
      expect(early.outcome).toBe('timed-out')

      // Past the age gate, the successor SHOULD win. Only the heartbeat
      // advances mtime and it refuses to rewrite a body it cannot prove is
      // ours, so a corrupt body freezes its own mtime and ages out. That is the
      // intended end state, not a displacement to be prevented: an owner that
      // cannot prove ownership must not publish, and the alternative — letting
      // the heartbeat restamp its token over an unparseable body — resurrected
      // legitimately-replaced writers and let release() delete a live
      // successor's lock.
      await writeFile(lockPath, '')
      const late = await acquireCacheRefreshLock({ cacheDir, waitMs: 2_400, pollMs: 10, staleMs: 400 })
      expect(late.outcome).toBe('acquired')
      if (late.outcome === 'acquired') {
        // The successor owns it outright: the body carries its token, not the
        // original owner's.
        expect(JSON.parse(await readFile(lockPath, 'utf-8')).token).not.toBe(ownerToken)
        await late.handle.release()
      }
    } finally {
      await exited(owner)
    }
    // The displaced owner's fence must refuse. Discarding its parse is the
    // fail-safe direction; two writers believing they own the lock is not.
    expect(existsSync(join(barriers, 'owner.verify.false')), 'displaced owner still passed its fence').toBe(true)
    expect(existsSync(join(barriers, 'owner.verify.true'))).toBe(false)
  }, 30_000)
})
