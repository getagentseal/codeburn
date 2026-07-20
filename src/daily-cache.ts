import { randomBytes } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, open, readdir, readFile, rename, stat, unlink } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type { DateRange, ProjectSummary } from './types.js'

// Bumped to 15: per-project daily rollups. Days and provider slices now carry
// a `projects` breakdown (cost/calls/savings/sessions per project) so project
// history outlives the session files, like models and categories already do.
// This bump is the first to ride the v14 carry-forward: the old cache is
// adopted losslessly and only days whose sources survive are re-derived (now
// with projects); days already sourceless keep their totals and simply have
// no project split.
//
// v14: NEVER-LOSE history. Session files are ephemeral (Claude Code
// deletes transcripts after ~30 days), so a day that can no longer be re-derived
// from sources exists ONLY in this cache. Every earlier version treated the
// cache as disposable — schema bumps, savings-config changes, timezone changes
// and incomplete-hydration retries all dropped the days and re-derived from
// whatever sources survived, silently truncating history to the source-retention
// window (five bumps between 2026-06-22 and 2026-07-16 erased everything before
// 2026-04-24 on a machine with usage since March). From v14 on, invalidation
// re-derives what it can and CARRIES FORWARD every (day, provider) slice it
// cannot, and loading a missing/unsupported cache file adopts days from every
// older daily-cache file in the cache dir instead of starting empty. Bumping
// the version now only forces re-derivation of days whose sources still exist;
// it must never again lose the rest. DailyEntry.providers slices carry a full
// per-provider breakdown (tokens, models, categories) so those carry-forwards
// stay exact across rebuilds.
//
// v13: day bucketing is now TURN-anchored (a turn's whole cost/calls
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
export const DAILY_CACHE_VERSION = 15
const MIN_SUPPORTED_VERSION = 15
// Version-suffixed so different binaries each own a distinct file and never
// clobber an incompatible schema. Bumping the version mints a fresh filename;
// adoptOlderDailyCaches then unions days out of every previous file (including
// the pre-versioning `daily-cache.json`, which old binaries still own and we
// never write or delete).
const DAILY_CACHE_FILENAME = `daily-cache.v${DAILY_CACHE_VERSION}.json`

export type ModelDayStats = {
  calls: number
  cost: number
  savingsUSD: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export type CategoryDayStats = { turns: number; cost: number; savingsUSD: number; editTurns: number; oneShotTurns: number }

/// `path` is the project's filesystem path when known — it is what display
/// layers derive a friendly name from once the sessions that carried the
/// mapping are gone.
export type ProjectDayStats = { cost: number; calls: number; savingsUSD: number; sessions: number; path?: string }

export type ProviderDaySlice = {
  calls: number
  cost: number
  savingsUSD: number
  /// Full per-provider breakdown, written since v14. Slices adopted from older
  /// caches carry only the three fields above; carrying such a slice forward
  /// restores exact cost/calls/savings but not the day's token/model/category
  /// split for that provider.
  sessions?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  editTurns?: number
  oneShotTurns?: number
  models?: Record<string, ModelDayStats>
  categories?: Record<string, CategoryDayStats>
  projects?: Record<string, ProjectDayStats>
}

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
  models: Record<string, ModelDayStats>
  categories: Record<string, CategoryDayStats>
  providers: Record<string, ProviderDaySlice>
  /// Per-project rollup (session-level project attribution). Absent on days
  /// recorded before v15 — those days keep their totals but have no project
  /// split, and nothing can reconstruct one once the sources are gone.
  projects?: Record<string, ProjectDayStats>
  /// Present when some of this day's data was carried forward from an earlier
  /// cache generation instead of re-derived from session files (the files no
  /// longer exist). Carried values keep the accounting of the version that
  /// recorded them — stale accounting beats a silent zero.
  carried?: true
}

