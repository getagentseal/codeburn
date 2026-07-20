// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DailyHistoryEntry } from '../lib/types'
import { ActivityHeatmap } from './ActivityHeatmap'

function entry(date: string, cost: number, calls: number): DailyHistoryEntry {
  return { date, cost, savingsUSD: 0, calls, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, topModels: [] }
}

// A fixed "now" so the 26-week window and the day-under-test are deterministic.
beforeEach(() => vi.setSystemTime(new Date(2026, 6, 20, 12, 0, 0)))
afterEach(() => vi.useRealTimers())

describe('ActivityHeatmap no-data days (before recorded history)', () => {
  // History begins 2026-07-10; earlier days predate any recorded data.
  const daily = [entry('2026-07-10', 4, 20), entry('2026-07-15', 6, 30)]

  it('marks days before the first recorded day as no data, not a currency zero', () => {
    const { container } = render(<ActivityHeatmap daily={daily} />)
    const preData = container.querySelector('[data-date="2026-07-05"]')!
    expect(preData).toHaveClass('nodata')
    expect(preData).toHaveAttribute('data-active', 'false')
    expect(preData.getAttribute('aria-label')).toContain('no data recorded')
    expect(preData.getAttribute('aria-label')).not.toContain('$0.00')
  })

  it('keeps a genuinely idle day within recorded history as a real zero', () => {
    const { container } = render(<ActivityHeatmap daily={daily} />)
    const idle = container.querySelector('[data-date="2026-07-12"]')!
    expect(idle).not.toHaveClass('nodata')
    expect(idle.getAttribute('aria-label')).toContain('$0.00, 0 calls')
  })

  it('shows "No data recorded" on hover for a pre-history day', () => {
    const { container } = render(<ActivityHeatmap daily={daily} />)
    fireEvent.mouseEnter(container.querySelector('[data-date="2026-07-05"]')!)
    const tip = document.querySelector('.chart-tip')!
    expect(tip.textContent).toContain('No data recorded')
    expect(tip.textContent).not.toContain('$0.00')
  })

  it('shows the currency value on hover for an idle day within history', () => {
    const { container } = render(<ActivityHeatmap daily={daily} />)
    fireEvent.mouseEnter(container.querySelector('[data-date="2026-07-12"]')!)
    const tip = document.querySelector('.chart-tip')!
    expect(tip.textContent).toContain('$0.00')
  })
})
