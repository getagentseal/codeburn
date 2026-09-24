import type { MenubarPayload } from './types'

const STORAGE_KEY = 'codeburn.overview-headlines.v2'
const LEGACY_STORAGE_KEYS = ['codeburn.overview-headlines.v1'] as const
const SNAPSHOT_VERSION = 2
const MAX_ENTRIES = 96
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export type OverviewHeadlineSnapshot = {
  version: 2
  /** The exact period/provider/config memo identity this headline belongs to. */
  key: string
  capturedAt: number
  generated: string
  label: string
  cost: number
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  currency?: MenubarPayload['currency']
}

type StoredSnapshotMap = Record<string, OverviewHeadlineSnapshot>

function storage(): Storage | null {
  try { return globalThis.localStorage ?? null } catch { return null }
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function valid(value: unknown): value is OverviewHeadlineSnapshot {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<OverviewHeadlineSnapshot>
  return item.version === SNAPSHOT_VERSION
    && typeof item.key === 'string'
    && finite(item.capturedAt)
    && typeof item.generated === 'string'
    && typeof item.label === 'string'
    && finite(item.cost)
    && finite(item.calls)
    && finite(item.inputTokens)
    && finite(item.outputTokens)
    && finite(item.cacheReadTokens)
    && finite(item.cacheWriteTokens)
}

function readMap(store = storage()): StoredSnapshotMap {
  if (!store) return {}
  try {
    const parsed = JSON.parse(store.getItem(STORAGE_KEY) ?? '{}') as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, OverviewHeadlineSnapshot] => valid(entry[1])))
  } catch {
    return {}
  }
}

/** Read a previously authoritative headline without starting the CLI. The
 * snapshot is deliberately tiny: no projects, paths, session names, models, or
 * behavioral conclusions are duplicated into renderer storage. */
export function readOverviewHeadline(key: string, now = Date.now()): OverviewHeadlineSnapshot | null {
  const item = readMap()[key]
  if (!item || item.key !== key || now - item.capturedAt > MAX_AGE_MS || item.capturedAt > now + 60_000) return null
  return item
}

/** Persist only fields proved additive/equal by overview-summary-index-parity.
 * Sessions and every drill-down are intentionally excluded: they require the
 * authoritative parse and the UI labels them as updating until it completes. */
export function writeOverviewHeadline(key: string, payload: MenubarPayload, capturedAt = Date.now()): OverviewHeadlineSnapshot | null {
  // Resident serve may answer progressively while a large corpus is still
  // indexing. Those totals are useful live with an indexing banner, but they
  // are not a complete exact result and must never survive a restart as one.
  if (payload.hydration?.complete === false) return null
  const store = storage()
  if (!store) return null
  const current = payload.current
  const snapshot: OverviewHeadlineSnapshot = {
    version: SNAPSHOT_VERSION,
    key,
    capturedAt,
    generated: payload.generated,
    label: current.label,
    cost: current.cost,
    calls: current.calls,
    inputTokens: current.inputTokens,
    outputTokens: current.outputTokens,
    cacheReadTokens: current.cacheReadTokens,
    cacheWriteTokens: current.cacheWriteTokens,
    ...(payload.currency ? { currency: payload.currency } : {}),
  }
  const entries = Object.entries({ ...readMap(store), [key]: snapshot })
    .sort((a, b) => b[1].capturedAt - a[1].capturedAt)
    .slice(0, MAX_ENTRIES)
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)))
    return snapshot
  } catch {
    return null
  }
}

export function clearOverviewHeadlines(): void {
  try {
    const store = storage()
    store?.removeItem(STORAGE_KEY)
    for (const key of LEGACY_STORAGE_KEYS) store?.removeItem(key)
  } catch { /* storage can be unavailable */ }
}

const APP_VERSION_KEY = 'codeburn.app-version'

/** On the first launch after an upgrade the cached per-period headlines belong to
 * the old build; wipe them once so that launch never flashes a stale headline
 * before the fresh value arrives. No-op when the stored version already matches. */
export function clearHeadlinesOnUpgrade(currentVersion: string): void {
  try {
    const store = storage()
    if (!store || store.getItem(APP_VERSION_KEY) === currentVersion) return
    clearOverviewHeadlines()
    store.setItem(APP_VERSION_KEY, currentVersion)
  } catch { /* storage can be unavailable */ }
}

export const __overviewSnapshotStorageKey = STORAGE_KEY
