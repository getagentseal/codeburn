import { existsSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import {
  ClaudeCredentialError,
  freshClaudeAccessToken,
  getCurrentClaudeRecord,
  rebootstrapClaudeCredentials,
  refreshClaudeAccessTokenAfter401,
} from './claude-credentials.js'

/**
 * Fetches live subscription quota data from Anthropic's OAuth usage endpoint
 * and surfaces it for the CLI / dashboard / menubar payload. Mirrors
 * `mac/Sources/CodeBurnMenubar/Data/ClaudeSubscriptionService.swift`.
 *
 * The endpoint is the same one the `claude` CLI itself uses to render
 * `/usage`. It is intentionally addressed with the OAuth-flavoured beta
 * header so it stays usable with the OAuth access token CodeBurn already
 * reads from `~/.claude/.credentials.json` or the macOS Keychain. No API
 * key is required, and CodeBurn never proxies provider calls.
 */

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const BETA_HEADER = 'oauth-2025-04-20'
const USER_AGENT = 'claude-code/2.1.0'
const BACKOFF_FILENAME = 'claude-quota-backoff.json'
const RATE_LIMIT_FLOOR_SECONDS = 60
const RATE_LIMIT_DEFAULT_SECONDS = 300

export type SubscriptionTier =
  | 'pro'
  | 'max_5x'
  | 'max_20x'
  | 'team'
  | 'enterprise'
  | 'unknown'

export type QuotaWindow = {
  /**
   * Anthropic returns utilization on a percent scale already (0..100, can
   * exceed 100 when the user is over-limit). We keep that scale end-to-end —
   * no extra multiplication when rendering or serialising.
   */
  utilization: number
  resetsAt: Date | null
}

export type SubscriptionQuota = {
  tier: SubscriptionTier
  rawTier: string | null
  fiveHour: QuotaWindow | null
  sevenDay: QuotaWindow | null
  sevenDayOpus: QuotaWindow | null
  sevenDaySonnet: QuotaWindow | null
  fetchedAt: Date
}

export type ClaudeQuotaErrorCode =
  | 'not_connected'
  | 'rate_limited'
  | 'http'
  | 'decode'
  | 'network'
  | 'credential_terminal'
  | 'credential_transient'

export class ClaudeQuotaError extends Error {
  readonly code: ClaudeQuotaErrorCode
  readonly httpStatus?: number
  readonly httpBody?: string
  readonly rateLimitRetryAt?: Date

  constructor(
    code: ClaudeQuotaErrorCode,
    message: string,
    opts?: { httpStatus?: number; httpBody?: string; rateLimitRetryAt?: Date },
  ) {
    super(message)
    this.name = 'ClaudeQuotaError'
    this.code = code
    this.httpStatus = opts?.httpStatus
    this.httpBody = opts?.httpBody
    this.rateLimitRetryAt = opts?.rateLimitRetryAt
  }

  /** True when the user must take action (sign in again). */
  get isTerminal(): boolean {
    return this.code === 'not_connected' || this.code === 'credential_terminal'
  }
}

type FetchUsageResult = { status: number; body: string; retryAfterHeader?: string | null }

type Hooks = {
  fetchUsage?: (token: string) => Promise<FetchUsageResult>
  now?: () => Date
}

let hooks: Hooks = {}

/** Internal: test hook injection. */
export function setClaudeQuotaHooks(next: Hooks): void {
  hooks = { ...next }
}

export function resetClaudeQuotaHooks(): void {
  hooks = {}
}

function now(): Date {
  return hooks.now ? hooks.now() : new Date()
}

function getCacheDir(): string {
  return process.env['CODEBURN_CACHE_DIR'] ?? join(homedir(), '.cache', 'codeburn')
}

function getBackoffPath(): string {
  return join(getCacheDir(), BACKOFF_FILENAME)
}

async function readBackoffUntil(): Promise<Date | null> {
  const path = getBackoffPath()
  if (!existsSync(path)) return null
  try {
    const raw = await readFile(path, { encoding: 'utf-8' })
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const u = (parsed as { until?: unknown }).until
    if (typeof u !== 'string') return null
    const d = new Date(u)
    if (Number.isNaN(d.getTime())) return null
    return d
  } catch {
    return null
  }
}

async function writeBackoffUntil(until: Date): Promise<void> {
  const dir = getCacheDir()
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  await writeFile(getBackoffPath(), JSON.stringify({ until: until.toISOString() }), { encoding: 'utf-8' })
}

async function clearBackoff(): Promise<void> {
  const path = getBackoffPath()
  if (!existsSync(path)) return
  try {
    await writeFile(path, JSON.stringify({ until: null }), { encoding: 'utf-8' })
  } catch {
    /* best-effort */
  }
}

function parseRetryAfterHeader(header: string | null | undefined): number | null {
  if (!header) return null
  // RFC 7231: Retry-After is either a delta in seconds or an HTTP-date.
  const trimmed = header.trim()
  const n = parseInt(trimmed, 10)
  if (Number.isFinite(n) && String(n) === trimmed) return n
  const date = new Date(trimmed)
  if (!Number.isNaN(date.getTime())) {
    return Math.max(0, Math.floor((date.getTime() - Date.now()) / 1000))
  }
  return null
}

function parseRetryAfterBody(body: string | null): number | null {
  if (!body) return null
  try {
    const parsed: unknown = JSON.parse(body)
    if (!parsed || typeof parsed !== 'object') return null
    const v = (parsed as { retry_after?: unknown }).retry_after
    if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v)
    if (typeof v === 'string') {
      const n = parseInt(v, 10)
      if (Number.isFinite(n)) return n
    }
  } catch {
    /* fall through */
  }
  return null
}

