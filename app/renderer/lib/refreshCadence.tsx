import { createContext, useContext } from 'react'

// The auto-refresh cadence, chosen in Settings > General and persisted at
// localStorage `codeburn.refreshInterval`. usePolled reads the resolved
// interval from context as its default when the caller passes none. `Manual`
// means no setInterval — data refreshes only on deps change and ⌘R / refresh.
export const REFRESH_OPTIONS: ReadonlyArray<{ value: string; label: string; ms: number | null }> = [
  { value: 'manual', label: 'Manual', ms: null },
  { value: '30s', label: '30 seconds', ms: 30_000 },
  { value: '1m', label: '1 minute', ms: 60_000 },
  { value: '3m', label: '3 minutes', ms: 180_000 },
  { value: '5m', label: '5 minutes', ms: 300_000 },
  { value: '10m', label: '10 minutes', ms: 600_000 },
]

// 60s is the default cadence: it halves idle CLI spawns versus the old 30s while
// staying fresh enough for a usage dashboard. 30s is still offered for anyone who
// wants it. Only an explicit choice is persisted (persistRefreshValue runs solely
// from Settings), so bumping this default silently migrates users who never chose,
// while any stored value below keeps overriding it.
export const DEFAULT_REFRESH_VALUE = '1m'
const DEFAULT_MS = 60_000
const STORAGE_KEY = 'codeburn.refreshInterval'

export function refreshValueToMs(value: string): number | null {
  const option = REFRESH_OPTIONS.find(o => o.value === value)
  return option ? option.ms : DEFAULT_MS
}

/** Persisted cadence at boot; falls back to the 30s default (prior behavior). */
export function readRefreshValue(): string {
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (saved && REFRESH_OPTIONS.some(o => o.value === saved)) return saved
  } catch { /* storage can be unavailable */ }
  return DEFAULT_REFRESH_VALUE
}

export function persistRefreshValue(value: string): void {
  try { globalThis.localStorage?.setItem(STORAGE_KEY, value) } catch { /* storage can be unavailable */ }
}

export type RefreshCadence = {
  value: string
  /** Resolved poll interval in ms, or null for Manual (no auto-poll). */
  intervalMs: number | null
  setValue: (value: string) => void
}

// Default matches the historical 30s hardcoded interval so any consumer rendered
// without a provider (e.g. isolated hook/component tests) behaves as before.
export const RefreshCadenceContext = createContext<RefreshCadence>({
  value: DEFAULT_REFRESH_VALUE,
  intervalMs: DEFAULT_MS,
  setValue: () => {},
})

export function useRefreshCadence(): RefreshCadence {
  return useContext(RefreshCadenceContext)
}
