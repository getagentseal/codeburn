// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_FILTERS } from '../lib/investigation'
import type { SessionRow, SessionWhy, WhyAgent, WhyParts, WhyStep, WhyTurn } from '../lib/types'
import { costByAgent, hasSessionView, SessionView } from './SessionView'
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

const model = (start: number, end: number, cost: number, extra: Partial<Extract<WhyStep, { kind: 'model' }>> = {}): WhyStep => (
  { kind: 'model', start, end, model: 'Fable 5.1', cost, parts: parts(cost), tokens, startedBy: 'tool', cachedPct: 86, toolCalls: 0, answer: false, ...extra }
)
const tool = (start: number, end: number, name: string, label: string, parent: number, resultChars: number, extra: Partial<Extract<WhyStep, { kind: 'tool' }>> = {}): WhyStep => (
  { kind: 'tool', start, end, name, label, isError: false, detail: null, parent, resultChars, ...extra }
)
const LONG = 'npm test -- --run src/webhooks/retry/very/long/path/to/the/spec/file.test.ts'
const inspectTurn = turn(5, 0.9, {
  calls: 4,
  steps: [
    model(0, 3_000, 0.1, { toolCalls: 2 }),
    tool(3_000, 3_400, 'Read', 'retry.ts', 0, 8_000, { parallel: { index: 1, of: 2 } }),
    tool(3_000, 3_200, 'Grep', 'retryAfter', 0, 400, { parallel: { index: 2, of: 2 } }),
    model(3_500, 70_000, 0.5, { toolCalls: 1 }),
    tool(70_000, 75_000, 'Bash', LONG, 3, 48_000, { isError: true, detail: { command: LONG, output: 'Exit code 1' } }),
    model(75_100, 79_000, 0.2, { toolCalls: 1 }),
    tool(79_000, 79_300, 'Edit', 'retry.ts', 5, 100),
    model(79_400, 82_000, 0.1, { answer: true }),
  ],
})
const inspectPayload: SessionWhy = {
  ...payload,
  turns: [...payload.turns, inspectTurn],
  findings: [{ id: 'f1', kind: 'slowCall', turn: 5, step: 3, usd: null, share: null, timeMs: 66_500, model: 'Fable 5.1', outputTokens: 1_000 }],
}
const texts = (root: Element, sel: string) => [...root.querySelectorAll(sel)].map(e => e.textContent)

