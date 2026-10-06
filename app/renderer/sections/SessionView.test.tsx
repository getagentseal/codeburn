// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_FILTERS } from '../lib/investigation'
import type { SessionRow, SessionWhy, WhyParts, WhyTurn } from '../lib/types'
import { hasSessionView, SessionView } from './SessionView'
import { Sessions } from './Sessions'

const { getSessionWhy, getSessions } = vi.hoisted(() => ({
  getSessionWhy: vi.fn<(id: string) => Promise<SessionWhy>>(),
  getSessions: vi.fn<(period: string, provider: string) => Promise<SessionRow[]>>(),
}))
vi.mock('../lib/ipc', async orig => {
  const actual = await orig<typeof import('../lib/ipc')>()
  return { ...actual, codeburn: { getSessionWhy, getSessions } }
})

const SID = '7f3c2a91-4be0-4d1e-9a55-2c8e01d4b6aa'
const parts = (cost: number): WhyParts => ({ input: 0, output: cost * 0.3, cacheRead: cost * 0.2, cacheWrite: cost * 0.5, webSearch: 0 })
const tokens = { input: 10, output: 1_000, cacheRead: 50_000, cacheWrite: 8_000 }

function turn(i: number, cost: number, extra: Partial<WhyTurn> = {}): WhyTurn {
  return {
    i, ts: `2026-10-02T08:${10 + i}:00.000Z`, prompt: { text: `Prompt text ${i}`, kind: 'text' }, cost, parts: parts(cost), tokens,
    calls: 2, models: ['Fable 5.1'], helperCost: 0, helpers: [], wallMs: 60_000,
    steps: [
      { kind: 'model', start: 0, end: 4_000, model: 'Fable 5.1', cost: cost / 2, parts: parts(cost / 2), tokens, startedBy: 'prompt' },
      { kind: 'model', start: 9_000, end: 12_000, model: 'Fable 5.1', cost: cost / 2, parts: parts(cost / 2), tokens, startedBy: 'tool' },
    ],
    ...extra,
  }
}

const failingTurn = turn(3, 1.2, {
  prompt: { text: 'Run the build and fix it', kind: 'text' },
  steps: [
    { kind: 'model', start: 0, end: 4_000, model: 'Fable 5.1', cost: 0.6, parts: parts(0.6), tokens, startedBy: 'prompt' },
    {
      kind: 'tool', start: 4_000, end: 9_000, name: 'Bash', label: 'npm run build', isError: true,
      error: { exitCode: 1, cause: "src/a.ts(4,1): error TS2339: Property 'retryAfter' does not exist", location: null, secondary: [] },
      detail: { command: 'npm run build', description: 'Build the frontend', output: "Exit code 1\n> tsc -b\nsrc/a.ts(4,1): error TS2339: Property 'retryAfter' does not exist\nFound 1 error." },
    },
    { kind: 'model', start: 9_000, end: 12_000, model: 'Fable 5.1', cost: 0.6, parts: parts(0.6), tokens, startedBy: 'tool' },
  ],
})

