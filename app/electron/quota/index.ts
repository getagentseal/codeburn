import os from 'node:os'
import path from 'node:path'

import { fetchAntigravityQuota } from './antigravity'
import { fetchClaudeQuota } from './claude'
import { fetchCodexQuota } from './codex'
import { fetchCopilotQuota } from './copilot'
import { fetchGeminiQuota } from './gemini'
import { fetchGrokbotQuota, grokbotInstalled } from './grokbot'
import { fetchKimiQuota } from './kimi'
import { atomicWriteSecureFile, readSecureFile, sanitizeError } from './security'
import type { ProviderName, QuotaProvider } from './types'
import { fetchZcodeQuota } from './zcode'

export type { QuotaProvider, QuotaWindow } from './types'
export { sanitizeError } from './security'

type Blocked = Partial<Record<ProviderName, string>>
type FetchResult = { quota: QuotaProvider; retryAfterSeconds?: number }
type FetcherOptions = { signal: AbortSignal; allowKeychain: boolean }
type QuotaDeps = {
  claude: (options: FetcherOptions) => Promise<FetchResult>
  codex: (options: FetcherOptions) => Promise<FetchResult>
  gemini: (options: FetcherOptions) => Promise<FetchResult>
  copilot: (options: FetcherOptions) => Promise<FetchResult>
  antigravity: (options: FetcherOptions) => Promise<FetchResult>
  kimi: (options: FetcherOptions) => Promise<FetchResult>
  zcode: (options: FetcherOptions) => Promise<FetchResult>
  grokbot: (options: FetcherOptions) => Promise<FetchResult>
  grokbotInstalled: () => boolean
  statePath: string
  readFile: typeof readSecureFile
  writeFile: typeof atomicWriteSecureFile
  now: () => number
  refreshMs: number
}

const PROVIDERS: ProviderName[] = ['claude', 'codex', 'gemini', 'copilot', 'antigravity', 'kimi', 'zcode', 'grokbot']

const defaultDeps: QuotaDeps = {
  claude: fetchClaudeQuota,
  codex: fetchCodexQuota,
  gemini: fetchGeminiQuota,
  copilot: fetchCopilotQuota,
  // The Antigravity probe talks only to localhost surfaces (no credentials,
  // no remote endpoints), so it ignores the abort/keychain options entirely.
  antigravity: async () => ({ quota: await fetchAntigravityQuota() }),
  kimi: fetchKimiQuota,
  zcode: fetchZcodeQuota,
  grokbot: options => fetchGrokbotQuota({ signal: options.signal }),
  grokbotInstalled,
  statePath: path.join(os.homedir(), '.codeburn', 'quota-backoff.json'),
  readFile: readSecureFile,
  writeFile: atomicWriteSecureFile,
  now: Date.now,
  // Politeness floor: quota stays gentle regardless of the app refresh cadence.
  // A user-initiated force refresh still bypasses this (invalidate()).
  refreshMs: 5 * 60_000,
}

function unavailable(provider: ProviderName, connection: QuotaProvider['connection']): QuotaProvider {
  return { provider, connection, primary: null, details: [], planLabel: null, footerLines: [] }
}

/**
 * The Codex live gauge needs read-write access to the Codex CLI's own
 * `~/.codex/auth.json`, because refreshing the OAuth grant rotates the token
 * and writes it back. A store-distributed snap should not hold write access to
 * another vendor's credential file, so the snap's personal-files declaration
 * requests neither that file nor a Codex root, and the gauge is disabled here
 * to match. Codex usage and cost analytics are unaffected: those come from the
 * session rollouts under `~/.codex/sessions`, which the snap does read.
 */
function codexQuotaSupported(): boolean {
  return !process.env['SNAP']
}

export class QuotaService {
  private readonly deps: QuotaDeps
  private cache: { at: number; value: QuotaProvider[] } | null = null
  private flight: Promise<QuotaProvider[]> | null = null
  private generations: Record<ProviderName, number> = Object.fromEntries(PROVIDERS.map(p => [p, 0])) as Record<ProviderName, number>
  private controllers: Partial<Record<ProviderName, AbortController>> = {}

  constructor(deps: Partial<QuotaDeps> = {}) { this.deps = { ...defaultDeps, ...deps } }

  invalidate(provider?: ProviderName): void {
    const providers: ProviderName[] = provider ? [provider] : PROVIDERS
    for (const p of providers) {
      this.generations[p] += 1
      this.controllers[p]?.abort()
      this.controllers[p] = undefined
    }
    this.cache = null
  }

