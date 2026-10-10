import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { formatCost, getCurrency, loadCurrency, switchCurrency } from '../src/currency.js'

const DAY_MS = 24 * 60 * 60 * 1000
let dir: string

async function seedRate(code: string, rate: number, ageMs: number): Promise<void> {
  await writeFile(join(dir, 'cache', 'exchange-rate.json'), JSON.stringify({ timestamp: Date.now() - ageMs, code, rate }))
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'codeburn-fx-'))
  await mkdir(join(dir, 'cache'), { recursive: true })
  process.env['CODEBURN_CACHE_DIR'] = join(dir, 'cache')
  process.env['HOME'] = dir
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await switchCurrency('USD')
  await rm(dir, { recursive: true, force: true })
})

describe('FX fallback with no fresh rate', () => {
  it('shows USD code and symbol when fetching is off and nothing is cached', async () => {
    await switchCurrency('EUR')
    expect(getCurrency()).toEqual({ code: 'USD', rate: 1, symbol: '$' })
    expect(formatCost(2)).toBe('$2.00')
  })

  it('uses a stale cached rate when fetching is off', async () => {
    await seedRate('EUR', 0.9, 30 * DAY_MS)
    await switchCurrency('EUR')
    expect(getCurrency()).toMatchObject({ code: 'EUR', rate: 0.9 })
  })

  it('ignores a cached rate for another currency', async () => {
    await seedRate('GBP', 0.8, 30 * DAY_MS)
    await switchCurrency('EUR')
    expect(getCurrency().code).toBe('USD')
  })

  describe('when the fetch fails', () => {
    beforeEach(() => {
      delete process.env['CODEBURN_FX_NO_FETCH']
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    })

    it('uses the last cached rate whatever its age', async () => {
      await seedRate('JPY', 150, 400 * DAY_MS)
      await switchCurrency('JPY')
      expect(getCurrency()).toMatchObject({ code: 'JPY', rate: 150, symbol: '¥' })
    })

    it('falls back to USD from config when nothing is cached', async () => {
      await mkdir(join(dir, '.config', 'codeburn'), { recursive: true })
      await writeFile(join(dir, '.config', 'codeburn', 'config.json'), JSON.stringify({ currency: { code: 'EUR', symbol: 'E' } }))
      await loadCurrency()
      expect(getCurrency()).toEqual({ code: 'USD', rate: 1, symbol: '$' })
      expect(formatCost(2)).toBe('$2.00')
    })
  })
})
