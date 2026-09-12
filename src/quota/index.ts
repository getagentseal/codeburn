// Provider capacity readers for `codeburn quota`.
//
// These adapters were ported from the Electron desktop app's copies under
// `app/electron/quota/*.ts`, which remain the origin and are still what the
// desktop app runs. They are deliberately left untouched by this change; the
// two trees will be deduped in a follow-up once every surface reads the CLI.

import { renderTable } from '../text-table.js'
import { fetchAntigravityQuota } from './antigravity.js'
import { fetchClaudeQuota } from './claude.js'
import { fetchClinePassQuota } from './clinepass.js'
import { fetchCodexQuota } from './codex.js'
import { fetchCopilotQuota } from './copilot.js'
import { fetchCursorQuota } from './cursor.js'
import { fetchGeminiQuota } from './gemini.js'
import { fetchGrokQuota } from './grok.js'
import { fetchKimiQuota } from './kimi.js'
import type { ProviderName, QuotaProvider } from './types.js'
import { fetchZaiQuota } from './zai.js'

export type QuotaCommandWindow = { label: string; usedPct: number; resetsAt?: string }

export type QuotaCommandProvider = {
  id: ProviderName
  name: string
  available: boolean
  plan?: string
  windows: QuotaCommandWindow[]
  error?: string
  /** Provider facts that are not a window, such as Codex's limit-reset credits.
   *  Printed under the provider's rows and carried in `--format json`. */
  notes?: string[]
}

export type QuotaReport = { providers: QuotaCommandProvider[] }

export type ProviderReader = (signal: AbortSignal) => Promise<QuotaProvider>

const READERS: { id: ProviderName; name: string; read: ProviderReader }[] = [
  { id: 'claude', name: 'Claude', read: async signal => (await fetchClaudeQuota({ signal, allowKeychain: true })).quota },
  // No keychain for Codex: it would prefer the menubar's read-only cached token
  // over `~/.codex/auth.json`, which this process may refresh and write back.
  { id: 'codex', name: 'Codex', read: async signal => (await fetchCodexQuota({ signal })).quota },
  { id: 'gemini', name: 'Gemini', read: async signal => (await fetchGeminiQuota({ signal })).quota },
  { id: 'copilot', name: 'GitHub Copilot', read: async signal => (await fetchCopilotQuota({ signal })).quota },
  { id: 'antigravity', name: 'Antigravity', read: () => fetchAntigravityQuota() },
  { id: 'kimi', name: 'Kimi', read: async signal => (await fetchKimiQuota({ signal })).quota },
  { id: 'cursor', name: 'Cursor', read: async signal => (await fetchCursorQuota({ signal })).quota },
  { id: 'zai', name: 'Z.ai', read: async signal => (await fetchZaiQuota({ signal })).quota },
  { id: 'grok', name: 'Grok', read: async signal => (await fetchGrokQuota({ signal })).quota },
  { id: 'clinepass', name: 'ClinePass', read: async signal => (await fetchClinePassQuota({ signal })).quota },
]

const DEFAULT_TIMEOUT_MS = 5_000

function errorFor(quota: QuotaProvider): string | undefined {
  switch (quota.connection) {
    case 'accessDenied':
      return quota.footerLines[0] ?? 'Access to the stored credential was denied.'
    case 'terminalFailure':
      return quota.footerLines[0] ?? 'The provider rejected the request.'
    case 'transientFailure':
      return quota.footerLines[0] ?? 'Temporarily unavailable.'
    default:
      return undefined
  }
}

function toWindows(quota: QuotaProvider): QuotaCommandWindow[] {
  const rows = quota.details.length > 0 ? quota.details : quota.primary ? [quota.primary] : []
  return rows.map(row => ({
    label: row.label,
    usedPct: Math.round(row.percent * 1000) / 10,
    ...(row.resetsAt ? { resetsAt: row.resetsAt } : {}),
  }))
}

export function toCommandProvider(id: ProviderName, name: string, quota: QuotaProvider): QuotaCommandProvider {
  const error = errorFor(quota)
  return {
    id,
    name,
    available: quota.connection === 'connected',
    ...(quota.planLabel ? { plan: quota.planLabel } : {}),
    windows: toWindows(quota),
    ...(error ? { error } : {}),
    ...(quota.notes?.length ? { notes: quota.notes } : {}),
  }
}

export async function collectQuota(options: {
  readers?: { id: ProviderName; name: string; read: ProviderReader }[]
  timeoutMs?: number
} = {}): Promise<QuotaReport> {
  const readers = options.readers ?? READERS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const providers = await Promise.all(readers.map(async entry => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const timedOut = new Promise<'timeout'>(resolve => { controller.signal.addEventListener('abort', () => resolve('timeout')) })
    try {
      const quota = await Promise.race([entry.read(controller.signal), timedOut])
      if (quota === 'timeout') {
        return { id: entry.id, name: entry.name, available: false, windows: [], error: 'Timed out.' }
      }
      return toCommandProvider(entry.id, entry.name, quota)
    } finally {
      clearTimeout(timer)
    }
  }))
  return { providers }
}

function resetLabel(iso: string | undefined): string {
  if (!iso) return ''
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleString()
}

export function renderQuotaTable(report: QuotaReport, opts: { color?: boolean } = {}): string {
  const rows: string[][] = []
  for (const provider of report.providers) {
    const title = provider.plan ? `${provider.name} (${provider.plan})` : provider.name
    if (provider.windows.length === 0) {
      rows.push([title, provider.error ?? 'Not connected', '', ''])
      // A provider with no readable window can still hold a fact worth saying.
      for (const note of provider.notes ?? []) rows.push(['', note, '', ''])
      continue
    }
    provider.windows.forEach((window, index) => {
      rows.push([index === 0 ? title : '', window.label, `${window.usedPct}%`, resetLabel(window.resetsAt)])
    })
    for (const note of provider.notes ?? []) rows.push(['', note, '', ''])
  }
  const columns = [{ header: 'Provider' }, { header: 'Window' }, { header: 'Used', right: true }, { header: 'Resets' }]
  return renderTable(columns, rows, { color: opts.color })
}
