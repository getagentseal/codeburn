import { useEffect, useRef, useState } from 'react'

import { codeburn, normalizeCliError } from '../lib/ipc'
import type { CliError, DateRange, OptimizeSnapshot, Period } from '../lib/types'

/** Force a recompute regardless of what is cached. */
const FORCE = 0

type OptimizeSnapshotState = { data: OptimizeSnapshot | null; loading: boolean; error: CliError | null }

export type OptimizeScope = {
  period: Period
  provider: string
  range?: DateRange | null
  configSource?: string | null
  scope?: string
}

/**
 * The optimize scan, at DAILY speed. The live overview poll runs with
 * --no-optimize, so these figures come from the main process's on-disk cache:
 * served when one exists for this exact scope and is younger than a day,
 * recomputed otherwise.
 *
 * `alwaysFresh` (the Optimize page) recomputes on every mount, so that page
 * behaves exactly as it did when the poll carried the block. A change in
 * `refreshToken` (manual refresh) forces a recompute too. Nothing here is ever
 * driven by a timer.
 */
export function useOptimizeSnapshot(
  { period, provider, range = null, configSource = null, scope = 'local' }: OptimizeScope,
  { enabled = true, alwaysFresh = false, refreshToken = 0 }: { enabled?: boolean; alwaysFresh?: boolean; refreshToken?: number } = {},
): { data: OptimizeSnapshot | null; loading: boolean; error: CliError | null } {
  const [state, setState] = useState<OptimizeSnapshotState>({ data: null, loading: true, error: null })
  const lastToken = useRef<number | null>(null)
  // The local calendar day, read at RENDER time and used as an effect
  // dependency. Every period this scan is computed for is anchored to the local
  // day, so an app left open past midnight must re-ask rather than keep
  // yesterday's figure under "Today". The live headline poll re-renders this
  // tree every cadence tick, so the first render after midnight flips this key
  // and re-requests; main then recomputes because its stored row is from
  // another day (app/electron/optimize-store.ts sameLocalDay). Deliberately a
  // plain request, not a forced one — the same-day rule main-side is what
  // decides. Under the Manual cadence nothing re-renders, so this does not fire
  // until the next interaction; acceptable, because the headline beside it is
  // not refreshing either and the age label carries the date once it is stale.
  const localDay = new Date().toDateString()

  useEffect(() => {
    const forced = alwaysFresh || (lastToken.current !== null && lastToken.current !== refreshToken)
    lastToken.current = refreshToken
    const fetchSnapshot = codeburn.getOptimizeSnapshot
    if (!enabled || typeof fetchSnapshot !== 'function') {
      // No bridge method (older preload) is not a loading state that never ends;
      // it is simply nothing to show, which is not an error either.
      setState({ data: null, loading: enabled === false, error: null })
      return
    }
    let cancelled = false
    setState({ data: null, loading: true, error: null })
    // Off the critical path: yield the frame so the headline paints first. The
    // main process additionally spawns this at background CLI priority.
    const handle = setTimeout(() => {
      fetchSnapshot(period, provider, range ?? undefined, configSource, scope, forced ? FORCE : undefined)
        .then(value => { if (!cancelled) setState({ data: value, loading: false, error: null }) })
        // A failed scan must not look like one still running: the Optimize page
        // shows the error (a manual refresh re-runs it), Overview just omits
        // the clause.
        .catch(err => { if (!cancelled) setState({ data: null, loading: false, error: normalizeCliError(err) }) })
    }, 0)
    return () => { cancelled = true; clearTimeout(handle) }
  }, [period, provider, range?.from, range?.to, configSource, scope, enabled, alwaysFresh, refreshToken, localDay])

  return state
}
