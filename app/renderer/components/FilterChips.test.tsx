// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_FILTERS, type InvestigationFilters } from '../lib/investigation'
import { FilterChips } from './FilterChips'

// Two sessions of the same provider whose ids agree on the first 12 characters
// (a real shape: one CLI's ids share a long prefix), so the chip LABEL — which
// truncates at 12 — is identical for both.
const COLLIDING: InvestigationFilters = {
  ...EMPTY_FILTERS,
  sessions: [
    { provider: 'claude', sessionId: 'session-abcd-1111' },
    { provider: 'claude', sessionId: 'session-abcd-2222' },
  ],
  branches: [
    { project: '/work/app', branch: 'main' },
    { project: '/personal/app', branch: 'main' },
  ],
}

afterEach(() => { vi.restoreAllMocks() })

describe('FilterChips', () => {
  it('renders one chip per selected value even when two values share a display label', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onChange = vi.fn()
    render(<FilterChips filters={COLLIDING} onChange={onChange} />)

    const bar = screen.getByRole('group', { name: /active investigation filters/i })
    expect(within(bar).getAllByRole('button', { name: /remove session filter/i })).toHaveLength(2)
    expect(within(bar).getAllByRole('button', { name: /remove branch filter/i })).toHaveLength(2)
    // Chips keyed by the truncated label collide, which React reports as two
    // children with the same key — and then reconciles the wrong one.
    const keyWarnings = warn.mock.calls.filter(([first]) => String(first).includes('same key'))
    expect(keyWarnings).toEqual([])

    // Removing the second of two identically-labeled chips removes exactly it.
    await userEvent.click(within(bar).getAllByRole('button', { name: /remove session filter/i })[1]!)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      sessions: [{ provider: 'claude', sessionId: 'session-abcd-1111' }],
    }))
  })

  it('renders nothing without a selection', () => {
    const { container } = render(<FilterChips filters={EMPTY_FILTERS} onChange={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })
})