export type DailyCache = {
  version: number
  /// Hash of the active `localModelSavings` config at the time the cache
  /// was last written. When the user changes their baseline mapping the
  /// hash mismatches and `ensureCacheHydrated` re-derives available history,
  /// then carries forward slices whose sources are gone.
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

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function sanitizeModels(raw: unknown): DailyEntry['models'] {
  if (!isRecord(raw)) return {}
  const out: DailyEntry['models'] = {}
  for (const [name, m] of Object.entries(raw)) {
    if (name in Object.prototype || !isRecord(m)) continue
    setOwn(out, name, {
      calls: num(m.calls),
      cost: num(m.cost),
      savingsUSD: num(m.savingsUSD),
      inputTokens: num(m.inputTokens),
      outputTokens: num(m.outputTokens),
      cacheReadTokens: num(m.cacheReadTokens),
      cacheWriteTokens: num(m.cacheWriteTokens),
    })
  }
  return out
}

function sanitizeCategories(raw: unknown): DailyEntry['categories'] {
  if (!isRecord(raw)) return {}
  const out: DailyEntry['categories'] = {}
  for (const [name, c] of Object.entries(raw)) {
    if (name in Object.prototype || !isRecord(c)) continue
    setOwn(out, name, {
      turns: num(c.turns),
      cost: num(c.cost),
      savingsUSD: num(c.savingsUSD),
      editTurns: num(c.editTurns),
      oneShotTurns: num(c.oneShotTurns),
    })
  }
  return out
}

const OPTIONAL_SLICE_NUMERICS = ['sessions', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'editTurns', 'oneShotTurns'] as const

/// Same junk-tolerance as sanitizeProjects, one level up: a foreign cache can
/// hold anything under a provider slice, and structuredClone in the merge
/// would faithfully preserve that junk into the next cache generation. Numeric
/// fields and nested maps are sanitized before the slice enters the cache.
function sanitizeProviders(raw: unknown): DailyEntry['providers'] {
  if (!isRecord(raw)) return {}
  const out: DailyEntry['providers'] = {}
  for (const [name, s] of Object.entries(raw)) {
    if (name in Object.prototype || !isRecord(s)) continue
    const slice = s
    const clean: ProviderDaySlice = { calls: num(slice.calls), cost: num(slice.cost), savingsUSD: num(slice.savingsUSD) }
    for (const key of OPTIONAL_SLICE_NUMERICS) {
      if (slice[key] !== undefined) clean[key] = num(slice[key])
    }
    if (isRecord(slice.models)) clean.models = sanitizeModels(slice.models)
    if (isRecord(slice.categories)) clean.categories = sanitizeCategories(slice.categories)
    const projects = sanitizeProjects(slice.projects).projects
    if (projects) clean.projects = projects
    setOwn(out, name, clean)
  }
  return out
}

/// Foreign or hand-edited caches can hold anything under `projects`; keep only
/// a plain record of finite numeric stats (arrays and null entries dropped) so
/// later carry merges can't crash on junk.
function sanitizeProjects(raw: unknown): { projects?: DailyEntry['projects'] } {
  if (!isRecord(raw)) return {}
  const out: NonNullable<DailyEntry['projects']> = {}
  for (const [name, p] of Object.entries(raw)) {
    if (name in Object.prototype || !isRecord(p)) continue
    setOwn(out, name, {
      cost: num(p.cost),
      calls: num(p.calls),
      savingsUSD: num(p.savingsUSD),
      sessions: num(p.sessions),
      ...(typeof p.path === 'string' && p.path.length > 0 ? { path: p.path } : {}),
    })
  }
  return Object.keys(out).length > 0 ? { projects: out } : {}
}

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

function migrateDays(days: Record<string, unknown>[]): DailyEntry[] {
  return days
    .filter(d => d && typeof d === 'object' && typeof d.date === 'string' && DATE_KEY_RE.test(d.date))
    .map(d => ({
      date: d.date as string,
      cost: num(d.cost),
      savingsUSD: num(d.savingsUSD),
      calls: num(d.calls),
      sessions: num(d.sessions),
      inputTokens: num(d.inputTokens),
      outputTokens: num(d.outputTokens),
      cacheReadTokens: num(d.cacheReadTokens),
      cacheWriteTokens: num(d.cacheWriteTokens),
      editTurns: num(d.editTurns),
      oneShotTurns: num(d.oneShotTurns),
      models: sanitizeModels(d.models),
      categories: sanitizeCategories(d.categories),
      providers: sanitizeProviders(d.providers),
      ...(sanitizeProjects(d.projects)),
      ...(d.carried === true ? { carried: true as const } : {}),
    }))
}

function migratedFrom(parsed: { version: number; lastComputedDate: string | null; savingsConfigHash?: string; tzKey?: string; days: Record<string, unknown>[]; complete?: boolean }): DailyCache {
  return {
    version: DAILY_CACHE_VERSION,
    savingsConfigHash: parsed.savingsConfigHash ?? '',
    tzKey: parsed.tzKey,
    lastComputedDate: typeof parsed.lastComputedDate === 'string' && DATE_KEY_RE.test(parsed.lastComputedDate)
      ? parsed.lastComputedDate
      : null,
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
    } catch {
      // fall through to adoption — a corrupt current file must not cost history
      // that older cache files still hold.
    }
    return adoptOlderDailyCaches()
  }
  return adoptOlderDailyCaches()
}

