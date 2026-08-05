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
  CodexTimingPatch,
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
  // Codex Desktop's custom-tool transport uses the shorter `exec` name for
  // the same shell tool that CLI rollouts record as `exec_command`.
  exec: 'Bash',
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

function getRawJsonNumberField(head: string, field: string): number | undefined {
  const match = new RegExp(`"${field}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`).exec(head)
  if (!match) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) ? value : undefined
}

function getRawPayloadFieldWindow(source: Buffer, field: string, windowBytes = 4096): string | undefined {
  const payloadKey = Buffer.from('"payload"')
  const payloadIndex = source.indexOf(payloadKey)
  if (payloadIndex < 0) return undefined
  let payloadStart = source.indexOf(0x7b, payloadIndex + payloadKey.length) // {
  if (payloadStart < 0) return undefined

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = payloadStart; i < source.length; i++) {
    const byte = source[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (byte === 0x5c) escaped = true // \
      else if (byte === 0x22) inString = false // "
      continue
    }
    if (byte === 0x22) {
      const keyStart = i + 1
      let keyEnd = keyStart
      let keyEscaped = false
      for (; keyEnd < source.length; keyEnd++) {
        const keyByte = source[keyEnd]!
        if (keyEscaped) { keyEscaped = false; continue }
        if (keyByte === 0x5c) { keyEscaped = true; continue }
        if (keyByte === 0x22) break
      }
      if (depth === 1 && keyEnd < source.length) {
        const key = source.subarray(keyStart, keyEnd).toString('utf-8')
        let valueStart = keyEnd + 1
        while (valueStart < source.length && (source[valueStart] === 0x20 || source[valueStart] === 0x09 || source[valueStart] === 0x0a || source[valueStart] === 0x0d)) valueStart++
        if (source[valueStart] === 0x3a && key === field) {
          return source.subarray(i, Math.min(source.length, i + windowBytes)).toString('utf-8')
        }
      }
      i = keyEnd
      inString = false
      continue
    }
    if (byte === 0x22) inString = true
    else if (byte === 0x7b || byte === 0x5b) depth++ // { or [
    else if (byte === 0x7d || byte === 0x5d) depth-- // } or ]
    if (depth < 0) break
  }
  return undefined
}

function getRawDurationMs(head: string): number | undefined {
  const objectMatch = /"duration"\s*:\s*\{\s*"secs"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*"nanos"\s*:\s*(-?\d+(?:\.\d+)?)\s*\}/.exec(head)
  if (objectMatch) {
    const seconds = Number(objectMatch[1])
    const nanos = Number(objectMatch[2])
    if (Number.isFinite(seconds) && Number.isFinite(nanos)) return seconds * 1000 + nanos / 1e6
  }
  const text = getRawJsonStringField(head, 'duration')
  if (text) {
    const match = /^(\d+(?:\.\d+)?)(ms|s)?$/.exec(text.trim())
    if (match) {
      const value = Number(match[1])
      if (Number.isFinite(value)) return value * (match[2] === 's' ? 1000 : 1)
    }
  }
  return undefined
}

function durationValueMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'object' && value) {
    const record = value as Record<string, unknown>
    const seconds = record['secs']
    const nanos = record['nanos']
    if (typeof seconds === 'number' && typeof nanos === 'number' && Number.isFinite(seconds) && Number.isFinite(nanos)) {
      return seconds * 1000 + nanos / 1e6
    }
  }
  if (typeof value === 'string') {
    const match = /^(\d+(?:\.\d+)?)(ms|s)?$/.exec(value.trim())
    if (match) {
      const parsed = Number(match[1])
      if (Number.isFinite(parsed)) return parsed * (match[2] === 's' ? 1000 : 1)
    }
  }
  return undefined
}

function getRawTokenUsage(head: string, field: 'last_token_usage' | 'total_token_usage'): CodexTokenUsage | undefined {
  const match = new RegExp(`"${field}"\\s*:\\s*\\{([^}]*)\\}`).exec(head)
  if (!match) return undefined
  const body = match[1]!
  return {
    input_tokens: getRawJsonNumberField(body, 'input_tokens'),
    cached_input_tokens: getRawJsonNumberField(body, 'cached_input_tokens'),
    output_tokens: getRawJsonNumberField(body, 'output_tokens'),
    reasoning_output_tokens: getRawJsonNumberField(body, 'reasoning_output_tokens'),
    total_tokens: getRawJsonNumberField(body, 'total_tokens'),
  }
}

