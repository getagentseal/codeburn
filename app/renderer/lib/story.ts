import { t } from '../i18n'
import { formatCompact, formatUsd } from './format'
import type { WhyAgent, WhyStep, WhyTokens, WhyTurn } from './types'

export type ModelStep = Extract<WhyStep, { kind: 'model' }>
export type ToolStep = Extract<WhyStep, { kind: 'tool' }>
export type ToolRef = { s: ToolStep; k: number }
export type Request = { s: ModelStep; k: number; n: number; tools: ToolRef[] }

export function formatStepDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  const s = ms / 1000
  if (s < 10) return `${s.toFixed(1)}s`
  if (s < 60) return `${Math.round(s)}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(Math.round(s % 60)).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export const at = (iso: string | null) => (iso ? Date.parse(iso) : NaN)
export const context = (k: WhyTokens) => k.input + k.cacheRead + k.cacheWrite
export const span = (s: WhyStep) => Math.max(0, s.end - s.start)
export const toolName = (s: ToolStep) => s.name.replace(/^mcp__(.+?)__/, '')
export const added = (s: ToolStep) => Math.ceil((s.resultChars ?? 0) / 4)

export function tookOf(h: WhyAgent): number {
  const d = at(h.handedBackAt ?? h.lastCallAt) - at(h.delegatedAt ?? h.firstCallAt)
  return Number.isFinite(d) ? Math.max(0, d) : 0
}

export function requestsOf(turn: WhyTurn): Request[] {
  const out: Request[] = []
  turn.steps.forEach((s, k) => {
    if (s.kind === 'model') out.push({ s, k, n: out.length + 1, tools: [] })
    else (out.find(r => r.k === s.parent) ?? out.at(-1))?.tools.push({ s, k })
  })
  return out
}

export type StoryKind = 'prompt' | 'model' | 'tools' | 'failed' | 'delegate' | 'compact' | 'idle' | 'answer' | 'helperDone'
export type StoryLine = { at: number; kind: StoryKind; text: string; step?: number }
export type Story = { header: string; lines: StoryLine[] }

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s)
const count = (key: string, n: number, vars: Record<string, string | number> = {}) => t(`${key}.${n === 1 ? 'one' : 'other'}`, { count: n, ...vars })
const d = formatStepDuration
export const offset = (ms: number) => `+${ms < 1 ? '0s' : d(ms)}`
const isSpawn = (s: ToolStep) => s.name === 'Agent' || s.name === 'Task'
const withLabel = (s: ToolStep) => (s.label ? `${toolName(s)} (${cut(s.label, 40)})` : toolName(s))

export function storyOf(turn: WhyTurn, idleMs: number): Story {
  const base = at(turn.ts)
  const lines: StoryLine[] = []
  const push = (line: StoryLine) => lines.push(line)
  if (turn.prompt.text) push({ at: 0, kind: 'prompt', text: t('sessions.why.story.prompt', { text: cut(turn.prompt.text, 80) }) })

  const reqs = requestsOf(turn)
  const answer = reqs.find(r => r.s.answer) ?? reqs.at(-1)
  const spawnsHere = turn.helpers.length > 0
  for (const r of reqs) {
    const ctx = context(r.s.tokens)
    const vars = { model: r.s.model, tokens: formatCompact(ctx), share: `${Math.round(r.s.cachedPct ?? (ctx ? r.s.tokens.cacheRead / ctx * 100 : 0))}%`, duration: d(span(r.s)) }
    const asked = r.s.toolCalls ?? r.tools.length
    push({
      at: r.s.start, kind: 'model', step: r.k,
      text: r === answer ? t('sessions.why.story.model.answer', vars) : asked ? count('sessions.why.story.model.tools', asked, vars) : t('sessions.why.story.model.none', vars),
    })
    let run: ToolRef[] = []
    const flush = () => {
      if (!run.length) return
      const first = run[0]!
      const took = d(Math.max(...run.map(x => x.s.end)) - Math.min(...run.map(x => x.s.start)))
      push({
        at: first.s.start, kind: 'tools', step: first.k,
        text: run.length === 1
          ? t('sessions.why.story.tool', { tool: withLabel(first.s), duration: took, tokens: formatCompact(added(first.s)) })
          : t('sessions.why.story.tools', { count: run.length, names: [...new Set(run.map(x => toolName(x.s)))].join(', '), duration: took }),
      })
      run = []
    }
    for (const x of r.tools) {
      if (spawnsHere && isSpawn(x.s)) continue
      if (!x.s.isError) { run.push(x); continue }
      flush()
      push({ at: x.s.start, kind: 'failed', step: x.k, text: t('sessions.why.story.failed', { tool: toolName(x.s), duration: d(span(x.s)) }) })
    }
    flush()
  }

  const ids = new Set(turn.helpers.map(h => h.id))
  for (const h of turn.helpers) {
    if (h.parentId && ids.has(h.parentId)) continue
    const k = turn.steps.findIndex(s => s.kind === 'tool' && s.detail?.helper?.id === h.id)
    const end = h.handedBackAt ? 'done' : h.state === 'running' ? 'running' : 'stopped'
    push({
      at: Math.max(0, at(h.delegatedAt ?? h.firstCallAt) - base) || 0, kind: 'delegate', ...(k >= 0 ? { step: k } : {}),
      text: t(`sessions.why.story.delegate.${end}`, {
        task: cut(h.task || h.description, 60), type: h.agentType || t('sessions.why.agents.helper'),
        requests: count('sessions.why.agents.requests', h.requests), tools: count('sessions.why.agents.toolCalls', h.toolCalls), duration: d(tookOf(h)),
      }),
    })
  }

  const models = turn.steps.map((s, k) => ({ s, k })).filter((x): x is { s: ModelStep; k: number } => x.s.kind === 'model')
  for (const c of turn.compactions ?? []) {
    const ms = at(c) - base
    const before = models.filter(x => x.s.end <= ms).at(-1)
    const after = models.find(x => x.s.start >= ms)
    push({
      at: ms, kind: 'compact', ...(after ? { step: after.k } : {}),
      text: before && after ? t('sessions.why.story.compact.sized', { from: formatCompact(context(before.s.tokens)), to: formatCompact(context(after.s.tokens)) }) : t('sessions.why.story.compact'),
    })
  }

  let cursor = 0
  turn.steps.forEach((s, k) => {
    if (s.start - cursor >= idleMs) push({ at: cursor, kind: 'idle', step: k, text: t('sessions.why.story.idle', { duration: d(s.start - cursor) }) })
    cursor = Math.max(cursor, s.end)
  })

  const answerAt = answer ? answer.s.end : 0
  if (answer) push({ at: answerAt, kind: 'answer', step: answer.k, text: t('sessions.why.story.answer', { duration: d(answerAt) }) })
  const helperEnd = Math.max(0, ...turn.helpers.map(h => at(h.handedBackAt ?? h.lastCallAt) - base).filter(Number.isFinite))
  const late = answer && helperEnd > answerAt
  if (late) push({ at: helperEnd, kind: 'helperDone', text: t('sessions.why.story.helperDone', { duration: d(helperEnd) }) })

  lines.sort((a, b) => a.at - b.at)
  const toolCalls = turn.steps.filter(s => s.kind === 'tool').length
  const header = [
    t('sessions.why.story.done', { duration: d(Math.max(turn.wallMs, helperEnd, cursor)) }) + (late ? ' ' + t('sessions.why.story.answerAt', { offset: d(answerAt) }) : ''),
    count('sessions.why.story.requests', turn.calls),
    count('sessions.why.agents.toolCalls', toolCalls),
    ...(turn.helpers.length ? [count('sessions.why.agents.topology', turn.helpers.length)] : []),
    t('sessions.why.agents.apiRates', { amount: formatUsd(turn.cost + turn.helperCost) }),
  ].join(' · ')
  return { header, lines }
}

export function storyMarkdown(story: Story): string {
  return [story.header, '', ...story.lines.map(l => `- ${offset(l.at)} ${l.text}`)].join('\n')
}
