import { Fragment, useEffect, useMemo, useState } from 'react'

import { ChartTip } from '../components/ChartTip'
import { cliErrorDisplay } from '../components/CliErrorPanel'
import { Panel } from '../components/Panel'
import { SessionDetails } from '../components/SessionDrawer'
import { SectionSkeleton } from '../components/Skeleton'
import { Usd } from '../components/Usd'
import { Icon } from '../components/icons'
import { t } from '../i18n'
import { formatAxisMoney, niceTicks } from '../lib/chartAxis'
import { formatCompact, formatDayLong, formatUsd, formatUsdDifference, shortenProjectPath } from '../lib/format'
import type { InvestigationFilters } from '../lib/investigation'
import { codeburn, normalizeCliError } from '../lib/ipc'
import type { CliError, SessionDrillRow, SessionWhy, WhyFinding, WhyParts, WhyStep, WhyTokens, WhyTurn } from '../lib/types'

/** Claude Code main sessions are `<uuid>.jsonl`; `--why` resolves only those. */
const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function hasSessionView(row: SessionDrillRow): boolean {
  return row.provider === 'claude' && !row.isSidechain && CLAUDE_SESSION_ID.test(row.sessionId)
}

const FINDINGS_SHOWN = 5
const STEPS_SHOWN = 12

const pct = (p: number) => (p > 0 && p < 0.01 ? '<1%' : `${Math.round(p * 100)}%`)
const tok = (n: number) => formatCompact(Math.round(n))
const usdFine = (n: number) => (n > 0 && n < 0.01 ? `<${formatUsd(0.01)}` : formatUsd(n))
const plural = (key: string, count: number, vars: Record<string, string | number> = {}) => t(`${key}.${count === 1 ? 'one' : 'other'}`, { count, ...vars })
const one = (key: string, count: number) => `${key}.${count === 1 ? 'one' : 'other'}`

