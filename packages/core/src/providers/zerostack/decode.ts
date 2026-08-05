// @codeburn/core Zerostack decoder: pure decode over supplied session JSON records.
// No fs / env / clock — the host reads the file and hands JSON objects straight through.
// The rich output carries token buckets but NO pricing (cost leaves the decoder;
// the host prices via its estimated-cost seam).

import type { DecodeContext } from '../../contracts.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import { sourceRefFingerprint } from '../../fingerprint.js'
import type { ZerostackDecodedCall, ZerostackMessage, ZerostackSession } from './types.js'

// Zerostack tool ids mapped to the canonical vocabulary. An id with
// no mapping passes through unchanged.
export const zerostackToolNameMap: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  grep: 'Grep',
  glob: 'Glob',
  fetch: 'WebFetch',
  search: 'WebSearch',
  task: 'Agent',
}

function firstUserMessage(messages: ZerostackMessage[]): string {
  const msg = messages.find(m => m.role === 'user')
  if (!msg) return ''
  if (typeof msg.content === 'string') return msg.content
  return (msg.content ?? []).map(c => c.text ?? '').filter(Boolean).join(' ')
}

export type ZerostackDecodeInput = {
  records: unknown[]
  context: DecodeContext
  // Host-derived per-source scalars (supplied by the CLI bridge). `project` is
  // the discovered source project; `sessionIdFallback` is basename(path,'.json'),
  // used when a session record carries no id. Both optional so a core unit test
  // can call the decoder with only { records, context }.
  project?: string
  sessionIdFallback?: string
  seenKeys?: Set<string>
}

export type ZerostackDecodeResult = {
  calls: ZerostackDecodedCall[]
  diagnostics: RecordDiagnostic[]
}

/**
 * Decode a Zerostack session file's record into a rich, cost-free call.
 * Zerostack has one record per session with cumulative token totals. The dedup
 * key threads a FINGERPRINT of the source ref (host path), never the raw path:
 * `zerostack:<sourceRefFingerprint>:<timestamp>:<sessionId>`. The raw path
 * must not cross into an observation output (dedupKey ships on the envelope).
 */
export function decodeZerostack({
  records,
  context,
  project,
  sessionIdFallback,
  seenKeys: liveSeen,
}: ZerostackDecodeInput): ZerostackDecodeResult {
  const seen = liveSeen ?? new Set<string>()
  const calls: ZerostackDecodedCall[] = []
  const diagnostics: RecordDiagnostic[] = []

  for (const rawRecord of records) {
    const session = rawRecord as ZerostackSession | null
    if (!session) continue

    const input = session.total_input_tokens ?? 0
    const output = session.total_output_tokens ?? 0
    if (input === 0 && output === 0) continue

    const timestamp = session.updated_at ?? session.created_at ?? ''
    const sessionId = session.id ?? sessionIdFallback ?? ''
    const dedupKey = `zerostack:${sourceRefFingerprint(context.privacyKey, context.sourceRef)}:${timestamp}:${sessionId}`
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)

    const model = session.model ?? ''

    calls.push({
      provider: 'zerostack',
      model,
      inputTokens: input,
      outputTokens: output,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      tools: [],
      rawBashCommands: [],
      timestamp,
      speed: 'standard',
      deduplicationKey: dedupKey,
      userMessage: firstUserMessage(session.messages ?? []),
      sessionId,
      ...(project !== undefined ? { project } : {}),
      ...(session.working_dir !== undefined ? { projectPath: session.working_dir } : {}),
    })
  }

  return { calls, diagnostics }
}
