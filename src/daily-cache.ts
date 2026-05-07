import { randomBytes } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, open, readFile, rename, unlink } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type { DateRange, ProjectSummary } from './types.js'

export const DAILY_CACHE_VERSION = 4
const MIN_SUPPORTED_VERSION = 2
const DAILY_CACHE_FILENAME = 'daily-cache.json'

export type DailyEntry = {
  date: string
  cost: number
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
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
  }>
  categories: Record<string, { turns: number; cost: number; editTurns: number; oneShotTurns: number }>
  providers: Record<string, { calls: number; cost: number }>
}

export type DailyCache = {
  version: number
  lastComputedDate: string | null
  days: DailyEntry[]
}

function getCacheDir(): string {
  return process.env['CODEBURN_CACHE_DIR'] ?? join(homedir(), '.cache', 'codeburn')
}

function getCachePath(): string {
  return join(getCacheDir(), DAILY_CACHE_FILENAME)
}

export function emptyCache(): DailyCache {
  return { version: DAILY_CACHE_VERSION, lastComputedDate: null, days: [] }
}

function isMigratableCache(parsed: unknown): parsed is { version: number; lastComputedDate: string | null; days: Record<string, unknown>[] } {
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

async function backupOldCache(path: string, version: number): Promise<void> {
  const backupPath = `${path}.v${version}.bak`
  try { await rename(path, backupPath) } catch { /* best-effort */ }
}

export async function loadDailyCache(): Promise<DailyCache> {
  const path = getCachePath()
  if (!existsSync(path)) return emptyCache()
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (isMigratableCache(parsed)) {
      const migrated: DailyCache = {
        version: DAILY_CACHE_VERSION,
        lastComputedDate: parsed.lastComputedDate,
        days: migrateDays(parsed.days),
      }
      if (parsed.version < DAILY_CACHE_VERSION) {
        await saveDailyCache(migrated).catch(() => {})
      }
      return migrated
    }
    const oldVersion = (parsed as { version?: number })?.version
    if (typeof oldVersion === 'number') await backupOldCache(path, oldVersion)
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
  return { version: DAILY_CACHE_VERSION, lastComputedDate: nextLast, days: pruned }
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
): Promise<DailyCache> {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterdayEnd = new Date(todayStart.getTime() - 1)
  const yesterdayStr = toDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))

  return withDailyCacheLock(async () => {
    let c = await loadDailyCache()

    const hadYesterday = c.days.some(d => d.date >= yesterdayStr)
    if (hadYesterday) {
      const freshDays = c.days.filter(d => d.date < yesterdayStr)
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
      await saveDailyCache(c)
    }
    return c
  })
}
