import os from 'node:os'
import path from 'node:path'

import { wslHomes } from '../wsl.js'
import { fraction, quotaRequestSignal, readKeychainPassword, readSecureFile, sanitizeError } from './security.js'
import type { KeychainOutcome } from './security.js'
import type { QuotaProvider, QuotaWindow } from './types.js'

const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'
const KEYCHAIN_SERVICE = 'Claude Code-credentials'
const EXPIRED_FOOTER = ['Claude Code login expired. Run Claude Code once, then refresh.']

type ClaudeCredential = { accessToken: string; expiresAt?: number; rateLimitTier?: string; subscriptionType?: string }
/** Where the credential in hand came from, so a rejected token is re-read from that same place. */
type CredentialSource = 'file' | 'keychain'
export type ClaudeDeps = {
  fetch: typeof fetch
  credentialPath: string
  /** Credential files inside running WSL distros (#1061); empty off Windows. */
  wslCredentialPaths: () => string[]
  readFile: typeof readSecureFile
  keychain?: () => Promise<KeychainOutcome>
  now: () => number
}

const defaults: ClaudeDeps = {
  fetch: globalThis.fetch,
  credentialPath: path.join(os.homedir(), '.claude', '.credentials.json'),
  wslCredentialPaths: () => wslHomes().map(home => `${home}\\.claude\\.credentials.json`),
  readFile: readSecureFile,
  now: Date.now,
}

function empty(connection: QuotaProvider['connection'], footerLines: string[] = []): QuotaProvider {
  return { provider: 'claude', connection, primary: null, details: [], planLabel: null, footerLines }
}

function parseCredential(raw: string): ClaudeCredential | null {
  const clean = raw.replace(/\r/g, '').replace(/\n[ \t]*/g, '')
  const oauth = (JSON.parse(clean) as { claudeAiOauth?: Record<string, unknown> }).claudeAiOauth
  if (!oauth || typeof oauth.accessToken !== 'string' || oauth.accessToken.length === 0) return null
  return {
    accessToken: oauth.accessToken,
    expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : undefined,
    rateLimitTier: typeof oauth.rateLimitTier === 'string' ? oauth.rateLimitTier : undefined,
    subscriptionType: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : undefined,
  }
}

async function credentialAt(file: string, deps: ClaudeDeps): Promise<ClaudeCredential | null> {
  const raw = await deps.readFile(file, 64 * 1024)
  return raw ? parseCredential(raw) : null
}

// A 9P share whose distro is going down can stall a read; the quota poll must
// never wait on it. The abandoned read settles (or not) on its own.
const WSL_READ_TIMEOUT_MS = 2000

function wslCredentialAt(file: string, deps: ClaudeDeps): Promise<ClaudeCredential | null> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<null>(resolve => { timer = setTimeout(resolve, WSL_READ_TIMEOUT_MS, null) })
  return Promise.race([credentialAt(file, deps).catch(() => null), timeout]).finally(() => clearTimeout(timer))
}

/**
 * The Windows-home credential plus one per running WSL distro home. A user can
 * be logged in on both sides; the one expiring last is the one Claude Code
 * renewed most recently. A broken WSL file is skipped; a broken Windows file
 * still surfaces its error when nothing else is usable.
 */
async function credentialFromFiles(deps: ClaudeDeps): Promise<{ credential: ClaudeCredential; path: string } | null> {
  let nativeError: unknown
  const native = credentialAt(deps.credentialPath, deps).catch(error => { nativeError = error; return null })
  const paths = [deps.credentialPath, ...deps.wslCredentialPaths()]
  const found = await Promise.all([native, ...paths.slice(1).map(file => wslCredentialAt(file, deps))])
  let best: { credential: ClaudeCredential; path: string } | null = null
  for (const [i, credential] of found.entries()) {
    if (credential && (!best || (credential.expiresAt ?? -Infinity) > (best.credential.expiresAt ?? -Infinity))) {
      best = { credential, path: paths[i]! }
    }
  }
  if (!best && nativeError !== undefined) throw nativeError
  return best
}

/**
 * Re-read whichever store the credential came from. On macOS the credential
 * usually lives in the Keychain and no file exists at all, so re-reading the
 * file after a 401 could never see the token Claude Code has since renewed.
 * A denied Keychain on a re-read needs no state of its own: the first read
 * already decided whether that store is reachable.
 */
async function credentialFrom(source: CredentialSource, file: string, deps: ClaudeDeps): Promise<ClaudeCredential | null> {
  if (source === 'file') return file === deps.credentialPath ? credentialAt(file, deps) : wslCredentialAt(file, deps)
  const outcome = await (deps.keychain ?? readClaudeKeychain)()
  return outcome.status === 'found' ? parseCredential(outcome.value) : null
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

export function planLabel(credential: Pick<ClaudeCredential, 'subscriptionType' | 'rateLimitTier'>): string {
  const subscriptionType = credential.subscriptionType?.toLowerCase() ?? ''
  const tier = credential.rateLimitTier?.toLowerCase() ?? ''
  const hasMax20 = tier.includes('max_20x') || tier.includes('max20x') || tier.includes('max-20x')
  const hasMax = tier.includes('max')
  if (subscriptionType === 'team' || (subscriptionType === '' && tier.includes('team'))) {
    return hasMax ? 'Team Premium' : 'Team'
  }
  if (subscriptionType === 'enterprise' || (subscriptionType === '' && tier.includes('enterprise'))) {
    return hasMax ? 'Enterprise Premium' : 'Enterprise'
  }
  if (subscriptionType === 'max' || hasMax) {
    return hasMax20 ? 'Max 20x' : 'Max 5x'
  }
  if (subscriptionType === 'pro' || tier.includes('pro')) {
    return 'Pro'
  }
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
    planLabel: planLabel(credential), footerLines: [],
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
    const fromFile = await credentialFromFiles(deps)
    let credential = fromFile?.credential ?? null
    let source: CredentialSource = 'file'
    if (!credential && options.allowKeychain && process.platform === 'darwin') {
      const outcome = await (deps.keychain ?? readClaudeKeychain)()
      if (outcome.status === 'accessDenied') return { quota: empty('accessDenied') }
      credential = outcome.status === 'found' ? parseCredential(outcome.value) : null
      source = 'keychain'
    }
    if (!credential) return { quota: empty('disconnected') }

    let response = await request(credential.accessToken, deps, options.signal)
    if (response.status === 401) {
      const reread = await credentialFrom(source, fromFile?.path ?? deps.credentialPath, deps)
      if (!reread || reread.accessToken === credential.accessToken) {
        // Nothing but a fresh login can clear a 401 on a credential whose life is
        // already over, so it is reported as terminal rather than as the blip its
        // consumers are meant to retry and to keep their last numbers through. A
        // token that has not expired is a real blip and keeps that backoff.
        const expired = credential.expiresAt !== undefined && credential.expiresAt <= deps.now()
        return { quota: expired ? empty('terminalFailure', EXPIRED_FOOTER) : empty('transientFailure') }
      }
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
