// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

import { RefreshCadenceContext, type RefreshCadence } from '../lib/refreshCadence'
import { desktopProjectScopeKey } from '../lib/projectScope'
import { clearPolledMemo, isCompleteReport, usePolled } from './usePolled'

function wrapper(intervalMs: number | null) {
  const value: RefreshCadence = { value: 'x', intervalMs, setValue: () => {} }
  return ({ children }: { children: ReactNode }) => createElement(RefreshCadenceContext.Provider, { value }, children)
}

// The shapes the producer actually sends: 125 cost-bearing days once indexing
// has converged, ~27 while the resident child is still re-deriving after the
// local-day rollover.
type Report = { current: { cost: number; calls: number }; history: { daily: Array<{ cost: number }> }; hydration?: { complete: boolean; indexedFiles: number; totalFiles: number }; stale?: boolean }

const complete: Report = { current: { cost: 20993.02, calls: 163600 }, history: { daily: new Array(125).fill({ cost: 1 }) } }
const partial: Report = { current: { cost: 4102.11, calls: 41003 }, history: { daily: new Array(27).fill({ cost: 1 }) }, hydration: { complete: false, indexedFiles: 900, totalFiles: 5400 } }
const staleRead: Report = { current: { cost: 1, calls: 1 }, history: { daily: [] }, stale: true }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('isCompleteReport', () => {
  it('separates a finished answer from a first paint and a stale read', () => {
    expect(isCompleteReport(complete)).toBe(true)
    expect(isCompleteReport(partial)).toBe(false)
    expect(isCompleteReport(staleRead)).toBe(false)
    expect(isCompleteReport({ hydration: { complete: true } })).toBe(true)
    expect(isCompleteReport(undefined)).toBe(true)
  })
})

describe('usePolled partial-hydration guard', () => {
  it('keeps the complete numbers when the next poll is partial, and says indexing', async () => {
    const fetcher = vi.fn<() => Promise<Report>>()
      .mockResolvedValueOnce(complete)
      .mockResolvedValueOnce(partial)
      .mockResolvedValueOnce(complete)
    const { result } = renderHook(() => usePolled(fetcher, [], { intervalMs: null, memoKey: 'overview|rollover' }), { wrapper: wrapper(null) })

    await act(async () => {})
    expect(result.current.data).toEqual(complete)
    expect(result.current.degraded).toBeNull()

    await act(async () => { result.current.refresh() })
    // The partial never reaches the screen; it is offered for the banner only.
    expect(result.current.data).toEqual(complete)
    expect(result.current.data!.history.daily).toHaveLength(125)
    expect(result.current.degraded).toEqual(partial)
    expect(result.current.switching).toBe(true)

    await act(async () => { result.current.refresh() })
    expect(result.current.data).toEqual(complete)
    expect(result.current.degraded).toBeNull()
    expect(result.current.switching).toBe(false)
  })

  it('adopts a partial when there is nothing complete to keep', async () => {
    const fetcher = vi.fn().mockResolvedValue(partial)
    const { result } = renderHook(() => usePolled(fetcher, [], { intervalMs: null, memoKey: 'overview|cold' }), { wrapper: wrapper(null) })
    await act(async () => {})
    expect(result.current.data).toEqual(partial)
    expect(result.current.degraded).toBeNull()
  })

  it('does not let a partial displace a complete report in the switch memo', async () => {
    const first = renderHook(() => usePolled(vi.fn().mockResolvedValue(complete), [], { intervalMs: null, memoKey: 'overview|memo' }), { wrapper: wrapper(null) })
    await act(async () => {})
    first.unmount()

    const second = renderHook(() => usePolled(vi.fn().mockResolvedValue(partial), [], { intervalMs: null, memoKey: 'overview|memo' }), { wrapper: wrapper(null) })
    await act(async () => {})
    expect(second.result.current.data).toEqual(complete)

    // A later switch back paints the complete report, never the partial.
    second.unmount()
    const third = renderHook(() => usePolled(vi.fn(() => new Promise<Report>(() => {})), [], { intervalMs: null, memoKey: 'overview|memo' }), { wrapper: wrapper(null) })
    expect(third.result.current.data).toEqual(complete)
  })

  it('does not paint an All-project memo under a selected project scope', async () => {
    const allKey = `overview|${desktopProjectScopeKey(null)}`
    const projectKey = `overview|${desktopProjectScopeKey('path:/work/alpha')}`
    const first = renderHook(() => usePolled(vi.fn().mockResolvedValue(complete), [], { intervalMs: null, memoKey: allKey }), { wrapper: wrapper(null) })
    await act(async () => {})
    first.unmount()

    const second = renderHook(() => usePolled(vi.fn(() => new Promise<Report>(() => {})), [], { intervalMs: null, memoKey: projectKey }), { wrapper: wrapper(null) })
    expect(second.result.current.data).toBeNull()
  })

  it('keeps the same-scope last-good response visible while a refresh is pending', async () => {
    const pending = deferred<Report>()
    const fetcher = vi.fn<() => Promise<Report>>()
      .mockResolvedValueOnce(complete)
      .mockReturnValueOnce(pending.promise)
    const { result } = renderHook(() => usePolled(fetcher, [], { intervalMs: null, memoKey: 'overview|all|filter:one' }), { wrapper: wrapper(null) })

    await act(async () => {})
    expect(result.current.data).toEqual(complete)

    act(() => { result.current.refresh() })
    expect(result.current.data).toEqual(complete)
    expect(result.current.loading).toBe(true)

    await act(async () => {
      pending.resolve(complete)
      await pending.promise
    })
    expect(result.current.data).toEqual(complete)
    expect(result.current.loading).toBe(false)
  })

  it('does not publish a rejected response after its filter revision was invalidated', async () => {
    const pending = deferred<Report>()
    const fetcher = vi.fn<() => Promise<Report>>().mockReturnValue(pending.promise)
    const { result } = renderHook(() => usePolled(fetcher, [], { intervalMs: null, memoKey: 'sessions|project:alpha|filter:one' }), { wrapper: wrapper(null) })

    expect(result.current.loading).toBe(true)
    clearPolledMemo()
    await act(async () => {
      pending.reject(new Error('stale filter response'))
      await expect(pending.promise).rejects.toThrow('stale filter response')
    })

    expect(result.current.error).toBeNull()
  })

  it.each([
    ['overview', 'overview|week|all||||project:alpha|filter:one'],
    ['sessions', 'sessions|week|all|||project:alpha|filter:one'],
    ['period compare drill-down', 'periodcomparesessions-v2|week|all|||project:alpha|filter:one'],
  ])('keeps the newest %s response when an older scoped request resolves last', async (_name, key) => {
    const older = deferred<Report>()
    const newer = deferred<Report>()
    const alpha: Report = { ...complete, current: { cost: 11, calls: 11 } }
    const beta: Report = { ...complete, current: { cost: 22, calls: 22 } }
    const queue = [older.promise, newer.promise]
    const fetcher = vi.fn<() => Promise<Report>>(() => queue.shift()!)
    const { result, rerender } = renderHook(
      ({ requestKey }) => usePolled(fetcher, [requestKey], { intervalMs: null, memoKey: requestKey }),
      { initialProps: { requestKey: key.replace('alpha', 'alpha') }, wrapper: wrapper(null) },
    )

    rerender({ requestKey: key.replace('alpha', 'beta') })
    await act(async () => {
      newer.resolve(beta)
      await newer.promise
    })
    expect(result.current.data).toEqual(beta)

    await act(async () => {
      older.resolve(alpha)
      await older.promise
    })
    expect(result.current.data).toEqual(beta)
  })
})