function getRawInvocation(head: string): { server?: string; tool?: string } | undefined {
  const idx = head.indexOf('"invocation"')
  if (idx === -1) return undefined
  // Server/tool are shallow fields and precede the potentially huge arguments
  // object in Codex MCP records. Limit this scan to keep compact parsing cheap.
  const invocationHead = head.slice(idx, idx + 8192)
  const server = getRawJsonStringField(invocationHead, 'server')
  const tool = getRawJsonStringField(invocationHead, 'tool')
  return server || tool ? { server, tool } : undefined
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
  // task_complete appends the potentially huge final assistant message before
  // its duration fields. Fall back to the full Buffer only for this event so
  // timing metadata is not lost when the compact head stops early.
  const needsTimingTail = type === 'event_msg' && (payloadType === 'task_complete' || payloadType === 'mcp_tool_call_end')
  const timingTail = needsTimingTail && line.length > RAW_HEAD_BYTES
    ? line.subarray(Math.max(0, line.length - 16 * 1024)).toString('utf-8')
    : pHead
  const timingNumber = (field: string): number | undefined =>
    getRawJsonNumberField(pHead, field) ?? getRawJsonNumberField(timingTail, field)
  // MCP records can place a large invocation.arguments object before duration
  // and a large result after it. Searching a small window around the field
  // avoids materializing the middle of the Buffer while still preserving wait
  // timing for those records.
  const payloadDuration = payloadType === 'mcp_tool_call_end'
    ? getRawDurationMs(getRawPayloadFieldWindow(line, 'duration') ?? '')
    : undefined
  const timingDuration = payloadDuration ?? getRawDurationMs(pHead) ?? getRawDurationMs(timingTail)
  const compactModel = getRawJsonStringField(pHead, 'model')
  const compactModelName = getRawJsonStringField(pHead, 'model_name')
  const compactLastUsage = getRawTokenUsage(pHead, 'last_token_usage')
  const compactTotalUsage = getRawTokenUsage(pHead, 'total_token_usage')
  const compactInfo = compactModel || compactModelName || compactLastUsage || compactTotalUsage
    ? { model: compactModel, model_name: compactModelName, last_token_usage: compactLastUsage, total_token_usage: compactTotalUsage }
    : undefined
  const invocation = getRawInvocation(pHead) ?? getRawInvocation(timingTail)

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
      invocation,
      call_id: getRawJsonStringField(pHead, 'call_id'),
      turn_id: getRawJsonStringField(pHead, 'turn_id'),
      duration_ms: timingNumber('duration_ms') ?? timingDuration,
      started_at: timingNumber('started_at'),
      info: compactInfo,
    },
  }

  if (type === 'response_item' && payloadType === 'message' && role === 'user') {
    entry.payload!.content = [{ type: 'input_text', text: extractFirstJsonText(line) }]
  } else if (type === 'response_item' && payloadType === 'message' && role === 'assistant') {
    entry.payload!.content = [{ type: 'output_text', text: 'x'.repeat(Math.min(countFirstJsonText(line), LARGE_TEXT_CAP)) }]
  }

  return entry
}

function resolveModel(info: CodexEntry['payload'], sessionModel?: string): string {
  return info?.model
    ?? info?.info?.model
    ?? info?.info?.model_name
    ?? sessionModel
    ?? 'gpt-5'
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
    // Task-timing window: a fresh window starts at the first call of the pass
    // (priorCallCount is 0 on a cold decode).
    taskResultStart: 0,
    taskGeneratedTokens: 0,
    taskToolIntervals: [],
    taskStartedAt: undefined,
    openToolStarts: {},
  }
}

