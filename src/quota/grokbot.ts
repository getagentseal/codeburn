// Live Grok Bot weekly allowance, read from the same Cursor dashboard call the
// desktop app makes for its own "Weekly usage" reading:
//
// - POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus
//     Connect-RPC, empty JSON body, `Authorization: Bearer <cursor token>`.
//     Response: usagePercent (0..100), currentPeriodStart,
//     nextResetTimestampUtc, hasNonZeroIncludedLimit,
//     usesPooledEnterpriseAllowance, and grokPlanLabel on newer builds.
//
// Credential: the Cursor IDE's OWN access token, unencrypted in its VS Code
// state database under `cursorAuth/accessToken` and already read read-only by
// src/quota/cursor.ts, whose lookup is reused here rather than duplicated.
// Grok Bot keeps its own copy of the same Cursor session in Electron safe
// storage, which CodeBurn never decrypts (see src/quota/codex.ts), so this
// reading is only the app's reading when the IDE is signed into the account
// Grok Bot uses.
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { cursorAccessTokenFromDatabase, cursorDatabasePath } from './cursor.js'
import { quotaRequestSignal, sanitizeError } from './security.js'
import type { QuotaProvider, QuotaWindow } from './types.js'

const USAGE_ENDPOINT = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus'
const WINDOW_LABEL = 'Weekly usage'
const SOURCE_FOOTER = ['Source: Cursor dashboard (the account the Cursor app is signed into)']
const SIGNED_OUT_FOOTER = ['Sign in to the Cursor app with the account Grok Bot uses, then click Retry.']
const REJECTED_FOOTER = ['Cursor rejected the current app session. Sign in again, then click Retry.']
const UNREADABLE_FOOTER = ["Could not read the Cursor app's local session data. Quit and reopen Cursor, then click Retry."]
const RATE_LIMITED_FOOTER = ['Cursor rate-limited the quota request.']
const UNAVAILABLE_FOOTER = ['Grok Bot quota is temporarily unavailable.']
const PARSE_FOOTER = ['Cursor returned an unrecognized Grok Bot quota response.']
const NO_ALLOWANCE_FOOTER = ['This account has no included Grok Bot allowance.']
const POOLED_FOOTER = ['Grok Bot usage is drawn from a pooled enterprise allowance, which has no per-account reading.']

/** The app is a normal drag-install, so either Applications folder counts;
 *  `~/.grokbot` is its data root, which survives a moved bundle. Without the
 *  app there is nothing to report: the Cursor session would still answer, but
 *  that allowance is not Grok Bot's. */
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

export type GrokbotQuotaDeps = {
  fetch: typeof fetch
  databasePath: string
  /** Resolves the Cursor app's access token; `null` when it is not signed in. */
  loadAccessToken: (databasePath: string) => Promise<string | null>
}

function defaultDeps(): GrokbotQuotaDeps {
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

/** `null` when the payload carries no usable percentage, or when the account
 *  has nothing of its own to report. Mirrors the app's own refusals: it shows
 *  no reading on a pooled enterprise allowance or a zero included limit. */
export function decodeGrokbotUsage(body: unknown): QuotaProvider | 'noAllowance' | 'pooled' | null {
  const data = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  if (data['usesPooledEnterpriseAllowance'] === true) return 'pooled'
  if (data['hasNonZeroIncludedLimit'] === false) return 'noAllowance'

  const raw = data['usagePercent']
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null

  const window: QuotaWindow = {
    label: WINDOW_LABEL,
    percent: Math.min(1, raw / 100),
    resetsAt: resetsAt(data['nextResetTimestampUtc']),
  }
  return {
    provider: 'grokbot', connection: 'connected',
    primary: window,
    details: [window],
    planLabel: nonEmpty(data['grokPlanLabel']),
    footerLines: SOURCE_FOOTER,
  }
}

export type GrokbotQuotaResult = { quota: QuotaProvider; retryAfterSeconds?: number }

export async function fetchGrokbotQuota(
  options: Partial<GrokbotQuotaDeps> & { signal?: AbortSignal } = {},
): Promise<GrokbotQuotaResult> {
  const deps = { ...defaultDeps(), ...options }
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
    const decoded = decodeGrokbotUsage(await response.json())
    // Terminal, not disconnected: the account is signed in and answering, it
    // simply has no per-account reading, so the surfaces must show the reason
    // rather than a "sign in to Cursor" affordance.
    if (decoded === 'pooled') return { quota: empty('terminalFailure', POOLED_FOOTER) }
    if (decoded === 'noAllowance') return { quota: empty('terminalFailure', NO_ALLOWANCE_FOOTER) }
    if (decoded === null) return { quota: empty('transientFailure', PARSE_FOOTER) }
    return { quota: decoded }
  } catch (error) {
    console.warn(`Grok Bot quota unavailable: ${sanitizeError(error)}`)
    return { quota: empty('transientFailure') }
  }
}
