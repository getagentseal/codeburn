import chalk from 'chalk'
import stripAnsi from 'strip-ansi'

import { isBehavioralCall } from './behavioral-weight.js'
import { codexCredits } from './codex-credits.js'
import { formatCost, formatTokens } from './format.js'
import { billableOutputTokens, fallbackRawModelDisplayName, getModelRoute, getRouteById, getShortModelName, modelRowKey, resolveCanonicalModelId, routeSuffix, sanitizeModelForDisplay } from './models.js'
import { getProvider } from './providers/index.js'
import { CATEGORY_LABELS, type ProjectSummary, type TaskCategory } from './types.js'

export type ModelReportRow = {
  provider: string
  providerDisplayName: string
  model: string
  modelDisplayName: string
  category: TaskCategory | null
  /// Set only in `byAgent` mode: the Claude subagent type this row's spend ran
  /// under (`general-purpose`, `Explore`, a workflow agent, …), or `'(main)'` for
  /// ordinary non-agent sessions and every non-Claude provider. `null` in the
  /// default and `byTask` views.
  agentType?: string | null
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  totalTokens: number
  costUSD: number
  savingsUSD: number
  savingsBaselineModel: string
  calls: number
  /// Raw provider/model ids folded into this row by the canonical-id merge
  /// above (e.g. `minimax/MiniMax-M3` and `MiniMaxAI/MiniMax-M3` both showing
  /// as "MiniMax M3"). Length 1 when nothing merged. Lets a cached vs
  /// uncached route stay visible even though the row is one model (#1239).
  rawModels: string[]
  /// Billing route id this row's calls went through (`bedrock`), or null for
  /// the direct door. Part of the row identity: the same model through two
  /// doors is two rows (#1449). Additive; JSON consumers that predate it
  /// ignore it.
  route: string | null
  /// Codex credit consumption (issues #408/#495). null for non-Codex models or
  /// Codex models without a known credit rate. A merged row that mixed rated
  /// and unrated buckets stores the partial sum of the rated ones.
  credits: number | null
  /// True when `credits` is a partial sum because some contributing buckets
  /// had no known credit rate.
  creditsIncomplete?: boolean
  topCategory?: TaskCategory
  topCategoryCost?: number
  topCategoryShare?: number
}

export type AggregateOptions = {
  byTask?: boolean
  /// One row per (provider, model, agent). Mutually exclusive with `byTask`;
  /// the caller enforces that. Non-Claude providers and ordinary sessions bucket
  /// under `'(main)'`.
  byAgent?: boolean
  taskFilter?: TaskCategory
  topN?: number
  /// Threshold for the `cost`-based filter. The default `0.01` would
  /// hide local-only models whose `costUSD` is 0 but `savingsUSD` is
  /// meaningful. The implementation ORs in `savingsUSD >= minCost`
  /// so saved-only rows still surface by default.
  minCost?: number
}

type Bucket = {
  provider: string
  model: string
  /// Route id the call recorded (see ParsedApiCall.route); the id shape fills
  /// it at fold time when absent. Part of the bucket identity so a
  /// `billing_provider = bedrock` call never shares a bucket with the direct
  /// call of the same id.
  route: string | null
  category: TaskCategory | null
  agentType: string | null
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  costUSD: number
  savingsUSD: number
  savingsBaselineModel: string
  calls: number
}

type ModelKey = string
type CategoryKey = TaskCategory

/// Canonical identity of one SKU through one door: the alias-resolved id plus
/// the door's suffix from the row key — never the route id. Two route ids can
/// share one label (a door with two endpoint names), and folding on the id
/// then prints two rows the reader cannot tell apart while every label-keyed
/// surface shows one. The id is NOT peeled to its base: `us.anthropic.…`
/// prices above `anthropic.…` and stays its own row, exactly as before #1450.
/// Exported for the test that pins the row key, not the id, as the fold.
export function modelFoldKey(model: string, routeId: string | null): string {
  return `${resolveCanonicalModelId(model)} ${routeSuffix(model, routeId)}`
}

