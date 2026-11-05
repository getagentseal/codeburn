import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'

import { ChartTip } from '../components/ChartTip'
import { cliErrorDisplay } from '../components/CliErrorPanel'
import { Panel } from '../components/Panel'
import { SessionDetails } from '../components/SessionDrawer'
import { SegTabs } from '../components/SegTabs'
import { SectionSkeleton } from '../components/Skeleton'
import { Usd } from '../components/Usd'
import { Icon, type IconName } from '../components/icons'
import { t } from '../i18n'
import { formatAxisMoney, niceTicks } from '../lib/chartAxis'
import { formatCompact, formatDayLong, formatUsd, formatUsdDifference, shortenProjectPath } from '../lib/format'
import type { InvestigationFilters } from '../lib/investigation'
import { codeburn, normalizeCliError } from '../lib/ipc'
import { added, at, context, formatStepDuration, type ModelStep, offset, type Request, requestsOf, span, storyMarkdown, storyOf, type StoryKind, tookOf, type ToolRef, toolName } from '../lib/story'
import type { CliError, SessionDrillRow, SessionWhy, WhyAgent, WhyFinding, WhyParts, WhyPrWork, WhyStep, WhyTokens, WhyTurn } from '../lib/types'

/** Claude Code main sessions are `<uuid>.jsonl`; `--why` resolves only those. */
const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function hasSessionView(row: SessionDrillRow): boolean {
  return row.provider === 'claude' && !row.isSidechain && CLAUDE_SESSION_ID.test(row.sessionId)
}

const FINDINGS_SHOWN = 5

const pct = (p: number) => (p > 0 && p < 0.01 ? '<1%' : `${Math.round(p * 100)}%`)
const tok = (n: number) => formatCompact(Math.round(n))
const usdFine = (n: number) => (n > 0 && n < 0.01 ? `<${formatUsd(0.01)}` : formatUsd(n))
const plural = (key: string, count: number, vars: Record<string, string | number> = {}) => t(`${key}.${count === 1 ? 'one' : 'other'}`, { count, ...vars })
const one = (key: string, count: number) => `${key}.${count === 1 ? 'one' : 'other'}`

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function describeHelpers(descs: string[]): string {
  const m = descs.map(d => /^(.*?)(\d+)$/.exec(d))
  if (descs.length > 1 && m.every(x => x && x[1] === m[0]![1])) {
    const nums = m.map(x => Number(x![2])).sort((a, b) => a - b)
    if (nums.every((n, i) => i === 0 || n === nums[i - 1]! + 1)) return `'${m[0]![1]}${nums[0]}–${nums.at(-1)}'`
  }
  const uniq = [...new Set(descs)]
  return uniq.slice(0, 2).map(d => `'${d}'`).join(', ') + (uniq.length > 2 ? ` +${uniq.length - 2}` : '')
}

const PART_KEYS = ['output', 'cacheRead', 'cacheWrite', 'input', 'webSearch'] as const

function partsLine(p: WhyParts, tk: WhyTokens, calls: number): string {
  const tokensOf = { output: tk.output, cacheRead: tk.cacheRead, cacheWrite: tk.cacheWrite, input: tk.input, webSearch: 0 }
  const text = PART_KEYS
    .filter(k => p[k] >= 0.005)
    .sort((a, b) => p[b] - p[a])
    .map(k => t(k === 'cacheRead' ? one('sessions.why.part.cacheRead', calls) : `sessions.why.part.${k}`, { amount: formatUsd(p[k]), tokens: tok(tokensOf[k]), calls }))
    .join(t('sessions.why.part.sep'))
  return text ? text.charAt(0).toUpperCase() + text.slice(1) + t('sessions.why.part.end') : ''
}

type Line = { text: string; save?: boolean }
type FindingCopy = { title: string; lines: Line[]; chip: string }

function altLine(f: { alt: { model: string; cost: number } | null; usd: number | null }, what: 'helpers' | 'prompt' | 'steps'): Line[] {
  if (!f.alt) return []
  return [{ text: t(`sessions.why.alt.${what}`, { model: f.alt.model, amount: formatUsd(f.alt.cost), saved: formatUsdDifference(f.usd ?? 0, f.alt.cost) }), save: true }]
}

