import { describe, it, expect } from 'vitest'

import { formatTokens } from '../src/format.js'

// The models table and MCP summary abbreviate token counts through this one
// helper, so a missing rung shows up as a column-wide misprint (a period
// cache-read total rendering as 29870.8M instead of 29.9B).
describe('formatTokens', () => {
  it('keeps plain digits below a thousand and switches to K above it', () => {
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1_500)).toBe('1.5K')
  })

  it('keeps the M rung output at the top of the M band', () => {
    // (999_999_999 / 1e6).toFixed(1) rounds up to 1000.0M; pinned so the B
    // rung cannot silently move the M boundary.
    expect(formatTokens(999_999_999)).toBe('1000.0M')
  })

  it('switches to a B rung at a billion', () => {
    expect(formatTokens(1_000_000_000)).toBe('1.0B')
    expect(formatTokens(29_870_800_000)).toBe('29.9B')
  })

  it('guards non-finite and negative values', () => {
    expect(formatTokens(Number.NaN)).toBe('?')
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('?')
    expect(formatTokens(-1)).toBe('0')
  })
})
