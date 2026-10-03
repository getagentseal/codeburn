import { afterEach, describe, expect, it } from 'vitest'

import { __resetStreak, rememberStreak } from './streak'

describe('rememberStreak', () => {
  afterEach(() => {
    __resetStreak()
  })

  it('does not reuse the global streak for a scoped provider or project query', () => {
    expect(rememberStreak(12, 'all')).toBe(12)
    expect(rememberStreak(undefined, 'provider:claude')).toBeNull()
    expect(rememberStreak(undefined, 'project:alpha')).toBeNull()
  })

  it('keeps a reported scoped streak isolated to that exact scope', () => {
    expect(rememberStreak(4, 'project:alpha')).toBe(4)
    expect(rememberStreak(undefined, 'project:beta')).toBeNull()
  })
})
