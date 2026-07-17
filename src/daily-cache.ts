import { randomBytes } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, open, readFile, rename, unlink } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type { DateRange, ProjectSummary } from './types.js'

// Bumped to 13: day bucketing is now TURN-anchored (a turn's whole cost/calls
// land on the day of its user-message timestamp) to match the live headline/
// report rollup. v12 bucketed each call by its own timestamp, so a midnight-
// straddling turn split across two days and history.daily / the provider
// breakdown never reconciled to current.cost. Raising MIN_SUPPORTED_VERSION
// forces the one-time re-hydration that rebuilds history under turn bucketing.
//
// v12: CodeWhale support adds historical usage that earlier rollups
// did not contain. Both the CodeWhale branch and the kiro credit-pricing
// change (below) claimed v11 independently, so v12 is the first version that
// contains both; raising MIN_SUPPORTED_VERSION forces the one-time
// re-hydration for days finalized at either v11.
//
// v11: kiro cost accounting changed (metered credits pass through
// the session cache instead of being re-priced from estimated tokens), so
// days finalized at v10 carry token-estimated kiro costs that were off by up
// to 16× per model. Raising MIN_SUPPORTED_VERSION forces the one-time full
// re-hydration that backfills history under credit-based pricing.
//
// v10: cursor accounting changed (real composer context tokens on
// conversation-anchored records, Cursor-published composer pricing), so days
// finalized at v9 carry the old double-counted agentKv estimates and
// sonnet-proxy composer costs.
//
// v9: providers added since the v8 rollup (Grok, Hermes, ZCode) parse usage
// that older binaries skipped. v8 added local-model savings to the daily
// rollup; the `savingsConfigHash` field is invalidated separately when the
// user changes their `localModelSavings` mapping.
export const DAILY_CACHE_VERSION = 13
const MIN_SUPPORTED_VERSION = 13
// Version-suffixed so different binaries each own a distinct file and never
// clobber an incompatible schema. Bumping the version mints a fresh filename.
const DAILY_CACHE_FILENAME = `daily-cache.v${DAILY_CACHE_VERSION}.json`
// The pre-versioning filename. Never written or deleted anymore (old binaries
// own it). Adopt-copied once on first load when the versioned file is absent and
// the legacy file's version matches ours; a different version is ignored.
const LEGACY_DAILY_CACHE_FILENAME = 'daily-cache.json'

export type DailyEntry = {
  date: string
  cost: number
  savingsUSD: number
  calls: number
  sessions: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  editTurns: number
  oneShotTurns: number
  models: Record<string, {
    calls: number
    cost: number
    savingsUSD: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
  }>
  categories: Record<string, { turns: number; cost: number; savingsUSD: number; editTurns: number; oneShotTurns: number }>
  providers: Record<string, { calls: number; cost: number; savingsUSD: number }>
}

export type DailyCache = {
  version: number
  /// Hash of the active `localModelSavings` config at the time the cache
  /// was last written. When the user changes their baseline mapping the
  /// hash mismatches and `ensureCacheHydrated` discards the cached days
  /// so historical savings are recomputed against the current mapping.
  savingsConfigHash: string
  /// IANA local timezone the days were bucketed under (day boundaries are
  /// local-time). If the machine's timezone changes, previously-cached days are
  /// bucketed against the wrong midnight, so a mismatch forces a full re-hydrate
  /// (same self-heal as `savingsConfigHash`). Absent on caches written before
  /// this field existed → not treated as a mismatch (no gratuitous rebuild).
  tzKey?: string
  lastComputedDate: string | null
  days: DailyEntry[]
  /// True only once the full backfill window has been hydrated from a COMPLETE
  /// session parse. A cache that was finalized against a partial (interrupted)
  /// session hydration — the "chart is empty for the first ~20 days" bug — reads
  /// as incomplete and is fully re-backfilled. Absent on caches written before
  /// this field existed → treated as incomplete (one self-healing re-backfill).
  complete?: boolean
}

