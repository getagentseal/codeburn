import { useCallback, useEffect, useState } from 'react'

import { normalizeCliError } from '../lib/ipc'
import type { CliError } from '../lib/types'

export type Polled<T> = {
  data: T | null
  error: CliError | null
  loading: boolean
  /** Re-run the fetcher immediately (period/provider change, manual refresh). */
  refresh: () => void
}

/**
 * Generic CLI-backed data hook: fetches on mount + whenever `deps` change, then
 * re-polls every `intervalMs`. Errors are normalized to the CliError shape so
 * sections can branch on `error.kind`. Last-good data is retained on error.
 */
export function usePolled<T>(fetcher: () => Promise<T>, deps: unknown[], intervalMs = 30_000): Polled<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<CliError | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    let cancelled = false
    setLoading(true)
    fetcher()
      .then(result => {
        if (cancelled) return
        setData(result)
        setError(null)
      })
      .catch(err => {
        if (!cancelled) setError(normalizeCliError(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // deps are intentionally the caller-provided dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  useEffect(() => {
    const cancel = load()
    const id = setInterval(() => load(), intervalMs)
    return () => {
      cancel()
      clearInterval(id)
    }
  }, [load, intervalMs])

  const refresh = useCallback(() => {
    load()
  }, [load])

  return { data, error, loading, refresh }
}
