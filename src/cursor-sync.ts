import { createHash, randomBytes } from 'crypto'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { dirname, join } from 'path'

import { getCodeburnCacheDir } from './cache-dir.js'
import { readConfig } from './config.js'
import { dropCursorSync, importCursorCsvText, loadCursorImport, replacedProviders, type CoverageRange, type CursorImportSummary } from './cursor-import.js'
import { invalidateProviderDays, toDateString } from './daily-cache.js'
import { cursorAccessTokenFromDatabase, cursorDatabasePath, cursorSessionCookie, cursorTokenClaims } from './quota/cursor.js'
import { sanitizeError } from './quota/security.js'

// Downloads the account's own usage export, the same CSV as Export CSV at
// cursor.com/dashboard/usage, with the session the Cursor app keeps locally
// (see quota/cursor.ts), and merges it into the Cursor import store.

const EXPORT_URL = 'https://cursor.com/api/dashboard/export-usage-events-csv'
const THROTTLE_MS = 15 * 60_000
const REJECTED_BACKOFF_MS = 6 * 3_600_000
// A 30-day first backfill took about 10s for 11k events.
const TIMEOUT_MS = 15_000
const FORCED_TIMEOUT_MS = 60_000

type SyncState = {
  lastAttemptAt?: number
  lastSuccessAt?: number
  backoffUntil?: number
  // Token expiry Cursor rejected; a new token lifts the 401/403 backoff.
  rejectedExp?: number
  lastError?: string
  // Short hash of the token subject, never the subject itself.
  account?: string
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
export async function maybeSyncCursor(opts: { force?: boolean; now?: number; fetchImpl?: typeof fetch } = {}): Promise<CursorImportSummary | null> {
  const force = opts.force === true
  const now = opts.now ?? Date.now()
  let attempt: SyncState | null = null
  try {
    if (!force && !(await cursorSyncEnabled())) return null
    const state = await readState()
    if (!force && state.lastAttemptAt !== undefined && now - state.lastAttemptAt < THROTTLE_MS) return null
    const token = (await cursorAccessTokenFromDatabase(cursorDatabasePath()))?.trim()
    if (!token) throw new Skip('the Cursor app is not signed in on this machine')
    const claims = cursorTokenClaims(token)
    const cookie = cursorSessionCookie(token, now)
    if (!claims || !cookie) throw new Skip('the Cursor app session is expired; open Cursor and sign in again')
    const backedOff = state.backoffUntil !== undefined && now < state.backoffUntil
      && (state.rejectedExp === undefined || state.rejectedExp === claims.exp)
    if (!force && backedOff) return null

    const account = createHash('sha256').update(claims.sub).digest('hex').slice(0, 16)
    attempt = { lastAttemptAt: now, ...(state.lastSuccessAt !== undefined ? { lastSuccessAt: state.lastSuccessAt } : {}), account }
    await writeState({ ...state, ...attempt })
    if (state.account !== undefined && state.account !== account) await invalidate(await dropCursorSync())

    const store = await loadCursorImport()
    const syncEnds = store?.ranges.filter(r => r.source === 'sync').map(r => Date.parse(r.end)) ?? []
    const from = syncEnds.length > 0 ? localDayStart(Math.max(...syncEnds)) : firstSyncStart(now)
    const res = await (opts.fetchImpl ?? globalThis.fetch)(`${EXPORT_URL}?startDate=${from}&endDate=${now}&strategy=tokens`, {
      method: 'GET',
      headers: { Accept: 'text/csv', Cookie: cookie, Origin: 'https://cursor.com', 'User-Agent': 'CodeBurn' },
      signal: AbortSignal.timeout(force ? FORCED_TIMEOUT_MS : TIMEOUT_MS),
    })
    if (res.status === 401 || res.status === 403) {
      const lastError = `Cursor rejected the app session (HTTP ${res.status}); open Cursor and sign in again`
      await writeState({ ...attempt, backoffUntil: now + REJECTED_BACKOFF_MS, ...(claims.exp !== null ? { rejectedExp: claims.exp } : {}), lastError })
      throw new Skip(lastError)
    }
    if (res.status === 429) {
      const seconds = Number(res.headers.get('Retry-After') ?? NaN)
      const lastError = 'Cursor rate-limited the usage export (HTTP 429)'
      await writeState({ ...attempt, backoffUntil: now + Math.max(Number.isFinite(seconds) ? Math.ceil(seconds) : 300, 60) * 1000, lastError })
      throw new Skip(lastError)
    }
    if (!res.ok) throw new Error(`Cursor returned HTTP ${res.status} for the usage export`)
    const summary = await importCursorCsvText(await res.text(), now, { from, to: now, source: 'sync' })
    if (summary?.changed) await invalidate([{ start: new Date(from).toISOString(), end: new Date(now).toISOString() }])
    await writeState({ lastAttemptAt: now, lastSuccessAt: now, account })
    return summary
  } catch (err) {
    // Only the first line: a header mismatch quotes the response body below it.
    const message = err instanceof Skip ? err.message : sanitizeError(err).split('\n')[0]!
    if (attempt && !(err instanceof Skip)) await writeState({ ...attempt, lastError: message }).catch(() => {})
    if (force) throw new Error(message)
    return null
  }
}
