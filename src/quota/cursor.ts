// Live Cursor quota via the app's own usage-summary endpoint (ported from the
// menubar's CursorSubscriptionService.swift):
//
// - GET https://cursor.com/api/usage-summary
//     Authenticated with the session cookie Cursor itself sends
//     (WorkosCursorSessionToken=<userId>%3A%3A<jwt>), not a bearer header.
//
// Credential: the access token the Cursor app already keeps in its own VS Code
// state database, under the ItemTable key `cursorAuth/accessToken`, opened
// read-only. Nothing is copied and nothing is written; CodeBurn never refreshes
// the session, so an expired token is terminal until the user signs in again.
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { quotaRequestSignal, sanitizeError } from './security.js'
import type { QuotaProvider, QuotaWindow } from './types.js'

const USAGE_ENDPOINT = 'https://cursor.com/api/usage-summary'
const ACCESS_TOKEN_KEY = 'cursorAuth/accessToken'
const SOURCE_FOOTER = ['Source: Cursor app']
const SIGNED_OUT_FOOTER = ['Sign in to the Cursor app, then click Retry.']
const EXPIRED_FOOTER = ['The Cursor app session is expired or invalid. Sign in again, then click Retry.']
const REJECTED_FOOTER = ['Cursor rejected the current app session. Sign in again, then click Retry.']
const UNREADABLE_FOOTER = ["Could not read the Cursor app's local session data. Quit and reopen Cursor, then click Retry."]
const RATE_LIMITED_FOOTER = ['Cursor rate-limited the quota request.']
const UNAVAILABLE_FOOTER = ['Cursor is temporarily unavailable.']
const PARSE_FOOTER = ['Cursor returned an unrecognized quota response.']

/** Cursor is an Electron app, so its state database follows the VS Code layout
 *  of whichever platform it runs on. */
export function cursorDatabasePath(
  platform: string = process.platform,
  home: string = os.homedir(),
): string {
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  }
  if (platform === 'win32') {
    return path.join(home, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  }
  return path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
}

export type CursorDeps = {
  fetch: typeof fetch
  databasePath: string
  /** Resolves the app's access token; `null` when Cursor is not signed in. */
  loadAccessToken: (databasePath: string) => Promise<string | null>
  now: () => number
}

/**
 * Read-only lookup of one row in Cursor's state database. The sqlite driver is
 * imported lazily so a machine without Cursor never loads it.
 */
export async function cursorAccessTokenFromDatabase(databasePath: string): Promise<string | null> {
  if (!existsSync(databasePath)) return null
  const { blobToText, openDatabase } = await import('../sqlite.js')
  const db = openDatabase(databasePath)
  try {
    const rows = db.query<{ value: Uint8Array | string | null }>(
      'SELECT CAST(value AS BLOB) AS value FROM ItemTable WHERE key = ? LIMIT 1',
      [ACCESS_TOKEN_KEY],
    )
    const value = blobToText(rows[0]?.value).trim()
    return value.length > 0 ? value : null
  } finally {
    db.close()
  }
}

// Resolved per call so a caller can change the platform the path is derived
// from without reloading the module.
function defaultDeps(): CursorDeps {
  return {
    fetch: globalThis.fetch,
    databasePath: cursorDatabasePath(),
    loadAccessToken: cursorAccessTokenFromDatabase,
    now: Date.now,
  }
}

