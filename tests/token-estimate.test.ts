import { describe, expect, it } from 'vitest'

import { CHARS_PER_TOKEN, estimateTokensFromChars } from '../src/token-estimate.js'

describe('estimateTokensFromChars', () => {
  it('uses four characters per token', () => {
    expect(CHARS_PER_TOKEN).toBe(4)
  })

  it('rounds partial tokens up', () => {
    expect(estimateTokensFromChars(5)).toBe(2)
  })

  it('handles zero and boundary character counts', () => {
    expect(estimateTokensFromChars(0)).toBe(0)
    expect(estimateTokensFromChars(1)).toBe(1)
    expect(estimateTokensFromChars(4)).toBe(1)
  })
})
