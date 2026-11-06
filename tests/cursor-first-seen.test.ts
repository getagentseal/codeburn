import { describe, it, expect } from 'vitest'

import { readFirstSeen, writeFirstSeen } from '../src/cursor-cache.js'

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
})