function getCacheDir(): string {
  return process.env['CODEBURN_CACHE_DIR'] ?? join(homedir(), '.cache', 'codeburn')
}

/** IANA name of the current local timezone (respects the TZ env var). Days are
 *  bucketed by local midnight, so this tags the cache for TZ-change invalidation. */
export function currentTzKey(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || '' } catch { return '' }
}

function getCachePath(): string {
  return join(getCacheDir(), DAILY_CACHE_FILENAME)
}

function getLegacyCachePath(): string {
  return join(getCacheDir(), LEGACY_DAILY_CACHE_FILENAME)
}

/** Absolute path of the active (version-suffixed) daily cache file. */
export function dailyCachePath(): string {
  return getCachePath()
}

export function emptyCache(savingsConfigHash = ''): DailyCache {
  return { version: DAILY_CACHE_VERSION, savingsConfigHash, tzKey: currentTzKey(), lastComputedDate: null, days: [], complete: false }
}

function isMigratableCache(parsed: unknown): parsed is { version: number; lastComputedDate: string | null; savingsConfigHash?: string; tzKey?: string; days: Record<string, unknown>[]; complete?: boolean } {
  if (!parsed || typeof parsed !== 'object') return false
  const c = parsed as Partial<DailyCache>
  if (typeof c.version !== 'number') return false
  if (!Array.isArray(c.days)) return false
  return c.version >= MIN_SUPPORTED_VERSION && c.version <= DAILY_CACHE_VERSION
}

function migrateDays(days: Record<string, unknown>[]): DailyEntry[] {
  return days.map(d => ({
    date: d.date as string,
    cost: (d.cost as number) ?? 0,
    savingsUSD: (d.savingsUSD as number) ?? 0,
    calls: (d.calls as number) ?? 0,
    sessions: (d.sessions as number) ?? 0,
    inputTokens: (d.inputTokens as number) ?? 0,
    outputTokens: (d.outputTokens as number) ?? 0,
    cacheReadTokens: (d.cacheReadTokens as number) ?? 0,
    cacheWriteTokens: (d.cacheWriteTokens as number) ?? 0,
    editTurns: (d.editTurns as number) ?? 0,
    oneShotTurns: (d.oneShotTurns as number) ?? 0,
    models: (d.models as DailyEntry['models']) ?? {},
    categories: (d.categories as DailyEntry['categories']) ?? {},
    providers: (d.providers as DailyEntry['providers']) ?? {},
  }))
}

function migratedFrom(parsed: { version: number; lastComputedDate: string | null; savingsConfigHash?: string; tzKey?: string; days: Record<string, unknown>[]; complete?: boolean }): DailyCache {
  return {
    version: DAILY_CACHE_VERSION,
    savingsConfigHash: parsed.savingsConfigHash ?? '',
    tzKey: parsed.tzKey,
    lastComputedDate: parsed.lastComputedDate,
    days: migrateDays(parsed.days),
    // Only a cache explicitly marked complete stays trusted; one written before
    // the marker existed reads false and is re-backfilled once.
    complete: parsed.complete === true,
  }
}

export async function loadDailyCache(): Promise<DailyCache> {
  const path = getCachePath()
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf-8'))
      if (isMigratableCache(parsed)) {
        const migrated = migratedFrom(parsed)
        if (parsed.version < DAILY_CACHE_VERSION) await saveDailyCache(migrated).catch(() => {})
        return migrated
      }
      return emptyCache()
    } catch {
      return emptyCache()
    }
  }
  // Versioned file absent: adopt the legacy unversioned file once, only when its
  // version matches ours. A different-version legacy file is ignored and left
  // intact — old binaries still own it, so we never write or delete it.
  return adoptLegacyDailyCache()
}

