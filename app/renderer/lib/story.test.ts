import { describe, expect, it } from 'vitest'

import { sessionView } from '../i18n/catalogs/sessionView'
import { storyMarkdown, storyOf } from './story'
import type { WhyAgent, WhyStep, WhyTurn } from './types'

const parts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearch: 0 }
const tokens = { input: 1_000, output: 500, cacheRead: 9_000, cacheWrite: 0 }
const T0 = '2026-10-02T08:00:00.000Z'
const iso = (ms: number) => new Date(Date.parse(T0) + ms).toISOString()
const model = (start: number, end: number, extra: Partial<Extract<WhyStep, { kind: 'model' }>> = {}): WhyStep => (
  { kind: 'model', start, end, model: 'Fable 5.1', cost: 0.1, parts, tokens, startedBy: 'tool', cachedPct: 90, toolCalls: 0, answer: false, ...extra }
)
const tool = (start: number, end: number, name: string, label: string, parent: number, extra: Partial<Extract<WhyStep, { kind: 'tool' }>> = {}): WhyStep => (
  { kind: 'tool', start, end, name, label, isError: false, detail: null, parent, resultChars: 4_000, ...extra }
)
const turn = (steps: WhyStep[], extra: Partial<WhyTurn> = {}): WhyTurn => ({
  i: 1, ts: T0, prompt: { text: 'Fix the retry bug', kind: 'text' }, cost: 0.5, parts, tokens, calls: steps.filter(s => s.kind === 'model').length,
  models: ['Fable 5.1'], helperCost: 0, helpers: [], wallMs: 0, steps, ...extra,
})
const helper = (extra: Partial<WhyAgent>): WhyAgent => ({
  id: 'h1', description: 'Scan repo', agentType: 'Explore', models: ['Sonnet 5'], calls: 3, cost: 0.2, nested: false, loose: false, parentId: null, model: 'Sonnet 5',
  background: true, state: 'done', task: 'Scan the whole repository for dead code and list every unused export', delegatedAt: iso(2_000), firstCallAt: iso(2_500),
  lastCallAt: iso(20_000), handedBackAt: iso(21_000), handedBackIn: 2, taskTokensEst: 0, reportTokensEst: 0, handBackCost: 0, cacheSaving: 0,
  requests: 3, toolCalls: 4, parts, tokens, steps: [], ...extra,
})
const texts = (t: WhyTurn, idle = 60_000) => storyOf(t, idle).lines.map(l => l.text)

