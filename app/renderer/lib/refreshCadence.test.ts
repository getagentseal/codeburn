// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest'

import { DEFAULT_REFRESH_VALUE, readRefreshValue, refreshValueToMs } from './refreshCadence'

const STORAGE_KEY = 'codeburn.refreshInterval'

// The project's jsdom does not expose a working localStorage (see App.test.tsx),
// so back it with a Map for these persistence tests.
const stored = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => stored.set(key, value),
  removeItem: (key: string) => stored.delete(key),
  clear: () => stored.clear(),
})

beforeEach(() => { stored.clear() })

describe('refresh cadence default migration', () => {
  it('defaults to 60s when a cadence was never chosen (silent migration off 30s)', () => {
    expect(DEFAULT_REFRESH_VALUE).toBe('1m')
    expect(readRefreshValue()).toBe('1m')
    expect(refreshValueToMs(readRefreshValue())).toBe(60_000)
  })

  it('honors an explicit stored 30s choice over the new default', () => {
    globalThis.localStorage.setItem(STORAGE_KEY, '30s')
    expect(readRefreshValue()).toBe('30s')
    expect(refreshValueToMs('30s')).toBe(30_000)
  })

  it('honors any other explicit stored choice', () => {
    globalThis.localStorage.setItem(STORAGE_KEY, '5m')
    expect(readRefreshValue()).toBe('5m')
    expect(refreshValueToMs('5m')).toBe(300_000)
  })

  it('falls back to the default for an unrecognized stored value', () => {
    globalThis.localStorage.setItem(STORAGE_KEY, 'bogus')
    expect(readRefreshValue()).toBe(DEFAULT_REFRESH_VALUE)
  })

  it('still offers 30s as a selectable cadence', () => {
    expect(refreshValueToMs('30s')).toBe(30_000)
  })
})
