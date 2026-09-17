import { isBehavioralTurn } from './behavioral-weight.js'
import { getShortModelName, modelRowKey } from './models.js'
import { CATEGORY_LABELS, type ProjectSummary } from './types.js'
import type { MenubarPayload } from './menubar-json.js'

/// The anonymised daily aggregate that both the desktop app and the Windows
/// tray send as the consent-gated `usage_snapshot` telemetry event. It is
/// computed here, in the CLI, so the two surfaces cannot drift into two
/// different shapes.
///
/// Privacy contract, held by construction rather than by a caller's discipline:
/// - Every magnitude is a bucket label. No exact dollar amounts, no exact
///   counts, no exact durations.
/// - Names are configuration or model identifiers only: model names, task
///   category labels, provider display names, MCP server / skill / tool names.
///   Nothing here is derived from a working directory, project name, branch
///   name, file path or message text.
/// - Leaves are only short strings, finite numbers and booleans, nested at most
///   two containers deep, so the desktop's whitelist sanitizer passes the block
///   through unchanged.
/// - Arrays are capped (see the limits below) so the block stays small.

export const TELEMETRY_SNAPSHOT_SCHEMA = 2

const MAX_MODELS = 8
const MAX_TASKS_PER_MODEL = 6
const MAX_CATEGORIES = 12
const MAX_MODELS_PER_CATEGORY = 3
const MAX_PROVIDERS = 8
const MAX_NAMED = 12
const MAX_NAME = 64
const SYNTHETIC_MODEL_NAME = '<synthetic>'

/// Shared with the desktop renderer's fallback builder: 1, 10, 50, 200 and
/// 1000 USD boundaries.
export function costBucket(usd: number): string {
  if (!Number.isFinite(usd) || usd < 1) return '<1'
  if (usd < 10) return '1-10'
  if (usd < 50) return '10-50'
  if (usd < 200) return '50-200'
  if (usd < 1000) return '200-1k'
  return '1k+'
}

/// Occurrence counts (turns, calls, sessions) coarsened the same way dollars
/// are, with one extra label at the bottom: `0`. Nothing happened is not the
/// same claim as "between one and ten", and a model the payload lists but that
/// has no behavioural turns behind it would otherwise report activity it never
/// had. A count that is not a finite number is unknown, which is likewise not
/// evidence of use, so it reads as `0` too.
/// Buckets: `0`, `1-10`, `10-100`, `100-1k`, `1k+`.
export function countBucket(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 10) return '1-10'
  if (n < 100) return '10-100'
  if (n < 1000) return '100-1k'
  return '1k+'
}

/// Wall-clock session length. Coarse enough that a single session cannot be
/// recognised from its duration.
export function minutesBucket(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 5) return '<5'
  if (minutes < 15) return '5-15'
  if (minutes < 60) return '15-60'
  if (minutes < 240) return '60-240'
  return '240+'
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/// Rates are reported to 2dp, or -1 when the denominator is empty. -1 is the
/// established "not computable" marker for these fields, so a consumer never
/// has to tell a missing rate apart from a genuine zero.
function rate2(numerator: number, denominator: number): number {
  if (denominator <= 0) return -1
  return round2(numerator / denominator)
}

function safeName(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, MAX_NAME) : ''
}

/// One (model, task category) cell of the model x task cross. Raw counts; only
/// their buckets and shares ever reach the snapshot.
export type ModelTaskTurns = {
  model: string
  category: string
  turns: number
  editTurns: number
  oneShotTurns: number
}

/// What the snapshot needs that the menubar payload does not already carry.
export type TelemetrySnapshotInput = {
  modelTasks?: ModelTaskTurns[]
  /// Session wall-clock durations in minutes. Only the median's bucket is sent.
  sessionMinutes?: number[]
}

export type SnapshotTask = { name: string; turnBucket: string; share: number }
export type SnapshotModel = {
  name: string
  costBucket: string
  turnBucket: string
  oneShotRate: number
  tasks: SnapshotTask[]
}
export type SnapshotCategory = {
  name: string
  turnBucket: string
  oneShotRate: number
  topModels: string[]
}
export type SnapshotProvider = { name: string; costBucket: string }
export type SnapshotNamedCalls = { name: string; callBucket: string }

export type TelemetrySnapshot = {
  schema: number
  period: string
  providerCount: number
  costBucket: string
  models: SnapshotModel[]
  categories: SnapshotCategory[]
  providers: SnapshotProvider[]
  mcpServers: SnapshotNamedCalls[]
  skills: SnapshotNamedCalls[]
  tools: SnapshotNamedCalls[]
  sessions: { countBucket: string; medianMinutesBucket?: string }
  efficiency: { cacheHitRate?: number; retryTaxShare?: number }
}

/// Walks parsed turns once and buckets each behavioural turn under its primary
/// model and its task category. The primary model is the turn's first
/// non-synthetic assistant call, matching how `aggregateModelEfficiency`
/// attributes a turn, and it is shortened with `getShortModelName` so the keys
/// line up with the payload's `topModels[].name`.
export function aggregateModelTaskTurns(projects: ProjectSummary[]): ModelTaskTurns[] {
  const rows = new Map<string, ModelTaskTurns>()
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        if (!isBehavioralTurn(turn)) continue
        const primary = turn.assistantCalls.find(call => getShortModelName(call.model) !== SYNTHETIC_MODEL_NAME)
        if (!primary) continue
        const model = modelRowKey(primary.model, primary.route)
        const category = CATEGORY_LABELS[turn.category] ?? turn.category
        const key = `${model}\u0000${category}`
        let row = rows.get(key)
        if (!row) {
          row = { model, category, turns: 0, editTurns: 0, oneShotTurns: 0 }
          rows.set(key, row)
        }
        row.turns++
        if (turn.hasEdits) {
          row.editTurns++
          if (turn.retries === 0) row.oneShotTurns++
        }
      }
    }
  }
  return [...rows.values()]
}