function rowFoldKey(row: Pick<ModelReportRow, 'provider' | 'model' | 'route'>): string {
  return `${row.provider} ${modelFoldKey(row.model, row.route)}`
}

/// Provider-first label with the route kept visible. A provider's own table
/// may already name the model ("Sonnet 4.5"); when the call went through a
/// door, the door's label is appended the same way modelRowKey does it, so
/// `models` reads "Sonnet 4.5 (Bedrock)" exactly where the menubar and the
/// overview do. Without a route the provider label is returned unchanged.
function routedDisplayName(providerLabel: string, model: string, routeId: string | null): string {
  const suffix = routeSuffix(model, routeId)
  if (!suffix) return providerLabel
  // The provider had no local name for a Bedrock id and echoed it (or the
  // global short name of it): the row key already resolves the base model.
  if (providerLabel === model || providerLabel === getShortModelName(model)) return modelRowKey(model, routeId)
  return providerLabel.endsWith(suffix) ? providerLabel : `${providerLabel} ${suffix}`
}

function bucketKey(provider: string, model: string, route: string | null, category: TaskCategory | null, agentType: string | null): string {
  return `${provider} ${model} ${route ?? ''} ${category ?? ''} ${agentType ?? ''}`
}

/// Walks every parsed turn, attributes each assistant call to a
/// (provider, raw-model, category, agent) bucket, then merges buckets that
/// resolve to the same provider + alias-resolved canonical id. Display names
/// stay cosmetic. Returned rows are keyed by (provider, canonical id) by
/// default, plus category under `byTask` or agent under `byAgent`.
///
/// Default view: rows sorted by cost descending.
/// byTask / byAgent view: rows grouped by (provider, model) so the renderer can
/// blank repeated provider/model cells. Group order follows total cost across
/// that model; within each group, rows go by cost descending. The agent label
/// comes from the subagent transcript's own `session.agentType`; ordinary
/// sessions and every non-Claude provider bucket under `'(main)'`.
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
          // Non-Claude sessions and ordinary main sessions have no agentType, so
          // their spend all lands under '(main)'. That is correct: the report never
          // fabricates an agent for calls that were not driven by one.
          const agentType: string | null = opts.byAgent ? (session.agentType ?? '(main)') : null
          const route = call.route ?? null
          const key = bucketKey(provider, model, route, category, agentType)
          let bucket = buckets.get(key)
          if (!bucket) {
            bucket = {
              provider,
              model,
              route,
              category,
              agentType,
              inputTokens: 0,
              outputTokens: 0,
              cacheWriteTokens: 0,
              cacheReadTokens: 0,
              costUSD: 0,
              savingsUSD: 0,
              savingsBaselineModel: '',
              calls: 0,
            }
            buckets.set(key, bucket)
          }
          bucket.inputTokens += call.usage.inputTokens
          bucket.outputTokens += billableOutputTokens(provider, call.usage.outputTokens, call.usage.reasoningTokens)
          bucket.cacheWriteTokens += call.usage.cacheCreationInputTokens
          // cacheReadInputTokens (Anthropic vocab) and cachedInputTokens (OpenAI vocab)
          // are two names for the same thing. Providers populate one or set both to the
          // same value, so take the max — summing double-counts cache reads for every
          // provider that fills both fields.
          bucket.cacheReadTokens += Math.max(call.usage.cacheReadInputTokens, call.usage.cachedInputTokens)
          bucket.costUSD += call.costUSD
          bucket.savingsUSD += call.savingsUSD ?? 0
          if (!bucket.savingsBaselineModel && call.savingsBaselineModel) {
            bucket.savingsBaselineModel = call.savingsBaselineModel
          }
          // Supplementary accounting calls keep their tokens and cost above but are not
          // distinct requests, so they add no call weight (see behavioral-weight.ts).
          if (isBehavioralCall(call)) bucket.calls += 1

          const modelKey = `${provider} ${model} ${route ?? ''}`
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
      formatModel: p
        ? (m: string) => sanitizeModelForDisplay(fallbackRawModelDisplayName(p.modelDisplayName(m), m))
        : (m: string) => sanitizeModelForDisplay(getShortModelName(m)),
    }
    providerCache.set(name, entry)
    return entry
  }

  const rowsByKey = new Map<string, ModelReportRow>()
  const foldedCategoryCost = new Map<string, Map<CategoryKey, number>>()
  const foldedTotalCost = new Map<string, number>()
  const foldedRawSeen = new Set<string>()
  // Empty string on the row means both "none seen" and "conflict". Track
  // distinct non-empty baselines separately so a later bucket cannot
  // repopulate a conflict that was already detected.
  const baselinesByKey = new Map<string, Set<string>>()

  for (const bucket of buckets.values()) {
    const meta = await resolveProvider(bucket.provider)
    // Fold by canonical id AND the row key's door suffix, and label the row
    // with the same key every other surface uses (modelRowKey), so `models`,
    // the menubar payload and the overview agree on what one row is. The
    // route is the persisted one when the provider recorded it, else what the
    // id's shape names.
    const routeId = getRouteById(bucket.route)?.id ?? getModelRoute(bucket.model)?.id ?? null
    const modelDisplayName = sanitizeModelForDisplay(routedDisplayName(meta.formatModel(bucket.model), bucket.model, routeId))
    const canonicalId = modelFoldKey(bucket.model, routeId)
    const resolvedKey = bucketKey(bucket.provider, canonicalId, null, bucket.category, bucket.agentType)
    const foldKey = `${bucket.provider} ${canonicalId}`
    const total = bucket.inputTokens + bucket.outputTokens + bucket.cacheWriteTokens + bucket.cacheReadTokens
    // Credits are per raw id (aliases can have different rates). Sum the
    // rated buckets and flag the row incomplete when any contributor is
    // unrated — nulling the whole merge would zero a real menubar total.
    // outputTokens is already the billable output (for Codex that includes
    // reasoning, so nothing is added on top), and inputTokens is non-cached
    // with cacheReadTokens holding cached input - exactly what the credit
    // rates expect.
    const bucketCredits = bucket.provider === 'codex'
      ? codexCredits(bucket.model, {
          inputTokens: bucket.inputTokens,
          cachedReadTokens: bucket.cacheReadTokens,
          outputTokens: bucket.outputTokens,
        })
      : null

    const baselines = baselinesByKey.get(resolvedKey) ?? new Set<string>()
    if (bucket.savingsBaselineModel) baselines.add(bucket.savingsBaselineModel)
    baselinesByKey.set(resolvedKey, baselines)
    const resolvedBaseline = baselines.size === 1 ? [...baselines][0]! : ''

    const existing = rowsByKey.get(resolvedKey)
    if (existing) {
      existing.inputTokens += bucket.inputTokens
      existing.outputTokens += bucket.outputTokens
      existing.cacheWriteTokens += bucket.cacheWriteTokens
      existing.cacheReadTokens += bucket.cacheReadTokens
      existing.totalTokens += total
      existing.costUSD += bucket.costUSD
      existing.savingsUSD += bucket.savingsUSD
      existing.calls += bucket.calls
      existing.savingsBaselineModel = resolvedBaseline
      if (!existing.rawModels.includes(bucket.model)) existing.rawModels.push(bucket.model)
      const existingRated = existing.credits !== null
      const incomingRated = bucketCredits !== null
      if (incomingRated) existing.credits = (existing.credits ?? 0) + bucketCredits
      if (existingRated !== incomingRated) existing.creditsIncomplete = true
    } else {
      rowsByKey.set(resolvedKey, {
        provider: bucket.provider,
        providerDisplayName: meta.displayName,
        model: bucket.model,
        modelDisplayName,
        route: routeId,
        category: bucket.category,
        agentType: bucket.agentType,
        inputTokens: bucket.inputTokens,
        outputTokens: bucket.outputTokens,
        cacheWriteTokens: bucket.cacheWriteTokens,
        cacheReadTokens: bucket.cacheReadTokens,
        totalTokens: total,
        costUSD: bucket.costUSD,
        savingsUSD: bucket.savingsUSD,
        savingsBaselineModel: resolvedBaseline,
        calls: bucket.calls,
        rawModels: [bucket.model],
        credits: bucketCredits,
      })
    }

    const rawKey = `${bucket.provider} ${bucket.model} ${bucket.route ?? ''}`
    if (!foldedRawSeen.has(rawKey)) {
      foldedRawSeen.add(rawKey)
      const rawCat = perModelCategoryCost.get(rawKey)
      if (rawCat) {
        let folded = foldedCategoryCost.get(foldKey)
        if (!folded) {
          folded = new Map()
          foldedCategoryCost.set(foldKey, folded)
        }
        for (const [cat, cost] of rawCat) {
          folded.set(cat, (folded.get(cat) ?? 0) + cost)
        }
      }
      foldedTotalCost.set(
        foldKey,
        (foldedTotalCost.get(foldKey) ?? 0) + (perModelTotalCost.get(rawKey) ?? 0),
      )
    }
  }

  const rows = [...rowsByKey.values()]
  for (const row of rows) {
    if (opts.byTask || opts.byAgent) continue
    const perCat = foldedCategoryCost.get(rowFoldKey(row))
    if (!perCat || perCat.size === 0) continue
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

  if (opts.byTask || opts.byAgent) {
    rows.sort((a, b) => {
      const aTotal = foldedTotalCost.get(rowFoldKey(a)) ?? 0
      const bTotal = foldedTotalCost.get(rowFoldKey(b)) ?? 0
      if (aTotal !== bTotal) return bTotal - aTotal
      if (a.provider !== b.provider) return a.provider.localeCompare(b.provider)
      if (a.modelDisplayName !== b.modelDisplayName) return a.modelDisplayName.localeCompare(b.modelDisplayName)
      return (b.costUSD + b.savingsUSD) - (a.costUSD + a.savingsUSD)
    })
  } else {
    rows.sort((a, b) => (b.costUSD + b.savingsUSD) - (a.costUSD + a.savingsUSD))
  }

  let filtered = rows
  if (opts.minCost !== undefined) {
    // OR with savings so local models with $0 actual cost but > 0 saved
    // counterfactual still surface in the default `models` view.
    filtered = filtered.filter(r => r.costUSD >= opts.minCost! || r.savingsUSD >= opts.minCost!)
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
  key: 'provider' | 'model' | 'task' | 'input' | 'output' | 'cacheWrite' | 'cacheRead' | 'total' | 'cost' | 'saved'
}

type TableRenderOptions = {
  byTask?: boolean
  byAgent?: boolean
  showTotals?: boolean
  terminalWidth?: number
  fullWidth?: boolean
}

/// The third column reuses the `task` slot for all three modes: 'Top Task' in
/// the default view, 'Task' under byTask, 'Agent' under byAgent.
function thirdColumnHeader(byTask: boolean, byAgent: boolean): string {
  if (byAgent) return 'Agent'
  return byTask ? 'Task' : 'Top Task'
}

const DROP_COLUMN_GROUPS: Array<Array<Column['key']>> = [
  ['cacheWrite', 'cacheRead'],
  ['input', 'output'],
  ['task'],
  ['saved'],
]

function defaultColumns(byTask: boolean, byAgent: boolean, showSaved: boolean): Column[] {
  // Higher priority numbers drop FIRST when the terminal is narrow.
  // Cache columns are the cheapest to lose, then input/output, then top-task.
  // Provider/Model/Total/Cost stay regardless. The Saved column only appears
  // when local-model savings actually exist (a `codeburn model-savings`
  // mapping produced nonzero avoided spend); otherwise it would be a column of
  // dashes for the majority of users, so it is omitted entirely.
  // Widths are MINIMUMS; sizeColumnsToContent() expands them to fit cell text.
  return [
    { key: 'provider',   header: 'Provider',                          align: 'left',  width: 8,  priority: 0 },
    { key: 'model',      header: 'Model',                             align: 'left',  width: 8,  priority: 0 },
    { key: 'task',       header: thirdColumnHeader(byTask, byAgent),  align: 'left',  width: 8,  priority: 1 },
    { key: 'input',      header: 'Input',                      align: 'right', width: 6,  priority: 2 },
    { key: 'output',     header: 'Output',                     align: 'right', width: 6,  priority: 2 },
    { key: 'cacheWrite', header: 'Cache Write',                align: 'right', width: 11, priority: 3 },
    { key: 'cacheRead',  header: 'Cache Read',                 align: 'right', width: 10, priority: 3 },
    { key: 'total',      header: 'Total',                      align: 'right', width: 6,  priority: 0 },
    { key: 'cost',       header: 'Cost',                       align: 'right', width: 6,  priority: 0 },
    ...(showSaved ? [{ key: 'saved' as const, header: 'Saved', align: 'right' as const, width: 6, priority: 0 }] : []),
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

function chooseColumns(byTask: boolean, byAgent: boolean, available: number, showSaved: boolean): Column[] {
  const all = defaultColumns(byTask, byAgent, showSaved)
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
  const byAgent = opts.byAgent ?? false
  // Both byTask and byAgent group rows under (provider, model) and blank the
  // repeated provider/model cells; the default view keeps them on every row.
  const grouped = byTask || byAgent
  const showTotals = opts.showTotals ?? true
  const available = opts.terminalWidth ?? defaultTerminalWidth()
  const fullWidth = opts.fullWidth ?? true
  // Only render the Saved column when something was actually saved.
  const showSaved = rows.some(r => r.savingsUSD > 0)

  const valueOf = (row: ModelReportRow, key: Column['key'], isNewGroup: boolean): string => {
    switch (key) {
      case 'provider':   return isNewGroup ? row.providerDisplayName : ''
      case 'model':      return isNewGroup ? row.modelDisplayName : ''
      case 'task':
        if (byAgent) return row.agentType ?? ''
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
      case 'saved':      return row.savingsUSD > 0 ? formatCost(row.savingsUSD) : chalk.dim('-')
    }
  }

  // Build all cell content first so we can size columns to fit.
  type RowCells = { kind: 'data' | 'totals'; cells: string[]; isNewGroup: boolean }
  const rowEntries: RowCells[] = []
  let prevProviderModel = ''
  for (const row of rows) {
    const groupKey = `${row.provider} ${row.modelDisplayName}`
    const isNewGroup = !grouped || groupKey !== prevProviderModel
    prevProviderModel = groupKey
    const allCells = defaultColumns(byTask, byAgent, showSaved).map(col => {
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
        acc.savings += r.savingsUSD
        return acc
      },
      { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, cost: 0, savings: 0 },
    )
    const cells = defaultColumns(byTask, byAgent, showSaved).map(col => {
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
        case 'saved':      return totals.savings > 0 ? chalk.yellow.bold(formatCost(totals.savings)) : chalk.dim('-')
      }
    })
    totalsEntry = { kind: 'totals', cells, isNewGroup: true }
  }

  // Pick which columns to include based on terminal width, then size them.
  // We index into `cells` by the column key to avoid object-identity pitfalls
  // across defaultColumns() invocations.
  const allKeys = defaultColumns(byTask, byAgent, showSaved).map(c => c.key)
  const indexByKey = new Map(allKeys.map((k, i) => [k, i]))
  const columns = chooseColumns(byTask, byAgent, available, showSaved)
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
    if (grouped && entry.isNewGroup && !isFirstRow) {
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
      rawModels: r.rawModels,
      route: r.route,
      category: r.category ?? r.topCategory ?? null,
      agentType: r.agentType ?? null,
      topCategory: r.topCategory ?? null,
      topCategoryShare: r.topCategoryShare ?? null,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheWriteTokens: r.cacheWriteTokens,
      cacheReadTokens: r.cacheReadTokens,
      totalTokens: r.totalTokens,
      calls: r.calls,
      costUSD: r.costUSD,
      savingsUSD: r.savingsUSD,
      savingsBaselineModel: r.savingsBaselineModel,
      credits: r.credits,
      creditsIncomplete: r.creditsIncomplete === true,
    })),
    null,
    2,
  )
}

