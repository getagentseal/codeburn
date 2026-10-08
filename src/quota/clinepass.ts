// Live ClinePass quota from the public usage-limits contract (ported from the
// menubar's ClinePassSubscriptionService.swift):
//
// - GET https://api.cline.bot/api/v1/users/me/plan/usage-limits
//     Bearer API key, one 5-hour / weekly / monthly window each.
//
// Credential: CLINEPASS_API_KEY, then CLINE_API_KEY, then the session the
// Cline CLI keeps in ~/.cline/data/settings/providers.json (read-only, never
// refreshed or written; an expired session asks the user to run cline). The
// key is used for one request and never persisted or logged.
import os from 'node:os'
import path from 'node:path'

import { quotaRequestSignal, readSecureFile, sanitizeError } from './security.js'
import type { QuotaProvider, QuotaWindow } from './types.js'

const USAGE_ENDPOINT = 'https://api.cline.bot/api/v1/users/me/plan/usage-limits'
const API_KEY_VARS = ['CLINEPASS_API_KEY', 'CLINE_API_KEY'] as const
const REJECTED_FOOTER = ['ClinePass rejected this API key.']
const EXPIRED_FOOTER = ['Cline sign-in expired. Run cline to refresh it.']
const RATE_LIMITED_FOOTER = ['ClinePass rate-limited the quota request.']
const UNAVAILABLE_FOOTER = ['ClinePass is temporarily unavailable.']
const PARSE_FOOTER = ['ClinePass quota response was malformed.']

const WINDOW_LABELS: Record<string, string> = { five_hour: '5-hour', weekly: 'Weekly', monthly: 'Monthly' }

export type ClinePassDeps = {
  fetch: typeof fetch
  env: NodeJS.ProcessEnv
  readFile: typeof readSecureFile
  homeDir: string
  now: () => number
}

function defaultDeps(): ClinePassDeps {
  return { fetch: globalThis.fetch, env: process.env, readFile: readSecureFile, homeDir: os.homedir(), now: Date.now }
}

function empty(connection: QuotaProvider['connection'], footerLines: string[] = []): QuotaProvider {
  return { provider: 'clinepass', connection, primary: null, details: [], planLabel: null, footerLines }
}

export function clinePassApiKey(env: NodeJS.ProcessEnv): string | null {
  for (const name of API_KEY_VARS) {
    const value = env[name]?.trim()
    if (value) return value
  }
  return null
}

/** Cline's own lookup order: a settings file override, then a data dir, then a Cline dir. */
export function clineProvidersPath(env: NodeJS.ProcessEnv, homeDir: string): string {
  const resolve = (name: string): string | null => {
    const value = env[name]?.trim()
    if (!value) return null
    if (value === '~') return homeDir
    return value.startsWith('~/') ? path.join(homeDir, value.slice(2)) : value
  }
  const file = resolve('CLINE_PROVIDER_SETTINGS_PATH')
  if (file) return file
  const dataDir = resolve('CLINE_DATA_DIR') ?? path.join(resolve('CLINE_DIR') ?? path.join(homeDir, '.cline'), 'data')
  return path.join(dataDir, 'settings', 'providers.json')
}

export type ClineFileCredential = { token: string; oauth: boolean; expiresAt: number | null }