  async getQuota(options: { force?: boolean; allowKeychain?: boolean; disabled?: string[] } = {}): Promise<QuotaProvider[]> {
    if (options.force) this.invalidate()
    if (!options.force && this.cache && this.deps.now() - this.cache.at < this.deps.refreshMs) return this.cache.value
    if (this.flight) return this.flight
    // IPC names are untrusted strings; only known providers may be skipped.
    const disabled = new Set((options.disabled ?? []).filter((p): p is ProviderName => PROVIDERS.includes(p as ProviderName)))
    this.flight = this.fetchAll(Boolean(options.allowKeychain), disabled).finally(() => { this.flight = null })
    return this.flight
  }

  private async readBlocked(): Promise<Blocked> {
    try {
      const raw = await this.deps.readFile(this.deps.statePath, 16 * 1024)
      return raw ? JSON.parse(raw) as Blocked : {}
    } catch (error) {
      console.warn(`Quota backoff state unavailable: ${sanitizeError(error)}`)
      return {}
    }
  }

  private async writeBlocked(blocked: Blocked): Promise<void> {
    try { await this.deps.writeFile(this.deps.statePath, `${JSON.stringify(blocked, null, 2)}\n`) }
    catch (error) { console.warn(`Quota backoff state not saved: ${sanitizeError(error)}`) }
  }

  private async fetchAll(allowKeychain: boolean, disabled: Set<ProviderName>): Promise<QuotaProvider[]> {
    const startingGenerations = { ...this.generations }
    const prior = this.cache?.value ?? []
    const blocked = await this.readBlocked()
    const run = async (provider: ProviderName): Promise<QuotaProvider> => {
      const retainOnFailure = (next: QuotaProvider): QuotaProvider => {
        const previous = prior.find(item => item.provider === provider)
        if (previous?.connection !== 'connected') return next
        // Keychain-only credentials are invisible to a background (keychain-less)
        // poll; keep showing the live connection rather than flapping to
        // disconnected. A forced refresh re-reads the keychain and reveals truth.
        if (!allowKeychain && (next.connection === 'disconnected' || next.connection === 'accessDenied')) return previous
        if (next.connection === 'transientFailure') return { ...previous, connection: 'transientFailure', rateLimited: next.rateLimited }
        return next
      }
      const until = blocked[provider] ? Date.parse(blocked[provider]!) : NaN
      if (Number.isFinite(until) && until > this.deps.now()) return retainOnFailure({ ...unavailable(provider, 'transientFailure'), rateLimited: true })
      const generation = this.generations[provider]
      const controller = new AbortController()
      this.controllers[provider] = controller
      const result = await this.deps[provider]({ signal: controller.signal, allowKeychain })
      if (generation !== this.generations[provider] || controller.signal.aborted) return unavailable(provider, 'disconnected')
      if (result.retryAfterSeconds !== undefined) {
        blocked[provider] = new Date(this.deps.now() + result.retryAfterSeconds * 1000).toISOString()
        await this.writeBlocked(blocked)
        if (this.controllers[provider] === controller) this.controllers[provider] = undefined
        return retainOnFailure({ ...result.quota, rateLimited: true })
      } else if (blocked[provider]) {
        delete blocked[provider]
        await this.writeBlocked(blocked)
      }
      if (this.controllers[provider] === controller) this.controllers[provider] = undefined
      return retainOnFailure(result.quota)
    }
    // Grok Bot is an optional desktop app rather than a signed-in account: with
    // the app absent there is no row to show, only someone else's Cursor
    // allowance under a Grok Bot label.
    const pollable = PROVIDERS.filter(provider => provider !== 'grokbot' || this.deps.grokbotInstalled())
    const value = await Promise.all(pollable.filter(provider => !disabled.has(provider)).map(provider =>
      provider === 'codex' && !codexQuotaSupported()
        ? Promise.resolve(unavailable('codex', 'disconnected'))
        : run(provider),
    ))
    if (PROVIDERS.every(p => startingGenerations[p] === this.generations[p])) {
      this.cache = { at: this.deps.now(), value }
    }
    return value
  }
}

export const quotaService = new QuotaService()
// Keychain reads can raise a one-time macOS permission dialog, so only attempt
// them on a user-initiated forced refresh (the Connect / Refresh affordance).
// Background polls skip the keychain and lean on retainOnFailure to hold a
// live connection steady between forced refreshes.
export const getQuota = (options: { force?: boolean; disabled?: string[] } = {}): Promise<QuotaProvider[]> =>
  quotaService.getQuota({ force: options.force, allowKeychain: Boolean(options.force), disabled: options.disabled })
