import { describe, expect, it } from 'vitest'

import { en, fr, ja, ko, zhCN, zhTW } from './catalog'
import { effectiveLocale, normalizeLocale, translate } from './index'

const PROJECT_SCOPE_KEYS = [
  'shell.projectScope.trigger',
  'shell.projectScope.all',
  'shell.projectScope.search',
  'shell.projectScope.loading',
  'shell.projectScope.noPermitted',
  'shell.projectScope.noMatches',
  'shell.projectScope.loadError',
  'shell.projectScope.retry',
  'shell.projectScope.pathUnavailable',
  'shell.projectScope.footer',
  'settings.scope.hintProjectSelected',
]

describe('t() fallback', () => {
  it('returns the English key when a locale has no translation', () => {
    // Keys are English sentences, so the fallback is real English, never an id.
    expect(translate('fr', 'Today')).toBe('Today')
    expect(translate('zh-CN', 'Session count unavailable')).toBe('Session count unavailable')
  })

  it('interpolates {name} placeholders and leaves unknown ones literal', () => {
    expect(translate('en', '{count} sessions', { count: 3 })).toBe('3 sessions')
    expect(translate('en', '{count} of {total}', { count: 3 })).toBe('3 of {total}')
  })
})

describe('locale resolution', () => {
  it('normalizes OS locale strings to supported locales', () => {
    expect(normalizeLocale('zh_TW.UTF-8')).toBe('zh-TW')
    expect(normalizeLocale('zh-HK')).toBe('zh-TW')
    expect(normalizeLocale('zh-CN')).toBe('zh-CN')
    expect(normalizeLocale('fr-CA')).toBe('fr')
    expect(normalizeLocale('de-DE')).toBeNull()
  })

  it('follows the config choice first, then the OS locale', () => {
    // Explicit choice wins over the OS locale.
    expect(effectiveLocale('ja', 'fr-FR')).toBe('ja')
    // 'system' falls back to the OS locale...
    expect(effectiveLocale('system', 'zh-TW')).toBe('zh-TW')
    // ...and to English when the OS locale is unsupported.
    expect(effectiveLocale('system', 'de-DE')).toBe('en')
  })
})

describe('project scope copy', () => {
  it('has translated picker and Settings copy in every supported locale', () => {
    const catalogs = { en, fr, ja, ko, 'zh-CN': zhCN, 'zh-TW': zhTW }
    for (const [locale, catalog] of Object.entries(catalogs)) {
      for (const key of PROJECT_SCOPE_KEYS) {
        expect({ locale, key, value: catalog[key] }).toEqual(expect.objectContaining({ locale, key }))
        expect(catalog[key]).toBeTruthy()
        expect(catalog[key]).not.toBe(key)
      }
    }
  })
})
