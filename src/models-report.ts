import chalk from 'chalk'
import stripAnsi from 'strip-ansi'

import { formatCost, formatTokens } from './format.js'
import { getProvider } from './providers/index.js'
import { CATEGORY_LABELS, type ProjectSummary, type TaskCategory } from './types.js'

export type ModelReportRow = {
  provider: string
  providerDisplayName: string
  model: string
  modelDisplayName: string
  category: TaskCategory | null
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  totalTokens: number
  costUSD: number
  calls: number
  topCategory?: TaskCategory
  topCategoryCost?: number
  topCategoryShare?: number
}

export type AggregateOptions = {
  byTask?: boolean
  taskFilter?: TaskCategory
  topN?: number
  minCost?: number
}

type Bucket = {
  provider: string
  model: string
  category: TaskCategory | null
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  costUSD: number
  calls: number
}

type ModelKey = string
type CategoryKey = string

function bucketKey(provider: string, model: string, category: TaskCategory | null): string {
  return `${provider} ${model} ${category ?? ''}`
}

/// Walks every parsed turn, attributes each assistant call to a
/// (provider, model, category) bucket, and returns rows keyed by either
/// (provider, model) when `byTask` is false or (provider, model, category) when true.
///
/// Default view: rows sorted by cost descending.
/// byTask view: rows grouped by (provider, model) so the renderer can blank
/// repeated provider/model cells. Group order follows total cost across that
/// model; within each group, rows go by cost descending.
export async function aggregateModels(projects: ProjectSummary[], opts: AggregateOptions = {}): Promise<ModelReportRow[]> {
  const buckets = new Map<string, Bucket>()
  const perModelCategoryCost = new Map<ModelKey, Map<CategoryKey, number>>()
  const perModelTotalCost = new Map<ModelKey, number>()

  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        if (opts.taskFilter && turn.category !== opts.taskFilter) continue
        for (const call of turn.assistantCalls) {
          const provider = call.provider || 'unknown'
          const model = call.model || 'unknown'
          const category: TaskCategory | null = opts.byTask ? turn.category : null
          const key = bucketKey(provider, model, category)
          let bucket = buckets.get(key)
          if (!bucket) {
            bucket = {
              provider,
              model,
              category,
              inputTokens: 0,
              outputTokens: 0,
              cacheWriteTokens: 0,
              cacheReadTokens: 0,
              costUSD: 0,
              calls: 0,
            }
            buckets.set(key, bucket)
          }
          bucket.inputTokens += call.usage.inputTokens
          bucket.outputTokens += call.usage.outputTokens + call.usage.reasoningTokens
          bucket.cacheWriteTokens += call.usage.cacheCreationInputTokens
          bucket.cacheReadTokens += call.usage.cacheReadInputTokens + call.usage.cachedInputTokens
          bucket.costUSD += call.costUSD
          bucket.calls += 1

          const modelKey = `${provider} ${model}`
          let perCat = perModelCategoryCost.get(modelKey)
          if (!perCat) {
            perCat = new Map()
            perModelCategoryCost.set(modelKey, perCat)
          }
          perCat.set(turn.category, (perCat.get(turn.category) ?? 0) + call.costUSD)
          perModelTotalCost.set(modelKey, (perModelTotalCost.get(modelKey) ?? 0) + call.costUSD)
        }
      }
    }
  }

  const providerCache = new Map<string, { displayName: string; formatModel: (m: string) => string }>()
  async function resolveProvider(name: string) {
    const cached = providerCache.get(name)
    if (cached) return cached
    const p = await getProvider(name)
    const entry = {
      displayName: p?.displayName ?? name,
      formatModel: p ? (m: string) => p.modelDisplayName(m) : (m: string) => m,
    }
    providerCache.set(name, entry)
    return entry
  }

  const rows: ModelReportRow[] = []
  for (const bucket of buckets.values()) {
    const meta = await resolveProvider(bucket.provider)
    const total = bucket.inputTokens + bucket.outputTokens + bucket.cacheWriteTokens + bucket.cacheReadTokens
    const row: ModelReportRow = {
      provider: bucket.provider,
      providerDisplayName: meta.displayName,
      model: bucket.model,
      modelDisplayName: meta.formatModel(bucket.model),
      category: bucket.category,
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      cacheWriteTokens: bucket.cacheWriteTokens,
      cacheReadTokens: bucket.cacheReadTokens,
      totalTokens: total,
      costUSD: bucket.costUSD,
      calls: bucket.calls,
    }

    if (!opts.byTask) {
      const perCat = perModelCategoryCost.get(`${bucket.provider} ${bucket.model}`)
      if (perCat && perCat.size > 0) {
        let topCat: TaskCategory = 'general'
        let topCost = -1
        let totalCost = 0
        for (const [cat, cost] of perCat.entries()) {
          totalCost += cost
          if (cost > topCost) {
            topCost = cost
            topCat = cat
          }
        }
        row.topCategory = topCat
        row.topCategoryCost = topCost
        row.topCategoryShare = totalCost > 0 ? topCost / totalCost : 0
      }
    }

    rows.push(row)
  }

  if (opts.byTask) {
    rows.sort((a, b) => {
      const aTotal = perModelTotalCost.get(`${a.provider} ${a.model}`) ?? 0
      const bTotal = perModelTotalCost.get(`${b.provider} ${b.model}`) ?? 0
      if (aTotal !== bTotal) return bTotal - aTotal
      if (a.provider !== b.provider) return a.provider.localeCompare(b.provider)
      if (a.model !== b.model) return a.model.localeCompare(b.model)
      return b.costUSD - a.costUSD
    })
  } else {
    rows.sort((a, b) => b.costUSD - a.costUSD)
  }

  let filtered = rows
  if (opts.minCost !== undefined) {
    filtered = filtered.filter(r => r.costUSD >= opts.minCost!)
  }
  if (opts.topN !== undefined) {
    filtered = filtered.slice(0, opts.topN)
  }
  return filtered
}

