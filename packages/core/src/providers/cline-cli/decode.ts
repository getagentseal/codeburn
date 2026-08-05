// @codeburn/core Cline CLI decoder: pure decode over the composite
// { meta, messages } record the host hands in. No fs / env / clock — the host
// reads and JSON-parses the metadata + messages files and passes one record
// through. The rich output carries token buckets + the CLI's reported cost but
// NO pricing (cost leaves the decoder; the host prices via its measured /
// estimated seam) and NO bash base-name extraction (that, with its `strip-ansi`
// dependency, stays host-side).
//
// Cline CLI is a "simple file-based" provider: one session directory is one
// logical session, the host re-reads both files every run (no incremental
// cache), so the decoder is a single pass with no serializable resume state.
// The only cross-record memory it needs is the pending user message (threaded
// within the one pass) and the cross-file dedup set (threaded live by the host,
// exactly like qwen).

import type { DecodeContext } from '../../contracts.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type { ClineCliDecodedCall, ClineCliSessionRecords, ClineCliToolCall } from './types.js'

export const PROVIDER_NAME = 'cline-cli'

// Cline CLI tool names mapped to the canonical vocabulary. A name with no
// mapping passes through unchanged so a provider-native tool still shows up.
export const clineCliToolNameMap: Record<string, string> = {
  run_commands: 'Bash',
  read_files: 'Read',
  editor: 'Edit',
  apply_patch: 'Edit',
  search_codebase: 'Grep',
  fetch_web_content: 'WebFetch',
  skills: 'Skill',
  spawn_agent: 'Agent',
  team_spawn_teammate: 'Agent',
  team_run_task: 'Agent',
  ask_question: 'AskUser',
}

function mapToolName(rawTool: string): string {
  return clineCliToolNameMap[rawTool] ?? rawTool
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function safeNonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function safeTokenCount(value: unknown): number {
  return Math.floor(Math.min(safeNonNegativeNumber(value), Number.MAX_SAFE_INTEGER))
}

// A cost counts as metered only when it is actually present and non-negative.
// `0` is a legitimate metered value (a free/cached call) and must stay reported,
// so this is a presence check, not a truthiness check.
function isReportedCost(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

type ParsedMetrics = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** CLI-reported dollar cost, present only when actually metered (incl. $0). */
  reportedCost?: number
}

function parseMetrics(value: unknown): ParsedMetrics | null {
  if (!isRecord(value)) return null
  const metrics: ParsedMetrics = {
    inputTokens: safeTokenCount(value['inputTokens']),
    outputTokens: safeTokenCount(value['outputTokens']),
    cacheReadTokens: safeTokenCount(value['cacheReadTokens']),
    cacheWriteTokens: safeTokenCount(value['cacheWriteTokens']),
    // A negative cost is not a credit we can represent — treat it as absent and
    // fall back to token pricing, rather than reporting a clamped $0 as metered.
    ...(isReportedCost(value['cost']) ? { reportedCost: safeNonNegativeNumber(value['cost']) } : {}),
  }
  const hasTokens = metrics.inputTokens > 0 || metrics.outputTokens > 0
    || metrics.cacheReadTokens > 0 || metrics.cacheWriteTokens > 0
  return hasTokens || metrics.reportedCost !== undefined && metrics.reportedCost > 0 ? metrics : null
}

// The CLI writes epoch milliseconds, but a seconds-resolution value would
// otherwise silently land in 1970. Promote it and reject what stays
// implausible, matching the guard kiro.ts uses on the same hazard.
const MIN_REASONABLE_TIMESTAMP_MS = 1_000_000_000_000

function isoTimestamp(value: unknown, fallback: string): string {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = value < MIN_REASONABLE_TIMESTAMP_MS ? value * 1000 : value
    const date = new Date(ms)
    if (!Number.isNaN(date.getTime()) && date.getTime() >= MIN_REASONABLE_TIMESTAMP_MS) {
      return date.toISOString()
    }
  }
  const parsed = nonEmptyString(value)
  if (parsed) {
    const date = new Date(parsed)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  return fallback
}

// `run_commands` carries its commands as a JSON-encoded array in a string
// field; anything else is treated as a single command line.
function commandsFrom(input: unknown): string[] {
  if (!isRecord(input)) return []
  const raw = input['commands'] ?? input['command']
  if (Array.isArray(raw)) return raw.filter((c): c is string => typeof c === 'string')
  const text = nonEmptyString(raw)
  if (!text) return []
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text) as unknown
      if (Array.isArray(parsed)) return parsed.filter((c): c is string => typeof c === 'string')
    } catch {
      // Not JSON after all - fall through and treat the whole string as one command.
    }
  }
  return [text]
}

