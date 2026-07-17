// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CompareJsonReport, ModelStats } from '../lib/types'
import { Compare } from './Compare'

const mocks = vi.hoisted(() => ({
  getCompareModels: vi.fn<(period: string, provider: string) => Promise<ModelStats[]>>(),
  getCompare: vi.fn<(period: string, provider: string, modelA: string, modelB: string) => Promise<CompareJsonReport>>(),
}))
vi.mock('../lib/ipc', async orig => {
  const actual = await orig<typeof import('../lib/ipc')>()
  return { ...actual, codeburn: mocks }
})

const modelA: ModelStats = {
  model: 'Opus 4.8', calls: 4812, cost: 331.2, outputTokens: 9_640_000, inputTokens: 152_600_000,
  cacheReadTokens: 119_400_000, cacheWriteTokens: 16_000_000, totalTurns: 1000, editTurns: 786,
  oneShotTurns: 558, retries: 267, selfCorrections: 33, editCost: 0.42,
  firstSeen: '2026-06-12T00:00:00.000Z', lastSeen: '2026-07-11T00:00:00.000Z',
}
const modelB: ModelStats = {
  model: 'Sonnet 5', calls: 3318, cost: 108.63, outputTokens: 6_080_000, inputTokens: 77_700_000,
  cacheReadTokens: 63_300_000, cacheWriteTokens: 7_000_000, totalTurns: 850, editTurns: 641,
  oneShotTurns: 404, retries: 300, selfCorrections: 40, editCost: 0.19,
  firstSeen: '2026-06-14T00:00:00.000Z', lastSeen: '2026-07-11T00:00:00.000Z',
}
const report: CompareJsonReport = {
  period: { label: 'Last 30 days', provider: 'all' },
  modelA,
  modelB,
  metrics: [
    { section: 'Performance', label: 'One-shot rate', valueA: 71, valueB: 63, formatFn: 'percent', winner: 'a' },
    { section: 'Efficiency', label: 'Cost / call', valueA: 0.069, valueB: 0.033, formatFn: 'cost', winner: 'b' },
  ],
  categories: [
    { category: 'Coding', turnsA: 400, editTurnsA: 312, oneShotRateA: 74, turnsB: 350, editTurnsB: 280, oneShotRateB: 66, winner: 'a' },
  ],
  workingStyle: [
    { label: 'Planning rate', valueA: 22, valueB: 9, formatFn: 'percent' },
  ],
}

describe('Compare', () => {
  beforeEach(() => {
    mocks.getCompareModels.mockReset()
    mocks.getCompare.mockReset()
  })

  it('defaults to the top two and renders formatted report panels and winners', async () => {
    const user = userEvent.setup()
    mocks.getCompareModels.mockResolvedValue([modelA, modelB])
    mocks.getCompare.mockResolvedValue(report)
    render(<Compare period="30days" provider="all" />)

    const first = await screen.findByLabelText('First model')
    const second = screen.getByLabelText('Second model')
    await waitFor(() => {
      expect(first).toHaveTextContent('Opus 4.8 · 4,812 calls')
      expect(second).toHaveTextContent('Sonnet 5 · 3,318 calls')
    })

    expect(await screen.findByText('Performance')).toBeInTheDocument()
    expect(mocks.getCompare).toHaveBeenCalledWith('30days', 'all', 'Opus 4.8', 'Sonnet 5')
    expect(screen.getByText('Efficiency')).toBeInTheDocument()
    expect(screen.getByText('Context')).toBeInTheDocument()
    expect(screen.getByText('71%')).toHaveClass('cmp-best')
    expect(screen.getByText('$0.03')).toHaveClass('cmp-best')
    expect(screen.getByText('$331.20')).toBeInTheDocument()
    expect(screen.getByText('152.6M')).toBeInTheDocument()
    expect(screen.getByText('9.6M')).toBeInTheDocument()

    const context = screen.getByText('Context').closest<HTMLElement>('.cmp-card')!
    expect(within(context).getByText('Cache hit rate')).toBeInTheDocument()
    expect(within(context).getByText('Days of data')).toBeInTheDocument()

    await user.click(second)
    await user.click(screen.getByRole('option', { name: 'Opus 4.8 · 4,812 calls' }))
    await waitFor(() => expect(first).toHaveTextContent('Sonnet 5 · 3,318 calls'))
    expect(mocks.getCompare).toHaveBeenCalledWith('30days', 'all', 'Sonnet 5', 'Opus 4.8')
  })

  it('computes cache hit rate over input + cache reads (excludes cache writes)', async () => {
    mocks.getCompareModels.mockResolvedValue([modelA, modelB])
    mocks.getCompare.mockResolvedValue(report)
    render(<Compare period="30days" provider="all" />)

    const context = (await screen.findByText('Context')).closest<HTMLElement>('.cmp-card')!
    const row = within(context).getByText('Cache hit rate').closest('.cmp-metric')!
    // 119.4M / (152.6M + 119.4M) = 44%, not 119.4 / (152.6 + 119.4 + 16) = 41%.
    expect(row).toHaveTextContent('44%')
    expect(row).not.toHaveTextContent('41%')
  })

  it('notes that custom ranges are unsupported and still compares by period', async () => {
    mocks.getCompareModels.mockResolvedValue([modelA, modelB])
    mocks.getCompare.mockResolvedValue(report)
    render(<Compare period="30days" provider="all" range={{ from: '2026-07-01', to: '2026-07-11' }} />)

    expect(await screen.findByText('Compare uses the selected period, custom dates are not supported yet.')).toBeInTheDocument()
    expect(mocks.getCompareModels).toHaveBeenCalledWith('30days', 'all')
  })

  it('renders the need-two-models note without requesting a report', async () => {
    mocks.getCompareModels.mockResolvedValue([modelA])
    render(<Compare period="week" provider="all" />)

    expect(await screen.findByText('Need at least two models with usage in this range to compare.')).toBeInTheDocument()
    expect(mocks.getCompare).not.toHaveBeenCalled()
  })
})
