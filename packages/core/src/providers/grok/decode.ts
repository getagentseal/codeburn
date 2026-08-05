// @codeburn/core Grok decoder: pure decode over a host-supplied composite record.
// The host reads summary.json, signals.json, and the updates.jsonl lines; this
// decoder reconstructs the per-session token buckets and tool list with no fs,
// env, clock, or pricing.

import type { DecodeContext } from '../../contracts.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import { sourceRefFingerprint } from '../../fingerprint.js'
import type { GrokDecodedCall, GrokSessionRecords, GrokSignals, GrokSummary, GrokUpdate } from './types.js'

// Grok Build tool ids mapped to the canonical vocabulary. Unknown ids pass
// through unchanged so provider-native tools still appear.
export const grokToolNameMap: Record<string, string> = {
  bash: 'Bash',
  run_terminal_command: 'Bash',
  read_file: 'Read',
  read: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  edit: 'Edit',
  list_dir: 'Glob',
  glob: 'Glob',
  grep: 'Grep',
  search: 'WebSearch',
  web_search: 'WebSearch',
  fetch: 'WebFetch',
  task: 'Agent',
  search_replace: 'Edit',
  todo_write: 'TodoWrite',
  spawn_subagent: 'Agent',
}

function isGrokSessionRecords(value: unknown): value is GrokSessionRecords {
  return (
    value !== null &&
    typeof value === 'object' &&
    'updatesLines' in (value as object) &&
    'summary' in (value as object)
  )
}

// Single pass over updates.jsonl: per-turn totalTokens for the cost estimate,
// plus the real tool calls. Bash commands are kept raw; base-name extraction is
// the host's job.
function parseUpdates(updates: string): {
  input: number
  cacheRead: number
  output: number
  tools: string[]
  rawBashCommands: string[]
  subagentTypes: string[]
} {
  const turns = new Map<string, { first: number; last: number }>()
  const tools: string[] = []
  const rawBashCommands: string[] = []
  const subagentTypes: string[] = []

  let prevTotal = -1
  let segmentPeak = 0
  let inputFresh = 0

  for (const line of updates.split('\n')) {
    if (!line.trim()) continue
    let params: GrokUpdate['params']
    try {
      params = (JSON.parse(line) as GrokUpdate).params
    } catch {
      continue
    }
    if (!params) continue

    const total = params._meta?.totalTokens
    if (typeof total === 'number') {
      if (prevTotal >= 0 && total < prevTotal * 0.5) {
        inputFresh += segmentPeak
        segmentPeak = 0
      }
      if (total > segmentPeak) segmentPeak = total
      prevTotal = total

      const promptId = params._meta?.promptId
      if (promptId) {
        const turn = turns.get(promptId)
        if (!turn) turns.set(promptId, { first: total, last: total })
        else turn.last = total
      }
    }

    const update = params.update
    if (update?.sessionUpdate === 'tool_call' && typeof update.title === 'string') {
      tools.push(grokToolNameMap[update.title] ?? update.title)
      if (update.title === 'run_terminal_command' && typeof update.rawInput?.command === 'string') {
        rawBashCommands.push(update.rawInput.command)
      }
      if (update.title === 'spawn_subagent' && typeof update.rawInput?.subagent_type === 'string') {
        subagentTypes.push(update.rawInput.subagent_type)
      }
    }
  }

  inputFresh += segmentPeak
  let sumFirst = 0
  let output = 0
  for (const { first, last } of turns.values()) {
    sumFirst += first
    output += Math.max(0, last - first)
  }
  const cacheRead = Math.max(0, sumFirst - inputFresh)
  return { input: inputFresh, cacheRead, output, tools, rawBashCommands, subagentTypes }
}

export type GrokDecodeInput = {
  records: unknown[]
  context: DecodeContext
  seenKeys?: Set<string>
}

export type GrokDecodeResult = {
  calls: GrokDecodedCall[]
  diagnostics: RecordDiagnostic[]
}

/**
 * Decode one Grok session's composite records into a single rich, cost-free call.
 * The host owns file I/O and the live cross-file dedup set; this function is
 * pure over the supplied record.
 */
export function decodeGrok({ records, context, seenKeys: liveSeen }: GrokDecodeInput): GrokDecodeResult {
  const seen = liveSeen ?? new Set<string>()
  const session = records.find(isGrokSessionRecords)
  if (!session) return { calls: [], diagnostics: [] }

  const { summary, signals, updatesLines, sourceDir, sessionName, project } = session
  const updates = updatesLines.join('\n')
  const { input, cacheRead, output, tools, rawBashCommands, subagentTypes } = parseUpdates(updates)
  if (input === 0 && output === 0) return { calls: [], diagnostics: [] }

  const model =
    summary.current_model_id ??
    signals?.primaryModelId ??
    signals?.modelsUsed?.[0] ??
    'grok-build'
  const timestamp = summary.updated_at ?? summary.last_active_at ?? summary.created_at ?? ''
  const sessionId = summary.info?.id ?? sessionName

  // The dedup key threads a FINGERPRINT of the session directory, never the raw
  // path — dedupKey ships on the envelope, so the raw path must not cross into
  // an observation output. (sessionName stays the basename-derived session
  // identity; it is not a path.)
  const dedupKey = `grok:${sourceRefFingerprint(context.privacyKey, sourceDir)}:${timestamp}:${sessionId}`
  if (seen.has(dedupKey)) return { calls: [], diagnostics: [] }
  seen.add(dedupKey)

  const call: GrokDecodedCall = {
    provider: 'grok',
    model,
    inputTokens: input,
    outputTokens: output,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: cacheRead,
    cachedInputTokens: cacheRead,
    reasoningTokens: 0,
    webSearchRequests: 0,
    tools,
    rawBashCommands,
    subagentTypes,
    timestamp,
    speed: 'standard',
    deduplicationKey: dedupKey,
    userMessage: summary.session_summary ?? summary.generated_title ?? '',
    sessionId,
    projectPath: summary.info?.cwd ?? '',
    project,
  }

  return { calls: [call], diagnostics: [] }
}
