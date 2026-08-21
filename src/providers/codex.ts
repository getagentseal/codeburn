import { readdir, stat } from 'fs/promises'
import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import { basename, join } from 'path'
import { homedir } from 'os'

import { readSessionLines } from '../fs-utils.js'
import { billableOutputTokens, calculateCost, getModelCosts } from '../models.js'
import { readCachedCodexResults, writeCachedCodexResults, getCachedCodexProject, fingerprintFile, type CodexFileFingerprint } from '../codex-cache.js'
import { mergeToolIntervals } from '../codex-throughput.js'
import { normalizeContentBlocks } from '../content-utils.js'
import { estimateTokensFromChars } from '../token-estimate.js'
import { wslHomes } from '../wsl.js'
import type { ToolCall } from '../types.js'
import type { Provider, ProbeRoot, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

const modelDisplayNames: Record<string, string> = {
  'codex-auto-review': 'Codex Auto Review',
  'gpt-5.5': 'GPT-5.5',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.3-codex-spark': 'GPT-5.3 Codex Spark',
  'gpt-5.3-codex': 'GPT-5.3 Codex',
  'gpt-5.2-low': 'GPT-5.2 Low',
  'gpt-5.2': 'GPT-5.2',
  'gpt-5': 'GPT-5',
  'gpt-4o-mini': 'GPT-4o Mini',
  'gpt-4o': 'GPT-4o',
}

// Longest-first + version-boundary match so an unlisted future minor (gpt-5.6)
// falls through to its raw id instead of collapsing into the base "GPT-5" entry.
const modelDisplayEntries = Object.entries(modelDisplayNames).sort((a, b) => b[0].length - a[0].length)

const toolNameMap: Record<string, string> = {
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
// through a shell command instead of registering the server natively. Codex
// then logs a plain exec_command with no `mcp_tool_call_end` event, so the MCP
// usage would only appear as a shell command and be absent from the MCP
// breakdown (issue #478). Recognize the `mcp-cli [options] call <server>
// <tool>` form and return the canonical mcp__<server>__<tool> so the call is
// also attributed to MCP. Only the `call` subcommand (an actual tool execution)
// is matched; info / grep / bare listing are lookups. The exec_command still
// counts as Bash since it genuinely is a shell exec. Scoped to the mcp-cli
// binary; other wrappers would need their own pattern.
//
// The negative lookbehind keeps `mcp-cli` a standalone binary (a leading
// quote/space/slash from a `bash -lc "..."` wrapper or absolute path is fine,
// but `foo-mcp-cli` is not). `(?:\s+(?!call\b)[^\s;|&]+)*` skips any options and
// their values between the binary and the subcommand (e.g.
// `mcp-cli -c ./mcp.json call ...`) without crossing a shell separator, and
// stops at the `call` token. This is substring matching, so a command that
// merely mentions the phrase (a comment, an echo, a commit message) can
// false-positive, an accepted tradeoff for the common case. \s+ and the token
// class don't overlap, so there is no catastrophic backtracking.
const MCP_CLI_CALL = /(?<![\w.-])mcp-cli(?:\s+(?!call\b)[^\s;|&]+)*\s+call\s+(\S+)\s+(\S+)/
function mcpToolFromShellCommand(command: unknown): string | null {
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
// `unified_diff`. A leading '+' is an added line and '-' a removed line; the
// '+++'/'---' file headers and '@@' hunk headers are excluded. Numbers only —
// the diff text is never stored. Rich-session-capture (capture-only).
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

type CodexEntry = {
  type: string
  timestamp?: string
  payload?: {
    type?: string
    turn_id?: string
    call_id?: string
    started_at?: number
    duration_ms?: number
    duration?: { secs?: number; nanos?: number } | string
    role?: string
    cwd?: string
    model_provider?: string
    originator?: string
    session_id?: string
    forked_from_id?: string
    model?: string
    name?: string
    invocation?: { server?: string; tool?: string }
    content?: Array<{ type?: string; text?: string }>
    info?: {
      model?: string
      model_name?: string
      last_token_usage?: CodexTokenUsage
      total_token_usage?: CodexTokenUsage
    }
  }
}

type CodexTokenUsage = {
  input_tokens?: number
  cached_input_tokens?: number
  /// Portion of `input_tokens` that was WRITTEN to the prompt cache this call
  /// (codex PR #33454). Like `cached_input_tokens`, it is carved out of
  /// `input_tokens`, not added on top.
  cache_write_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
  total_tokens?: number
}

const RAW_HEAD_BYTES = 64 * 1024
const LARGE_TEXT_CAP = 2000

function getCodexDir(override?: string): string {
  return override ?? process.env['CODEX_HOME'] ?? join(homedir(), '.codex')
}

function sanitizeProject(cwd: string): string {
  return cwd.replace(/^\//, '').replace(/\//g, '-')
}

// Cap how many bytes we'll read while looking for the first newline. Real
// Codex session_meta lines are ~22-27 KB; this leaves plenty of headroom while
// keeping memory bounded if a corrupt file has no newline at all.
const FIRST_LINE_READ_CAP = 1024 * 1024

async function readFirstLine(filePath: string): Promise<CodexEntry | null> {
  // Codex CLI 0.128+ writes a session_meta line that can exceed 20 KB because
  // it embeds the full base_instructions / system prompt. A fixed-size buffer
  // would miss the trailing newline and reject the session as invalid.
  // Stream the file via readline so we can read the first line up to
  // FIRST_LINE_READ_CAP, which keeps memory bounded if the file has no newline.
  const stream = createReadStream(filePath, {
    encoding: 'utf-8',
    start: 0,
    end: FIRST_LINE_READ_CAP - 1,
  })
  // Silence stream errors so a late read-ahead error after we've already
  // returned the first line cannot escape as an unhandled 'error' event.
  // readline's async iterator re-throws underlying stream errors (ENOENT,
  // EACCES, etc.) on Node 16+, which the catch below handles for the cases
  // that matter for validation.
  stream.on('error', () => {})
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  let firstLine: string | undefined
  try {
    for await (const line of rl) {
      firstLine = line
      break
    }
  } catch {
    return null
  } finally {
    rl.close()
    stream.destroy()
  }
  if (!firstLine || !firstLine.trim()) return null
  try {
    return JSON.parse(firstLine) as CodexEntry
  } catch {
    return null
  }
}

// Validation is STRUCTURAL, never string-matching on `payload.originator`.
// `originator` is a free-form CLIENT IDENTITY string, not a format marker: any
// tool driving `codex app-server` writes structurally identical rollouts under
// ~/.codex/sessions with its own value ("codex-tui", "Codex Desktop",
// "t3code_desktop", "JetBrains.IntelliJ IDEA", ...). Gating on the spelling
// silently dropped every third-party frontend and needed a new allowlist entry
// per client (issues #626, #873).
//
// A `session_meta` first line with a well-formed payload object is signal
// enough: the walker only visits `rollout-*.jsonl` under the strict
// YYYY/MM/DD path or `archived_sessions/`, and codex.ts is the only provider
// that reads ~/.codex, so directory ownership — not originator content —
// decides the provider. Genuinely foreign files (wrong entry type, missing or
// non-object payload, malformed JSON) are still rejected.
async function isValidCodexSession(filePath: string): Promise<{ valid: boolean; meta?: CodexEntry }> {
  const entry = await readFirstLine(filePath)
  if (!entry) return { valid: false }
  // `entry` comes from an unchecked JSON.parse cast, so re-check the payload
  // shape at runtime instead of trusting the declared type.
  const payload: unknown = entry.payload
  const valid = entry.type === 'session_meta' &&
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload)
  return { valid, meta: valid ? entry : undefined }
}

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
      else if (byte === 0x5c) escaped = true // \\
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
    cache_write_input_tokens: getRawJsonNumberField(body, 'cache_write_input_tokens'),
    output_tokens: getRawJsonNumberField(body, 'output_tokens'),
    reasoning_output_tokens: getRawJsonNumberField(body, 'reasoning_output_tokens'),
    total_tokens: getRawJsonNumberField(body, 'total_tokens'),
  }
}

function payloadHead(head: string): string {
  const idx = head.indexOf('"payload"')
  return idx === -1 ? head : head.slice(idx)
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

function parseCodexLine(line: string | Buffer): CodexEntry | null {
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
  // session_meta can embed same-name keys under base_instructions /
  // dynamic_tools (including provenance.model). A depth-agnostic scan of the
  // compact head steals the first nested hit and can overwrite turn_context.
  // Restrict every session_meta string field to payload depth 1. Other event
  // types keep the cheap first-match scan.
  const payloadString = (field: string): string | undefined =>
    type === 'session_meta'
      ? getRawJsonStringField(getRawPayloadFieldWindow(line, field) ?? '', field)
      : getRawJsonStringField(pHead, field)
  const compactModel = payloadString('model')
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
      cwd: payloadString('cwd'),
      model_provider: payloadString('model_provider'),
      originator: payloadString('originator'),
      session_id: payloadString('session_id'),
      forked_from_id: payloadString('forked_from_id'),
      model: compactModel,
      name: payloadString('name'),
      invocation,
      call_id: getRawJsonStringField(pHead, 'call_id'),
      turn_id: getRawJsonStringField(pHead, 'turn_id'),
      // On mcp_tool_call_end a coincidental `duration_ms` inside the large
      // invocation.arguments object can shadow the payload-level duration, so the
      // depth-aware value wins. The naive scan stays as the fallback for
      // task_complete, which records duration_ms at the payload level directly.
      duration_ms: timingDuration ?? timingNumber('duration_ms'),
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

async function discoverSessionFile(filePath: string): Promise<SessionSource | null> {
  const s = await stat(filePath).catch(() => null)
  if (!s?.isFile()) return null

  // Fast path: cached results already know the project, so avoid opening the
  // file. This keeps discovery cheap on large session directories.
  const cachedProject = await getCachedCodexProject(filePath)
  if (cachedProject) {
    return { path: filePath, project: cachedProject, provider: 'codex' }
  }

  const { valid, meta } = await isValidCodexSession(filePath)
  if (!valid || !meta) return null

  // Same unchecked-cast caveat as the payload check above: `cwd` is declared
  // `string` but comes straight off JSON.parse. A rollout carrying a number,
  // object or array here would throw out of sanitizeProject, escape
  // discoverSessions, and make safeDiscoverSessions return [] for the WHOLE
  // codex provider — every Codex report reading zero because of one bad file.
  const rawCwd: unknown = meta.payload?.cwd
  const cwd = typeof rawCwd === 'string' && rawCwd ? rawCwd : 'unknown'
  return { path: filePath, project: sanitizeProject(cwd), provider: 'codex' }
}

async function discoverSessionsInDir(codexDir: string): Promise<SessionSource[]> {
  const sources: SessionSource[] = []
  // Codex archives a session by moving it from sessions/YYYY/MM/DD/ to
  // archived_sessions/, keeping the same basename. Deduplicate by basename so
  // a session does not appear twice while it exists in both roots. This avoids
  // reading every file to extract session_id and preserves the cheap cached
  // fast path.
  const seenBasenames = new Set<string>()
  const sessionsDir = join(codexDir, 'sessions')

  const years = await readdir(sessionsDir).catch(() => [] as string[])

  for (const year of years) {
    if (!/^\d{4}$/.test(year)) continue
    const yearDir = join(sessionsDir, year)
    const months = await readdir(yearDir).catch(() => [] as string[])

    for (const month of months) {
      if (!/^\d{2}$/.test(month)) continue
      const monthDir = join(yearDir, month)
      const days = await readdir(monthDir).catch(() => [] as string[])

      for (const day of days) {
        if (!/^\d{2}$/.test(day)) continue
        const dayDir = join(monthDir, day)
        const files = await readdir(dayDir).catch(() => [] as string[])

        for (const file of files) {
          if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue
          if (seenBasenames.has(file)) continue
          seenBasenames.add(file)
          const source = await discoverSessionFile(join(dayDir, file))
          if (source) sources.push(source)
        }
      }
    }
  }

  // Codex moves archived sessions into a flat directory. Keep them in usage
  // reports so archiving a conversation does not erase its historical usage.
  // Call-level deduplication (seenKeys) already collapses any remaining
  // archived copies, while basename dedup above prevents double discovery.
  const archivedDir = join(codexDir, 'archived_sessions')
  const archivedFiles = await readdir(archivedDir).catch(() => [] as string[])
  for (const file of archivedFiles) {
    if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue
    if (seenBasenames.has(file)) continue
    seenBasenames.add(file)
    const source = await discoverSessionFile(join(archivedDir, file))
    if (source) sources.push(source)
  }

  return sources
}

// The model fields come off an unchecked JSON.parse cast, so a third-party
// rollout can carry a non-string `model`. It flows straight into calculateCost,
// which calls `.replace()` on it, so pick the first genuine string and never let
// a number/object/array through.
function firstModelString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

function resolveModel(info: CodexEntry['payload'], sessionModel?: string): string {
  return firstModelString(info?.model, info?.info?.model, info?.info?.model_name, sessionModel) ?? 'gpt-5'
}

// Everything the single-pass decode carries across a `task_started` boundary.
// A rollout is append-only, so recording this at such a boundary (where the
// previous task has been flushed to `results` and the per-task accumulators are
// empty) lets a later run restart there and produce byte-identical output
// instead of re-reading the whole file. Every field the loop below reads from a
// PRIOR line must appear here, or a resumed decode silently diverges.
type CodexResumeState = {
  sessionModel?: string
  sessionId: string
  sessionCwd?: string
  forkedFromId: string
  forkCutoff: string
  prevCumulativeTotal: number | null
  prevInput: number
  prevCached: number
  prevCacheWrite: number
  prevOutput: number
  prevReasoning: number
  pendingTools: string[]
  pendingToolSequence: ToolCall[][]
  pendingUserMessage: string
  pendingOutputChars: number
  pendingLocAdded: number
  pendingLocRemoved: number
  pendingEditFailed: number
  estCounter: number
  turnCounter: number
  currentTurnId: string
  taskStartedAt?: number
  // #1088 BUG-1: timestamp of the first request-context event (turn_context,
  // world_state, event_msg/user_message, or response_item/message) seen since
  // the last task_started. Codex fires task_started before it assembles the
  // request, so the gap up to this event is CLI/harness startup, not model
  // wait -- the active window for Tok/s starts here, not at task_started.
  taskActiveStartedAt?: number
}

// The state comes back off our own JSON cache; a truncated or hand-edited file
// must fall back to a full re-parse rather than decode against nonsense.
function isResumeState(value: unknown): value is CodexResumeState {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v['sessionId'] === 'string'
    && typeof v['forkedFromId'] === 'string'
    && typeof v['forkCutoff'] === 'string'
    && (v['prevCumulativeTotal'] === null || typeof v['prevCumulativeTotal'] === 'number')
    && typeof v['prevInput'] === 'number'
    && typeof v['prevCached'] === 'number'
    && typeof v['prevCacheWrite'] === 'number'
    && typeof v['prevOutput'] === 'number'
    && typeof v['prevReasoning'] === 'number'
    && Array.isArray(v['pendingTools'])
    && Array.isArray(v['pendingToolSequence'])
    && typeof v['pendingUserMessage'] === 'string'
    && typeof v['pendingOutputChars'] === 'number'
    && typeof v['pendingLocAdded'] === 'number'
    && typeof v['pendingLocRemoved'] === 'number'
    && typeof v['pendingEditFailed'] === 'number'
    && typeof v['estCounter'] === 'number'
    && typeof v['turnCounter'] === 'number'
    && typeof v['currentTurnId'] === 'string'
}

/** What the serial path would have written to the codex cache for one file. */
export type CodexCacheWrite = {
  project: string
  fingerprint: CodexFileFingerprint
  resume?: { offset: number; state: unknown; callCount: number }
}

// When `capture` is passed the parse is a whole-file decode that never touches
// the codex cache: no hit lookup (so no resume), and the entry it would have
// written comes back through `capture` for the caller to install. That is what
// lets a worker thread run this exact decode without owning the cache module's
// per-directory state.
function createParser(source: SessionSource, seenKeys: Set<string>, capture?: { write?: CodexCacheWrite }): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const hit = capture ? null : await readCachedCodexResults(source.path)
      if (hit?.kind === 'exact') {
        for (const call of hit.calls) {
          if (seenKeys.has(call.deduplicationKey)) continue
          seenKeys.add(call.deduplicationKey)
          yield call
        }
        return
      }
      const resume = hit && isResumeState(hit.state)
        ? { offset: hit.offset, state: hit.state, calls: hit.calls.slice(0, hit.callCount) }
        : null

      const fp = await fingerprintFile(source.path)
      if (!fp) return

      let sessionModel: string | undefined = resume?.state.sessionModel
      let sessionId = resume?.state.sessionId ?? ''
      let sessionCwd: string | undefined = resume?.state.sessionCwd
      let forkedFromId = resume?.state.forkedFromId ?? ''
      let forkCutoff = resume?.state.forkCutoff ?? ''
      // Null sentinel rather than `0` so the FIRST event is never confused
      // with a duplicate. A session that only emits last_token_usage (no
      // total_token_usage) reports cumulativeTotal=0 on every event; with a
      // 0-initialized prev, the first event would have matched and been
      // dropped. Once we've observed any event, we record its cumulative
      // total and dedup on equality regardless of whether it is zero.
      let prevCumulativeTotal: number | null = resume?.state.prevCumulativeTotal ?? null
      let prevInput = resume?.state.prevInput ?? 0
      let prevCached = resume?.state.prevCached ?? 0
      let prevCacheWrite = resume?.state.prevCacheWrite ?? 0
      let prevOutput = resume?.state.prevOutput ?? 0
      let prevReasoning = resume?.state.prevReasoning ?? 0
      let pendingTools: string[] = resume ? [...resume.state.pendingTools] : []
      let pendingToolSequence: ToolCall[][] = resume ? [...resume.state.pendingToolSequence] : []
      let pendingUserMessage = resume?.state.pendingUserMessage ?? ''
      let pendingOutputChars = resume?.state.pendingOutputChars ?? 0
      // Rich-session-capture: edit LOC deltas and failed-patch count accumulated
      // across a turn's patch_apply_end events, flushed onto the turn's call.
      let pendingLocAdded = resume?.state.pendingLocAdded ?? 0
      let pendingLocRemoved = resume?.state.pendingLocRemoved ?? 0
      let pendingEditFailed = resume?.state.pendingEditFailed ?? 0
      let estCounter = resume?.state.estCounter ?? 0
      let turnCounter = resume?.state.turnCounter ?? 0
      let currentTurnId = resume?.state.currentTurnId ?? `${sessionId}:t0`
      let sawAnyLine = false
      const results: ParsedProviderCall[] = []
      // Calls already decoded before the resume boundary. They pass through the
      // same cross-provider dedup a full decode would have applied to them.
      if (resume) {
        for (const call of resume.calls) {
          if (seenKeys.has(call.deduplicationKey)) continue
          seenKeys.add(call.deduplicationKey)
          results.push(call)
        }
      }
      // Calls decoded since the last task_started, held back so task_complete can
      // stamp active/toolWait timing before they are appended to results. Emitting
      // a task only once its timing is known keeps single-pass and split/resume
      // decodes in agreement instead of back-patching already-emitted calls.
      // Bounded by one task's calls; flushed at the next task_started and at EOF.
      let pendingTaskCalls: ParsedProviderCall[] = []
      let taskGeneratedTokens = 0
      let taskToolIntervals: Array<[number, number]> = []
      let taskStartedAt: number | undefined = resume?.state.taskStartedAt
      let taskActiveStartedAt: number | undefined = resume?.state.taskActiveStartedAt
      const openToolStarts = new Map<string, number>()

      // Resume point for the NEXT run, refreshed at every task boundary.
      const tracker = { lastCompleteLineOffset: resume?.offset ?? 0 }
      let resumeOffset = resume?.offset ?? 0
      let resumeState: CodexResumeState | null = resume?.state ?? null
      let resumeCallCount = results.length

      // Stream the session file line by line. Heavy Codex sessions can exceed
      // 250 MB on disk; reading the entire file into a string would either hit
      // the readSessionFile cap or push V8 toward its 512 MB string limit
      // after split('\n'). readSessionLines streams raw buffers and hands
      // huge lines to the compact parser without full string conversion.
      for await (const rawLine of readSessionLines(source.path, undefined, {
        largeLineAsBuffer: true,
        byteOffsetTracker: tracker,
        ...(resume ? { startByteOffset: resume.offset } : {}),
      })) {
        sawAnyLine = true
        const entry = parseCodexLine(rawLine)
        if (!entry) continue

        if (entry.type === 'session_meta') {
          sessionId = entry.payload?.session_id ?? basename(source.path, '.jsonl')
          // Guarded for the same reason as discoverSessionFile: parseCodexLine
          // hands back an unchecked JSON.parse cast, and a non-string cwd would
          // ride into projectPath/workingDirectory where the parser's path
          // helpers (normalizeProjectPathKey, resolveCanonicalProjectPath) call
          // string methods on it.
          const rawSessionCwd: unknown = entry.payload?.cwd
          if (typeof rawSessionCwd === 'string' && rawSessionCwd) sessionCwd = rawSessionCwd
          forkedFromId = entry.payload?.forked_from_id ?? ''
          if (forkedFromId && entry.timestamp) {
            // An unparseable timestamp (a garbage string, or a non-string from
            // the unchecked JSON.parse cast) makes `new Date(NaN).toISOString()`
            // throw RangeError, which would sink this whole session to zero.
            const forkBaseMs = new Date(entry.timestamp).getTime()
            if (Number.isFinite(forkBaseMs)) forkCutoff = new Date(forkBaseMs + 5000).toISOString()
          }
          if (typeof entry.payload?.model === 'string') sessionModel = entry.payload.model
          continue
        }

        // #1088 BUG-1: the first request-context event since task_started marks
        // where model-request assembly actually began. Checked before any of
        // these types `continue` below, and unconditionally (like turn_context's
        // model capture above) so a forked replay's own request-context events
        // still mark it -- matching how those events are already read regardless
        // of isForkReplay, which only filters task boundaries and tool events.
        if (taskActiveStartedAt === undefined && (
          entry.type === 'turn_context'
          || entry.type === 'world_state'
          || (entry.type === 'event_msg' && entry.payload?.type === 'user_message')
          || (entry.type === 'response_item' && entry.payload?.type === 'message')
        )) {
          const ctxAt = entry.timestamp ? Date.parse(entry.timestamp) : NaN
          if (Number.isFinite(ctxAt)) taskActiveStartedAt = ctxAt
        }

        if (entry.type === 'turn_context' && typeof entry.payload?.model === 'string') {
          sessionModel = entry.payload.model
          continue
        }

        const isForkReplay = Boolean(forkCutoff && entry.timestamp && entry.timestamp < forkCutoff)
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
          // Emit the previous task. If it never reached task_complete its timing
          // fields simply stay unset, matching the un-buffered behaviour.
          results.push(...pendingTaskCalls)
          pendingTaskCalls = []
          taskGeneratedTokens = 0
          taskToolIntervals = []
          const startedAt = entry.timestamp ? Date.parse(entry.timestamp) : NaN
          taskStartedAt = Number.isFinite(startedAt) ? startedAt : undefined
          taskActiveStartedAt = undefined
          openToolStarts.clear()
          // Everything decoded so far is now in `results` and the per-task
          // accumulators are empty: a clean restart point for an appended tail.
          resumeOffset = tracker.lastCompleteLineOffset
          resumeCallCount = results.length
          resumeState = {
            ...(sessionModel !== undefined ? { sessionModel } : {}),
            sessionId,
            ...(sessionCwd !== undefined ? { sessionCwd } : {}),
            forkedFromId,
            forkCutoff,
            prevCumulativeTotal,
            prevInput,
            prevCached,
            prevCacheWrite,
            prevOutput,
            prevReasoning,
            pendingTools: [...pendingTools],
            pendingToolSequence: [...pendingToolSequence],
            pendingUserMessage,
            pendingOutputChars,
            pendingLocAdded,
            pendingLocRemoved,
            pendingEditFailed,
            estCounter,
            turnCounter,
            currentTurnId,
            ...(taskStartedAt !== undefined ? { taskStartedAt } : {}),
            ...(taskActiveStartedAt !== undefined ? { taskActiveStartedAt } : {}),
          }
          continue
        }

        if (entry.type === 'response_item' && (entry.payload?.type === 'function_call' || entry.payload?.type === 'custom_tool_call')) {
          const rawName = entry.payload.name ?? ''
          const mapped = toolNameMap[rawName] ?? rawName
          pendingTools.push(mapped)
          const call: ToolCall = { tool: mapped }
          const rawArgs = (entry.payload as Record<string, unknown>)['arguments']
          const args = typeof rawArgs === 'string'
            ? (() => { try { return JSON.parse(rawArgs) as Record<string, unknown> } catch { return null } })()
            : typeof rawArgs === 'object' && rawArgs ? rawArgs as Record<string, unknown> : null
          if (args) {
            const fp = args['file_path'] ?? args['path']
            if (typeof fp === 'string') call.file = fp
            const cmd = args['command'] ?? args['cmd']
            if (typeof cmd === 'string') call.command = cmd
            // Attribute a CLI-wrapped MCP call (e.g. `mcp-cli call server tool`)
            // to the MCP breakdown too; the exec still counts as Bash above.
            const mcpTool = mcpToolFromShellCommand(cmd)
            if (mcpTool) {
              pendingTools.push(mcpTool)
              pendingToolSequence.push([{ tool: mcpTool }])
            }
          }
          const callId = entry.payload.call_id
          const started = entry.timestamp ? Date.parse(entry.timestamp) : NaN
          if (callId && Number.isFinite(started)) openToolStarts.set(callId, started)
          pendingToolSequence.push([call])
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

        if (entry.type === 'event_msg' && entry.payload?.type === 'task_complete') {
          // #1088 BUG-8: task_complete's duration can arrive as {secs,nanos} or
          // a string too (mcp_tool_call_end already tolerates both, below, via
          // this same durationValueMs helper); read it the same permissive way
          // instead of only the plain-number `duration_ms` field.
          const durationMs = durationValueMs(entry.payload.duration_ms) ?? durationValueMs(entry.payload.duration)
          if (typeof durationMs === 'number' && durationMs > 0 && taskGeneratedTokens > 0 && pendingTaskCalls.length > 0) {
            const completedAt = entry.timestamp ? Date.parse(entry.timestamp) : NaN
            // #1088 BUG-1: Codex fires task_started before it assembles the
            // request, so the gap up to the first request-context event is
            // CLI/harness startup, not model wait. The active window starts
            // there instead of at task_started; task completion (windowEnd,
            // inside mergeToolIntervals) is unchanged.
            const activeWindowStart = taskActiveStartedAt ?? taskStartedAt
            const startupGapMs = activeWindowStart !== undefined && taskStartedAt !== undefined
              ? activeWindowStart - taskStartedAt
              : 0
            const effectiveDurationMs = Math.max(0, durationMs - startupGapMs)
            // #1088 BUG-8: shared with codex-throughput.ts's live estimate
            // instead of a second inline copy of the same clip/merge/cap.
            const toolWaitMs = mergeToolIntervals(taskToolIntervals, effectiveDurationMs, activeWindowStart, Number.isFinite(completedAt) ? completedAt : undefined)
            const activeMs = effectiveDurationMs - toolWaitMs
            if (activeMs <= 0) continue
            for (const call of pendingTaskCalls) {
              // Reasoning is already inside output_tokens (#1075/#1078); the
              // throughput numerator must agree with the cost numerator or
              // Tok/s reads high for reasoning-heavy calls (#1079).
              const generated = billableOutputTokens('codex', call.outputTokens, call.reasoningTokens)
              if (generated <= 0) continue
              call.activeGeneratedTokens = generated
              call.activeDurationMs = activeMs * (generated / taskGeneratedTokens)
              call.toolWaitMs = toolWaitMs * (generated / taskGeneratedTokens)
            }
          }
          continue
        }

        if (entry.type === 'event_msg' && entry.payload?.type === 'patch_apply_end') {
          pendingTools.push('Edit')
          const p = entry.payload as Record<string, unknown>
          const changes = p['changes']
          const changesObj = typeof changes === 'object' && changes ? changes as Record<string, unknown> : {}
          const filePaths = Object.keys(changesObj)
          if (filePaths.length > 0) {
            for (const fp of filePaths) {
              pendingToolSequence.push([{ tool: 'Edit', file: fp }])
              const diff = (changesObj[fp] as Record<string, unknown> | undefined)?.['unified_diff']
              const loc = countUnifiedDiffLoc(diff)
              pendingLocAdded += loc.added
              pendingLocRemoved += loc.removed
            }
          } else {
            pendingToolSequence.push([{ tool: 'Edit' }])
          }
          // Only an explicit failure counts; a missing `success` is treated as ok.
          if (p['success'] === false) pendingEditFailed++
          continue
        }

        // Recent Codex emits MCP calls as `event_msg`/`mcp_tool_call_end`
        // instead of a `function_call` response_item, so the call was never
        // attributed. Rebuild the canonical `mcp__<server>__<tool>` name the
        // classifier recognizes.
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
            pendingTools.push(name)
            pendingToolSequence.push([{ tool: name }])
          }
          continue
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload?.role === 'user') {
          const texts = normalizeContentBlocks(entry.payload.content)
            .filter(c => c.type === 'input_text')
            .map(c => c.text ?? '')
            .filter(Boolean)
          if (texts.length > 0) {
            pendingUserMessage = texts.join(' ').slice(0, 500)
            currentTurnId = `${sessionId}:t${++turnCounter}`
          }
          continue
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload?.role === 'assistant') {
          const texts = normalizeContentBlocks(entry.payload.content)
            .filter(c => c.type === 'output_text' || c.type === 'text')
            .map(c => c.text ?? '')
          pendingOutputChars += texts.join('').length
          continue
        }

        if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
          // Forked sessions replay the parent's entire event history with
          // timestamps clustered at the fork creation time. Skip replayed
          // events (within 5s of fork) to avoid double-counting.
          if (forkCutoff && entry.timestamp && entry.timestamp < forkCutoff) continue
          const info = entry.payload.info
          if (!info) {
            if (pendingOutputChars === 0 && pendingUserMessage.length === 0) continue
            const estInput = estimateTokensFromChars(pendingUserMessage.length)
            const estOutput = estimateTokensFromChars(pendingOutputChars)
            if (estInput === 0 && estOutput === 0) continue

            const model = sessionModel ?? 'gpt-5'
            const timestamp = entry.timestamp ?? ''
            const dedupKey = `codex:${sessionId}:${timestamp}:est${estCounter++}`

            if (seenKeys.has(dedupKey)) { pendingTools = []; pendingToolSequence = []; pendingUserMessage = ''; pendingOutputChars = 0; pendingLocAdded = 0; pendingLocRemoved = 0; pendingEditFailed = 0; continue }
            seenKeys.add(dedupKey)

            const costUSD = calculateCost(model, estInput, estOutput, 0, 0, 0)

            pendingTaskCalls.push({
              provider: 'codex',
              model,
              inputTokens: estInput,
              outputTokens: estOutput,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
              cachedInputTokens: 0,
              reasoningTokens: 0,
              webSearchRequests: 0,
              costUSD,
              costIsEstimated: true,
              tools: pendingTools,
              bashCommands: [],
              timestamp,
              speed: 'standard',
              deduplicationKey: dedupKey,
              turnId: currentTurnId,
              toolSequence: pendingToolSequence.length > 0 ? pendingToolSequence : undefined,
              userMessage: pendingUserMessage,
              sessionId,
              ...(sessionCwd ? { projectPath: sessionCwd, workingDirectory: sessionCwd } : {}),
              ...(pendingLocAdded ? { locAdded: pendingLocAdded } : {}),
              ...(pendingLocRemoved ? { locRemoved: pendingLocRemoved } : {}),
              ...(pendingEditFailed ? { editFailed: pendingEditFailed } : {}),
            })
            taskGeneratedTokens += estOutput

            pendingTools = []
            pendingToolSequence = []
            pendingUserMessage = ''
            pendingOutputChars = 0
            pendingLocAdded = 0
            pendingLocRemoved = 0
            pendingEditFailed = 0
            continue
          }

          const cumulativeTotal = info.total_token_usage?.total_tokens ?? 0
          // Dedup guard. Two consecutive events with cumulativeTotal=0 but
          // non-empty last_token_usage would have been double-counted with
          // the previous `> 0` clause. The null sentinel ensures the FIRST
          // event always passes (so a session that never reports cumulative
          // doesn't lose its opening turn).
          if (prevCumulativeTotal !== null && cumulativeTotal === prevCumulativeTotal) continue
          prevCumulativeTotal = cumulativeTotal

          const last = info.last_token_usage
          let inputTokens = 0
          let cachedInputTokens = 0
          let cacheWriteTokens = 0
          let outputTokens = 0
          let reasoningTokens = 0

          if (last) {
            inputTokens = last.input_tokens ?? 0
            cachedInputTokens = last.cached_input_tokens ?? 0
            cacheWriteTokens = last.cache_write_input_tokens ?? 0
            outputTokens = last.output_tokens ?? 0
            reasoningTokens = last.reasoning_output_tokens ?? 0
          } else if (cumulativeTotal > 0) {
            const total = info.total_token_usage
            if (!total) continue
            inputTokens = (total.input_tokens ?? 0) - prevInput
            cachedInputTokens = (total.cached_input_tokens ?? 0) - prevCached
            cacheWriteTokens = (total.cache_write_input_tokens ?? 0) - prevCacheWrite
            outputTokens = (total.output_tokens ?? 0) - prevOutput
            reasoningTokens = (total.reasoning_output_tokens ?? 0) - prevReasoning
          }

          // Always advance the prev counters to track the cumulative state.
          // Previously prev was only updated on the fallback branch, so a
          // session with mixed last_token_usage / no-last events would
          // compute the next fallback delta against a stale prev=0 baseline,
          // double-counting the entire cumulative window. The prev value
          // must mirror what cumulative reports regardless of whether this
          // event used `last` or fell back to deltas.
          const total = info.total_token_usage
          if (total) {
            prevInput = total.input_tokens ?? 0
            prevCached = total.cached_input_tokens ?? 0
            prevCacheWrite = total.cache_write_input_tokens ?? 0
            prevOutput = total.output_tokens ?? 0
            prevReasoning = total.reasoning_output_tokens ?? 0
          }

          const totalTokens = inputTokens + cachedInputTokens + outputTokens + reasoningTokens
          if (totalTokens === 0) continue

          // OpenAI includes cached tokens inside input_tokens; Anthropic does not.
          // Normalize to Anthropic semantics: inputTokens = non-cached only.
          const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens)

          // Cache writes are carved out of the uncached input, never added to
          // it: clamp so a malformed or lagging count can never drive the plain
          // input bucket negative.
          const cacheWriteInputTokens = Math.max(0, Math.min(cacheWriteTokens, uncachedInputTokens))

          const model = resolveModel(entry.payload, sessionModel)
          // Only move tokens into the cache-write bucket when the pricing
          // source publishes a real cache-write rate for this model (gpt-5.6+
          // charges 1.25x input; everything before it charges nothing extra).
          // Otherwise buildCosts' fabricated 1.25x default would invent a
          // surcharge that OpenAI never billed, so the tokens stay where they
          // already were -- in plain input, priced exactly as before.
          const billedCacheWriteTokens = cacheWriteInputTokens > 0 && getModelCosts(model)?.cacheWriteCostIsExplicit
            ? cacheWriteInputTokens
            : 0
          const billedInputTokens = uncachedInputTokens - billedCacheWriteTokens
          const timestamp = entry.timestamp ?? ''
          // Forked sessions copy the parent's entire token_count history
          // (re-timestamped), so replays must collide with the parent's events
          // and drop to avoid double-counting -- hence the parent namespace
          // (forkedFromId) and the deliberate omission of the per-session id.
          // But cumulativeTotal alone is too coarse a discriminator: a genuine
          // post-divergence fork event whose running total coincidentally equals
          // some parent total would also collide and be lost (undercount). So we
          // also key on the cumulative token breakdown, which a fork replays
          // verbatim from the parent -- a true replay collides exactly, while
          // genuinely different work at the same total stays distinct. We use the
          // CUMULATIVE figures (not the per-event deltas) on purpose: the deltas
          // are computed against a running `prev` that the fork advances
          // differently once the 5s cutoff skips some replays, so a delta-based
          // key would spuriously diverge on a replay and double-count it.
          const dedupKey = `codex:${forkedFromId || sessionId}:${cumulativeTotal}:${total?.input_tokens ?? 0}:${total?.cached_input_tokens ?? 0}:${total?.output_tokens ?? 0}:${total?.reasoning_output_tokens ?? 0}`

          // A drop here can only be a byte-identical replay: the
          // prevCumulativeTotal guard above already discards a repeated
          // running total, so nothing reaching this point ever loses real
          // tokens -- no active-time rescaling needed (#1088 investigation).
          if (seenKeys.has(dedupKey)) continue
          seenKeys.add(dedupKey)

          // Reasoning tokens are already inside output_tokens, so they are NOT
          // added here. The cache-rehydration twin of this line lives in
          // src/parser.ts (cachedCallToApiCall); both call billableOutputTokens
          // so a fresh parse and a cache read can never price differently.
          const costUSD = calculateCost(
            model,
            billedInputTokens,
            billableOutputTokens('codex', outputTokens, reasoningTokens),
            billedCacheWriteTokens,
            cachedInputTokens,
            0,
          )

          pendingTaskCalls.push({
            provider: 'codex',
            model,
            inputTokens: billedInputTokens,
            outputTokens,
            cacheCreationInputTokens: billedCacheWriteTokens,
            cacheReadInputTokens: cachedInputTokens,
            cachedInputTokens,
            reasoningTokens,
            webSearchRequests: 0,
            costUSD,
            tools: pendingTools,
            bashCommands: [],
            timestamp,
            speed: 'standard',
            deduplicationKey: dedupKey,
            turnId: currentTurnId,
            toolSequence: pendingToolSequence.length > 0 ? pendingToolSequence : undefined,
            userMessage: pendingUserMessage,
            sessionId,
            ...(sessionCwd ? { projectPath: sessionCwd, workingDirectory: sessionCwd } : {}),
            ...(pendingLocAdded ? { locAdded: pendingLocAdded } : {}),
            ...(pendingLocRemoved ? { locRemoved: pendingLocRemoved } : {}),
            ...(pendingEditFailed ? { editFailed: pendingEditFailed } : {}),
          })
          taskGeneratedTokens += billableOutputTokens('codex', outputTokens, reasoningTokens)

          pendingTools = []
          pendingToolSequence = []
          pendingUserMessage = ''
          pendingOutputChars = 0
          pendingLocAdded = 0
          pendingLocRemoved = 0
          pendingEditFailed = 0
        }
      }

      // If the stream yielded nothing the file was unreadable, oversized, or
      // empty. Skip cache write so a transient failure can't pin an empty
      // result set against a fingerprint that would otherwise be re-parsed. On a
      // resume the earlier calls are still valid output, so serve them - but
      // still leave the cache entry alone.
      if (!sawAnyLine) {
        if (resume) for (const call of results) yield call
        return
      }

      // Flush the final task, which has no following task_started to trigger it.
      results.push(...pendingTaskCalls)

      const resumeWrite = resumeState ? { offset: resumeOffset, state: resumeState, callCount: resumeCallCount } : undefined
      if (capture) {
        capture.write = { project: source.project, fingerprint: fp, ...(resumeWrite ? { resume: resumeWrite } : {}) }
      } else {
        await writeCachedCodexResults(source.path, source.project, results, fp, resumeWrite)
      }

      for (const call of results) {
        yield call
      }
    },
  }
}