describe('SessionView inspect', () => {
  it('ranks the insights, flagged rows first, and shows Problems only when a step failed', async () => {
    const user = userEvent.setup()
    getSessionWhy.mockResolvedValue(inspectPayload)
    const { container } = render(<SessionView row={row} filters={EMPTY_FILTERS} onBack={() => {}} />)
    await screen.findByText('Slowest request')
    const td = container.querySelector('#sv-turn-5 .sv-td')!
    expect(texts(td, '.sv-ins-row')).toEqual([
      'Slowest request1m 07sRequest 2',
      'Added the most context≈12K tokensBash',
      'Problems1 failed stepBash',
      'Costliest request$0.50 · 56% of the promptRequest 2',
      'Tool calls4 in 3 batchesRequest 1 · 2 parallel',
    ])
    expect(td.querySelector('.sv-ins-row b.top')).toHaveTextContent('$0.50')
    await user.click(screen.getByText('All 5'))
    await user.click(within(container.querySelector('#sv-turn-1')!).getByRole('button', { name: /Prompt text 1/ }))
    const t1 = container.querySelector('#sv-turn-1 .sv-td')!
    expect(texts(t1, '.sv-ins-row .lb')).toEqual(['Slowest request', 'Costliest request'])
  })

  it('shows one card per request, newest first, with nested tools, parallel labels and roles', async () => {
    const user = userEvent.setup()
    getSessionWhy.mockResolvedValue(inspectPayload)
    const { container } = render(<SessionView row={row} filters={EMPTY_FILTERS} onBack={() => {}} />)
    await screen.findByText('Slowest request')
    const td = container.querySelector('#sv-turn-5 .sv-td')!
    expect(texts(td, '.sv-rq-head .ti b')).toEqual(['Request 4', 'Request 3', 'Request 2', 'Request 1'])
    const [last] = td.querySelectorAll('.sv-rq')
    expect(last!.querySelector('.mt')).toHaveTextContent('58K in / 1K out / 86% cached · wrote the answer')
    expect(last!.querySelectorAll('.sv-rq-tool')).toHaveLength(0)
    expect(texts(last!, '.sv-rq-head .sv-pill')).toEqual(['$0.10'])
    expect(td.querySelector('.sv-rq.sel .sv-sd')).toHaveTextContent('Model call')
    await user.click(screen.getByRole('button', { name: 'Newest first' }))
    const first = td.querySelector('.sv-rq')!
    expect(first.querySelector('.mt')).toHaveTextContent('asked for 2 tool calls')
    expect(texts(first, '.sv-rq-tool .nm')).toEqual(['Read', 'Grep'])
    expect(texts(first, '.sv-rq-tool .tg')).toEqual(['parallel 1/2', 'parallel 2/2'])
    expect(texts(first, '.sv-rq-tool .tk')).toEqual(['+2K', '+100'])
    const failed = td.querySelector('.sv-rq-tool.err')!
    expect(failed.querySelector('.lb')!.textContent).toBe(LONG.slice(0, 60))
    expect(failed.querySelector('.tg')).toHaveTextContent('failed')
    await user.click(failed)
    expect(td.querySelector('.sv-rq-tools .sv-sd')).toHaveTextContent('Command')
  })

  it('filters cards and tools by text, and switches between all, model and tools', async () => {
    const user = userEvent.setup()
    getSessionWhy.mockResolvedValue(inspectPayload)
    const { container } = render(<SessionView row={row} filters={EMPTY_FILTERS} onBack={() => {}} />)
    await screen.findByText('Slowest request')
    const td = container.querySelector('#sv-turn-5 .sv-td')!
    const search = screen.getByRole('searchbox', { name: 'Filter requests and tools' })
    await user.type(search, 'grep')
    expect(texts(td, '.sv-rq-head .ti b')).toEqual(['Request 1'])
    expect(texts(td, '.sv-rq-tool .nm')).toEqual(['Grep'])
    await user.clear(search)
    await user.type(search, 'request 3')
    expect(texts(td, '.sv-rq-head .ti b')).toEqual(['Request 3'])
    expect(texts(td, '.sv-rq-tool .nm')).toEqual(['Edit'])
    await user.type(search, 'x')
    expect(td).toHaveTextContent('Nothing matches the filter.')
    await user.clear(search)
    await user.click(within(td as HTMLElement).getByRole('tab', { name: 'Model' }))
    expect(td.querySelectorAll('.sv-rq-head')).toHaveLength(4)
    expect(td.querySelectorAll('.sv-rq-tool')).toHaveLength(0)
    await user.click(within(td as HTMLElement).getByRole('tab', { name: 'Tools' }))
    expect(td.querySelectorAll('.sv-rq-head')).toHaveLength(0)
    expect(texts(td, '.sv-rq-tool .nm')).toEqual(['Edit', 'Bash', 'Grep', 'Read'])
  })
})

