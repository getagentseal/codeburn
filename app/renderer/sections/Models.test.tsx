// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ModelReportRow } from '../lib/types'
import { Models } from './Models'

const { getModels } = vi.hoisted(() => ({
  getModels: vi.fn<(period: string, provider: string, byTask: boolean) => Promise<ModelReportRow[]>>(),
}))
vi.mock('../lib/ipc', async orig => {
  const actual = await orig<typeof import('../lib/ipc')>()
  return { ...actual, codeburn: { getModels } }
})

const rows: ModelReportRow[] = [
  {
    provider: 'anthropic',
    providerDisplayName: 'Anthropic',
    model: 'claude-opus-4.8',
    modelDisplayName: 'Claude Opus 4.8',
    category: null,
    topCategory: 'coding',
    topCategoryShare: 0.71,
    inputTokens: 152_600_000,
    outputTokens: 9_640_000,
    cacheWriteTokens: 16_000_000,
    cacheReadTokens: 119_400_000,
    totalTokens: 297_640_000,
    calls: 4812,
    costUSD: 331.2,
    savingsUSD: 86.4,
    savingsBaselineModel: 'Claude Opus 4.8',
    credits: null,
  },
  {
    provider: 'codex',
    providerDisplayName: 'Codex',
    model: 'gpt-5.5-codex',
    modelDisplayName: 'GPT-5.5 Codex',
    category: null,
    topCategory: 'debugging',
    topCategoryShare: 0.42,
    inputTokens: 86_900_000,
    outputTokens: 7_520_000,
    cacheWriteTokens: 3_200_000,
    cacheReadTokens: 45_100_000,
    totalTokens: 142_720_000,
    calls: 2704,
    costUSD: 137.9,
    savingsUSD: 35.1,
    savingsBaselineModel: 'GPT-5.5 Codex',
    credits: 173,
  },
  {
    provider: 'local',
    providerDisplayName: 'Local',
    model: 'llama-local',
    modelDisplayName: 'Llama Local',
    category: null,
    inputTokens: 750_000,
    outputTokens: 400_000,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 1_150_000,
    calls: 82,
    costUSD: 0,
    savingsUSD: 12.34,
    savingsBaselineModel: 'Claude Opus 4.8',
    credits: null,
  },
  {
    provider: 'custom',
    providerDisplayName: 'Custom',
    model: 'my-proxy-model',
    modelDisplayName: 'my-proxy-model',
    category: null,
    inputTokens: 4_800_000,
    outputTokens: 400_000,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 5_200_000,
    calls: 176,
    costUSD: 0,
    savingsUSD: 0,
    savingsBaselineModel: '',
    credits: null,
  },
]

const byTaskRows: ModelReportRow[] = [
  {
    ...rows[0],
    category: 'coding',
    calls: 3400,
    inputTokens: 100_000_000,
    outputTokens: 6_100_000,
    cacheReadTokens: 88_000_000,
    totalTokens: 210_100_000,
    costUSD: 244.12,
    savingsUSD: 61.22,
  },
  {
    ...rows[0],
    category: 'delegation',
    calls: 120,
    inputTokens: 8_000_000,
    outputTokens: 500_000,
    cacheReadTokens: 6_000_000,
    totalTokens: 14_500_000,
    costUSD: 20.88,
    savingsUSD: 5.18,
  },
]

describe('Models', () => {
  beforeEach(() => {
    getModels.mockReset()
  })

  it('renders priced model rows with series dots, costs, and savings', async () => {
    getModels.mockResolvedValue(rows)

    const { container } = render(<Models period="30days" provider="all" />)

    expect(await screen.findByText('Claude Opus 4.8')).toBeInTheDocument()
    expect(screen.getByText('4,812')).toBeInTheDocument()
    expect(screen.getByText('152.6M')).toBeInTheDocument()
    expect(screen.getByText('9.6M')).toBeInTheDocument()
    expect(screen.getByText('119.4M')).toBeInTheDocument()
    expect(screen.getByText('$331.20')).toBeInTheDocument()
    expect(screen.getByText('$86.40')).toHaveClass('pos')
    expect(screen.getByText('GPT-5.5 Codex')).toBeInTheDocument()
    expect(screen.getByText('$137.90')).toBeInTheDocument()
    expect(screen.getByText('$35.10')).toHaveClass('pos')

    const dots = [...container.querySelectorAll('.mdot')]
    expect(dots[0]).toHaveAttribute('style', expect.stringContaining('var(--s-opus)'))
    expect(dots[1]).toHaveAttribute('style', expect.stringContaining('var(--s-gpt)'))
  })

  it('renders codex rows with credits and real cost as priced', async () => {
    getModels.mockResolvedValue([rows[1]])

    render(<Models period="30days" provider="all" />)

    expect(await screen.findByText('GPT-5.5 Codex')).not.toHaveClass('dim')
    expect(screen.getByText('$137.90')).not.toHaveClass('dim')
    expect(screen.getByText('$35.10')).toHaveClass('pos')
    expect(screen.queryByText('add alias ›')).not.toBeInTheDocument()
  })

  it('renders local saved-only rows as priced with real savings', async () => {
    getModels.mockResolvedValue([rows[2]])

    render(<Models period="30days" provider="all" />)

    expect(await screen.findByText('Llama Local')).not.toHaveClass('dim')
    expect(screen.getByText('750K')).toBeInTheDocument()
    expect(screen.getByText('400K')).toBeInTheDocument()
    expect(screen.getByText('$0.00')).not.toHaveClass('dim')
    expect(screen.getByText('$12.34')).toHaveClass('pos')
    expect(screen.queryByText('add alias ›')).not.toBeInTheDocument()
  })

  it('renders unpriced proxy rows as dim with alias affordance and dashes', async () => {
    getModels.mockResolvedValue([rows[3]])

    render(<Models period="30days" provider="all" />)

    expect(await screen.findByText('my-proxy-model')).toHaveClass('dim')
    expect(screen.getByText('add alias ›')).toHaveClass('alias')
    expect(screen.getAllByText('—')).toHaveLength(5)
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument()
  })

  it('refetches with byTask=true and renders the task category', async () => {
    getModels.mockResolvedValueOnce(rows).mockResolvedValueOnce(byTaskRows)

    render(<Models period="week" provider="anthropic" />)

    expect(await screen.findByText('Claude Opus 4.8')).toBeInTheDocument()
    expect(getModels).toHaveBeenCalledWith('week', 'anthropic', false)

    fireEvent.click(screen.getByRole('tab', { name: 'By task' }))

    await waitFor(() => expect(getModels).toHaveBeenCalledWith('week', 'anthropic', true))
    expect(await screen.findByText('coding')).toBeInTheDocument()
    expect(screen.getByText('delegation')).toBeInTheDocument()
    expect(screen.getByText('3,520')).toBeInTheDocument()
    expect(screen.getByText('$265.00')).toBeInTheDocument()
    expect(screen.getByText('$66.40')).toBeInTheDocument()
    expect(screen.getByText('$244.12')).toBeInTheDocument()
    expect(screen.getAllByText('Claude Opus 4.8')).toHaveLength(1)
    expect(document.querySelectorAll('.model-task-group')).toHaveLength(1)
    expect(document.querySelectorAll('.model-task-row')).toHaveLength(2)
  })
})