function findingCopy(f: WhyFinding, why: SessionWhy): FindingCopy {
  const chip = t(`sessions.why.kind.${f.kind}`)
  const amount = formatUsd(f.usd ?? 0)
  switch (f.kind) {
    case 'helpers': {
      const head = f.direct > 0
        ? plural('sessions.why.f.helpers.title', f.direct, { turn: f.turn ?? 0, models: f.models.join('/'), desc: f.descriptions.length ? ` (${describeHelpers(f.descriptions)})` : '' })
        : plural('sessions.why.f.helpers.looseOnly', f.loose, { turn: f.turn ?? 0 })
      const more = (f.nested ? t('sessions.why.f.helpers.nested', { count: f.nested }) : '') + (f.direct > 0 && f.loose ? t('sessions.why.f.helpers.loose', { count: f.loose }) : '')
      const range = f.minCalls === f.maxCalls ? String(f.minCalls) : `${f.minCalls}–${f.maxCalls}`
      return {
        chip,
        title: head + more + t('sessions.why.f.helpers.total', { amount }),
        lines: [
          { text: partsLine(f.parts, f.tokens, f.calls) },
          { text: t(one('sessions.why.f.helpers.calls', range === '1' ? 1 : 2), { range, tokens: tok(f.tokens.cacheRead / Math.max(1, f.calls)) }) },
          ...altLine(f, 'helpers'),
        ],
      }
    }
    case 'hotspot': {
      const mult = f.median > 0 ? (f.usd ?? 0) / f.median : 0
      const vars = { turn: f.turn ?? 0, calls: f.calls, models: f.models.join('/'), amount }
      return {
        chip,
        title: mult >= 2
          ? t(one('sessions.why.f.hotspot.title', f.calls), { ...vars, mult: Math.round(mult), median: formatUsd(f.median) })
          : t(one('sessions.why.f.hotspot.titleShare', f.calls), { ...vars, share: pct(f.share ?? 0) }),
        lines: [
          { text: partsLine(f.parts, f.tokens, f.calls) },
          ...(f.toolCalls ? [{ text: t(one('sessions.why.f.hotspot.tools', f.calls), { tools: f.toolCalls, calls: f.calls }) }] : []),
          ...altLine(f, 'prompt'),
        ],
      }
    }
    case 'coordination': {
      const turn = why.turns[(f.turn ?? 1) - 1]
      return {
        chip,
        title: t('sessions.why.f.coordination.title', { turn: f.turn ?? 0, tools: f.toolCalls, calls: f.calls, model: f.model, amount }),
        lines: [...(turn ? [{ text: partsLine(f.parts, turn.tokens, turn.calls) }] : []), ...altLine(f, 'steps')],
      }
    }
    case 'reread':
      return {
        chip,
        title: t('sessions.why.f.reread.title', { amount, share: pct(f.share ?? 0) }),
        lines: [{ text: t('sessions.why.f.reread.line', { calls: f.calls, tokens: tok(f.avgTokens) }) }, { text: t('sessions.why.f.reread.lever') }],
      }
    case 'failed': {
      if (f.userStopped) return { chip, title: t('sessions.why.f.failed.stopped', { tool: f.tool }), lines: [] }
      const what = (f.description || f.label).slice(0, 80)
      const title = f.tool === 'Bash'
        ? f.error.exitCode !== null ? t('sessions.why.f.failed.commandExit', { what, code: f.error.exitCode }) : t('sessions.why.f.failed.command', { what })
        : t('sessions.why.f.failed.tool', { tool: f.label ? `${f.tool} (${f.label})` : f.tool })
      return {
        chip,
        title,
        lines: [
          { text: f.error.cause ? t('sessions.why.f.failed.ended', { cause: f.error.cause + (f.error.location ? ` (${f.error.location})` : '') }) : t('sessions.why.f.failed.noCause') },
          ...(f.error.secondary.length ? [{ text: t('sessions.why.f.failed.also', { lines: f.error.secondary.slice(-2).join('; ') }) }] : []),
          ...(f.afterCalls !== null ? [{ text: plural('sessions.why.f.failed.after', f.afterCalls, { amount }) }] : []),
        ],
      }
    }
    case 'carry':
      return {
        chip,
        title: f.source === 'paste'
          ? t(one('sessions.why.f.carry.paste', f.calls), { chars: f.chars.toLocaleString(), tokens: tok(f.tokens), calls: f.calls })
          : t(one('sessions.why.f.carry.tool', f.calls), { tool: f.tool, chars: f.chars.toLocaleString(), tokens: tok(f.tokens), calls: f.calls }),
        lines: [
          { text: (f.label ? `“${f.label}”. ` : '') + t(one('sessions.why.f.carry.line', f.calls - 1), { write: formatUsd(f.writeUsd), later: f.calls - 1, read: formatUsd(f.readUsd), amount }) },
          { text: t('sessions.why.f.carry.lever') },
        ],
      }
    case 'prefix':
      return {
        chip,
        title: t('sessions.why.f.prefix.title', { tokens: tok(f.tokens) }),
        lines: [
          { text: t(one('sessions.why.f.prefix.line', f.laterCalls), { uncached: tok(f.uncached), write: formatUsd(f.writeUsd), readCalls: f.readCalls, laterCalls: f.laterCalls, tokens: tok(f.cached), read: formatUsd(f.readUsd) }) },
          { text: t('sessions.why.f.prefix.lever') },
        ],
      }
    case 'idle':
      return { chip, title: t(f.endedBy === 'helper' ? 'sessions.why.f.idle.titleHelpers' : 'sessions.why.f.idle.title', { turn: f.turn ?? 0, duration: formatStepDuration(f.timeMs) }), lines: [{ text: t(`sessions.why.f.idle.${f.endedBy}`) }] }
    case 'slowCall':
      return { chip, title: t('sessions.why.f.slowCall.title', { turn: f.turn ?? 0, model: f.model, duration: formatStepDuration(f.timeMs) }), lines: [{ text: t('sessions.why.f.slowCall.line', { tokens: tok(f.outputTokens) }) }] }
  }
}

function verdict(why: SessionWhy): string {
  const top = why.findings.find(f => (f.usd ?? 0) > 0)
  const failed = why.findings.filter(f => f.kind === 'failed' && !f.userStopped).length
  const tail = failed ? ' ' + plural('sessions.why.verdict.failed', failed) : ''
  if (!top) return t('sessions.why.verdict.none') + tail
  const vars = { turn: top.turn ?? 0, amount: formatUsd(top.usd ?? 0), share: pct(top.share ?? 0) }
  if (top.kind === 'helpers' || top.kind === 'hotspot' || top.kind === 'reread') return t(`sessions.why.verdict.${top.kind}`, vars) + tail
  return t('sessions.why.verdict.other', { title: findingCopy(top, why).title }) + tail
}

const severity = (f: WhyFinding) => (f.kind === 'failed' && !f.userStopped ? 'bad' : f.kind === 'idle' || f.kind === 'slowCall' || f.kind === 'failed' ? 'info' : 'warn')
const isEstimate = (f: WhyFinding) => f.kind === 'carry' || f.kind === 'prefix'

function FindingFigure({ f }: { f: WhyFinding }) {
  if (f.usd === null) {
    return (
      <div className="sv-fd-num">
        <b>{'timeMs' in f ? formatStepDuration(f.timeMs) : '—'}</b>
        <span>{t('sessions.why.share.timeOnly')}</span>
      </div>
    )
  }
  return (
    <div className="sv-fd-num">
      <b>{isEstimate(f) ? '≈' : ''}{formatUsd(f.usd)}</b>
      {f.share !== null && <span>{t(f.kind === 'helpers' ? 'sessions.why.share.withHelpers' : 'sessions.why.share.session', { share: pct(f.share) })}</span>}
    </div>
  )
}

function FindingRow({ f, why, lead, onJump }: { f: WhyFinding; why: SessionWhy; lead: boolean; onJump: (turn: number, step?: number) => void }) {
  const copy = findingCopy(f, why)
  return (
    <div className={`sv-fd ${severity(f)}${lead ? ' lead' : ''}`}>
      <div className="sv-fd-body">
        <div className="sv-fd-title">
          <i className={`sv-dot ${severity(f)}`} aria-hidden="true" />
          <span>{copy.title}</span>
          {isEstimate(f) && <span className="sv-pill">{t('sessions.why.findings.estimate')}</span>}
        </div>
        {copy.lines.filter(l => l.text).map((l, i) => <p key={i} className={l.save ? 'sv-fd-line save' : 'sv-fd-line'}>{l.text}</p>)}
      </div>
      <FindingFigure f={f} />
      {f.turn
        ? <button type="button" className="sv-jump" onClick={() => onJump(f.turn!, f.step)}>{t('sessions.why.findings.jump', { turn: f.turn })}<Icon name="chevron-right" /></button>
        : <span />}
    </div>
  )
}