type AdoptableCache = { version: number; lastComputedDate?: string | null; savingsConfigHash?: string; tzKey?: string; days: Record<string, unknown>[]; complete?: boolean }

function isAdoptableCache(parsed: unknown): parsed is AdoptableCache {
  if (!parsed || typeof parsed !== 'object') return false
  const c = parsed as Partial<DailyCache>
  return typeof c.version === 'number' && Array.isArray(c.days)
}

/// Versioned file absent (or unreadable): adopt days from EVERY other
/// daily-cache file in the cache dir — the legacy unversioned file, older
/// versioned files, and manual .bak copies. Files are read, never written or
/// deleted (old binaries still own theirs). A candidate at exactly our version
/// (the legacy file written by a same-version binary) is fully trusted and
/// becomes the base; every other candidate contributes per-(day, provider)
/// slices it alone still has, marked `carried`. This is what makes a schema
/// bump lossless: the new version starts from the union of everything every
/// previous version ever recorded, then re-derives what sources still support.
async function adoptOlderDailyCaches(): Promise<DailyCache> {
  const dir = getCacheDir()
  let names: string[] = []
  try {
    names = await readdir(dir)
  } catch {
    return emptyCache()
  }
  const candidates: { parsed: AdoptableCache; mtimeMs: number }[] = []
  for (const name of names) {
    if (!name.startsWith('daily-cache') || !name.includes('.json')) continue
    if (name === DAILY_CACHE_FILENAME) continue
    // .tmp files are included deliberately: a crash between the atomic write
    // completing and the rename landing leaves the NEWEST state only in the
    // .tmp. A truncated half-write fails JSON.parse below and is skipped.
    const path = join(dir, name)
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf-8'))
      if (!isAdoptableCache(parsed)) continue
      candidates.push({ parsed, mtimeMs: (await stat(path)).mtimeMs })
    } catch {
      continue
    }
  }
  if (candidates.length === 0) return emptyCache()
  // Priority: newer schema first, then most recently written. Higher priority
  // wins per (day, provider); lower priority only fills what is missing.
  candidates.sort((a, b) => (b.parsed.version - a.parsed.version) || (b.mtimeMs - a.mtimeMs))

  let base: DailyCache
  let rest = candidates
  if (candidates[0]!.parsed.version === DAILY_CACHE_VERSION && isMigratableCache(candidates[0]!.parsed)) {
    base = migratedFrom(candidates[0]!.parsed as Parameters<typeof migratedFrom>[0])
    rest = candidates.slice(1)
  } else {
    base = emptyCache()
  }
  let days = base.days
  for (const { parsed } of rest) {
    days = mergeDayEntries(days, migrateDays(parsed.days), true)
  }
  // loadDailyCache has standalone readers, so the adopted result must already
  // satisfy the cache's own invariants: no today/future entries (they would be
  // served frozen instead of recomputed live) and nothing past retention.
  const now = new Date()
  const todayStr = toDateString(now)
  const yesterdayStr = toDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
  days = applyRetention(days.filter(d => d.date < todayStr), yesterdayStr)
  // A trusted base can carry lastComputedDate >= today (clock skew wrote a
  // frozen today entry that the purge above just removed). Left as-is it would
  // make hydration skip the gap parse forever and the purged day would never
  // be recomputed. Clamp back to the retained data.
  let lastComputedDate = base.lastComputedDate
  if (lastComputedDate && lastComputedDate > yesterdayStr) {
    lastComputedDate = days.length > 0 ? days[days.length - 1]!.date : null
  }
  const adopted: DailyCache = {
    ...base,
    lastComputedDate,
    days,
    // An untrusted base means nothing here was derived under the current
    // accounting: leave complete unset so the next hydration re-derives every
    // day whose sources survive (the merge keeps the rest).
    complete: rest.length === candidates.length ? false : base.complete,
  }
  await saveDailyCache(adopted).catch(() => {})
  return adopted
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
  const nextLast = cache.lastComputedDate && cache.lastComputedDate > newestDate
    ? cache.lastComputedDate
    : newestDate
  return {
    version: DAILY_CACHE_VERSION,
    savingsConfigHash: cache.savingsConfigHash,
    tzKey: cache.tzKey,
    lastComputedDate: nextLast,
    days: applyRetention(merged, newestDate),
    complete: cache.complete,
  }
}

