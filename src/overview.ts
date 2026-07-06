import { Chalk, type ChalkInstance } from 'chalk'

import { homedir } from 'os'

import { CATEGORY_LABELS, type ProjectSummary, type TaskCategory } from './types.js'
import { formatCost as baseCost } from './currency.js'
import { getShortModelName } from './models.js'
import { dateKey } from './day-aggregator.js'

// Display-only helpers. The shared formatters omit thousands separators and
// abbreviate; here we show full, comma-grouped numbers so the tables read like
// a precise statement. Aggregation uses raw numbers; these only affect render.
function formatCost(usd: number): string {
  return baseCost(usd).replace(/(\d)(?=(\d{3})+(\.|$))/g, '$1,')
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

type Col = { header: string; right?: boolean }

// Visible width, ignoring ANSI color codes, so padding stays aligned.
function vlen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, '').length
}

function renderTable(c: ChalkInstance, cols: Col[], rows: string[][]): string {
  const widths = cols.map((col, i) =>
    Math.max(vlen(col.header), ...rows.map((r) => vlen(r[i] ?? ''))),
  )
  const pad = (s: string, w: number, right?: boolean): string => {
    const fill = ' '.repeat(Math.max(0, w - vlen(s)))
    return right ? fill + s : s + fill
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

export function renderOverview(
  projects: ProjectSummary[],
  opts: { label: string; color: boolean },
): string {
  const c = new Chalk(opts.color ? {} : { level: 0 })
  const heading = (text: string): string => c.cyan.bold(text)
  const out: string[] = []

  out.push(c.bold('CodeBurn') + c.dim('  ' + opts.label))
  out.push('')

  if (projects.length === 0) {
    out.push(c.dim(`No usage found for ${opts.label}.`))
    return out.join('\n') + '\n'
  }

  let cost = 0, savings = 0, calls = 0, sessions = 0
  let inTok = 0, outTok = 0, cacheR = 0, cacheW = 0
  const byProvider = new Map<string, { cost: number; tokens: number }>()
  const byModel = new Map<string, { cost: number; calls: number; tokens: number }>()
  const byCat = new Map<string, { cost: number; turns: number }>()
  const byTool = new Map<string, number>()
  const byDay = new Map<string, { cost: number; tokens: number; providers: Set<string> }>()
  const byProject = new Map<string, { cost: number; sessions: number }>()

  for (const p of projects) {
    cost += p.totalCostUSD
    savings += p.totalSavingsUSD
    calls += p.totalApiCalls
    sessions += p.sessions.length
    const pname = projectName(p)
    const pe = byProject.get(pname) ?? { cost: 0, sessions: 0 }
    pe.cost += p.totalCostUSD
    pe.sessions += p.sessions.length
    byProject.set(pname, pe)
    for (const s of p.sessions) {
      inTok += s.totalInputTokens
      outTok += s.totalOutputTokens
      cacheR += s.totalCacheReadTokens
      cacheW += s.totalCacheWriteTokens
      for (const [m, d] of Object.entries(s.modelBreakdown)) {
        const e = byModel.get(m) ?? { cost: 0, calls: 0, tokens: 0 }
        e.cost += d.costUSD
        e.calls += d.calls
        e.tokens += d.tokens.inputTokens + d.tokens.outputTokens + d.tokens.cacheReadInputTokens + d.tokens.cacheCreationInputTokens
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
          const tk = call.usage.inputTokens + call.usage.outputTokens + call.usage.cacheReadInputTokens + call.usage.cacheCreationInputTokens
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

  const totalTokens = inTok + outTok + cacheR + cacheW
  const cacheHitDenom = inTok + cacheR
  const cacheHit = cacheHitDenom > 0 ? (cacheR / cacheHitDenom) * 100 : 0

  // Totals
  out.push(heading('Totals'))
  const kv = (k: string, v: string): string => '  ' + c.dim(k.padEnd(11)) + v
  out.push(kv('Cost', c.bold(formatCost(cost))))
  out.push(kv('Tokens', formatTokens(totalTokens) + c.dim('   (breakdown below)')))
  out.push(kv('Calls', formatCount(calls) + c.dim('   sessions ') + formatCount(sessions)))
  out.push(kv('Cache hit', `${cacheHit.toFixed(1)}%`))
  if (savings > 0) out.push(kv('Savings', formatCost(savings) + c.dim(' (local models)')))
  out.push('')

  // Tokens breakdown: input / output / cache in (written) / cache out (read)
  if (totalTokens > 0) {
    const share = (n: number): string => `${Math.round((n / totalTokens) * 100)}%`
    out.push(heading('Tokens'))
    out.push(renderTable(c,
      [{ header: 'Type' }, { header: 'Tokens', right: true }, { header: 'Share', right: true }],
      [
        ['Input', formatTokens(inTok), share(inTok)],
        ['Output', formatTokens(outTok), share(outTok)],
        ['Cache in', formatTokens(cacheW), share(cacheW)],
        ['Cache out', formatTokens(cacheR), share(cacheR)],
        ['Total', formatTokens(totalTokens), '100%'],
      ],
    ))
    out.push('')
  }

  // By tool (provider)
  const providerRows = [...byProvider.entries()]
    .filter(([, v]) => v.cost > 0 || v.tokens > 0)
    .sort((a, b) => b[1].cost - a[1].cost)
  if (providerRows.length) {
    out.push(heading('By tool'))
    out.push(renderTable(c,
      [{ header: 'Tool' }, { header: 'Cost', right: true }, { header: 'Tokens', right: true }, { header: 'Share', right: true }],
      providerRows.map(([name, v]) => [name, formatCost(v.cost), formatTokens(v.tokens), cost > 0 ? `${Math.round((v.cost / cost) * 100)}%` : '0%']),
    ))
    out.push('')
  }

  // Top models
  const modelRows = [...byModel.entries()].filter(([, v]) => v.cost > 0 || v.tokens > 0).sort((a, b) => b[1].cost - a[1].cost).slice(0, 10)
  if (modelRows.length) {
    out.push(heading('Top models'))
    out.push(renderTable(c,
      [{ header: 'Model' }, { header: 'Cost', right: true }, { header: 'Calls', right: true }, { header: 'Tokens', right: true }],
      modelRows.map(([m, v]) => [getShortModelName(m), formatCost(v.cost), formatCount(v.calls), formatTokens(v.tokens)]),
    ))
    out.push('')
  }

  // Highest-value days
  const topDays = [...byDay.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 5)
  if (topDays.length) {
    out.push(heading('Highest-value days'))
    out.push(renderTable(c,
      [{ header: '#' }, { header: 'Date' }, { header: 'Cost', right: true }, { header: 'Tokens', right: true }],
      topDays.map(([d, v], i) => [String(i + 1), d, formatCost(v.cost), formatTokens(v.tokens)]),
    ))
    out.push('')
  }

  // Top projects
  const projRows = [...byProject.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 10)
  if (projRows.length) {
    out.push(heading('Top projects'))
    out.push(renderTable(c,
      [{ header: 'Project' }, { header: 'Cost', right: true }, { header: 'Sessions', right: true }],
      projRows.map(([name, v]) => [name, formatCost(v.cost), formatCount(v.sessions)]),
    ))
    out.push('')
  }

  // Daily
  const dailyRows = [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  if (dailyRows.length) {
    out.push(heading('Daily'))
    out.push(renderTable(c,
      [{ header: 'Date' }, { header: 'Cost', right: true }, { header: 'Tokens', right: true }, { header: 'Providers' }],
      dailyRows.map(([d, v]) => [d, formatCost(v.cost), formatTokens(v.tokens), [...v.providers].sort().join(', ')]),
    ))
    out.push('')
  }

  // By activity
  const catRows = [...byCat.entries()].filter(([, v]) => v.cost > 0 || v.turns > 0).sort((a, b) => b[1].cost - a[1].cost)
  if (catRows.length) {
    out.push(heading('By activity'))
    out.push(renderTable(c,
      [{ header: 'Activity' }, { header: 'Cost', right: true }, { header: 'Turns', right: true }],
      catRows.map(([cat, v]) => [CATEGORY_LABELS[cat as TaskCategory] ?? cat, formatCost(v.cost), formatCount(v.turns)]),
    ))
    out.push('')
  }

  // Tools
  const toolRows = [...byTool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
  if (toolRows.length) {
    out.push(heading('Tools'))
    out.push(renderTable(c,
      [{ header: 'Tool' }, { header: 'Calls', right: true }],
      toolRows.map(([t, n]) => [t, formatCount(n)]),
    ))
    out.push('')
  }

  const topTool = providerRows[0]?.[0]
  const topModel = modelRows[0] ? getShortModelName(modelRows[0][0]) : ''
  const mostly = topTool ? `, mostly ${topTool}${topModel ? ` / ${topModel}` : ''}` : ''
  out.push(c.dim('Bottom line: ') + `${opts.label} totals ${formatCost(cost)} across ${formatTokens(totalTokens)} tokens${mostly}.`)

  return out.join('\n') + '\n'
}
