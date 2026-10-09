import { REFRESH_OPTIONS } from '../../app/renderer/lib/refreshCadence'
import type { Period, ProviderName } from '../../app/renderer/lib/types'
import type { StatusBarFormat } from '../../app/renderer/vscode/summary'

export type Settings = {
  workspaceOnly: boolean
  defaultPeriod: Period
  refreshInterval: string
  statusBarFormat: StatusBarFormat
  currency: string
  provider: string
  quotaProviders: ProviderName[]
  nodePath: string
}

const PERIODS: Period[] = ['today', 'week', '30days', 'month', 'all', 'lifetime']
const FORMATS: StatusBarFormat[] = ['cost', 'costAndQuota', 'workspace', 'hidden']
export const QUOTA_PROVIDERS: ProviderName[] = ['claude', 'codex', 'gemini', 'copilot', 'antigravity', 'kimi', 'zcode', 'grokbot']

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback
}

/** Every `codeburn.*` setting, validated: a hand-edited settings.json can hold anything. */
export function readSettings(get: (key: string) => unknown): Settings {
  const quota = get('quotaProviders')
  const currency = get('currency')
  const provider = get('provider')
  const nodePath = get('nodePath')
  return {
    workspaceOnly: get('workspaceOnly') !== false,
    defaultPeriod: pick(get('defaultPeriod'), PERIODS, 'today'),
    refreshInterval: pick(get('refreshInterval'), REFRESH_OPTIONS.map(option => option.value), '1m'),
    statusBarFormat: pick(get('statusBar.format'), FORMATS, 'cost'),
    currency: typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? currency : '',
    provider: typeof provider === 'string' && /^[a-z0-9-]+$/.test(provider) ? provider : 'all',
    quotaProviders: Array.isArray(quota) ? QUOTA_PROVIDERS.filter(name => quota.includes(name)) : [...QUOTA_PROVIDERS],
    nodePath: typeof nodePath === 'string' ? nodePath.trim() : '',
  }
}

export function refreshIntervalMs(value: string): number | null {
  return REFRESH_OPTIONS.find(option => option.value === value)?.ms ?? null
}

/** The renderer's own localStorage keys the dashboard reads at boot, seeded from settings. */
export function webviewSeed(settings: Settings): Record<string, string> {
  return {
    'codeburn.defaultPeriod': settings.defaultPeriod,
    'codeburn.refreshInterval': settings.refreshInterval,
    'codeburn.quotaDisabled': JSON.stringify(QUOTA_PROVIDERS.filter(name => !settings.quotaProviders.includes(name))),
  }
}