function csvEscape(value: string | undefined | null): string {
  if (value === undefined || value === null) return ''
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
export function renderMarkdown(rows: ModelReportRow[], opts: { byTask?: boolean; byAgent?: boolean; showTotals?: boolean } = {}): string {
  const byTask = opts.byTask ?? false
  const byAgent = opts.byAgent ?? false
  const showTotals = opts.showTotals ?? true

  const header = ['Provider', 'Model', thirdColumnHeader(byTask, byAgent), 'Input', 'Output', 'Cache Write', 'Cache Read', 'Total', 'Cost', 'Saved']
  const align = ['---', '---', '---', '---:', '---:', '---:', '---:', '---:', '---:', '---:']

  const lines: string[] = []
  lines.push(`| ${header.join(' | ')} |`)
  lines.push(`| ${align.join(' | ')} |`)

  for (const row of rows) {
    const taskCell = byAgent
      ? row.agentType ?? ''
      : byTask
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
      row.savingsUSD > 0 ? formatCost(row.savingsUSD) : '-',
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
        acc.savings += r.savingsUSD
        return acc
      },
      { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, cost: 0, savings: 0 },
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
      totals.savings > 0 ? `**${formatCost(totals.savings)}**` : '-',
    ]
    lines.push(`| ${totalCells.join(' | ')} |`)
  }

  return lines.join('\n')
}

