import { describe, expect, it } from 'vitest'

import { finishStar, recordFirstSeen, showStar } from '../src/star'

function memento() {
  const data = new Map<string, unknown>()
  return { get: <T>(key: string) => data.get(key) as T | undefined, update: async (key: string, value: unknown) => { data.set(key, value) } }
}

const DAY = 86_400_000

describe('star line', () => {
  it('stays hidden until the third day of use', () => {
    const store = memento()
    const start = Date.UTC(2026, 9, 1)
    expect(showStar(store, start)).toBe(false)
    recordFirstSeen(store, start)
    expect(showStar(store, start + DAY)).toBe(false)
    expect(showStar(store, start + 2 * DAY)).toBe(true)
  })

  it('keeps the first day when the extension activates again', () => {
    const store = memento()
    recordFirstSeen(store, 0)
    recordFirstSeen(store, 5 * DAY)
    expect(showStar(store, 2 * DAY)).toBe(true)
  })

  it('never returns once clicked or dismissed', async () => {
    const store = memento()
    recordFirstSeen(store, 0)
    await finishStar(store)
    expect(showStar(store, 30 * DAY)).toBe(false)
  })
})