function cloneState(prev: CodexDecodeState): CodexDecodeState {
  return {
    ...prev,
    pendingTools: [...prev.pendingTools],
    pendingToolSequence: prev.pendingToolSequence.map(step => step.map(c => ({ ...c }))),
    seenKeys: [...prev.seenKeys],
    taskToolIntervals: prev.taskToolIntervals ? prev.taskToolIntervals.map(i => [...i]) : [],
    openToolStarts: { ...(prev.openToolStarts ?? {}) },
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
  // Number of calls the host already emitted in EARLIER passes of this file
  // (0 on a cold decode). The task-timing window's `taskResultStart` is an
  // absolute index into the concatenated prior+current call list, so a resumed
  // pass must know where its own calls begin. Also required for the absolute
  // indices in the `timingPatches` it returns.
  priorCallCount?: number
  // Session id to fall back to when a session_meta omits `session_id` (the CLI
  // passes the rollout file's basename; core never touches the path).
  sessionIdFallback?: string
}

export type CodexDecodeResult = {
  calls: CodexDecodedCall[]
  diagnostics: RecordDiagnostic[]
  state: CodexDecodeState
  // Proportional active-timing attribution for the calls of a task that was
  // OPEN when a prior decode pass ended and whose task_complete arrived in this
  // pass (see CodexTimingPatch). Empty unless a task straddles the boundary.
  timingPatches: CodexTimingPatch[]
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
export function decodeCodex({ records, state: prevState, seenKeys: liveSeen, sessionIdFallback = '', priorCallCount = 0 }: CodexDecodeInput): CodexDecodeResult {
  const s = prevState ? cloneState(prevState) : freshCodexState()
  const seen = liveSeen ?? new Set(s.seenKeys)
  const calls: CodexDecodedCall[] = []
  const diagnostics: RecordDiagnostic[] = []
  const timingPatches: CodexTimingPatch[] = []

  // Task-timing window (tool-excluded active throughput, issue a6bf81f).
  // Seeded from the threaded state so a task whose task_started / token_counts
  // landed in an earlier pass keeps its window when task_complete arrives here:
  // `taskResultStart` is an ABSOLUTE index into the concatenated prior+current
  // call list (priorCallCount offsets this pass's own calls). On a state that
  // predates the fields (or a fresh decode) the window starts fresh.
  let taskResultStart = s.taskResultStart ?? priorCallCount
  let taskGeneratedTokens = s.taskGeneratedTokens ?? 0
  let taskToolIntervals: Array<[number, number]> = s.taskToolIntervals ? s.taskToolIntervals.map(i => [...i]) : []
  let taskStartedAt: number | undefined = s.taskStartedAt
  const openToolStarts = new Map<string, number>(Object.entries(s.openToolStarts ?? {}))

  for (const rawLine of records) {
    const entry = parseCodexLine(rawLine as string | Buffer)
    if (!entry) continue

    const isForkReplay = Boolean(s.forkCutoff && entry.timestamp && entry.timestamp < s.forkCutoff)
    if (isForkReplay && (
      entry.payload?.type === 'task_started' ||
      entry.payload?.type === 'task_complete' ||
      entry.payload?.type === 'function_call' ||
      entry.payload?.type === 'function_call_output' ||
      entry.payload?.type === 'custom_tool_call' ||
      entry.payload?.type === 'custom_tool_call_output' ||
      entry.payload?.type === 'mcp_tool_call_end' ||
      entry.payload?.type === 'patch_apply_end'
    )) continue

    if (entry.type === 'event_msg' && entry.payload?.type === 'task_started') {
      taskResultStart = priorCallCount + calls.length
      taskGeneratedTokens = 0
      taskToolIntervals = []
      const startedAt = entry.timestamp ? Date.parse(entry.timestamp) : NaN
      taskStartedAt = Number.isFinite(startedAt) ? startedAt : undefined
      openToolStarts.clear()
      continue
    }

    if (entry.type === 'session_meta') {
      // Update in place — do NOT reset the running counters. A single rollout
      // file can carry more than one session_meta (Codex re-emits it on resume /
      // fork within the same file); the pre-phase-4 decoder treated the whole
      // file as one continuous session and only re-assigned these fields, keeping
      // the cumulative-dedup and delta counters intact. Per-file freshness comes
      // from the host starting a new decode (state: undefined) per file, not from
      // resetting here.
      s.sessionId = entry.payload?.session_id ?? sessionIdFallback
      s.sessionCwd = entry.payload?.cwd ?? s.sessionCwd
      s.forkedFromId = entry.payload?.forked_from_id ?? ''
      if (s.forkedFromId && entry.timestamp) {
        s.forkCutoff = new Date(new Date(entry.timestamp).getTime() + 5000).toISOString()
      }
      s.sessionModel = entry.payload?.model ?? s.sessionModel
      continue
    }

    if (entry.type === 'turn_context' && entry.payload?.model) {
      s.sessionModel = entry.payload.model
      continue
    }

    if (entry.type === 'response_item' && (entry.payload?.type === 'function_call' || entry.payload?.type === 'custom_tool_call')) {
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
      const callId = entry.payload.call_id
      const started = entry.timestamp ? Date.parse(entry.timestamp) : NaN
      if (callId && Number.isFinite(started)) openToolStarts.set(callId, started)
      s.pendingToolSequence.push([call])
      continue
    }

    if (entry.type === 'response_item' && (entry.payload?.type === 'function_call_output' || entry.payload?.type === 'custom_tool_call_output')) {
      const callId = entry.payload.call_id
      const ended = entry.timestamp ? Date.parse(entry.timestamp) : NaN
      const started = callId ? openToolStarts.get(callId) : undefined
      if (started !== undefined && Number.isFinite(ended) && ended > started) taskToolIntervals.push([started, ended])
      if (callId) openToolStarts.delete(callId)
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
      const endedAt = entry.timestamp ? Date.parse(entry.timestamp) : NaN
      const durationMs = entry.payload.duration_ms ?? durationValueMs(entry.payload.duration)
      if (typeof durationMs === 'number' && durationMs > 0 && Number.isFinite(endedAt)) {
        taskToolIntervals.push([endedAt - durationMs, endedAt])
      }
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

    if (entry.type === 'event_msg' && entry.payload?.type === 'task_complete') {
      const durationMs = entry.payload.duration_ms
      const taskEnd = priorCallCount + calls.length
      if (typeof durationMs === 'number' && durationMs > 0 && taskGeneratedTokens > 0 && taskResultStart < taskEnd) {
        const completedAt = entry.timestamp ? Date.parse(entry.timestamp) : NaN
        const windowStart = taskStartedAt ?? (Number.isFinite(completedAt) ? completedAt - durationMs : undefined)
        const windowEnd = windowStart !== undefined ? windowStart + durationMs : undefined
        const clipped = taskToolIntervals.map(([start, end]) => [
          windowStart !== undefined ? Math.max(start, windowStart) : start,
          windowEnd !== undefined ? Math.min(end, windowEnd) : end,
        ] as [number, number]).filter(([start, end]) => end > start)
        const merged = clipped.sort((a, b) => a[0] - b[0]).reduce<Array<[number, number]>>((acc, interval) => {
          const previous = acc.at(-1)
          if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1])
          else acc.push([...interval])
          return acc
        }, [])
        const toolWaitMs = Math.min(durationMs, merged.reduce((sum, interval) => sum + interval[1] - interval[0], 0))
        const activeMs = durationMs - toolWaitMs
        if (activeMs > 0) {
          // Attribute the in-pass calls directly; a task opened in an EARLIER
          // pass additionally hands the host a patch so the earlier-pass calls
          // (already returned to it) get the same proportional split.
          const inPassStart = Math.max(taskResultStart, priorCallCount)
          for (let i = inPassStart; i < taskEnd; i++) {
            const call = calls[i - priorCallCount]!
            const generated = call.outputTokens + call.reasoningTokens
            if (generated <= 0) continue
            call.activeGeneratedTokens = generated
            call.activeDurationMs = activeMs * (generated / taskGeneratedTokens)
            call.toolWaitMs = toolWaitMs * (generated / taskGeneratedTokens)
          }
          if (taskResultStart < priorCallCount) {
            timingPatches.push({ resultStart: taskResultStart, resultEnd: taskEnd, activeDurationMs: activeMs, taskGeneratedTokens, toolWaitMs })
          }
        }
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
      // Forked sessions replay the parent's event history clustered at the fork
      // creation time. Skip replays within 5s of the fork to avoid double-count.
      if (s.forkCutoff && entry.timestamp && entry.timestamp < s.forkCutoff) continue
      const info = entry.payload.info
      if (!info) {
        if (s.pendingOutputChars === 0 && s.pendingUserMessage.length === 0) continue
        const estInput = estimateTokensFromChars(s.pendingUserMessage.length)
        const estOutput = estimateTokensFromChars(s.pendingOutputChars)
        if (estInput === 0 && estOutput === 0) continue

        const model = s.sessionModel ?? 'gpt-5'
        const timestamp = entry.timestamp ?? ''
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

        taskGeneratedTokens += estOutput
        clearPending(s)
        continue
      }

      const cumulativeTotal = info.total_token_usage?.total_tokens ?? 0
      if (s.prevCumulativeTotal !== null && cumulativeTotal === s.prevCumulativeTotal) continue
      s.prevCumulativeTotal = cumulativeTotal

      const last = info.last_token_usage
      let inputTokens = 0
      let cachedInputTokens = 0
      let outputTokens = 0
      let reasoningTokens = 0

      if (last) {
        inputTokens = last.input_tokens ?? 0
        cachedInputTokens = last.cached_input_tokens ?? 0
        outputTokens = last.output_tokens ?? 0
        reasoningTokens = last.reasoning_output_tokens ?? 0
      } else if (cumulativeTotal > 0) {
        const total = info.total_token_usage
        if (!total) continue
        inputTokens = (total.input_tokens ?? 0) - s.prevInput
        cachedInputTokens = (total.cached_input_tokens ?? 0) - s.prevCached
        outputTokens = (total.output_tokens ?? 0) - s.prevOutput
        reasoningTokens = (total.reasoning_output_tokens ?? 0) - s.prevReasoning
      }

      // Always advance the prev counters to mirror the cumulative state, whether
      // this event used `last` or the delta fallback.
      const total: CodexTokenUsage | undefined = info.total_token_usage
      if (total) {
        s.prevInput = total.input_tokens ?? 0
        s.prevCached = total.cached_input_tokens ?? 0
        s.prevOutput = total.output_tokens ?? 0
        s.prevReasoning = total.reasoning_output_tokens ?? 0
      }

      const totalTokens = inputTokens + cachedInputTokens + outputTokens + reasoningTokens
      if (totalTokens === 0) continue

      // OpenAI includes cached tokens inside input_tokens; normalize to Anthropic
      // semantics: inputTokens = non-cached only.
      const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens)

      const model = resolveModel(entry.payload, s.sessionModel)
      const timestamp = entry.timestamp ?? ''
      // Fork replays copy the parent's token_count history verbatim, so key on
      // the parent namespace plus the cumulative breakdown: a true replay collides
      // exactly, genuinely different work at the same total stays distinct.
      const dedupKey = `codex:${s.forkedFromId || s.sessionId}:${cumulativeTotal}:${total?.input_tokens ?? 0}:${total?.cached_input_tokens ?? 0}:${total?.output_tokens ?? 0}:${total?.reasoning_output_tokens ?? 0}`

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

      taskGeneratedTokens += outputTokens + reasoningTokens
      clearPending(s)
    }
  }

  // Persist the task-timing window in the threaded state so a later
  // (append-resume) pass can close a still-open task with attribution across
  // the boundary.
  s.taskResultStart = taskResultStart
  s.taskGeneratedTokens = taskGeneratedTokens
  s.taskToolIntervals = taskToolIntervals
  s.taskStartedAt = taskStartedAt
  s.openToolStarts = Object.fromEntries(openToolStarts)

  s.seenKeys = liveSeen ? [] : [...seen]
  return { calls, diagnostics, state: s, timingPatches }
}

/**
 * Apply the timing patches a resumed decode returned (see CodexTimingPatch) to
 * the host's CONCATENATED prior+new call list. Indices are absolute into that
 * list. Overwriting the in-pass portion is a harmless no-op: the formula below
 * is exactly the decoder's, so it writes identical values.
 */
export function applyCodexTimingPatches(
  calls: Array<{
    outputTokens: number
    reasoningTokens: number
    activeDurationMs?: number
    activeGeneratedTokens?: number
    toolWaitMs?: number
  }>,
  patches: CodexTimingPatch[],
): void {
  for (const patch of patches) {
    for (let i = patch.resultStart; i < Math.min(patch.resultEnd, calls.length); i++) {
      const call = calls[i]!
      const generated = call.outputTokens + call.reasoningTokens
      if (generated <= 0) continue
      call.activeGeneratedTokens = generated
      call.activeDurationMs = patch.activeDurationMs * (generated / patch.taskGeneratedTokens)
      call.toolWaitMs = patch.toolWaitMs * (generated / patch.taskGeneratedTokens)
    }
  }
}
