import { useCallback, useContext, useEffect, useRef, useState } from 'react'

import { normalizeCliError } from '../lib/ipc'
import { RefreshCadenceContext } from '../lib/refreshCadence'
import type { CliError } from '../lib/types'

export type Polled<T> = {
  data: T | null
  error: CliError | null
  loading: boolean
  /** True while a fresh fetch runs behind instantly-served memoized data (a
   *  provider/period switch). Sections use it for a subtle in-flight indicator. */
  switching: boolean
  /** Wall-clock timestamp for the most recent successful fetch. */
  lastSuccessAt: number | null
  /** Re-run the fetcher immediately (period/provider change, manual refresh). */
  refresh: () => void
}

// Module-level LRU of last-good results per memoKey. A section that switches deps
// to a previously-seen key (e.g. a provider switch, or a switch-back) paints the
// cached result in the same frame while a fresh fetch runs behind it — no blank,
// no stale-freeze. ~8 entries is plenty for the handful of live (provider ×
// period × range) combinations a user cycles through.
const MEMO_MAX = 8
const memoStore = new Map<string, unknown>()

function memoGet<T>(key: string): T | undefined {
  if (!memoStore.has(key)) return undefined
  const value = memoStore.get(key) as T
  // Touch recency.
  memoStore.delete(key)
  memoStore.set(key, value)
  return value
}

function memoSet(key: string, value: unknown): void {
  if (memoStore.has(key)) memoStore.delete(key)
  memoStore.set(key, value)
  while (memoStore.size > MEMO_MAX) {
    const oldest = memoStore.keys().next().value
    if (oldest === undefined) break
    memoStore.delete(oldest)
  }
}

/** Test-only: clear the module-level memo between renders so cached results from
 *  one test never bleed into the next. */
export function __resetPolledMemo(): void {
  memoStore.clear()
}

/**
 * Generic CLI-backed data hook: fetches on mount + whenever `deps` change, then
 * re-polls every `intervalMs`. Errors are normalized to the CliError shape so
 * sections can branch on `error.kind`. Last-good data is retained on error.
 *
 * `intervalMs` defaults to the app-wide refresh cadence (Settings > General) via
 * context; pass one explicitly to override. `null` cadence (Manual) means no
 * setInterval — the fetcher runs only on mount, deps change, and refresh().
 *
 * `enabled` (default true) gates fetching: while false the hook stays in its
 * initial loading state and issues no CLI spawn. The app boot flow sets it false
 * on every section poll until the first overview resolves, so the one-time cold
 * cache hydration happens ONCE (via overview) instead of fanning out into a
 * parallel full-history parse per section.
 *
 * `memoKey` opts into the instant-switch memo above.
 */
export function usePolled<T>(
  fetcher: () => Promise<T>,
  deps: unknown[],
  opts: { intervalMs?: number | null; enabled?: boolean; memoKey?: string } = {},
): Polled<T> {
  const cadence = useContext(RefreshCadenceContext)
  const intervalMs = opts.intervalMs !== undefined ? opts.intervalMs : cadence.intervalMs
  const enabled = opts.enabled ?? true
  const memoKey = opts.memoKey
  const [data, setData] = useState<T | null>(() => (memoKey ? memoGet<T>(memoKey) ?? null : null))
  const [error, setError] = useState<CliError | null>(null)
  const [loading, setLoading] = useState(true)
  const [switching, setSwitching] = useState(false)
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null)
  // Generation counter: every load() (mount, deps change, interval, refresh)
  // claims the next epoch; a fetch applies its result only while its epoch is
  // still current. This is what keeps a slow fetch from an older deps/period
  // from clobbering a newer one that already resolved.
  const epochRef = useRef(0)

  const load = useCallback(() => {
    if (!enabled) return
    const epoch = ++epochRef.current
    // Instant paint: on a deps/key change, if a last-good result for the new key
    // is cached, show it immediately and flag `switching` while the fresh fetch
    // runs. Otherwise fall back to the normal loading state.
    let servedCached = false
    if (memoKey) {
      const cached = memoGet<T>(memoKey)
      if (cached !== undefined) { setData(cached); servedCached = true }
    }
    setLoading(true)
    setSwitching(servedCached)
    // Clear any prior error at the start of each attempt so a fresh poll never
    // shows a stale banner while it is still in flight; last-good `data` stays.
    setError(null)
    fetcher()
      .then(result => {
        if (epochRef.current !== epoch) return
        setData(result)
        setError(null)
        setLastSuccessAt(Date.now())
        if (memoKey) memoSet(memoKey, result)
      })
      .catch(err => {
        if (epochRef.current !== epoch) return
        setError(normalizeCliError(err))
      })
      .finally(() => {
        if (epochRef.current !== epoch) return
        setLoading(false)
        setSwitching(false)
      })
    // deps are intentionally the caller-provided dependency list; `enabled` and
    // `memoKey` are prepended so flipping the gate / key re-creates load and
    // fires immediately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, memoKey, ...deps])

  useEffect(() => {
    load()
    // Manual cadence (intervalMs == null) skips the interval entirely.
    const id = intervalMs != null ? setInterval(() => load(), intervalMs) : null
    return () => {
      if (id != null) clearInterval(id)
      // Retire this generation so an in-flight fetch can't resolve into state
      // after unmount or a deps change.
      epochRef.current++
    }
  }, [load, intervalMs])

  const refresh = useCallback(() => {
    load()
  }, [load])

  return { data, error, loading, switching, lastSuccessAt, refresh }
}