async function adoptLegacyDailyCache(): Promise<DailyCache> {
  const legacy = getLegacyCachePath()
  if (!existsSync(legacy)) return emptyCache()
  try {
    const parsed: unknown = JSON.parse(await readFile(legacy, 'utf-8'))
    if (isMigratableCache(parsed) && parsed.version === DAILY_CACHE_VERSION) {
      const adopted = migratedFrom(parsed)
      await saveDailyCache(adopted).catch(() => {})
      return adopted
    }
    return emptyCache()
  } catch {
    return emptyCache()
  }
}

export async function saveDailyCache(cache: DailyCache): Promise<void> {
  const dir = getCacheDir()
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  const finalPath = getCachePath()
  const tempPath = `${finalPath}.${randomBytes(8).toString('hex')}.tmp`
  const payload = JSON.stringify(cache)
  const handle = await open(tempPath, 'w', 0o600)
  try {
    await handle.writeFile(payload, { encoding: 'utf-8' })
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(tempPath, finalPath)
  } catch (err) {
    try { await unlink(tempPath) } catch { /* ignore */ }
    throw err
  }
}

export function addNewDays(cache: DailyCache, incoming: DailyEntry[], newestDate: string): DailyCache {
  const byDate = new Map(cache.days.map(d => [d.date, d]))
  for (const day of incoming) {
    byDate.set(day.date, day)
  }
  const merged = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date))
  // Prune entries older than the BACKFILL window so the cache file does not
  // grow unbounded over years of daily use. The "all time" / 6-month period
  // and the BACKFILL_DAYS bootstrap both fit comfortably inside this cap.
  // Anchor the cap on the newestDate boundary so a stale or stuck clock
  // can't accidentally evict everything. Skip the prune entirely if
  // newestDate is malformed — an invalid Date would produce a NaN cutoff
  // and `d.date >= "Invalid Date"` would silently drop every entry.
  const cutoffDate = new Date(`${newestDate}T00:00:00Z`)
  let pruned = merged
  if (!isNaN(cutoffDate.getTime())) {
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - DAILY_CACHE_RETENTION_DAYS)
    const cutoff = toDateString(cutoffDate)
    pruned = merged.filter(d => d.date >= cutoff)
  }
  const nextLast = cache.lastComputedDate && cache.lastComputedDate > newestDate
    ? cache.lastComputedDate
    : newestDate
  return {
    version: DAILY_CACHE_VERSION,
    savingsConfigHash: cache.savingsConfigHash,
    tzKey: cache.tzKey,
    lastComputedDate: nextLast,
    days: pruned,
    complete: cache.complete,
  }
}

export function getDaysInRange(cache: DailyCache, start: string, end: string): DailyEntry[] {
  return cache.days.filter(d => d.date >= start && d.date <= end)
}

let lockChain: Promise<unknown> = Promise.resolve()

export function withDailyCacheLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = lockChain.then(() => fn())
  lockChain = next.catch(() => undefined)
  return next
}

export const MS_PER_DAY = 24 * 60 * 60 * 1000
export const BACKFILL_DAYS = 365
// Keep 2 years of history so the longest UI-exposed period (6 months
// today, with headroom for future longer windows) always reads from
// cache while old entries get pruned.
export const DAILY_CACHE_RETENTION_DAYS = 730

