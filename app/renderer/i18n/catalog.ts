// Translation catalogs, merged from per-section modules in ./catalogs.
//
// `en` is the source of truth. Each section module (settings, overview, …)
// carries its own keys for all six locales; this file flattens them into the
// six records translate() reads. A missing key falls through to `en`, so an
// untranslated string renders English, never a raw identifier.
//
// Keys are dotted and grouped by section (e.g. settings.theme.label). To add a
// section, create ./catalogs/<name>.ts exporting a SectionCatalog and list it in
// SECTIONS below. catalog.test.ts asserts every en key exists in all five others.

import type { SectionCatalog } from './catalogs/types'
import { common } from './catalogs/common'
import { settings } from './catalogs/settings'
import { overview } from './catalogs/overview'
import { sessions } from './catalogs/sessions'
import { plans } from './catalogs/plans'
import { plugins } from './catalogs/plugins'
import { models } from './catalogs/models'
import { compare } from './catalogs/compare'
import { pullRequests } from './catalogs/pullRequests'
import { spend } from './catalogs/spend'
import { onboarding } from './catalogs/onboarding'
import { shell } from './catalogs/shell'
import { shared } from './catalogs/shared'

const SECTIONS: SectionCatalog[] = [
  common,
  settings,
  overview,
  sessions,
  plans,
  plugins,
  models,
  compare,
  pullRequests,
  spend,
  onboarding,
  shell,
  shared,
]

function merge(pick: (s: SectionCatalog) => Record<string, string>): Record<string, string> {
  return Object.assign({}, ...SECTIONS.map(pick))
}

export const en: Record<string, string> = merge(s => s.en)
export const fr: Record<string, string> = merge(s => s.fr)
export const ja: Record<string, string> = merge(s => s.ja)
export const ko: Record<string, string> = merge(s => s.ko)
export const zhCN: Record<string, string> = merge(s => s.zhCN)
export const zhTW: Record<string, string> = merge(s => s.zhTW)
