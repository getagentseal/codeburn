import { beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetGeneration, generationAt, generationHeadline, generationModels, periodTotalsBreach, rememberGeneration, type PeriodTotals } from './generation'
import type { MenubarPayload } from './types'

const MODELS = [{ name: 'gen-opus', cost: 400, savingsUSD: 0, savingsBaselineModel: '', calls: 200 }] as MenubarPayload['current']['topModels']

function payloadWithModels(periodTotals: PeriodTotals, models: MenubarPayload['current']['topModels']): MenubarPayload {
  return { periodTotals, current: { topModels: models } } as MenubarPayload
}

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

describe('generationModels', () => {
  it('serves the models when the generation is newer and captured from the shown period', () => {
    rememberGeneration(payloadWithModels(totals(), MODELS), 2_000, '30days')
    expect(generationModels('30days', 1_000)).toEqual(MODELS)
  })

  it('withholds the models when the generation was captured from another period', () => {
    rememberGeneration(payloadWithModels(totals(), MODELS), 2_000, 'week')
    // The headline can still take the 30days total, but the models belong to week.
    expect(generationHeadline('30days', 1_000)).toEqual({ cost: 14000, calls: 87000 })
    expect(generationModels('30days', 1_000)).toBeNull()
  })

  it('withholds the models when the payload on screen is already the newest', () => {
    rememberGeneration(payloadWithModels(totals(), MODELS), 1_000, '30days')
    expect(generationModels('30days', 1_000)).toBeNull()
  })

  it('withholds an empty model list rather than blanking the table', () => {
    rememberGeneration(payloadWithModels(totals(), []), 2_000, '30days')
    expect(generationModels('30days', 1_000)).toBeNull()
  })
})