/** Matches Cline's getApiKey: the OAuth access token wins over keys kept in the same entry. */
export function parseClineProviders(raw: string): ClineFileCredential | null {
  const root = JSON.parse(raw) as { providers?: { cline?: { settings?: Record<string, any> } } }
  const settings = root?.providers?.cline?.settings
  if (!settings || typeof settings !== 'object') return null
  const auth = settings['auth'] && typeof settings['auth'] === 'object' ? settings['auth'] : {}
  const clean = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null
  const access = clean(auth.accessToken)
  if (access) {
    return {
      token: access.startsWith('workos:') ? access : `workos:${access}`,
      oauth: true,
      expiresAt: num(auth.expiresAt),
    }
  }
  const key = clean(settings['apiKey']) ?? clean(auth.apiKey)
  return key ? { token: key, oauth: false, expiresAt: null } : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * `null` on any malformed row. ClinePass publishes this contract, so unlike the
 * looser internal endpoints a field that is present but wrong is a broken
 * response rather than something to skip past; only an unknown window type is
 * ignored, so a new one does not break the reading.
 */
export function decodeClinePassUsage(body: unknown): QuotaProvider | null {
  if (!body || typeof body !== 'object') return null
  const root = body as Record<string, unknown>
  if (root['success'] !== true) return null
  const data = root['data']
  if (!data || typeof data !== 'object') return null
  const limits = (data as Record<string, unknown>)['limits']
  if (!Array.isArray(limits)) return null

  const windows = new Map<string, QuotaWindow>()
  for (const raw of limits) {
    if (!raw || typeof raw !== 'object') return null
    const limit = raw as Record<string, unknown>
    const type = limit['type']
    if (typeof type !== 'string') return null
    const label = WINDOW_LABELS[type]
    if (label === undefined) continue

    const percentUsed = num(limit['percentUsed'])
    if (percentUsed === null) return null
    let resetsAt: string | null = null
    if (limit['resetsAt'] !== undefined && limit['resetsAt'] !== null) {
      const parsed = typeof limit['resetsAt'] === 'string' ? Date.parse(limit['resetsAt']) : NaN
      if (!Number.isFinite(parsed)) return null
      resetsAt = new Date(parsed).toISOString()
    }
    windows.set(type, { label, percent: Math.min(1, Math.max(0, percentUsed / 100)), resetsAt })
  }

  const details = ['five_hour', 'weekly', 'monthly']
    .map(type => windows.get(type))
    .filter((row): row is QuotaWindow => row !== undefined)
  if (details.length === 0) return null
  return {
    provider: 'clinepass', connection: 'connected',
    primary: windows.get('weekly') ?? windows.get('five_hour') ?? windows.get('monthly')!,
    details,
    planLabel: null,
    footerLines: [],
  }
}

export type ClinePassResult = { quota: QuotaProvider; retryAfterSeconds?: number }

export async function fetchClinePassQuota(options: Partial<ClinePassDeps> & { signal?: AbortSignal } = {}): Promise<ClinePassResult> {
  const deps = { ...defaultDeps(), ...options }
  try {
    const envKey = clinePassApiKey(deps.env)
    const file = envKey ? null : await deps.readFile(clineProvidersPath(deps.env, deps.homeDir), 1024 * 1024)
    const credential = envKey ? { token: envKey, oauth: false, expiresAt: null } : file ? parseClineProviders(file) : null
    if (!credential) return { quota: empty('disconnected') }
    // Not terminal: running cline refreshes the session file this only reads,
    // so the next scheduled read recovers on its own.
    if (credential.oauth && credential.expiresAt !== null && credential.expiresAt <= deps.now()) {
      return { quota: empty('transientFailure', EXPIRED_FOOTER) }
    }
    const response = await deps.fetch(USAGE_ENDPOINT, {
      method: 'GET', signal: quotaRequestSignal(options.signal),
      headers: { Accept: 'application/json', Authorization: `Bearer ${credential.token}`, 'User-Agent': 'CodeBurn' },
    })
    if (response.status === 401 || response.status === 403) {
      return { quota: credential.oauth ? empty('transientFailure', EXPIRED_FOOTER) : empty('terminalFailure', REJECTED_FOOTER) }
    }
    if (response.status === 429) {
      const raw = response.headers.get('Retry-After')
      const seconds = raw === null ? NaN : Number(raw)
      return {
        quota: { ...empty('transientFailure', RATE_LIMITED_FOOTER), rateLimited: true },
        retryAfterSeconds: Math.max(Number.isFinite(seconds) ? Math.ceil(seconds) : 300, 60),
      }
    }
    if (response.status >= 500) return { quota: empty('transientFailure', UNAVAILABLE_FOOTER) }
    if (!response.ok) return { quota: empty('transientFailure', PARSE_FOOTER) }
    // Never log the body - it carries account data.
    const quota = decodeClinePassUsage(await response.json())
    return { quota: quota ?? empty('transientFailure', PARSE_FOOTER) }
  } catch (error) {
    console.warn(`ClinePass quota unavailable: ${sanitizeError(error)}`)
    return { quota: empty('transientFailure') }
  }
}
