// Live Kimi Code quota via the CLI's own usage endpoint (ported from the
// menubar's KimiSubscriptionService.swift):
//
// - GET https://api.kimi.com/coding/v1/usages
//     Headers mirror observed Kimi Code client responses (X-Msh-Platform /
//     X-Msh-Device-Id). Numeric fields have shipped as both JSON numbers and
//     strings, and the reset stamp under several spellings, so decode leniently.
//
// Credential: the Kimi CLI's own ~/.kimi-code/credentials/kimi-code.json,
// read-only. Access tokens live ~15 minutes and ONLY the Kimi CLI refreshes
// them — we never refresh and never write, so an expired or rejected token is a
// terminal state whose footer tells the user to run the Kimi CLI once.
import os from 'node:os'
import path from 'node:path'

import { fraction, quotaRequestSignal, readSecureFile, sanitizeError } from './security'
import type { QuotaProvider, QuotaWindow } from './types'

const USAGE_ENDPOINT = 'https://api.kimi.com/coding/v1/usages'
const EXPIRED_FOOTER = ['Login expired. Run the Kimi CLI once, then refresh.']

const kimiHome = process.env['KIMI_CODE_HOME'] ?? path.join(os.homedir(), '.kimi-code')

export type KimiDeps = {
  fetch: typeof fetch
  credentialPath: string
  deviceIdPath: string
  readFile: typeof readSecureFile
  now: () => number
}

const defaults: KimiDeps = {
  fetch: globalThis.fetch,
  credentialPath: path.join(kimiHome, 'credentials', 'kimi-code.json'),
  deviceIdPath: path.join(kimiHome, 'device_id'),
  readFile: readSecureFile,
  now: Date.now,
}