function firstString(input: unknown, keys: string[]): string | undefined {
  if (!isRecord(input)) return undefined
  for (const key of keys) {
    const value = nonEmptyString(input[key])
    if (value) return value
  }
  return undefined
}

type CollectedTools = {
  tools: string[]
  rawBashCommands: string[]
  toolSequence: ClineCliToolCall[][]
  skills: string[]
  subagentTypes: string[]
  webSearchRequests: number
}

function collectTools(content: unknown): CollectedTools {
  const collected: CollectedTools = {
    tools: [], rawBashCommands: [], toolSequence: [], skills: [], subagentTypes: [], webSearchRequests: 0,
  }
  if (!Array.isArray(content)) return collected

  const turnTools: ClineCliToolCall[] = []
  for (const block of content) {
    if (!isRecord(block) || block['type'] !== 'tool_use') continue
    const rawName = nonEmptyString(block['name'])
    if (!rawName) continue
    const mapped = mapToolName(rawName)
    const input = block['input']
    const toolCall: ClineCliToolCall = { tool: mapped }

    const file = firstString(input, ['path', 'file_path', 'paths', 'file'])
    if (file) toolCall.file = file

    if (mapped === 'Bash') {
      const commands = commandsFrom(input)
      const [first] = commands
      if (first) toolCall.command = first
      // Raw command strings travel host-side; base-name extraction (with its
      // `strip-ansi` dependency) stays in the CLI adapter's toProviderCall.
      for (const command of commands) collected.rawBashCommands.push(command)
    }
    if (mapped === 'Skill') {
      const skill = firstString(input, ['name', 'skill', 'skill_name'])
      if (skill) collected.skills.push(skill)
    }
    if (mapped === 'Agent') {
      const subagentType = firstString(input, ['agent', 'agent_type', 'type', 'name'])
      if (subagentType) collected.subagentTypes.push(subagentType)
    }
    if (mapped === 'WebFetch') collected.webSearchRequests++

    collected.tools.push(mapped)
    turnTools.push(toolCall)
  }

  if (turnTools.length > 0) collected.toolSequence.push(turnTools)
  return collected
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  for (const block of content) {
    if (!isRecord(block) || block['type'] !== 'text') continue
    const text = nonEmptyString(block['text'])
    if (text) return text
  }
  return ''
}

function firstUserMessage(messages: unknown[]): string {
  for (const message of messages) {
    if (!isRecord(message) || message['role'] !== 'user') continue
    const text = textFromContent(message['content'])
    // Tool results come back as role:user too; they carry no text block.
    if (text) return text
  }
  return ''
}

export type ClineCliDecodeInput = {
  records: unknown[]
  context: DecodeContext
  // Optional live dedup set the host mutates in place (its shared cross-file
  // seenKeys). Threaded exactly like qwen's live set. Simple file-based
  // providers never persist resume state, so there is no serialized fallback.
  seenKeys?: Set<string>
}

export type ClineCliDecodeResult = {
  calls: ClineCliDecodedCall[]
  diagnostics: RecordDiagnostic[]
}

/**
 * Decode one Cline CLI session's composite record into rich, cost-free calls.
 * Emits one call per assistant message carrying a metrics block; when no
 * message carries metrics at all, falls back to the session rollup
 * (`metadata.usage`, deliberately NOT `aggregateUsage`, which folds in spawned
 * subagents that are themselves separate session directories).
 *
 * Dedup is keyed on `cline-cli:<sessionId>:<messageId>` (per-message) and
 * `cline-cli:<sessionId>:rollup` against the live `seenKeys` set (host-owned).
 */