export function formatStepDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  const s = ms / 1000
  if (s < 10) return `${s.toFixed(1)}s`
  if (s < 60) return `${Math.round(s)}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(Math.round(s % 60)).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

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

function turnSummary(turn: WhyTurn): string {
  const calls = turn.steps.filter(s => s.kind === 'model').length
  const tools = turn.steps.length - calls
  const top = PART_KEYS.slice().sort((a, b) => turn.parts[b] - turn.parts[a])[0]!
  return t('sessions.why.turn.summary', {
    calls, tools, duration: formatStepDuration(turn.wallMs), share: pct(turn.cost > 0 ? turn.parts[top] / turn.cost : 0),
    amount: formatUsd(turn.cost), part: t(`sessions.why.partName.${top}`),
  }) + (turn.helperCost > 0 ? ' ' + t('sessions.why.turn.helpers', { amount: formatUsd(turn.helperCost) }) : '')
}

function stepClass(s: WhyStep): string {
  if (s.kind === 'model') return 'model'
  if (s.isError) return 'err'
  return s.helperCost !== undefined || s.name === 'Agent' || s.name === 'Task' ? 'agent' : 'tool'
}

function TurnDetail({ turn, findings, why, openStep, onStep }: { turn: WhyTurn; findings: WhyFinding[]; why: SessionWhy; openStep: number | null; onStep: (k: number | null) => void }) {
  const [tip, setTip] = useState<{ x: number; y: number; step: WhyStep } | null>(null)
  const [allSteps, setAllSteps] = useState(false)
  const span = Math.max(1, ...turn.steps.map(s => s.end))
  const indexed = turn.steps.map((s, k) => ({ s, k }))
  const tools = indexed.filter(x => x.s.kind === 'tool')
  const flaggedSteps = new Set(findings.map(f => f.step).filter((s): s is number => s !== undefined))
  const shown = allSteps || tools.length <= STEPS_SHOWN ? tools : tools.filter((x, j) => j < 8 || (x.s.kind === 'tool' && x.s.isError) || flaggedSteps.has(x.k) || x.k === openStep)
  const sel = openStep !== null ? turn.steps[openStep] : undefined
  const bars = (list: typeof indexed) => list.map(({ s, k }) => (
    <button
      key={k}
      type="button"
      className={`sv-wf-bar ${stepClass(s)}${openStep === k ? ' sel' : ''}`}
      style={{ left: `${s.start / span * 100}%`, width: `${Math.max(0, s.end - s.start) / span * 100}%` }}
      aria-label={s.kind === 'model' ? `${t('sessions.why.step.model')} ${s.model} ${formatUsd(s.cost)}` : `${s.name} ${s.label}`}
      onClick={() => onStep(openStep === k ? null : k)}
      onMouseMove={e => setTip({ x: e.clientX, y: e.clientY, step: s })}
      onMouseLeave={() => setTip(null)}
    />
  ))
  return (
    <div className="sv-td">
      {turn.prompt.text && <p className="sv-td-prompt">{turn.prompt.text}</p>}
      <p className="sv-td-sum">{turnSummary(turn)}</p>
      {findings.length > 0 && (
        <ul className="sv-td-flags">
          {findings.map(f => <li key={f.id}><i className={`sv-dot ${severity(f)}`} aria-hidden="true" />{findingCopy(f, why).title}</li>)}
        </ul>
      )}
      <div className="sv-wf">
        <span className="sv-wf-lab">{t('sessions.why.lane.model')}</span>
        <div className="sv-wf-track">{bars(indexed.filter(x => x.s.kind === 'model'))}</div>
        <span className="sv-wf-lab">{t('sessions.why.lane.tools')}</span>
        <div className="sv-wf-track">{bars(tools)}</div>
        <div className="sv-wf-axis"><span>{clock(turn.ts)}</span><span>{formatStepDuration(span)}</span></div>
      </div>
      {tip && (
        <ChartTip x={tip.x} y={tip.y}>
          <div className="chart-tip-d">{tip.step.kind === 'model' ? `${t('sessions.why.step.model')} · ${tip.step.model}` : `${tip.step.name}${tip.step.label ? ` · ${tip.step.label.slice(0, 60)}` : ''}`}</div>
          <div className="chart-tip-v">{tip.step.kind === 'model' ? usdFine(tip.step.cost) : formatStepDuration(tip.step.end - tip.step.start)}</div>
          <div className="chart-tip-s">+{formatStepDuration(tip.step.start)}{tip.step.kind === 'model' ? ` · ${formatStepDuration(tip.step.end - tip.step.start)}` : ''}</div>
        </ChartTip>
      )}
      {tools.length > 0 && (
        <div className="sv-steps">
          {shown.map(({ s, k }) => s.kind === 'tool' && (
            <button key={k} type="button" className={`sv-st${s.isError ? ' err' : ''}${openStep === k ? ' sel' : ''}`} onClick={() => onStep(openStep === k ? null : k)} aria-expanded={openStep === k}>
              <i className={`sv-sw ${stepClass(s)}`} aria-hidden="true" />
              <span className="nm">{s.name.replace(/^mcp__(.+?)__/, '')}</span>
              <span className="lb">{s.label}</span>
              {s.helperCost !== undefined && <span className="hc">{formatUsd(s.helperCost)}</span>}
              <span className="du">{formatStepDuration(s.end - s.start)}</span>
            </button>
          ))}
          {shown.length < tools.length && (
            <button type="button" className="sv-more" onClick={() => setAllSteps(true)}>{t('sessions.why.steps.more', { count: tools.length - shown.length })}</button>
          )}
        </div>
      )}
      {sel && <StepDetail step={sel} />}
    </div>
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
        {Math.abs(why.cost - row.cost) > 0.005 && <p className="sv-note">{t('sessions.why.periodNote', { amount: formatUsd(row.cost) })}</p>}
        <p className="sv-lead">{verdict(why)}</p>
        <div className="sv-kpis">
          <span><b>{why.turns.length}</b> {t(`sessions.why.kpi.prompts.${why.turns.length === 1 ? 'one' : 'other'}`)}{why.turns.length !== row.turns && <small className="sv-kpi-note">{t('sessions.why.kpi.promptsNote', { turns: row.turns })}</small>}</span>
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
                {isOpen && <TurnDetail turn={turn} findings={fs} why={why} openStep={openStep} onStep={setOpenStep} />}
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

