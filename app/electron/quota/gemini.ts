// Live Gemini quota via the OAuth-backed Code Assist APIs the Gemini CLI
// itself calls, derived from the Google Code Assist client flow and the CLI's
// own traffic:
//
// - POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist
//     body { metadata: { ideType: 'GEMINI_CLI', pluginType: 'GEMINI' } }
//     → tier (plan label), cloudaicompanionProject (quota project)
// - POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota
//     body { project } (or {} when unknown) → per-model quota buckets
// - POST https://oauth2.googleapis.com/token (only when the stored token is
//     stale and GEMINI_OAUTH_CLIENT_ID/GEMINI_OAUTH_CLIENT_SECRET are set;
//     the refreshed token stays in memory — the Gemini CLI owns its file)
//
// Credential: the Gemini CLI's own ~/.gemini/oauth_creds.json, read-only.
import os from 'node:os'
import path from 'node:path'

import { fraction, quotaRequestSignal, readSecureFile, sanitizeError } from './security'
import type { QuotaProvider, QuotaWindow } from './types'

const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com/v1internal'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

type GeminiCredential = {
  access_token?: string
  refresh_token?: string
  id_token?: string
  expiry_date?: number
}

export type GeminiDeps = {
  fetch: typeof fetch
  credentialPath: string
  readFile: typeof readSecureFile
  now: () => number
}

const defaults: GeminiDeps = {
  fetch: globalThis.fetch,
  credentialPath: path.join(os.homedir(), '.gemini', 'oauth_creds.json'),
  readFile: readSecureFile,
  now: Date.now,
}

function empty(connection: QuotaProvider['connection'], footerLines: string[] = []): QuotaProvider {
  return { provider: 'gemini', connection, primary: null, details: [], planLabel: null, footerLines }
}

function parseCredential(raw: string): GeminiCredential | null {
  const parsed = JSON.parse(raw) as GeminiCredential
  if (!parsed || typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) return null
  return parsed
}

async function credentialFromFile(deps: GeminiDeps): Promise<GeminiCredential | null> {
  const raw = await deps.readFile(deps.credentialPath, 64 * 1024)
  return raw ? parseCredential(raw) : null
}

// Client credentials live inside the installed Gemini CLI bundle; scanning the
// install is out of scope here, so only the CLI's documented env overrides are
// honored. Without them an expired token is used as-is and a 401 degrades.
function clientCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env['GEMINI_OAUTH_CLIENT_ID']
  const clientSecret = process.env['GEMINI_OAUTH_CLIENT_SECRET']
  return clientId && clientSecret ? { clientId, clientSecret } : null
}

async function refresh(credential: GeminiCredential, deps: GeminiDeps, signal?: AbortSignal): Promise<string | null> {
  const client = clientCredentials()
  const refreshToken = credential.refresh_token
  if (!client || !refreshToken) return null
  const body = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })
  const response = await deps.fetch(TOKEN_ENDPOINT, { method: 'POST', signal: quotaRequestSignal(signal), body })
  if (!response.ok) return null
  const next = await response.json() as Record<string, unknown>
  return typeof next.access_token === 'string' && next.access_token ? next.access_token : null
}

// The `hd` claim (hosted domain) separates Google Workspace logins from
// personal ones, matching the provider's tier labels.
function workspaceClaim(idToken: string | undefined): boolean {
  if (!idToken) return false
  const [, payload] = idToken.split('.')
  if (!payload) return false
  try {
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as Record<string, unknown>
    return typeof json.hd === 'string' && json.hd.length > 0
  } catch {
    return false
  }
}

function tierLabel(body: Record<string, any>, credential: GeminiCredential): string | null {
  // paidTier wins whenever present; otherwise whatever tier the account sits on.
  const raw = body.paidTier?.name ?? body.currentTier?.name ?? body.currentTier?.id
  if (typeof raw !== 'string' || !raw.trim()) return null
  const lower = raw.trim().toLowerCase()
  if (lower === 'standard-tier') return 'Paid'
  if (lower === 'legacy-tier') return 'Legacy'
  if (lower.includes('free') && workspaceClaim(credential.id_token)) return 'Workspace'
  if (lower.includes('free')) return 'Free'
  return raw.trim()
}

function windowOf(bucket: Record<string, unknown>): QuotaWindow | null {
  const modelId = bucket.modelId
  const remaining = fraction(typeof bucket.remainingFraction === 'number' ? bucket.remainingFraction * 100 : NaN)
  if (typeof modelId !== 'string' || !modelId || remaining === null) return null
  const resetTime = bucket.resetTime
  const resetsAt = typeof resetTime === 'string' && !Number.isNaN(Date.parse(resetTime))
    ? new Date(resetTime).toISOString() : null
  return { label: modelId, percent: 1 - remaining, resetsAt }
}