function SpendChart({ why, flagged, selected, onSelect }: { why: SessionWhy; flagged: Set<number>; selected: number | null; onSelect: (turn: number) => void }) {
  const [tip, setTip] = useState<{ x: number; y: number; turn: WhyTurn } | null>(null)
  const peak = Math.max(...why.turns.map(x => x.cost + x.helperCost), 0)
  const ticks = niceTicks(peak, 3)
  const top = ticks.at(-1) || 1
  return (
    <div className={why.turns.length > 40 ? 'sv-chart dense' : 'sv-chart'}>
      <div className="sv-chart-plot">
        <div className="sv-chart-grid" aria-hidden="true">
          {ticks.map(v => <div key={v} className="sv-grid-line" style={{ bottom: `${v / top * 100}%` }}><span>{formatAxisMoney(v)}</span></div>)}
        </div>
        <div className="sv-bars">
          {why.turns.map(turn => (
            <button
              key={turn.i}
              type="button"
              className={`sv-bar${flagged.has(turn.i) ? ' flag' : ''}${selected === turn.i ? ' sel' : ''}`}
              aria-label={t('sessions.why.chart.barLabel', { turn: turn.i, amount: formatUsd(turn.cost + turn.helperCost) })}
              onClick={() => onSelect(turn.i)}
              onMouseMove={e => setTip({ x: e.clientX, y: e.clientY, turn })}
              onMouseLeave={() => setTip(null)}
            >
              <i className="own" style={{ height: `${turn.cost / top * 100}%` }} />
              {turn.helperCost > 0 && <i className="sub" style={{ height: `${turn.helperCost / top * 100}%` }} />}
            </button>
          ))}
        </div>
      </div>
      <div className="sv-ticks" aria-hidden="true">{why.turns.map(turn => <span key={turn.i}>{why.turns.length <= 40 || turn.i % 5 === 0 ? turn.i : ''}</span>)}</div>
      <div className="sv-legend">
        <span><i className="own" />{t('sessions.why.chart.session')}</span>
        {why.helperCount > 0 && <span><i className="sub" />{t('sessions.why.chart.helpers')}</span>}
        <span><i className="flag" />{t('sessions.why.chart.flagged')}</span>
      </div>
      {tip && (
        <ChartTip x={tip.x} y={tip.y}>
          <div className="chart-tip-d">{t('sessions.why.findings.jump', { turn: tip.turn.i })} · {clock(tip.turn.ts)}</div>
          <div className="chart-tip-v">{formatUsd(tip.turn.cost + tip.turn.helperCost)}</div>
          {tip.turn.helperCost > 0 && (
            <>
              <div className="chart-tip-row"><i className="chart-tip-sw hi" /><span>{t('sessions.why.chart.session')}</span><b>{formatUsd(tip.turn.cost)}</b></div>
              <div className="chart-tip-row"><i className="chart-tip-sw" /><span>{t('sessions.why.chart.helpers')}</span><b>{formatUsd(tip.turn.helperCost)}</b></div>
            </>
          )}
        </ChartTip>
      )}
    </div>
  )
}

function SplitRows({ step }: { step: Extract<WhyStep, { kind: 'model' }> }) {
  const rows: Array<[string, number, number]> = [
    [t('sessions.why.split.input'), step.parts.input, step.tokens.input],
    [t('sessions.why.split.cacheRead'), step.parts.cacheRead, step.tokens.cacheRead],
    [t('sessions.why.split.cacheWrite'), step.parts.cacheWrite, step.tokens.cacheWrite],
    [t('sessions.why.split.output'), step.parts.output, step.tokens.output],
  ]
  return (
    <div className="usd-pop sv-split">
      {rows.map(([label, cost, n]) => <div key={label} className="usd-pop-row"><span>{label} · {tok(n)}</span><b>{usdFine(cost)}</b></div>)}
      <div className="usd-pop-row calls"><span>{t('sessions.why.split.total')}</span><b>{usdFine(step.cost)}</b></div>
    </div>
  )
}

function Pre({ text, mark, tail = false }: { text: string; mark?: (line: string) => string; tail?: boolean }) {
  return (
    <pre className="sv-pre" ref={el => { if (el && tail) { const hl = el.querySelector('.hl') as HTMLElement | null; el.scrollTop = hl ? Math.max(0, hl.offsetTop - 48) : el.scrollHeight } }}>
      {text.split('\n').map((line, i) => <div key={i} className={mark?.(line) || undefined}>{line || ' '}</div>)}
    </pre>
  )
}

const diffMark = (l: string) => (l.startsWith('@@') || l.startsWith('… ') ? 'dim' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : '')

function StepDetail({ step }: { step: WhyStep }) {
  if (step.kind === 'model') {
    return (
      <div className="sv-sd">
        <div className="sv-sd-head"><b>{t('sessions.why.step.model')}</b><span className="mono">{step.model}</span><span className="r">{formatStepDuration(step.end - step.start)}</span></div>
        <SplitRows step={step} />
      </div>
    )
  }
  const d = step.detail
  const head = (title: string, sub?: string) => <div className="sv-sd-head"><b>{title}</b>{sub && <span className="mono">{sub}</span>}<span className="r">{formatStepDuration(step.end - step.start)}</span></div>
  const err = step.error
  const errLine = err && (err.cause || err.exitCode !== null)
    ? <p className="sv-sd-err">{[err.exitCode !== null ? t('sessions.why.step.exit', { code: err.exitCode }) : '', err.cause ?? ''].filter(Boolean).join(' · ')}</p>
    : null
  const causeMark = (l: string) => (err?.cause && l.trim() === err.cause ? 'hl' : '')
  if (!d) return <div className="sv-sd">{head(step.name, step.label)}<p className="sv-sd-desc">{t('sessions.why.step.omitted')}</p></div>
  if (step.name === 'Bash') {
    return (
      <div className="sv-sd">
        {head(t('sessions.why.step.command'))}
        {d.description && <p className="sv-sd-desc">{d.description}</p>}
        {errLine}
        <Pre text={d.command ?? ''} />
        <div className="sv-sd-sub">{t('sessions.why.step.output')}</div>
        <Pre text={d.output || t('sessions.why.step.noOutput')} mark={causeMark} tail />
      </div>
    )
  }
  if (d.helper) {
    return (
      <div className="sv-sd">
        {head(t('sessions.why.step.helper'), d.helper.description)}
        <p className="sv-sd-desc">{t(one('sessions.why.step.helperFacts', d.helper.calls), { type: d.helper.agentType || '—', models: d.helper.models.join(', ') || '—', calls: d.helper.calls, amount: formatUsd(d.helper.cost) })}</p>
      </div>
    )
  }
  if (step.name === 'Edit' || step.name === 'MultiEdit' || step.name === 'Write') {
    return (
      <div className="sv-sd">
        {head(step.name === 'Write' ? t('sessions.why.step.write', { count: d.lines ?? 0 }) : t('sessions.why.step.edit'), d.path)}
        {errLine}
        {d.diff ? <Pre text={d.diff} mark={diffMark} /> : null}
        {d.output && <Pre text={d.output} mark={causeMark} tail />}
      </div>
    )
  }
  if (step.name === 'Read') {
    return (
      <div className="sv-sd">
        {head(step.name, d.path)}
        {errLine}
        {d.lines !== undefined && <p className="sv-sd-desc">{t('sessions.why.step.read', { count: d.lines })}</p>}
        {d.output && <Pre text={d.output} mark={causeMark} tail />}
      </div>
    )
  }
  return (
    <div className="sv-sd">
      {head(step.name, step.label)}
      {errLine}
      <div className="sv-sd-sub">{t('sessions.why.step.input')}</div>
      <Pre text={d.input ?? ''} />
      <div className="sv-sd-sub">{t('sessions.why.step.result')}</div>
      <Pre text={d.output || t('sessions.why.step.noOutput')} mark={causeMark} tail />
    </div>
  )
}