function empty(connection: QuotaProvider['connection'], footerLines: string[] = []): QuotaProvider {
  return { provider: 'kimi', connection, primary: null, details: [], planLabel: null, footerLines }
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** `null` = no usable credential; `'expired'` = present but past its life. */
async function freshToken(deps: KimiDeps): Promise<string | null | 'expired'> {
  const raw = await deps.readFile(deps.credentialPath, 64 * 1024)
  if (!raw) return null
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const token = parsed.access_token
  if (typeof token !== 'string' || !token) return null
  const expiresAt = num(parsed.expires_at)
  // 60s skew, matching the menubar: a token about to die is already useless.
  if (expiresAt === null || expiresAt <= deps.now() / 1000 + 60) return 'expired'
  return token
}

async function deviceId(deps: KimiDeps): Promise<string | null> {
  try {
    const raw = await deps.readFile(deps.deviceIdPath, 4 * 1024)
    return raw?.trim() || null
  } catch {
    return null
  }
}

/** Reset stamps arrive as ISO-8601 or as epoch seconds (string or number). */
function resetsAt(value: unknown): string | null {
  const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : null
  if (!raw) return null
  // Bare digits are epoch seconds; Date.parse would misread them as a year.
  if (/^\d+(\.\d+)?$/.test(raw)) return new Date(Number(raw) * 1000).toISOString()
  const iso = Date.parse(raw)
  return Number.isFinite(iso) ? new Date(iso).toISOString() : null
}

function windowOf(label: string, detail: unknown): QuotaWindow | null {
  if (!detail || typeof detail !== 'object') return null
  const row = detail as Record<string, unknown>
  const limit = num(row.limit)
  if (limit === null || limit <= 0) return null
  const remaining = num(row.remaining)
  // Rate-limit windows report only limit + remaining — derive used.
  const used = num(row.used) ?? Math.max(0, limit - (remaining ?? limit))
  return {
    label,
    // Over-limit usage clamps to 100% rather than overflowing the bar.
    percent: fraction(used / limit * 100)!,
    resetsAt: resetsAt(row.resetTime ?? row.resetAt ?? row.reset_time ?? row.reset_at),
  }
}

/** Window size → human label. The API sends enum-style units
 *  ("TIME_UNIT_MINUTE", duration 300) as well as plain ones ("hour"), so
 *  normalize first; exact sub-day durations roll up (300 minutes → 5-hour). */
function windowLabel(duration: unknown, timeUnit: unknown): string {
  let value = num(duration)
  if (value === null || typeof timeUnit !== 'string' || !timeUnit) return 'Rate Limit'
  let unit = timeUnit.toLowerCase().replace(/^time_unit_/, '').replace(/s$/, '')
  if (unit === 'minute' && value >= 60 && value % 60 === 0) { value /= 60; unit = 'hour' }
  const count = Math.trunc(value)
  switch (unit) {
    case 'minute': return count === 1 ? 'Minutely' : `${count}-min`
    case 'hour': return count === 1 ? 'Hourly' : `${count}-hour`
    case 'day': return count === 1 ? 'Daily' : count === 7 ? 'Weekly' : `${count}-day`
    case 'week': return count === 1 ? 'Weekly' : `${count}-week`
    case 'month': return count === 1 ? 'Monthly' : `${count}-month`
    default: return `${count} ${unit}`
  }
}

/** "LEVEL_INTERMEDIATE" → "Intermediate"; unknown/missing → null so the UI
 *  falls back to the plain "Kimi Code" title. */
function planLabel(level: unknown): string | null {
  if (typeof level !== 'string' || !level.trim()) return null
  return level.trim().replace(/^LEVEL_/i, '').replace(/_/g, ' ').toLowerCase()
    .replace(/(^|\s)\w/g, match => match.toUpperCase())
}

/** `null` when the payload carries no usable window at all. */
export function decodeKimiUsage(body: unknown): QuotaProvider | null {
  const data = body && typeof body === 'object' ? body as Record<string, any> : {}
  // The top-level usage envelope is the account's weekly quota (its reset lands
  // ~7 days out), so label it the way the menubar does.
  const primary = windowOf('Weekly', data.usage)
  const rest = (Array.isArray(data.limits) ? data.limits : [])
    .map((limit: any) => windowOf(windowLabel(limit?.window?.duration, limit?.window?.timeUnit), limit?.detail))
    .filter((window: QuotaWindow | null): window is QuotaWindow => window !== null)
  const details = primary ? [primary, ...rest] : rest
  if (details.length === 0) return null
  const parallel = num(data.parallel?.limit)
  return {
    provider: 'kimi', connection: 'connected',
    primary: primary ?? details[0]!,
    details,
    planLabel: planLabel(data.user?.membership?.level),
    footerLines: parallel !== null && parallel > 0 ? [`Parallel sessions: ${Math.trunc(parallel)}`] : [],
  }
}

export type KimiResult = { quota: QuotaProvider; retryAfterSeconds?: number }

export async function fetchKimiQuota(options: Partial<KimiDeps> & { signal?: AbortSignal } = {}): Promise<KimiResult> {
  const deps = { ...defaults, ...options }
  try {
    const token = await freshToken(deps)
    if (token === null) return { quota: empty('disconnected') }
    if (token === 'expired') return { quota: { ...empty('terminalFailure', EXPIRED_FOOTER), connectable: true } }

    const device = await deviceId(deps)
    const response = await deps.fetch(USAGE_ENDPOINT, {
      method: 'GET', signal: quotaRequestSignal(options.signal),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': 'CodeBurn',
        'X-Msh-Platform': 'kimi_code_cli',
        ...(device ? { 'X-Msh-Device-Id': device } : {}),
      },
    })
    // We never self-refresh, so a rejected token is terminal until the CLI runs.
    if (response.status === 401 || response.status === 403) return { quota: { ...empty('terminalFailure', EXPIRED_FOOTER), connectable: true } }
    if (response.status === 429) {
      const raw = response.headers.get('Retry-After')
      const seconds = raw === null ? NaN : Number(raw)
      return { quota: empty('transientFailure'), retryAfterSeconds: Math.max(Number.isFinite(seconds) ? Math.ceil(seconds) : 300, 60) }
    }
    if (!response.ok) return { quota: empty(response.status >= 400 && response.status < 500 ? 'terminalFailure' : 'transientFailure') }
    // Never log the body — it carries account data.
    const quota = decodeKimiUsage(await response.json())
    return { quota: quota ?? empty('transientFailure') }
  } catch (error) {
    console.warn(`Kimi quota unavailable: ${sanitizeError(error)}`)
    return { quota: empty('transientFailure') }
  }
}
