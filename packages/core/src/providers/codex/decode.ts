// @codeburn/core Codex decoder: pure decode over supplied rollout records with
// EXPLICIT serializable state. No fs / env / clock — the host streams the file
// and hands lines (string OR Buffer) straight through; a Buffer passes through
// un-re-buffered so a >250 MB session never materializes as a string. The rich
// output carries token buckets but NO pricing (cost leaves the decoder; the host
// prices via its estimated-cost seam).

import type { DecodeContext } from '../../contracts.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type {
  CodexDecodedCall,
  CodexDecodeState,
  CodexEntry,
  CodexToolCall,
  CodexTokenUsage,
} from './types.js'

// ── Pure helpers (self-contained copies; core must not import from the CLI) ──

const CHARS_PER_TOKEN = 4
function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

// Coerce a message `content` into an array of blocks. Some turns write `content`
// as a bare string; a raw string reaching `.filter` would throw mid-decode.
function normalizeContentBlocks<T extends { type?: string; text?: string }>(
  content: T[] | string | null | undefined,
): T[] {
  if (Array.isArray(content)) {
    const isBlock = (b: T): boolean => b != null && typeof b === 'object'
    return content.every(isBlock) ? content : content.filter(isBlock)
  }
  if (typeof content === 'string') return [{ type: 'text', text: content } as T]
  return []
}

export const codexToolNameMap: Record<string, string> = {
  exec_command: 'Bash',
  read_file: 'Read',
  write_file: 'Edit',
  apply_diff: 'Edit',
  apply_patch: 'Edit',
  spawn_agent: 'Agent',
  close_agent: 'Agent',
  wait_agent: 'Agent',
  read_dir: 'Glob',
}