type Insight = { key: string; label: string; value: string; pill: string; step: number; tone?: 'top' | 'bad'; flag: boolean }

function insightsOf(turn: WhyTurn, reqs: Request[], rules: SessionWhy['rules']): Insight[] {
  if (!reqs.length) return []
  const reqPill = (r: Request) => t('sessions.why.inspect.request', { n: r.n })
  const tools = reqs.flatMap(r => r.tools)
  const slow = reqs.reduce((a, b) => (span(b.s) > span(a.s) ? b : a))
  const dear = reqs.reduce((a, b) => (b.s.cost > a.s.cost ? b : a))
  const rows: Insight[] = [
    { key: 'slowest', label: t('sessions.why.inspect.slowest'), value: formatStepDuration(span(slow.s)), pill: reqPill(slow), step: slow.k, flag: span(slow.s) >= rules.slowCallMs },
    { key: 'costliest', label: t('sessions.why.inspect.costliest'), value: t('sessions.why.inspect.costValue', { amount: usdFine(dear.s.cost), share: pct(turn.cost > 0 ? dear.s.cost / turn.cost : 0) }), pill: reqPill(dear), step: dear.k, tone: 'top', flag: false },
  ]
  const big = tools.reduce<ToolRef | null>((a, b) => (added(b.s) > (a ? added(a.s) : 0) ? b : a), null)
  if (big) rows.push({ key: 'context', label: t('sessions.why.inspect.context'), value: t('sessions.why.inspect.contextValue', { tokens: tok(added(big.s)) }), pill: toolName(big.s), step: big.k, flag: added(big.s) >= rules.carryTokens })
  if (tools.length) {
    const asked = reqs.filter(r => r.tools.length)
    const widest = asked.reduce((a, b) => (b.tools.length > a.tools.length ? b : a))
    rows.push(asked.length === tools.length
      ? { key: 'tools', label: t('sessions.why.inspect.toolCalls'), value: plural('sessions.why.inspect.sequential', tools.length), pill: reqPill(widest), step: widest.k, flag: false }
      : { key: 'tools', label: t('sessions.why.inspect.toolCalls'), value: t(one('sessions.why.inspect.batches', asked.length), { count: tools.length, batches: asked.length }), pill: t('sessions.why.inspect.batchPill', { request: reqPill(widest), count: widest.tools.length }), step: widest.k, flag: false })
  }
  const failed = tools.filter(x => x.s.isError)
  if (failed.length) rows.push({ key: 'problems', label: t('sessions.why.inspect.problems'), value: plural('sessions.why.inspect.failed', failed.length), pill: toolName(failed[0]!.s), step: failed[0]!.k, tone: 'bad', flag: true })
  return rows.sort((a, b) => Number(b.flag) - Number(a.flag)).slice(0, 5)
}

function roleOf(r: Request): string {
  if (r.tools.length) return plural('sessions.why.inspect.role.tools', r.tools.length)
  return t(r.s.answer ? 'sessions.why.inspect.role.answer' : 'sessions.why.inspect.role.none')
}

function TurnDetail({ turn, findings, why, openStep, onStep, seg }: { turn: WhyTurn; findings: WhyFinding[]; why: SessionWhy; openStep: number | null; onStep: (k: number | null) => void; seg?: ReactNode }) {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState('all')
  const [newest, setNewest] = useState(true)
  const reqs = requestsOf(turn)
  const longest = Math.max(1, ...turn.steps.map(span))
  const tk = turn.tokens
  const toggle = (k: number) => onStep(openStep === k ? null : k)
  const detail = (k: number) => openStep === k && <StepDetail step={turn.steps[k]!} />
  const q = query.trim().toLowerCase()
  const hit = (...xs: string[]) => xs.some(x => x.toLowerCase().includes(q))
  const shown = reqs.map(r => {
    const head = !q || hit(t('sessions.why.inspect.request', { n: r.n }), r.s.model)
    return { r, head, tools: r.tools.filter(x => head || hit(x.s.name, x.s.label)) }
  }).filter(x => x.head || x.tools.length)
  if (newest) shown.reverse()
  const toolRow = ({ s, k }: ToolRef) => (
    <Fragment key={k}>
      <button type="button" className={`sv-rq-tool${s.isError ? ' err' : ''}${openStep === k ? ' sel' : ''}`} aria-expanded={openStep === k} onClick={() => toggle(k)}>
        <span className="nm">{toolName(s)}</span>
        <span className="lb">{s.name === 'Bash' ? s.label.slice(0, 60) : s.label}</span>
        <span className="tg">
          {s.isError && <span className="sv-pill bad">{t('sessions.why.kind.failed')}</span>}
          {s.parallel && <span className="sv-pill">{t('sessions.why.inspect.parallel', { index: s.parallel.index, of: s.parallel.of })}</span>}
        </span>
        <span className="tk">{added(s) > 0 ? `+${tok(added(s))}` : ''}</span>
        <span className="du">{formatStepDuration(span(s))}</span>
      </button>
      {detail(k)}
    </Fragment>
  )
  return (
    <div className="sv-td">
      {seg}
      {turn.prompt.text && <p className="sv-td-prompt">{turn.prompt.text}</p>}
      <p className="sv-td-sum">
        {plural('sessions.why.inspect.summary', turn.calls, { duration: formatStepDuration(turn.wallMs), amount: formatUsd(turn.cost), tokens: tok(tk.input + tk.cacheRead + tk.cacheWrite), reread: tok(tk.cacheRead), fresh: tok(tk.input + tk.cacheWrite), out: tok(tk.output) })}
        {turn.helperCost > 0 && ' ' + t('sessions.why.turn.helpers', { amount: formatUsd(turn.helperCost) })}
      </p>
      {findings.length > 0 && (
        <ul className="sv-td-flags">
          {findings.map(f => <li key={f.id}><i className={`sv-dot ${severity(f)}`} aria-hidden="true" />{findingCopy(f, why).title}</li>)}
        </ul>
      )}
      {reqs.length > 0 && (
        <div className="sv-ins">
          {insightsOf(turn, reqs, why.rules).map(row => (
            <button key={row.key} type="button" className="sv-ins-row" onClick={() => onStep(row.step)}>
              <span className="lb">{row.label}</span>
              <b className={row.tone}>{row.value}</b>
              <span className="sv-pill">{row.pill}</span>
            </button>
          ))}
        </div>
      )}
      {reqs.length > 0 && (
        <div className="sv-rq-bar">
          <input className="sessions-search" type="search" aria-label={t('sessions.why.inspect.search')} placeholder={t('sessions.why.inspect.search')} value={query} onChange={e => setQuery(e.target.value)} />
          <SegTabs options={[{ value: 'all', label: t('sessions.why.inspect.all') }, { value: 'model', label: t('sessions.why.lane.model') }, { value: 'tools', label: t('sessions.why.lane.tools') }]} value={mode} onChange={setMode} />
          <button type="button" className="sv-jump" onClick={() => setNewest(!newest)}>{t(newest ? 'sessions.why.inspect.newest' : 'sessions.why.inspect.oldest')}</button>
        </div>
      )}
      {reqs.length > 0 && !shown.length && <p className="sv-note">{t('sessions.why.inspect.noMatch')}</p>}
      {turn.truncatedSteps ? <p className="sv-note">{plural('sessions.why.step.truncated', turn.truncatedSteps)}</p> : null}
      {mode === 'tools'
        ? shown.some(x => x.tools.length) && <div className="sv-rq">{shown.flatMap(x => (newest ? [...x.tools].reverse() : x.tools).map(toolRow))}</div>
        : (
          <div className="sv-rq-list">
            {shown.map(({ r, tools }) => (
              <div key={r.k} className={`sv-rq${openStep === r.k ? ' sel' : ''}`}>
                <button type="button" className="sv-rq-head" aria-expanded={openStep === r.k} onClick={() => toggle(r.k)}>
                  <span className="ti"><b>{t('sessions.why.inspect.request', { n: r.n })}</b><span>{r.s.model}</span></span>
                  <span className="pl">
                    <span className="sv-pill">{usdFine(r.s.cost)}</span>
                  </span>
                  <span className="mt">
                    {t('sessions.why.inspect.tokens', { in: tok(r.s.tokens.input + r.s.tokens.cacheRead + r.s.tokens.cacheWrite), out: tok(r.s.tokens.output), cached: r.s.cachedPct == null ? '—' : `${Math.round(r.s.cachedPct)}%` })}
                    {' · '}{roleOf(r)}
                  </span>
                  <span className="du"><i><b style={{ width: `${span(r.s) / longest * 100}%` }} /></i>{formatStepDuration(span(r.s))}</span>
                </button>
                {detail(r.k)}
                {mode === 'all' && tools.length > 0 && <div className="sv-rq-tools">{tools.map(toolRow)}</div>}
              </div>
            ))}
          </div>
        )}
    </div>
  )
}

