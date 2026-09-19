// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, renderHook, act } from '@testing-library/react'

import { RefreshCadenceContext, type RefreshCadence } from '../lib/refreshCadence'
import { __resetPolledMemo, clearPolledMemo, hasPolledMemo, polledMemoTimestamp, primePolledMemo, usePolled } from './usePolled'

function cadenceWrapper(intervalMs: number | null) {
  const value: RefreshCadence = { value: 'x', intervalMs, setValue: () => {} }
  return ({ children }: { children: ReactNode }) => createElement(RefreshCadenceContext.Provider, { value }, children)
}

/** Override document visibility for the hidden-polling tests. jsdom defaults to
 *  'visible'; the own-property override is torn down in afterEach. */
function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' })
}
afterEach(() => {
  delete (document as unknown as { visibilityState?: unknown }).visibilityState
  delete (document as unknown as { hidden?: unknown }).hidden
  localStorage.clear()
  clearPolledMemo()
})

describe('usePolled', () => {
  it('discards a stale in-flight fetch that resolves after a newer one (epoch guard)', async () => {
    // A fetcher we resolve by hand, one deferred per call, so we can force a
    // SLOW deps-A fetch to resolve AFTER a FAST deps-B fetch.
    const resolvers: Array<(v: string) => void> = []
    const fetcher = vi.fn(() => new Promise<string>(resolve => { resolvers.push(resolve) }))

    const { result, rerender } = renderHook(
      ({ p }: { p: string }) => usePolled(fetcher, [p]),
      { initialProps: { p: 'A' } },
    )

    // #0 mount fetch (deps A) — resolve it to establish a known baseline.
    await act(async () => { resolvers[0]!('A0') })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(result.current.data).toBe('A0')

    // #1 refresh() while deps are still A → an in-flight SLOW fetch whose cancel
    // handle the hook discards. Leave it unresolved for now.
    act(() => { result.current.refresh() })
    expect(fetcher).toHaveBeenCalledTimes(2)

    // #2 deps change A→B → a FAST fetch that resolves first with fresh data.
    rerender({ p: 'B' })
    expect(fetcher).toHaveBeenCalledTimes(3)
    await act(async () => { resolvers[2]!('B-fresh') })
    expect(result.current.data).toBe('B-fresh')

    // #1 (the slow deps-A fetch) now resolves LATE. It must NOT clobber B.
    await act(async () => { resolvers[1]!('A-stale') })
    expect(result.current.data).toBe('B-fresh')
  })

  it('does not fetch while disabled, then fires once enabled flips true', async () => {
    const resolvers: Array<(v: string) => void> = []
    const fetcher = vi.fn(() => new Promise<string>(resolve => { resolvers.push(resolve) }))

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => usePolled(fetcher, ['x'], { enabled }),
      { initialProps: { enabled: false } },
    )

    // Gated: no spawn, still in the initial loading state (splash/skeleton stays).
    expect(fetcher).not.toHaveBeenCalled()
    expect(result.current.loading).toBe(true)
    expect(result.current.data).toBeNull()

    // Gate opens (first overview resolved): the fetch fires exactly once.
    rerender({ enabled: true })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await act(async () => { resolvers[0]!('ready') })
    expect(result.current.data).toBe('ready')
  })

  it('keeps last-good data and exposes the error when a background reload fails', async () => {
    const calls: Array<{ resolve: (v: string) => void; reject: (e: unknown) => void }> = []
    const fetcher = vi.fn(() => new Promise<string>((resolve, reject) => { calls.push({ resolve, reject }) }))
    const { result } = renderHook(() => usePolled(fetcher, []))

    // Establish last-good data.
    await act(async () => { calls[0]!.resolve('good') })
    expect(result.current.data).toBe('good')
    expect(result.current.error).toBeNull()

    // A reload clears the error up front; if it fails, data is retained and the
    // error is surfaced alongside it (the StaleBanner condition).
    act(() => { result.current.refresh() })
    expect(result.current.error).toBeNull()
    await act(async () => { calls[1]!.reject({ kind: 'nonzero', message: 'boom' }) })
    expect(result.current.data).toBe('good')
    expect(result.current.error).toMatchObject({ kind: 'nonzero', message: 'boom' })
  })

  it('serves last-good data instantly on switch-back and flags `switching` while it refreshes', async () => {
    vi.useFakeTimers()
    try {
      const resolvers: Array<(v: string) => void> = []
      const fetcher = vi.fn(() => new Promise<string>(resolve => { resolvers.push(resolve) }))

      // Mount on key kA, resolve to A0 → memoized under kA.
      const { result, rerender } = renderHook(
        ({ k }: { k: string }) => usePolled(fetcher, [k], { memoKey: k, intervalMs: null }),
        { initialProps: { k: 'kA' } },
      )
      await act(async () => { resolvers[0]!('A0') })
      expect(result.current.data).toBe('A0')
      expect(result.current.switching).toBe(false)

      // Switch to a fresh key kB, resolve to B0 → memoized under kB.
      rerender({ k: 'kB' })
      await act(async () => { resolvers[1]!('B0') })
      expect(result.current.data).toBe('B0')

      // Age kA past the freshness window so the switch-back revalidates.
      await act(async () => { await vi.advanceTimersByTimeAsync(31_000) })

      // Switch BACK to kA: the memoized A0 paints in the same commit (no blank, no
      // B0 freeze) and `switching` is true while the fresh fetch runs behind it.
      rerender({ k: 'kA' })
      expect(result.current.data).toBe('A0')
      expect(result.current.switching).toBe(true)
      expect(result.current.loading).toBe(true)

      // The fresh fetch resolves → new data swaps in place, switching clears.
      await act(async () => { resolvers[2]!('A1') })
      expect(result.current.data).toBe('A1')
      expect(result.current.switching).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('serves a still-fresh cached key with no fetch at all (switch costs nothing)', async () => {
    const resolvers: Array<(v: string) => void> = []
    const fetcher = vi.fn(() => new Promise<string>(resolve => { resolvers.push(resolve) }))

    const { result, rerender } = renderHook(
      ({ k }: { k: string }) => usePolled(fetcher, [k], { memoKey: k, intervalMs: null }),
      { initialProps: { k: 'fA' } },
    )
    await act(async () => { resolvers[0]!('A0') })
    rerender({ k: 'fB' })
    await act(async () => { resolvers[1]!('B0') })
    expect(fetcher).toHaveBeenCalledTimes(2)

    // Straight back to fA well inside the freshness window: painted instantly and
    // NOT revalidated — no CLI spawn, no loading state, no switching indicator.
    rerender({ k: 'fA' })
    expect(result.current.data).toBe('A0')
    expect(result.current.loading).toBe(false)
    expect(result.current.switching).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(2)

    // An explicit refresh still bypasses freshness.
    act(() => { result.current.refresh() })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('keeps the cached payload painted when the background revalidate fails', async () => {
    vi.useFakeTimers()
    try {
      const calls: Array<{ resolve: (v: string) => void; reject: (e: unknown) => void }> = []
      const fetcher = vi.fn(() => new Promise<string>((resolve, reject) => { calls.push({ resolve, reject }) }))

      const { result, rerender } = renderHook(
        ({ k }: { k: string }) => usePolled(fetcher, [k], { memoKey: k, intervalMs: null }),
        { initialProps: { k: 'eA' } },
      )
      await act(async () => { calls[0]!.resolve('A0') })
      rerender({ k: 'eB' })
      await act(async () => { calls[1]!.resolve('B0') })
      await act(async () => { await vi.advanceTimersByTimeAsync(31_000) })

      // Switch back to the stale eA, then fail its background revalidate: the
      // cached payload stays on screen and the error surfaces beside it.
      rerender({ k: 'eA' })
      expect(result.current.data).toBe('A0')
      await act(async () => { calls[2]!.reject({ kind: 'nonzero', message: 'boom' }) })
      expect(result.current.data).toBe('A0')
      expect(result.current.error).toMatchObject({ kind: 'nonzero', message: 'boom' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds the instant-switch memo and retains recently-used keys', () => {
    clearPolledMemo()
    for (let i = 0; i < 96; i++) primePolledMemo(`key-${i}`, i)

    // Re-seeding the oldest key makes it recent before the next insertion.
    expect(hasPolledMemo('key-0')).toBe(true)
    primePolledMemo('key-0', 0)
    primePolledMemo('key-96', 96)

    expect(hasPolledMemo('key-0')).toBe(true)
    expect(hasPolledMemo('key-1')).toBe(false)
    expect(hasPolledMemo('key-96')).toBe(true)
  })

  it('bounds the instant-switch memo by serialized weight, not only entry count', () => {
    primePolledMemo('large', { text: 'x'.repeat(12_000_001) })
    expect(hasPolledMemo('large')).toBe(true)

    // The newest entry wins; adding it evicts the older oversized graph rather
    // than retaining both merely because the count is below 96.
    primePolledMemo('newest', { total: 42 })
    expect(hasPolledMemo('large')).toBe(false)
    expect(hasPolledMemo('newest')).toBe(true)
  })

  it('restores the last successful keyed payload after a renderer restart, then refreshes behind it', async () => {
    const firstFetcher = vi.fn().mockResolvedValue({ total: 42 })
    const first = renderHook(() => usePolled(firstFetcher, [], { memoKey: 'sessions|today|all', intervalMs: null }))
    await act(async () => {})
    expect(first.result.current.data).toEqual({ total: 42 })
    first.unmount()

    // A renderer restart loses module memory but preserves the app origin's
    // durable local snapshot. The next mount must paint it synchronously.
    __resetPolledMemo()
    const secondFetcher = vi.fn(() => new Promise<{ total: number }>(() => {}))
    const second = renderHook(() => usePolled(secondFetcher, [], { memoKey: 'sessions|today|all', intervalMs: null }))

    expect(second.result.current.data).toEqual({ total: 42 })
    expect(second.result.current.switching).toBe(true)
    expect(secondFetcher).toHaveBeenCalledTimes(1)
  })

  it('never reports a refresh time from a restored snapshot, not even for the render before switch effects run', async () => {
    // Leave a durable snapshot for key B behind, then drop module memory: B is
    // now reachable only from disk, as it would be after a restart.
    const seed = renderHook(() => usePolled(vi.fn().mockResolvedValue({ total: 42 }), [], { memoKey: 'overview|B', intervalMs: null }))
    await act(async () => {})
    seed.unmount()
    __resetPolledMemo()
    const aged = Date.now() - 3 * 24 * 60 * 60 * 1000
    for (const key of Object.keys(localStorage)) {
      localStorage.setItem(key, (localStorage.getItem(key) ?? '').replace(/^\{"at":\d+/, `{"at":${aged}`))
    }

    // The consumers of `lastSuccessAt` (the generation and the persisted
    // headline) read it every render, so sample every render, not the settled one.
    const started = Date.now()
    const stamps: Array<number | null> = []
    const { rerender } = renderHook(
      ({ k }: { k: string }) => {
        const polled = usePolled(vi.fn().mockResolvedValue({ total: 43 }), [k], { memoKey: k, intervalMs: null })
        stamps.push(polled.lastSuccessAt)
        return polled
      },
      { initialProps: { k: 'overview|A' } },
    )
    await act(async () => {})
    stamps.length = 0

    rerender({ k: 'overview|B' })
    expect(stamps.length).toBeGreaterThan(0)
    expect(stamps.filter(at => at !== null && at < started)).toEqual([])
  })

  it('reports no refresh time for a snapshot restored from a previous app run', async () => {
    const first = renderHook(() => usePolled(vi.fn().mockResolvedValue({ total: 42 }), [], { memoKey: 'overview|restart', intervalMs: null }))
    await act(async () => {})
    expect(polledMemoTimestamp('overview|restart')).toBeCloseTo(Date.now(), -3)
    first.unmount()

    // The restored payload is hours old and the refresh it describes never
    // happened in this run: the footer must not announce it as one.
    __resetPolledMemo()
    expect(polledMemoTimestamp('overview|restart')).toBeNull()

    const second = renderHook(() => usePolled(vi.fn().mockResolvedValue({ total: 43 }), [], { memoKey: 'overview|restart', intervalMs: null }))
    await act(async () => {})
    expect(polledMemoTimestamp('overview|restart')).toBeCloseTo(Date.now(), -3)
    second.unmount()
  })

  it('compresses a heavy report snapshot before placing it in renderer storage', async () => {
    const repeated = Array.from({ length: 2_000 }, (_, index) => ({
      id: index,
      project: 'Documents/Codeburn/long-repeated-project-name',
      summary: 'A deliberately repetitive heavy-corpus session summary',
    }))
    const first = renderHook(() => usePolled(
      vi.fn().mockResolvedValue(repeated),
      [],
      { memoKey: 'sessions|lifetime|all', intervalMs: null },
    ))
    await act(async () => {})
    first.unmount()

    const stored = Object.keys(localStorage)
      .map(key => localStorage.getItem(key) ?? '')
      .find(value => value.includes('lz-utf16'))
    expect(stored).toBeDefined()
    expect(stored).not.toContain('long-repeated-project-name')

    __resetPolledMemo()
    const second = renderHook(() => usePolled(
      vi.fn(() => new Promise<typeof repeated>(() => {})),
      [],
      { memoKey: 'sessions|lifetime|all', intervalMs: null },
    ))
    expect(second.result.current.data).toEqual(repeated)
  })

  it('does not recompress or rewrite an unchanged durable report', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    primePolledMemo('unchanged|week|all', { total: 42, rows: [1, 2, 3] })
    expect(setItem).toHaveBeenCalledTimes(1)

    primePolledMemo('unchanged|week|all', { total: 42, rows: [1, 2, 3] })
    expect(setItem).toHaveBeenCalledTimes(1)
    setItem.mockRestore()
  })

  it('keeps oversized, stale, and partial reports out of restart persistence', () => {
    primePolledMemo('oversized', { text: 'x'.repeat(300_001) })
    primePolledMemo('stale', { stale: true, total: 42 })
    primePolledMemo('partial', { hydration: { complete: false }, total: 42 })

    expect(localStorage.getItem('codeburn.reportSnapshot.v1.oversized')).toBeNull()
    expect(localStorage.getItem('codeburn.reportSnapshot.v1.stale')).toBeNull()
    expect(localStorage.getItem('codeburn.reportSnapshot.v1.partial')).toBeNull()
    __resetPolledMemo()
    expect(hasPolledMemo('oversized')).toBe(false)
    expect(hasPolledMemo('stale')).toBe(false)
    expect(hasPolledMemo('partial')).toBe(false)
  })

  it('discards an old-config fetch that resolves after cache invalidation', async () => {
    let resolve!: (value: { total: number }) => void
    const fetcher = vi.fn(() => new Promise<{ total: number }>(done => { resolve = done }))
    const { result } = renderHook(() => usePolled(fetcher, [], { memoKey: 'old-config', intervalMs: null }))

    clearPolledMemo()
    await act(async () => { resolve({ total: 42 }) })

    expect(result.current.data).toBeNull()
    expect(hasPolledMemo('old-config')).toBe(false)
  })

  it('clears stale data on a switch to an unmemoized key (skeleton, never the prior filter)', async () => {
    const resolvers: Array<(v: string) => void> = []
    const fetcher = vi.fn(() => new Promise<string>(resolve => { resolvers.push(resolve) }))

    const { result, rerender } = renderHook(
      ({ k }: { k: string }) => usePolled(fetcher, [k], { memoKey: k }),
      { initialProps: { k: 'miss-A' } },
    )
    await act(async () => { resolvers[0]!('A0') })
    expect(result.current.data).toBe('A0')

    // Switch to a brand-new key with nothing memoized: data must drop to null so
    // the section paints its skeleton, NOT the previous filter's numbers. This is
    // the "old numbers for 2-3s on switch" fix — no cache hit, no stale hold.
    rerender({ k: 'miss-B' })
    expect(result.current.data).toBeNull()
    expect(result.current.switching).toBe(false)
    expect(result.current.loading).toBe(true)

    await act(async () => { resolvers[1]!('B0') })
    expect(result.current.data).toBe('B0')

    // A background re-poll on the SAME key (its last result is memoized) must keep
    // showing data — the clear-on-miss must never blank a plain refresh.
    act(() => { result.current.refresh() })
    expect(result.current.data).toBe('B0')
  })

  it('never exposes a prior keyed payload even for the render before switch effects run', async () => {
    const resolvers: Array<(v: string) => void> = []
    const fetcher = vi.fn(() => new Promise<string>(resolve => { resolvers.push(resolve) }))
    const observed: Array<{ key: string; data: string | null }> = []
    function Probe({ memoKey }: { memoKey: string }) {
      const polled = usePolled(fetcher, [memoKey], { memoKey, intervalMs: null })
      observed.push({ key: memoKey, data: polled.data })
      return null
    }

    const view = render(createElement(Probe, { memoKey: 'frame-A' }))
    await act(async () => { resolvers[0]!('A0') })
    observed.length = 0

    view.rerender(createElement(Probe, { memoKey: 'frame-B' }))
    expect(observed[0]).toEqual({ key: 'frame-B', data: null })
  })

  it('never exposes a prior keyed error during the render before switch effects run', async () => {
    const calls: Array<{ resolve: (value: string) => void; reject: (error: unknown) => void }> = []
    const fetcher = vi.fn(() => new Promise<string>((resolve, reject) => { calls.push({ resolve, reject }) }))
    const observed: Array<{ key: string; error: unknown }> = []
    function Probe({ memoKey }: { memoKey: string }) {
      const polled = usePolled(fetcher, [memoKey], { memoKey, intervalMs: null })
      observed.push({ key: memoKey, error: polled.error })
      return null
    }
    const view = render(createElement(Probe, { memoKey: 'error-A' }))
    await act(async () => { calls[0]!.reject({ kind: 'nonzero', message: 'A failed' }) })
    expect(observed.at(-1)?.error).toMatchObject({ message: 'A failed' })
    observed.length = 0

    view.rerender(createElement(Probe, { memoKey: 'error-B' }))

    expect(observed[0]).toEqual({ key: 'error-B', error: null })
  })

  it('manual cadence (null interval) polls only on mount + refresh, never on a timer', async () => {
    vi.useFakeTimers()
    try {
      const fetcher = vi.fn().mockResolvedValue('x')
      const { result } = renderHook(() => usePolled(fetcher, [], { intervalMs: null }))
      expect(fetcher).toHaveBeenCalledTimes(1) // mount
      await act(async () => { await vi.advanceTimersByTimeAsync(600_000) })
      expect(fetcher).toHaveBeenCalledTimes(1) // no interval fired
      act(() => { result.current.refresh() })
      expect(fetcher).toHaveBeenCalledTimes(2) // manual refresh still works
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops the interval while hidden, then resumes with a catch-up on return', async () => {
    vi.useFakeTimers()
    try {
      setVisibility('visible')
      const fetcher = vi.fn().mockResolvedValue('x')
      renderHook(() => usePolled(fetcher, [], { intervalMs: 1000 }))
      expect(fetcher).toHaveBeenCalledTimes(1) // mount fetch
      // Let the mount fetch resolve so lastSuccess is recorded.
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      // One visible cadence ticks.
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(fetcher).toHaveBeenCalledTimes(2)

      // Hidden: the interval stops, so no CLI re-parse fires while unwatched.
      setVisibility('hidden')
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(fetcher).toHaveBeenCalledTimes(2) // frozen while hidden

      // Back to visible after more than one cadence: an immediate catch-up
      // refresh fires so the returning view is never stale, then ticking resumes.
      setVisibility('visible')
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
      expect(fetcher).toHaveBeenCalledTimes(3) // catch-up
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(fetcher).toHaveBeenCalledTimes(4) // single resumed interval, no stack
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not fire a catch-up when returning to visible within one cadence', async () => {
    vi.useFakeTimers()
    try {
      setVisibility('visible')
      const fetcher = vi.fn().mockResolvedValue('x')
      renderHook(() => usePolled(fetcher, [], { intervalMs: 10_000 }))
      expect(fetcher).toHaveBeenCalledTimes(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })

      // Hidden only briefly (well under the 10s cadence), then visible again:
      // the last success is still fresh, so no catch-up fetch.
      setVisibility('hidden')
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      setVisibility('visible')
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clearPolledMemo empties the instant-switch memo', () => {
    primePolledMemo('k1', 'v1')
    primePolledMemo('k2', 'v2')
    expect(hasPolledMemo('k1')).toBe(true)
    expect(hasPolledMemo('k2')).toBe(true)
    clearPolledMemo()
    expect(hasPolledMemo('k1')).toBe(false)
    expect(hasPolledMemo('k2')).toBe(false)
  })

  it('defaults the interval to the RefreshCadence context, and Manual disables the timer', async () => {
    vi.useFakeTimers()
    try {
      const timed = vi.fn().mockResolvedValue('x')
      renderHook(() => usePolled(timed, []), { wrapper: cadenceWrapper(60_000) })
      expect(timed).toHaveBeenCalledTimes(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      expect(timed).toHaveBeenCalledTimes(2) // context interval fired

      const manual = vi.fn().mockResolvedValue('x')
      renderHook(() => usePolled(manual, []), { wrapper: cadenceWrapper(null) })
      expect(manual).toHaveBeenCalledTimes(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(600_000) })
      expect(manual).toHaveBeenCalledTimes(1) // Manual context → no timer
    } finally {
      vi.useRealTimers()
    }
  })
})
