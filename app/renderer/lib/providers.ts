import type { ProviderName } from './types'

export const PROVIDER_NAMES: Record<ProviderName, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  copilot: 'Copilot',
  antigravity: 'Antigravity',
  kimi: 'Kimi Code',
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