const KIND_SEGMENTS = [['read', 'cacheRead', 'flagship'], ['written', 'cacheWrite', 'premium'], ['new', 'input', 'fast'], ['out', 'output', 'balanced']] as const
const AGENT_TONES = ['flagship', 'premium', 'balanced', 'fast', 'other']

function statsLine(took: number, requests: number, tools: number, tk: WhyTokens, cost: number): string {
  return [formatStepDuration(took), plural('sessions.why.agents.requests', requests), plural('sessions.why.agents.toolCalls', tools),
    t('sessions.why.agents.in', { tokens: tok(context(tk)) }), t('sessions.why.agents.out', { tokens: tok(tk.output) }), formatUsd(cost)].join(' · ')
}

function Segments({ items, className }: { items: Array<{ key: string; tone: string; value: number; label: string }>; className: string }) {
  const total = items.reduce((s, x) => s + x.value, 0)
  return (
    <span className={className} aria-hidden="true">
      {total > 0 && items.filter(x => x.value > 0).map(x => <i key={x.key} className={x.tone} title={x.label} style={{ flexGrow: x.value / total }} />)}
    </span>
  )
}

export function costByAgent(turn: WhyTurn): { main: number; helpers: Array<{ h: WhyAgent; cost: number }>; handBacks: number } {
  const readBy = (id: string | null) => turn.helpers.filter(h => h.parentId === id).reduce((s, h) => s + h.handBackCost, 0)
  return {
    main: turn.cost - readBy(null),
    helpers: turn.helpers.map(h => ({ h, cost: h.cost - readBy(h.id) })),
    handBacks: turn.helpers.reduce((s, h) => s + h.handBackCost, 0),
  }
}

function treeOf(hs: WhyAgent[]): Array<{ h: WhyAgent; depth: number }> {
  const ids = new Set(hs.map(h => h.id))
  const out: Array<{ h: WhyAgent; depth: number }> = []
  const walk = (parent: string | null, depth: number) => hs
    .filter(h => (h.parentId && ids.has(h.parentId) ? h.parentId : null) === parent)
    .forEach(h => { out.push({ h, depth }); walk(h.id, depth + 1) })
  walk(null, 0)
  return out
}

const agentName = (h: WhyAgent) => h.agentType || t('sessions.why.agents.helper')

function Lifecycle({ h }: { h: WhyAgent }) {
  const base = at(h.delegatedAt ?? h.firstCallAt)
  const off = (iso: string | null) => (Number.isFinite(at(iso) - base) ? `+${formatStepDuration(at(iso) - base)}` : '—')
  const reqs = h.steps.filter((s): s is ModelStep => s.kind === 'model')
  const first = reqs[0]?.tokens
  const peak = Math.max(1, ...reqs.map(s => context(s.tokens) + s.tokens.output))
  const inputs = reqs.map(s => tok(context(s.tokens)))
  const legend = KIND_SEGMENTS.map(([key]) => t(`sessions.why.agents.legend.${key}`))
  const stages: Array<{ key: string; offset: string; body: ReactNode }> = [
    { key: 'delegate', offset: h.delegatedAt ? '+0s' : '—', body: <p>{t('sessions.why.agents.delegate', { tokens: tok(h.taskTokensEst) })}</p> },
    { key: 'initialize', offset: off(h.firstCallAt), body: first && <p>{t('sessions.why.agents.initialize', { tokens: tok(context(first)), written: tok(first.cacheWrite) })}</p> },
    {
      key: 'run', offset: off(h.lastCallAt), body: (
        <>
          <p>{[plural('sessions.why.agents.requests', h.requests), plural('sessions.why.agents.toolCalls', h.toolCalls), t('sessions.why.agents.cached', { share: pct(context(h.tokens) > 0 ? h.tokens.cacheRead / context(h.tokens) : 0) })].join(', ')}</p>
          {h.truncatedSteps ? <p className="sv-note">{plural('sessions.why.step.truncated', h.truncatedSteps)}</p> : null}
          <span className="sv-lc-bars" aria-hidden="true">
            {reqs.map((s, j) => (
              <span key={j} style={{ height: `${(context(s.tokens) + s.tokens.output) / peak * 100}%` }}>
                {KIND_SEGMENTS.map(([key, part, tone]) => <i key={key} className={tone} style={{ flexGrow: s.tokens[part] }} />)}
              </span>
            ))}
          </span>
          <span className="sv-lc-legend">{legend.map((l, n) => <span key={l}><i className={KIND_SEGMENTS[n]![2]} />{l}</span>)}</span>
          {inputs.length > 0 && <p className="mono">{inputs.slice(0, 4).join(' → ') + (inputs.length > 4 ? ' → …' : '')}</p>}
        </>
      ),
    },
    {
      key: 'handBack', offset: off(h.handedBackAt), body: h.handedBackAt
        ? <><p>{t('sessions.why.agents.report', { tokens: tok(h.reportTokensEst) })}</p>{h.handedBackIn !== null && <p>{t('sessions.why.agents.readIn', { n: h.handedBackIn })}</p>}</>
        : <p>{t(`sessions.why.agents.noReport.${h.state === 'running' ? 'running' : 'stopped'}`)}</p>,
    },
    {
      key: 'cost', offset: `+${formatStepDuration(tookOf(h))}`, body: (
        <>
          <p>{t('sessions.why.agents.apiRates', { amount: formatUsd(h.cost) })}</p>
          <Segments className="sv-lc-kind" items={KIND_SEGMENTS.map(([key, part, tone], n) => ({ key, tone, value: h.parts[part], label: legend[n]! }))} />
          {h.cacheSaving > 0 && <p>{t('sessions.why.agents.saved', { amount: usdFine(h.cacheSaving) })}</p>}
        </>
      ),
    },
  ]
  return (
    <ol className="sv-lc">
      {stages.map(x => (
        <li key={x.key} data-stage={x.key}>
          <span className="pt"><b>{t(`sessions.why.agents.stage.${x.key}`)}</b><span className="off">{x.offset}</span></span>
          <div className="dt">{x.body}</div>
        </li>
      ))}
    </ol>
  )
}

