import { Chalk, type ChalkInstance } from 'chalk'

import { homedir } from 'os'

import { type ProjectSummary } from './types.js'
import { formatCost as baseCost, getCurrency } from './currency.js'
import { findUnpricedModels, getShortModelName, unpricedModelHintLocalized } from './models.js'
import { callBillableOutputTokens, sessionBillableOutputTokens, sessionModelBillableOutputTokens } from './session-output.js'
import { markEstimated } from './format.js'
import { formatSessionCountLocalized, sessionCountHelpLocalized, type SessionCountBasis } from './session-count-label.js'
import { normalizeAbsProjectPathKey } from './parser.js'
import { dateKey } from './day-aggregator.js'
import type { DailyEntry } from './daily-cache.js'
import type { BudgetStatus, BudgetTier } from './budget.js'
import { displayWidth, fmt, getCatalog, localizedCategory, padEndDisplay, padStartDisplay } from './i18n/index.js'

// Display-only helpers. The shared formatters omit thousands separators and
// abbreviate; here we show full, comma-grouped numbers so the tables read like
// a precise statement. Aggregation uses raw numbers; these only affect render.
function formatCost(usd: number): string {
  return baseCost(usd).replace(/(\d)(?=(\d{3})+(\.|$))/g, '$1,')
}
function formatDisplayCost(amount: number): string {
  const { rate } = getCurrency()
  return formatCost(rate > 0 ? amount / rate : amount)
}
function formatTokens(n: number): string {
  // Pin the locale so grouping is deterministic regardless of the host's
  // locale (e.g. en-IN groups as 2,00,20,00,000 instead of 2,002,000,000).
  return Math.round(n).toLocaleString('en-US')
}
// Integer counts (calls, sessions, turns, tool uses) — same locale pin so the
// overview output is byte-identical across machines.
function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}
function isAbsoluteProjectPath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\') || /^[a-zA-Z]:[/\\]/.test(path)
}
function projectName(p: ProjectSummary): string {
  const path = p.projectPath
  if (path) {
    if (path === homedir()) return 'Home'
    if (!isAbsoluteProjectPath(path)) return p.project || path
    const base = path.replace(/[/\\]+$/, '').split(/[/\\]/).filter(Boolean).pop()
    if (base) return base
  }
  return p.project.split('-').filter(Boolean).pop() || p.project
}

/** #1260: aggregate by abs path identity so /a/vault != /b/vault. */
function projectAggKey(p: ProjectSummary): string {
  return normalizeAbsProjectPathKey(p.projectPath ?? '') ?? `label:${projectName(p).toLowerCase()}`
}