function visibleLength(text: string): number {
  return stripAnsi(text).length
}

function pad(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  const visible = visibleLength(text)
  if (visible >= width) return text
  const filler = ' '.repeat(width - visible)
  return align === 'left' ? text + filler : filler + text
}

function categoryLabel(c: TaskCategory): string {
  return CATEGORY_LABELS[c] ?? c
}

/// Box-drawing preset matching tokscale's comfy-table layout. Pure Unicode;
/// every modern terminal handles these. JSON / CSV / Markdown formats already
/// cover the no-Unicode case for downstream tooling.
const BOX = {
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  topT: '┬',
  bottomT: '┴',
  leftT: '├',
  rightT: '┤',
  cross: '┼',
  horizontal: '─',
  vertical: '│',
}

type Column = {
  header: string
  align: 'left' | 'right'
  width: number
  /// Drop priority. 0 = always shown; higher numbers get dropped first when
  /// the terminal is narrow.
  priority: number
  key: 'provider' | 'model' | 'task' | 'input' | 'output' | 'cacheWrite' | 'cacheRead' | 'total' | 'cost'
}

type TableRenderOptions = {
  byTask?: boolean
  showTotals?: boolean
  terminalWidth?: number
  fullWidth?: boolean
}

const DROP_COLUMN_GROUPS: Array<Array<Column['key']>> = [
  ['cacheWrite', 'cacheRead'],
  ['input', 'output'],
  ['task'],
]

function defaultColumns(byTask: boolean): Column[] {
  // Higher priority numbers drop FIRST when the terminal is narrow.
  // Cache columns are the cheapest to lose, then input/output, then top-task.
  // Provider/Model/Total/Cost stay regardless.
  // Widths are MINIMUMS; sizeColumnsToContent() expands them to fit cell text.
  return [
    { key: 'provider',   header: 'Provider',                   align: 'left',  width: 8,  priority: 0 },
    { key: 'model',      header: 'Model',                      align: 'left',  width: 8,  priority: 0 },
    { key: 'task',       header: byTask ? 'Task' : 'Top Task', align: 'left',  width: 8,  priority: 1 },
    { key: 'input',      header: 'Input',                      align: 'right', width: 6,  priority: 2 },
    { key: 'output',     header: 'Output',                     align: 'right', width: 6,  priority: 2 },
    { key: 'cacheWrite', header: 'Cache Write',                align: 'right', width: 11, priority: 3 },
    { key: 'cacheRead',  header: 'Cache Read',                 align: 'right', width: 10, priority: 3 },
    { key: 'total',      header: 'Total',                      align: 'right', width: 6,  priority: 0 },
    { key: 'cost',       header: 'Cost',                       align: 'right', width: 6,  priority: 0 },
  ]
}