/// Session wall-clock lengths in minutes, for the median duration bucket.
export function sessionDurationMinutes(projects: ProjectSummary[]): number[] {
  const minutes: number[] = []
  for (const project of projects) {
    for (const session of project.sessions) {
      const start = Date.parse(session.firstTimestamp)
      const end = Date.parse(session.lastTimestamp)
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue
      minutes.push((end - start) / 60_000)
    }
  }
  return minutes
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]!
  return (sorted[mid - 1]! + sorted[mid]!) / 2
}

type ModelRollup = {
  turns: number
  editTurns: number
  oneShotTurns: number
  tasks: Map<string, number>
}

export function buildTelemetrySnapshot(
  payload: MenubarPayload,
  input: TelemetrySnapshotInput = {},
): TelemetrySnapshot {
  const current = payload.current
  const byModel = new Map<string, ModelRollup>()
  const byCategory = new Map<string, Map<string, number>>()
  for (const row of input.modelTasks ?? []) {
    const model = safeName(row.model)
    const category = safeName(row.category)
    if (!model || !category || !Number.isFinite(row.turns) || row.turns <= 0) continue
    let rollup = byModel.get(model)
    if (!rollup) {
      rollup = { turns: 0, editTurns: 0, oneShotTurns: 0, tasks: new Map() }
      byModel.set(model, rollup)
    }
    rollup.turns += row.turns
    rollup.editTurns += Number.isFinite(row.editTurns) ? row.editTurns : 0
    rollup.oneShotTurns += Number.isFinite(row.oneShotTurns) ? row.oneShotTurns : 0
    rollup.tasks.set(category, (rollup.tasks.get(category) ?? 0) + row.turns)
    const models = byCategory.get(category) ?? new Map<string, number>()
    models.set(model, (models.get(model) ?? 0) + row.turns)
    byCategory.set(category, models)
  }

  const models: SnapshotModel[] = []
  for (const model of current.topModels ?? []) {
    if (models.length >= MAX_MODELS) break
    const name = safeName(model.name)
    if (!name) continue
    const rollup = byModel.get(name)
    const tasks: SnapshotTask[] = rollup
      ? [...rollup.tasks.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, MAX_TASKS_PER_MODEL)
          .map(([category, turns]) => ({
            name: category,
            turnBucket: countBucket(turns),
            share: rate2(turns, rollup.turns),
          }))
      : []
    models.push({
      name,
      costBucket: costBucket(model.cost),
      turnBucket: countBucket(rollup?.turns ?? 0),
      oneShotRate: rate2(rollup?.oneShotTurns ?? 0, rollup?.editTurns ?? 0),
      tasks,
    })
  }

  const categories: SnapshotCategory[] = []
  for (const activity of current.topActivities ?? []) {
    if (categories.length >= MAX_CATEGORIES) break
    const name = safeName(activity.name)
    if (!name) continue
    categories.push({
      name,
      turnBucket: countBucket(activity.turns),
      oneShotRate: activity.oneShotRate == null ? -1 : round2(activity.oneShotRate),
      topModels: [...(byCategory.get(name) ?? new Map<string, number>()).entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_MODELS_PER_CATEGORY)
        .map(([model]) => model),
    })
  }

  const providers: SnapshotProvider[] = Object.entries(current.providers ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_PROVIDERS)
    .map(([name, cost]) => ({ name: safeName(name), costBucket: costBucket(cost) }))
    .filter(entry => entry.name !== '')

  const named = <T>(rows: T[] | undefined, name: (row: T) => unknown, calls: (row: T) => number): SnapshotNamedCalls[] =>
    (rows ?? [])
      .slice(0, MAX_NAMED)
      .map(row => ({ name: safeName(name(row)), callBucket: countBucket(calls(row)) }))
      .filter(entry => entry.name !== '')

  const medianMinutes = median(input.sessionMinutes ?? [])
  const cacheDenominator = current.inputTokens + current.cacheReadTokens
  const retryTaxUSD = current.retryTax?.totalUSD ?? 0

  return {
    schema: TELEMETRY_SNAPSHOT_SCHEMA,
    period: safeName(current.label),
    providerCount: Object.keys(current.providers ?? {}).length,
    costBucket: costBucket(current.cost),
    models,
    categories,
    providers,
    mcpServers: named(current.mcpServers, row => row.name, row => row.calls),
    skills: named(current.skills, row => row.name, row => row.turns),
    tools: named(current.tools, row => row.name, row => row.calls),
    sessions: {
      countBucket: countBucket(current.sessions),
      ...(medianMinutes === null ? {} : { medianMinutesBucket: minutesBucket(medianMinutes) }),
    },
    efficiency: {
      ...(cacheDenominator > 0 ? { cacheHitRate: round2(current.cacheHitPercent / 100) } : {}),
      ...(current.cost > 0 ? { retryTaxShare: round2(retryTaxUSD / current.cost) } : {}),
    },
  }
}