function disambiguatedProjectLabel(key: string, sample: ProjectSummary, basenameCounts: Map<string, number>): string {
  const base = projectName(sample)
  if ((basenameCounts.get(base) ?? 0) <= 1) return base
  const path = (sample.projectPath ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (path && isAbsoluteProjectPath(path)) {
    const parts = path.split('/').filter(Boolean)
    if (parts.length >= 2) return parts.slice(-2).join('/')
    return path
  }
  return sample.project || base || key
}

type Col = { header: string; right?: boolean }
type OverviewBudget = {
  tier: BudgetTier
  status: BudgetStatus
  inProgress: boolean
}

// Visible width, ignoring ANSI color codes, so padding stays aligned. CJK
// glyphs are double-width in terminals, so padding must use display width
// rather than codepoint count (see src/i18n/index.ts:displayWidth).
function vlen(s: string): number {
  return displayWidth(s)
}

export function renderTable(c: ChalkInstance, cols: Col[], rows: string[][]): string {
  const widths = cols.map((col, i) =>
    Math.max(vlen(col.header), ...rows.map((r) => vlen(r[i] ?? ''))),
  )
  const pad = (s: string, w: number, right?: boolean): string => {
    return right ? padStartDisplay(s, w) : padEndDisplay(s, w)
  }
  const gap = '  ' // 2-space cell padding so columns breathe
  const sep = gap + c.dim('│') + gap
  const edge = c.dim('│')
  const bar = (l: string, mid: string, r: string): string =>
    c.dim(l + widths.map((w) => '─'.repeat(w + 4)).join(mid) + r)
  const line = (cells: string[], header = false): string =>
    edge + gap + cells.map((cell, i) => {
      const padded = pad(cell, widths[i]!, cols[i]!.right)
      return header ? c.bold(padded) : padded
    }).join(sep) + gap + edge
  return [
    bar('┌', '┬', '┐'),
    line(cols.map((col) => col.header), true),
    bar('├', '┼', '┤'),
    ...rows.map((r) => line(r)),
    bar('└', '┴', '┘'),
  ].join('\n')
}

/// The durable slice renderOverview needs: headline totals + the day set behind
/// them + how much of the total came from carried (expired-source) days.
export type OverviewDurable = {
  cost: number
  savingsUSD: number
  calls: number
  sessions: number
  sessionCountBasis?: SessionCountBasis
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  days: DailyEntry[]
  carriedCostUSD: number
  /// Cost a --project/--exclude filter could not attribute (cached days with no
  /// per-project split). Optional so callers that never filter can omit it.
  unattributedCostUSD?: number
}

export function renderOverview(
  projects: ProjectSummary[],
  opts: { label: string; color: boolean; budget?: OverviewBudget; durable?: OverviewDurable },
): string {
  const c = new Chalk(opts.color ? {} : { level: 0 })
  const L = getCatalog()
  const heading = (text: string): string => c.cyan.bold(text)
  const out: string[] = []
  const durable = opts.durable

  out.push(c.bold('CodeBurn') + c.dim('  ' + opts.label))
  out.push('')

  if (projects.length === 0 && !(durable && durable.cost > 0)) {
    out.push(c.dim(fmt(L.overview.noUsage, { label: opts.label })))
    return out.join('\n') + '\n'
  }

  let cost = 0, savings = 0, calls = 0, sessions = 0
  let inTok = 0, outTok = 0, cacheR = 0, cacheW = 0
  const byProvider = new Map<string, { cost: number; tokens: number }>()
  const byModel = new Map<string, { cost: number; calls: number; tokens: number; estimatedCost: number }>()
  const byCat = new Map<string, { cost: number; turns: number }>()
  const byTool = new Map<string, number>()
  const byDay = new Map<string, { cost: number; tokens: number; providers: Set<string> }>()
  const byProject = new Map<string, { cost: number; sessions: number; sample: ProjectSummary }>()

  for (const p of projects) {
    cost += p.totalCostUSD
    savings += p.totalSavingsUSD
    calls += p.totalApiCalls
    sessions += p.sessions.length
    const pkey = projectAggKey(p)
    const pe = byProject.get(pkey) ?? { cost: 0, sessions: 0, sample: p }
    pe.cost += p.totalCostUSD
    pe.sessions += p.sessions.length
    byProject.set(pkey, pe)
    for (const s of p.sessions) {
      inTok += s.totalInputTokens
      outTok += sessionBillableOutputTokens(s)
      cacheR += s.totalCacheReadTokens
      cacheW += s.totalCacheWriteTokens
      for (const [m, d] of Object.entries(s.modelBreakdown)) {
        const e = byModel.get(m) ?? { cost: 0, calls: 0, tokens: 0, estimatedCost: 0 }
        e.cost += d.costUSD
        e.calls += d.calls
        e.estimatedCost += d.estimatedCostUSD ?? 0
        e.tokens += d.tokens.inputTokens + d.tokens.cacheReadInputTokens + d.tokens.cacheCreationInputTokens
        byModel.set(m, e)
      }
      // Output must be billed per call while provider identity is still known.
      // Join on the same key as parser modelBreakdown (getShortModelName), not raw call.model.
      for (const [m, output] of Object.entries(sessionModelBillableOutputTokens(s))) {
        const e = byModel.get(m) ?? { cost: 0, calls: 0, tokens: 0, estimatedCost: 0 }
        e.tokens += output
        byModel.set(m, e)
      }
      for (const [cat, d] of Object.entries(s.categoryBreakdown)) {
        const e = byCat.get(cat) ?? { cost: 0, turns: 0 }
        e.cost += d.costUSD
        e.turns += d.turns
        byCat.set(cat, e)
      }
      for (const [tool, d] of Object.entries(s.toolBreakdown)) {
        byTool.set(tool, (byTool.get(tool) ?? 0) + d.calls)
      }
      for (const t of s.turns) {
        const day = dateKey(t.timestamp || t.assistantCalls[0]?.timestamp || '')
        for (const call of t.assistantCalls) {
          const usage = call.usage
          const billableOut = callBillableOutputTokens(call)
          const tk = (usage?.inputTokens ?? 0) + billableOut + (usage?.cacheReadInputTokens ?? 0) + (usage?.cacheCreationInputTokens ?? 0)
          const pv = byProvider.get(call.provider) ?? { cost: 0, tokens: 0 }
          pv.cost += call.costUSD
          pv.tokens += tk
          byProvider.set(call.provider, pv)
          if (day) {
            const dd = byDay.get(day) ?? { cost: 0, tokens: 0, providers: new Set<string>() }
            dd.cost += call.costUSD
            dd.tokens += tk
            dd.providers.add(call.provider)
            byDay.set(day, dd)
          }
        }
      }
    }
  }

  // Headline totals and the day-resolved views (Daily, Highest-value days) come
  // from the durable daily cache so they match the menubar exactly, carried
  // (expired-source) days included. The per-tool / per-model / per-project
  // breakdowns above stay live: they need surviving session detail.
  if (durable) {
    cost = durable.cost
    savings = durable.savingsUSD
    calls = durable.calls
    sessions = durable.sessions
    inTok = durable.inputTokens
    outTok = durable.outputTokens
    cacheR = durable.cacheReadTokens
    cacheW = durable.cacheWriteTokens
    byDay.clear()
    for (const d of durable.days) {
      byDay.set(d.date, {
        cost: d.cost,
        tokens: d.inputTokens + d.outputTokens + d.cacheReadTokens + d.cacheWriteTokens,
        providers: new Set(Object.keys(d.providers)),
      })
    }
  }

  const totalTokens = inTok + outTok + cacheR + cacheW
  const cacheHitDenom = inTok + cacheR
  const cacheHit = cacheHitDenom > 0 ? (cacheR / cacheHitDenom) * 100 : 0

  // Totals
  out.push(heading(L.overview.totals))
  // Long translated keys (e.g. fr "Détail des tokens") must never glue the
  // value to the label: pad to at least one column past the key's own width.
  const kv = (k: string, v: string): string => '  ' + c.dim(padEndDisplay(k, Math.max(11, displayWidth(k) + 1))) + v
  out.push(kv(L.overview.cost, c.bold(formatCost(cost))))
  out.push(kv(L.overview.tokens, formatTokens(totalTokens) + c.dim('   ' + L.overview.breakdownBelow)))
  out.push(kv(L.overview.calls, formatCount(calls) + c.dim('   ') + formatSessionCountLocalized(sessions, durable ? durable.sessionCountBasis : 'identity')))
  if (durable && durable.sessionCountBasis !== 'identity' && sessions > 0) {
    out.push(kv('', c.dim(sessionCountHelpLocalized())))
  }
  out.push(kv(L.overview.cacheHit, `${cacheHit.toFixed(1)}%`))
  if (savings > 0) out.push(kv(L.overview.savings, formatCost(savings) + c.dim(' ' + L.overview.localModels)))
  const unpriced = findUnpricedModels(
    [...byModel.entries()].map(([model, d]) => ({ model, calls: d.calls, cost: d.cost, tokens: d.tokens })),
  )
  if (unpriced.length > 0) {
    const shown = unpriced.slice(0, 3)
      .map((u) => `${u.model} (${formatTokens(u.tokens)} tok)`)
      .join(', ')
    const more = unpriced.length > 3 ? fmt(L.overview.plusMore, { n: unpriced.length - 3 }) : ''
    out.push(kv(L.overview.unpriced, c.yellow(fmt(unpriced.length === 1 ? L.overview.unpricedAtOne : L.overview.unpricedAtMany, { n: unpriced.length })) + shown + more))
    out.push(kv('', c.dim(unpricedModelHintLocalized())))
  }
  if (opts.budget) {
    const label = opts.budget.tier === 'daily'
      ? L.overview.budgetDaily
      : opts.budget.tier === 'weekly'
        ? L.overview.budgetWeekly
        : L.overview.budgetMonthly
    const status = opts.budget.status
    const pct = `${Math.floor(status.pct)}%`
    const statusColor = status.state === 'over' ? c.red : status.state === 'warn' ? c.yellow : c.green
    const period = opts.budget.tier === 'monthly' ? L.overview.endMonth : opts.budget.tier === 'weekly' ? L.overview.endWeek : L.overview.endDay
    const projected = opts.budget.inProgress
      ? c.dim(fmt(L.overview.projected, { amount: formatDisplayCost(status.projected), period }))
      : ''
    out.push('  ' + statusColor(fmt(L.overview.budgetLine, { label, spent: formatDisplayCost(status.spent), budget: formatDisplayCost(status.budget), pct })) + projected)
  }
  out.push('')

  // Tokens breakdown: input / output / cache in (written) / cache out (read)
  if (totalTokens > 0) {
    const share = (n: number): string => `${Math.round((n / totalTokens) * 100)}%`
    out.push(heading(L.overview.tokens))
    out.push(renderTable(c,
      [{ header: L.headers.type }, { header: L.headers.tokens, right: true }, { header: L.headers.share, right: true }],
      [
        [L.headers.input, formatTokens(inTok), share(inTok)],
        [L.headers.output, formatTokens(outTok), share(outTok)],
        [L.headers.cacheIn, formatTokens(cacheW), share(cacheW)],
        [L.headers.cacheOut, formatTokens(cacheR), share(cacheR)],
        [L.headers.total, formatTokens(totalTokens), '100%'],
      ],
    ))
    out.push('')
  }

  // By tool (provider)
  const providerRows = [...byProvider.entries()]
    .filter(([, v]) => v.cost > 0 || v.tokens > 0)
    .sort((a, b) => b[1].cost - a[1].cost)
  if (providerRows.length) {
    out.push(heading(L.overview.byTool))
    out.push(renderTable(c,
      [{ header: L.headers.tool }, { header: L.headers.cost, right: true }, { header: L.headers.tokens, right: true }, { header: L.headers.share, right: true }],
      providerRows.map(([name, v]) => [name, formatCost(v.cost), formatTokens(v.tokens), cost > 0 ? `${Math.round((v.cost / cost) * 100)}%` : '0%']),
    ))
    out.push('')
  }

  // Top models
  const modelRows = [...byModel.entries()].filter(([, v]) => v.cost > 0 || v.tokens > 0).sort((a, b) => b[1].cost - a[1].cost).slice(0, 10)
  if (modelRows.length) {
    out.push(heading(L.overview.topModels))
    out.push(renderTable(c,
      [{ header: L.headers.model }, { header: L.headers.cost, right: true }, { header: L.headers.calls, right: true }, { header: L.headers.tokens, right: true }],
      modelRows.map(([m, v]) => [getShortModelName(m), markEstimated(formatCost(v.cost), v.estimatedCost > 0), formatCount(v.calls), formatTokens(v.tokens)]),
    ))
    if (modelRows.some(([, v]) => v.estimatedCost > 0)) {
      out.push('  ' + c.dim(L.overview.estimated))
    }
    out.push('')
  }

  // Highest-value days
  const topDays = [...byDay.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 5)
  if (topDays.length) {
    out.push(heading(L.overview.highestValueDays))
    out.push(renderTable(c,
      [{ header: L.headers.rank }, { header: L.headers.date }, { header: L.headers.cost, right: true }, { header: L.headers.tokens, right: true }],
      topDays.map(([d, v], i) => [String(i + 1), d, formatCost(v.cost), formatTokens(v.tokens)]),
    ))
    out.push('')
  }

  // Top projects (#1260: labels disambiguate when basename collides across abs paths)
  const projRows = [...byProject.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 10)
  if (projRows.length) {
    const basenameCounts = new Map<string, number>()
    for (const [, v] of projRows) {
      const b = projectName(v.sample)
      basenameCounts.set(b, (basenameCounts.get(b) ?? 0) + 1)
    }
    out.push(heading(L.overview.topProjects))
    out.push(renderTable(c,
      [{ header: L.headers.project }, { header: L.headers.cost, right: true }, { header: L.headers.sessions, right: true }],
      projRows.map(([key, v]) => [disambiguatedProjectLabel(key, v.sample, basenameCounts), formatCost(v.cost), formatCount(v.sessions)]),
    ))
    out.push('')
  }

  // Daily
  const dailyRows = [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  if (dailyRows.length) {
    out.push(heading(L.overview.daily))
    out.push(renderTable(c,
      [{ header: L.headers.date }, { header: L.headers.cost, right: true }, { header: L.headers.tokens, right: true }, { header: L.headers.providers }],
      dailyRows.map(([d, v]) => [d, formatCost(v.cost), formatTokens(v.tokens), [...v.providers].sort().join(', ')]),
    ))
    out.push('')
  }

  // By activity
  const catRows = [...byCat.entries()].filter(([, v]) => v.cost > 0 || v.turns > 0).sort((a, b) => b[1].cost - a[1].cost)
  if (catRows.length) {
    out.push(heading(L.overview.byActivity))
    out.push(renderTable(c,
      [{ header: L.headers.activity }, { header: L.headers.cost, right: true }, { header: L.headers.turns, right: true }],
      catRows.map(([cat, v]) => [localizedCategory(cat), formatCost(v.cost), formatCount(v.turns)]),
    ))
    out.push('')
  }

  // Tools
  const toolRows = [...byTool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
  if (toolRows.length) {
    out.push(heading(L.overview.tools))
    out.push(renderTable(c,
      [{ header: L.headers.tool }, { header: L.headers.calls, right: true }],
      toolRows.map(([t, n]) => [t, formatCount(n)]),
    ))
    out.push('')
  }

  const topTool = providerRows[0]?.[0]
  const topModel = modelRows[0] ? getShortModelName(modelRows[0][0]) : ''
  const mostly = topTool ? fmt(L.overview.mostly, { tool: topTool, modelPart: topModel ? fmt(L.overview.modelPart, { model: topModel }) : '' }) : ''
  out.push(c.dim(L.overview.bottomLinePrefix) + fmt(L.overview.bottomLine, { label: opts.label, cost: formatCost(cost), tokens: formatTokens(totalTokens), mostly }))

  // When some of the period's total came from days whose session logs have since
  // expired, say so once. The figure is real (preserved in the durable daily
  // cache); it just can't be re-derived from surviving files anymore.
  if (durable && durable.carriedCostUSD > 0) {
    out.push(c.dim('  ' + fmt(L.overview.carried, { amount: formatCost(durable.carriedCostUSD) })))
  }

  // A project filter cannot claim days the cache holds without a project split
  // (recorded before that split existed), so they sit outside this total. Say how
  // much rather than let the filtered figure look inexplicably short.
  if (durable && (durable.unattributedCostUSD ?? 0) > 0) {
    out.push(c.dim('  ' + fmt(L.overview.unattributed, { amount: formatCost(durable.unattributedCostUSD!) })))
  }

  return out.join('\n') + '\n'
}
