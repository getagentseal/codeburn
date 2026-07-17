// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ToastHost } from './ToastHost'
import { dismissToast, showToast } from '../lib/toast'

afterEach(() => {
  dismissToast()
  vi.useRealTimers()
})

describe('ToastHost', () => {
  it('shows an action toast and auto-dismisses it after 3s', () => {
    vi.useFakeTimers()
    render(<ToastHost />)

    act(() => { showToast('Exported to /tmp/out') })
    expect(screen.getByRole('status')).toHaveTextContent('Exported to /tmp/out')

    act(() => { vi.advanceTimersByTime(2999) })
    expect(screen.getByRole('status')).toBeInTheDocument()

    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('keeps only the most recent toast (one at a time)', () => {
    vi.useFakeTimers()
    render(<ToastHost />)

    act(() => { showToast('First') })
    act(() => { showToast('Second', 'error') })

    const toasts = screen.getAllByRole('status')
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toHaveTextContent('Second')
    expect(toasts[0]).toHaveClass('toast-error')
  })
})
