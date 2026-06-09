import { describe, expect, it } from 'vitest'

import { isPositiveNumber, safeNumber } from '../src/parser.js'

describe('safeNumber', () => {
  it('returns positive finite numbers unchanged', () => {
    expect(safeNumber(1)).toBe(1)
    expect(safeNumber(0.25)).toBe(0.25)
  })

  it('normalizes non-positive numbers to zero', () => {
    expect(safeNumber(0)).toBe(0)
    expect(safeNumber(-1)).toBe(0)
  })

  it('normalizes non-finite numbers to zero', () => {
    expect(safeNumber(Number.NaN)).toBe(0)
    expect(safeNumber(Number.POSITIVE_INFINITY)).toBe(0)
    expect(safeNumber(Number.NEGATIVE_INFINITY)).toBe(0)
  })

  it('normalizes non-number values to zero', () => {
    expect(safeNumber('12')).toBe(0)
    expect(safeNumber(null)).toBe(0)
    expect(safeNumber(undefined)).toBe(0)
    expect(safeNumber({ value: 12 })).toBe(0)
  })
})

describe('isPositiveNumber', () => {
  it('returns true for positive finite numbers', () => {
    expect(isPositiveNumber(1)).toBe(true)
    expect(isPositiveNumber(0.25)).toBe(true)
  })

  it('returns false for zero and negative numbers', () => {
    expect(isPositiveNumber(0)).toBe(false)
    expect(isPositiveNumber(-1)).toBe(false)
  })

  it('returns false for non-finite numbers', () => {
    expect(isPositiveNumber(Number.NaN)).toBe(false)
    expect(isPositiveNumber(Number.POSITIVE_INFINITY)).toBe(false)
    expect(isPositiveNumber(Number.NEGATIVE_INFINITY)).toBe(false)
  })

  it('returns false for non-number values', () => {
    expect(isPositiveNumber('12')).toBe(false)
    expect(isPositiveNumber(null)).toBe(false)
    expect(isPositiveNumber(undefined)).toBe(false)
    expect(isPositiveNumber({ value: 12 })).toBe(false)
  })
})
