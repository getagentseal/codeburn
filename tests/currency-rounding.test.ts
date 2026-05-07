import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { convertCost, roundForActiveCurrency, getFractionDigits } from '../src/currency.js'
import { CurrencyState } from '../src/currency.js'
import * as currencyMod from '../src/currency.js'

// We poke the module-level state directly via switchCurrency for these tests.
// Each test restores USD afterwards so it doesn't bleed.
async function setActive(code: string, rate: number): Promise<void> {
  // switchCurrency does network + persistence; for unit tests we set the
  // active state directly via the module's internal state. Since the module
  // doesn't expose a setter, we go through getCurrency()'s state and patch.
  // Instead use the public switchCurrency only when offline: nope, just
  // exploit the fact that the module exports `getCurrency` which returns a
  // ref. We can't easily mock fetch. So we test only convertCost (which uses
  // active.rate) and rounding helpers — both pure functions of the state.
  const state = currencyMod.getCurrency()
  // @ts-expect-error — directly mutating for test
  state.code = code
  // @ts-expect-error
  state.rate = rate
  // @ts-expect-error
  state.symbol = code
}

beforeEach(async () => {
  await setActive('USD', 1)
})

afterEach(async () => {
  await setActive('USD', 1)
})

describe('convertCost — no rounding contract', () => {
  it('returns unrounded float for USD (rate=1)', () => {
    expect(convertCost(1.234567)).toBe(1.234567)
    expect(convertCost(0.001)).toBe(0.001)
  })

  it('returns unrounded float for non-USD currencies', async () => {
    await setActive('JPY', 150)
    // 1 USD * 150 = 150, but a fractional input must NOT be rounded by convertCost.
    expect(convertCost(0.123456)).toBeCloseTo(18.5184, 4)
    expect(convertCost(1.5)).toBe(225)
  })

  it('rounding is the caller\'s responsibility (display vs export)', async () => {
    // Regression guard: previously convertCost did its own rounding which
    // produced ¥412.37 in CSV exports while the dashboard rendered ¥412.
    // Confirm we now return the raw value and the caller decides.
    await setActive('JPY', 150)
    const raw = convertCost(2.7491)
    expect(raw).toBe(412.365)   // unrounded
    expect(roundForActiveCurrency(raw)).toBe(412)   // currency-aware rounding for export
  })
})

describe('roundForActiveCurrency', () => {
  it('USD rounds to 2 decimals', async () => {
    await setActive('USD', 1)
    expect(roundForActiveCurrency(1.2345)).toBe(1.23)
    expect(roundForActiveCurrency(1.235)).toBeCloseTo(1.24, 2)
    expect(roundForActiveCurrency(0.005)).toBe(0.01)
  })

  it('JPY rounds to whole numbers', async () => {
    await setActive('JPY', 150)
    expect(roundForActiveCurrency(412.37)).toBe(412)
    expect(roundForActiveCurrency(412.5)).toBe(413)
    expect(roundForActiveCurrency(0.4)).toBe(0)
  })

  it('KRW rounds to whole numbers', async () => {
    await setActive('KRW', 1300)
    expect(roundForActiveCurrency(15999.7)).toBe(16000)
  })

  it('EUR rounds to 2 decimals like USD', async () => {
    await setActive('EUR', 0.92)
    expect(roundForActiveCurrency(1.2345)).toBe(1.23)
  })

  it('matches the display contract: roundForActiveCurrency(convertCost(x)) is what users see', async () => {
    await setActive('JPY', 150)
    // Dashboard displays via formatCost which uses getFractionDigits=0 for JPY.
    // CSV exports must produce the same integer value, not a 2-decimal float.
    expect(roundForActiveCurrency(convertCost(2.75))).toBe(413)
    expect(roundForActiveCurrency(convertCost(2.745))).toBe(412)
  })
})

describe('getFractionDigits', () => {
  it('returns 0 for zero-fraction currencies', () => {
    expect(getFractionDigits('JPY')).toBe(0)
    expect(getFractionDigits('KRW')).toBe(0)
    expect(getFractionDigits('CLP')).toBe(0)
  })

  it('returns 2 for typical currencies', () => {
    expect(getFractionDigits('USD')).toBe(2)
    expect(getFractionDigits('EUR')).toBe(2)
    expect(getFractionDigits('GBP')).toBe(2)
    expect(getFractionDigits('INR')).toBe(2)
  })
})