// `context` is part of the decode contract but the rich layer never consumes it:
// minimization / fingerprinting happens in toObservations.
export function decodeClineCli({ records, seenKeys: liveSeen }: ClineCliDecodeInput): ClineCliDecodeResult {
  const seen = liveSeen ?? new Set<string>()
  const calls: ClineCliDecodedCall[] = []
  const diagnostics: RecordDiagnostic[] = []

  const envelope = records[0]
  if (!isRecord(envelope)) return { calls, diagnostics }
  const recordsShape = envelope as unknown as ClineCliSessionRecords
  const meta = isRecord(recordsShape.meta) ? recordsShape.meta : null
  if (!meta) return { calls, diagnostics }
  const messages = Array.isArray(recordsShape.messages) ? recordsShape.messages : []

  const sessionId = nonEmptyString(meta['session_id']) ?? ''
  const metadata = isRecord(meta['metadata']) ? meta['metadata'] : {}
  const workspace = nonEmptyString(meta['workspace_root']) ?? nonEmptyString(meta['cwd'])
  const sessionModel = nonEmptyString(meta['model']) ?? 'unknown'
  const startedAt = isoTimestamp(meta['started_at'], new Date(0).toISOString())
  // Always injected by the CLI adapter's readRecords (from the discovered
  // source); falls back to the display name only if that ever changes.
  const project = nonEmptyString(meta['project']) ?? 'Cline CLI'
  const cwd = nonEmptyString(meta['cwd'])

  const userMessage = firstUserMessage(messages)
  // Whether the session carried any per-message metrics at all. Set before
  // the dedup check below so a session whose calls were all deduped (e.g. a
  // duplicated session directory reusing a session_id) still declines the
  // rollup fallback rather than double-counting its cost through it.
  let hadMetrics = false

  for (const [index, message] of messages.entries()) {
    if (!isRecord(message) || message['role'] !== 'assistant') continue
    const metrics = parseMetrics(message['metrics'])
    if (!metrics) continue
    hadMetrics = true

    const modelInfo = isRecord(message['modelInfo']) ? message['modelInfo'] : {}
    const model = nonEmptyString(modelInfo['id']) ?? sessionModel
    const messageId = nonEmptyString(message['id']) ?? String(index)
    const deduplicationKey = `${PROVIDER_NAME}:${sessionId}:${messageId}`
    if (seen.has(deduplicationKey)) continue
    seen.add(deduplicationKey)

    const { tools, rawBashCommands, toolSequence, skills, subagentTypes, webSearchRequests }
      = collectTools(message['content'])

    calls.push({
      provider: PROVIDER_NAME,
      model,
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      cacheCreationInputTokens: metrics.cacheWriteTokens,
      cacheReadInputTokens: metrics.cacheReadTokens,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests,
      ...(metrics.reportedCost !== undefined ? { reportedCost: metrics.reportedCost } : {}),
      tools,
      rawBashCommands,
      skills: skills.length > 0 ? skills : [],
      subagentTypes: subagentTypes.length > 0 ? subagentTypes : [],
      timestamp: isoTimestamp(message['ts'], startedAt),
      speed: 'standard',
      deduplicationKey,
      turnId: `${sessionId}:${messageId}`,
      toolSequence: toolSequence.length > 0 ? toolSequence : undefined,
      userMessage,
      sessionId,
      project,
      projectPath: workspace,
      ...(cwd ? { workingDirectory: cwd } : {}),
    })
  }

  if (hadMetrics) return { calls, diagnostics }

  // No per-message metrics: fall back to the session rollup so an interrupted
  // or older session still reports its spend.
  const rollup = parseMetrics(isRecord(metadata['usage']) ? metadata['usage'] : null)
  if (!rollup) return { calls, diagnostics }
  const deduplicationKey = `${PROVIDER_NAME}:${sessionId}:rollup`
  if (seen.has(deduplicationKey)) return { calls, diagnostics }
  seen.add(deduplicationKey)

  // Same presence-not-truthiness rule as the per-message path: a metered $0
  // rollup stays reported instead of being re-estimated from tokens.
  const rawRollupCost = (isRecord(metadata['usage']) ? metadata['usage']['totalCost'] : undefined)
    ?? metadata['totalCost']
  const rollupReportedCost = isReportedCost(rawRollupCost) ? safeNonNegativeNumber(rawRollupCost) : undefined

  calls.push({
    provider: PROVIDER_NAME,
    model: sessionModel,
    inputTokens: rollup.inputTokens,
    outputTokens: rollup.outputTokens,
    cacheCreationInputTokens: rollup.cacheWriteTokens,
    cacheReadInputTokens: rollup.cacheReadTokens,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    ...(rollupReportedCost !== undefined ? { reportedCost: rollupReportedCost } : {}),
    tools: [],
    rawBashCommands: [],
    skills: [],
    subagentTypes: [],
    timestamp: isoTimestamp(meta['ended_at'], startedAt),
    speed: 'standard',
    deduplicationKey,
    turnId: `${sessionId}:rollup`,
    userMessage,
    sessionId,
    project,
    projectPath: workspace,
    ...(cwd ? { workingDirectory: cwd } : {}),
  })

  return { calls, diagnostics }
}
