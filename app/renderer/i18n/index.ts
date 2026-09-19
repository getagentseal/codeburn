import { createContext, useContext } from 'react'

// Catalogs are keyed by the English source sentence. `en` is the source of
// truth; Stage 2 fills the other five. Until then every lookup falls back to
// the English key, so the app renders English while being fully wired to switch.
import { en, fr, ja, ko, zhCN, zhTW } from './catalog'

/** The six concrete locales. `system` (the picker's default) follows the OS. */
export type Locale = 'en' | 'fr' | 'ja' | 'ko' | 'zh-CN' | 'zh-TW'
export type LocaleChoice = Locale | 'system'

export const LOCALES: Locale[] = ['en', 'fr', 'ja', 'ko', 'zh-CN', 'zh-TW']

const CATALOGS: Record<Locale, Record<string, string>> = { en, fr, ja, ko, 'zh-CN': zhCN, 'zh-TW': zhTW }

export function isLocale(value: string): value is Locale {
  return (LOCALES as string[]).includes(value)
}

export function isLocaleChoice(value: string): value is LocaleChoice {
  return value === 'system' || isLocale(value)
}

/**
 * Normalize a locale-ish string ("zh_TW.UTF-8", "ZH-hk", "fr-CA", "ja") to a
 * supported Locale, or null when unsupported. Traditional-Chinese regions map
 * to zh-TW; every other zh variant maps to zh-CN.
 */
export function normalizeLocale(value: string | undefined): Locale | null {
  if (!value) return null
  const v = value.trim().toLowerCase().replace(/-/g, '_').split(/[.:]/)[0]!
  if (!v) return null
  if (v === 'en' || v.startsWith('en_')) return 'en'
  if (v.startsWith('zh')) {
    if (v === 'zh_tw' || v === 'zh_hk' || v === 'zh_mo' || v === 'zh_hant') return 'zh-TW'
    return 'zh-CN'
  }
  if (v.startsWith('ja')) return 'ja'
  if (v.startsWith('ko')) return 'ko'
  if (v.startsWith('fr')) return 'fr'
  return null
}

/** Resolve the OS/app language tag to a concrete Locale, defaulting to English. */
export function resolveSystemLocale(appLocaleTag: string | undefined): Locale {
  return normalizeLocale(appLocaleTag) ?? 'en'
}

/** The effective locale for a choice: 'system' follows the OS, else the choice. */
export function effectiveLocale(choice: LocaleChoice, appLocaleTag: string | undefined): Locale {
  return choice === 'system' ? resolveSystemLocale(appLocaleTag) : choice
}

/**
 * Translate one user-facing string, keyed by its English copy. An untranslated
 * key degrades to the English catalog and then to the key itself (which is the
 * English sentence) — never a raw identifier. `{name}` placeholders interpolate;
 * unknown placeholders are left literal.
 */
export function translate(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const template = CATALOGS[locale][key] ?? en[key] ?? key
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m))
}

/** Non-React callers (formatters) read the current locale from this module. */
let currentLocale: Locale = 'en'

export function setCurrentLocale(locale: Locale): void {
  currentLocale = locale
}

/**
 * The BCP-47 tag the Intl formatters use for the current locale. English maps
 * to en-US so existing English output stays byte-identical; the others are
 * already valid Intl tags. Formatting only — digit values never change.
 */
export function localeTag(): string {
  return currentLocale === 'en' ? 'en-US' : currentLocale
}

/** The t() components import. React binding lives in LocaleContext (App.tsx). */
export function t(key: string, vars?: Record<string, string | number>): string {
  return translate(currentLocale, key, vars)
}

export type LocaleContextValue = {
  locale: Locale
  /** The effective choice including 'system', for the Settings picker. */
  choice: LocaleChoice
  setChoice: (choice: LocaleChoice) => void
}

export const LocaleContext = createContext<LocaleContextValue>({
  locale: 'en',
  choice: 'system',
  setChoice: () => {},
})

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext)
}
