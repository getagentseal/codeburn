import { beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetGeneration, generationAt, generationHeadline, periodTotalsBreach, rememberGeneration, type PeriodTotals } from './generation'
import type { MenubarPayload } from './types'

function totals(over: Partial<Record<keyof PeriodTotals, [number, number]>> = {}): PeriodTotals {
  const base: Record<string, [number, number]> = {
    today: [700, 6000],
    week: [1900, 15000],
    '30days': [14000, 87000],
    month: [4700, 29000],
    all: [37700, 270000],
    lifetime: [37800, 272000],
    ...over,
  }
  return Object.fromEntries(Object.entries(base).map(([k, [cost, calls]]) => [k, { cost, calls }])) as PeriodTotals
}

function payload(periodTotals: PeriodTotals | undefined): MenubarPayload {
  return { periodTotals } as MenubarPayload
}

beforeEach(__resetGeneration)

describe('periodTotalsBreach', () => {
  it('accepts nested windows', () => {
    expect(periodTotalsBreach(totals())).toBeNull()
  })

  it('catches a wider window costing less than a narrower one', () => {
    expect(periodTotalsBreach(totals({ lifetime: [37000, 272000] }))).toMatch(/lifetime cost/)
  })

  it('catches calls going backwards, the Lifetime-under-6M case', () => {
    expect(periodTotalsBreach(totals({ lifetime: [37800, 269000] }))).toMatch(/lifetime calls/)
  })

  it('skips a window the generation does not carry rather than comparing across the gap', () => {
    const partial = totals({ lifetime: [10, 10] })
    delete partial.all
    delete partial['30days']
    expect(periodTotalsBreach(partial)).toMatch(/lifetime/)
    const scanned = totals()
    delete scanned.all
    expect(periodTotalsBreach(scanned)).toBeNull()
  })

  it('tolerates a cent of float drift between two sums', () => {
    expect(periodTotalsBreach(totals({ all: [37800.004, 272000] , lifetime: [37800, 272000] }))).toBeNull()
  })
})

describe('rememberGeneration', () => {
  it('serves a period from a generation newer than the payload on screen', () => {
    rememberGeneration(payload(totals()), 2_000)
    expect(generationHeadline('today', 1_000)).toEqual({ cost: 700, calls: 6000 })
    expect(generationHeadline('lifetime', 1_000)).toEqual({ cost: 37800, calls: 272000 })
    expect(generationAt()).toBe(2_000)
  })

  it('never replaces a payload that is itself the newest answer', () => {
    rememberGeneration(payload(totals()), 1_000)
    expect(generationHeadline('today', 1_000)).toBeNull()
    expect(generationHeadline('today', 5_000)).toBeNull()
  })

  it('does not answer for a window the scan did not cover', () => {
    const scanned = totals()
    delete scanned.lifetime
    delete scanned.all
    rememberGeneration(payload(scanned), 2_000)
    expect(generationHeadline('today', 1_000)).toEqual({ cost: 700, calls: 6000 })
    expect(generationHeadline('lifetime', 1_000)).toBeNull()
  })

  it('keeps the newest generation and ignores an older payload arriving late', () => {
    rememberGeneration(payload(totals()), 3_000)
    rememberGeneration(payload(totals({ today: [1, 1] })), 2_000)
    expect(generationHeadline('today', 1_000)).toEqual({ cost: 700, calls: 6000 })
    expect(generationAt()).toBe(3_000)
  })

  it('holds the last good generation when a payload carries no totals', () => {
    rememberGeneration(payload(totals()), 2_000)
    rememberGeneration(payload(undefined), 5_000)
    expect(generationHeadline('all', 1_000)).toEqual({ cost: 37700, calls: 270000 })
    expect(generationAt()).toBe(2_000)
  })

  it('reports a non-nested generation in dev instead of showing it silently', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    rememberGeneration(payload(totals({ lifetime: [1, 1] })), 1_000)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('not nested'))
    error.mockRestore()
  })
})
