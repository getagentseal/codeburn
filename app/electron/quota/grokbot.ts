// Live Grok Bot weekly allowance (ported from src/quota/grokbot.ts, which the
// CLI uses, and from the menubar's GrokBotSubscriptionService.swift):
//
// - POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus
//     Connect-RPC, empty JSON body, `Authorization: Bearer <cursor token>`.
//     Response: usagePercent (0..100), nextResetTimestampUtc,
//     hasNonZeroIncludedLimit, usesPooledEnterpriseAllowance, grokPlanLabel.
//
// Credential: the Cursor IDE's OWN access token, unencrypted in its VS Code
// state database under `cursorAuth/accessToken`, opened read-only. Grok Bot
// keeps its own copy of the same Cursor session in Electron safe storage, which
// CodeBurn never decrypts, so this reading is Grok Bot's only while the Cursor
// app is signed into the account Grok Bot uses.
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { quotaRequestSignal, sanitizeError } from './security'
import type { QuotaProvider, QuotaWindow } from './types'

const USAGE_ENDPOINT = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus'
const ACCESS_TOKEN_KEY = 'cursorAuth/accessToken'
const SOURCE_FOOTER = ['Source: Cursor dashboard (the account the Cursor app is signed into)']
const SIGNED_OUT_FOOTER = ['Sign in to the Cursor app with the account Grok Bot uses, then Refresh.']
const REJECTED_FOOTER = ['Cursor rejected the current app session. Sign in again, then Refresh.']
const UNREADABLE_FOOTER = ["Could not read the Cursor app's local session data. Quit and reopen Cursor, then Refresh."]
const RATE_LIMITED_FOOTER = ['Cursor rate-limited the quota request.']
const UNAVAILABLE_FOOTER = ['Grok Bot quota is temporarily unavailable.']
const PARSE_FOOTER = ['Cursor returned an unrecognized Grok Bot quota response.']
const NO_ALLOWANCE_FOOTER = ['This account has no included Grok Bot allowance.']
const POOLED_FOOTER = ['Grok Bot usage is drawn from a pooled enterprise allowance, which has no per-account reading.']

/** Cursor is an Electron app, so its state database follows the VS Code layout
 *  of whichever platform it runs on. */
export function cursorDatabasePath(platform: string = process.platform, home: string = os.homedir()): string {
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  }
  if (platform === 'win32') {
    return path.join(home, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  }
  return path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
}

/** The app is a normal drag-install, so either Applications folder counts;
 *  `~/.grokbot` is its data root, which survives a moved bundle. */
export function grokbotInstalled(
  platform: string = process.platform,
  home: string = os.homedir(),
  systemApplications = '/Applications',
): boolean {
  const bundles = platform === 'darwin'
    ? [path.join(systemApplications, 'Grok Bot.app'), path.join(home, 'Applications', 'Grok Bot.app')]
    : []
  return [...bundles, path.join(home, '.grokbot')].some(existsSync)
}

/** Read-only lookup of one row in Cursor's state database. `node:sqlite` is
 *  imported lazily so a machine without Cursor never loads it. */
export async function cursorAccessTokenFromDatabase(databasePath: string): Promise<string | null> {
  if (!existsSync(databasePath)) return null
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    // Cursor is usually running and holding a write lock; without this a read
    // gets SQLITE_BUSY at once. Wait it out the same 1s the CLI opener does.
    db.exec?.('PRAGMA busy_timeout = 1000')
  } catch {
    // Best effort. Some Node sqlite builds may not expose exec on DatabaseSync.
  }
  try {
    const rows = db.prepare('SELECT value FROM ItemTable WHERE key = ? LIMIT 1').all(ACCESS_TOKEN_KEY)
    const value = rows[0]?.['value']
    const text = typeof value === 'string'
      ? value
      : value instanceof Uint8Array ? new TextDecoder('utf-8', { fatal: false }).decode(value) : ''
    return text.trim().length > 0 ? text.trim() : null
  } finally {
    db.close()
  }
}

export type GrokbotDeps = {
  fetch: typeof fetch
  databasePath: string
  loadAccessToken: (databasePath: string) => Promise<string | null>
}

function defaults(): GrokbotDeps {
  return {
    fetch: globalThis.fetch,
    databasePath: cursorDatabasePath(),
    loadAccessToken: cursorAccessTokenFromDatabase,
  }
}

function empty(connection: QuotaProvider['connection'], footerLines: string[] = []): QuotaProvider {
  return { provider: 'grokbot', connection, primary: null, details: [], planLabel: null, footerLines }
}

function resetsAt(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** `null` when the payload carries no usable percentage; the two sentinels
 *  mirror the app's own refusals, which show no reading on a pooled enterprise
 *  allowance or a zero included limit. */
export function decodeGrokbotUsage(body: unknown): QuotaProvider | 'noAllowance' | 'pooled' | null {
  const data = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  if (data['usesPooledEnterpriseAllowance'] === true) return 'pooled'
  if (data['hasNonZeroIncludedLimit'] === false) return 'noAllowance'

  const raw = data['usagePercent']
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null

  const window: QuotaWindow = {
    label: 'Weekly usage',
    percent: Math.min(1, raw / 100),
    resetsAt: resetsAt(data['nextResetTimestampUtc']),
  }
  return {
    provider: 'grokbot',
    connection: 'connected',
    primary: window,
    details: [window],
    planLabel: nonEmpty(data['grokPlanLabel']),
    footerLines: SOURCE_FOOTER,
  }
}

export async function fetchGrokbotQuota(
  options: Partial<GrokbotDeps> & { signal?: AbortSignal } = {},
): Promise<{ quota: QuotaProvider; retryAfterSeconds?: number }> {
  const deps = { ...defaults(), ...options }
  let token: string | null
  try {
    token = (await deps.loadAccessToken(deps.databasePath))?.trim() || null
  } catch (error) {
    // Cursor holding a write lock, or a database this build cannot open, is a
    // local condition that clears itself; never a signed-out user.
    console.warn(`Grok Bot quota unavailable: ${sanitizeError(error)}`)
    return { quota: empty('transientFailure', UNREADABLE_FOOTER) }
  }
  if (!token) return { quota: empty('disconnected', SIGNED_OUT_FOOTER) }

  try {
    const response = await deps.fetch(USAGE_ENDPOINT, {
      method: 'POST',
      body: '{}',
      signal: quotaRequestSignal(options.signal),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'connect-protocol-version': '1',
        'User-Agent': 'CodeBurn',
      },
    })
    if (response.status === 401 || response.status === 403) return { quota: { ...empty('terminalFailure', REJECTED_FOOTER), connectable: true } }
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
    const decoded = decodeGrokbotUsage(await response.json())
    // Terminal, not disconnected: the account is signed in and answering, it
    // simply has no per-account reading, so Plans shows the reason rather than
    // the "sign in to Cursor" affordance.
    if (decoded === 'pooled') return { quota: empty('terminalFailure', POOLED_FOOTER) }
    if (decoded === 'noAllowance') return { quota: empty('terminalFailure', NO_ALLOWANCE_FOOTER) }
    if (decoded === null) return { quota: empty('transientFailure', PARSE_FOOTER) }
    return { quota: decoded }
  } catch (error) {
    console.warn(`Grok Bot quota unavailable: ${sanitizeError(error)}`)
    return { quota: empty('transientFailure') }
  }
}
