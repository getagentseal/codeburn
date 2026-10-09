import { createHash, randomBytes } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { dirname, join } from 'path'

import { getCodeburnCacheDir } from './cache-dir.js'
import { readConfig } from './config.js'
import { cursorImportPath, importCursorCsvText, loadCursorImport, replacedProviders, type CoverageRange, type CursorImportSummary } from './cursor-import.js'
import { invalidateProviderDays, toDateString } from './daily-cache.js'
import { cursorAccessTokenFromDatabase, cursorDatabasePath, cursorSessionCookie, cursorTokenClaims } from './quota/cursor.js'
import { sanitizeError } from './quota/security.js'

// Downloads the account's own usage export, the same CSV as Export CSV at
// cursor.com/dashboard/usage, with the session the Cursor app keeps locally
// (see quota/cursor.ts), and merges it into the Cursor import store.

const EXPORT_URL = 'https://cursor.com/api/dashboard/export-usage-events-csv'
// The menubar refresh calls this every poll, so the throttle is what bounds
// traffic to cursor.com. The jitter spreads installs that started together.
const THROTTLE_MS = 3_600_000
const JITTER_MS = 5 * 60_000
const REJECTED_BACKOFF_MS = 6 * 3_600_000
const MAX_FAILURES = 3
const FAILURE_BACKOFF_MS = 6 * 3_600_000
// A month's first backfill took 11-12.5s for 11k events on a real account.
const TIMEOUT_MS = 15_000
const BACKFILL_TIMEOUT_MS = 45_000
const FORCED_TIMEOUT_MS = 60_000

type SyncState = {
  lastAttemptAt?: number
  nextAttemptAt?: number
  lastSuccessAt?: number
  backoffUntil?: number
  // Consecutive failed requests; reset by a success.
  failures?: number
  // Token expiry Cursor rejected; a new token lifts the 401/403 backoff.
  rejectedExp?: number
  lastError?: string
  // Short hash of the token subject, never the subject itself.
  account?: string
  // Per account: the newest synced event, or the start of the day a sync
  // found nothing, so a quiet account is not re-downloaded from scratch.
  through?: Record<string, number>
}

// A sidecar, so recording an attempt never moves the import store's mtime.
export function cursorSyncStatePath(): string {
  return join(getCodeburnCacheDir(), 'imports', 'cursor-sync.v1.json')
}

async function readState(): Promise<SyncState> {
  try {
    return JSON.parse(await readFile(cursorSyncStatePath(), 'utf-8')) as SyncState
  } catch {
    return {}
  }
}