export function renderCsv(rows: ModelReportRow[], opts: { byTask?: boolean; byAgent?: boolean } = {}): string {
  const byTask = opts.byTask ?? false
  const byAgent = opts.byAgent ?? false
  // CSV intentionally repeats provider/model on every row so downstream
  // consumers can sort/filter without first reconstructing the grouping.
  const header = byAgent
    ? ['provider', 'model', 'agent', 'input_tokens', 'output_tokens', 'cache_write_tokens', 'cache_read_tokens', 'total_tokens', 'calls', 'cost_usd', 'savings_usd', 'savings_baseline_model']
    : byTask
    ? ['provider', 'model', 'task', 'input_tokens', 'output_tokens', 'cache_write_tokens', 'cache_read_tokens', 'total_tokens', 'calls', 'cost_usd', 'savings_usd', 'savings_baseline_model']
    : ['provider', 'model', 'top_task', 'top_task_share', 'input_tokens', 'output_tokens', 'cache_write_tokens', 'cache_read_tokens', 'total_tokens', 'calls', 'cost_usd', 'savings_usd', 'savings_baseline_model']
  const lines: string[] = [header.join(',')]
  for (const r of rows) {
    const cells = byAgent
      ? [
          csvEscape(r.providerDisplayName),
          csvEscape(r.modelDisplayName),
          csvEscape(r.agentType ?? ''),
          String(r.inputTokens),
          String(r.outputTokens),
          String(r.cacheWriteTokens),
          String(r.cacheReadTokens),
          String(r.totalTokens),
          String(r.calls),
          r.costUSD.toFixed(6),
          (r.savingsUSD ?? 0).toFixed(6),
          csvEscape(r.savingsBaselineModel),
        ]
      : byTask
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
          (r.savingsUSD ?? 0).toFixed(6),
          csvEscape(r.savingsBaselineModel),
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
          (r.savingsUSD ?? 0).toFixed(6),
          csvEscape(r.savingsBaselineModel),
        ]
    lines.push(cells.join(','))
  }
  return lines.join('\n')
}