const T0 = Date.parse('2026-10-02T08:16:00.000Z')
const iso = (ms: number | null) => (ms === null ? null : new Date(T0 + ms).toISOString())
const usage = (input: number, cacheRead: number, cacheWrite: number, output: number) => ({ input, cacheRead, cacheWrite, output })
function helper(id: string, description: string, agentType: string, cost: number, times: [number, number, number, number | null], extra: Partial<WhyAgent> = {}): WhyAgent {
  return {
    id, description, agentType, models: ['Sonnet 5'], calls: 1, cost, nested: false, loose: false, parentId: null, model: 'Sonnet 5', background: true, state: 'done', task: '',
    delegatedAt: iso(times[0]), firstCallAt: iso(times[1]), lastCallAt: iso(times[2]), handedBackAt: iso(times[3]), handedBackIn: null,
    taskTokensEst: 100, reportTokensEst: 0, handBackCost: 0, cacheSaving: 0, requests: 1, toolCalls: 0, parts: parts(cost), tokens: usage(2, 0, 5_000, 100),
    steps: [model(500, 3_000, cost, { tokens: usage(2, 0, 5_000, 100) })], ...extra,
  }
}
const scan = helper('agent-k1', 'Scan repo', 'Explore', 0.3, [3_000, 3_500, 32_505, 65_015], {
  calls: 3, requests: 3, toolCalls: 1, task: 'Scan the repo for dead code.', taskTokensEst: 1_000, reportTokensEst: 500, handedBackIn: 3, handBackCost: 0.01, cacheSaving: 0.08,
  tokens: usage(3_004, 31_000, 13_900, 2_000),
  steps: [
    model(500, 3_500, 0.1, { tokens: usage(3_000, 0, 12_000, 1_000), toolCalls: 0 }),
    model(4_500, 6_500, 0.1, { tokens: usage(2, 15_000, 1_000, 400), toolCalls: 1 }),
    tool(6_500, 26_505, 'Agent', 'Deep scan', 1, 40),
    model(27_505, 29_505, 0.1, { tokens: usage(2, 16_000, 900, 600), answer: true }),
  ],
})
const agentsTurn = turn(6, 0.9, {
  helperCost: 0.55,
  helpers: [
    scan,
    helper('agent-k2', 'Write docs', 'general-purpose', 0.12, [3_000, 5_000, 8_000, null], { state: 'stopped' }),
    helper('agent-k5', 'Lint', 'general-purpose', 0.08, [3_000, 5_000, 9_000, null], { state: 'running' }),
    helper('agent-k3', 'Deep scan', 'Explore', 0.05, [6_500, 10_000, 13_000, 26_505], { parentId: 'agent-k1', nested: true, reportTokensEst: 300, handedBackIn: 3, handBackCost: 0.004 }),
  ],
})
const agentsPayload: SessionWhy = {
  ...payload,
  turns: [...payload.turns, agentsTurn],
  findings: [{ id: 'f1', kind: 'slowCall', turn: 6, step: 1, usd: null, share: null, timeMs: 66_500, model: 'Fable 5.1', outputTokens: 1_000 }],
}

