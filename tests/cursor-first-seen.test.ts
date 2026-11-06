import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdirSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'

import { getCodeburnCacheDir } from '../src/cache-dir.js'
import { CURSOR_CACHE_VERSION, cursorCacheFileName, readFirstSeen, writeFirstSeen } from '../src/cursor-cache.js'

const lockState = vi.hoisted(() => ({ unavailable: false }))
vi.mock('../src/cache-refresh-lock.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/cache-refresh-lock.js')>()
  return {
    ...mod,
    acquireCacheRefreshLock: (...args: Parameters<typeof mod.acquireCacheRefreshLock>) =>
      lockState.unavailable ? Promise.resolve({ outcome: 'unavailable' as const }) : mod.acquireCacheRefreshLock(...args),
  }
})

const fragments = () => readdirSync(getCodeburnCacheDir()).filter(n => /^cursor-first-seen\.\d+\.json$/.test(n))

beforeEach(() => {
  lockState.unavailable = false
})

describe('cursor first-seen sidecar', () => {
  it('keeps both entries when two writers each started from a stale view', async () => {
    const a = await readFirstSeen()
    const b = await readFirstSeen()
    a.set('req-a', '2026-10-01T00:00:00.000Z')
    b.set('req-b', '2026-10-02T00:00:00.000Z')

    await writeFirstSeen(a)
    await writeFirstSeen(b)

    expect(Object.fromEntries(await readFirstSeen())).toEqual({
      'req-a': '2026-10-01T00:00:00.000Z',
      'req-b': '2026-10-02T00:00:00.000Z',
    })
  })

  it('keeps both entries when two writes run concurrently, and the recorded time wins', async () => {
    await writeFirstSeen(new Map([['req-c', '2026-10-03T00:00:00.000Z']]))

    await Promise.all([
      writeFirstSeen(new Map([['req-c', '2026-11-01T00:00:00.000Z'], ['req-d', '2026-10-04T00:00:00.000Z']])),
      writeFirstSeen(new Map([['req-e', '2026-10-05T00:00:00.000Z']])),
    ])

    expect(Object.fromEntries(await readFirstSeen())).toMatchObject({
      'req-c': '2026-10-03T00:00:00.000Z',
      'req-d': '2026-10-04T00:00:00.000Z',
      'req-e': '2026-10-05T00:00:00.000Z',
    })
  })

  it('drops values that are not ISO timestamps', async () => {
    mkdirSync(getCodeburnCacheDir(), { recursive: true })
    writeFileSync(join(getCodeburnCacheDir(), 'cursor-first-seen.json'), JSON.stringify({
      good: '2026-10-01T00:00:00.000Z',
      garbage: 'not a date',
      loose: '2026-10-01',
      number: 1759276800000,
      empty: '',
    }))

    expect(Object.fromEntries(await readFirstSeen())).toEqual({ good: '2026-10-01T00:00:00.000Z' })
  })

  it('keeps both entries from writers that could not take the lock, and folds them in later', async () => {
    lockState.unavailable = true
    const realPid = process.pid
    try {
      Object.defineProperty(process, 'pid', { value: 70001, configurable: true })
      await writeFirstSeen(new Map([['req-f', '2026-10-06T00:00:00.000Z']]))
      Object.defineProperty(process, 'pid', { value: 70002, configurable: true })
      await writeFirstSeen(new Map([['req-g', '2026-10-07T00:00:00.000Z']]))
    } finally {
      Object.defineProperty(process, 'pid', { value: realPid, configurable: true })
    }

    expect(fragments().sort()).toEqual(['cursor-first-seen.70001.json', 'cursor-first-seen.70002.json'])
    expect(Object.fromEntries(await readFirstSeen())).toMatchObject({
      'req-f': '2026-10-06T00:00:00.000Z',
      'req-g': '2026-10-07T00:00:00.000Z',
    })

    lockState.unavailable = false
    await writeFirstSeen(new Map([['req-h', '2026-10-08T00:00:00.000Z']]))

    expect(fragments()).toEqual([])
    expect(Object.fromEntries(await readFirstSeen())).toMatchObject({
      'req-f': '2026-10-06T00:00:00.000Z',
      'req-g': '2026-10-07T00:00:00.000Z',
      'req-h': '2026-10-08T00:00:00.000Z',
    })
  })

  it('keeps both entries from concurrent writes in one process that cannot take the lock', async () => {
    lockState.unavailable = true

    await Promise.all([
      writeFirstSeen(new Map([['req-i', '2026-10-09T00:00:00.000Z']])),
      writeFirstSeen(new Map([['req-j', '2026-10-10T00:00:00.000Z']])),
    ])

    expect(Object.fromEntries(await readFirstSeen())).toMatchObject({
      'req-i': '2026-10-09T00:00:00.000Z',
      'req-j': '2026-10-10T00:00:00.000Z',
    })
  })

  it('retires v7 results, which billed old agent streams at the database mtime', () => {
    expect(CURSOR_CACHE_VERSION).toBe(8)
    expect(cursorCacheFileName()).toBe('cursor-results.v8.json')
  })
})
