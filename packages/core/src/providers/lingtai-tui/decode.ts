// @codeburn/core LingTai TUI decoder: pure decode over supplied ledger JSONL records.

import type { DecodeContext } from '../../contracts.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import { sourceRefFingerprint } from '../../fingerprint.js'
import { normalizeModelIdentifier } from '../../schema.js'
import type { LingTaiTuiDecodedCall, LingTaiLedgerEntry, JsonObject } from './types.js'

export type LingTaiTuiDecodeInput = {
  records: unknown[]
  context: DecodeContext
  agentId: string
  fallbackModel: string
  fallbackEndpoint: string
  projectPath: string
  // Discovered/manifest-derived source project (host-derived). Optional so a
  // core unit test can decode without it.
  project?: string
  seenKeys?: Set<string>
}

export type LingTaiTuiDecodeResult = {
  calls: LingTaiTuiDecodedCall[]
  diagnostics: RecordDiagnostic[]
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
}

function stringField(obj: JsonObject | null, key: string): string | undefined {
  const value = obj?.[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function numericField(obj: JsonObject, key: keyof LingTaiLedgerEntry): number {
  const raw = obj[key]
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.trunc(n)
}

function parseTimestamp(raw: unknown): string {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const ms = raw < 1e12 ? raw * 1000 : raw
    return new Date(ms).toISOString()
  }
  if (typeof raw !== 'string' || !raw.trim()) return ''
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}

function activityForSource(sourceLabel: string): { userMessage: string; tools: string[]; subagentTypes: string[] } {
  const normalized = sourceLabel.trim().toLowerCase()

  if (normalized === 'tc_wake' || normalized.startsWith('tc_') || normalized.includes('wake')) {
    return {
      userMessage: 'LingTai task coordinator wake',
      tools: ['Agent'],
      subagentTypes: ['lingtai-task-coordinator'],
    }
  }

  if (normalized === 'daemon') {
    return {
      userMessage: 'LingTai daemon task',
      tools: ['Agent'],
      subagentTypes: ['lingtai-daemon'],
    }
  }

  if (normalized === 'summarize_apriori' || normalized.includes('summar')) {
    return {
      userMessage: 'LingTai planning summary',
      tools: ['EnterPlanMode'],
      subagentTypes: [],
    }
  }

  return {
    userMessage: normalized === 'main'
      ? 'LingTai main conversation'
      : `LingTai ${sourceLabel || 'main'} conversation`,
    tools: [],
    subagentTypes: [],
  }
}

function parseLedgerLine(line: string | Buffer): LingTaiLedgerEntry | null {
  const text = Buffer.isBuffer(line) ? line.toString('utf-8') : line
  if (!text.trim()) return null
  try {
    const parsed = JSON.parse(text) as unknown
    const obj = asObject(parsed)
    return obj ? (obj as LingTaiLedgerEntry) : null
  } catch {
    return null
  }
}

/**
 * Decode LingTai TUI ledger JSONL records into rich, cost-free calls.
 */
export function decodeLingTaiTui({
  records,
  context,
  agentId,
  fallbackModel,
  fallbackEndpoint,
  projectPath,
  project,
  seenKeys: liveSeen,
}: LingTaiTuiDecodeInput): LingTaiTuiDecodeResult {
  const seen = liveSeen ?? new Set<string>()
  const calls: LingTaiTuiDecodedCall[] = []
  const diagnostics: RecordDiagnostic[] = []

  let lineNo = 0
  for (const rawRecord of records) {
    lineNo += 1
    const entry = typeof rawRecord === 'string'
      ? parseLedgerLine(rawRecord)
      : (rawRecord as LingTaiLedgerEntry | null)

    if (!entry) continue

    const obj = entry as JsonObject
    const inputTotal = numericField(obj, 'input')
    const outputTokens = numericField(obj, 'output')
    const reasoningTokens = numericField(obj, 'thinking')
    const cachedInputTokens = numericField(obj, 'cached')
    const totalTokens = inputTotal + outputTokens + reasoningTokens + cachedInputTokens
    if (totalTokens === 0) continue

    // LingTai records provider-normalized input totals plus a separate cached count.
    // Match CodeBurn's normal shape by billing cached tokens in cacheReadInputTokens.
    const inputTokens = Math.max(0, inputTotal - cachedInputTokens)
    const model = stringField(obj, 'model') ?? fallbackModel
    const endpoint = stringField(obj, 'endpoint') ?? fallbackEndpoint
    const timestamp = parseTimestamp(entry.ts)
    const sourceLabel = stringField(obj, 'source') ?? 'main'
    const emId = stringField(obj, 'em_id') ?? ''
    const runId = stringField(obj, 'run_id') ?? ''
    const sessionId = runId || `${agentId}:${sourceLabel}`
    const activity = activityForSource(sourceLabel)
    // The dedup key threads a FINGERPRINT of the source ref (host ledger path),
    // never the raw path — dedupKey ships on the envelope, so the raw path must
    // not cross into an observation output. (The agent-dir projectPath is never
    // used here.) The model component is the NORMALIZED identifier, never the
    // raw ledger text: the observation boundary normalizes the same value (a
    // display name like "GPT-5.5 Pro (High)" collapses to 'unknown' there), so
    // building the key from the normalized form keeps the key and the
    // envelope's model field consistent and stops free text from riding the key.
    const dedupKey = [
      'lingtai-tui',
      sourceRefFingerprint(context.privacyKey, context.sourceRef),
      lineNo,
      timestamp,
      normalizeModelIdentifier(model),
      endpoint,
      sourceLabel,
      emId,
      runId,
      inputTotal,
      outputTokens,
      reasoningTokens,
      cachedInputTokens,
    ].join(':')

    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)

    calls.push({
      provider: 'lingtai-tui',
      model,
      inputTokens,
      outputTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: cachedInputTokens,
      cachedInputTokens,
      reasoningTokens,
      webSearchRequests: 0,
      tools: activity.tools,
      rawBashCommands: [],
      timestamp,
      speed: 'standard',
      deduplicationKey: dedupKey,
      turnId: `${sessionId}:line:${lineNo}`,
      userMessage: activity.userMessage,
      sessionId,
      subagentTypes: activity.subagentTypes,
      projectPath,
      ...(project !== undefined ? { project } : {}),
    })
  }

  return { calls, diagnostics }
}
