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
  trend: [], typical: null,
}
const sample: SpeedSample = {
  id: row.latestSampleId!, harness: 'dsh', model: row.model, source: 'proxy', resolution: 'chunk',
  startedAt: row.latestStartedAt, durationMs: 895, firstEmissionMs: 741.9, outputTokens: 6, status: 'complete',
  events: [{ elapsedMs: 741.9 }, { elapsedMs: 890 }],
}
const report: SpeedReport = {
  rows: [row], unavailableHarnesses: ['hermes'], rejectedRecords: 0, omittedRecords: 0,
  warnings: [], generatedAt: '2026-10-01T20:00:01Z', historyLimit: 10,
  trend: { bucket: 'day', starts: [] }, typicalDays: null,
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

  it('shows the typical day under each value and charts the trend with gaps and moved points', async () => {
    const day = (generation: number, first: number, requests: number) => ({ generationTokensPerSecondP50: generation, generationRequests: requests, firstEmissionMsP50: first, firstEmissionRequests: requests })
    const moved: SpeedRow = { ...row, harness: 'zcode', model: 'glm-flash', source: 'zcode-db', resolution: 'request', latestSampleId: null,
      generationTokensPerSecondP50: 52, firstEmissionMsP50: 16_000, trend: [day(70, 5_000, 40), day(68, 5_200, 40), null, day(52, 16_000, 30)],
      typical: { days: 7, generationTokensPerSecondP50: 70, firstEmissionMsP50: 5_000, generationChangePct: -25.7, firstEmissionChangePct: 220, generationShift: true, firstEmissionShift: true } }
    const quiet: SpeedRow = { ...row, trend: [null, null, null, day(33.8, 741.9, 1)] }
    bridge.getSpeed.mockResolvedValue({ ...report, rows: [quiet, moved], typicalDays: 7,
      trend: { bucket: 'day', starts: ['2026-09-29T00:00:00.000Z', '2026-09-30T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z'] } })
    render(<Speed period="week" provider="all" />)
    const table = await screen.findByRole('table')
    // Slower generation and a later first arrival are both regressions.
    expect(within(table).getByText('−26%')).toHaveClass('speed-delta', 'tone-bad')
    expect(within(table).getByText('+220%')).toHaveClass('speed-delta', 'tone-bad')
    expect(within(table).getByText('−26%').closest('.speed-typical')).toHaveTextContent('typical 70')
    // The row whose typical day moved is charted first.
    expect(screen.getByText('Trend · ZCode / glm-flash')).toBeInTheDocument()
    const chart = screen.getByRole('img', { name: 'Generation tok/s · p50 over time' })
    expect(chart.querySelectorAll('.speed-line')).toHaveLength(1)
    expect(chart.querySelector('.speed-typical-line')).not.toBeNull()
    expect([...chart.querySelectorAll('.speed-dot')].map(dot => dot.getAttribute('class'))).toEqual(['speed-dot tone-bad'])
    chart.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 180, right: 800, bottom: 180, x: 0, y: 0, toJSON: () => ({}) })
    fireEvent.mouseMove(chart, { clientX: 790, clientY: 50 })
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('52 tok/s')
    expect(tip).toHaveTextContent('Requests: 30')
    expect(tip).toHaveTextContent('typical 70 · −26%')
    fireEvent.mouseMove(chart, { clientX: 530, clientY: 50 })
    expect(screen.getByRole('tooltip')).toHaveTextContent('No complete requests in this interval')
    expect(screen.getByText(/median day in the 7 days before this window/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Trend: DeepSeek Harness / deepseek-flash' }))
    expect(screen.getByText('Trend · DeepSeek Harness / deepseek-flash')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Trend: DeepSeek Harness / deepseek-flash' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('img', { name: 'Generation tok/s · p50 over time' }).querySelector('.speed-typical-line')).toBeNull()
  })

  it('leaves out the typical-day explanation when the window has none', async () => {
    const trend = [{ generationTokensPerSecondP50: 40, generationRequests: 9, firstEmissionMsP50: 900, firstEmissionRequests: 9 }]
    bridge.getSpeed.mockResolvedValue({ ...report, rows: [{ ...row, trend }], typicalDays: null, trend: { bucket: 'week', starts: ['2026-09-28T00:00:00.000Z'] } })
    render(<Speed period="lifetime" provider="all" />)
    expect(await screen.findByText(/Each point is the median of complete requests/)).toBeInTheDocument()
    expect(screen.queryByText(/days before this window/)).toBeNull()
    expect(screen.getByText('Median per week')).toBeInTheDocument()
  })

  it('bounds a large native timeline while retaining endpoints and disclosing its displayed count', () => {
    const events = Array.from({ length: 10_000 }, (_, index) => ({ elapsedMs: index, tokens: 1 as const }))
    const { container } = render(<ArrivalChart sample={{ ...sample, source: 'native', resolution: 'token', durationMs: 10_000, events }} />)
    expect(container.querySelectorAll('circle')).toHaveLength(200)
    expect(container.querySelector('circle:last-of-type title')).toHaveTextContent('10000: 9,999 ms')
    expect(screen.getByText(/Showing 200 of 10000 recorded arrivals/)).toBeInTheDocument()
  })
})
