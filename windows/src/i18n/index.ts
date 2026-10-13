// Menubar copy. Keys are the English sentence, the same contract as the macOS app
// (`mac/Sources/CodeBurnMenubar/Localization.swift`). `mac-catalog.json` is generated
// from that app's Localizable.strings; `extra.json` holds strings that exist only
// in this Windows port. A missing translation renders the English key.

import { useSyncExternalStore } from 'react'
import macCatalog from './mac-catalog.json'
import extraCatalog from './extra.json'

export const LOCALES = ['en', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'] as const
export type Locale = (typeof LOCALES)[number]
export type LanguageChoice = 'system' | Locale

type Table = Record<string, string>
type Catalog = Record<string, Table>

const mac = macCatalog as Catalog
const extra = extraCatalog as Catalog

const listeners = new Set<() => void>()
let choice: LanguageChoice = 'system'
let locale: Locale = resolveChoice('system')

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value)
}

export function isLanguageChoice(value: string): value is LanguageChoice {
  return value === 'system' || isLocale(value)
}

/**
 * "zh_TW.UTF-8", "zh-HK", "zh-CN", "fr-CA" → a shipped locale, or null.
 * Traditional-Chinese regions map to zh-Hant; every other zh variant maps to zh-Hans.
 */
export function normalizeLocale(value: string | undefined | null): Locale | null {
  if (!value) return null
  const v = value.trim().toLowerCase().replace(/-/g, '_')
  const primary = v.split(/[.:]/)[0] ?? ''
  if (!primary) return null
  if (primary.startsWith('zh')) {
    if (primary === 'zh_tw' || primary === 'zh_hk' || primary === 'zh_mo' || primary === 'zh_hant' || v.includes('hant')) {
      return 'zh-Hant'
    }
    return 'zh-Hans'
  }
  if (primary.startsWith('ja')) return 'ja'
  if (primary.startsWith('ko')) return 'ko'
  if (primary.startsWith('fr')) return 'fr'
  if (primary.startsWith('en')) return 'en'
  return null
}

export function resolveChoice(next: LanguageChoice, systemTag?: string | null): Locale {
  if (next !== 'system') return next
  const tag = systemTag ?? (typeof navigator !== 'undefined' ? navigator.language : undefined)
  return normalizeLocale(tag) ?? 'en'
}

export function currentLocale(): Locale {
  return locale
}

export function currentChoice(): LanguageChoice {
  return choice
}

/** Point later t() calls at this choice. Notifies subscribers when the locale changes. */
export function applyLanguage(next: LanguageChoice, systemTag?: string | null): void {
  choice = next
  const resolved = resolveChoice(next, systemTag)
  if (resolved === locale) return
  locale = resolved
  for (const listener of listeners) listener()
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, currentLocale, currentLocale)
}

/** BCP-47 tag for Intl formatters. English stays en-US so existing English output is unchanged. */
export function localeTag(): string {
  if (locale === 'en') return 'en-US'
  if (locale === 'zh-Hans') return 'zh-CN'
  if (locale === 'zh-Hant') return 'zh-TW'
  return locale
}

function lookup(key: string): string {
  // macOS Localizable.strings wins when it has the sentence. extra.json is only
  // for copy that does not exist there, so a Simplified entry cannot mask zh-Hant.
  return mac[locale]?.[key] ?? extra[locale]?.[key] ?? mac.en?.[key] ?? extra.en?.[key] ?? key
}

/**
 * Fill a catalog template. `%@` and `%lld` are sequential; `%1$@` / `%2$lld` are
 * positional. `%%` is a literal percent. Already-formatted numbers and names go
 * in as strings so this does not regroup them.
 */
export function formatTemplate(template: string, args: Array<string | number>): string {
  let seq = 0
  return template.replace(/%%|%(\d+)\$@|%(\d+)\$lld|%@|%lld/g, (match, atPos: string, lldPos: string) => {
    if (match === '%%') return '%'
    const index = atPos || lldPos ? Number(atPos || lldPos) - 1 : seq++
    const value = args[index]
    return value === undefined ? match : String(value)
  })
}

export function t(key: string, ...args: Array<string | number>): string {
  const template = lookup(key)
  return args.length === 0 ? template : formatTemplate(template, args)
}

/** Translate the `label` of each option at render time, so a language change is picked up. */
export function labels<T extends { label: string }>(rows: readonly T[]): T[] {
  return rows.map(row => ({ ...row, label: t(row.label) }))
}