function AgentsView({ turn, why, seg }: { turn: WhyTurn; why: SessionWhy; seg: ReactNode }) {
  const [open, setOpen] = useState<string | null>(null)
  const [step, setStep] = useState<number | null>(null)
  const tree = treeOf(turn.helpers)
  const nested = tree.some(x => x.depth > 0)
  const split = costByAgent(turn)
  const total = turn.cost + turn.helperCost
  const share = (v: number) => pct(total > 0 ? v / total : 0)
  const rows = [
    { key: 'main', tone: 'main', label: t('sessions.why.agents.main'), value: split.main },
    ...split.helpers.map(({ h, cost }, n) => ({ key: h.id, tone: AGENT_TONES[n % AGENT_TONES.length]!, label: `${agentName(h)} · ${h.description}`, value: cost })),
    { key: 'handBacks', tone: 'back', label: t('sessions.why.agents.byAgent.handBacks'), value: split.handBacks },
  ]
  const byType = new Map<string, number>()
  for (const h of turn.helpers) byType.set(agentName(h), (byType.get(agentName(h)) ?? 0) + h.cost)
  return (
    <div className="sv-td">
      {seg}
      <div className="sv-ag-topo">
        <b>{plural('sessions.why.agents.topology', turn.helpers.length)}</b>
        {nested
          ? <ul className="sv-ag-tree">{tree.map(({ h, depth }) => <li key={h.id} data-depth={depth} style={{ paddingLeft: depth * 16 }}>{agentName(h)} <span>{h.description}</span></li>)}</ul>
          : <span>{tree.map(x => agentName(x.h)).join(' · ')}</span>}
      </div>
      <p className="sv-ag-main"><b>{t('sessions.why.agents.main')}</b> <span>{[turn.models.join('/'), statsLine(turn.wallMs, turn.calls, turn.steps.filter(s => s.kind === 'tool').length, turn.tokens, turn.cost)].filter(Boolean).join(' · ')}</span></p>
      {tree.map(({ h }) => (
        <div key={h.id} className="sv-ag" data-agent={h.id}>
          <div className="sv-ag-head">
            <span className="ti"><b>{agentName(h)}</b><span>{h.description}</span></span>
            <span className={`sv-pill ${h.state}`}>{t(`sessions.why.agents.state.${h.state}`)}</span>
            <button type="button" className="sv-jump" aria-expanded={open === h.id} onClick={() => { setOpen(open === h.id ? null : h.id); setStep(null) }}>{t('sessions.why.view.inspect')}<Icon name="chevron-right" /></button>
          </div>
          {h.task && <p className="sv-ag-task">{h.task}</p>}
          <p className="sv-ag-stats">{statsLine(tookOf(h), h.requests, h.toolCalls, h.tokens, h.cost)}</p>
          <Lifecycle h={h} />
          {open === h.id && (
            <TurnDetail
              turn={{ ...turn, ts: h.delegatedAt ?? turn.ts, prompt: { text: '', kind: 'text' }, cost: h.cost, parts: h.parts, tokens: h.tokens, calls: h.requests, models: h.models, helperCost: 0, helpers: [], wallMs: tookOf(h), steps: h.steps, truncatedSteps: h.truncatedSteps }}
              findings={[]} why={why} openStep={step} onStep={setStep}
            />
          )}
        </div>
      ))}
      <div className="sv-ag-cost">
        <div className="sv-ag-cost-head"><b>{t('sessions.why.agents.byAgent.title')}</b><span>{formatUsd(total)}</span></div>
        <Segments className="sv-ag-bar" items={rows} />
        {rows.filter(r => r.key !== 'handBacks' || r.value > 0).map(r => (
          <div key={r.key} className="sv-ag-row" data-row={r.key}>
            <i className={r.tone} aria-hidden="true" />
            <span>{r.label}</span>
            <b>{r.key === 'handBacks' ? '≈' : ''}{usdFine(r.value)}</b>
            <span className="pc">{share(r.value)}</span>
          </div>
        ))}
        <p className="sv-ag-type">{t('sessions.why.agents.byAgent.byType', { list: [...byType].map(([k, v]) => `${k} ${formatUsd(v)}`).join(' · ') })}</p>
      </div>
    </div>
  )
}

const STORY_GLYPHS: Record<StoryKind, IconName> = {
  prompt: 'arrow-right', model: 'sparkles', tools: 'zap', failed: 'triangle-alert', delegate: 'arrow-up-right',
  compact: 'box', idle: 'circle', answer: 'circle-check', helperDone: 'arrow-down',
}

function StoryView({ turn, why, seg, onOpen }: { turn: WhyTurn; why: SessionWhy; seg: ReactNode; onOpen: (k: number) => void }) {
  const story = storyOf(turn, why.rules.idleMs)
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(storyMarkdown(story))
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1_500)
  }
  return (
    <div className="sv-td">
      {seg}
      <div className="sv-story-head">
        <p>{story.header}</p>
        <button type="button" className="sv-jump" onClick={() => void copy()}>{t(copied ? 'spend.optimize.copy.done' : 'sessions.why.story.copy')}</button>
      </div>
      <ol className="sv-story">
        {story.lines.map((l, n) => (
          <li key={n} data-kind={l.kind}>
            <span className="off">{offset(l.at)}</span>
            <Icon name={STORY_GLYPHS[l.kind]} />
            <span className="tx">{l.text}</span>
            {l.step !== undefined
              ? <button type="button" className="sv-jump" aria-label={t('sessions.why.story.open')} onClick={() => onOpen(l.step!)}><Icon name="chevron-right" /></button>
              : <span />}
          </li>
        ))}
      </ol>
      {turn.truncatedSteps ? <p className="sv-note">{plural('sessions.why.step.truncated', turn.truncatedSteps)}</p> : null}
      <p className="sv-note">{t('sessions.why.story.footer')}</p>
    </div>
  )
}