/// Prune entries older than the retention window so the cache file does not
/// grow unbounded over years of daily use. Anchor the cutoff on newestDate so
/// a stale or stuck clock can't accidentally evict everything. Skip the prune
/// entirely if newestDate is malformed — an invalid Date would produce a NaN
/// cutoff and `d.date >= "Invalid Date"` would silently drop every entry.
function applyRetention(days: DailyEntry[], newestDate: string): DailyEntry[] {
  const cutoffDate = new Date(`${newestDate}T00:00:00Z`)
  if (isNaN(cutoffDate.getTime())) return days
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - DAILY_CACHE_RETENTION_DAYS)
  const cutoff = toDateString(cutoffDate)
  return days.filter(d => d.date >= cutoff)
}

function hasSliceData(slice: ProviderDaySlice): boolean {
  return slice.cost > 0 || slice.calls > 0 || (slice.savingsUSD ?? 0) > 0
}

/// A day from a pre-v5-era cache: day-level totals exist but the providers map
/// is empty, so nothing can be attributed per provider. Such a day merges
/// all-or-nothing — filling slices into it would double-count whatever share
/// of its totals the incoming provider already contributed.
function isOpaqueDay(day: DailyEntry): boolean {
  return (day.cost > 0 || day.calls > 0) && Object.keys(day.providers).length === 0
}