/// Expands each column's width to fit the widest cell in that column, so a
/// short header (e.g. "Task") in a fixed 18-wide cell does not leave 14 chars
/// of trailing whitespace. Mirrors cli-table3 / comfy-table auto-sizing.
function sizeColumnsToContent(columns: Column[], rows: string[][]): Column[] {
  return columns.map((col, i) => {
    let maxLen = visibleLength(col.header)
    for (const row of rows) {
      const cell = row[i] ?? ''
      const len = visibleLength(cell)
      if (len > maxLen) maxLen = len
    }
    return { ...col, width: Math.max(col.width, maxLen) }
  })
}

function frameWidth(columns: Column[]): number {
  if (columns.length === 0) return 0
  // 1 (left border) + sum(col + 2 padding) + (N-1) inner separators + 1 (right border)
  return 2 + columns.reduce((acc, c) => acc + c.width + 2, 0) + (columns.length - 1)
}

function chooseColumns(byTask: boolean, available: number): Column[] {
  const all = defaultColumns(byTask)
  if (frameWidth(all) <= available) return all

  // Drop in this order so the table degrades sensibly. Cache columns drop as
  // a pair (showing only one of cache write / cache read looks broken).
  const kept = new Set(all)
  for (const group of DROP_COLUMN_GROUPS) {
    for (const key of group) {
      const col = all.find(c => c.key === key)
      if (col) kept.delete(col)
    }
    const remaining = all.filter(c => kept.has(c))
    if (frameWidth(remaining) <= available) return remaining
  }
  return all.filter(c => c.priority === 0)
}

function expandedColumnWeight(col: Column): number {
  switch (col.key) {
    case 'task':
    case 'model':
      return 3
    case 'provider':
      return 2
    default:
      return 1
  }
}

/// Expands a fitted table to the available terminal width. The extra cells are
/// spread across all visible columns, weighted toward text columns so grouped
/// model/task rows breathe on wide terminals without turning numeric columns
/// into huge empty gutters.
function expandColumnsToWidth(columns: Column[], targetWidth: number): Column[] {
  let remaining = targetWidth - frameWidth(columns)
  if (remaining <= 0 || columns.length === 0) return columns

  const expanded = columns.map(c => ({ ...c }))
  const weights = expanded.map(expandedColumnWeight)
  const totalWeight = weights.reduce((sum, w) => sum + w, 0)

  for (let i = 0; i < expanded.length; i++) {
    const add = Math.floor((targetWidth - frameWidth(columns)) * (weights[i]! / totalWeight))
    if (add <= 0) continue
    expanded[i]!.width += add
    remaining -= add
  }

  // Hand out rounding leftovers in the same preference order.
  const preferred: Column['key'][] = ['task', 'model', 'provider', 'total', 'cost', 'input', 'output', 'cacheRead', 'cacheWrite']
  while (remaining > 0) {
    let changed = false
    for (const key of preferred) {
      const col = expanded.find(c => c.key === key)
      if (!col) continue
      col.width += 1
      remaining -= 1
      changed = true
      if (remaining === 0) break
    }
    if (!changed) break
  }

  return expanded
}

function renderRow(cells: string[], columns: Column[]): string {
  const padded = cells.map((c, i) => pad(c, columns[i]!.width, columns[i]!.align))
  return BOX.vertical + ' ' + padded.join(' ' + BOX.vertical + ' ') + ' ' + BOX.vertical
}