function parseRetryAfter(result: FetchUsageResult): number | null {
  return parseRetryAfterHeader(result.retryAfterHeader ?? null) ?? parseRetryAfterBody(result.body)
}

async function recordRateLimit(retryAfterSeconds: number | null): Promise<Date> {
  const seconds = Math.max(retryAfterSeconds ?? RATE_LIMIT_DEFAULT_SECONDS, RATE_LIMIT_FLOOR_SECONDS)
  const until = new Date(now().getTime() + seconds * 1000)
  try {
    await writeBackoffUntil(until)
  } catch {
    /* best-effort */
  }
  return until
}

export function classifyTier(raw: string | null | undefined): SubscriptionTier {
  if (!raw) return 'unknown'
  const lower = raw.toLowerCase()
  if (lower.includes('max_20x') || lower.includes('max20x') || lower.includes('max-20x')) return 'max_20x'
  if (lower.includes('max_5x') || lower.includes('max5x') || lower.includes('max-5x')) return 'max_5x'
  if (lower.includes('max')) return 'max_5x'
  if (lower.includes('pro')) return 'pro'
  if (lower.includes('team')) return 'team'
  if (lower.includes('enterprise')) return 'enterprise'
  return 'unknown'
}

export function tierDisplayName(tier: SubscriptionTier): string {
  switch (tier) {
    case 'pro':
      return 'Pro'
    case 'max_5x':
      return 'Max 5x'
    case 'max_20x':
      return 'Max 20x'
    case 'team':
      return 'Team'
    case 'enterprise':
      return 'Enterprise'
    case 'unknown':
      return 'Subscription'
  }
}

function parseWindow(raw: unknown): QuotaWindow | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { utilization?: unknown; resets_at?: unknown }
  if (typeof r.utilization !== 'number' || !Number.isFinite(r.utilization)) return null
  let resetsAt: Date | null = null
  if (typeof r.resets_at === 'string' && r.resets_at.length > 0) {
    const d = new Date(r.resets_at)
    if (!Number.isNaN(d.getTime())) resetsAt = d
  }
  return { utilization: r.utilization, resetsAt }
}

function mapResponse(body: string, rawTier: string | null): SubscriptionQuota {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new ClaudeQuotaError('decode', 'Quota response was malformed.')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new ClaudeQuotaError('decode', 'Quota response was malformed.')
  }
  const p = parsed as Record<string, unknown>
  return {
    tier: classifyTier(rawTier),
    rawTier,
    fiveHour: parseWindow(p['five_hour']),
    sevenDay: parseWindow(p['seven_day']),
    sevenDayOpus: parseWindow(p['seven_day_opus']),
    sevenDaySonnet: parseWindow(p['seven_day_sonnet']),
    fetchedAt: now(),
  }
}

async function defaultFetchUsage(token: string): Promise<FetchUsageResult> {
  let response: Response
  try {
    response = await fetch(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'anthropic-beta': BETA_HEADER,
        'User-Agent': USER_AGENT,
      },
    })
  } catch (err) {
    throw new ClaudeQuotaError('network', `Network error: ${(err as Error).message}`)
  }
  const text = await response.text()
  return {
    status: response.status,
    body: text,
    retryAfterHeader: response.headers.get('retry-after'),
  }
}

async function fetchOnce(token: string): Promise<FetchUsageResult> {
  const fetcher = hooks.fetchUsage ?? defaultFetchUsage
  return await fetcher(token)
}

/**
 * Fetches the live subscription quota. Returns `null` when no local Claude
 * credentials are available (so callers can degrade silently in places like
 * the menubar payload). Throws `ClaudeQuotaError` for all other failure
 * modes — rate-limited windows, HTTP errors, malformed responses, etc.
 */
