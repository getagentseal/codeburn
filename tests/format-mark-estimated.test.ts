import { describe, it, expect } from 'vitest'

import { isEstimatedCost, markEstimated } from '../src/format.js'

describe('markEstimated', () => {
  it('prefixes the estimated marker when the figure is estimated', () => {
    expect(markEstimated('$1.23', true)).toBe('~$1.23')
  })

  it('leaves a measured figure untouched', () => {
    expect(markEstimated('$1.23', false)).toBe('$1.23')
  })
})

describe('isEstimatedCost', () => {
  it('marks a fully estimated row', () => {
    expect(isEstimatedCost(579.13, 579.13)).toBe(true)
  })

  it('marks a partly estimated row once the estimate reaches 1% of it', () => {
    expect(isEstimatedCost(10, 0.1)).toBe(true)
    expect(isEstimatedCost(10, 2.5)).toBe(true)
  })

  it('leaves a metered row with a sub-1% estimated sliver unmarked', () => {
    expect(isEstimatedCost(1.4375, 0.0043)).toBe(false)
  })

  it('leaves a fully estimated figure unmarked when it reads as zero', () => {
    expect(isEstimatedCost(0.0003, 0.0003, '$0.00')).toBe(false)
    expect(isEstimatedCost(0.0003, 0.0003, '$0.0003')).toBe(true)
  })

  it('leaves an exact row unmarked', () => {
    expect(isEstimatedCost(12, 0)).toBe(false)
    expect(isEstimatedCost(12, undefined)).toBe(false)
    expect(isEstimatedCost(0, 0)).toBe(false)
  })
})