export type CodexFullParse = { calls: ParsedProviderCall[]; write?: CodexCacheWrite }

/// Decode one rollout end to end, exactly as the serial path does for a file
/// with no cache entry, without reading or writing the codex cache. `seenKeys`
/// is the dedup set the decode runs against — pass an empty one off-thread and
/// let the caller prove no earlier file claimed any of the keys before
/// installing the result.
export async function parseCodexFileFull(source: SessionSource, seenKeys: Set<string>): Promise<CodexFullParse> {
  const capture: { write?: CodexCacheWrite } = {}
  const calls: ParsedProviderCall[] = []
  for await (const call of createParser(source, seenKeys, capture).parse()) calls.push(call)
  return { calls, ...(capture.write ? { write: capture.write } : {}) }
}

export function createCodexProvider(codexDir?: string): Provider {
  const dir = getCodexDir(codexDir)
  // An explicit dir means "scan exactly this" (tests, callers with a fixture).
  // Otherwise add every WSL home's ~/.codex as an extra root (#1059); empty
  // off-win32. Discovery runs per-root so its basename dedup — which collapses
  // a session archived out of sessions/ — never merges two distros. Resolved
  // lazily: `codex` is constructed at import, and WSL probing spawns wsl.exe.
  const codexDirs = (): string[] =>
    codexDir ? [dir] : [...new Set([dir, ...wslHomes().map(home => join(home, '.codex'))])]

  return {
    name: 'codex',
    displayName: 'Codex',

    modelDisplayName(model: string): string {
      for (const [key, name] of modelDisplayEntries) {
        if (model === key || model.startsWith(key + '-')) return name
      }
      return model
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    // The same dirs discoverSessionsInDir walks: <codexDir>/sessions (dated
    // rollout files) and <codexDir>/archived_sessions. Honors CODEX_HOME.
    async probeRoots(): Promise<ProbeRoot[]> {
      return codexDirs().flatMap(d => [
        { path: join(d, 'sessions'), label: 'sessions' },
        { path: join(d, 'archived_sessions'), label: 'archived' },
      ])
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const perDir = await Promise.all(codexDirs().map(d => discoverSessionsInDir(d)))
      return perDir.flat()
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const codex = createCodexProvider()