export async function fetchClaudeQuota(): Promise<SubscriptionQuota | null> {
  const record = await getCurrentClaudeRecord()
  if (!record) return null

  const blockedUntil = await readBackoffUntil()
  if (blockedUntil && blockedUntil > now()) {
    throw new ClaudeQuotaError(
      'rate_limited',
      `Anthropic rate-limited the quota endpoint. Retrying after ${blockedUntil.toISOString()}.`,
      { rateLimitRetryAt: blockedUntil },
    )
  }

  let token: string
  try {
    const fresh = await freshClaudeAccessToken()
    if (!fresh) return null
    token = fresh
  } catch (err) {
    if (err instanceof ClaudeCredentialError) {
      // Terminal credential failures can mean the user re-logged into the
      // `claude` CLI but we are still pinned to a dead cached pair. Drop
      // the cache and try once with whatever is now in the source before
      // surfacing the error.
      if (err.isTerminal) {
        const fresh = await rebootstrapClaudeCredentials().catch(() => null)
        if (fresh) {
          token = fresh.accessToken
        } else {
          throw new ClaudeQuotaError('credential_terminal', err.message)
        }
      } else {
        throw new ClaudeQuotaError('credential_transient', err.message)
      }
    } else {
      throw err
    }
  }

  let attempt = await fetchOnce(token)
  let didRefresh = false

  if (attempt.status === 401) {
    try {
      token = await refreshClaudeAccessTokenAfter401()
      didRefresh = true
    } catch (err) {
      if (err instanceof ClaudeCredentialError) {
        if (err.isTerminal) {
          // Refresh path declared the cached credentials dead. Try to pick
          // up a freshly re-logged source before surfacing terminal so the
          // user does not have to manually delete our cache.
          const fresh = await rebootstrapClaudeCredentials().catch(() => null)
          if (fresh && fresh.accessToken !== token) {
            token = fresh.accessToken
            didRefresh = true
          } else {
            throw new ClaudeQuotaError('credential_terminal', err.message)
          }
        } else {
          throw new ClaudeQuotaError('credential_transient', err.message)
        }
      } else {
        throw err
      }
    }
    attempt = await fetchOnce(token)
  }

  switch (attempt.status) {
    case 200: {
      await clearBackoff()
      return mapResponse(attempt.body, record.rateLimitTier)
    }
    case 401: {
      // A 401 on a freshly refreshed token means the session is dead. Treat
      // it as terminal so the caller can prompt the user to reconnect
      // instead of looping.
      throw new ClaudeQuotaError(
        'credential_terminal',
        didRefresh
          ? 'Quota fetch still 401 after token refresh; reconnect required.'
          : `Quota fetch failed (HTTP 401)${attempt.body ? `: ${attempt.body}` : ''}`,
        { httpStatus: 401, httpBody: attempt.body },
      )
    }
    case 429: {
      const retryAfter = parseRetryAfter(attempt)
      const until = await recordRateLimit(retryAfter)
      throw new ClaudeQuotaError(
        'rate_limited',
        `Anthropic rate-limited the quota endpoint. Retrying after ${until.toISOString()}.`,
        { rateLimitRetryAt: until },
      )
    }
    default: {
      throw new ClaudeQuotaError(
        'http',
        `Quota fetch failed (HTTP ${attempt.status})${attempt.body ? `: ${attempt.body}` : ''}`,
        { httpStatus: attempt.status, httpBody: attempt.body },
      )
    }
  }
}

/**
 * Shape used by JSON / menubar consumers. Stable across releases so the
 * menubar app can rely on it without a coordinated version bump.
 */
export type SubscriptionQuotaJSON = {
  tier: SubscriptionTier
  rawTier: string | null
  fiveHour: { percent: number; resetsAt: string | null } | null
  sevenDay: { percent: number; resetsAt: string | null } | null
  sevenDayOpus: { percent: number; resetsAt: string | null } | null
  sevenDaySonnet: { percent: number; resetsAt: string | null } | null
  fetchedAt: string
}

function windowToJSON(w: QuotaWindow | null): { percent: number; resetsAt: string | null } | null {
  if (!w) return null
  return {
    percent: w.utilization,
    resetsAt: w.resetsAt ? w.resetsAt.toISOString() : null,
  }
}

export function quotaToJSON(q: SubscriptionQuota): SubscriptionQuotaJSON {
  return {
    tier: q.tier,
    rawTier: q.rawTier,
    fiveHour: windowToJSON(q.fiveHour),
    sevenDay: windowToJSON(q.sevenDay),
    sevenDayOpus: windowToJSON(q.sevenDayOpus),
    sevenDaySonnet: windowToJSON(q.sevenDaySonnet),
    fetchedAt: q.fetchedAt.toISOString(),
  }
}
