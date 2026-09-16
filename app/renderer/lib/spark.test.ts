import { describe, expect, it } from 'vitest'

import { paceDirection, sparkArea, sparkPath, sparkPoints } from './spark'

describe('sparkPoints', () => {
  it('spreads the series across the width and puts the peak at the top inset', () => {
    expect(sparkPoints([0, 5, 10], 100, 40, 3)).toEqual([
      [3, 37],
      [50, 20],
      [97, 3],
    ])
  })

  it('draws a flat all-zero series on the baseline instead of dividing by zero', () => {
    expect(sparkPoints([0, 0, 0], 100, 40, 3)).toEqual([[3, 37], [50, 37], [97, 37]])
  })

  it('places a single point on the left inset', () => {
    expect(sparkPoints([7], 100, 40, 3)).toEqual([[3, 3]])
  })

  it('returns nothing for an empty series', () => {
    expect(sparkPoints([], 100, 40)).toEqual([])
  })
})

describe('sparkPath', () => {
  it('joins two points with one cubic whose handles follow the segment slope', () => {
    expect(sparkPath([[0, 10], [10, 0]])).toBe('M0 10 C3.33 6.67 6.67 3.33 10 0')
  })

  it('flattens the tangent at a local extreme so the curve never overshoots the data', () => {
    // The middle pair is level, so the curve must arrive and leave it flat.
    expect(sparkPath([[0, 30], [10, 20], [20, 20], [30, 0]]))
      .toBe('M0 30 C3.33 26.67 6.67 20 10 20 C13.33 20 16.67 20 20 20 C23.33 20 26.67 6.67 30 0')
  })

  it('keeps a monotone rise monotone: no control point sits below the lower endpoint', () => {
    const d = sparkPath([[0, 40], [10, 30], [20, 10], [30, 0]])
    const ys = d.match(/-?[\d.]+/g)!.map(Number).filter((_, index) => index % 2 === 1)
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...ys)).toBeLessThanOrEqual(40)
  })

  it('is a bare move for a single point', () => {
    expect(sparkPath([[5, 5]])).toBe('M5 5')
  })

  it('is empty for an empty series', () => {
    expect(sparkPath([])).toBe('')
  })
})

describe('sparkArea', () => {
  it('closes the curve down to the baseline', () => {
    expect(sparkArea([[0, 10], [10, 0]], 40)).toBe('M0 10 C3.33 6.67 6.67 3.33 10 0 L10 40 L0 40 Z')
  })

  it('needs two points to enclose anything', () => {
    expect(sparkArea([[0, 10]], 40)).toBe('')
  })
})

describe('paceDirection', () => {
  it('reads spending under the comparison as good', () => {
    expect(paceDirection(-30)).toBe('good')
  })

  it('reads spending over the comparison as bad', () => {
    expect(paceDirection(12)).toBe('bad')
  })

  it('treats dead level as bad, not good: it is not under the comparison', () => {
    expect(paceDirection(0)).toBe('bad')
  })
})