function empty(connection: QuotaProvider['connection'], footerLines: string[] = []): QuotaProvider {
  return { provider: 'cursor', connection, primary: null, details: [], planLabel: null, footerLines }
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Provider-reported percentages are 0..100 and never negative; a value above
 *  the limit clamps rather than overflowing the bar. */
function providerPercent(value: unknown): number | null {
  const parsed = num(value)
  if (parsed === null || parsed < 0) return null
  return Math.min(1, parsed / 100)
}

function ratio(used: unknown, limit: unknown): number | null {
  const usedValue = num(used)
  const limitValue = num(limit)
  if (usedValue === null || limitValue === null || usedValue < 0 || limitValue <= 0) return null
  return Math.min(1, Math.max(0, usedValue / limitValue))
}

function resetsAt(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function planLabel(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const raw = value.trim()
  const known: Record<string, string> = {
    pro: 'Pro', pro_plus: 'Pro Plus', 'pro plus': 'Pro Plus', business: 'Business',
    enterprise: 'Enterprise', hobby: 'Hobby', free: 'Hobby', ultra: 'Ultra',
  }
  return known[raw.toLowerCase()] ?? raw
}

/** `null` when the payload carries no usable percentage. */
export function decodeCursorUsage(body: unknown): QuotaProvider | null {
  const data = body && typeof body === 'object' ? body as Record<string, any> : {}
  const plan = data.individualUsage?.plan
  const overall = data.individualUsage?.overall
  const pooled = data.teamUsage?.pooled
  const teamOnDemand = data.teamUsage?.onDemand
  const auto = providerPercent(plan?.autoPercentUsed)
  const api = providerPercent(plan?.apiPercentUsed)

  // A capacity gauge must surface the pool that is about to run out, so the
  // fallback takes the worse of the two rather than averaging them.
  const monthly = providerPercent(plan?.totalPercentUsed)
    ?? (auto !== null && api !== null ? Math.max(auto, api) : api ?? auto)
    ?? ratio(plan?.used, plan?.limit)
    ?? ratio(overall?.used, overall?.limit)
    ?? ratio(pooled?.used, pooled?.limit)
    ?? (data.isUnlimited === true ? 0 : null)
  // Enterprise team seats report no individual meter; the team on-demand
  // meter is the only structured used/limit pair in their payload.
  const teamOnDemandPercent = teamOnDemand?.enabled === false ? null : ratio(teamOnDemand?.used, teamOnDemand?.limit)
  const primaryPercent = monthly ?? teamOnDemandPercent
  if (primaryPercent === null) return null

  const reset = resetsAt(data.billingCycleEnd)
  const primary: QuotaWindow = { label: monthly === null ? 'Team on-demand' : 'Monthly', percent: primaryPercent, resetsAt: reset }
  const details = [primary]
  if (auto !== null) details.push({ label: 'Auto', percent: auto, resetsAt: reset })
  if (api !== null) details.push({ label: 'API', percent: api, resetsAt: reset })
  const onDemand = data.individualUsage?.onDemand
  const onDemandPercent = onDemand?.enabled === false ? null : ratio(onDemand?.used, onDemand?.limit)
  if (onDemandPercent !== null) details.push({ label: 'On-demand', percent: onDemandPercent, resetsAt: reset })
  const teamPercent = ratio(pooled?.used, pooled?.limit)
  if (teamPercent !== null) details.push({ label: 'Team pool', percent: teamPercent, resetsAt: reset })
  if (monthly !== null && teamOnDemandPercent !== null) details.push({ label: 'Team on-demand', percent: teamOnDemandPercent, resetsAt: reset })

  return {
    provider: 'cursor', connection: 'connected',
    primary, details,
    planLabel: planLabel(data.membershipType),
    footerLines: SOURCE_FOOTER,
  }
}

function decodeBase64Url(value: string): string | null {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4)
  try {
    return Buffer.from(padded, 'base64').toString('utf8')
  } catch {
    return null
  }
}

/**
 * Cursor's web session is the JWT plus the user id encoded inside it. Anything
 * that is not a live three-part token with a usable subject is an expired or
 * invalid session, never a request worth making.
 */
export function cursorSessionCookie(token: string, now: number): string | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const payload = decodeBase64Url(parts[1]!)
  if (payload === null) return null
  let claims: { sub?: unknown; exp?: unknown }
  try {
    claims = JSON.parse(payload) as { sub?: unknown; exp?: unknown }
  } catch {
    return null
  }
  if (typeof claims.sub !== 'string') return null
  const userId = claims.sub.split('|').filter(part => part.length > 0).pop()
  if (!userId || !/^[A-Za-z0-9._-]+$/.test(userId)) return null
  const expiresAt = num(claims.exp)
  // 60s skew, matching the menubar: a token about to die is already useless.
  if (expiresAt === null || expiresAt * 1000 - now <= 60_000) return null
  return `WorkosCursorSessionToken=${userId}%3A%3A${token}`
}

export type CursorResult = { quota: QuotaProvider; retryAfterSeconds?: number }

export async function fetchCursorQuota(options: Partial<CursorDeps> & { signal?: AbortSignal } = {}): Promise<CursorResult> {
  const deps = { ...defaultDeps(), ...options }
  let token: string | null
  try {
    token = (await deps.loadAccessToken(deps.databasePath))?.trim() || null
  } catch (error) {
    // Cursor holding a write lock, or a database this build cannot open, is a
    // local condition that clears itself; never a signed-out user.
    console.warn(`Cursor quota unavailable: ${sanitizeError(error)}`)
    return { quota: empty('transientFailure', UNREADABLE_FOOTER) }
  }
  if (!token) return { quota: empty('disconnected', SIGNED_OUT_FOOTER) }

  const cookie = cursorSessionCookie(token, deps.now())
  if (cookie === null) return { quota: empty('terminalFailure', EXPIRED_FOOTER) }

  try {
    const response = await deps.fetch(USAGE_ENDPOINT, {
      method: 'GET', signal: quotaRequestSignal(options.signal),
      headers: { Accept: 'application/json', Cookie: cookie, 'User-Agent': 'CodeBurn' },
    })
    if (response.status === 401 || response.status === 403) return { quota: empty('terminalFailure', REJECTED_FOOTER) }
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
    const quota = decodeCursorUsage(await response.json())
    return { quota: quota ?? empty('transientFailure', PARSE_FOOTER) }
  } catch (error) {
    console.warn(`Cursor quota unavailable: ${sanitizeError(error)}`)
    return { quota: empty('transientFailure') }
  }
}