describe('storyOf', () => {
  it('tells the prompt, cut at 80 characters', () => {
    const long = 'a'.repeat(100)
    expect(texts(turn([], { prompt: { text: long, kind: 'text' } }))).toEqual([`You asked “${'a'.repeat(80)}…”.`])
  })

  it('tells a model request that asked for tools and the one that wrote the answer', () => {
    const lines = storyOf(turn([model(0, 4_800, { toolCalls: 1 }), tool(4_800, 5_000, 'Read', 'a.ts', 0), model(5_000, 7_000, { answer: true })]), 60_000).lines
    expect(lines.map(l => l.kind)).toEqual(['prompt', 'model', 'tools', 'model', 'answer'])
    expect(lines[1]!.text).toBe('Claude (Fable 5.1) read 10K tokens (90% from cache) and asked for 1 tool call in 4.8s.')
    expect(lines[3]!.text).toBe('Claude (Fable 5.1) read 10K tokens (90% from cache) and wrote the answer in 2.0s.')
    expect(lines[4]).toMatchObject({ at: 7_000, step: 2, text: 'The answer was ready after 7.0s.' })
  })

  it('tells one tool with its label cut at 40 characters and the tokens it added', () => {
    const cmd = 'npm test -- --run src/webhooks/retry/very/long/path.test.ts'
    expect(texts(turn([model(0, 1_000, { toolCalls: 1 }), tool(1_000, 3_500, 'Bash', cmd, 0), model(3_500, 4_000, { answer: true })]))[2])
      .toBe(`It ran Bash (${cmd.slice(0, 40)}…) in 2.5s, which added ≈1K tokens.`)
  })

  it('groups the tools of one request into one sentence and never merges across requests', () => {
    const lines = texts(turn([
      model(0, 1_000, { toolCalls: 3 }),
      tool(1_000, 1_400, 'Read', 'a.ts', 0, { parallel: { index: 1, of: 3 } }),
      tool(1_000, 1_200, 'Grep', 'x', 0, { parallel: { index: 2, of: 3 } }),
      tool(1_000, 1_300, 'Read', 'b.ts', 0, { parallel: { index: 3, of: 3 } }),
      model(1_500, 2_000, { toolCalls: 1 }),
      tool(2_000, 2_100, 'Read', 'c.ts', 4),
      model(2_200, 3_000, { answer: true }),
    ]))
    expect(lines.filter(l => l.startsWith('It ran'))).toEqual([
      'It ran 3 tool calls in parallel (Read, Grep) in 400ms.',
      'It ran Read (c.ts) in 100ms, which added ≈1K tokens.',
    ])
  })

  it('tells a failed tool on its own line', () => {
    const story = storyOf(turn([model(0, 1_000, { toolCalls: 2 }), tool(1_000, 1_200, 'Read', 'a.ts', 0), tool(1_000, 6_000, 'Bash', 'npm run build', 0, { isError: true }), model(6_000, 7_000, { answer: true })]), 60_000)
    expect(story.lines.filter(l => l.kind === 'tools' || l.kind === 'failed').map(l => [l.kind, l.text, l.step])).toEqual([
      ['tools', 'It ran Read (a.ts) in 200ms, which added ≈1K tokens.', 1],
      ['failed', 'Bash failed after 5.0s.', 2],
    ])
  })

  it('tells each delegation by how it ended, skipping the spawn tool step and nested helpers', () => {
    const t = turn([model(0, 2_000, { toolCalls: 3 }), tool(2_000, 21_000, 'Agent', 'Scan repo', 0), model(21_000, 22_000, { answer: true })], {
      helpers: [
        helper({}),
        helper({ id: 'h2', task: 'Write docs', agentType: 'general-purpose', handedBackAt: null, lastCallAt: iso(5_000), state: 'running', requests: 1, toolCalls: 1 }),
        helper({ id: 'h3', task: 'Lint', handedBackAt: null, lastCallAt: iso(4_000), state: 'stopped' }),
        helper({ id: 'h4', task: 'Deep scan', parentId: 'h1' }),
      ],
    })
    expect(texts(t).filter(l => l.startsWith('It '))).toEqual([
      'It handed “Scan the whole repository for dead code and list every unuse…” to a Explore subagent, which made 3 requests and 4 tool calls in 19s and reported back.',
      'It handed “Write docs” to a general-purpose subagent, which made 1 request and 1 tool call in 3.0s and is still running.',
      'It handed “Lint” to a Explore subagent, which made 3 requests and 4 tool calls in 2.0s and stopped without reporting back.',
    ])
  })

  it('tells a compaction with sizes when both sides are known, else without', () => {
    const steps = [model(0, 1_000, { toolCalls: 0 }), model(5_000, 6_000, { answer: true, tokens: { input: 0, output: 10, cacheRead: 0, cacheWrite: 3_000 } })]
    expect(texts(turn(steps, { compactions: [iso(2_000)] }))).toContain('Claude Code compacted the conversation here, from 10K to 3K tokens.')
    expect(texts(turn(steps, { compactions: [iso(9_000)] }))).toContain('Claude Code compacted the conversation here.')
  })

  it('tells an idle gap at or over the threshold only', () => {
    const steps = [model(0, 1_000, { toolCalls: 1 }), tool(1_000, 2_000, 'Read', 'a.ts', 0), model(72_000, 73_000, { answer: true })]
    expect(storyOf(turn(steps), 60_000).lines.find(l => l.kind === 'idle')).toMatchObject({ at: 2_000, step: 2, text: 'Nothing happened for 1m 10s.' })
    expect(texts(turn(steps), 80_000).some(l => l.startsWith('Nothing'))).toBe(false)
  })

  it('tells the last helper finishing after the answer and says when the answer came in the header', () => {
    const story = storyOf(turn([model(0, 1_000, { toolCalls: 1 }), model(3_000, 4_000, { answer: true })], { helpers: [helper({})], helperCost: 0.2, wallMs: 4_000 }), 60_000)
    expect(story.lines.at(-1)).toEqual({ at: 21_000, kind: 'helperDone', text: 'Its last background subagent finished after 21s.' })
    expect(story.header).toBe('What happened: done in 21s (answer at 4.0s) · 2 model requests · 0 tool calls · 1 subagent · $0.70 at API rates')
    const md = storyMarkdown(story)
    expect(md.split('\n').slice(0, 3)).toEqual([story.header, '', '- +0s You asked “Fix the retry bug”.'])
    expect(md).not.toMatch(/\]\(|https?:/)
  })
})

describe('story catalog', () => {
  it('has every story template in all six locales with the same placeholders', () => {
    const vars = (s: string | undefined) => (s?.match(/\{(\w+)\}/g) ?? []).sort()
    const keys = Object.keys(sessionView.en).filter(k => k.startsWith('sessions.why.story.') || k === 'sessions.why.view.story')
    expect(keys).toHaveLength(24)
    for (const [locale, catalog] of Object.entries(sessionView)) {
      for (const key of keys) expect({ locale, key, has: key in catalog, vars: vars(catalog[key]) }).toEqual({ locale, key, has: true, vars: vars(sessionView.en[key]) })
    }
  })
})