function PromptDetail(props: { turn: WhyTurn; findings: WhyFinding[]; why: SessionWhy; openStep: number | null; onStep: (k: number | null) => void }) {
  const [view, setView] = useState('inspect')
  const options = [{ value: 'inspect', label: t('sessions.why.view.inspect') }, ...(props.turn.helpers.length ? [{ value: 'agents', label: t('sessions.why.view.agents') }] : []), { value: 'story', label: t('sessions.why.view.story') }]
  const seg = <SegTabs options={options} value={view} onChange={setView} style={{ alignSelf: 'flex-start' }} />
  if (view === 'story') return <StoryView turn={props.turn} why={props.why} seg={seg} onOpen={k => { setView('inspect'); props.onStep(k) }} />
  return view === 'agents' ? <AgentsView turn={props.turn} why={props.why} seg={seg} /> : <TurnDetail {...props} seg={seg} />
}

const prLabel = (url: string) => url.replace(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+).*$/, '$1/$2#$3')

function PrWorkPanel({ work }: { work: WhyPrWork }) {
  return (
    <Panel title={t('sessions.why.pr.title')} right={work.reviewCost > 0 ? t('sessions.why.pr.reviewTotal', { amount: formatUsd(work.reviewCost) }) : undefined} className="sv-findings sv-prwork">
      {work.opened.map(pr => (
        <div key={pr.url} className="sv-fd info">
          <div className="sv-fd-body">
            <div className="sv-fd-title"><span>{t('sessions.why.pr.opened', { pr: prLabel(pr.url) })}</span></div>
            {pr.followUpRounds !== null && (
              <p className="sv-fd-line">{pr.followUpRounds === 0 ? t('sessions.why.pr.noFollowUps') : t('sessions.why.pr.followUps', { rounds: pr.followUpRounds, pushes: pr.followUpPushes })}</p>
            )}
          </div>
          <span />
          <span />
        </div>
      ))}
      {work.reviewRuns.map(run => {
        const line = [run.models.join(', '), run.pr !== null ? `#${run.pr}` : ''].filter(Boolean).join(' · ')
        return (
          <div key={run.helperId} className="sv-fd info">
            <div className="sv-fd-body">
              <div className="sv-fd-title"><span>{run.description || t('sessions.why.pr.reviewRun')}</span></div>
              {line && <p className="sv-fd-line">{line}</p>}
            </div>
            <div className="sv-fd-num"><b>{formatUsd(run.cost)}</b></div>
            <span />
          </div>
        )
      })}
    </Panel>
  )
}

