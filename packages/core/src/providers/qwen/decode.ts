// @codeburn/core Qwen decoder: pure decode over supplied chat JSONL records. No
// fs / env / clock — the host reads the file and hands lines straight through.
// The rich output carries token buckets but NO pricing (cost leaves the decoder;
// the host prices via its estimated-cost seam) and NO bash base-name extraction
// (that, with its `strip-ansi` dependency, stays host-side).
//
// Qwen is a "simple JSONL" provider: one chat file is one logical session, the
// host re-reads the whole file every run (no incremental cache), so the decoder
// is a single pass with no serializable resume state. The only cross-record
// memory it needs is the pending user message (threaded within the one pass) and
// the cross-file dedup set (threaded live by the host, exactly like codex).

import type { DecodeContext } from '../../contracts.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type { QwenDecodedCall, QwenEntry, QwenPart, QwenToolCall } from './types.js'

// Qwen (Gemini-lineage) tool ids mapped to the canonical vocabulary. An id with
// no mapping passes through unchanged so a provider-native tool still shows up.
export const qwenToolNameMap: Record<string, string> = {
  read_file: 'Read',
  write_to_file: 'Write',
  edit_file: 'Edit',
  execute_command: 'Bash',
  search_files: 'Grep',
  list_files: 'LS',
  list_directory: 'LS',
  browser_action: 'WebFetch',
  web_search: 'WebSearch',
  ask_followup_question: 'AskUser',
  attempt_completion: 'Complete',
}

// Parse one chat line. Qwen chat lines are ordinary JSONL; a blank or malformed
// line is skipped (returns null) exactly as the pre-migration decode did.
export function parseQwenLine(line: string): QwenEntry | null {
  if (!line.trim()) return null
  try {
    return JSON.parse(line) as QwenEntry
  } catch {
    return null
  }
}

// Pull the file path a tool call targets, honoring both Qwen arg spellings.
function fileFromArgs(args: Record<string, unknown> | undefined): string | undefined {
  const fp = args?.['file_path'] ?? args?.['path']
  return typeof fp === 'string' ? fp : undefined
}

function extractCalls(parts: QwenPart[]): {
  tools: string[]
  rawBashCommands: string[]
  toolSequence: QwenToolCall[][]
} {
  const tools: string[] = []
  const rawBashCommands: string[] = []
  const toolSequence: QwenToolCall[][] = []

  for (const part of parts) {
    const name = part.functionCall?.name
    if (!name) continue
    const mapped = qwenToolNameMap[name] ?? name
    tools.push(mapped)

    const args = part.functionCall?.args
    const call: QwenToolCall = { tool: mapped }
    const file = fileFromArgs(args)
    if (file) call.file = file
    if (mapped === 'Bash' && args && typeof args['command'] === 'string') {
      const command = args['command'] as string
      call.command = command
      rawBashCommands.push(command)
    }
    toolSequence.push([call])
  }

  return { tools, rawBashCommands, toolSequence }
}

export type QwenDecodeInput = {
  records: unknown[]
  context: DecodeContext
  // Optional live dedup set the host mutates in place (its shared cross-file
  // seenKeys). Threaded exactly like codex's live set. Simple JSONL providers
  // never persist resume state, so there is no serialized `seenKeys` fallback.
  seenKeys?: Set<string>
}

export type QwenDecodeResult = {
  calls: QwenDecodedCall[]
  diagnostics: RecordDiagnostic[]
}

/**
 * Decode a Qwen chat file's records into rich, cost-free calls. A single pass:
 * user messages set the pending prompt for the next assistant call; assistant
 * messages that carry token usage flush into a call. Dedup is keyed on
 * `qwen:<sessionId>:<uuid>` against the live `seenKeys` set (host-owned), so a
 * fork/replay that repeats a uuid collides and drops.
 */
// `context` is part of the decode contract but the rich layer never consumes it:
// minimization / fingerprinting happens in toObservations.
export function decodeQwen({ records, seenKeys: liveSeen }: QwenDecodeInput): QwenDecodeResult {
  const seen = liveSeen ?? new Set<string>()
  const calls: QwenDecodedCall[] = []
  const diagnostics: RecordDiagnostic[] = []

  let pendingUserMessage = ''

  for (const rawLine of records) {
    const entry = typeof rawLine === 'string' ? parseQwenLine(rawLine) : (rawLine as QwenEntry | null)
    if (!entry) continue

    if (entry.type === 'user' && entry.message) {
      const texts = (entry.message.parts ?? [])
        .filter(p => p.text && !p.thought)
        .map(p => p.text!)
      if (texts.length > 0) {
        pendingUserMessage = texts.join(' ').slice(0, 500)
      }
      continue
    }

    if (entry.type !== 'assistant' || !entry.usageMetadata) continue

    const usage = entry.usageMetadata
    const promptTokenCount = usage.promptTokenCount ?? 0
    const candidatesTokenCount = usage.candidatesTokenCount ?? 0
    if (promptTokenCount === 0 && candidatesTokenCount === 0) continue

    // Deliberate shape: the pre-extraction decoder interpolated the raw fields
    // (`qwen:${entry.sessionId}:${entry.uuid}`), so a record missing sessionId
    // produced the literal 'qwen:undefined:<uuid>'. That spelling was a
    // template-string artifact, never a contract; coalescing to '' is pinned by
    // qwen-decode.test.ts ("pins the dedup-key shape ... no 'undefined' spelling").
    const dedupKey = `qwen:${entry.sessionId ?? ''}:${entry.uuid ?? ''}`
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)

    const model = entry.model || 'qwen-auto'
    const { tools, rawBashCommands, toolSequence } = extractCalls(entry.message?.parts ?? [])

    const reasoningTokens = usage.thoughtsTokenCount ?? 0
    const cachedTokens = usage.cachedContentTokenCount ?? 0

    calls.push({
      provider: 'qwen',
      model,
      inputTokens: promptTokenCount,
      outputTokens: candidatesTokenCount,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: cachedTokens,
      cachedInputTokens: cachedTokens,
      reasoningTokens,
      webSearchRequests: 0,
      tools: [...new Set(tools)],
      rawBashCommands,
      timestamp: entry.timestamp || '',
      speed: 'standard',
      deduplicationKey: dedupKey,
      userMessage: pendingUserMessage,
      sessionId: entry.sessionId ?? '',
      ...(toolSequence.length > 0 ? { toolSequence } : {}),
    })

    pendingUserMessage = ''
  }

  return { calls, diagnostics }
}