export function toDateString(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export async function ensureCacheHydrated(
  parseSessions: (range: DateRange) => Promise<ProjectSummary[]>,
  aggregateDays: (projects: ProjectSummary[]) => DailyEntry[],
  /// Hash of the active `localModelSavings` config. When this changes
  /// (user re-mapped a baseline) the cached `savingsUSD` totals are no
  /// longer accurate, so we treat the cache as stale and force a full
  /// re-hydration. Pass `''` for "no savings config" to disable.
  savingsConfigHash: string = '',
  /// Whether the session parse that fed this backfill left the session cache
  /// fully hydrated. A partial (interrupted) session cache yields empty/partial
  /// older days; finalizing them would freeze that gap into the daily history.
  /// So the backfill is only marked `complete` when this returns true. Defaults
  /// to a trusting `true` for callers that don't (or can't) supply it.
  sessionComplete: () => boolean = () => true,
): Promise<DailyCache> {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterdayEnd = new Date(todayStart.getTime() - 1)
  const yesterdayStr = toDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))

  return withDailyCacheLock(async () => {
    let c = await loadDailyCache()

    // Three reasons to drop the cached days and re-hydrate the whole retention
    // window:
    //  1. Savings config changed — the cached `savingsUSD` totals are stale, and
    //     we can't cheaply recompute them per historical day without re-parsing.
    //  2. The cache was never finalized against a COMPLETE session parse (an old
    //     pre-marker cache, or one frozen from a partial/interrupted hydration).
    //     Its older days may be empty or partial; trusting `lastComputedDate`
    //     would leave that gap forever (the "first ~20 days missing" bug).
    //  3. The local timezone changed — days are bucketed by local midnight, so a
    //     TZ change mis-buckets every cached day. Only invalidate when a tzKey is
    //     present and differs (a cache written before this field, or a test
    //     fixture, has none → left alone rather than force a spurious rebuild).
    const tzKey = currentTzKey()
    const tzChanged = c.tzKey !== undefined && c.tzKey !== tzKey
    if (c.savingsConfigHash !== savingsConfigHash || c.complete !== true || tzChanged) {
      c = {
        version: DAILY_CACHE_VERSION,
        savingsConfigHash,
        tzKey,
        lastComputedDate: null,
        days: [],
        complete: false,
      }
    } else if (c.tzKey === undefined) {
      // First write under the tzKey scheme: tag the cache so a later TZ change is
      // detectable, without discarding the (still-valid, same-TZ) cached days.
      c = { ...c, tzKey }
    }

    // Drop any cached entry dated today or later. The cache only ever stores
    // complete past days (up to yesterday), so a >= today entry can only come
    // from the clock moving backward or a stale older cache; left in place it
    // would be served frozen instead of recomputed live. Yesterday and earlier
    // stay cached, so this does not re-parse already-cached days.
    const todayStr = toDateString(now)
    if (c.days.some(d => d.date >= todayStr)) {
      const freshDays = c.days.filter(d => d.date < todayStr)
      const latestFresh = freshDays.length > 0 ? freshDays[freshDays.length - 1].date : null
      c = { ...c, days: freshDays, lastComputedDate: latestFresh }
    }

    const gapStart = c.lastComputedDate
      ? new Date(
          parseInt(c.lastComputedDate.slice(0, 4)),
          parseInt(c.lastComputedDate.slice(5, 7)) - 1,
          parseInt(c.lastComputedDate.slice(8, 10)) + 1
        )
      : new Date(now.getFullYear(), now.getMonth(), now.getDate() - BACKFILL_DAYS)

    if (gapStart.getTime() <= yesterdayEnd.getTime()) {
      const gapRange: DateRange = { start: gapStart, end: yesterdayEnd }
      const gapProjects = await parseSessions(gapRange)
      const gapDays = aggregateDays(gapProjects)
      c = addNewDays(c, gapDays, yesterdayStr)
      // Finalize as complete ONLY when the session parse that produced these days
      // was itself complete. If it was partial, leave `complete: false` so the
      // next launch (once the session cache is whole) re-backfills instead of
      // freezing the partial history.
      c = { ...c, complete: sessionComplete() }
      await saveDailyCache(c)
    } else if (c.complete !== true && sessionComplete()) {
      // No gap to fill (already current through yesterday) but not yet marked —
      // e.g. a brand-new machine whose only data is today. Finalize so future
      // launches don't re-backfill the whole window every time.
      c = { ...c, complete: true }
      await saveDailyCache(c)
    }
    return c
  })
}