export function decodeGeminiUsage(body: unknown): QuotaProvider {
  const data = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const buckets = Array.isArray(data.buckets) ? data.buckets : []
  const details = buckets
    .filter((bucket): bucket is Record<string, unknown> => Boolean(bucket) && typeof bucket === 'object')
    .map(windowOf)
    .filter((window): window is QuotaWindow => window !== null)
    .sort((a, b) => b.percent - a.percent)
  return {
    provider: 'gemini', connection: 'connected',
    primary: details[0] ?? null,
    details,
    planLabel: null,
    footerLines: [],
  }
}

async function post(token: string, path: string, payload: Record<string, unknown>, deps: GeminiDeps, parent?: AbortSignal): Promise<Response> {
  return deps.fetch(`${CODE_ASSIST_ENDPOINT}:${path}`, {
    method: 'POST', signal: quotaRequestSignal(parent),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'CodeBurn' },
    body: JSON.stringify(payload),
  })
}

// Google flags retired consumer tiers (June 2026 shutdown of individual/AI
// Pro/Ultra OAuth access) with these sentinels instead of ordinary errors.
function migrationFooter(body: unknown): string[] {
  const error = body && typeof body === 'object' ? (body as Record<string, any>).error : null
  const status = typeof error?.status === 'string' ? error.status : ''
  const message = typeof error?.message === 'string' ? error.message : ''
  const deprecated = status === 'UNSUPPORTED_CLIENT' || message.includes('IneligibleTierError')
  return deprecated ? ['Google retired Gemini CLI OAuth for this account tier — use Antigravity.'] : []
}

export type GeminiResult = { quota: QuotaProvider; retryAfterSeconds?: number }

export async function fetchGeminiQuota(options: Partial<GeminiDeps> & { signal?: AbortSignal } = {}): Promise<GeminiResult> {
  const deps = { ...defaults, ...options }
  try {
    let credential = await credentialFromFile(deps)
    if (!credential) return { quota: empty('disconnected') }

    if ((credential.expiry_date ?? Infinity) - deps.now() <= 5 * 60_000) {
      const accessToken = await refresh(credential, deps, options.signal)
      if (accessToken) credential = { ...credential, access_token: accessToken }
    }
    const token = credential.access_token!
    let response = await post(token, 'loadCodeAssist', { metadata: { ideType: 'GEMINI_CLI', pluginType: 'GEMINI' } }, deps, options.signal)
    if (response.status === 401) {
      const reread = await credentialFromFile(deps)
      // Gemini has no keychain and no in-process refresh without the CLI's env
      // overrides, so a 401 whose re-read token is unchanged is an expired login
      // only the Gemini CLI can fix — a terminal, actionable state (matching the
      // menubar's .tokenExpired), never an open-ended "waiting".
      if (!reread || reread.access_token === credential.access_token) {
        return { quota: { ...empty('terminalFailure', ['Gemini login expired. Run the Gemini CLI once to refresh, then try again.']), connectable: true } }
      }
      credential = reread
      response = await post(credential.access_token!, 'loadCodeAssist', { metadata: { ideType: 'GEMINI_CLI', pluginType: 'GEMINI' } }, deps, options.signal)
    }
    if (response.status === 429) {
      const raw = response.headers.get('Retry-After')
      const seconds = raw === null ? NaN : Number(raw)
      return { quota: empty('transientFailure'), retryAfterSeconds: Math.max(Number.isFinite(seconds) ? Math.ceil(seconds) : 300, 60) }
    }
    // Retired-tier sentinels ride inside the JSON error body of a non-200
    // response, so parse before branching on status.
    const assist = await response.json().catch(() => ({})) as Record<string, any>
    const migration = migrationFooter(assist)
    if (migration.length > 0) return { quota: empty('terminalFailure', migration) }
    if (!response.ok) return { quota: { ...empty(response.status >= 400 && response.status < 500 ? 'terminalFailure' : 'transientFailure'), ...(response.status === 401 || response.status === 403 ? { connectable: true } : {}) } }

    const project = typeof assist.cloudaicompanionProject === 'string' && assist.cloudaicompanionProject
      ? assist.cloudaicompanionProject : undefined
    const quotaResponse = await post(credential.access_token!, 'retrieveUserQuota', project ? { project } : {}, deps, options.signal)
    if (quotaResponse.status === 429) {
      const raw = quotaResponse.headers.get('Retry-After')
      const seconds = raw === null ? NaN : Number(raw)
      return { quota: empty('transientFailure'), retryAfterSeconds: Math.max(Number.isFinite(seconds) ? Math.ceil(seconds) : 300, 60) }
    }
    if (!quotaResponse.ok) {
      return { quota: { ...empty(quotaResponse.status >= 400 && quotaResponse.status < 500 ? 'terminalFailure' : 'transientFailure'), ...(quotaResponse.status === 401 || quotaResponse.status === 403 ? { connectable: true } : {}) } }
    }
    const quota = decodeGeminiUsage(await quotaResponse.json())
    quota.planLabel = tierLabel(assist, credential)
    return { quota }
  } catch (error) {
    console.warn(`Gemini quota unavailable: ${sanitizeError(error)}`)
    return { quota: empty('transientFailure') }
  }
}
