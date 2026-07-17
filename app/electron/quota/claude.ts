import os from 'node:os'
import path from 'node:path'

import { fraction, quotaRequestSignal, readKeychainPassword, readSecureFile, sanitizeError } from './security'
import type { KeychainOutcome } from './security'
import type { QuotaProvider, QuotaWindow } from './types'

const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'
const KEYCHAIN_SERVICE = 'Claude Code-credentials'

type ClaudeCredential = { accessToken: string; expiresAt?: number; rateLimitTier?: string }
export type ClaudeDeps = {
  fetch: typeof fetch
  credentialPath: string
  readFile: typeof readSecureFile
  now: () => number
  keychain?: () => Promise<KeychainOutcome>
}

const defaults: ClaudeDeps = {
  fetch: globalThis.fetch,
  credentialPath: path.join(os.homedir(), '.claude', '.credentials.json'),
  readFile: readSecureFile,
  now: Date.now,
}

function empty(connection: QuotaProvider['connection']): QuotaProvider {
  return { provider: 'claude', connection, primary: null, details: [], planLabel: null, footerLines: [] }
}

function parseCredential(raw: string): ClaudeCredential | null {
  const clean = raw.replace(/\r/g, '').replace(/\n[ \t]*/g, '')
  const oauth = (JSON.parse(clean) as { claudeAiOauth?: Record<string, unknown> }).claudeAiOauth
  if (!oauth || typeof oauth.accessToken !== 'string' || oauth.accessToken.length === 0) return null
  return {
    accessToken: oauth.accessToken,
    expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : undefined,
    rateLimitTier: typeof oauth.rateLimitTier === 'string' ? oauth.rateLimitTier : undefined,
  }
}

async function credentialFromFile(deps: ClaudeDeps): Promise<ClaudeCredential | null> {
  const raw = await deps.readFile(deps.credentialPath, 64 * 1024)
  return raw ? parseCredential(raw) : null
}

export async function readClaudeKeychain(): Promise<KeychainOutcome> {
  // Claude Code has written the item under both `$USER` (2.1.x) and the older
  // hardcoded "agentseal" account; a user-scoped miss must fall through to the
  // service-only lookup rather than reporting disconnected.
  const user = process.env.USER
  return readKeychainPassword(KEYCHAIN_SERVICE, user ? [user, null] : [null])
}

function windowOf(label: string, value: unknown): QuotaWindow | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const percent = fraction(row.utilization)
  if (percent === null) return null
  const resetsAt = typeof row.resets_at === 'string' && !Number.isNaN(Date.parse(row.resets_at))
    ? new Date(row.resets_at).toISOString() : null
  return { label, percent, resetsAt }
}

function tierLabel(raw: string | undefined): string {
  const value = raw?.toLowerCase() ?? ''
  if (value.includes('max_20x') || value.includes('max20x') || value.includes('max-20x')) return 'Max 20x'
  if (value.includes('max_5x') || value.includes('max5x') || value.includes('max-5x') || value.includes('max')) return 'Max 5x'
  if (value.includes('pro')) return 'Pro'
  if (value.includes('team')) return 'Team'
  if (value.includes('enterprise')) return 'Enterprise'
  return 'Subscription'
}

export function decodeClaudeUsage(body: unknown, credential: ClaudeCredential): QuotaProvider {
  const data = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const five = windowOf('5-hour', data.five_hour)
  const weekly = windowOf('Weekly', data.seven_day)
  const opus = windowOf('Weekly · Opus', data.seven_day_opus)
  const sonnet = windowOf('Weekly · Sonnet', data.seven_day_sonnet)
  const scoped: QuotaWindow[] = []
  if (Array.isArray(data.limits)) {
    for (const item of data.limits) {
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, any>
      const display = row.scope?.model?.display_name
      const percent = fraction(row.percent)
      if (row.kind !== 'weekly_scoped' || typeof display !== 'string' || percent === null) continue
      const resetsAt = typeof row.resets_at === 'string' && !Number.isNaN(Date.parse(row.resets_at))
        ? new Date(row.resets_at).toISOString() : null
      scoped.push({ label: `Weekly · ${display}`, percent, resetsAt })
    }
  }
  return {
    provider: 'claude', connection: 'connected', primary: weekly,
    details: [five, weekly, opus, sonnet].filter((row): row is QuotaWindow => row !== null).concat(scoped),
    planLabel: tierLabel(credential.rateLimitTier), footerLines: [],
  }
}

async function request(token: string, deps: ClaudeDeps, parent?: AbortSignal): Promise<Response> {
  return deps.fetch(ENDPOINT, {
    method: 'GET', signal: quotaRequestSignal(parent),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-code/2.1.0',
    },
  })
}

export type ClaudeResult = { quota: QuotaProvider; retryAfterSeconds?: number }

export async function fetchClaudeQuota(options: Partial<ClaudeDeps> & { signal?: AbortSignal; allowKeychain?: boolean } = {}): Promise<ClaudeResult> {
  const deps = { ...defaults, ...options }
  try {
    let credential = await credentialFromFile(deps)
    if (!credential && options.allowKeychain && process.platform === 'darwin') {
      const outcome = await (deps.keychain ?? readClaudeKeychain)()
      if (outcome.status === 'accessDenied') return { quota: empty('accessDenied') }
      credential = outcome.status === 'found' ? parseCredential(outcome.value) : null
    }
    if (!credential) return { quota: empty('disconnected') }

    let response: Response
    if (credential.expiresAt !== undefined && credential.expiresAt - deps.now() <= 5 * 60_000) {
      const reread = await credentialFromFile(deps)
      if (!reread || reread.accessToken === credential.accessToken) return { quota: empty('transientFailure') }
      credential = reread
    }
    response = await request(credential.accessToken, deps, options.signal)
    if (response.status === 401) {
      const reread = await credentialFromFile(deps)
      if (!reread || reread.accessToken === credential.accessToken) return { quota: empty('transientFailure') }
      credential = reread
      response = await request(credential.accessToken, deps, options.signal)
    }
    if (response.status === 429) {
      let hint: unknown
      try { hint = (await response.json() as Record<string, unknown>).retry_after } catch { hint = undefined }
      const parsed = typeof hint === 'number' ? hint : typeof hint === 'string' ? Number(hint) : NaN
      return { quota: empty('transientFailure'), retryAfterSeconds: Math.max(Number.isFinite(parsed) ? parsed : 300, 60) }
    }
    if (!response.ok) return { quota: empty(response.status >= 400 && response.status < 500 ? 'terminalFailure' : 'transientFailure') }
    return { quota: decodeClaudeUsage(await response.json(), credential) }
  } catch (error) {
    // Deliberately sanitize before the only diagnostic sink. Tokens are never returned.
    console.warn(`Claude quota unavailable: ${sanitizeError(error)}`)
    return { quota: empty('transientFailure') }
  }
}
