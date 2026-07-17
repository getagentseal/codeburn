// @vitest-environment jsdom
import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The splash captures `codeburn` at import; mock it so a test can drive the
// progress callback the splash subscribes with.
let progressCb: ((event: unknown) => void) | undefined
vi.mock('../lib/ipc', () => ({
  codeburn: { onProgress: (cb: (event: unknown) => void) => { progressCb = cb; return () => { progressCb = undefined } } },
  normalizeCliError: (err: unknown) => err,
}))

import { Splash } from './Splash'
import { mockMatchMedia as mockReducedMotion } from '../lib/testMatchMedia'

function splashEl(): HTMLElement | null {
  return document.querySelector('.splash')
}


afterEach(() => {
  vi.useRealTimers()
  Reflect.deleteProperty(window, 'matchMedia')
})

describe('Splash', () => {
  it('stays up while the first overview fetch has neither data nor error', () => {
    render(<Splash hasData={false} hasError={false} />)
    const el = splashEl()
    expect(el).toBeInTheDocument()
    // Static under vitest / the closed motion gate: no ignite/pulse class,
    // the static mark instead of the loader video.
    expect(el).not.toHaveClass('splash-lit')
    expect(el?.querySelector('video')).toBeNull()
    expect(el?.querySelector('.flamemark')).not.toBeNull()
  })

  it('holds the min on-screen time, then crossfades away once data lands', () => {
    vi.useFakeTimers()
    const { rerender } = render(<Splash hasData={false} hasError={false} />)
    expect(splashEl()).toBeInTheDocument()

    // First data lands immediately (warm cache): the floor must keep it up.
    rerender(<Splash hasData hasError={false} />)
    act(() => { vi.advanceTimersByTime(599) })
    expect(splashEl()).toBeInTheDocument()
    expect(splashEl()).not.toHaveClass('splash-out')

    // Floor reached: begin the crossfade (still on screen during it).
    act(() => { vi.advanceTimersByTime(1) })
    expect(splashEl()).toHaveClass('splash-out')

    // Crossfade complete: gone.
    act(() => { vi.advanceTimersByTime(250) })
    expect(splashEl()).not.toBeInTheDocument()
  })

  it('yields immediately when the first fetch errors, with no min-time', () => {
    vi.useFakeTimers()
    const { rerender } = render(<Splash hasData={false} hasError={false} />)
    expect(splashEl()).toBeInTheDocument()

    rerender(<Splash hasData={false} hasError />)
    expect(splashEl()).not.toBeInTheDocument()
  })

  it('never reappears on a later loading state after it has dismissed', () => {
    vi.useFakeTimers()
    const { rerender } = render(<Splash hasData={false} hasError={false} />)
    rerender(<Splash hasData hasError={false} />)
    act(() => { vi.advanceTimersByTime(600) })
    act(() => { vi.advanceTimersByTime(250) })
    expect(splashEl()).not.toBeInTheDocument()

    // A filter change re-enters loading and can clear last-good data; the splash
    // must not come back.
    rerender(<Splash hasData={false} hasError={false} />)
    expect(splashEl()).not.toBeInTheDocument()
    rerender(<Splash hasData hasError={false} />)
    expect(splashEl()).not.toBeInTheDocument()
  })

  it('reveals the compact indexing status on real cold-scan progress', () => {
    render(<Splash hasData={false} hasError={false} />)
    expect(splashEl()).toBeInTheDocument()
    // No detail before any progress arrives.
    expect(document.querySelector('.splash-status')).toBeNull()

    act(() => {
      // The leading `providers` event carries cold:true only on a genuine full
      // hydration — that, and only that, reveals the indexing detail.
      progressCb?.({ kind: 'providers', cold: true, providers: ['claude', 'codex'] })
      progressCb?.({ kind: 'provider', provider: 'claude', state: 'start' })
      progressCb?.({ kind: 'tick', provider: 'claude', done: 120, total: 480 })
    })

    const status = document.querySelector('.splash-status')
    expect(status).toBeInTheDocument()
    // One compact line: active provider + live counter. No per-provider text rows.
    expect(status?.querySelector('.splash-status-line')?.textContent).toBe('Indexing Claude · 120/480')
    expect(status?.textContent).toContain('One-time scan')
    // Both detected providers render as small logos in the strip; claude active.
    expect(document.querySelectorAll('.splash-prov').length).toBe(2)
    expect(document.querySelector('.splash-prov.active')?.getAttribute('title')).toBe('Claude')

    act(() => { progressCb?.({ kind: 'provider', provider: 'claude', state: 'done' }) })
    expect(document.querySelector('.splash-prov.done')?.getAttribute('title')).toBe('Claude')
    // No active provider left: the line falls back to the generic copy.
    expect(document.querySelector('.splash-status-line')?.textContent).toBe('Indexing your usage history…')
  })

  it('never reveals the indexing status on a warm launch (providers/ticks without cold)', () => {
    render(<Splash hasData={false} hasError={false} />)
    expect(splashEl()).toBeInTheDocument()

    act(() => {
      // A warm launch's incremental re-parse streams the same providers/provider/
      // tick events, but the providers event has NO cold flag. The strip must stay
      // hidden — this is the "indexing on every launch" bug fix.
      progressCb?.({ kind: 'providers', cold: false, providers: ['claude', 'codex'] })
      progressCb?.({ kind: 'provider', provider: 'claude', state: 'start' })
      progressCb?.({ kind: 'tick', provider: 'claude', done: 40, total: 60 })
      progressCb?.({ kind: 'provider', provider: 'claude', state: 'done' })
    })

    expect(document.querySelector('.splash-status')).toBeNull()
  })

  it('swaps instantly under reduced motion (no fade, no min-time)', () => {
    mockReducedMotion(true)
    const { rerender } = render(<Splash hasData={false} hasError={false} />)
    const el = splashEl()
    expect(el).toBeInTheDocument()
    expect(el).not.toHaveClass('splash-lit')

    // No timers advanced: data lands and the overlay is gone at once.
    rerender(<Splash hasData hasError={false} />)
    expect(splashEl()).not.toBeInTheDocument()
  })
})
