import { readFileSync } from 'fs'

import { en, type Catalog } from './en.js'
import { zhCN } from './zh-cn.js'
import { zhTW } from './zh-tw.js'
import { ja } from './ja.js'
import { ko } from './ko.js'
import { fr } from './fr.js'
import { getConfigFilePath } from '../config.js'

export type Locale = 'en' | 'zh-CN' | 'zh-TW' | 'ja' | 'ko' | 'fr'

export const LOCALES: Locale[] = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'fr']

const CATALOGS: Record<Locale, Catalog> = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, ja, ko, fr }

export function isLocale(value: string): value is Locale {
  return (LOCALES as string[]).includes(value)
}

/// Machine-readable outputs (menubar-json, json, csv exports, MCP) keep the
/// English catalog so GUI clients and contract tests never see translated
/// field labels. Set for the whole process before any render happens.
let forced: Locale | null = null

export function forceLocale(locale: Locale | null): void {
  forced = locale
  resolved = null
}

/// Normalize a locale-ish string ("zh_CN.UTF-8", "ZH-tw", "ja") to a supported
/// Locale, or null when unsupported. Traditional-Chinese regions map to zh-TW;
/// every other zh variant maps to zh-CN.
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

/// Sync, memoized peek at config `language` (readConfig is async; locale
/// resolution must stay sync so render helpers can call it anywhere).
let configLanguage: string | null | undefined

function readConfigLanguage(): string | null {
  if (configLanguage !== undefined) return configLanguage
  try {
    const raw = readFileSync(getConfigFilePath(), 'utf8')
    const parsed = JSON.parse(raw) as { language?: unknown }
    configLanguage = typeof parsed.language === 'string' ? parsed.language : null
  } catch {
    configLanguage = null
  }
  return configLanguage
}

/** Test/CLI hook: drop the memo after config.json changes on disk. */
export function reloadLocaleConfig(): void {
  configLanguage = undefined
  resolved = null
}

let resolved: Locale | null = null

/// Resolution order: process override (machine formats) > config `language`
/// (codeburn language zh-CN) > CODEBURN_LANG > LANG/LC_ALL > en.
/// Under vitest the host LANG/LC_ALL are ignored so suites stay hermetic on
/// any developer machine; CODEBURN_LANG still works for explicit test setup.
export function resolveLocale(): Locale {
  if (forced) return forced
  if (resolved) return resolved
  const fromConfig = normalizeLocale(readConfigLanguage() ?? undefined)
  const hermetic = Boolean(process.env.VITEST)
  const fromEnv =
    normalizeLocale(process.env.CODEBURN_LANG) ??
    (hermetic ? null : normalizeLocale(process.env.LC_ALL) ?? normalizeLocale(process.env.LANG))
  resolved = fromConfig ?? fromEnv ?? 'en'
  return resolved
}

export function getCatalog(): Catalog {
  return CATALOGS[resolveLocale()]
}

/** Replace {key} placeholders; unknown placeholders stay literal. */
export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}

/// Translate a TaskCategory id ("coding", "build/deploy", ...) for display.
/// Unknown ids pass through untouched so new categories never render as a
/// blank cell before their catalog entry lands.
export function localizedCategory(cat: string): string {
  const key = cat === 'build/deploy' ? 'buildDeploy' : cat
  const labels = getCatalog().categories as Record<string, string>
  return labels[key] ?? cat
}

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
}

/// Terminal display width: East Asian Wide/Fullwidth codepoints occupy two
/// columns, so CJK table headers must pad by width, not by codepoint count.
/// ANSI color escapes contribute zero.
export function displayWidth(s: string): number {
  const plain = s.replace(ANSI_RE, '')
  let w = 0
  for (const ch of plain) {
    const cp = ch.codePointAt(0)!
    w += isWide(cp) ? 2 : 1
  }
  return w
}

export function padEndDisplay(s: string, width: number): string {
  const gap = width - displayWidth(s)
  return gap > 0 ? s + ' '.repeat(gap) : s
}

export function padStartDisplay(s: string, width: number): string {
  const gap = width - displayWidth(s)
  return gap > 0 ? ' '.repeat(gap) + s : s
}
