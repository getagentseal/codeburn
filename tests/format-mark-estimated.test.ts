import { describe, it, expect } from 'vitest'

import { markEstimated } from '../src/format.js'

describe('markEstimated', () => {
  it('prefixes the estimated marker when the figure is estimated', () => {
    expect(markEstimated('$1.23', true)).toBe('~$1.23')
  })

  it('leaves a measured figure untouched', () => {
    expect(markEstimated('$1.23', false)).toBe('$1.23')
  })
})
