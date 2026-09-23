import { t } from '../i18n'
import type { MenubarPayload, ProviderName } from './types'

export const PROVIDER_NAMES: Record<ProviderName, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  copilot: 'Copilot',
  antigravity: 'Antigravity',
  kimi: 'Kimi Code',
  zcode: 'ZCode',
  grokbot: 'Grok Bot',
}

/** Company named in honest copy like "Anthropic rate limited the quota endpoint". */
export const PROVIDER_OWNERS: Record<ProviderName, string> = {
  claude: 'Anthropic',
  codex: 'OpenAI',
  gemini: 'Google',
  copilot: 'GitHub',
  antigravity: 'Google',
  kimi: 'Moonshot AI',
  zcode: 'Z.ai',
  // The weekly allowance is served by Cursor's dashboard, so Cursor is who
  // rate limits it.
  grokbot: 'Cursor',
}

const ALL_PROVIDERS = Object.keys(PROVIDER_NAMES) as ProviderName[]
const DISABLED_KEY = 'codeburn.quotaDisabled'

/** Display order for quota rows (matches the electron poll order). */
export const QUOTA_PROVIDERS = Object.keys(PROVIDER_NAMES) as ProviderName[]

export function readDisabledProviders(): ProviderName[] {
  try {
    const raw = globalThis.localStorage?.getItem(DISABLED_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((p): p is ProviderName => typeof p === 'string' && ALL_PROVIDERS.includes(p as ProviderName)) : []
  } catch {
    return []
  }
}

export function writeDisabledProviders(disabled: ProviderName[]): void {
  try { globalThis.localStorage?.setItem(DISABLED_KEY, JSON.stringify(disabled)) } catch { /* storage can be unavailable in hardened contexts */ }
}

export type DetectedProvider = { id: string; label: string; cost: number; idle: boolean; excludedFromTotal?: boolean }

/**
 * Every provider the CLI found on this machine, whether or not it billed
 * anything in the selected period. `hasUsage: false` means "installed, idle this
 * period" — a reason to grey the row, never to hide a provider the user has.
 * Active providers lead by spend; idle ones follow alphabetically.
 */
// A provider id is only useful if it can round-trip as `--provider`; the main
// process rejects anything else as bad args, so an id that cannot is never
// offered as a filter or an export target.
const USABLE_PROVIDER_ID = /^[a-z0-9-]+$/

export function detectedProviders(current: MenubarPayload['current'] | undefined): DetectedProvider[] {
  if (!current) return []
  if (current.providerDetails) {
    return [...current.providerDetails]
      .filter(entry => USABLE_PROVIDER_ID.test(entry.id))
      .map(entry => ({
        id: entry.id,
        label: entry.label,
        cost: entry.cost,
        idle: entry.hasUsage === false,
        // Real spend, deliberately outside the headline: the CLI flags a
        // provider whose rows are daily aggregates the local tools already
        // report. Label it, never subtract or hide it.
        ...(entry.excludedFromTotal ? { excludedFromTotal: true as const } : {}),
      }))
      .sort((a, b) => Number(a.idle) - Number(b.idle) || (a.idle ? a.label.localeCompare(b.label) : b.cost - a.cost))
  }
  // Fallback map keys are lowercased display names; ones with spaces ("grok
  // build") cannot round-trip as --provider, so exclude them rather than offer a
  // filter that is guaranteed to error. A key that survives the shape test can
  // still be the wrong id ("KiloCode" lowercases to `kilocode`, while the CLI's
  // id is `kilo-code`): there is no display-name-to-id table on this side, and
  // any current CLI sends providerDetails above, so only a pre-details CLI can
  // reach this.
  return Object.entries(current.providers)
    .filter(([key, cost]) => cost > 0 && USABLE_PROVIDER_ID.test(key))
    .sort(([, a], [, b]) => b - a)
    .map(([key, cost]) => ({ id: key, label: providerLabel(key), cost, idle: false }))
}

/** Title-cases a lowercased provider key from the legacy providers map. */
export function providerLabel(provider: string): string {
  if (provider === 'all') return t('shell.provider.all')
  return provider
    .split(/[-\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}