// CLI-based MCP wrappers (e.g. philschmid/mcp-cli) let Codex call an MCP tool
// through a shell command instead of registering the server natively. Codex logs
// a plain exec_command with no `mcp_tool_call_end` event, so the MCP usage would
// only appear as a shell command (issue #478). Recognize the `mcp-cli [options]
// call <server> <tool>` form and return the canonical mcp__<server>__<tool>. The
// negative lookbehind keeps `mcp-cli` a standalone binary; the option-skip group
// stops at the `call` token without crossing a shell separator.
const MCP_CLI_CALL = /(?<![\w.-])mcp-cli(?:\s+(?!call\b)[^\s;|&]+)*\s+call\s+(\S+)\s+(\S+)/
export function mcpToolFromShellCommand(command: unknown): string | null {
  const text = typeof command === 'string'
    ? command
    : Array.isArray(command) ? command.filter(x => typeof x === 'string').join(' ') : ''
  if (!text) return null
  const m = MCP_CLI_CALL.exec(text)
  if (!m) return null
  const server = m[1]!.replace(/['"]/g, '')
  const tool = m[2]!.replace(/['"]/g, '')
  if (!server || !tool) return null
  return `mcp__${server}__${tool}`
}

// Count added/removed lines from a Codex `patch_apply_end` change's
// `unified_diff`. Numbers only — the diff text is never stored.
export function countUnifiedDiffLoc(diff: unknown): { added: number; removed: number } {
  let added = 0
  let removed = 0
  if (typeof diff !== 'string') return { added, removed }
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++
    else if (line.startsWith('-') && !line.startsWith('---')) removed++
  }
  return { added, removed }
}

const RAW_HEAD_BYTES = 64 * 1024
const LARGE_TEXT_CAP = 2000

function getRawJsonStringField(head: string, field: string): string | undefined {
  const re = new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`)
  const match = re.exec(head)
  if (!match) return undefined
  try {
    return JSON.parse(`"${match[1]}"`) as string
  } catch {
    return match[1]
  }
}

function payloadHead(head: string): string {
  const idx = head.indexOf('"payload"')
  return idx === -1 ? head : head.slice(idx)
}

function countJsonStringBytes(source: Buffer, valueStart: number): number {
  let count = 0
  for (let i = valueStart; i < source.length; i++) {
    const ch = source[i]
    if (ch === 0x5c) {
      i++
      count++
      continue
    }
    if (ch === 0x22) return count
    count++
  }
  return count
}

function extractFirstJsonText(source: Buffer, cap = LARGE_TEXT_CAP): string {
  const key = Buffer.from('"text"')
  const idx = source.indexOf(key)
  if (idx === -1) return ''
  const colon = source.indexOf(0x3a, idx + key.length)
  if (colon === -1) return ''
  const qStart = source.indexOf(0x22, colon + 1)
  if (qStart === -1) return ''
  const chunks: number[] = []
  for (let i = qStart + 1; i < source.length && chunks.length < cap; i++) {
    const ch = source[i]
    if (ch === 0x5c) {
      const next = source[++i]
      if (next === 0x6e) chunks.push(0x0a)
      else if (next === 0x72) chunks.push(0x0d)
      else if (next === 0x74) chunks.push(0x09)
      else if (next !== undefined) chunks.push(next)
      continue
    }
    if (ch === 0x22) break
    chunks.push(ch)
  }
  return Buffer.from(chunks).toString('utf-8')
}

function countFirstJsonText(source: Buffer): number {
  const key = Buffer.from('"text"')
  const idx = source.indexOf(key)
  if (idx === -1) return 0
  const colon = source.indexOf(0x3a, idx + key.length)
  if (colon === -1) return 0
  const qStart = source.indexOf(0x22, colon + 1)
  if (qStart === -1) return 0
  return countJsonStringBytes(source, qStart + 1)
}

// Parse one rollout line. A small line arrives as a string (plain JSON.parse); a
// huge line arrives as a Buffer and is scanned for just the fields the decoder
// needs, so a 250 MB assistant message never becomes a V8 string.
export function parseCodexLine(line: string | Buffer): CodexEntry | null {
  if (typeof line === 'string') {
    const trimmed = line.trim()
    if (!trimmed) return null
    try {
      return JSON.parse(trimmed) as CodexEntry
    } catch {
      return null
    }
  }

  if (line.length === 0) return null
  const head = line.subarray(0, RAW_HEAD_BYTES).toString('utf-8')
  const type = getRawJsonStringField(head, 'type')
  if (!type) return null
  const pHead = payloadHead(head)
  const payloadType = getRawJsonStringField(pHead, 'type')
  const role = getRawJsonStringField(pHead, 'role')

  const entry: CodexEntry = {
    type,
    timestamp: getRawJsonStringField(head, 'timestamp'),
    payload: {
      type: payloadType,
      role,
      cwd: getRawJsonStringField(pHead, 'cwd'),
      model_provider: getRawJsonStringField(pHead, 'model_provider'),
      originator: getRawJsonStringField(pHead, 'originator'),
      session_id: getRawJsonStringField(pHead, 'session_id'),
      forked_from_id: getRawJsonStringField(pHead, 'forked_from_id'),
      model: getRawJsonStringField(pHead, 'model'),
      name: getRawJsonStringField(pHead, 'name'),
    },
  }

  if (type === 'response_item' && payloadType === 'message' && role === 'user') {
    entry.payload!.content = [{ type: 'input_text', text: extractFirstJsonText(line) }]
  } else if (type === 'response_item' && payloadType === 'message' && role === 'assistant') {
    entry.payload!.content = [{ type: 'output_text', text: 'x'.repeat(Math.min(countFirstJsonText(line), LARGE_TEXT_CAP)) }]
  }

  return entry
}

// Every payload field here comes off an unchecked JSON.parse cast, so a
// structurally-valid rollout can carry anything JSON can express where the
// schema declares a string or a number. The host prices the emitted calls and
// buckets them into days by timestamp, so a wrong-shaped value must never ride
// through. One guarding idiom for all of them: pick the first value of the
// right kind and let the caller fall back.
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

// A timestamp that is not a string, or a string that does not parse to a
// finite instant, would make the host's day aggregator bucket the call under
// 'NaN-NaN-NaN' (Invalid Date) — a day the daily cache keeps for ten years.
// Accept only strings that name a real instant.
function firstParseableTimestamp(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string' || !value) continue
    if (Number.isFinite(new Date(value).getTime())) return value
  }
  return undefined
}

function resolveModel(info: CodexEntry['payload'], sessionModel?: string): string {
  return firstString(info?.model, info?.info?.model, info?.info?.model_name, sessionModel) ?? 'gpt-5'
}

// ── Explicit state ──────────────────────────────────────────────────────

export function freshCodexState(): CodexDecodeState {
  return {
    sessionModel: undefined,
    sessionId: '',
    sessionCwd: undefined,
    forkedFromId: '',
    forkCutoff: '',
    prevCumulativeTotal: null,
    prevInput: 0,
    prevCached: 0,
    prevOutput: 0,
    prevReasoning: 0,
    pendingTools: [],
    pendingToolSequence: [],
    pendingUserMessage: '',
    pendingOutputChars: 0,
    pendingLocAdded: 0,
    pendingLocRemoved: 0,
    pendingEditFailed: 0,
    estCounter: 0,
    turnCounter: 0,
    // The pre-phase-4 decoder computed this as `${sessionId}:t0` at init time,
    // when sessionId was still '' — session_meta sets the id later but never
    // recomputes this, so a call before the first user message keeps ':t0'.
    currentTurnId: ':t0',
    seenKeys: [],
  }
}

function cloneState(prev: CodexDecodeState): CodexDecodeState {
  return {
    ...prev,
    pendingTools: [...prev.pendingTools],
    pendingToolSequence: prev.pendingToolSequence.map(step => step.map(c => ({ ...c }))),
    seenKeys: [...prev.seenKeys],
  }
}

function clearPending(s: CodexDecodeState): void {
  s.pendingTools = []
  s.pendingToolSequence = []
  s.pendingUserMessage = ''
  s.pendingOutputChars = 0
  s.pendingLocAdded = 0
  s.pendingLocRemoved = 0
  s.pendingEditFailed = 0
}

export type CodexDecodeInput = {
  records: unknown[]
  context: DecodeContext
  state?: CodexDecodeState
  // Optional live dedup set the host mutates in place (its shared cross-file
  // seenKeys). When provided it is canonical and `state.seenKeys` is left empty;
  // when absent the decoder threads dedup memory through `state.seenKeys`.
  seenKeys?: Set<string>
  // Session id to fall back to when a session_meta omits `session_id` (the CLI
  // passes the rollout file's basename; core never touches the path).
  sessionIdFallback?: string
}

export type CodexDecodeResult = {
  calls: CodexDecodedCall[]
  diagnostics: RecordDiagnostic[]
  state: CodexDecodeState
}

/**
 * Decode a batch of Codex rollout records into rich, cost-free calls, threading
 * explicit serializable state. Concatenating the calls from decoding a corpus in
 * one pass equals concatenating the calls from any split of it, as long as the
 * state (and dedup memory) threads between passes — the resume invariant.
 */
// `context` is part of the Decoder contract but the rich layer never consumes it:
// minimization / fingerprinting happens in toObservations, which takes the
// privacy key directly. It stays in the input type for contract conformance.
export function decodeCodex({ records, state: prevState, seenKeys: liveSeen, sessionIdFallback = '' }: CodexDecodeInput): CodexDecodeResult {
  const s = prevState ? cloneState(prevState) : freshCodexState()
  const seen = liveSeen ?? new Set(s.seenKeys)
  const calls: CodexDecodedCall[] = []
  const diagnostics: RecordDiagnostic[] = []

  for (const [index, rawLine] of records.entries()) {
    const entry = parseCodexLine(rawLine as string | Buffer)
    if (!entry) continue

    if (entry.type === 'session_meta') {
      // Update in place — do NOT reset the running counters. A single rollout
      // file can carry more than one session_meta (Codex re-emits it on resume /
      // fork within the same file); the pre-phase-4 decoder treated the whole
      // file as one continuous session and only re-assigned these fields, keeping
      // the cumulative-dedup and delta counters intact. Per-file freshness comes
      // from the host starting a new decode (state: undefined) per file, not from
      // resetting here.
      s.sessionId = firstString(entry.payload?.session_id) ?? sessionIdFallback
      // Same unchecked-cast caveat as the discovery payload check: `cwd` is
      // declared `string` but comes straight off JSON.parse, and a non-string
      // value would ride into projectPath/workingDirectory where downstream
      // path helpers call string methods on it.
      const sessionCwd = firstString(entry.payload?.cwd)
      if (sessionCwd) s.sessionCwd = sessionCwd
      s.forkedFromId = firstString(entry.payload?.forked_from_id) ?? ''
      if (s.forkedFromId) {
        // An unparseable timestamp (a garbage string, or a non-string from
        // the unchecked JSON.parse cast) makes `new Date(NaN).toISOString()`
        // throw RangeError, which would sink this whole session to zero.
        const forkBase = firstParseableTimestamp(entry.timestamp)
        if (forkBase) s.forkCutoff = new Date(new Date(forkBase).getTime() + 5000).toISOString()
      }
      const sessionModel = firstString(entry.payload?.model)
      if (sessionModel) s.sessionModel = sessionModel
      continue
    }

    if (entry.type === 'turn_context') {
      const turnModel = firstString(entry.payload?.model)
      if (turnModel) s.sessionModel = turnModel
      continue
    }

    if (entry.type === 'response_item' && entry.payload?.type === 'function_call') {
      const rawName = entry.payload.name ?? ''
      const mapped = codexToolNameMap[rawName] ?? rawName
      s.pendingTools.push(mapped)
      const call: CodexToolCall = { tool: mapped }
      const rawArgs = (entry.payload as Record<string, unknown>)['arguments']
      const args = typeof rawArgs === 'string'
        ? (() => { try { return JSON.parse(rawArgs) as Record<string, unknown> } catch { return null } })()
        : typeof rawArgs === 'object' && rawArgs ? rawArgs as Record<string, unknown> : null
      if (args) {
        const fp = args['file_path'] ?? args['path']
        if (typeof fp === 'string') call.file = fp
        const cmd = args['command'] ?? args['cmd']
        if (typeof cmd === 'string') call.command = cmd
        const mcpTool = mcpToolFromShellCommand(cmd)
        if (mcpTool) {
          s.pendingTools.push(mcpTool)
          s.pendingToolSequence.push([{ tool: mcpTool }])
        }
      }
      s.pendingToolSequence.push([call])
      continue
    }

    if (entry.type === 'event_msg' && entry.payload?.type === 'patch_apply_end') {
      s.pendingTools.push('Edit')
      const p = entry.payload as Record<string, unknown>
      const changes = p['changes']
      const changesObj = typeof changes === 'object' && changes ? changes as Record<string, unknown> : {}
      const filePaths = Object.keys(changesObj)
      if (filePaths.length > 0) {
        for (const fp of filePaths) {
          s.pendingToolSequence.push([{ tool: 'Edit', file: fp }])
          const diff = (changesObj[fp] as Record<string, unknown> | undefined)?.['unified_diff']
          const loc = countUnifiedDiffLoc(diff)
          s.pendingLocAdded += loc.added
          s.pendingLocRemoved += loc.removed
        }
      } else {
        s.pendingToolSequence.push([{ tool: 'Edit' }])
      }
      if (p['success'] === false) s.pendingEditFailed++
      continue
    }

    if (entry.type === 'event_msg' && entry.payload?.type === 'mcp_tool_call_end') {
      const inv = (entry.payload as Record<string, unknown>)['invocation'] as Record<string, unknown> | undefined
      const server = typeof inv?.['server'] === 'string' ? inv['server'] as string : ''
      const tool = typeof inv?.['tool'] === 'string' ? inv['tool'] as string : ''
      if (server && tool) {
        const name = `mcp__${server}__${tool}`
        s.pendingTools.push(name)
        s.pendingToolSequence.push([{ tool: name }])
      }
      continue
    }

    if (entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload?.role === 'user') {
      const texts = normalizeContentBlocks(entry.payload.content)
        .filter(c => c.type === 'input_text')
        .map(c => c.text ?? '')
        .filter(Boolean)
      if (texts.length > 0) {
        s.pendingUserMessage = texts.join(' ').slice(0, 500)
        s.currentTurnId = `${s.sessionId}:t${++s.turnCounter}`
      }
      continue
    }

    if (entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload?.role === 'assistant') {
      const texts = normalizeContentBlocks(entry.payload.content)
        .filter(c => c.type === 'output_text' || c.type === 'text')
        .map(c => c.text ?? '')
      s.pendingOutputChars += texts.join('').length
      continue
    }

    if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
      // `timestamp` is declared `string` but comes straight off the unchecked
      // cast. A number/object/bool — or a garbage string — riding into
      // call.timestamp would make the host's day aggregator bucket the call
      // under 'NaN-NaN-NaN' (Invalid Date), and the daily cache keeps that
      // bucket for ten years. Drop the event and record a diagnostic instead;
      // pending content stays pending so the next flush still counts it.
      const timestamp = firstParseableTimestamp(entry.timestamp)
      if (!timestamp) {
        diagnostics.push({ index, code: 'invalid-value', detail: 'token_count timestamp is not a parseable string; event skipped' })
        continue
      }
      // Forked sessions replay the parent's event history clustered at the fork
      // creation time. Skip replays within 5s of the fork to avoid double-count.
      if (s.forkCutoff && timestamp < s.forkCutoff) continue
      const info = entry.payload.info
      if (!info) {
        if (s.pendingOutputChars === 0 && s.pendingUserMessage.length === 0) continue
        const estInput = estimateTokensFromChars(s.pendingUserMessage.length)
        const estOutput = estimateTokensFromChars(s.pendingOutputChars)
        if (estInput === 0 && estOutput === 0) continue

        const model = s.sessionModel ?? 'gpt-5'
        const dedupKey = `codex:${s.sessionId}:${timestamp}:est${s.estCounter++}`

        if (seen.has(dedupKey)) { clearPending(s); continue }
        seen.add(dedupKey)

        calls.push({
          provider: 'codex',
          model,
          inputTokens: estInput,
          outputTokens: estOutput,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          webSearchRequests: 0,
          costIsEstimated: true,
          tools: s.pendingTools,
          timestamp,
          speed: 'standard',
          deduplicationKey: dedupKey,
          turnId: s.currentTurnId,
          toolSequence: s.pendingToolSequence.length > 0 ? s.pendingToolSequence : undefined,
          userMessage: s.pendingUserMessage,
          sessionId: s.sessionId,
          ...(s.sessionCwd ? { projectPath: s.sessionCwd, workingDirectory: s.sessionCwd } : {}),
          ...(s.pendingLocAdded ? { locAdded: s.pendingLocAdded } : {}),
          ...(s.pendingLocRemoved ? { locRemoved: s.pendingLocRemoved } : {}),
          ...(s.pendingEditFailed ? { editFailed: s.pendingEditFailed } : {}),
        })

        clearPending(s)
        continue
      }

      const cumulativeTotal = firstFiniteNumber(info.total_token_usage?.total_tokens) ?? 0
      if (s.prevCumulativeTotal !== null && cumulativeTotal === s.prevCumulativeTotal) continue
      s.prevCumulativeTotal = cumulativeTotal

      const last = info.last_token_usage
      let inputTokens = 0
      let cachedInputTokens = 0
      let outputTokens = 0
      let reasoningTokens = 0

      if (last) {
        // Token counts share the unchecked-cast caveat: a garbage string or
        // object mixed with real numbers turns the totals into a string or
        // NaN, which slips past the `=== 0` skip and reaches the host's
        // pricing pass as NaN cost. A field that is not a finite number
        // counts as zero — the same default as a missing field — so valid
        // siblings are never thrown away and NaN can never form.
        inputTokens = firstFiniteNumber(last.input_tokens) ?? 0
        cachedInputTokens = firstFiniteNumber(last.cached_input_tokens) ?? 0
        outputTokens = firstFiniteNumber(last.output_tokens) ?? 0
        reasoningTokens = firstFiniteNumber(last.reasoning_output_tokens) ?? 0
      } else if (cumulativeTotal > 0) {
        const total = info.total_token_usage
        if (!total) continue
        inputTokens = (firstFiniteNumber(total.input_tokens) ?? 0) - s.prevInput
        cachedInputTokens = (firstFiniteNumber(total.cached_input_tokens) ?? 0) - s.prevCached
        outputTokens = (firstFiniteNumber(total.output_tokens) ?? 0) - s.prevOutput
        reasoningTokens = (firstFiniteNumber(total.reasoning_output_tokens) ?? 0) - s.prevReasoning
      }

      // Always advance the prev counters to mirror the cumulative state, whether
      // this event used `last` or the delta fallback.
      const total: CodexTokenUsage | undefined = info.total_token_usage
      if (total) {
        s.prevInput = firstFiniteNumber(total.input_tokens) ?? 0
        s.prevCached = firstFiniteNumber(total.cached_input_tokens) ?? 0
        s.prevOutput = firstFiniteNumber(total.output_tokens) ?? 0
        s.prevReasoning = firstFiniteNumber(total.reasoning_output_tokens) ?? 0
      }

      const totalTokens = inputTokens + cachedInputTokens + outputTokens + reasoningTokens
      if (totalTokens === 0) continue

      // OpenAI includes cached tokens inside input_tokens; normalize to Anthropic
      // semantics: inputTokens = non-cached only.
      const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens)

      const model = resolveModel(entry.payload, s.sessionModel)
      // Fork replays copy the parent's token_count history verbatim, so key on
      // the parent namespace plus the cumulative breakdown: a true replay collides
      // exactly, genuinely different work at the same total stays distinct.
      const dedupKey = `codex:${s.forkedFromId || s.sessionId}:${cumulativeTotal}:${firstFiniteNumber(total?.input_tokens) ?? 0}:${firstFiniteNumber(total?.cached_input_tokens) ?? 0}:${firstFiniteNumber(total?.output_tokens) ?? 0}:${firstFiniteNumber(total?.reasoning_output_tokens) ?? 0}`

      if (seen.has(dedupKey)) continue
      seen.add(dedupKey)

      calls.push({
        provider: 'codex',
        model,
        inputTokens: uncachedInputTokens,
        outputTokens,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: cachedInputTokens,
        cachedInputTokens,
        reasoningTokens,
        webSearchRequests: 0,
        tools: s.pendingTools,
        timestamp,
        speed: 'standard',
        deduplicationKey: dedupKey,
        turnId: s.currentTurnId,
        toolSequence: s.pendingToolSequence.length > 0 ? s.pendingToolSequence : undefined,
        userMessage: s.pendingUserMessage,
        sessionId: s.sessionId,
        ...(s.sessionCwd ? { projectPath: s.sessionCwd, workingDirectory: s.sessionCwd } : {}),
        ...(s.pendingLocAdded ? { locAdded: s.pendingLocAdded } : {}),
        ...(s.pendingLocRemoved ? { locRemoved: s.pendingLocRemoved } : {}),
        ...(s.pendingEditFailed ? { editFailed: s.pendingEditFailed } : {}),
      })

      clearPending(s)
    }
  }

  s.seenKeys = liveSeen ? [] : [...seen]
  return { calls, diagnostics, state: s }
}