describe('SessionView agents', () => {
  async function openAgents() {
    const user = userEvent.setup()
    getSessionWhy.mockResolvedValue(agentsPayload)
    const { container } = render(<SessionView row={row} filters={EMPTY_FILTERS} onBack={() => {}} />)
    await screen.findByText('Slowest request')
    await user.click(within(container.querySelector('#sv-turn-6')!).getByRole('tab', { name: 'Agents' }))
    return { user, td: container.querySelector('#sv-turn-6 .sv-td')!, container }
  }
  const card = (td: Element, id: string) => td.querySelector(`[data-agent="${id}"]`)!

  it('shows the helpers as a tree, the main agent, and a card per helper with its state', async () => {
    const { td } = await openAgents()
    expect(td.querySelector('.sv-ag-topo b')).toHaveTextContent('4 subagents')
    expect([...td.querySelectorAll('.sv-ag-tree li')].map(li => [li.textContent, li.getAttribute('data-depth')])).toEqual([
      ['Explore Scan repo', '0'], ['Explore Deep scan', '1'], ['general-purpose Write docs', '0'], ['general-purpose Lint', '0'],
    ])
    expect(td.querySelector('.sv-ag-main')).toHaveTextContent('Main agent Fable 5.1 · 1m 00s · 2 requests · 0 tool calls · 58K in · 1K out · $0.90')
    expect(texts(td, '.sv-ag .sv-ag-head .sv-pill')).toEqual(['done', 'done', 'stopped', 'running'])
    expect(texts(td, '.sv-ag .sv-ag-head .ti b')).toEqual(['Explore', 'Explore', 'general-purpose', 'general-purpose'])
    expect(card(td, 'agent-k1').querySelector('.sv-ag-task')).toHaveTextContent('Scan the repo for dead code.')
    expect(card(td, 'agent-k1').querySelector('.sv-ag-stats')).toHaveTextContent('1m 02s · 3 requests · 1 tool call · 47.9K in · 2K out · $0.30')
  })

  it('draws each helper lifecycle with the elapsed offset and the detail of every stage', async () => {
    const { td } = await openAgents()
    const k1 = card(td, 'agent-k1')
    expect(texts(k1, '.sv-lc .pt b')).toEqual(['Delegate', 'Initialize', 'Run', 'Hand back', 'Cost'])
    expect(texts(k1, '.sv-lc .off')).toEqual(['+0s', '+500ms', '+30s', '+1m 02s', '+1m 02s'])
    expect(texts(k1, '.sv-lc .dt p')).toEqual([
      '≈1K tokens of task text handed over',
      'Started with 15K tokens, 12K written to cache',
      '3 requests, 1 tool call, 65% of input read from cache',
      '15K → 16K → 16.9K',
      'Report ≈500 tokens',
      'Handed back in request 3',
      '$0.30 at API rates',
      'Reading from cache saved ≈$0.08 against sending that input uncached',
    ])
    expect(k1.querySelectorAll('.sv-lc-bars > span')).toHaveLength(3)
    expect(k1.querySelectorAll('.sv-lc-bars > span:first-child i')).toHaveLength(4)
    expect(card(td, 'agent-k2').querySelector('[data-stage="handBack"]')).toHaveTextContent('Hand back—The session ended without a hand-back')
    expect(card(td, 'agent-k5').querySelector('[data-stage="handBack"] .dt')).toHaveTextContent('Still working')
  })

  it('splits the prompt by agent so the parts add up to the prompt total, and opens a helper own request cards', async () => {
    const split = costByAgent(agentsTurn)
    expect(split.main + split.helpers.reduce((s, x) => s + x.cost, 0) + split.handBacks).toBeCloseTo(agentsTurn.cost + agentsTurn.helperCost, 12)
    expect(split.main).toBeCloseTo(0.89, 12)
    expect(split.helpers.map(x => Number(x.cost.toFixed(3)))).toEqual([0.296, 0.12, 0.08, 0.05])
    const { user, td } = await openAgents()
    const panel = td.querySelector('.sv-ag-cost')!
    expect(panel.querySelector('.sv-ag-cost-head')).toHaveTextContent('Cost by agent$1.45')
    expect(texts(panel, '.sv-ag-row')).toEqual([
      'Main agent$0.8961%', 'Explore · Scan repo$0.3020%', 'general-purpose · Write docs$0.128%', 'general-purpose · Lint$0.086%', 'Explore · Deep scan$0.053%', 'Hand-backs≈$0.01<1%',
    ])
    expect(panel.querySelectorAll('.sv-ag-bar i')).toHaveLength(6)
    expect(panel.querySelector('.sv-ag-type')).toHaveTextContent('By type: Explore $0.35 · general-purpose $0.20')
    await user.click(within(card(td, 'agent-k1') as HTMLElement).getByRole('button', { name: 'Inspect' }))
    expect(texts(card(td, 'agent-k1'), '.sv-rq-head .ti b')).toEqual(['Request 3', 'Request 2', 'Request 1'])
    expect(texts(card(td, 'agent-k1'), '.sv-rq-tool .nm')).toEqual(['Agent'])
  })
})

