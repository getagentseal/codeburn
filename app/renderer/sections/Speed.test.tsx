// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ArrivalChart, Speed } from './Speed'
import type { SpeedReport, SpeedRow, SpeedSample } from '../lib/speed'

const bridge = vi.hoisted(() => ({ getSpeed: vi.fn(), getSpeedEvents: vi.fn(), openExternal: vi.fn() }))
vi.mock('../lib/ipc', async original => ({ ...await original<typeof import('../lib/ipc')>(), codeburn: bridge }))

const row: SpeedRow = {
  harness: 'dsh', model: 'deepseek-flash', source: 'proxy', resolution: 'chunk', estimated: false,
  latestSampleId: 'deepseek-live', latestStartedAt: '2026-10-01T20:00:00.000Z',
  generationRateEstimated: true, generationRequests: 1, requests: 2, timedRequests: 1, incompleteRequests: 1, outputTokens: 6,
  effectiveTokensPerSecond: 6.7, generationTokensPerSecondP50: 33.8, firstEmissionMsP50: 741.9, durationMsP95: 895,
}
const sample: SpeedSample = {
  id: row.latestSampleId!, harness: 'dsh', model: row.model, source: 'proxy', resolution: 'chunk',
  startedAt: row.latestStartedAt, durationMs: 895, firstEmissionMs: 741.9, outputTokens: 6, status: 'complete',
  events: [{ elapsedMs: 741.9 }, { elapsedMs: 890 }],
}
const report: SpeedReport = {
  rows: [row], unavailableHarnesses: ['hermes'], rejectedRecords: 0, omittedRecords: 0,
  warnings: [], generatedAt: '2026-10-01T20:00:01Z', historyLimit: 10,
}

describe('Speed', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    bridge.getSpeed.mockResolvedValue(report)
    bridge.getSpeedEvents.mockResolvedValue(sample)
  })

  it('shows real model/harness attribution and inspects chunks without claiming per-token timing', async () => {
    render(<Speed period="week" provider="dsh" range={{ from: '2026-10-01', to: '2026-10-01' }} />)
    expect(await screen.findByText('DeepSeek Harness')).toBeInTheDocument()
    expect(bridge.getSpeed).toHaveBeenCalledWith('week', 'dsh', { from: '2026-10-01', to: '2026-10-01' })
    expect(screen.queryByText('6.7')).toBeNull()
    expect(screen.getByText('~33.8')).toHaveClass('speed-rate')
    expect(screen.getByText('741.9')).toBeInTheDocument()
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
    expect(screen.getByText(/This device · all projects and accounts/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Timeline: DeepSeek Harness/ }))
    expect(await screen.findByRole('img', { name: 'Arrival order over elapsed time' })).toBeInTheDocument()
    expect(bridge.getSpeedEvents).toHaveBeenCalledWith('deepseek-live', 'dsh')
    expect(screen.getByText('Recorded arrivals').nextElementSibling).toHaveTextContent('2')
    expect(screen.getByText('Reported output tokens').nextElementSibling).toHaveTextContent('6')
    expect(screen.getByText(/not individual tokens. Token contents/)).toBeInTheDocument()
  })

  it('keeps source estimates separate and leaves incomplete rates unavailable', async () => {
    bridge.getSpeed.mockResolvedValue({ ...report, rows: [row,
      { ...row, source: 'native', resolution: 'token', generationTokensPerSecondP50: null, generationRequests: 0, timedRequests: 0, latestSampleId: 'failed' },
      { ...row, harness: 'codex', source: 'codex-checkpoint', resolution: 'turn', estimated: true, generationTokensPerSecondP50: null, generationRequests: 0, latestSampleId: null },
    ] })
    render(<Speed period="week" provider="all" />)
    const table = await screen.findByRole('table')
    expect(within(table).getAllByRole('row')).toHaveLength(4)
    expect(within(table).queryByText('~6.7')).toBeNull()
    for (const count of within(table).getAllByText('0 / 2')) expect(count.closest('tr')!.children[2]).toHaveTextContent('—')
    expect(within(table).getAllByRole('button')).toHaveLength(2)
  })

  it('clears the selected timeline on a harness change, including a late event response', async () => {
    let resolve!: (sample: SpeedSample) => void
    bridge.getSpeedEvents.mockReturnValue(new Promise<SpeedSample>(done => { resolve = done }))
    const { rerender } = render(<Speed period="week" provider="dsh" />)
    fireEvent.click(await screen.findByRole('button', { name: /Timeline:/ }))
    bridge.getSpeed.mockResolvedValue({ ...report, rows: [] })
    rerender(<Speed period="today" provider="hermes" />)
    resolve(sample)
    expect(await screen.findByText(/No timing samples in this window/)).toBeInTheDocument()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('shows a capture path for unsupported harnesses without calling an invalid CLI filter', () => {
    render(<Speed period="today" provider="cursor" />)
    expect(screen.getByText(/Speed capture is available/)).toBeInTheDocument()
    expect(bridge.getSpeed).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Capture setup' }))
    expect(bridge.openExternal).toHaveBeenCalledWith(expect.stringContaining('/docs/speed.md'))
  })

  it('discloses invalid/omitted records and fetch errors instead of reporting zero speed', async () => {
    bridge.getSpeed.mockResolvedValue({ ...report, rejectedRecords: 2, omittedRecords: 3 })
    const { unmount } = render(<Speed period="week" provider="all" />)
    expect(await screen.findByText(/Excluded invalid records: 2/)).toBeInTheDocument()
    unmount()
    bridge.getSpeed.mockRejectedValue(new Error('Speed unavailable'))
    render(<Speed period="today" provider="claude" />)
    expect(await screen.findByText(/Speed unavailable/)).toBeInTheDocument()
    expect(screen.queryByText('0.0')).toBeNull()
  })

  it('bounds a large native timeline while retaining endpoints and disclosing its displayed count', () => {
    const events = Array.from({ length: 10_000 }, (_, index) => ({ elapsedMs: index, tokens: 1 as const }))
    const { container } = render(<ArrivalChart sample={{ ...sample, source: 'native', resolution: 'token', durationMs: 10_000, events }} />)
    expect(container.querySelectorAll('circle')).toHaveLength(200)
    expect(container.querySelector('circle:last-of-type title')).toHaveTextContent('10000: 9,999 ms')
    expect(screen.getByText(/Showing 200 of 10000 recorded arrivals/)).toBeInTheDocument()
  })
})