function renderBorder(columns: Column[], left: string, mid: string, right: string): string {
  const segments = columns.map(c => BOX.horizontal.repeat(c.width + 2))
  return left + segments.join(mid) + right
}

function defaultTerminalWidth(): number {
  const cols = process.stdout.columns
  if (typeof cols === 'number' && cols > 0) return cols
  // Honor $COLUMNS when stdout is not a TTY (piped, tee'd, etc.); some
  // shells set it even when isTTY is false.
  const envCols = process.env['COLUMNS'] ? parseInt(process.env['COLUMNS'], 10) : NaN
  if (Number.isFinite(envCols) && envCols > 0) return envCols
  // Conservative fallback. 100 keeps the table readable on the most common
  // terminal sizes (80, 100, 120) without trying to fit cache columns into
  // a window that cannot hold them.
  return 100
}

/// Renders a Unicode box-drawn table. Columns are auto-sized to their content
/// (with declared `width` as a minimum). When the terminal is narrow, drops
/// the lowest-priority columns (cache first, then input/output, then top-task)
/// so the table fits without wrapping.
export function renderTable(
  rows: ModelReportRow[],
  opts: TableRenderOptions = {},
): string {
  const byTask = opts.byTask ?? false
  const showTotals = opts.showTotals ?? true
  const available = opts.terminalWidth ?? defaultTerminalWidth()
  const fullWidth = opts.fullWidth ?? true

  const valueOf = (row: ModelReportRow, key: Column['key'], isNewGroup: boolean): string => {
    switch (key) {
      case 'provider':   return isNewGroup ? row.providerDisplayName : ''
      case 'model':      return isNewGroup ? row.modelDisplayName : ''
      case 'task':
        if (byTask) return row.category ? categoryLabel(row.category) : ''
        return row.topCategory
          ? `${categoryLabel(row.topCategory)} ${chalk.dim(`(${Math.round((row.topCategoryShare ?? 0) * 100)}%)`)}`
          : chalk.dim('-')
      case 'input':      return formatTokens(row.inputTokens)
      case 'output':     return formatTokens(row.outputTokens)
      case 'cacheWrite': return formatTokens(row.cacheWriteTokens)
      case 'cacheRead':  return formatTokens(row.cacheReadTokens)
      case 'total':      return formatTokens(row.totalTokens)
      case 'cost':       return formatCost(row.costUSD)
    }
  }

  // Build all cell content first so we can size columns to fit.
  type RowCells = { kind: 'data' | 'totals'; cells: string[]; isNewGroup: boolean }
  const rowEntries: RowCells[] = []
  let prevProviderModel = ''
  for (const row of rows) {
    const groupKey = `${row.provider} ${row.model}`
    const isNewGroup = !byTask || groupKey !== prevProviderModel
    prevProviderModel = groupKey
    const allCells = defaultColumns(byTask).map(col => {
      const raw = valueOf(row, col.key, isNewGroup)
      if (col.key === 'provider' && raw) return chalk.dim(raw)
      return raw
    })
    rowEntries.push({ kind: 'data', cells: allCells, isNewGroup })
  }

  let totalsEntry: RowCells | null = null
  if (showTotals && rows.length > 0) {
    const totals = rows.reduce(
      (acc, r) => {
        acc.input += r.inputTokens
        acc.output += r.outputTokens
        acc.cacheWrite += r.cacheWriteTokens
        acc.cacheRead += r.cacheReadTokens
        acc.total += r.totalTokens
        acc.cost += r.costUSD
        return acc
      },
      { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, cost: 0 },
    )
    const cells = defaultColumns(byTask).map(col => {
      switch (col.key) {
        case 'provider':   return ''
        case 'model':      return chalk.yellow.bold('Total')
        case 'task':       return ''
        case 'input':      return chalk.yellow(formatTokens(totals.input))
        case 'output':     return chalk.yellow(formatTokens(totals.output))
        case 'cacheWrite': return chalk.yellow(formatTokens(totals.cacheWrite))
        case 'cacheRead':  return chalk.yellow(formatTokens(totals.cacheRead))
        case 'total':      return chalk.yellow.bold(formatTokens(totals.total))
        case 'cost':       return chalk.yellow.bold(formatCost(totals.cost))
      }
    })
    totalsEntry = { kind: 'totals', cells, isNewGroup: true }
  }

  // Pick which columns to include based on terminal width, then size them.
  // We index into `cells` by the column key to avoid object-identity pitfalls
  // across defaultColumns() invocations.
  const allKeys = defaultColumns(byTask).map(c => c.key)
  const indexByKey = new Map(allKeys.map((k, i) => [k, i]))
  const columns = chooseColumns(byTask, available)
  const projectColumns = (cols: Column[], entry: RowCells) =>
    cols.map(c => entry.cells[indexByKey.get(c.key)!] ?? '')
  const cellMatrix = [
    ...rowEntries.map(e => projectColumns(columns, e)),
    ...(totalsEntry ? [projectColumns(columns, totalsEntry)] : []),
  ]
  const sized = sizeColumnsToContent(columns, cellMatrix)

  // If content sizing pushed the table back over budget, keep dropping the
  // same low-value column groups until the rendered frame fits.
  let final = sized
  if (frameWidth(final) > available) {
    let reduced = columns
    for (const group of DROP_COLUMN_GROUPS) {
      reduced = reduced.filter(c => !group.includes(c.key))
      const reducedMatrix = [
        ...rowEntries.map(e => projectColumns(reduced, e)),
        ...(totalsEntry ? [projectColumns(reduced, totalsEntry)] : []),
      ]
      const candidate = sizeColumnsToContent(reduced, reducedMatrix)
      final = candidate
      if (frameWidth(candidate) <= available) break
    }
  }

  if (fullWidth && frameWidth(final) < available) {
    final = expandColumnsToWidth(final, available)
  }

  const lines: string[] = []
  lines.push(renderBorder(final, BOX.topLeft, BOX.topT, BOX.topRight))
  lines.push(renderRow(final.map(c => chalk.cyan.bold(c.header)), final))
  lines.push(renderBorder(final, BOX.leftT, BOX.cross, BOX.rightT))

  let isFirstRow = true
  for (const entry of rowEntries) {
    if (byTask && entry.isNewGroup && !isFirstRow) {
      lines.push(renderBorder(final, BOX.leftT, BOX.cross, BOX.rightT))
    }
    isFirstRow = false
    lines.push(renderRow(projectColumns(final, entry), final))
  }

  if (totalsEntry) {
    lines.push(renderBorder(final, BOX.leftT, BOX.cross, BOX.rightT))
    lines.push(renderRow(projectColumns(final, totalsEntry), final))
  }

  lines.push(renderBorder(final, BOX.bottomLeft, BOX.bottomT, BOX.bottomRight))
  return lines.join('\n')
}

