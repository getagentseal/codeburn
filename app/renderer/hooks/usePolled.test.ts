// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

import { RefreshCadenceContext, type RefreshCadence } from '../lib/refreshCadence'
import { usePolled } from './usePolled'

function cadenceWrapper(intervalMs: number | null) {
  const value: RefreshCadence = { value: 'x', intervalMs, setValue: () => {} }
  return ({ children }: { children: ReactNode }) => createElement(RefreshCadenceContext.Provider, { value }, children)
}

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
    const resolvers: Array<(v: string) => void> = []
    const fetcher = vi.fn(() => new Promise<string>(resolve => { resolvers.push(resolve) }))

    // Mount on key kA, resolve to A0 → memoized under kA.
    const { result, rerender } = renderHook(
      ({ k }: { k: string }) => usePolled(fetcher, [k], { memoKey: k }),
      { initialProps: { k: 'kA' } },
    )
    await act(async () => { resolvers[0]!('A0') })
    expect(result.current.data).toBe('A0')
    expect(result.current.switching).toBe(false)

    // Switch to a fresh key kB, resolve to B0 → memoized under kB.
    rerender({ k: 'kB' })
    await act(async () => { resolvers[1]!('B0') })
    expect(result.current.data).toBe('B0')

    // Switch BACK to kA: the memoized A0 paints in the same commit (no blank, no
    // B0 freeze) and `switching` is true while the fresh fetch runs behind it.
    rerender({ k: 'kA' })
    expect(result.current.data).toBe('A0')
    expect(result.current.switching).toBe(true)
    expect(result.current.loading).toBe(true)

    // The fresh fetch resolves → new data, switching clears.
    await act(async () => { resolvers[2]!('A1') })
    expect(result.current.data).toBe('A1')
    expect(result.current.switching).toBe(false)
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
