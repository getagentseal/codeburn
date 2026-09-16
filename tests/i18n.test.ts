import { afterEach, describe, expect, it } from 'vitest'
import { Chalk } from 'chalk'

import { en } from '../src/i18n/en.js'
import { zhCN } from '../src/i18n/zh-cn.js'
import { zhTW } from '../src/i18n/zh-tw.js'
import { ja } from '../src/i18n/ja.js'
import { ko } from '../src/i18n/ko.js'
import { fr } from '../src/i18n/fr.js'
import {
  displayWidth,
  fmt,
  forceLocale,
  getCatalog,
  isLocale,
  localizedCategory,
  normalizeLocale,
  padEndDisplay,
  padStartDisplay,
  resolveLocale,
  type Locale,
} from '../src/i18n/index.js'
import { renderOverview, renderTable } from '../src/overview.js'
import { renderStatusBar, carriedCostNote } from '../src/format.js'
import { formatSessionCountLocalized } from '../src/session-count-label.js'

const ALL: Record<Locale, typeof en> = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, ja, ko, fr }

afterEach(() => {
  forceLocale(null)
  delete process.env.CODEBURN_LANG
})

function keyPaths(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') return [prefix]
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => keyPaths(v, prefix ? `${prefix}.${k}` : k))
  }
  return [prefix]
}

describe('catalog parity', () => {
  it('every locale defines exactly the en key set', () => {
    const base = keyPaths(en).sort()
    for (const [locale, catalog] of Object.entries(ALL)) {
      expect(keyPaths(catalog).sort(), locale).toEqual(base)
    }
  })

  it('no empty strings in any locale', () => {
    for (const [locale, catalog] of Object.entries(ALL)) {
      for (const path of keyPaths(catalog)) {
        const value = path.split('.').reduce<unknown>((acc, k) => (acc as Record<string, unknown>)[k], catalog)
        expect(typeof value === 'string' && value.length > 0, `${locale}:${path}`).toBe(true)
      }
    }
  })
})

describe('normalizeLocale', () => {
  it('maps regional forms to supported locales', () => {
    expect(normalizeLocale('zh_CN.UTF-8')).toBe('zh-CN')
    expect(normalizeLocale('zh-CN')).toBe('zh-CN')
    expect(normalizeLocale('ZH_tw')).toBe('zh-TW')
    expect(normalizeLocale('zh_HK')).toBe('zh-TW')
    expect(normalizeLocale('ja_JP.UTF-8')).toBe('ja')
    expect(normalizeLocale('ko')).toBe('ko')
    expect(normalizeLocale('fr_FR')).toBe('fr')
    expect(normalizeLocale('en_GB')).toBe('en')
  })

  it('rejects unsupported and empty values', () => {
    expect(normalizeLocale('de_DE')).toBeNull()
    expect(normalizeLocale('')).toBeNull()
    expect(normalizeLocale(undefined)).toBeNull()
  })

  it('isLocale agrees with the supported set', () => {
    expect(isLocale('zh-CN')).toBe(true)
    expect(isLocale('pt-BR')).toBe(false)
  })
})

describe('resolveLocale', () => {
  it('defaults to en under vitest even with a CJK host LANG', () => {
    expect(resolveLocale()).toBe('en')
  })

  it('CODEBURN_LANG wins over the host environment', () => {
    process.env.CODEBURN_LANG = 'ja_JP.UTF-8'
    // drop the memo so the env is re-read
    forceLocale(null)
    expect(resolveLocale()).toBe('ja')
  })

  it('forceLocale overrides everything (machine-format contract)', () => {
    process.env.CODEBURN_LANG = 'ko'
    forceLocale('en')
    expect(resolveLocale()).toBe('en')
    expect(getCatalog()).toBe(en)
  })
})

describe('display width', () => {
  it('counts CJK glyphs as two columns', () => {
    expect(displayWidth('Cost')).toBe(4)
    expect(displayWidth('成本')).toBe(4)
    expect(displayWidth('キャッシュ読取')).toBe(14)
  })

  it('ignores ANSI color escapes', () => {
    const c = new Chalk({})
    expect(displayWidth(c.red('成本'))).toBe(4)
  })

  it('pads by display width so CJK tables align', () => {
    expect(displayWidth(padEndDisplay('成本', 6))).toBe(6)
    expect(displayWidth(padStartDisplay('coût', 8))).toBe(8)
    expect(padEndDisplay('ab', 2)).toBe('ab')
  })
})

describe('fmt', () => {
  it('substitutes placeholders and leaves unknown ones literal', () => {
    expect(fmt('{n} calls', { n: 3 })).toBe('3 calls')
    expect(fmt('{a} {b}', { a: 1 })).toBe('1 {b}')
  })
})

describe('localized render surfaces', () => {
  it('renderOverview empty state follows the locale', () => {
    forceLocale('zh-CN')
    expect(renderOverview([], { label: '九月', color: false })).toContain('未找到 九月 的使用数据。')
    forceLocale('en')
    expect(renderOverview([], { label: 'September', color: false })).toContain('No usage found for September.')
  })

  it('renderStatusBar headline follows the locale', () => {
    const totals = { today: { cost: 1, calls: 2 }, month: { cost: 3, calls: 4 } }
    forceLocale('ja')
    expect(renderStatusBar([], totals)).toContain('今日')
    forceLocale('fr')
    expect(renderStatusBar([], totals)).toContain("Aujourd'hui")
    forceLocale('en')
    expect(renderStatusBar([], totals)).toContain('Today')
  })

  it('carriedCostNote follows the locale', () => {
    forceLocale('zh-CN')
    expect(carriedCostNote(1.5) ?? '').toContain('来自已过期会话日志的保留计数')
    forceLocale('en')
    expect(carriedCostNote(1.5)).toBe('includes $1.50 preserved from expired session logs')
  })

  it('session counts follow the locale', () => {
    forceLocale('zh-CN')
    expect(formatSessionCountLocalized(1, 'identity')).toBe('1 个会话')
    expect(formatSessionCountLocalized(5, 'partial')).toBe('至少 5 个会话')
    forceLocale('en')
    expect(formatSessionCountLocalized(1, 'identity')).toBe('1 session')
  })

  it('categories localize with passthrough for unknown ids', () => {
    forceLocale('ko')
    expect(localizedCategory('coding')).toBe('코딩')
    expect(localizedCategory('build/deploy')).toBe('빌드/배포')
    expect(localizedCategory('brand-new-category')).toBe('brand-new-category')
  })

  it('CJK table columns stay aligned', () => {
    forceLocale('zh-CN')
    const c = new Chalk({ level: 0 })
    const L = getCatalog()
    const table = renderTable(
      c,
      [
        { header: L.headers.type },
        { header: L.headers.tokens, right: true },
        { header: L.headers.share, right: true },
      ],
      [
        [L.headers.input, '1,234', '10%'],
        [L.headers.cacheOut, '99,999,999', '85%'],
      ],
    )
    const widths = new Set(table.split('\n').map((line) => displayWidth(line)))
    expect(widths.size).toBe(1)
  })
})