export function renderJson(rows: ModelReportRow[]): string {
  return JSON.stringify(
    rows.map(r => ({
      provider: r.provider,
      providerDisplayName: r.providerDisplayName,
      model: r.model,
      modelDisplayName: r.modelDisplayName,
      category: r.category ?? r.topCategory ?? null,
      topCategory: r.topCategory ?? null,
      topCategoryShare: r.topCategoryShare ?? null,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheWriteTokens: r.cacheWriteTokens,
      cacheReadTokens: r.cacheReadTokens,
      totalTokens: r.totalTokens,
      calls: r.calls,
      costUSD: r.costUSD,
    })),
    null,
    2,
  )
}

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

function mdEscape(value: string): string {
  // Pipes break GitHub-flavored markdown tables; escape them.
  return value.replace(/\|/g, '\\|')
}

/// GitHub-flavored markdown table. Renders cleanly on GitHub, Notion, and most
/// chat platforms that understand markdown. Always shows provider/model on
/// every row (no blank-repeat trick) so the table remains useful when copied
/// into a context that loses whitespace alignment.
export function renderMarkdown(rows: ModelReportRow[], opts: { byTask?: boolean; showTotals?: boolean } = {}): string {
  const byTask = opts.byTask ?? false
  const showTotals = opts.showTotals ?? true

  const header = byTask
    ? ['Provider', 'Model', 'Task', 'Input', 'Output', 'Cache Write', 'Cache Read', 'Total', 'Cost']
    : ['Provider', 'Model', 'Top Task', 'Input', 'Output', 'Cache Write', 'Cache Read', 'Total', 'Cost']
  const align = ['---', '---', '---', '---:', '---:', '---:', '---:', '---:', '---:']

  const lines: string[] = []
  lines.push(`| ${header.join(' | ')} |`)
  lines.push(`| ${align.join(' | ')} |`)

  for (const row of rows) {
    const taskCell = byTask
      ? row.category ? categoryLabel(row.category) : ''
      : row.topCategory
        ? `${categoryLabel(row.topCategory)} (${Math.round((row.topCategoryShare ?? 0) * 100)}%)`
        : '-'
    const cells = [
      mdEscape(row.providerDisplayName),
      `\`${mdEscape(row.modelDisplayName)}\``,
      taskCell,
      formatTokens(row.inputTokens),
      formatTokens(row.outputTokens),
      formatTokens(row.cacheWriteTokens),
      formatTokens(row.cacheReadTokens),
      formatTokens(row.totalTokens),
      formatCost(row.costUSD),
    ]
    lines.push(`| ${cells.join(' | ')} |`)
  }

  if (showTotals && rows.length > 0) {
    const totals = rows.reduce(
      (acc, r) => {
        acc.input += r.inputTokens
        acc.output += r.outputTokens
        acc.cacheWrite += r.cacheWriteTokens
        acc.cacheRead += r.cacheReadTokens
        acc.total += r.totalTokens
        acc.cost += r.costUSD
        return acc
      },
      { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, cost: 0 },
    )
    const totalCells = [
      '',
      '**Total**',
      '',
      `**${formatTokens(totals.input)}**`,
      `**${formatTokens(totals.output)}**`,
      `**${formatTokens(totals.cacheWrite)}**`,
      `**${formatTokens(totals.cacheRead)}**`,
      `**${formatTokens(totals.total)}**`,
      `**${formatCost(totals.cost)}**`,
    ]
    lines.push(`| ${totalCells.join(' | ')} |`)
  }

  return lines.join('\n')
}

