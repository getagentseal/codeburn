// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { Usd, sumTokens, tokensOf } from './Usd'

const TOKENS = { inputTokens: 1_200, outputTokens: 34_000, cacheReadTokens: 2_500_000, cacheWriteTokens: 900, calls: 42 }

describe('Usd', () => {
  it('renders the amount alone when there is no breakdown', () => {
    render(<Usd value={12.5} />)
    expect(screen.getByText('$12.50')).toBeInTheDocument()
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('shows the four token rows on hover and hides them on leave', async () => {
    const user = userEvent.setup()
    render(<Usd value={12.5} tokens={TOKENS} />)

    await user.hover(screen.getByText('$12.50'))
    const tip = screen.getByRole('tooltip')
    expect(tip).toHaveTextContent('Input1.2K')
    expect(tip).toHaveTextContent('Output34K')
    expect(tip).toHaveTextContent('Cache read2.5M')
    expect(tip).toHaveTextContent('Cache write900')
    expect(tip).toHaveTextContent('Calls42')

    await user.unhover(screen.getByText('$12.50'))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('omits the Calls row when the breakdown carries no call count', async () => {
    const user = userEvent.setup()
    const { calls: _calls, ...noCalls } = TOKENS
    render(<Usd value={12.5} tokens={noCalls} />)

    await user.hover(screen.getByText('$12.50'))
    const tip = screen.getByRole('tooltip')
    expect(tip).toHaveTextContent('Cache write900')
    expect(tip).not.toHaveTextContent('Calls')
  })

  it('opens on keyboard focus and closes on Escape', async () => {
    const user = userEvent.setup()
    render(<Usd value={12.5} tokens={TOKENS} />)

    await user.tab()
    expect(screen.getByText('$12.50')).toHaveFocus()
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('nested in an interactive row it is out of the tab order and hover-only', async () => {
    const user = userEvent.setup()
    render(<Usd value={12.5} tokens={TOKENS} nested />)
    const trigger = screen.getByText('$12.50')
    // Not its own tab stop, so it cannot swallow the row's Enter.
    expect(trigger).toHaveAttribute('tabindex', '-1')

    // Hover still reveals the breakdown.
    await user.hover(trigger)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    await user.unhover(trigger)
    expect(screen.queryByRole('tooltip')).toBeNull()

    // Tab lands elsewhere and focus never opens the popover.
    await user.tab()
    expect(trigger).not.toHaveFocus()
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})

describe('tokensOf / sumTokens', () => {
  it('reads a breakdown only when every count is present', () => {
    expect(tokensOf(TOKENS)).toEqual(TOKENS)
    expect(tokensOf({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 })).toBeNull()
    expect(tokensOf(undefined)).toBeNull()
  })

  it('sums rows, and averages them when given a divisor', () => {
    const rows = [TOKENS, TOKENS]
    expect(sumTokens(rows)).toEqual({ inputTokens: 2_400, outputTokens: 68_000, cacheReadTokens: 5_000_000, cacheWriteTokens: 1_800, calls: 84 })
    expect(sumTokens(rows, 2)).toEqual(TOKENS)
    expect(sumTokens([])).toBeNull()
    expect(sumTokens([TOKENS, { inputTokens: 1 }])).toBeNull()
  })

  it('leaves calls out when a row does not carry one, rather than adding a zero', () => {
    const noCalls = { inputTokens: 100, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 400 }
    expect(sumTokens([TOKENS, noCalls])).not.toHaveProperty('calls')
    expect(sumTokens([noCalls])).not.toHaveProperty('calls')
  })
})