export function SessionView({ row, filters, medianCost, onBack }: {
  row: SessionDrillRow
  filters: InvestigationFilters
  medianCost?: number
  onBack: () => void
}) {
  const [state, setState] = useState<{ data: SessionWhy | null; error: CliError | null }>({ data: null, error: null })
  const [filter, setFilter] = useState<'flag' | 'all'>('flag')
  const [openTurn, setOpenTurn] = useState<number | null>(null)
  const [openStep, setOpenStep] = useState<number | null>(null)
  const [allFindings, setAllFindings] = useState(false)

  // On demand, never memoized: the payload carries transcript text.
  useEffect(() => {
    let live = true
    setState({ data: null, error: null })
    codeburn.getSessionWhy(row.sessionId).then(
      data => { if (live) setState({ data, error: null }) },
      err => { if (live) setState({ data: null, error: normalizeCliError(err) }) },
    )
    return () => { live = false }
  }, [row.sessionId])

  const why = state.data
  const byTurn = useMemo(() => {
    const map = new Map<number, WhyFinding[]>()
    for (const f of why?.findings ?? []) if (f.turn) map.set(f.turn, [...(map.get(f.turn) ?? []), f])
    return map
  }, [why])

  const open = (turn: number, step?: number) => {
    if (!byTurn.has(turn)) setFilter('all')
    setOpenTurn(turn)
    const fs = byTurn.get(turn) ?? []
    const first = step ?? fs.find(f => f.step !== undefined)?.step
    setOpenStep(first ?? null)
    requestAnimationFrame(() => document.getElementById(`sv-turn-${turn}`)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }))
  }

  useEffect(() => {
    const first = why?.findings.find(f => f.turn)
    if (first?.turn) {
      setOpenTurn(first.turn)
      setOpenStep(first.step ?? null)
    }
  }, [why])

  const title = row.title || shortenProjectPath(row.project)
  const header = (
    <div className="sv-head">
      <button type="button" className="sv-back" onClick={onBack}><Icon name="chevron-left" />{t('sessions.why.back')}</button>
      <h2 className="sv-title">{title}</h2>
      <div className="sv-meta">
        {row.provider} · {shortenProjectPath(row.project)} · {formatDayLong(row.startedAt)}, {clock(row.startedAt)}–{formatDayLong(row.endedAt) === formatDayLong(row.startedAt) ? '' : `${formatDayLong(row.endedAt)}, `}{clock(row.endedAt)} · <span className="mono">{row.sessionId.slice(0, 8)}</span>
      </div>
    </div>
  )
  const details = (
    <details className="sv-details">
      <summary><Icon name="chevron-right" />{t('sessions.why.details.title')}<span>{t('sessions.why.details.hint')}</span></summary>
      <div className="sv-details-body"><SessionDetails row={row} filters={filters} medianCost={medianCost} /></div>
    </details>
  )

  if (!why) {
    if (state.error) {
      const display = cliErrorDisplay(state.error)
      return (
        <div className="sv">
          {header}
          <Panel title={t('sessions.why.error')}><p className="sv-error">{display.message}</p></Panel>
          {details}
        </div>
      )
    }
    return <div className="sv">{header}<SectionSkeleton label={t('sessions.why.loading')} rows={6} chart /></div>
  }

  const flaggedTurns = why.turns.filter(x => byTurn.has(x.i))
  const listTurns = filter === 'flag' ? flaggedTurns : why.turns
  const maxTurn = Math.max(...why.turns.map(x => x.cost), 0)
  const findings = allFindings ? why.findings : why.findings.slice(0, FINDINGS_SHOWN)
  const durationMs = Date.parse(why.endedAt) - Date.parse(why.startedAt)
  const r = why.rules
  const ownTurns = row.turns - (row.subagents ?? []).reduce((sum, entry) => sum + entry.turns, 0)

  return (
    <div className="sv">
      {header}

      <section className="sv-verdict" aria-label={t('sessions.why.verdict.label')}>
        <div className="sv-figure-row">
          <span className="sv-figure"><Usd value={why.cost} tokens={{ inputTokens: why.tokens.input, outputTokens: why.tokens.output, cacheReadTokens: why.tokens.cacheRead, cacheWriteTokens: why.tokens.cacheWrite, calls: why.calls }} /></span>
          <span className="sv-figure-sub">
            {t('sessions.why.thisSession')}
            {why.helperCount > 0 && <> · <b>{plural('sessions.why.plusHelpers', why.helperCount, { amount: formatUsd(why.helperCost) })}</b></>}
          </span>
        </div>
        {Math.abs(why.cost + why.helperCost - row.cost) > 0.005 && <p className="sv-note">{t('sessions.why.periodNote', { amount: formatUsd(row.cost) })}</p>}
        <p className="sv-lead">{verdict(why)}</p>
        <div className="sv-kpis">
          <span><b>{why.turns.length}</b> {t(`sessions.why.kpi.prompts.${why.turns.length === 1 ? 'one' : 'other'}`)}{why.turns.length !== ownTurns && <small className="sv-kpi-note">{t('sessions.why.kpi.promptsNote', { turns: ownTurns })}</small>}</span>
          <span><b>{why.calls}</b> {t(`sessions.why.kpi.calls.${why.calls === 1 ? 'one' : 'other'}`)}</span>
          {durationMs > 0 && <span><b>{formatStepDuration(durationMs)}</b> {t('sessions.why.kpi.wall')}</span>}
          <span><b>{why.findings.length}</b> {t('sessions.why.kpi.flags')}</span>
        </div>
      </section>

      <Panel title={t('sessions.why.findings.title')} right={why.findings.length ? t('sessions.why.findings.ranked') : undefined} className="sv-findings">
        {why.findings.length === 0
          ? <p className="sv-empty">{t('sessions.why.findings.none')}</p>
          : findings.map((f, i) => <FindingRow key={f.id} f={f} why={why} lead={i === 0} onJump={open} />)}
        {!allFindings && why.findings.length > FINDINGS_SHOWN && (
          <button type="button" className="sv-more" onClick={() => setAllFindings(true)}>{t('sessions.why.findings.more', { count: why.findings.length - FINDINGS_SHOWN })}</button>
        )}
      </Panel>
      <details className="sv-rules">
        <summary>{t('sessions.why.rules.summary')}</summary>
        <ul>
          <li>{t('sessions.why.rules.hotspot', { top: r.hotspotTopShare * 100, mult: r.hotspotMedianX, min: r.hotspotMinShare * 100 })}</li>
          <li>{t('sessions.why.rules.helpers', { share: r.helperShare * 100 })}</li>
          <li>{t('sessions.why.rules.coordination', { share: r.coordinationToolShare * 100, calls: r.coordinationMinCalls })}</li>
          <li>{t('sessions.why.rules.reread', { share: r.rereadShare * 100, calls: r.rereadMinCalls })}</li>
          <li>{t('sessions.why.rules.parts')}</li>
          <li>{t('sessions.why.rules.alt')}</li>
          <li>{t('sessions.why.rules.failed')}</li>
          <li>{t('sessions.why.rules.carry', { tokens: r.carryTokens / 1000 })}</li>
          <li>{t('sessions.why.rules.prefix', { tokens: r.prefixTokens / 1000 })}</li>
          <li>{t('sessions.why.rules.time', { idle: r.idleMs / 1000, slow: r.slowCallMs / 1000 })}</li>
          <li>{t('sessions.why.rules.reconcile')}</li>
        </ul>
      </details>

      {why.prWork && (why.prWork.opened.length > 0 || why.prWork.reviewRuns.length > 0) && <PrWorkPanel work={why.prWork} />}

      <Panel title={t('sessions.why.chart.title')} right={t('sessions.why.chart.hint')}>
        <SpendChart why={why} flagged={new Set(byTurn.keys())} selected={openTurn} onSelect={turn => open(turn)} />
      </Panel>

      <Panel
        title={t('sessions.why.prompts.title')}
        right={
          <span className="seg sv-seg" role="tablist">
            {(['flag', 'all'] as const).map(value => (
              <span key={value} role="tab" tabIndex={0} aria-selected={filter === value} className={filter === value ? 'on' : undefined} onClick={() => setFilter(value)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setFilter(value) }}>
                {value === 'flag' ? t('sessions.why.prompts.flagged', { count: flaggedTurns.length }) : t('sessions.why.prompts.all', { count: why.turns.length })}
              </span>
            ))}
          </span>
        }
        className="sv-prompts"
      >
        {listTurns.length === 0 && <p className="sv-empty">{t('sessions.why.prompts.none')}</p>}
        {listTurns.map(turn => {
          const fs = byTurn.get(turn.i) ?? []
          const sev = fs.some(f => severity(f) === 'bad') ? 'bad' : fs.some(f => severity(f) === 'warn') ? 'warn' : fs.length ? 'info' : null
          const kinds = [...new Set(fs.map(f => f.kind))]
          const isOpen = openTurn === turn.i
          return (
            <Fragment key={turn.i}>
              <div id={`sv-turn-${turn.i}`} className={`sv-tr${sev ? ` sev-${sev}` : ''}${isOpen ? ' open' : ''}`}>
                <button type="button" className="sv-tr-row" aria-expanded={isOpen} onClick={() => { if (isOpen) setOpenTurn(null); else open(turn.i) }}>
                  {sev ? <i className={`sv-dot ${sev}`} aria-hidden="true" /> : <i />}
                  <span className="sv-tr-no">{turn.i}</span>
                  <span className="sv-tr-time">{clock(turn.ts)}</span>
                  <span className={`sv-tr-prompt${turn.prompt.kind === 'system' ? ' system' : ''}`} title={turn.prompt.text}>
                    {turn.prompt.kind !== 'text' && <span className="k">{t(`sessions.why.prompts.${turn.prompt.kind}`)}</span>}
                    {turn.prompt.text || t('sessions.why.prompts.empty')}
                  </span>
                  <span className="sv-tr-chips">
                    {kinds.slice(0, 2).map(k => <span key={k} className="sv-pill">{t(`sessions.why.kind.${k}`)}</span>)}
                    {kinds.length > 2 && <span className="sv-pill">+{kinds.length - 2}</span>}
                  </span>
                  <span className="sv-tr-cost">
                    {formatUsd(turn.cost)}
                    <i aria-hidden="true"><b style={{ width: `${maxTurn > 0 ? turn.cost / maxTurn * 100 : 0}%` }} /></i>
                  </span>
                  <span className="sv-tr-dur">{formatStepDuration(turn.wallMs)}</span>
                </button>
                {isOpen && <PromptDetail turn={turn} findings={fs} why={why} openStep={openStep} onStep={setOpenStep} />}
              </div>
            </Fragment>
          )
        })}
      </Panel>

      {why.detailsOmitted && <p className="sv-note">{t('sessions.why.step.omitted')}</p>}
      {details}
    </div>
  )
}