describe('SessionView story', () => {
  async function openStory() {
    const user = userEvent.setup()
    getSessionWhy.mockResolvedValue(agentsPayload)
    const { container } = render(<SessionView row={row} filters={EMPTY_FILTERS} onBack={() => {}} />)
    await screen.findByText('Slowest request')
    const tr = container.querySelector('#sv-turn-6')!
    expect(texts(tr, '.sv-td > .seg [role="tab"]')).toEqual(['Inspect', 'Agents', 'Story'])
    await user.click(within(tr as HTMLElement).getByRole('tab', { name: 'Story' }))
    return { user, tr, td: tr.querySelector('.sv-td')! }
  }

  it('tells the prompt in sentences with offsets, a header and the footer', async () => {
    const { td } = await openStory()
    expect(td.querySelector('.sv-story-head p')).toHaveTextContent('What happened: done in 1m 05s (answer at 12s) · 2 model requests · 0 tool calls · 4 subagents · $1.45 at API rates')
    expect(texts(td, '.sv-story .off')).toEqual(['+0s', '+0s', '+3.0s', '+3.0s', '+3.0s', '+9.0s', '+12s', '+1m 05s'])
    expect(texts(td, '.sv-story .tx')[2]).toBe('It handed “Scan the repo for dead code.” to the Explore subagent, which made 3 requests and 1 tool call in 1m 02s and reported back.')
    expect(td.querySelector('.sv-story + .sv-note')).toHaveTextContent('Written from the recorded steps alone.')
  })

  it('opens the step in Inspect from its chevron', async () => {
    const { user, tr } = await openStory()
    const line = tr.querySelectorAll('.sv-story li')[5]!
    await user.click(within(line as HTMLElement).getByRole('button', { name: 'Open in Inspect' }))
    expect(tr.querySelector('.seg [aria-selected="true"]')).toHaveTextContent('Inspect')
    expect(tr.querySelector('.sv-rq.sel .sv-sd')).toHaveTextContent('Model call')
    expect(texts(tr, '.sv-rq.sel .ti b')).toEqual(['Request 2'])
  })

  it('copies the header and the sentences with offsets as Markdown', async () => {
    const { user, td } = await openStory()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await user.click(within(td as HTMLElement).getByRole('button', { name: 'Copy as Markdown' }))
    const md = writeText.mock.calls[0]![0] as string
    const lines = md.split('\n')
    expect(lines[0]).toBe(td.querySelector('.sv-story-head p')!.textContent)
    expect(lines.slice(2)).toEqual([...td.querySelectorAll('.sv-story li')].map(li => `- ${li.querySelector('.off')!.textContent} ${li.querySelector('.tx')!.textContent}`))
    expect(lines[2]).toBe('- +0s You asked “Prompt text 6”.')
    expect(within(td as HTMLElement).getByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })
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

  it('shows PR work: PRs opened here with follow-ups and review runs with cost', async () => {
    getSessionWhy.mockResolvedValue({ ...payload, prWork: {
      opened: [
        { url: 'https://github.com/o/r/pull/12', at: '2026-10-02T08:12:00.000Z', head: 'feat/a', followUpRounds: 2, followUpPushes: 3 },
        { url: 'https://github.com/o/r/pull/13', at: '2026-10-02T08:14:00.000Z', head: 'feat/b', followUpRounds: 0, followUpPushes: 0 },
        { url: 'https://github.com/o/r/pull/14', at: '2026-10-02T08:15:00.000Z', head: null, followUpRounds: null, followUpPushes: 0 },
      ],
      reviewRuns: [{ helperId: 'h1', description: 'Review PR 12', models: ['Opus 5.5'], cost: 1.4, pr: 12 }],
      reviewCost: 1.4,
    } })
    const { container } = render(<SessionView row={row} filters={EMPTY_FILTERS} onBack={() => {}} />)
    await screen.findByText('PR work')
    const block = container.querySelector('.sv-prwork') as HTMLElement
    expect(block).toHaveTextContent('review runs $1.40')
    expect([...block.querySelectorAll('.sv-fd')].map(r => r.textContent)).toEqual([
      'Opened o/r#12Follow-up rounds: 2, pushes: 3',
      'Opened o/r#13No pushes after it was opened',
      'Opened o/r#14',
      'Review PR 12Opus 5.5 · #12$1.40',
    ])
  })

  it('has no PR work block when the session did none', async () => {
    getSessionWhy.mockResolvedValue({ ...payload, prWork: { opened: [], reviewRuns: [], reviewCost: 0 } })
    render(<SessionView row={row} filters={EMPTY_FILTERS} onBack={() => {}} />)
    await screen.findByText('Worth a look')
    expect(screen.queryByText('PR work')).toBeNull()
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
    expect(container.querySelector('#sv-turn-3 .sv-td-sum')).toHaveTextContent('Done in 1m 00s · 2 model requests · $1.20 for this prompt')
    expect(container.querySelectorAll('#sv-turn-3 .sv-rq')).toHaveLength(2)
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
