import { describe, expect, it } from 'vitest'

import { en, fr, ja, ko, zhCN, zhTW } from './catalog'

const OTHERS: Record<string, Record<string, string>> = { fr, ja, ko, 'zh-CN': zhCN, 'zh-TW': zhTW }
const enKeys = Object.keys(en)

describe('catalog completeness', () => {
  it('en has keys', () => {
    expect(enKeys.length).toBeGreaterThan(0)
  })

  for (const [name, catalog] of Object.entries(OTHERS)) {
    it(`${name} has every en key and no extras`, () => {
      const missing = enKeys.filter(k => !(k in catalog))
      const extra = Object.keys(catalog).filter(k => !(k in en))
      expect({ locale: name, missing, extra }).toEqual({ locale: name, missing: [], extra: [] })
    })
  }

  it('all six catalogs have equal key counts', () => {
    const counts = { en: enKeys.length, fr: Object.keys(fr).length, ja: Object.keys(ja).length, ko: Object.keys(ko).length, 'zh-CN': Object.keys(zhCN).length, 'zh-TW': Object.keys(zhTW).length }
    const unique = new Set(Object.values(counts))
    expect({ counts, unique: [...unique] }).toEqual({ counts, unique: [enKeys.length] })
  })

  it('every placeholder in en appears in each translation', () => {
    const vars = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort()
    for (const [name, catalog] of Object.entries(OTHERS)) {
      for (const key of enKeys) {
        if (!(key in catalog)) continue
        expect({ locale: name, key, vars: vars(catalog[key]!) }).toEqual({ locale: name, key, vars: vars(en[key]!) })
      }
    }
  })
})
