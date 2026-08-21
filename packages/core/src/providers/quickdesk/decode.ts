// @codeburn/core Quickdesk decoder: pure decode over host-supplied records.
// The host reads the metrics JSONL and queries the sqlite sessions.db; this
// decoder extracts token buckets, tool lists, and user messages with no fs, env,
// clock, sqlite, pricing, or strip-ansi. It emits raw command strings (always
// empty for this provider); bash base-name extraction stays host-side.

import type { DecodeContext } from '../../contracts.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import { normalizeModelIdentifier } from '../../schema.js'
import type {
  QuickdeskDatabaseInput,
  QuickdeskDecodedCall,
  QuickdeskMetricsInput,
  QuickdeskMetricsRecord,
  QuickdeskSessionMetadata,
} from './types.js'

const METRICS_FILE_RE = /^metrics-(\d{4})-(\d{2})-(\d{2})\.jsonl$/

export const quickdeskToolNameMap: Record<string, string> = {
  readFile: 'Read',
  read_file: 'Read',
  writeFile: 'Edit',
  write_file: 'Edit',
  editFile: 'Edit',
  edit_file: 'Edit',
  runCommand: 'Bash',
  run_command: 'Bash',
  executeBash: 'Bash',
  shell: 'Bash',
  grep: 'Grep',
  searchFiles: 'Grep',
  search_files: 'Grep',
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nonNegativeNumber(value: unknown): number | undefined {
  const number = finiteNumber(value)
  return number !== undefined && number >= 0 ? number : undefined
}

function uniqueMappedTools(values: string[]): string[] {
  return [...new Set(values.map(value => quickdeskToolNameMap[value] ?? value).filter(Boolean))]
}

function unixSecondsIso(value: number): string | null {
  const date = new Date(value * 1000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / 4)
}

function usageRecord(record: Record<string, unknown>): boolean {
  return Boolean(stringValue(record['Model']))
    && nonNegativeNumber(record['InputTokens']) !== undefined
    && nonNegativeNumber(record['OutputTokens']) !== undefined
}

function sessionId(record: Record<string, unknown>): string {
  return stringValue(record['session_id'])
}

function toolsKey(record: Record<string, unknown>): string {
  return sessionId(record)
}

function collectMetricTools(records: QuickdeskMetricsRecord[]): Map<string, string[]> {
  const tools = new Map<string, string[]>()
  for (const { record } of records) {
    const key = toolsKey(record)
    const tool = stringValue(record['ToolName'])
    if (!key || !tool) continue
    const current = tools.get(key) ?? []
    current.push(quickdeskToolNameMap[tool] ?? tool)
    tools.set(key, current)
  }
  for (const [key, values] of tools) tools.set(key, [...new Set(values)])
  return tools
}

function fallbackTimestamp(path: string): string | null {
  const match = METRICS_FILE_RE.exec(path)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return date.toISOString()
}

function metricsTimestamp(record: Record<string, unknown>, fileId: string): string | null {
  const aws = asRecord(record['_aws'])
  const timestampMs = finiteNumber(aws?.['Timestamp'])
  if (timestampMs !== undefined) {
    const date = new Date(timestampMs)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  return fallbackTimestamp(fileId)
}

export type QuickdeskDecodeInput = {
  records: unknown[]
  context: DecodeContext
  seenKeys?: Set<string>
}

export type QuickdeskDecodeResult = {
  calls: QuickdeskDecodedCall[]
  diagnostics: RecordDiagnostic[]
}

function decodeMetrics(input: QuickdeskMetricsInput, seen: Set<string>): QuickdeskDecodedCall[] {
  const calls: QuickdeskDecodedCall[] = []
  const { records, sessions, project, projectPath, fileId } = input
  const linkedTools = collectMetricTools(records)

  for (const { record } of records) {
    if (!usageRecord(record)) continue
    const model = stringValue(record['Model'])
    const inputTokens = nonNegativeNumber(record['InputTokens'])!
    const outputTokens = nonNegativeNumber(record['OutputTokens'])!
    const timestamp = metricsTimestamp(record, fileId)
    if (!timestamp) continue

    const linkedSessionId = sessionId(record)
    const metadata = linkedSessionId ? sessions.get(linkedSessionId) : undefined
    if (metadata?.deleted) continue

    const fallbackId = `${project}:${fileId}`
    // The model component is normalized exactly as the observation boundary
    // normalizes `model`: the key ships on the envelope, so a display name or
    // free text in the CSV 'Model' column must collapse to 'unknown' inside
    // the key too, never ride it raw.
    const deduplicationKey = `quickdesk:${linkedSessionId || fallbackId}:${timestamp}:${normalizeModelIdentifier(model)}:${inputTokens}:${outputTokens}`
    if (seen.has(deduplicationKey)) continue
    seen.add(deduplicationKey)

    const recordedCost = nonNegativeNumber(record['CostUSD'])
    const metricTools = linkedTools.get(toolsKey(record)) ?? []
    const tools = uniqueMappedTools([...metricTools, ...(metadata?.tools ?? [])])

    calls.push({
      provider: 'quickdesk',
      model,
      inputTokens,
      outputTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      tools,
      rawBashCommands: [],
      speed: 'standard',
      timestamp,
      deduplicationKey,
      userMessage: metadata?.firstUserMessage ?? '',
      sessionId: linkedSessionId || fileId,
      project,
      projectPath,
      ...(recordedCost !== undefined ? { recordedCost } : {}),
    })
  }

  return calls
}

function decodeDatabase(input: QuickdeskDatabaseInput, seen: Set<string>): QuickdeskDecodedCall[] {
  const calls: QuickdeskDecodedCall[] = []
  const { sessions, meteredSessionIds, project, projectPath } = input

  for (const metadata of sessions) {
    if (metadata.deleted || meteredSessionIds.has(metadata.id) || metadata.createdAt === undefined) continue
    const createdAtSeconds = metadata.createdAt > 1_000_000_000_000
      ? metadata.createdAt / 1000
      : metadata.createdAt
    const timestamp = unixSecondsIso(createdAtSeconds)
    if (!timestamp) continue
    const inputTokens = estimateTokensFromChars(metadata.inputChars)
    const outputTokens = estimateTokensFromChars(metadata.outputChars)
    if (inputTokens + outputTokens === 0) continue

    const deduplicationKey = `quickdesk-est:${metadata.id}`
    if (seen.has(deduplicationKey)) continue
    seen.add(deduplicationKey)
    const model = 'quickdesk-auto'

    calls.push({
      provider: 'quickdesk',
      model,
      inputTokens,
      outputTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      tools: metadata.tools,
      rawBashCommands: [],
      speed: 'standard',
      timestamp,
      deduplicationKey,
      userMessage: metadata.firstUserMessage,
      sessionId: metadata.id,
      project,
      projectPath,
    })
  }

  return calls
}

/**
 * Decode Quickdesk records (metrics JSONL or sqlite-derived session metadata)
 * into rich, cost-free calls. Dedup is keyed on `quickdesk:<sessionId>:...`
 * against the live `seenKeys` set (host-owned).
 */
export function decodeQuickdesk({ records, seenKeys: liveSeen }: QuickdeskDecodeInput): QuickdeskDecodeResult {
  const seen = liveSeen ?? new Set<string>()
  const diagnostics: RecordDiagnostic[] = []

  const input = records[0] as QuickdeskMetricsInput | QuickdeskDatabaseInput | undefined
  if (!input || typeof input !== 'object') return { calls: [], diagnostics }

  if (input.variant === 'metrics') {
    return { calls: decodeMetrics(input, seen), diagnostics }
  }

  if (input.variant === 'database') {
    return { calls: decodeDatabase(input, seen), diagnostics }
  }

  return { calls: [], diagnostics }
}