export function renderCsv(rows: ModelReportRow[], opts: { byTask?: boolean } = {}): string {
  const byTask = opts.byTask ?? false
  // CSV intentionally repeats provider/model on every row so downstream
  // consumers can sort/filter without first reconstructing the grouping.
  const header = byTask
    ? ['provider', 'model', 'task', 'input_tokens', 'output_tokens', 'cache_write_tokens', 'cache_read_tokens', 'total_tokens', 'calls', 'cost_usd']
    : ['provider', 'model', 'top_task', 'top_task_share', 'input_tokens', 'output_tokens', 'cache_write_tokens', 'cache_read_tokens', 'total_tokens', 'calls', 'cost_usd']
  const lines: string[] = [header.join(',')]
  for (const r of rows) {
    const cells = byTask
      ? [
          csvEscape(r.providerDisplayName),
          csvEscape(r.modelDisplayName),
          r.category ? categoryLabel(r.category) : '',
          String(r.inputTokens),
          String(r.outputTokens),
          String(r.cacheWriteTokens),
          String(r.cacheReadTokens),
          String(r.totalTokens),
          String(r.calls),
          r.costUSD.toFixed(6),
        ]
      : [
          csvEscape(r.providerDisplayName),
          csvEscape(r.modelDisplayName),
          r.topCategory ? categoryLabel(r.topCategory) : '',
          r.topCategoryShare !== undefined ? r.topCategoryShare.toFixed(4) : '',
          String(r.inputTokens),
          String(r.outputTokens),
          String(r.cacheWriteTokens),
          String(r.cacheReadTokens),
          String(r.totalTokens),
          String(r.calls),
          r.costUSD.toFixed(6),
        ]
    lines.push(cells.join(','))
  }
  return lines.join('\n')
}