const payload: SessionWhy = {
  sessionId: SID, title: 'Webhook retry', project: '/work/acme', startedAt: '2026-10-02T08:11:00.000Z', endedAt: '2026-10-02T08:25:00.000Z',
  cost: 3.07, calls: 8, parts: parts(3.07), tokens, models: [{ model: 'Fable 5.1', cost: 3.07 }], helperCost: 3.09, helperCount: 6, median: 0.8,
  turns: [turn(1, 1.39), turn(2, 0.41, { helperCost: 3.09 }), failingTurn, turn(4, 0.07)],
  findings: [
    { id: 'f1', kind: 'helpers', turn: 2, usd: 3.09, share: 0.5, direct: 6, nested: 0, loose: 0, models: ['Sonnet 5'], descriptions: ['Review module 1', 'Review module 2', 'Review module 3', 'Review module 4', 'Review module 5', 'Review module 6'], parts: parts(3.09), tokens, calls: 71, minCalls: 9, maxCalls: 15, alt: { model: 'Haiku 4.5', cost: 1.55 } },
    { id: 'f2', kind: 'hotspot', turn: 1, usd: 1.39, share: 0.45, calls: 8, toolCalls: 7, models: ['Fable 5.1'], median: 0.8, parts: parts(1.39), tokens, alt: { model: 'Opus 5.5', cost: 0.6 } },
    { id: 'f3', kind: 'prefix', estimate: true, turn: 1, usd: 0.83, share: 0.27, tokens: 53_200, cached: 53_190, uncached: 31_400, writeUsd: 0.63, readUsd: 0.2, laterCalls: 7, readCalls: 6 },
    { id: 'f4', kind: 'failed', turn: 3, step: 1, usd: 0.58, share: 0.19, tool: 'Bash', label: 'npm run build', description: 'Build the frontend', error: failingTurn.steps[1]!.kind === 'tool' ? failingTurn.steps[1]!.error! : { exitCode: null, cause: null, location: null, secondary: [] }, userStopped: false, afterCalls: 2 },
    { id: 'f5', kind: 'slowCall', turn: 3, step: 2, usd: null, share: null, timeMs: 181_000, model: 'Fable 5.1', outputTokens: 9_800 },
  ],
  rules: { hotspotTopShare: 0.2, hotspotMedianX: 2, hotspotMinShare: 0.1, helperShare: 0.1, coordinationMinCalls: 5, coordinationToolShare: 0.75, rereadShare: 0.5, rereadMinCalls: 10, carryTokens: 10_000, prefixTokens: 40_000, idleMs: 60_000, slowCallMs: 60_000 },
  detailsOmitted: false,
}

const row: SessionRow = {
  sessionId: SID, title: 'Webhook retry', project: '-Users-demo-code-acme', provider: 'claude', models: ['Fable 5.1'], cost: 3.07, savingsUSD: 0,
  calls: 8, turns: 4, inputTokens: 10, outputTokens: 1_000, cacheReadTokens: 50_000, cacheWriteTokens: 8_000,
  startedAt: payload.startedAt, endedAt: payload.endedAt, durationMs: 840_000,
}

beforeEach(() => {
  getSessionWhy.mockReset()
  getSessions.mockReset()
})

