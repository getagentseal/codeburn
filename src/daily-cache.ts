import { randomBytes } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, open, readFile, rename, unlink } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

export const DAILY_CACHE_VERSION = 4
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

function emptyCache(): DailyCache {
  return { version: DAILY_CACHE_VERSION, lastComputedDate: null, days: [] }
}

function isValidCache(parsed: unknown): parsed is DailyCache {
  if (!parsed || typeof parsed !== 'object') return false
  const c = parsed as Partial<DailyCache>
  if (c.version !== DAILY_CACHE_VERSION) return false
  if (!Array.isArray(c.days)) return false
  return true
}

export async function loadDailyCache(): Promise<DailyCache> {
  const path = getCachePath()
  if (!existsSync(path)) return emptyCache()
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (!isValidCache(parsed)) return emptyCache()
    return parsed
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
  const nextLast = cache.lastComputedDate && cache.lastComputedDate > newestDate
    ? cache.lastComputedDate
    : newestDate
  return { version: DAILY_CACHE_VERSION, lastComputedDate: nextLast, days: merged }
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
