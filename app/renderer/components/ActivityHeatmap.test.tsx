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

describe('ActivityHeatmap active-days caption', () => {
  // Four active days across the 26-week window; only the last falls inside the
  // 12 weeks a narrow slot can draw.
  const daily = [entry('2026-02-10', 5, 25), entry('2026-03-15', 7, 35), entry('2026-05-01', 3, 15), entry('2026-07-15', 6, 30)]

  function renderAtSlotWidth(width: number) {
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width)
    const view = render(<ActivityHeatmap daily={daily} />)
    clientWidth.mockRestore()
    return view
  }

  it('counts the whole data window, not the week columns that happen to fit', () => {
    const counts = new Set<string>()
    const weekColumns = new Set<number>()
    for (const width of [166, 246, 574]) {
      const { container, unmount } = renderAtSlotWidth(width)
      counts.add(container.querySelector('.ov-active-days')!.textContent!)
      weekColumns.add(container.querySelectorAll('.ov-heat-cell').length / 7)
      unmount()
    }
    expect(weekColumns.size).toBeGreaterThan(1)
    expect([...counts]).toEqual(['4 active days'])
  })
})