describe('SessionView', () => {
  it('opens only for Claude Code main sessions', () => {
    expect(hasSessionView(row)).toBe(true)
    expect(hasSessionView({ ...row, provider: 'codex' })).toBe(false)
    expect(hasSessionView({ ...row, sessionId: 'agent-a1b2c3' })).toBe(false)
    expect(hasSessionView({ ...row, isSidechain: true })).toBe(false)
  })

  it('leads with the verdict, ranks findings by cost and shows the repriced option', async () => {
    getSessionWhy.mockResolvedValue(payload)
    const { container } = render(<SessionView row={row} filters={EMPTY_FILTERS} onBack={() => {}} />)
    expect(await screen.findByText('Helpers launched by prompt 2 cost $3.09, 50% of this session and its helpers. One step failed along the way.')).toBeInTheDocument()
    expect(getSessionWhy).toHaveBeenCalledWith(SID)
    expect(container.querySelector('.sv-figure')).toHaveTextContent('$3.07')
    const rows = [...container.querySelectorAll('.sv-fd')]
    expect(rows).toHaveLength(5)
    expect(rows[0]).toHaveClass('lead')
    expect(rows[0]).toHaveTextContent("Prompt 2 launched 6 Sonnet 5 helpers ('Review module 1–6'): $3.09 in total")
    expect(rows[0]).toHaveTextContent('If Haiku 4.5 can do these tasks, the same tokens cost $1.55 (−$1.54).')
    expect(rows[2]).toHaveTextContent('Estimate')
    expect(rows[2]).toHaveTextContent('≈$0.83')
    expect(rows[4]).toHaveTextContent('3m 01s')
    expect(rows[4]).toHaveTextContent('time only')
    expect(container.querySelectorAll('.sv-bar')).toHaveLength(4)
  })

  it('says so when the list row covers only part of the session', async () => {
    getSessionWhy.mockResolvedValue(payload)
    render(<SessionView row={{ ...row, cost: 1.25 }} filters={EMPTY_FILTERS} onBack={() => {}} />)
    expect(await screen.findByText('The Sessions list shows $1.25 for this row; this view prices every call in this transcript, including calls a forked or resumed session shares with another row.')).toBeInTheDocument()
  })

  it('explains a prompt count that differs from the row, and singular counts read as singular', async () => {
    getSessionWhy.mockResolvedValue({ ...payload, findings: [...payload.findings, { id: 'f6', kind: 'carry', estimate: true, turn: 4, step: 0, usd: 0.01, share: 0.003, source: 'tool', tool: 'Read', label: 'a.log', chars: 48_000, tokens: 12_000, calls: 1, writeUsd: 0.01, readUsd: 0 }] })
    const { container } = render(<SessionView row={{ ...row, turns: 9 }} filters={EMPTY_FILTERS} onBack={() => {}} />)
    expect(await screen.findByText('(9 turns in the Sessions list: helper replies fold into the prompt they answer)')).toBeInTheDocument()
    await userEvent.setup().click(screen.getByText('Show 1 more'))
    expect(container.textContent).toContain('stayed in context for 1 call')
    expect(container.textContent).not.toMatch(/(for|over|made) 1 calls/)
  })

  it('shows the saving as the difference of the two shown figures', async () => {
    const hot = payload.findings[1]!
    getSessionWhy.mockResolvedValue({ ...payload, findings: [{ ...hot, usd: 1.006, alt: { model: 'Opus 5.5', cost: 0.504 } } as typeof hot] })
    const { container } = render(<SessionView row={row} filters={EMPTY_FILTERS} onBack={() => {}} />)
    await screen.findByText('Worth a look')
    expect(container.textContent).toContain('the same tokens cost $0.50 (−$0.51)')
  })

  it('lists flagged prompts by default and all on request', async () => {
    const user = userEvent.setup()
    getSessionWhy.mockResolvedValue(payload)
    const { container } = render(<SessionView row={row} filters={EMPTY_FILTERS} onBack={() => {}} />)
    await screen.findByText('Flagged 3')
    expect(container.querySelectorAll('.sv-tr')).toHaveLength(3)
    await user.click(screen.getByText('All 4'))
    expect(container.querySelectorAll('.sv-tr')).toHaveLength(4)
  })

  it('jumps from a failed-step finding to the step: real error, command and output', async () => {
    const user = userEvent.setup()
    getSessionWhy.mockResolvedValue(payload)
    const { container } = render(<SessionView row={row} filters={EMPTY_FILTERS} onBack={() => {}} />)
    const failed = (await screen.findByText('Command “Build the frontend” failed with exit code 1')).closest('.sv-fd') as HTMLElement
    await user.click(within(failed).getByRole('button', { name: /Prompt 3/ }))
    const detail = container.querySelector('#sv-turn-3 .sv-sd') as HTMLElement
    expect(detail).toHaveTextContent('exit code 1')
    expect(detail.querySelector('.sv-pre .hl')).toHaveTextContent("error TS2339: Property 'retryAfter' does not exist")
    expect(container.querySelector('#sv-turn-3 .sv-td-sum')).toHaveTextContent('Model calls: 2 · tool steps: 1')
    expect(container.querySelectorAll('#sv-turn-3 .sv-wf-bar')).toHaveLength(3)
  })

  it('shows the error and keeps the session details when the transcript cannot be read', async () => {
    getSessionWhy.mockRejectedValue({ kind: 'nonzero', message: 'codeburn: no Claude Code session matches' })
    render(<SessionView row={row} filters={EMPTY_FILTERS} onBack={() => {}} />)
    expect(await screen.findByText("Couldn't read this session")).toBeInTheDocument()
    expect(screen.getByText('Session details')).toBeInTheDocument()
  })

  it('replaces the list when a Claude session is clicked, and Back returns to it', async () => {
    const user = userEvent.setup()
    getSessions.mockResolvedValue([row])
    getSessionWhy.mockResolvedValue(payload)
    render(<Sessions period="30days" provider="all" />)
    await user.click(await screen.findByRole('button', { name: /Webhook retry/ }))
    expect(await screen.findByText('Worth a look')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Sessions' }))
    await waitFor(() => expect(screen.queryByText('Worth a look')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: /Webhook retry/ })).toBeInTheDocument()
  })
})
