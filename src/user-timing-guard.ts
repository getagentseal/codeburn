import { performance } from 'node:perf_hooks'

// React's development build - the one Ink loads whenever NODE_ENV is anything
// but "production" - records a performance.measure() entry for every render
// (its Chrome DevTools "Scheduler ⚛" / "Components ⚛" tracks). Node keeps
// user-timing marks and measures in a process-wide buffer that nothing trims,
// so an interactive Ink UI left open accumulates them until V8 aborts with
// "JavaScript heap out of memory" (roughly 700 entries a minute for the
// dashboard; a few days is enough to exhaust the default heap).
//
// The launcher defaults NODE_ENV to "production", which selects the build that
// records nothing. This guard covers the remaining case - an explicit
// NODE_ENV=development in the user's shell - by dropping the buffer on a
// timer. codeburn records no marks or measures of its own, so nothing is lost.

export const USER_TIMING_GUARD_INTERVAL_MS = 30_000

export function userTimingEntryCount(): number {
  return performance.getEntriesByType('mark').length + performance.getEntriesByType('measure').length
}

/** Drops every user-timing mark and measure without looking at them first. */
export function clearUserTimingEntries(): void {
  performance.clearMarks()
  performance.clearMeasures()
}

/** Drops every user-timing mark and measure; returns how many were dropped. */
export function dropUserTimingEntries(): number {
  const count = userTimingEntryCount()
  if (count > 0) clearUserTimingEntries()
  return count
}

/**
 * Drops user-timing entries every `intervalMs` until the returned stop
 * function is called. The timer is unref'd so it never keeps the process alive;
 * stopping drops whatever accumulated since the last tick. The tick clears
 * blind: counting first would copy the buffer it is about to empty.
 */
export function startUserTimingGuard(intervalMs = USER_TIMING_GUARD_INTERVAL_MS): () => void {
  const timer = setInterval(clearUserTimingEntries, intervalMs)
  timer.unref()
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    dropUserTimingEntries()
  }
}