function emptyModelStats(): ModelDayStats {
  return { calls: 0, cost: 0, savingsUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

/// Fold one provider's day slice into a day: the providers map, the day-level
/// totals, and (when the slice carries them — v14+ slices do) the model and
/// category breakdowns. Skinny slices from pre-v14 caches restore only
/// cost/calls/savings; the day's other totals simply don't grow. A zero-data
/// placeholder already present for the provider (a session that started this
/// day but whose turns all landed on another) only contributes its session
/// count, deduplicated by max — the same real session may be counted on both
/// sides.
function addSliceIntoDay(day: DailyEntry, provider: string, slice: ProviderDaySlice): void {
  // Reads keyed by names from foreign caches use hasOwn throughout: a plain
  // lookup of "__proto__" returns the prototype object, and accumulating into
  // it pollutes every object in the process.
  const placeholder = Object.hasOwn(day.providers, provider) ? day.providers[provider] : undefined
  const placeholderSessions = placeholder?.sessions ?? 0
  const merged = structuredClone(slice)
  if (placeholderSessions > (merged.sessions ?? 0)) merged.sessions = placeholderSessions
  setOwn(day.providers, provider, merged)
  day.cost += slice.cost
  day.calls += slice.calls
  day.savingsUSD += slice.savingsUSD ?? 0
  day.sessions += Math.max(0, (slice.sessions ?? 0) - placeholderSessions)
  day.inputTokens += slice.inputTokens ?? 0
  day.outputTokens += slice.outputTokens ?? 0
  day.cacheReadTokens += slice.cacheReadTokens ?? 0
  day.cacheWriteTokens += slice.cacheWriteTokens ?? 0
  day.editTurns += slice.editTurns ?? 0
  day.oneShotTurns += slice.oneShotTurns ?? 0
  for (const [name, m] of Object.entries(slice.models ?? {})) {
    const acc = Object.hasOwn(day.models, name) ? day.models[name]! : emptyModelStats()
    acc.calls += m.calls
    acc.cost += m.cost
    acc.savingsUSD += m.savingsUSD ?? 0
    acc.inputTokens += m.inputTokens
    acc.outputTokens += m.outputTokens
    acc.cacheReadTokens += m.cacheReadTokens
    acc.cacheWriteTokens += m.cacheWriteTokens
    setOwn(day.models, name, acc)
  }
  for (const [cat, c] of Object.entries(slice.categories ?? {})) {
    const acc = Object.hasOwn(day.categories, cat) ? day.categories[cat]! : { turns: 0, cost: 0, savingsUSD: 0, editTurns: 0, oneShotTurns: 0 }
    acc.turns += c.turns
    acc.cost += c.cost
    acc.savingsUSD += c.savingsUSD ?? 0
    acc.editTurns += c.editTurns
    acc.oneShotTurns += c.oneShotTurns
    setOwn(day.categories, cat, acc)
  }
  const placeholderProjects = placeholder?.projects ?? {}
  for (const [name, p] of Object.entries(slice.projects ?? {})) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue
    const dayProjects = (day.projects ??= {})
    const acc = Object.hasOwn(dayProjects, name) ? dayProjects[name]! : { cost: 0, calls: 0, savingsUSD: 0, sessions: 0 }
    acc.cost += num(p.cost)
    acc.calls += num(p.calls)
    acc.savingsUSD += num(p.savingsUSD)
    if (!acc.path && typeof p.path === 'string') acc.path = p.path
    // Same session dedup as the slice-level sessions above: a placeholder's
    // project sessions were already counted into the day when the fresh day
    // was built, so only the excess is added.
    const placeholderProjectSessions = Object.hasOwn(placeholderProjects, name) ? num(placeholderProjects[name]?.sessions) : 0
    acc.sessions += Math.max(0, num(p.sessions) - placeholderProjectSessions)
    setOwn(dayProjects, name, acc)
  }
  // Placeholder-only projects (session counted fresh, calls landed elsewhere)
  // survive on the merged slice rather than being dropped by the clone above.
  const mergedProjects = merged.projects
  if (mergedProjects) {
    for (const [name, p] of Object.entries(placeholderProjects)) {
      if (!p || typeof p !== 'object') continue
      if (Object.hasOwn(mergedProjects, name)) {
        if (num(p.sessions) > num(mergedProjects[name]!.sessions)) mergedProjects[name]!.sessions = num(p.sessions)
      } else {
        setOwn(mergedProjects, name, { cost: 0, calls: 0, savingsUSD: 0, sessions: num(p.sessions) })
      }
    }
  } else if (placeholder?.projects) {
    merged.projects = structuredClone(placeholder.projects)
  }
}

/// Assign via defineProperty so filesystem-derived keys like "__proto__" become
/// ordinary own properties instead of mutating the prototype link.
function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

/// Merge two day lists per (date, provider): `primary` wins wherever both have
/// data; `secondary` only fills dates primary lacks entirely and provider
/// slices primary lacks on shared dates. Nothing in secondary can overwrite or
/// double into primary. With markSecondaryCarried, every day that received a
/// secondary contribution is flagged `carried`.
///
/// Days that cannot be attributed per provider merge all-or-nothing:
///  - an OPAQUE primary day (pre-v5-era: totals but empty providers map) is
///    never slice-filled — its totals may already contain the incoming
///    provider's share, so adding would double-count;
///  - an opaque secondary day on a date primary already has contributes
///    nothing — its day-level totals cannot be attributed without slices.
/// A primary slice blocks a secondary one only when it carries DATA; a
/// zero-data placeholder (sessions only) is merged into, not treated as a
/// re-derivation of the provider's day.
export function mergeDayEntries(primary: DailyEntry[], secondary: DailyEntry[], markSecondaryCarried: boolean): DailyEntry[] {
  const byDate = new Map<string, DailyEntry>()
  for (const day of primary) byDate.set(day.date, structuredClone(day))
  for (const day of secondary) {
    const existing = byDate.get(day.date)
    if (!existing) {
      const copy = structuredClone(day)
      if (markSecondaryCarried) copy.carried = true
      byDate.set(day.date, copy)
      continue
    }
    if (isOpaqueDay(existing)) continue
    for (const [provider, slice] of Object.entries(day.providers)) {
      // Sessions-only slices (a session whose calls all landed on another
      // day) still carry a real session count — worth preserving.
      if (!hasSliceData(slice) && !(slice.sessions ?? 0)) continue
      const existingSlice = Object.hasOwn(existing.providers, provider) ? existing.providers[provider] : undefined
      if (existingSlice && hasSliceData(existingSlice)) continue
      addSliceIntoDay(existing, provider, slice)
      if (markSecondaryCarried) existing.carried = true
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
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

    // Drop any cached entry dated today or later BEFORE anything else can
    // carry it forward. The cache only ever stores complete past days (up to
    // yesterday), so a >= today entry can only come from the clock moving
    // backward or a stale older cache; left in place it would be served frozen
    // instead of recomputed live. Yesterday and earlier stay cached.
    const todayStr = toDateString(now)
    if (c.days.some(d => d.date >= todayStr)) {
      const freshDays = c.days.filter(d => d.date < todayStr)
      const latestFresh = freshDays.length > 0 ? freshDays[freshDays.length - 1].date : null
      c = { ...c, days: freshDays, lastComputedDate: latestFresh }
    }

    // Three reasons to re-derive the whole retention window:
    //  1. Savings config changed — cached `savingsUSD` totals are stale.
    //  2. The cache was never finalized against a COMPLETE session parse (an old
    //     pre-marker cache, an adoption from older cache files, or one frozen
    //     from a partial/interrupted hydration).
    //  3. The local timezone changed — days are bucketed by local midnight, so a
    //     TZ change mis-buckets every cached day. Only invalidate when a tzKey is
    //     present and differs (a cache written before this field, or a test
    //     fixture, has none → left alone rather than force a spurious rebuild).
    //
    // Re-derive, NOT discard. Session files are ephemeral; a cached day whose
    // sources are gone exists nowhere else, so the old days stay as a baseline
    // and the fresh parse overrides per (day, provider) wherever it actually
    // produced data. What it could not re-derive is carried forward (marked
    // `carried`) with its old accounting — every wipe here before v14 turned
    // into permanently lost history.
    const tzKey = currentTzKey()
    const tzChanged = c.tzKey !== undefined && c.tzKey !== tzKey
    if (c.savingsConfigHash !== savingsConfigHash || c.complete !== true || tzChanged) {
      const baseline = c.days
      const backfillStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - BACKFILL_DAYS)
      let freshDays: DailyEntry[] = []
      if (backfillStart.getTime() <= yesterdayEnd.getTime()) {
        freshDays = aggregateDays(await parseSessions({ start: backfillStart, end: yesterdayEnd }))
      }
      const parseWasComplete = sessionComplete()
      // A PARTIAL parse must not overwrite finalized baseline days with
      // undercounts (if their sources die before the next complete parse, the
      // undercount would be what survives). Partial fresh data only fills days
      // and slices the baseline lacks; the next complete parse gets to win.
      const merged = parseWasComplete
        ? mergeDayEntries(freshDays, baseline, true)
        : mergeDayEntries(baseline, freshDays, false)
      c = {
        version: DAILY_CACHE_VERSION,
        savingsConfigHash,
        tzKey,
        lastComputedDate: yesterdayStr,
        days: applyRetention(merged, yesterdayStr),
        complete: parseWasComplete,
      }
      await saveDailyCache(c)
      return c
    }
    if (c.tzKey === undefined) {
      // First write under the tzKey scheme: tag the cache so a later TZ change is
      // detectable, without discarding the (still-valid, same-TZ) cached days.
      c = { ...c, tzKey }
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