async function writeState(state: SyncState): Promise<void> {
  const path = cursorSyncStatePath()
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`
  await writeFile(tmp, JSON.stringify(state) + '\n', 'utf-8')
  await rename(tmp, path)
}

export async function cursorSyncEnabled(): Promise<boolean> {
  if (process.env['CODEBURN_CURSOR_SYNC'] === '0') return false
  return (await readConfig()).cursorSync !== false
}

export type CursorSyncStatus = {
  enabled: boolean
  state: 'ok' | 'syncing-never' | 'error' | 'off' | 'no-login'
  lastSuccessAt: string | null
  // A fixed code for the apps to localize; `error` is its English text.
  errorCode?: 'login' | 'network' | 'export'
  error?: string
}

const STATUS_ERRORS = {
  login: 'Cursor login expired, open Cursor to sign in again',
  network: "Couldn't reach cursor.com, will retry",
  export: "Couldn't read the usage export from cursor.com, will retry",
} as const

function statusErrorCode(lastError: string): keyof typeof STATUS_ERRORS {
  if (/sign in again|HTTP 40[13]\b/.test(lastError)) return 'login'
  if (/HTTP (429|5\d\d)\b|fetch failed|time(d)? ?out|abort|network|socket|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN/i.test(lastError)) return 'network'
  return 'export'
}

/// What the apps show about the sync, read from the sidecar, the config and the
/// Cursor app's login. Never syncs and never makes a request. Null when Cursor
/// is not signed in on this machine and has never synced.
export async function cursorSyncStatus(now = Date.now()): Promise<CursorSyncStatus | null> {
  const state = await readState()
  const dbPath = cursorDatabasePath()
  // undefined: the database is there but could not be read this time.
  const token = existsSync(dbPath)
    ? await cursorAccessTokenFromDatabase(dbPath).then(t => t?.trim() || null, () => undefined)
    : null
  if (token === null && state.lastAttemptAt === undefined && state.lastSuccessAt === undefined) return null
  const enabled = await cursorSyncEnabled()
  const lastSuccessAt = state.lastSuccessAt !== undefined ? new Date(state.lastSuccessAt).toISOString() : null
  if (!enabled) return { enabled, state: 'off', lastSuccessAt }
  const claims = token ? cursorTokenClaims(token) : null
  if (token === null || (token !== undefined && (!claims || !cursorSessionCookie(token, now)))) {
    return { enabled, state: 'no-login', lastSuccessAt, errorCode: 'login', error: STATUS_ERRORS.login }
  }
  const code = state.lastError ? statusErrorCode(state.lastError) : null
  // A rejection of an earlier token says nothing about a newer one, which the
  // next poll tries.
  const staleRejection = code === 'login' && claims !== null && state.rejectedExp !== undefined && state.rejectedExp !== claims.exp
  if (code && !staleRejection) return { enabled, state: 'error', lastSuccessAt, errorCode: code, error: STATUS_ERRORS[code] }
  return { enabled, state: lastSuccessAt ? 'ok' : 'syncing-never', lastSuccessAt }
}

// The day before too: Cursor can post a row for the previous local day late.
function previousLocalDayStart(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1).getTime()
}

function localDayStart(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

// Reaches back to whichever is earlier, the start of this month or 30 days
// ago, so both the month and 30-day reports are fully covered.
function firstSyncStart(now: number): number {
  const d = new Date(now)
  return Math.min(new Date(d.getFullYear(), d.getMonth(), 1).getTime(), new Date(d.getFullYear(), d.getMonth(), d.getDate() - 30).getTime())
}

async function invalidate(ranges: CoverageRange[]): Promise<void> {
  for (const r of ranges) {
    await invalidateProviderDays(replacedProviders(), toDateString(new Date(r.start)), toDateString(new Date(r.end)))
  }
}

class Skip extends Error {}

/// Silent unless `force`: a skipped or failed sync returns null and keeps the
/// stored usage, and `force` (`codeburn import cursor --sync`) turns every skip
/// and failure into an error and ignores the throttle, backoff and off switch.
/// Null from a forced sync means the window held no usage.
///
/// The first sync of an account reaches back a month; every later one starts
/// the local day before its newest synced event, so older closed days are
/// downloaded once. A `provider` filter that leaves out every Cursor provider
/// skips the sync. Earlier accounts' synced usage stays, and a new account's window
/// starts after their coverage so no stretch of local usage is replaced twice.
export async function maybeSyncCursor(opts: { force?: boolean; now?: number; fetchImpl?: typeof fetch; provider?: string } = {}): Promise<CursorImportSummary | null> {
  if (opts.provider !== undefined && opts.provider !== 'all' && !replacedProviders().includes(opts.provider)) return null
  const force = opts.force === true
  const now = opts.now ?? Date.now()
  let state: SyncState = {}
  let attempt: SyncState | null = null
  const fail = async (lastError: string, backoffUntil = 0, rejectedExp?: number | null) => {
    const failures = (state.failures ?? 0) + 1
    const until = Math.max(backoffUntil, failures >= MAX_FAILURES ? now + FAILURE_BACKOFF_MS : 0)
    await writeState({ ...attempt, failures, lastError, ...(until > 0 ? { backoffUntil: until } : {}), ...(rejectedExp != null ? { rejectedExp } : {}) })
  }
  try {
    if (!force && !(await cursorSyncEnabled())) return null
    state = await readState()
    if (!force && state.nextAttemptAt !== undefined && now < state.nextAttemptAt) return null
    const token = (await cursorAccessTokenFromDatabase(cursorDatabasePath()))?.trim()
    if (!token) throw new Skip('the Cursor app is not signed in on this machine')
    const claims = cursorTokenClaims(token)
    const cookie = cursorSessionCookie(token, now)
    if (!claims || !cookie) throw new Skip('the Cursor app session is expired; open Cursor and sign in again')
    const backedOff = state.backoffUntil !== undefined && now < state.backoffUntil
      && (state.rejectedExp === undefined || state.rejectedExp === claims.exp)
    if (!force && backedOff) return null

    const account = createHash('sha256').update(claims.sub).digest('hex').slice(0, 16)
    const throttle = { lastAttemptAt: now, nextAttemptAt: now + THROTTLE_MS + Math.floor(Math.random() * JITTER_MS) }
    // Only the throttle before the request; the account is recorded once the
    // store reflects it.
    await writeState({ ...state, ...throttle })
    attempt = {
      ...throttle,
      account,
      ...(state.lastSuccessAt !== undefined ? { lastSuccessAt: state.lastSuccessAt } : {}),
      ...(state.through ? { through: state.through } : {}),
    }

    const store = existsSync(cursorImportPath()) ? await loadCursorImport() : null
    // A loop, not a spread: the store keeps every event forever.
    let ownNewest = -Infinity
    for (const e of store?.events ?? []) if (e.source === 'sync' && e.account === account) ownNewest = Math.max(ownNewest, Date.parse(e.date))
    const through = store ? Math.max(ownNewest, state.through?.[account] ?? -Infinity) : -Infinity
    const othersEnd = Math.max(-Infinity, ...(store?.ranges.filter(r => r.source === 'sync' && r.account !== account).map(r => Date.parse(r.end)) ?? []))
    const backfill = !Number.isFinite(through)
    const from = Math.max(backfill ? firstSyncStart(now) : previousLocalDayStart(through), othersEnd + 1)
    const res = await (opts.fetchImpl ?? globalThis.fetch)(`${EXPORT_URL}?startDate=${from}&endDate=${now}&strategy=tokens`, {
      method: 'GET',
      headers: { Accept: 'text/csv', Cookie: cookie, Origin: 'https://cursor.com', 'User-Agent': 'CodeBurn' },
      signal: AbortSignal.timeout(force ? FORCED_TIMEOUT_MS : backfill ? BACKFILL_TIMEOUT_MS : TIMEOUT_MS),
    })
    if (res.status === 401 || res.status === 403) {
      const lastError = `Cursor rejected the app session (HTTP ${res.status}); open Cursor and sign in again`
      await fail(lastError, now + REJECTED_BACKOFF_MS, claims.exp)
      throw new Skip(lastError)
    }
    if (res.status === 429) {
      const seconds = Number(res.headers.get('Retry-After') ?? NaN)
      const lastError = 'Cursor rate-limited the usage export (HTTP 429)'
      await fail(lastError, now + Math.max(Number.isFinite(seconds) ? Math.ceil(seconds) : 300, 60) * 1000)
      throw new Skip(lastError)
    }
    if (!res.ok) throw new Error(`Cursor returned HTTP ${res.status} for the usage export`)
    const summary = await importCursorCsvText(await res.text(), now, { from, to: now, source: 'sync', account })
    if (summary?.changed) await invalidate([{ start: new Date(from).toISOString(), end: new Date(now).toISOString() }])
    const newest = Math.max(state.through?.[account] ?? -Infinity, summary ? Date.parse(summary.lastEvent) : localDayStart(now))
    await writeState({ ...attempt, lastSuccessAt: now, through: { ...state.through, [account]: newest } })
    return summary
  } catch (err) {
    // Only the first line: a header mismatch quotes the response body below it.
    const message = err instanceof Skip ? err.message : sanitizeError(err).split('\n')[0]!
    if (attempt && !(err instanceof Skip)) await fail(message).catch(() => {})
    if (force) throw new Error(message)
    return null
  }
}
