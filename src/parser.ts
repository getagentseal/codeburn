import { existsSync } from 'fs'
import { lstat, readFile, readdir, stat } from 'fs/promises'
import { basename, dirname, join, resolve, sep } from 'path'
import { readSessionLines } from './fs-utils.js'
import { calculateCost, calculateLocalModelSavings, getShortModelName, isProxiedPath, getProxyPathsConfigHash } from './models.js'
import { resolveSubagentAttribution, sessionIdentity } from './sessions-report.js'
import { normalizeContentBlocks } from './content-utils.js'
import { discoverAllSessions, getProvider } from './providers/index.js'
import { flushCodexCache } from './codex-cache.js'
import { antigravityCascadeIdFromPath, flushAntigravityCache, shouldReparseAntigravitySource } from './providers/antigravity.js'
import { getDesktopSessionsDir } from './providers/claude.js'
import { isSqliteBusyError } from './sqlite.js'
import {
  type CachedCall,
  type CachedFile,
  type CachedTurn,
  type ProviderSection,
  type SessionCache,
  beginColdHydration,
  cleanupOrphanedTempFiles,
  computeEnvFingerprint,
  DURABLE_PROVIDER_NAMES,
  fingerprintFile,
  isCacheComplete,
  loadCache,
  reconcileFile,
  saveCache,
} from './session-cache.js'
import { acquireCacheRefreshLock, type RefreshLockHandle } from './cache-refresh-lock.js'
import type { ParsedProviderCall, SessionSource } from './providers/types.js'
import type {
  ApiUsageIteration,
  AssistantMessageContent,
  ClassifiedTurn,
  ContentBlock,
  DateRange,
  JournalEntry,
  ParsedApiCall,
  ParsedTurn,
  ProjectSummary,
  SessionSummary,
  SessionSourceMetadata,
  TokenUsage,
  ToolCall,
  ToolUseBlock,
} from './types.js'
import { classifyTurn, BASH_TOOLS, EDIT_TOOLS } from './classifier.js'
import { extractBashCommands } from './bash-utils.js'

function unsanitizePath(dirName: string): string {
  return dirName.replace(/-/g, '/')
}

function claudeSlugFallbackPath(dirName: string): string {
  // Claude project directory names are lossy: a dash may be either a path
  // separator from the original cwd or a literal dash in the leaf name.
  // Without cwd metadata, keep the slug intact instead of inventing segments.
  return dirName
}

function normalizeProjectPathKey(projectPath: string): string {
  const normalized = projectPath.trim().replace(/\\/g, '/')
  return (normalized.replace(/\/+$/, '') || normalized).toLowerCase()
}

function projectNameFromPath(projectPath: string, fallback: string): string {
  const normalized = projectPath.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.split('/').filter(Boolean).pop() ?? fallback
}


// Returns true for sessions whose canonical project key must NOT be derived
// from the cwd. Cowork sessions come in two flavours:
//   1. Local-mode: cwd is an ephemeral per-session outputs/ dir inside the
//      desktop sessions directory (detected by checking the cwd).
//   2. Container-mode: the session runs inside a Docker container so cwd is
//      something like /sessions/<adjective-name> — not a real path on the host.
//      We detect these by checking the JSONL file path instead: if the file
//      lives inside the desktop sessions directory, the cwd is container-local
//      and must not become the canonical project key.
// In both cases the grouping key comes from the Cowork space name resolved in
// claude.ts::discoverSessions().
function isCoworkSession(cwd: string, filePath: string): boolean {
  const base = resolve(getDesktopSessionsDir())
  const inBase = (p: string) => p.startsWith(base + sep) || p.startsWith(base + '/')
  return inBase(resolve(cwd)) || inBase(resolve(filePath))
}

async function resolveCanonicalProjectPath(cwd: string): Promise<{ path: string; isWorktree: boolean }> {
  const trimmed = cwd.trim()
  if (!trimmed) return { path: cwd, isWorktree: false }

  // Walk up the directory tree to find a real git worktree marker. Ordinary
  // repos use a .git directory; linked worktrees use a .git file pointing back
  // to <main>/.git/worktrees/<name>. Only the latter should canonicalize to
  // the main repo. A parent directory with a stray .git directory must not
  // absorb sibling projects.
  // Guard against foreign paths (e.g. a Windows path recorded on a machine
  // that now runs macOS): only walk paths that look like absolute paths on the
  // current platform. A relative or foreign-format path cannot be walked on
  // the current filesystem without risking false positives.
  const isAbsoluteOnCurrentPlatform = process.platform === 'win32'
    ? /^[a-zA-Z]:[/\\]/.test(trimmed)
    : trimmed.startsWith('/')
  if (!isAbsoluteOnCurrentPlatform) return { path: cwd, isWorktree: false }

  let dir = trimmed
  while (true) {
    const gitEntry = join(dir, '.git')
    const entryStat = await lstat(gitEntry).catch(() => null)
    if (entryStat?.isDirectory()) {
      return { path: dir === trimmed ? dir : cwd, isWorktree: false }
    }
    if (entryStat?.isFile()) {
      const gitFile = await readFile(gitEntry, 'utf-8').catch(() => null)
      if (gitFile === null) return { path: dir === trimmed ? dir : cwd, isWorktree: false }
      const match = gitFile.match(/^gitdir:\s*(.+?)\s*$/m)
      if (!match?.[1]) return { path: dir === trimmed ? dir : cwd, isWorktree: false }
      const gitDir = resolve(dir, match[1])
      const normalizedGitDir = gitDir.replace(/\\/g, '/')
      const worktreeMarker = '/.git/worktrees/'
      const markerIndex = normalizedGitDir.lastIndexOf(worktreeMarker)
      if (markerIndex === -1) return { path: dir === trimmed ? dir : cwd, isWorktree: false }
      return { path: normalizedGitDir.slice(0, markerIndex), isWorktree: true }
    }
    const parent = dirname(dir)
    if (parent === dir) return { path: cwd, isWorktree: false }
    dir = parent
  }
}

const LARGE_JSONL_LINE_BYTES = 32 * 1024

export function parseJsonlLine(line: string | Buffer): JournalEntry | null {
  if (Buffer.isBuffer(line)) {
    if (line.length > LARGE_JSONL_LINE_BYTES) return parseLargeJsonl(line)
    try {
      return JSON.parse(line.toString('utf-8')) as JournalEntry
    } catch {
      return null
    }
  }
  if (line.length > LARGE_JSONL_LINE_BYTES) return parseLargeJsonl(line)
  try {
    return JSON.parse(line) as JournalEntry
  } catch {
    return null
  }
}

const RAW_HEAD_BYTES = 2048

type JsonValueBounds = {
  start: number
  end: number
  kind: 'string' | 'object' | 'array' | 'scalar'
}

type JsonIndexedSource = string | Buffer

type JsonSource = {
  readonly raw: JsonIndexedSource
  readonly length: number
  readonly slice: (start: number, end: number, maxChars?: number) => string
}

function isAsciiWhitespace(ch: number | undefined): boolean {
  return ch === 0x20 || ch === 0x0a || ch === 0x0d || ch === 0x09 || ch === 0x0b || ch === 0x0c
}

function isBufferWhitespaceAt(source: Buffer, index: number): boolean {
  const byte = source[index]
  if (isAsciiWhitespace(byte)) return true
  if (byte === undefined || byte < 0x80) return false

  let start = index
  while (start > 0) {
    const preceding = source[start]
    if (preceding === undefined || (preceding & 0xc0) !== 0x80) break
    start--
  }
  const first = source[start]
  if (first === undefined) return false
  let codePoint: number | undefined
  let byteLength = 0
  if (first >= 0xc2 && first <= 0xdf) {
    const second = source[start + 1]
    if (second === undefined || (second & 0xc0) !== 0x80) return false
    codePoint = ((first & 0x1f) << 6) | (second & 0x3f)
    byteLength = 2
  } else if (first >= 0xe0 && first <= 0xef) {
    const second = source[start + 1]
    const third = source[start + 2]
    if (second === undefined || third === undefined || (second & 0xc0) !== 0x80 || (third & 0xc0) !== 0x80) return false
    codePoint = ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f)
    byteLength = 3
  } else if (first >= 0xf0 && first <= 0xf4) {
    const second = source[start + 1]
    const third = source[start + 2]
    const fourth = source[start + 3]
    if (second === undefined || third === undefined || fourth === undefined || (second & 0xc0) !== 0x80 || (third & 0xc0) !== 0x80 || (fourth & 0xc0) !== 0x80) {
      return false
    }
    codePoint = ((first & 0x07) << 18) | ((second & 0x3f) << 12) | ((third & 0x3f) << 6) | (fourth & 0x3f)
    byteLength = 4
  }
  if (codePoint === undefined || index >= start + byteLength) return false
  return codePoint === 0x00a0 || codePoint === 0x1680 || (codePoint >= 0x2000 && codePoint <= 0x200a) || codePoint === 0x2028 || codePoint === 0x2029 || codePoint === 0x202f || codePoint === 0x205f || codePoint === 0x3000 || codePoint === 0xfeff
}

function safeBufferSegmentEnd(source: Buffer, index: number): number {
  while (index > 0 && ((source[index] ?? 0) & 0xc0) === 0x80) index--
  return index
}

function createJsonSource(source: string | Buffer): JsonSource {
  if (typeof source === 'string') {
    return {
      raw: source,
      length: source.length,
      slice: (start, end, maxChars = Number.POSITIVE_INFINITY) => source.slice(start, Math.min(end, start + maxChars)),
    }
  }

  return {
    raw: source,
    length: source.length,
    slice: (start, end, maxChars = Number.POSITIVE_INFINITY) => {
      const cappedEnd = Number.isFinite(maxChars) ? safeBufferSegmentEnd(source, Math.min(end, start + maxChars * 4)) : end
      return source.subarray(start, cappedEnd).toString('utf-8').slice(0, maxChars)
    },
  }
}

function jsonCharCodeAt(source: JsonSource, index: number): number {
  return typeof source.raw === 'string' ? source.raw.charCodeAt(index) : source.raw[index] ?? Number.NaN
}

function skipJsonWhitespace(source: JsonSource, start: number, limit = source.length): number {
  if (typeof source.raw === 'string') {
    let i = start
    while (i < limit && /\s/.test(source.raw[i]!)) i++
    return i
  }
  let i = start
  while (i < limit && isBufferWhitespaceAt(source.raw, i)) i++
  return i
}

function findJsonStringEnd(source: JsonSource, start: number, limit = source.length): number {
  return typeof source.raw === 'string'
    ? findJsonStringEndString(source.raw, start, limit)
    : findJsonStringEndBuffer(source.raw, start, limit)
}

function findJsonContainerEnd(source: JsonSource, start: number, open: number, close: number, limit = source.length): number {
  return typeof source.raw === 'string'
    ? findJsonContainerEndString(source.raw, start, open, close, limit)
    : findJsonContainerEndBuffer(source.raw, start, open, close, limit)
}

function findObjectFieldValue(source: JsonSource, objectStart: number, objectEnd: number, field: string): JsonValueBounds | null {
  return typeof source.raw === 'string'
    ? findObjectFieldValueString(source.raw, objectStart, objectEnd, field)
    : findObjectFieldValueBuffer(source.raw, objectStart, objectEnd, field)
}

function findJsonValueBounds(source: JsonSource, start: number, limit = source.length): JsonValueBounds | null {
  return typeof source.raw === 'string'
    ? findJsonValueBoundsString(source.raw, start, limit)
    : findJsonValueBoundsBuffer(source.raw, start, limit)
}

function readJsonString(source: JsonSource, bounds: JsonValueBounds | null, cap = Number.POSITIVE_INFINITY): string | undefined {
  if (typeof source.raw === 'string') return readJsonStringString(source.raw, bounds, cap)
  return readJsonStringBuffer(source.raw, bounds, cap)
}

function readJsonNumberField(source: JsonSource, objectBounds: JsonValueBounds | null, field: string): number | undefined {
  if (!objectBounds || objectBounds.kind !== 'object') return undefined
  const bounds = findObjectFieldValue(source, objectBounds.start, objectBounds.end, field)
  if (!bounds) return undefined
  const value = Number(source.slice(bounds.start, bounds.end))
  return Number.isFinite(value) ? value : undefined
}

// The large-line parsers avoid JSON.parse on the whole (multi-KB) line, but the
// usage object itself is tiny; parse just that slice to recover advisor
// (/advisor) iterations, which the byte-scanner cannot cheaply extract. Without
// this, an advisor escalation on a large assistant turn would be dropped.
function extractAdvisorIterations(usageObjectJson: string): ApiUsageIteration[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(usageObjectJson)
  } catch {
    return undefined
  }
  const iterations = (parsed as { iterations?: unknown }).iterations
  if (!Array.isArray(iterations)) return undefined
  const advisor = iterations.filter(
    (it): it is ApiUsageIteration =>
      !!it && typeof it === 'object' && (it as { type?: unknown }).type === 'advisor_message',
  )
  return advisor.length > 0 ? advisor : undefined
}

function parseLargeUsage(source: JsonSource, usageBounds: JsonValueBounds | null) {
  const usage: AssistantMessageContent['usage'] = {
    input_tokens: readJsonNumberField(source, usageBounds, 'input_tokens') ?? 0,
    output_tokens: readJsonNumberField(source, usageBounds, 'output_tokens') ?? 0,
    cache_creation_input_tokens: readJsonNumberField(source, usageBounds, 'cache_creation_input_tokens'),
    cache_read_input_tokens: readJsonNumberField(source, usageBounds, 'cache_read_input_tokens'),
  }

  if (usageBounds?.kind === 'object') {
    const cacheCreation = findObjectFieldValue(source, usageBounds.start, usageBounds.end, 'cache_creation')
    const ephemeral5m = readJsonNumberField(source, cacheCreation, 'ephemeral_5m_input_tokens')
    const ephemeral1h = readJsonNumberField(source, cacheCreation, 'ephemeral_1h_input_tokens')
    if (ephemeral5m !== undefined || ephemeral1h !== undefined) {
      ;(usage as AssistantMessageContent['usage']).cache_creation = {
        ...(ephemeral5m !== undefined ? { ephemeral_5m_input_tokens: ephemeral5m } : {}),
        ...(ephemeral1h !== undefined ? { ephemeral_1h_input_tokens: ephemeral1h } : {}),
      }
    }

    const serverToolUse = findObjectFieldValue(source, usageBounds.start, usageBounds.end, 'server_tool_use')
    const webSearch = readJsonNumberField(source, serverToolUse, 'web_search_requests')
    const webFetch = readJsonNumberField(source, serverToolUse, 'web_fetch_requests')
    if (webSearch !== undefined || webFetch !== undefined) {
      ;(usage as AssistantMessageContent['usage']).server_tool_use = {
        ...(webSearch !== undefined ? { web_search_requests: webSearch } : {}),
        ...(webFetch !== undefined ? { web_fetch_requests: webFetch } : {}),
      }
    }

    const speed = readJsonString(source, findObjectFieldValue(source, usageBounds.start, usageBounds.end, 'speed'))
    if (speed === 'standard' || speed === 'fast') usage.speed = speed

    const advisor = extractAdvisorIterations(source.slice(usageBounds.start, usageBounds.end))
    if (advisor) usage.iterations = advisor
  }

  return usage
}

function extractLargeToolBlocks(source: JsonSource, contentBounds: JsonValueBounds | null): ToolUseBlock[] {
  if (!contentBounds || contentBounds.kind !== 'array') return []
  const tools: ToolUseBlock[] = []
  let i = contentBounds.start + 1
  while (i < contentBounds.end - 1 && tools.length < MAX_TOOL_BLOCKS) {
    i = skipJsonWhitespace(source, i, contentBounds.end)
    if (jsonCharCodeAt(source, i) === 0x2c) {
      i++
      continue
    }
    if (jsonCharCodeAt(source, i) !== 0x7b) {
      i++
      continue
    }
    const objectEnd = findJsonContainerEnd(source, i, 0x7b, 0x7d, contentBounds.end)
    if (objectEnd === -1) break
    const objectBounds = { start: i, end: objectEnd + 1, kind: 'object' as const }
    const blockType = readJsonString(source, findObjectFieldValue(source, objectBounds.start, objectBounds.end, 'type'))
    if (blockType === 'tool_use') {
      const name = readJsonString(source, findObjectFieldValue(source, objectBounds.start, objectBounds.end, 'name')) ?? ''
      const id = readJsonString(source, findObjectFieldValue(source, objectBounds.start, objectBounds.end, 'id')) ?? ''
      const inputBounds = findObjectFieldValue(source, objectBounds.start, objectBounds.end, 'input')
      const input: Record<string, unknown> = {}
      if (inputBounds?.kind === 'object') {
        if (name === 'Skill') {
          const skill = readJsonString(source, findObjectFieldValue(source, inputBounds.start, inputBounds.end, 'skill'), 200)
          const skillName = readJsonString(source, findObjectFieldValue(source, inputBounds.start, inputBounds.end, 'name'), 200)
          if (skill !== undefined) input['skill'] = skill
          if (skillName !== undefined) input['name'] = skillName
        } else if (name === 'Read' || name === 'FileReadTool' || EDIT_TOOLS.has(name)) {
          const filePath = readJsonString(source, findObjectFieldValue(source, inputBounds.start, inputBounds.end, 'file_path'), BASH_COMMAND_CAP)
          if (filePath !== undefined) input['file_path'] = filePath
        } else if (name === 'Agent' || name === 'Task') {
          const subagentType = readJsonString(source, findObjectFieldValue(source, inputBounds.start, inputBounds.end, 'subagent_type'), 200)
          if (subagentType !== undefined) input['subagent_type'] = subagentType
        } else if (BASH_TOOLS.has(name)) {
          const command = readJsonString(source, findObjectFieldValue(source, inputBounds.start, inputBounds.end, 'command'), BASH_COMMAND_CAP)
          if (command !== undefined) input['command'] = command
        }
      }
      tools.push({ type: 'tool_use', id, name, input })
    }
    i = objectEnd + 1
  }
  return tools
}

function extractLargeUserText(source: JsonSource, contentBounds: JsonValueBounds | null): string | undefined {
  if (!contentBounds) return undefined
  if (contentBounds.kind === 'string') return readJsonString(source, contentBounds, USER_TEXT_CAP)
  if (contentBounds.kind !== 'array') return undefined

  let text = ''
  let i = contentBounds.start + 1
  while (i < contentBounds.end - 1 && text.length < USER_TEXT_CAP) {
    i = skipJsonWhitespace(source, i, contentBounds.end)
    if (jsonCharCodeAt(source, i) === 0x2c) {
      i++
      continue
    }
    if (jsonCharCodeAt(source, i) !== 0x7b) {
      i++
      continue
    }
    const objectEnd = findJsonContainerEnd(source, i, 0x7b, 0x7d, contentBounds.end)
    if (objectEnd === -1) break
    const objectBounds = { start: i, end: objectEnd + 1, kind: 'object' as const }
    const type = readJsonString(source, findObjectFieldValue(source, objectBounds.start, objectBounds.end, 'type'))
    if (type === 'text' || type === 'input_text') {
      const part = readJsonString(
        source,
        findObjectFieldValue(source, objectBounds.start, objectBounds.end, 'text'),
        USER_TEXT_CAP - text.length,
      )
      if (part) text += (text ? ' ' : '') + part
    }
    i = objectEnd + 1
  }
  return text || undefined
}

function extractLargeAddedNames(source: JsonSource, attachmentBounds: JsonValueBounds | null): string[] {
  if (!attachmentBounds || attachmentBounds.kind !== 'object') return []
  const attachmentType = readJsonString(source, findObjectFieldValue(source, attachmentBounds.start, attachmentBounds.end, 'type'))
  if (attachmentType !== 'deferred_tools_delta') return []
  const addedNames = findObjectFieldValue(source, attachmentBounds.start, attachmentBounds.end, 'addedNames')
  if (!addedNames || addedNames.kind !== 'array') return []
  const names: string[] = []
  let i = addedNames.start + 1
  while (i < addedNames.end - 1 && names.length < MAX_ADDED_NAMES) {
    i = skipJsonWhitespace(source, i, addedNames.end)
    if (jsonCharCodeAt(source, i) === 0x2c) {
      i++
      continue
    }
    if (jsonCharCodeAt(source, i) !== 0x22) {
      i++
      continue
    }
    const end = findJsonStringEnd(source, i, addedNames.end)
    if (end === -1) break
    const name = readJsonString(source, { start: i, end: end + 1, kind: 'string' }, 500)
    if (name) names.push(name)
    i = end + 1
  }
  return names
}

// Does the raw key bytes/chars at [keyStart, keyEnd) equal one of `fields`? This
// compares the RAW key (escapes and all), exactly as findObjectFieldValue did, so
// a key like "type" still does not match "type". Returns the matched field
// name so the caller can bucket the value.
function matchCapturedField(
  source: JsonSource,
  fieldBuffers: Buffer[] | null,
  keyStart: number,
  keyEnd: number,
  fields: readonly string[],
): string | null {
  if (fieldBuffers === null) {
    const key = (source.raw as string).slice(keyStart, keyEnd)
    return fields.includes(key) ? key : null
  }
  const raw = source.raw as Buffer
  const keyLength = keyEnd - keyStart
  for (let k = 0; k < fields.length; k++) {
    const fieldBuffer = fieldBuffers[k]!
    if (keyLength === fieldBuffer.length && raw.subarray(keyStart, keyEnd).equals(fieldBuffer)) return fields[k]!
  }
  return null
}

// Single pass over one JSON object, capturing the bounds of several top-level
// fields at once. This is the multi-field generalization of findObjectFieldValue:
// it reproduces that walk exactly — same whitespace/comma handling, same
// first-match-wins on duplicate keys, and the same "stop on a truncated key or an
// unparseable value" behavior that findObjectFieldValue expressed as `return null`
// — but visits each byte once instead of re-walking the object per field. On large
// Claude lines a multi-KB tool blob often precedes these keys, so a per-field walk
// re-scanned that blob once for every field it trailed.
function extractObjectFields(
  source: JsonSource,
  objectStart: number,
  objectEnd: number,
  fields: readonly string[],
): Record<string, JsonValueBounds | null> {
  const captured: Record<string, JsonValueBounds | null> = {}
  for (const field of fields) captured[field] = null
  if (jsonCharCodeAt(source, objectStart) !== 0x7b) return captured

  const fieldBuffers = typeof source.raw === 'string' ? null : fields.map((f) => Buffer.from(f))
  let remaining = fields.length
  let i = objectStart + 1
  while (i < objectEnd - 1 && remaining > 0) {
    i = skipJsonWhitespace(source, i, objectEnd)
    const ch = jsonCharCodeAt(source, i)
    if (ch === 0x2c) {
      i++
      continue
    }
    // Any non-'"' byte here is stray content between members; step over it and
    // resync on the next quote, exactly as the per-field walk did.
    if (ch !== 0x22) {
      i++
      continue
    }
    const keyEnd = findJsonStringEnd(source, i, objectEnd)
    if (keyEnd === -1) break // truncated key: findObjectFieldValue returned null here
    const keyStart = i + 1
    i = skipJsonWhitespace(source, keyEnd + 1, objectEnd)
    if (jsonCharCodeAt(source, i) !== 0x3a) continue // missing ':' — resync on the next member
    const value = findJsonValueBounds(source, i + 1, objectEnd)
    if (!value) break // unparseable value: findObjectFieldValue returned null here
    const matched = matchCapturedField(source, fieldBuffers, keyStart, keyEnd, fields)
    if (matched !== null && captured[matched] === null) {
      captured[matched] = value // keep the first occurrence, like findObjectFieldValue
      remaining-- // once every field is found the rest of the object is dead weight
    }
    i = value.end
  }
  return captured
}

const LARGE_ROOT_FIELDS = ['type', 'timestamp', 'sessionId', 'cwd', 'gitBranch', 'attachment', 'message'] as const
const LARGE_ASSISTANT_MESSAGE_FIELDS = ['model', 'usage', 'id', 'content'] as const

function parseLargeJsonl(line: string | Buffer): JournalEntry | null {
  const source = createJsonSource(line)
  const rootStart = skipJsonWhitespace(source, 0)
  const rootEnd = findJsonContainerEnd(source, rootStart, 0x7b, 0x7d)
  if (rootEnd === -1) return null
  const rootLimit = rootEnd + 1
  const root = extractObjectFields(source, rootStart, rootLimit, LARGE_ROOT_FIELDS)
  const type = readJsonString(source, root['type'])
  if (!type) return null

  const entry: JournalEntry = { type }
  const timestamp = readJsonString(source, root['timestamp'])
  const sessionId = readJsonString(source, root['sessionId'])
  const cwd = readJsonString(source, root['cwd'])
  const gitBranch = readJsonString(source, root['gitBranch'])
  if (timestamp !== undefined) entry.timestamp = timestamp
  if (sessionId !== undefined) entry.sessionId = sessionId
  if (cwd !== undefined) entry.cwd = cwd
  if (gitBranch !== undefined) entry.gitBranch = gitBranch
  const addedNames = extractLargeAddedNames(source, root['attachment'])
  if (addedNames.length > 0) {
    ;(entry as Record<string, unknown>)['attachment'] = { type: 'deferred_tools_delta', addedNames }
  }

  const message = root['message']
  if (type === 'user') {
    if (message?.kind === 'object') {
      const content = findObjectFieldValue(source, message.start, message.end, 'content')
      const text = extractLargeUserText(source, content)
      if (text !== undefined) entry.message = { role: 'user', content: text }
    }
    return entry
  }

  if (type !== 'assistant') return entry
  if (message?.kind !== 'object') return entry
  const messageFields = extractObjectFields(source, message.start, message.end, LARGE_ASSISTANT_MESSAGE_FIELDS)
  const model = readJsonString(source, messageFields['model'])
  const usageBounds = messageFields['usage']
  if (!model || usageBounds?.kind !== 'object') return entry
  const id = readJsonString(source, messageFields['id'])
  const contentBounds = messageFields['content']

  entry.message = {
    type: 'message',
    role: 'assistant',
    model,
    ...(id !== undefined ? { id } : {}),
    content: extractLargeToolBlocks(source, contentBounds),
    usage: parseLargeUsage(source, usageBounds),
  }

  return entry
}

function findJsonStringEndString(source: string, start: number, limit = source.length): number {
  for (let i = start + 1; i < limit; i++) {
    const ch = source.charCodeAt(i)
    if (ch === 0x5c) {
      i++
      continue
    }
    if (ch === 0x22) return i
  }
  return -1
}

function findJsonContainerEndString(source: string, start: number, open: number, close: number, limit = source.length): number {
  let depth = 0
  let inString = false
  for (let i = start; i < limit; i++) {
    const ch = source.charCodeAt(i)
    if (inString) {
      if (ch === 0x5c) {
        i++
      } else if (ch === 0x22) {
        inString = false
      }
      continue
    }
    if (ch === 0x22) {
      inString = true
    } else if (ch === open) {
      depth++
    } else if (ch === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function findJsonValueBoundsString(source: string, start: number, limit = source.length): JsonValueBounds | null {
  let i = start
  while (i < limit && /\s/.test(source[i]!)) i++
  if (i >= limit) return null
  const ch = source.charCodeAt(i)
  if (ch === 0x22) {
    const end = findJsonStringEndString(source, i, limit)
    return end === -1 ? null : { start: i, end: end + 1, kind: 'string' }
  }
  if (ch === 0x7b) {
    const end = findJsonContainerEndString(source, i, 0x7b, 0x7d, limit)
    return end === -1 ? null : { start: i, end: end + 1, kind: 'object' }
  }
  if (ch === 0x5b) {
    const end = findJsonContainerEndString(source, i, 0x5b, 0x5d, limit)
    return end === -1 ? null : { start: i, end: end + 1, kind: 'array' }
  }
  let end = i
  while (end < limit) {
    const c = source.charCodeAt(end)
    if (c === 0x2c || c === 0x7d || c === 0x5d || /\s/.test(source[end]!)) break
    end++
  }
  return { start: i, end, kind: 'scalar' }
}

function findJsonStringEndBuffer(source: Buffer, start: number, limit = source.length): number {
  for (let i = start + 1; i < limit; i++) {
    const ch = source[i]
    if (ch === 0x5c) {
      i++
      continue
    }
    if (ch === 0x22) return i
  }
  return -1
}

function findJsonContainerEndBuffer(source: Buffer, start: number, open: number, close: number, limit = source.length): number {
  let depth = 0
  let inString = false
  for (let i = start; i < limit; i++) {
    const ch = source[i]
    if (inString) {
      if (ch === 0x5c) {
        i++
      } else if (ch === 0x22) {
        inString = false
      }
      continue
    }
    if (ch === 0x22) {
      inString = true
    } else if (ch === open) {
      depth++
    } else if (ch === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function findJsonValueBoundsBuffer(source: Buffer, start: number, limit = source.length): JsonValueBounds | null {
  let i = start
  while (i < limit && isBufferWhitespaceAt(source, i)) i++
  if (i >= limit) return null
  const ch = source[i]
  if (ch === 0x22) {
    const end = findJsonStringEndBuffer(source, i, limit)
    return end === -1 ? null : { start: i, end: end + 1, kind: 'string' }
  }
  if (ch === 0x7b) {
    const end = findJsonContainerEndBuffer(source, i, 0x7b, 0x7d, limit)
    return end === -1 ? null : { start: i, end: end + 1, kind: 'object' }
  }
  if (ch === 0x5b) {
    const end = findJsonContainerEndBuffer(source, i, 0x5b, 0x5d, limit)
    return end === -1 ? null : { start: i, end: end + 1, kind: 'array' }
  }
  let end = i
  while (end < limit) {
    const c = source[end]
    if (c === 0x2c || c === 0x7d || c === 0x5d || isBufferWhitespaceAt(source, end)) break
    end++
  }
  return { start: i, end, kind: 'scalar' }
}

function findObjectFieldValueString(source: string, objectStart: number, objectEnd: number, field: string): JsonValueBounds | null {
  if (source.charCodeAt(objectStart) !== 0x7b) return null
  let i = objectStart + 1
  while (i < objectEnd - 1) {
    while (i < objectEnd && /\s/.test(source[i]!)) i++
    if (source.charCodeAt(i) === 0x2c) {
      i++
      continue
    }
    if (source.charCodeAt(i) !== 0x22) {
      i++
      continue
    }
    const keyEnd = findJsonStringEndString(source, i, objectEnd)
    if (keyEnd === -1) return null
    const keyStart = i + 1
    i = keyEnd + 1
    while (i < objectEnd && /\s/.test(source[i]!)) i++
    if (source.charCodeAt(i) !== 0x3a) continue
    const value = findJsonValueBoundsString(source, i + 1, objectEnd)
    if (!value) return null
    if (source.slice(keyStart, keyEnd) === field) return value
    i = value.end
  }
  return null
}

function findObjectFieldValueBuffer(source: Buffer, objectStart: number, objectEnd: number, field: string): JsonValueBounds | null {
  if (source[objectStart] !== 0x7b) return null
  let i = objectStart + 1
  while (i < objectEnd - 1) {
    while (i < objectEnd && isBufferWhitespaceAt(source, i)) i++
    if (source[i] === 0x2c) {
      i++
      continue
    }
    if (source[i] !== 0x22) {
      i++
      continue
    }
    const keyEnd = findJsonStringEndBuffer(source, i, objectEnd)
    if (keyEnd === -1) return null
    const keyStart = i + 1
    i = keyEnd + 1
    while (i < objectEnd && isBufferWhitespaceAt(source, i)) i++
    if (source[i] !== 0x3a) continue
    const value = findJsonValueBoundsBuffer(source, i + 1, objectEnd)
    if (!value) return null
    if (keyEnd - keyStart === field.length && source.subarray(keyStart, keyEnd).equals(Buffer.from(field))) return value
    i = value.end
  }
  return null
}

function appendStringJsonSegment(source: string, start: number, end: number, current: string, cap: number): string {
  if (start >= end || current.length >= cap) return current
  return current + source.slice(start, Math.min(end, start + cap - current.length))
}

function appendBufferJsonSegment(source: Buffer, start: number, end: number, current: string, cap: number): string {
  if (start >= end || current.length >= cap) return current
  const remaining = cap - current.length
  const cappedEnd = Number.isFinite(cap) ? safeBufferSegmentEnd(source, Math.min(end, start + remaining * 4)) : end
  return current + source.subarray(start, cappedEnd).toString('utf-8').slice(0, remaining)
}

function readJsonStringString(source: string, bounds: JsonValueBounds | null, cap = Number.POSITIVE_INFINITY): string | undefined {
  if (!bounds || bounds.kind !== 'string') return undefined
  let out = ''
  const contentEnd = bounds.end - 1
  let segmentStart = bounds.start + 1
  let i = segmentStart
  let scanLimit = Number.isFinite(cap) ? Math.min(contentEnd, segmentStart + cap) : contentEnd
  while (i < contentEnd && out.length < cap) {
    if (i >= scanLimit) {
      out = appendStringJsonSegment(source, segmentStart, i, out, cap)
      if (out.length >= cap) break
      segmentStart = i
      scanLimit = Number.isFinite(cap) ? Math.min(contentEnd, i + cap - out.length) : contentEnd
      continue
    }
    const ch = source.charCodeAt(i)
    if (ch !== 0x5c) {
      i++
      continue
    }
    out = appendStringJsonSegment(source, segmentStart, i, out, cap)
    if (out.length >= cap) break
    i++
    const next = source.charCodeAt(i)
    if (Number.isNaN(next)) break
    if (next === 0x6e) out += '\n'
    else if (next === 0x72) out += '\r'
    else if (next === 0x74) out += '\t'
    else if (next === 0x62) out += '\b'
    else if (next === 0x66) out += '\f'
    else if (next === 0x75 && i + 4 < bounds.end) {
      const code = Number.parseInt(source.slice(i + 1, i + 5), 16)
      if (Number.isFinite(code)) out += String.fromCharCode(code)
      i += 4
    } else {
      out += String.fromCharCode(next)
    }
    segmentStart = i + 1
    i++
  }
  return appendStringJsonSegment(source, segmentStart, contentEnd, out, cap)
}

function readJsonStringBuffer(source: Buffer, bounds: JsonValueBounds | null, cap = Number.POSITIVE_INFINITY): string | undefined {
  if (!bounds || bounds.kind !== 'string') return undefined
  let out = ''
  const contentEnd = bounds.end - 1
  let segmentStart = bounds.start + 1
  let i = segmentStart
  let scanLimit = Number.isFinite(cap) ? Math.min(contentEnd, segmentStart + cap * 4) : contentEnd
  while (i < contentEnd && out.length < cap) {
    if (i >= scanLimit) {
      const segmentEnd = safeBufferSegmentEnd(source, i)
      out = appendBufferJsonSegment(source, segmentStart, segmentEnd, out, cap)
      if (out.length >= cap) break
      segmentStart = segmentEnd
      i = segmentEnd
      scanLimit = Number.isFinite(cap) ? Math.min(contentEnd, i + (cap - out.length) * 4) : contentEnd
      continue
    }
    const ch = source[i]
    if (ch !== 0x5c) {
      i++
      continue
    }
    out = appendBufferJsonSegment(source, segmentStart, i, out, cap)
    if (out.length >= cap) break
    i++
    const next = source[i]
    if (next === undefined) break
    if (next === 0x6e) out += '\n'
    else if (next === 0x72) out += '\r'
    else if (next === 0x74) out += '\t'
    else if (next === 0x62) out += '\b'
    else if (next === 0x66) out += '\f'
    else if (next === 0x75 && i + 4 < bounds.end) {
      const code = Number.parseInt(source.subarray(i + 1, i + 5).toString('ascii'), 16)
      if (Number.isFinite(code)) out += String.fromCharCode(code)
      i += 4
    } else {
      out += String.fromCharCode(next)
    }
    segmentStart = i + 1
    i++
  }
  return appendBufferJsonSegment(source, segmentStart, contentEnd, out, cap)
}

function getTopLevelRawJsonStringField(head: string, field: string): string | null {
  let i = 0
  while (i < head.length && /\s/.test(head[i]!)) i++
  if (head.charCodeAt(i) !== 0x7b) return null
  i++
  while (i < head.length) {
    while (i < head.length && /\s/.test(head[i]!)) i++
    if (head.charCodeAt(i) === 0x2c) {
      i++
      continue
    }
    if (head.charCodeAt(i) === 0x7d) return null
    if (head.charCodeAt(i) !== 0x22) return null
    const keyEnd = findJsonStringEndString(head, i)
    if (keyEnd === -1) return null
    const key = head.slice(i + 1, keyEnd)
    i = keyEnd + 1
    while (i < head.length && /\s/.test(head[i]!)) i++
    if (head.charCodeAt(i) !== 0x3a) return null
    const value = findJsonValueBoundsString(head, i + 1)
    if (!value) return null
    if (key === field) return readJsonStringString(head, value) ?? null
    i = value.end
  }
  return null
}

export function shouldSkipLine(line: string, threshold: string): boolean {
  const head = line.length > RAW_HEAD_BYTES ? line.slice(0, RAW_HEAD_BYTES) : line
  const type = getTopLevelRawJsonStringField(head, 'type')
  if (type !== 'user' && type !== 'assistant') return false
  const ts = getTopLevelRawJsonStringField(head, 'timestamp')
  if (!ts || ts.length < 10) return false
  return ts < threshold
}

const USER_TEXT_CAP = 2000
const BASH_COMMAND_CAP = 2000
const MAX_TOOL_BLOCKS = 500
const MAX_ADDED_NAMES = 1000

export function compactEntry(raw: JournalEntry): JournalEntry {
  const entry: JournalEntry = { type: raw.type }

  if (raw.timestamp !== undefined) entry.timestamp = raw.timestamp
  if (raw.sessionId !== undefined) entry.sessionId = raw.sessionId
  if (raw.cwd !== undefined) entry.cwd = raw.cwd
  // Preserved so groupIntoTurns can stamp each turn's git branch (rich capture).
  if (typeof raw.gitBranch === 'string' && raw.gitBranch) entry.gitBranch = raw.gitBranch
  // Preserved so groupIntoTurns can attribute each PR reference to its turn.
  // Only `pr-link` entries carry `prUrl`; every other field of theirs is dropped.
  if (raw.type === 'pr-link') {
    const prUrl = (raw as Record<string, unknown>)['prUrl']
    if (typeof prUrl === 'string' && prUrl) (entry as Record<string, unknown>)['prUrl'] = prUrl
  }

  const att = (raw as Record<string, unknown>)['attachment']
  if (att && typeof att === 'object') {
    const a = att as Record<string, unknown>
    if (a['type'] === 'deferred_tools_delta' && Array.isArray(a['addedNames'])) {
      const names: string[] = []
      for (let i = 0; i < Math.min(a['addedNames'].length, MAX_ADDED_NAMES); i++) {
        const n = a['addedNames'][i]
        if (typeof n === 'string') names.push(n)
      }
      ;(entry as Record<string, unknown>)['attachment'] = { type: 'deferred_tools_delta', addedNames: names }
    }
  }

  if (!raw.message) return entry

  if (raw.message.role === 'user') {
    const content = raw.message.content
    if (typeof content === 'string') {
      entry.message = { role: 'user', content: content.slice(0, USER_TEXT_CAP) }
    } else if (Array.isArray(content)) {
      let remaining = USER_TEXT_CAP
      const blocks: { type: 'text'; text: string }[] = []
      for (const b of content) {
        if (remaining <= 0) break
        if (!b || typeof b !== 'object' || b.type !== 'text') continue
        const text = (b as { text?: unknown }).text
        if (typeof text !== 'string') continue
        const sliced = text.slice(0, remaining)
        blocks.push({ type: 'text', text: sliced })
        remaining -= sliced.length
      }
      entry.message = { role: 'user', content: blocks }
    }
    return entry
  }

  const msg = raw.message as AssistantMessageContent
  if (!msg.usage || !msg.model) return entry

  const rawContent = msg.content
  const contentArr = Array.isArray(rawContent) ? rawContent : []
  const toolBlocks = contentArr.filter((b): b is ToolUseBlock => b != null && typeof b === 'object' && b.type === 'tool_use')
  const compactContent: ContentBlock[] = toolBlocks.slice(0, MAX_TOOL_BLOCKS).map(tb => {
    let input: Record<string, unknown> = {}
    if (tb.name === 'Skill') {
      const ri = (tb.input ?? {}) as Record<string, unknown>
      if (typeof ri['skill'] === 'string') input['skill'] = (ri['skill'] as string).slice(0, 200)
      if (typeof ri['name'] === 'string') input['name'] = (ri['name'] as string).slice(0, 200)
    } else if (tb.name === 'Read' || tb.name === 'FileReadTool' || EDIT_TOOLS.has(tb.name)) {
      const ri = (tb.input ?? {}) as Record<string, unknown>
      if (typeof ri['file_path'] === 'string') input['file_path'] = (ri['file_path'] as string).slice(0, BASH_COMMAND_CAP)
    } else if (tb.name === 'Agent' || tb.name === 'Task') {
      const ri = (tb.input ?? {}) as Record<string, unknown>
      if (typeof ri['subagent_type'] === 'string') input['subagent_type'] = (ri['subagent_type'] as string).slice(0, 200)
    } else if (BASH_TOOLS.has(tb.name)) {
      const ri = (tb.input ?? {}) as Record<string, unknown>
      if (typeof ri['command'] === 'string') {
        input['command'] = (ri['command'] as string).slice(0, BASH_COMMAND_CAP)
      }
    }
    return { type: 'tool_use' as const, id: tb.id ?? '', name: tb.name, input }
  })

  const u = msg.usage
  const compactUsage: AssistantMessageContent['usage'] = {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
  }
  if (u.cache_creation_input_tokens) compactUsage.cache_creation_input_tokens = u.cache_creation_input_tokens
  if (u.cache_creation) {
    compactUsage.cache_creation = {
      ...(u.cache_creation.ephemeral_5m_input_tokens ? { ephemeral_5m_input_tokens: u.cache_creation.ephemeral_5m_input_tokens } : {}),
      ...(u.cache_creation.ephemeral_1h_input_tokens ? { ephemeral_1h_input_tokens: u.cache_creation.ephemeral_1h_input_tokens } : {}),
    }
  }
  if (u.cache_read_input_tokens) compactUsage.cache_read_input_tokens = u.cache_read_input_tokens
  if (u.server_tool_use) {
    compactUsage.server_tool_use = {
      ...(u.server_tool_use.web_search_requests ? { web_search_requests: u.server_tool_use.web_search_requests } : {}),
      ...(u.server_tool_use.web_fetch_requests ? { web_fetch_requests: u.server_tool_use.web_fetch_requests } : {}),
    }
  }
  if (u.speed) compactUsage.speed = u.speed
  // Preserve only advisor_message iterations (/advisor sub-usage) so
  // parseAdvisorCalls can attribute the advisor model's spend; drop the rest to
  // keep the cache small. Other iteration types (plain `message`, and the
  // `fallback_message` written when a turn retries on another model) are not
  // accounted here, a separate pre-existing gap, so they are not preserved.
  if (Array.isArray(u.iterations)) {
    const advisorIterations = u.iterations
      .filter((it): it is ApiUsageIteration => !!it && it.type === 'advisor_message')
      .map(it => {
        const compact: ApiUsageIteration = { type: 'advisor_message' }
        if (typeof it.model === 'string') compact.model = it.model
        if (it.input_tokens) compact.input_tokens = it.input_tokens
        if (it.output_tokens) compact.output_tokens = it.output_tokens
        if (it.cache_creation_input_tokens) compact.cache_creation_input_tokens = it.cache_creation_input_tokens
        if (it.cache_read_input_tokens) compact.cache_read_input_tokens = it.cache_read_input_tokens
        if (it.cache_creation) {
          compact.cache_creation = {
            ...(it.cache_creation.ephemeral_5m_input_tokens ? { ephemeral_5m_input_tokens: it.cache_creation.ephemeral_5m_input_tokens } : {}),
            ...(it.cache_creation.ephemeral_1h_input_tokens ? { ephemeral_1h_input_tokens: it.cache_creation.ephemeral_1h_input_tokens } : {}),
          }
        }
        if (it.server_tool_use?.web_search_requests) compact.server_tool_use = { web_search_requests: it.server_tool_use.web_search_requests }
        if (it.speed) compact.speed = it.speed
        return compact
      })
    if (advisorIterations.length > 0) compactUsage.iterations = advisorIterations
  }

  entry.message = {
    type: 'message',
    role: 'assistant',
    model: msg.model,
    usage: compactUsage,
    content: compactContent,
    ...(msg.id ? { id: msg.id } : {}),
  }

  return entry
}

function extractToolNames(content: ContentBlock[]): string[] {
  return content
    .filter((b): b is ToolUseBlock => b.type === 'tool_use')
    .map(b => b.name)
}

function extractMcpTools(tools: string[]): string[] {
  return tools.filter(t => t.startsWith('mcp__'))
}

function extractSkillNames(content: ContentBlock[]): string[] {
  return content
    .filter((b): b is ToolUseBlock => b.type === 'tool_use' && b.name === 'Skill')
    .map(b => {
      const input = (b.input ?? {}) as Record<string, unknown>
      const raw = input['skill'] ?? input['name']
      return typeof raw === 'string' ? raw.trim() : ''
    })
    .filter(name => name.length > 0)
}

function extractSubagentTypes(content: ContentBlock[]): string[] {
  return content
    .filter((b): b is ToolUseBlock => b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task'))
    .map(b => {
      const input = (b.input ?? {}) as Record<string, unknown>
      const raw = input['subagent_type']
      return typeof raw === 'string' ? raw.trim() : ''
    })
    .filter(name => name.length > 0)
}

function extractCoreTools(tools: string[]): string[] {
  return tools.filter(t => !t.startsWith('mcp__'))
}

function extractBashCommandsFromContent(content: ContentBlock[]): string[] {
  return content
    .filter((b): b is ToolUseBlock => b.type === 'tool_use' && BASH_TOOLS.has((b as ToolUseBlock).name))
    .flatMap(b => {
      const command = (b.input as Record<string, unknown>)?.command
      return typeof command === 'string' ? extractBashCommands(command) : []
    })
}

function getUserMessageText(entry: JournalEntry): string {
  if (!entry.message || entry.message.role !== 'user') return ''
  const content = entry.message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join(' ')
  }
  return ''
}

function getMessageId(entry: JournalEntry): string | null {
  if (entry.type !== 'assistant') return null
  const msg = entry.message as AssistantMessageContent | undefined
  return msg?.id ?? null
}

export function safeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

export function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function extractClaudeCacheCreation(usage: {
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
}): { totalTokens: number; oneHourTokens: number } {
  const legacyTotal = safeNumber(usage.cache_creation_input_tokens)
  const cacheCreation = usage.cache_creation
  const fiveMinuteTokens = safeNumber(cacheCreation?.ephemeral_5m_input_tokens)
  const oneHourTokens = safeNumber(cacheCreation?.ephemeral_1h_input_tokens)
  const splitTotal = fiveMinuteTokens + oneHourTokens

  if (splitTotal === 0) return { totalTokens: legacyTotal, oneHourTokens: 0 }

  // Valid Claude usage reports the legacy total and split total as equal.
  // Keep the larger value so malformed partial splits do not drop tokens.
  const totalTokens = Math.max(legacyTotal, splitTotal)
  return {
    totalTokens,
    oneHourTokens: Math.min(oneHourTokens, totalTokens),
  }
}

/// Apply local-model savings accounting to a call. If the raw model name is
/// mapped via `codeburn model-savings`, the call's actual cost is forced
/// to $0 and the hypothetical baseline cost is recorded as `savingsUSD`.
/// Returns the input unchanged when no mapping is configured for the
/// model — keeps the hot path branch-free for the common paid-only case.
function applyLocalModelSavings(call: ParsedApiCall): ParsedApiCall {
  const u = call.usage
  const savings = calculateLocalModelSavings(
    call.model,
    u.inputTokens,
    u.outputTokens,
    u.cacheCreationInputTokens,
    u.cacheReadInputTokens,
    u.webSearchRequests,
    call.speed,
    call.cacheCreationOneHourTokens ?? 0,
  )
  if (!savings) return call
  return {
    ...call,
    costUSD: 0,
    savingsUSD: savings.savingsUSD,
    savingsBaselineModel: savings.baselineModel,
    isLocalSavings: true,
  }
}

// ── Rich Session Capture (Claude) ──────────────────────────────────────
//
// Parse-time extraction of edit sizes, interruptions, error counts, git branch,
// and session titles/PR links from the raw JSONL. Capture-only: no report or
// payload consumes these yet. Everything is optional and omitted at zero/false
// to keep the cache cost minimal.

// Per-call metadata keyed by tool_use_id, built from a session's user
// (tool-result) entries before compaction discards `toolUseResult` and the
// tool_result blocks' `is_error` flag.
export type ToolResultMeta = {
  locAdded: number
  locRemoved: number
  interrupted: boolean
  userModified: boolean
  isError: boolean
}

// Session-level accumulator: last `ai-title` wins, `pr-link` URLs accumulate,
// and any sidechain entry flips `isSidechain`. parentUuid is deliberately not
// captured as a session link — it references an intra-file entry uuid, not
// another session's id, so it cannot reliably connect two sessions.
export type SessionMeta = {
  title?: string
  prLinks: string[]
  isSidechain: boolean
  // Sidechain side: the parent session id (a sidechain entry's internal
  // `sessionId`, which is the spawning session). First non-empty value wins.
  parentSessionId?: string
  // Parent side: agentId -> the `tool_use` id of the `Agent`/`Task` block that
  // spawned it, read from the spawn result's `toolUseResult.agentId`. First value
  // per agentId wins. Empty for sessions that spawned no completed subagent.
  agentSpawnLinks: Record<string, string>
  // Parent side: agent ids whose spawn result named them but whose exact launching
  // tool_use could not be paired (an ambiguous multi-result record). Drives the
  // grace-window fallback for a late child. Deduped.
  ambiguousSpawnAgentIds: string[]
}

export function emptySessionMeta(): SessionMeta {
  return { prLinks: [], isSidechain: false, agentSpawnLinks: {}, ambiguousSpawnAgentIds: [] }
}

// Count added/removed lines from a Claude `toolUseResult.structuredPatch`. Each
// hunk's `lines` array holds unified-diff content lines: a leading '+' is an
// added line, '-' a removed line, ' ' context. Numbers only — patch text is
// never stored. Missing/empty/non-array patches count as zero.
export function countStructuredPatchLoc(patch: unknown): { added: number; removed: number } {
  let added = 0
  let removed = 0
  if (!Array.isArray(patch)) return { added, removed }
  for (const hunk of patch) {
    const lines = (hunk as { lines?: unknown } | null)?.lines
    if (!Array.isArray(lines)) continue
    for (const line of lines) {
      if (typeof line !== 'string') continue
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  }
  return { added, removed }
}

// Record tool-result metadata from a raw user entry into `map`, keyed by the
// tool_result block's tool_use_id. Must run on the RAW entry (before
// compactEntry drops toolUseResult / is_error). Large tool-result lines parsed
// as buffers lose toolUseResult (the byte scanner does not extract it) — an
// accepted gap for oversized outputs.
export function collectToolResultMeta(entry: JournalEntry, map: Map<string, ToolResultMeta>): void {
  if (entry.type !== 'user') return
  const msg = entry.message
  const content = msg && typeof msg === 'object' ? (msg as { content?: unknown }).content : undefined
  if (!Array.isArray(content)) return
  const tur = (entry as Record<string, unknown>)['toolUseResult']
  const turObj = tur && typeof tur === 'object' ? tur as Record<string, unknown> : undefined
  const loc = countStructuredPatchLoc(turObj?.['structuredPatch'])
  const interrupted = turObj?.['interrupted'] === true
  const userModified = turObj?.['userModified'] === true
  for (const b of content) {
    if (!b || typeof b !== 'object' || (b as { type?: unknown }).type !== 'tool_result') continue
    const id = (b as { tool_use_id?: unknown }).tool_use_id
    if (typeof id !== 'string' || !id) continue
    const isError = (b as { is_error?: unknown }).is_error === true
    map.set(id, { locAdded: loc.added, locRemoved: loc.removed, interrupted, userModified, isError })
  }
}

// Accumulate session-level metadata from a raw entry. `ai-title` is last-wins
// (Claude refines the title over the session); `pr-link` URLs union; any
// sidechain entry marks the session.
export function collectSessionMeta(entry: JournalEntry, meta: SessionMeta): void {
  if (entry.type === 'ai-title') {
    const t = (entry as Record<string, unknown>)['aiTitle']
    if (typeof t === 'string' && t.trim()) meta.title = t.trim().slice(0, 200)
  } else if (entry.type === 'pr-link') {
    const url = (entry as Record<string, unknown>)['prUrl']
    if (typeof url === 'string' && url && !meta.prLinks.includes(url)) meta.prLinks.push(url)
  }
  if (entry.isSidechain === true) {
    meta.isSidechain = true
    // A sidechain entry's own `sessionId` is the id of the session that spawned
    // it (32/32 on real data; cross-checked against the owning directory at
    // stamp time). First value wins; every entry in the file carries the same id.
    const sid = (entry as Record<string, unknown>)['sessionId']
    if (!meta.parentSessionId && typeof sid === 'string' && sid) meta.parentSessionId = sid
  }
  // Parent side: the `Agent`/`Task` spawn result records the spawned agent's id in
  // `toolUseResult.agentId`; pair it with the `tool_result` block's `tool_use_id`
  // (the spawn's `tool_use` id) so a child can be folded into the launching turn.
  // Read from the RAW entry (compaction strips `toolUseResult`).
  const tur = (entry as Record<string, unknown>)['toolUseResult']
  if (tur && typeof tur === 'object') {
    const agentId = (tur as Record<string, unknown>)['agentId']
    if (typeof agentId === 'string' && agentId && !(agentId in meta.agentSpawnLinks)) {
      const msg = entry.message
      const content = msg && typeof msg === 'object' ? (msg as { content?: unknown }).content : undefined
      if (Array.isArray(content)) {
        const results = content.filter((b): b is Record<string, unknown> =>
          !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_result'
          && typeof (b as { tool_use_id?: unknown }).tool_use_id === 'string' && !!(b as { tool_use_id?: unknown }).tool_use_id)
        let spawnId: string | undefined
        if (results.length === 1) {
          spawnId = results[0]!['tool_use_id'] as string
        } else if (results.length > 1) {
          // Several batched tool results share one entry: pair the agentId with the
          // block whose `content` is the spawn result (equals `toolUseResult.content`),
          // so an unrelated sibling block cannot capture the id. When the match is
          // ambiguous (identical blocks, or none match) the spawn link is left
          // unset ON PURPOSE: the child then folds via the timestamp-bucket fallback
          // in resolveChild rather than risk pairing with the wrong id.
          const turContent = JSON.stringify((tur as Record<string, unknown>)['content'])
          const matches = results.filter(b => JSON.stringify(b['content']) === turContent)
          if (matches.length === 1) spawnId = matches[0]!['tool_use_id'] as string
        }
        if (spawnId) meta.agentSpawnLinks[agentId] = spawnId
        // We know this parent spawned `agentId` (its result named it) but could not
        // pair the exact tool_use: record it as an AMBIGUOUS pairing so a late child
        // can still fold via the grace window. Not the same as an absent spawn.
        else if (!meta.ambiguousSpawnAgentIds.includes(agentId)) meta.ambiguousSpawnAgentIds.push(agentId)
      }
    }
  }
}

export function parseApiCall(entry: JournalEntry, toolResultMeta?: Map<string, ToolResultMeta>): ParsedApiCall | null {
  if (entry.type !== 'assistant') return null
  const msg = entry.message as AssistantMessageContent | undefined
  if (!msg?.usage || !msg?.model) return null

  const usage = msg.usage
  const cacheCreation = extractClaudeCacheCreation(usage)
  const tokens: TokenUsage = {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheCreationInputTokens: cacheCreation.totalTokens,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: usage.server_tool_use?.web_search_requests ?? 0,
  }

  // Defensive: a message whose `content` is a string (not an array of blocks)
  // would crash the helpers below; normalize so one bad record can't abort the
  // whole backfill (issue #441).
  const contentBlocks = normalizeContentBlocks(msg.content)
  const tools = extractToolNames(contentBlocks)
  const skills = extractSkillNames(contentBlocks)
  const subagentTypes = extractSubagentTypes(contentBlocks)
  const costUSD = calculateCost(
    msg.model,
    tokens.inputTokens,
    tokens.outputTokens,
    tokens.cacheCreationInputTokens,
    tokens.cacheReadInputTokens,
    tokens.webSearchRequests,
    usage.speed ?? 'standard',
    cacheCreation.oneHourTokens,
  )

  const bashCmds = extractBashCommandsFromContent(contentBlocks)

  // Subagent-spawn `tool_use` ids in this message (`Agent`/`Task` blocks). Kept so
  // groupIntoTurns can attach them to the turn and by-PR attribution can fold each
  // spawned sidechain back into the turn that launched it.
  const spawnIds = contentBlocks
    .filter((b): b is ToolUseBlock => b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task') && !!b.id)
    .map(b => b.id)

  const toolSeq: ToolCall[][] = contentBlocks
    .filter((b): b is ToolUseBlock => b.type === 'tool_use')
    .map(b => {
      const call: ToolCall = { tool: b.name }
      const inp = (b.input ?? {}) as Record<string, unknown>
      if (typeof inp['file_path'] === 'string') call.file = inp['file_path'] as string
      if (typeof inp['command'] === 'string') call.command = inp['command'] as string
      return [call]
    })

  // Attribute tool-result metadata (edit LOC, interruptions, errors) to this
  // call by summing over the tool_use ids it issued. Omitted entirely when no
  // meta map is supplied (e.g. the guard usage path) or nothing was recorded.
  let locAdded = 0
  let locRemoved = 0
  let toolErrors = 0
  let interrupted = false
  let userModified = false
  if (toolResultMeta && toolResultMeta.size > 0) {
    for (const b of contentBlocks) {
      if (b.type !== 'tool_use') continue
      const m = toolResultMeta.get((b as ToolUseBlock).id)
      if (!m) continue
      locAdded += m.locAdded
      locRemoved += m.locRemoved
      if (m.isError) toolErrors++
      if (m.interrupted) interrupted = true
      if (m.userModified) userModified = true
    }
  }

  return applyLocalModelSavings({
    provider: 'claude',
    model: msg.model,
    usage: tokens,
    costUSD,
    tools,
    mcpTools: extractMcpTools(tools),
    skills,
    subagentTypes,
    hasAgentSpawn: tools.includes('Agent'),
    hasPlanMode: tools.includes('EnterPlanMode'),
    speed: usage.speed ?? 'standard',
    timestamp: entry.timestamp ?? '',
    bashCommands: bashCmds,
    deduplicationKey: msg.id ?? `claude:${entry.timestamp}`,
    cacheCreationOneHourTokens: cacheCreation.oneHourTokens || undefined,
    toolSequence: toolSeq.length > 0 ? toolSeq : undefined,
    ...(spawnIds.length > 0 ? { spawnToolUseIds: spawnIds } : {}),
    ...(locAdded ? { locAdded } : {}),
    ...(locRemoved ? { locRemoved } : {}),
    ...(interrupted ? { interrupted: true } : {}),
    ...(userModified ? { userModified: true } : {}),
    ...(toolErrors ? { toolErrors } : {}),
  })
}

/// Claude Code's advisor tool (/advisor) escalates hard decisions to a stronger
/// advisor model mid-turn. Those tokens are recorded as `advisor_message`
/// records inside `message.usage.iterations` under the advisor's own model, and
/// are excluded from the top-level `message.usage` totals that `parseApiCall`
/// reads. Emit them as separate calls so the advisor's spend is counted and
/// attributed to the advisor model rather than silently dropped.
export function parseAdvisorCalls(entry: JournalEntry): ParsedApiCall[] {
  if (entry.type !== 'assistant') return []
  const msg = entry.message as AssistantMessageContent | undefined
  const iterations = msg?.usage?.iterations
  if (!msg?.usage || !Array.isArray(iterations)) return []

  const calls: ParsedApiCall[] = []
  const baseKey = msg.id ?? `claude:${entry.timestamp}`
  // Ordinal among advisor entries (not the raw array index) so the dedup key is
  // identical whether it is computed from the raw record (guard path) or the
  // compacted record whose non-advisor iterations were dropped (report path).
  let advisorOrdinal = 0
  for (const it of iterations) {
    if (!it || it.type !== 'advisor_message') continue
    const model = typeof it.model === 'string' && it.model ? it.model : msg.model
    if (!model) continue
    const index = advisorOrdinal++

    const cacheCreation = extractClaudeCacheCreation(it)
    const tokens: TokenUsage = {
      inputTokens: it.input_tokens ?? 0,
      outputTokens: it.output_tokens ?? 0,
      cacheCreationInputTokens: cacheCreation.totalTokens,
      cacheReadInputTokens: it.cache_read_input_tokens ?? 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: it.server_tool_use?.web_search_requests ?? 0,
    }
    const speed = it.speed ?? msg.usage.speed ?? 'standard'
    const costUSD = calculateCost(
      model,
      tokens.inputTokens,
      tokens.outputTokens,
      tokens.cacheCreationInputTokens,
      tokens.cacheReadInputTokens,
      tokens.webSearchRequests,
      speed,
      cacheCreation.oneHourTokens,
    )

    calls.push(applyLocalModelSavings({
      provider: 'claude',
      model,
      usage: tokens,
      costUSD,
      tools: [],
      mcpTools: [],
      skills: [],
      subagentTypes: [],
      hasAgentSpawn: false,
      hasPlanMode: false,
      speed,
      timestamp: entry.timestamp ?? '',
      bashCommands: [],
      deduplicationKey: `${baseKey}:advisor:${index}`,
      cacheCreationOneHourTokens: cacheCreation.oneHourTokens || undefined,
    }))
  }
  return calls
}

export function dedupeStreamingMessageIds(entries: JournalEntry[]): JournalEntry[] {
  const firstIdxById = new Map<string, number>()
  const lastIdxById = new Map<string, number>()
  for (let i = 0; i < entries.length; i++) {
    const id = getMessageId(entries[i]!)
    if (!id) continue
    if (!firstIdxById.has(id)) firstIdxById.set(id, i)
    lastIdxById.set(id, i)
  }
  if (lastIdxById.size === 0) return entries
  const result: JournalEntry[] = []
  for (let i = 0; i < entries.length; i++) {
    const id = getMessageId(entries[i]!)
    if (id && lastIdxById.get(id) !== i) continue
    if (id && firstIdxById.get(id) !== i) {
      const firstTs = entries[firstIdxById.get(id)!]!.timestamp
      result.push({ ...entries[i]!, timestamp: firstTs ?? entries[i]!.timestamp })
      continue
    }
    result.push(entries[i]!)
  }
  return result
}

export function groupIntoTurns(entries: JournalEntry[], seenMsgIds: Set<string>, toolResultMeta?: Map<string, ToolResultMeta>): ParsedTurn[] {
  const turns: ParsedTurn[] = []
  let currentUserMessage = ''
  let currentCalls: ParsedApiCall[] = []
  let currentTimestamp = ''
  let currentSessionId = ''
  // Git branch of the turn currently being accumulated. Captured at turn start
  // from the user entry (gitBranch is on every user/assistant entry); a
  // continuation turn with no leading user text falls back to its first call.
  let currentBranch: string | undefined
  // GitHub PR URLs referenced within the turn currently being accumulated. A
  // `pr-link` entry is emitted after the assistant creates/references a PR, so it
  // lands inside the same turn (before the next user message) and attaches here.
  let currentPrRefs: string[] = []
  // Subagent-spawn `tool_use` ids emitted within the current turn (deduped),
  // carried from each call's `spawnToolUseIds`.
  let currentSpawnIds: string[] = []

  for (const entry of entries) {
    const entryBranch = typeof entry.gitBranch === 'string' && entry.gitBranch ? entry.gitBranch : undefined
    if (entry.type === 'user') {
      const text = getUserMessageText(entry)
      if (text.trim()) {
        if (currentCalls.length > 0) {
          turns.push({
            userMessage: currentUserMessage,
            assistantCalls: currentCalls,
            timestamp: currentTimestamp,
            sessionId: currentSessionId,
            ...(currentBranch ? { gitBranch: currentBranch } : {}),
            ...(currentPrRefs.length > 0 ? { prRefs: [...currentPrRefs].sort() } : {}),
            ...(currentSpawnIds.length > 0 ? { spawnToolUseIds: currentSpawnIds } : {}),
          })
        }
        currentUserMessage = text
        currentCalls = []
        currentTimestamp = entry.timestamp ?? ''
        currentSessionId = entry.sessionId ?? ''
        currentBranch = entryBranch
        currentPrRefs = extractPrUrlsFromText(text)
        currentSpawnIds = []
      }
    } else if (entry.type === 'assistant') {
      if (entryBranch && !currentBranch) currentBranch = entryBranch
      const msgId = getMessageId(entry)
      if (msgId && seenMsgIds.has(msgId)) continue
      if (msgId) seenMsgIds.add(msgId)
      const call = parseApiCall(entry, toolResultMeta)
      if (call) {
        currentCalls.push(call)
        if (call.spawnToolUseIds) for (const id of call.spawnToolUseIds) if (!currentSpawnIds.includes(id)) currentSpawnIds.push(id)
      }
      for (const advisorCall of parseAdvisorCalls(entry)) currentCalls.push(advisorCall)
    } else if (entry.type === 'pr-link') {
      const url = (entry as Record<string, unknown>)['prUrl']
      if (typeof url === 'string' && url && !currentPrRefs.includes(url)) currentPrRefs.push(url)
    }
  }

  if (currentCalls.length > 0) {
    turns.push({
      userMessage: currentUserMessage,
      assistantCalls: currentCalls,
      timestamp: currentTimestamp,
      sessionId: currentSessionId,
      ...(currentBranch ? { gitBranch: currentBranch } : {}),
      ...(currentPrRefs.length > 0 ? { prRefs: [...currentPrRefs].sort() } : {}),
      ...(currentSpawnIds.length > 0 ? { spawnToolUseIds: currentSpawnIds } : {}),
    })
  }

  return turns
}

// Map each subagent-spawn `tool_use` id to the PR set active at the turn that
// emitted it, walking the FULL turn list in order. A turn's own `prRefs` apply to
// spawns within it; otherwise the carried set does. First occurrence of a spawn id
// wins deterministically (tool_use ids are unique in practice; this only guards a
// pathological restatement). Drives cross-range subagent PR attribution.
export function buildSpawnPrSets(turns: Array<{ prRefs?: string[]; spawnToolUseIds?: string[] }>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  let cur: string[] = []
  for (const turn of turns) {
    const active = turn.prRefs?.length ? turn.prRefs : cur
    for (const id of turn.spawnToolUseIds ?? []) if (!(id in out)) out[id] = active
    if (turn.prRefs?.length) cur = turn.prRefs
  }
  return out
}

/**
 * Extract MCP tool inventory observed across a session's JSONL entries.
 *
 * Claude Code emits `attachment.type === "deferred_tools_delta"` entries whose
 * `addedNames` array lists every tool currently available at that turn (built-in
 * tools plus all `mcp__<server>__<tool>` names exposed by configured MCP
 * servers). Tool inventory can change mid-session if the user reloads MCP
 * config, so we union every occurrence rather than trusting only the first.
 *
 * Built-in tools are filtered out: only `mcp__*` identifiers survive.
 */
// Fully-qualified MCP tool name shape: `mcp__<server>__<tool>`. Both server
// and tool segments must be non-empty. Names like `mcp__server` (no tool
// segment) or `mcp__server__` (trailing empty tool) would silently pollute
// the inventory and break downstream `split('__')` consumers, so they're
// rejected here.
function isMcpToolName(name: string): boolean {
  if (!name.startsWith('mcp__')) return false
  const rest = name.slice(5) // strip `mcp__`
  const sep = rest.indexOf('__')
  if (sep <= 0) return false                   // missing or empty server
  if (sep >= rest.length - 2) return false     // missing or empty tool
  return true
}

export function extractMcpInventory(entries: JournalEntry[]): string[] {
  const inventory = new Set<string>()
  for (const entry of entries) {
    const att = entry['attachment']
    if (!att || typeof att !== 'object') continue
    const a = att as { type?: unknown; addedNames?: unknown }
    if (a.type !== 'deferred_tools_delta') continue
    if (!Array.isArray(a.addedNames)) continue
    for (const name of a.addedNames) {
      if (typeof name !== 'string') continue
      if (!isMcpToolName(name)) continue
      inventory.add(name)
    }
  }
  if (inventory.size === 0) return []
  return Array.from(inventory).sort()
}

function extractCanonicalCwd(entries: JournalEntry[]): string | undefined {
  for (const entry of entries) {
    if (typeof entry.cwd !== 'string') continue
    const cwd = entry.cwd.trim()
    if (cwd) return cwd
  }
  return undefined
}

function buildSessionSummary(
  sessionId: string,
  project: string,
  turns: ClassifiedTurn[],
  mcpInventory?: string[],
  source?: SessionSourceMetadata,
): SessionSummary {
  const modelBreakdown: SessionSummary['modelBreakdown'] = Object.create(null)
  const toolBreakdown: SessionSummary['toolBreakdown'] = Object.create(null)
  const mcpBreakdown: SessionSummary['mcpBreakdown'] = Object.create(null)
  const bashBreakdown: SessionSummary['bashBreakdown'] = Object.create(null)
  const categoryBreakdown: SessionSummary['categoryBreakdown'] = Object.create(null)
  const skillBreakdown: SessionSummary['skillBreakdown'] = Object.create(null)
  const subagentBreakdown: SessionSummary['subagentBreakdown'] = Object.create(null)

  let totalCost = 0
  let totalSavings = 0
  let totalEstimated = 0
  let totalInput = 0
  let totalOutput = 0
  let totalReasoning = 0
  let totalCacheRead = 0
  let totalCacheWrite = 0
  let apiCalls = 0
  let firstTs = ''
  let lastTs = ''

  for (const turn of turns) {
    const turnCost = turn.assistantCalls.reduce((s, c) => s + c.costUSD, 0)
    const turnSavings = turn.assistantCalls.reduce((s, c) => s + (c.savingsUSD ?? 0), 0)

    if (!categoryBreakdown[turn.category]) {
      categoryBreakdown[turn.category] = { turns: 0, costUSD: 0, savingsUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 }
    }
    categoryBreakdown[turn.category].turns++
    categoryBreakdown[turn.category].costUSD += turnCost
    categoryBreakdown[turn.category].savingsUSD += turnSavings
    if (turn.hasEdits) {
      categoryBreakdown[turn.category].editTurns++
      categoryBreakdown[turn.category].retries += turn.retries
      if (turn.retries === 0) categoryBreakdown[turn.category].oneShotTurns++
    }

    if (turn.subCategory) {
      const skillKey = turn.subCategory
      if (!skillBreakdown[skillKey]) {
        skillBreakdown[skillKey] = { turns: 0, costUSD: 0, savingsUSD: 0, editTurns: 0, oneShotTurns: 0 }
      }
      skillBreakdown[skillKey].turns++
      skillBreakdown[skillKey].costUSD += turnCost
      skillBreakdown[skillKey].savingsUSD += turnSavings
      if (turn.hasEdits) {
        skillBreakdown[skillKey].editTurns++
        if (turn.retries === 0) skillBreakdown[skillKey].oneShotTurns++
      }
    }

    for (const call of turn.assistantCalls) {
      const callSavings = call.savingsUSD ?? 0
      const callEstimated = call.isEstimated ? call.costUSD : 0
      totalCost += call.costUSD
      totalSavings += callSavings
      totalEstimated += callEstimated
      totalInput += call.usage.inputTokens
      totalOutput += call.usage.outputTokens
      totalReasoning += call.usage.reasoningTokens
      totalCacheRead += call.usage.cacheReadInputTokens
      totalCacheWrite += call.usage.cacheCreationInputTokens
      apiCalls++

      const modelKey = call.provider === 'devin' ? call.model : getShortModelName(call.model)
      if (!modelBreakdown[modelKey]) {
        modelBreakdown[modelKey] = {
          calls: 0,
          costUSD: 0,
          savingsUSD: 0,
          estimatedCostUSD: 0,
          tokens: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0 },
        }
      }
      modelBreakdown[modelKey].calls++
      modelBreakdown[modelKey].costUSD += call.costUSD
      modelBreakdown[modelKey].savingsUSD += callSavings
      modelBreakdown[modelKey].estimatedCostUSD = (modelBreakdown[modelKey].estimatedCostUSD ?? 0) + callEstimated
      modelBreakdown[modelKey].tokens.inputTokens += call.usage.inputTokens
      modelBreakdown[modelKey].tokens.outputTokens += call.usage.outputTokens
      modelBreakdown[modelKey].tokens.cacheReadInputTokens += call.usage.cacheReadInputTokens
      modelBreakdown[modelKey].tokens.cacheCreationInputTokens += call.usage.cacheCreationInputTokens
      modelBreakdown[modelKey].tokens.reasoningTokens += call.usage.reasoningTokens

      for (const tool of extractCoreTools(call.tools)) {
        toolBreakdown[tool] = toolBreakdown[tool] ?? { calls: 0 }
        toolBreakdown[tool].calls++
      }
      for (const mcp of call.mcpTools) {
        const server = mcp.split('__')[1] ?? mcp
        mcpBreakdown[server] = mcpBreakdown[server] ?? { calls: 0 }
        mcpBreakdown[server].calls++
      }
      for (const cmd of call.bashCommands) {
        bashBreakdown[cmd] = bashBreakdown[cmd] ?? { calls: 0 }
        bashBreakdown[cmd].calls++
      }
      for (const sat of call.subagentTypes) {
        subagentBreakdown[sat] = subagentBreakdown[sat] ?? { calls: 0, costUSD: 0, savingsUSD: 0 }
        subagentBreakdown[sat].calls++
        subagentBreakdown[sat].costUSD += call.costUSD
        subagentBreakdown[sat].savingsUSD += callSavings
      }

      if (!firstTs || call.timestamp < firstTs) firstTs = call.timestamp
      if (!lastTs || call.timestamp > lastTs) lastTs = call.timestamp
    }
  }

  return {
    sessionId,
    project,
    firstTimestamp: firstTs || turns[0]?.timestamp || '',
    lastTimestamp: lastTs || turns[turns.length - 1]?.timestamp || '',
    totalCostUSD: totalCost,
    totalSavingsUSD: totalSavings,
    totalEstimatedCostUSD: totalEstimated,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalReasoningTokens: totalReasoning,
    totalCacheReadTokens: totalCacheRead,
    totalCacheWriteTokens: totalCacheWrite,
    apiCalls,
    turns,
    modelBreakdown,
    toolBreakdown,
    mcpBreakdown,
    bashBreakdown,
    categoryBreakdown,
    skillBreakdown,
    subagentBreakdown,
    ...(source ? { source } : {}),
    ...(mcpInventory && mcpInventory.length > 0 ? { mcpInventory } : {}),
  }
}

async function parseSessionFile(
  filePath: string,
  project: string,
  seenMsgIds: Set<string>,
  dateRange?: DateRange,
): Promise<{ session: SessionSummary; canonicalCwd?: string } | null> {
  // Skip files whose mtime is older than the range start. A session file
  // can only contain entries up to its last-modified time; if that predates
  // the requested range, nothing in this file can match.
  if (dateRange) {
    try {
      const s = await stat(filePath)
      if (s.mtimeMs < dateRange.start.getTime()) return null
    } catch { /* fall through to normal read; missing stat shouldn't break parsing */ }
  }
  const entries: JournalEntry[] = []
  let hasLines = false

  // When a dateRange is given, skip user/assistant lines whose timestamp
  // is older than range.start - 24h without calling JSON.parse. Huge lines
  // that cannot be skipped are yielded as Buffers and compact-parsed without
  // converting the whole line into a V8 string.
  const earlySkipThreshold = dateRange
    ? new Date(dateRange.start.getTime() - 86_400_000).toISOString()
    : null
  const skipFn = earlySkipThreshold
    ? (head: string) => shouldSkipLine(head, earlySkipThreshold)
    : undefined

  for await (const line of readSessionLines(filePath, skipFn, { largeLineAsBuffer: true })) {
    hasLines = true
    const entry = parseJsonlLine(line)
    if (entry) entries.push(compactEntry(entry))
  }

  if (!hasLines) return null

  if (entries.length === 0) return null

  const sessionId = basename(filePath, '.jsonl')
  const dedupedEntries = dedupeStreamingMessageIds(entries)
  let turns = groupIntoTurns(dedupedEntries, seenMsgIds)
  if (dateRange) {
    // Bucket a turn by the timestamp of its first assistant call (when the cost was
    // actually incurred). Filtering entries directly produced orphan assistant calls
    // when a user message sat in one day and the response landed in another -- those
    // got pushed as turns with empty timestamps, which some code paths counted and
    // others dropped, producing inconsistent Today totals.
    turns = turns.filter(turn => {
      if (turn.assistantCalls.length === 0) return false
      const firstCallTs = turn.assistantCalls[0]!.timestamp
      if (!firstCallTs) return false
      const ts = new Date(firstCallTs)
      return ts >= dateRange.start && ts <= dateRange.end
    })
    if (turns.length === 0) return null
  }
  const classified = turns.map(classifyTurn)

  // Inventory is extracted from the full entry stream, not just the
  // turns we kept after date filtering: tool availability is set up
  // once at the start of a session (with possible mid-session reloads),
  // and we want to reflect what was loaded even if the user only ran
  // turns inside a narrow date window.
  const mcpInventory = extractMcpInventory(entries)
  const canonicalCwd = extractCanonicalCwd(entries)

  return {
    session: buildSessionSummary(sessionId, project, classified, mcpInventory),
    ...(canonicalCwd ? { canonicalCwd } : {}),
  }
}

// Recursively collect every `.jsonl` under `dir`. Subagent transcripts live in
// `subagents/`, and workflow/ultracode runs nest a further level deep
// (`subagents/workflows/<wf>/agent-*.jsonl`); a flat scan misses those, so their
// usage went uncounted whenever the workflow feature was on. (#470)
async function collectJsonlInto(dir: string, out: Set<string>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await collectJsonlInto(p, out)
    else if (e.name.endsWith('.jsonl')) out.add(p)
  }
}

export async function collectJsonlFiles(dirPath: string): Promise<string[]> {
  const files = await readdir(dirPath).catch(() => [])
  const jsonlFiles = new Set(files.filter(f => f.endsWith('.jsonl')).map(f => join(dirPath, f)))

  await collectJsonlInto(join(dirPath, 'subagents'), jsonlFiles)
  for (const entry of files) {
    if (entry.endsWith('.jsonl')) continue
    await collectJsonlInto(join(dirPath, entry, 'subagents'), jsonlFiles)
  }

  return [...jsonlFiles]
}

// Claude Code subagent transcripts (`subagents/.../agent-*.jsonl`) have a sibling
// `.meta.json` carrying the `agentType` (e.g. `workflow-subagent`, `Explore`).
// Returns undefined for ordinary session files, which carry no agent type.
export async function readAgentType(filePath: string): Promise<string | undefined> {
  if (!/[\\/]subagents[\\/]/.test(filePath)) return undefined
  const metaPath = filePath.replace(/\.jsonl$/, '.meta.json')
  try {
    const t = (JSON.parse(await readFile(metaPath, 'utf8')) as { agentType?: unknown }).agentType
    if (typeof t === 'string' && t.trim()) return t.trim().slice(0, 100)
  } catch { /* missing or unreadable meta */ }
  // Workflow agents always live under `subagents/workflows/`, so fall back to that
  // even when the meta sidecar is absent.
  return /[\\/]subagents[\\/]workflows[\\/]/.test(filePath) ? 'workflow-subagent' : undefined
}

async function scanProjectDirs(
  dirs: Array<{ path: string; name: string; source?: SessionSourceMetadata }>,
  seenMsgIds: Set<string>,
  diskCache: SessionCache,
  dateRange?: DateRange,
  // Cold-run robustness: called after every parsed Claude file so a throttled
  // caller (parseAllSessions) can persist partial progress. A run killed
  // mid-scan then resumes from a warm cache instead of re-parsing from zero.
  onFileParsed?: () => Promise<void>,
  readOnly = false,
): Promise<ProjectSummary[]> {
  const section = getOrCreateProviderSection(diskCache, 'claude')
  const allDiscoveredFiles = new Set<string>()

  type FileInfo = { dirName: string; fp: NonNullable<Awaited<ReturnType<typeof fingerprintFile>>>; source?: SessionSourceMetadata }
  const unchangedFiles: Array<{ filePath: string; dirName: string; source?: SessionSourceMetadata; cached: CachedFile }> = []
  const changedFiles: Array<{ filePath: string; info: FileInfo; append?: { cached: CachedFile; readFromOffset: number } }> = []

  const discoverProgress = createScanProgress('scanning claude project dirs', dirs.length)
  let dirsDone = 0
  for (const { path: dirPath, name: dirName, source } of dirs) {
    const jsonlFiles = await collectJsonlFiles(dirPath)
    for (const filePath of jsonlFiles) {
      allDiscoveredFiles.add(filePath)
      const fp = await fingerprintFile(filePath)
      if (!fp) continue

      const cached = section.files[filePath]
      const action = reconcileFile(fp, cached)
      if (cached && (readOnly || action.action === 'unchanged')) {
        unchangedFiles.push({ filePath, dirName, source, cached: section.files[filePath]! })
      } else if (!readOnly) {
        if (action.action === 'appended') {
          changedFiles.push({
            filePath,
            info: { dirName, fp, source },
            append: { cached: section.files[filePath]!, readFromOffset: action.readFromOffset },
          })
          continue
        }
        changedFiles.push({ filePath, info: { dirName, fp, source } })
      }
    }
    dirsDone++
    await discoverProgress.tick(dirsDone)
  }
  discoverProgress.finish()

  // Orphans: cached sessions whose source file is no longer discovered. In
  // read-only mode surface them all (the snapshot is authoritative, nothing is
  // being pruned). In write mode surface only PR-bearing orphans: their transcript
  // is gone and can never re-parse, but they carry attributable PR spend the by-PR
  // report must keep (as a legacy even-split); the eviction below preserves the
  // same set so `section.files` still holds them when summaries are built.
  for (const [filePath, cached] of Object.entries(section.files)) {
    if (allDiscoveredFiles.has(filePath)) continue
    if (!readOnly && !cached.prLinks?.length) continue
    const dirName = cached.canonicalProjectName
      ?? cached.turns[0]?.calls[0]?.project
      ?? basename(dirname(filePath))
    unchangedFiles.push({ filePath, dirName, cached })
  }

  // Pre-seed dedup set from cached (unchanged) files
  for (const { cached } of unchangedFiles) {
    for (const turn of cached.turns) {
      for (const call of turn.calls) {
        seenMsgIds.add(call.deduplicationKey)
      }
    }
  }

  const parseProgress = createScanProgress('parsing changed claude sessions', changedFiles.length)
  const progressTotal = changedFiles.length
  let filesDone = 0
  emitScanProgress({ kind: 'tick', provider: 'claude', done: 0, total: progressTotal })
  for (const { filePath, info, append } of changedFiles) {
    delete section.files[filePath]

    try {
      if (append) {
        // Append-only growth: parse ONLY the bytes past the cached resume offset
        // and merge with the cached turns, rather than re-reading the file from 0.
        // On a studio machine where live agents constantly append to session
        // JSONL, this is the dominant warm-run cost. The merged result is
        // byte-for-byte identical to a full re-parse (see mergeBoundaryCalls).
        const tracker = { lastCompleteLineOffset: append.readFromOffset }
        const toolResultMeta = new Map<string, ToolResultMeta>()
        const sessionMeta = emptySessionMeta()
        const newEntries = await parseClaudeEntries(filePath, tracker, append.readFromOffset, { toolResultMeta, sessionMeta })
        const cached = append.cached

        // Straddle guard: a streamed assistant message id that first appeared in
        // the committed prefix can be restated inside the appended region
        // (image-heavy turns stream one id across several records over seconds).
        // The appended region is grouped before this file's cached keys join
        // seenMsgIds, so the restated id would count twice; suppressing it
        // instead would freeze the stale first emission. Neither matches a full
        // re-parse, so on any id overlap the shortcut is abandoned and the file
        // re-parses from byte 0 (rare: ~0.3% of real files).
        const cachedIds = new Set(cached.turns.flatMap(t => t.calls.map(c => c.deduplicationKey)))
        const straddles = newEntries !== null && newEntries.some(e => {
          const id = getMessageId(e)
          return id !== null && cachedIds.has(id)
        })
        if (!straddles) {
          const newTurns = newEntries
            ? parsedTurnsToCachedTurns(groupIntoTurns(dedupeStreamingMessageIds(newEntries), seenMsgIds, toolResultMeta))
            : []

          const mergedTurns: CachedTurn[] = cached.turns.map(t => ({ ...t, calls: [...t.calls] }))
          if (newTurns.length > 0) {
            let startIdx = 0
            // A first new turn with no leading user message is a continuation of
            // the last cached turn — merge its calls in (a full re-parse would put
            // them in that same turn), then append the remaining new turns.
            if (!newTurns[0]!.userMessage.trim() && mergedTurns.length > 0) {
              const last = mergedTurns[mergedTurns.length - 1]!
              last.calls = mergeBoundaryCalls(last.calls, newTurns[0]!.calls)
              // A PR referenced in the appended continuation belongs to this same
              // turn: union its refs in so the shortcut matches a full re-parse.
              const refs = Array.from(new Set([...(last.prRefs ?? []), ...(newTurns[0]!.prRefs ?? [])])).sort()
              if (refs.length > 0) last.prRefs = refs
              // A subagent spawned in the appended continuation belongs to this
              // same turn: union its spawn ids in for the same reason.
              const spawnIds = Array.from(new Set([...(last.spawnToolUseIds ?? []), ...(newTurns[0]!.spawnToolUseIds ?? [])]))
              if (spawnIds.length > 0) last.spawnToolUseIds = spawnIds
              startIdx = 1
            }
            for (let i = startIdx; i < newTurns.length; i++) mergedTurns.push(newTurns[i]!)
          }

          // The cached region's dedup keys were not added to seenMsgIds (only
          // unchanged files pre-seed it), so add them now — a full re-parse would
          // have, and later files dedup cross-file against them.
          for (const t of cached.turns) for (const c of t.calls) seenMsgIds.add(c.deduplicationKey)

          // First-cwd wins, and the first cwd lives in the cached region whenever
          // one was resolved there; only re-derive if the cached region had none.
          let canonicalCwd = cached.canonicalCwd
          let canonicalProjectName = cached.canonicalProjectName
          let workingDirectory = cached.workingDirectory
          if (canonicalCwd === undefined && newEntries) {
            const cwd = extractCanonicalCwd(newEntries)
            workingDirectory = workingDirectory ?? cwd
            const canonical = (cwd && !isCoworkSession(cwd, filePath)) ? await resolveCanonicalProjectPath(cwd) : undefined
            canonicalCwd = canonical?.path
            canonicalProjectName = canonical?.isWorktree ? projectNameFromPath(canonical.path, info.dirName) : undefined
          }

          // Inventory is a sorted set union; cached (older entries) ∪ new = full.
          const mcpInventory = newEntries
            ? Array.from(new Set([...cached.mcpInventory, ...extractMcpInventory(newEntries)])).sort()
            : cached.mcpInventory

          // Session meta merges across the append boundary: title is last-wins
          // (prefer the newly-parsed tail), PR links union, isSidechain is sticky.
          // parentSessionId is sticky (cached-first, it is the earliest region);
          // agentSpawnLinks union (cached-first, first-seen spawn id per agent wins).
          const mergedTitle = sessionMeta.title ?? cached.title
          const mergedPrLinks = Array.from(new Set([...(cached.prLinks ?? []), ...sessionMeta.prLinks]))
          const mergedSidechain = cached.isSidechain === true || sessionMeta.isSidechain
          const mergedParentSessionId = cached.parentSessionId ?? sessionMeta.parentSessionId
          const mergedSpawnLinks = { ...sessionMeta.agentSpawnLinks, ...cached.agentSpawnLinks }
          const mergedAmbiguousIds = Array.from(new Set([...(cached.ambiguousSpawnAgentIds ?? []), ...sessionMeta.ambiguousSpawnAgentIds]))

          section.files[filePath] = {
            fingerprint: info.fp,
            lastCompleteLineOffset: tracker.lastCompleteLineOffset,
            canonicalCwd,
            ...(workingDirectory ? { workingDirectory } : {}),
            canonicalProjectName,
            mcpInventory,
            turns: mergedTurns,
            agentType: cached.agentType,
            ...(mergedTitle ? { title: mergedTitle } : {}),
            ...(mergedPrLinks.length > 0 ? { prLinks: mergedPrLinks } : {}),
            ...(mergedSidechain ? { isSidechain: true } : {}),
            ...(mergedParentSessionId ? { parentSessionId: mergedParentSessionId } : {}),
            ...(Object.keys(mergedSpawnLinks).length > 0 ? { agentSpawnLinks: mergedSpawnLinks } : {}),
            ...(mergedAmbiguousIds.length > 0 ? { ambiguousSpawnAgentIds: mergedAmbiguousIds } : {}),
          }
          ;(diskCache as { _dirty?: boolean })._dirty = true
          filesDone++
          await parseProgress.tick(filesDone)
          if (filesDone % 50 === 0 || filesDone === progressTotal) {
            emitScanProgress({ kind: 'tick', provider: 'claude', done: filesDone, total: progressTotal })
          }
          if (onFileParsed) await onFileParsed()
          continue
        }
        // Straddled: fall through to the full re-parse below.
      }

      const tracker = { lastCompleteLineOffset: 0 }
      const toolResultMeta = new Map<string, ToolResultMeta>()
      const sessionMeta = emptySessionMeta()
      const entries = await parseClaudeEntries(filePath, tracker, undefined, { toolResultMeta, sessionMeta })
      if (!entries) { filesDone++; await parseProgress.tick(filesDone); continue }

      const turns = groupIntoTurns(dedupeStreamingMessageIds(entries), seenMsgIds, toolResultMeta)
      const cwd = extractCanonicalCwd(entries)
      const canonical = (cwd && !isCoworkSession(cwd, filePath)) ? await resolveCanonicalProjectPath(cwd) : undefined
      section.files[filePath] = {
        fingerprint: info.fp,
        lastCompleteLineOffset: tracker.lastCompleteLineOffset,
        canonicalCwd: canonical?.path,
        ...(cwd ? { workingDirectory: cwd } : {}),
        canonicalProjectName: canonical?.isWorktree ? projectNameFromPath(canonical.path, info.dirName) : undefined,
        mcpInventory: extractMcpInventory(entries),
        turns: parsedTurnsToCachedTurns(turns),
        agentType: await readAgentType(filePath),
        ...(sessionMeta.title ? { title: sessionMeta.title } : {}),
        ...(sessionMeta.prLinks.length > 0 ? { prLinks: sessionMeta.prLinks } : {}),
        ...(sessionMeta.isSidechain ? { isSidechain: true } : {}),
        ...(sessionMeta.parentSessionId ? { parentSessionId: sessionMeta.parentSessionId } : {}),
        ...(Object.keys(sessionMeta.agentSpawnLinks).length > 0 ? { agentSpawnLinks: sessionMeta.agentSpawnLinks } : {}),
        ...(sessionMeta.ambiguousSpawnAgentIds.length > 0 ? { ambiguousSpawnAgentIds: sessionMeta.ambiguousSpawnAgentIds } : {}),
      }
      ;(diskCache as { _dirty?: boolean })._dirty = true
    } catch (err) {
      // A single malformed Claude session file must not abort the whole run — that
      // would empty the daily-cache backfill and wipe the trend/history (issue #441,
      // same isolation the provider path already has). Record a failure marker keyed
      // by the current fingerprint so it isn't re-read and re-thrown every run; it
      // re-parses only if the file changes.
      section.files[filePath] = { fingerprint: info.fp, mcpInventory: [], turns: [], failed: true }
      ;(diskCache as { _dirty?: boolean })._dirty = true
      warnProviderParseFailure('claude', filePath, err)
    }
    filesDone++
    await parseProgress.tick(filesDone)
    // Machine-readable tick for the app splash (throttled to ~every 50 files so
    // a large cold run doesn't flood stderr), plus a partial-progress save.
    if (filesDone % 50 === 0 || filesDone === progressTotal) {
      emitScanProgress({ kind: 'tick', provider: 'claude', done: filesDone, total: progressTotal })
    }
    if (onFileParsed) await onFileParsed()
  }
  parseProgress.finish()

  if (!readOnly && dirs.length > 0) {
    for (const cachedPath of Object.keys(section.files)) {
      if (allDiscoveredFiles.has(cachedPath)) continue
      // Keep PR-bearing orphans: their transcript is gone and can never re-parse,
      // but they carry attributable PR spend (surfaced above as a legacy split).
      if (section.files[cachedPath]?.prLinks?.length) continue
      delete section.files[cachedPath]
      ;(diskCache as { _dirty?: boolean })._dirty = true
    }
  }

  const projectMap = new Map<string, { project: string; projectPath: string; sessions: SessionSummary[]; anchors: SessionSummary[]; dirNames: Set<string> }>()

  const allFiles = [
    ...unchangedFiles.map(f => ({ filePath: f.filePath, dirName: f.dirName, source: f.source })),
    ...changedFiles.map(f => ({ filePath: f.filePath, dirName: f.info.dirName, source: f.info.source })),
  ]

  for (const { filePath, dirName, source } of allFiles) {
    const cachedFile = section.files[filePath]
    if (!cachedFile || cachedFile.turns.length === 0) continue

    // Carry the git branch forward BEFORE the date filter below: the cache
    // stores a turn's branch only when it changes, so resolving here (over the
    // full ordered turn list) means a later date slice can drop the anchor turn
    // without the surviving turns losing their branch.
    let carriedBranch: string | undefined
    // The PR set active going into the report range: carried across the FULL turn
    // list, frozen the moment the first in-range turn is reached. Lets per-turn PR
    // attribution seed from a reference made before the window (see
    // attributeSessionPrSpend); the branch carry above solves the same problem.
    let carriedPrRefs: string[] | undefined
    let prRefsAtRangeStart: string[] | undefined
    let frozePrRefs = !dateRange
    let classifiedTurns = cachedFile.turns.map(turn => {
      if (turn.gitBranch) carriedBranch = turn.gitBranch
      if (dateRange && !frozePrRefs) {
        const firstTs = turn.calls[0]?.timestamp
        if (firstTs && new Date(firstTs) >= dateRange.start) {
          prRefsAtRangeStart = carriedPrRefs
          frozePrRefs = true
        }
      }
      if (turn.prRefs?.length) carriedPrRefs = turn.prRefs
      return cachedTurnToClassified(turn, carriedBranch)
    })
    // Captured from the FULL turn list, before the date slice below can drop the
    // turn a branch was first seen on. Lets the by-branch report keep this
    // session's in-range unbranched spend as `null` instead of discarding it.
    const everHadBranch = carriedBranch !== undefined

    // Built from the FULL (pre-slice) turn list: each subagent-spawn tool_use id ->
    // the PR set active at the turn that emitted it. Lets a subagent fold into the
    // right PR even when its launching turn is later sliced out of range. Only for
    // sessions that both spawned subagents and referenced a PR.
    const spawnPrSets = cachedFile.prLinks?.length ? buildSpawnPrSets(cachedFile.turns) : {}

    if (dateRange) {
      classifiedTurns = classifiedTurns.filter(turn => {
        if (turn.assistantCalls.length === 0) return false
        const firstCallTs = turn.assistantCalls[0]!.timestamp
        if (!firstCallTs) return false
        const ts = new Date(firstCallTs)
        return ts >= dateRange.start && ts <= dateRange.end
      })
    }

    // A PR-linked parent that spawned subagents is kept even when its OWN turns all
    // fall out of range, as a 0-cost fold ANCHOR: an in-range child (an async agent
    // that outlived the parent's last in-range turn) still needs the parent's
    // `prLinks` / `spawnPrSets` to attribute. An anchor carries no in-range spend
    // and is stored OUTSIDE `sessions` (see subagentAnchors) so it never
    // contaminates session counts, averages, or any other per-session report.
    const isSpawnAnchor = Object.keys(spawnPrSets).length > 0 && cachedFile.isSidechain !== true
    const anchorOnly = classifiedTurns.length === 0 && isSpawnAnchor
    if (classifiedTurns.length === 0 && !isSpawnAnchor) continue

    const sessionId = basename(filePath, '.jsonl')
    const projectPath = cachedFile.canonicalCwd ?? claudeSlugFallbackPath(dirName)
    const projectName = cachedFile.canonicalProjectName ?? dirName
    const mcpInv = cachedFile.mcpInventory.length > 0 ? cachedFile.mcpInventory : undefined
    const session = buildSessionSummary(sessionId, projectName, classifiedTurns, mcpInv, source)
    if (cachedFile.workingDirectory) session.workingDirectory = cachedFile.workingDirectory
    session.agentType = cachedFile.agentType
    if (everHadBranch) session.everHadBranch = true
    const observedPrLinks = new Set(classifiedTurns.flatMap(turn => turn.prRefs ?? []))
    for (const link of cachedFile.prLinks ?? []) observedPrLinks.add(link)
    if (observedPrLinks.size) {
      session.prLinks = [...observedPrLinks].sort()
      session.prAttributionSource = cachedFile.prLinks?.length ? 'transcript' : 'explicit-reference'
    }
    if (prRefsAtRangeStart?.length) session.prRefsAtRangeStart = prRefsAtRangeStart
    if (cachedFile.title) session.title = cachedFile.title
    // Sidechain linkage: carry the parent id (the transcript's internal
    // `sessionId`, authoritative even when it disagrees with the owning directory
    // on a resumed session) and derive the agent id from the `agent-<agentId>`
    // filename. A sidechain whose parent id was never captured stays standalone.
    if (cachedFile.isSidechain) {
      if (cachedFile.parentSessionId) session.parentSessionId = cachedFile.parentSessionId
      session.agentId = sessionId.startsWith('agent-') ? sessionId.slice('agent-'.length) : sessionId
    }
    // Parent linkage maps (only present on sessions that spawned subagents).
    if (cachedFile.agentSpawnLinks && Object.keys(cachedFile.agentSpawnLinks).length > 0) {
      session.agentSpawnLinks = cachedFile.agentSpawnLinks
    }
    if (cachedFile.ambiguousSpawnAgentIds?.length) session.ambiguousSpawnAgentIds = cachedFile.ambiguousSpawnAgentIds
    if (Object.keys(spawnPrSets).length > 0) session.spawnPrSets = spawnPrSets

    if (session.apiCalls > 0 || anchorOnly) {
      const projectKey = cachedFile.canonicalCwd
        ? normalizeProjectPathKey(cachedFile.canonicalCwd)
        : `slug:${dirName}`
      const existing = projectMap.get(projectKey)
      // An anchor (no in-range spend) goes into a separate bucket, never `sessions`.
      const target = existing ?? { project: projectName, projectPath, sessions: [], anchors: [], dirNames: new Set([dirName]) }
      if (anchorOnly) target.anchors.push(session)
      else target.sessions.push(session)
      target.dirNames.add(dirName)
      if (!existing) projectMap.set(projectKey, target)
    }
  }

  // Fold slug-keyed entries into cwd-keyed entries
  const cwdKeyByDirName = new Map<string, string>()
  for (const [key, entry] of projectMap) {
    if (key.startsWith('slug:')) continue
    for (const dirName of entry.dirNames) {
      if (!cwdKeyByDirName.has(dirName)) cwdKeyByDirName.set(dirName, key)
    }
  }
  for (const [key, entry] of [...projectMap]) {
    if (!key.startsWith('slug:')) continue
    const cwdKey = cwdKeyByDirName.get(entry.project)
    if (!cwdKey) continue
    const target = projectMap.get(cwdKey)!
    target.sessions.push(...entry.sessions)
    target.anchors.push(...entry.anchors)
    projectMap.delete(key)
  }

  const projects: ProjectSummary[] = []
  for (const { project, projectPath, sessions, anchors } of projectMap.values()) {
    projects.push(summarizeProject(project, projectPath, sessions, anchors))
  }

  return projects
}

/// Build a ProjectSummary from its sessions, rolling up cost/savings/calls and
/// deriving the proxy attribution. This is the single place proxy matching
/// happens: a project whose canonical path is under a configured `proxyPaths`
/// prefix keeps its full API-rate `totalCostUSD` but records that amount as
/// `totalProxiedCostUSD` (subscription-covered). All ProjectSummary callers go
/// through here so the rule stays consistent across the fresh, cached, and
/// date/day-filtered paths.
function summarizeProject(project: string, projectPath: string, sessions: SessionSummary[], anchors: SessionSummary[] = []): ProjectSummary {
  const totalCostUSD = sessions.reduce((s, sess) => s + sess.totalCostUSD, 0)
  return {
    project,
    projectPath,
    sessions,
    totalCostUSD,
    totalSavingsUSD: sessions.reduce((s, sess) => s + sess.totalSavingsUSD, 0),
    totalEstimatedCostUSD: sessions.reduce((s, sess) => s + (sess.totalEstimatedCostUSD ?? 0), 0),
    totalApiCalls: sessions.reduce((s, sess) => s + sess.apiCalls, 0),
    totalProxiedCostUSD: isProxiedPath(projectPath) ? totalCostUSD : 0,
    // Fold anchors travel separately (0-cost, out of every per-session total).
    ...(anchors.length > 0 ? { subagentAnchors: anchors } : {}),
  }
}

// Provider-neutral explicit-reference capture. Every saved provider session
// passes through this boundary. Full URLs only: a bare "#123" is repository-
// ambiguous and must never silently move spend between repositories.
const PR_URL_IN_TEXT_RE = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g
export function extractPrUrlsFromText(text: string): string[] {
  return [...new Set(text.match(PR_URL_IN_TEXT_RE) ?? [])].sort()
}

function providerCallToTurn(call: ParsedProviderCall): ParsedTurn {
  const tools = call.tools
  const usage: TokenUsage = {
    inputTokens: call.inputTokens,
    outputTokens: call.outputTokens,
    cacheCreationInputTokens: call.cacheCreationInputTokens,
    cacheReadInputTokens: call.cacheReadInputTokens,
    cachedInputTokens: call.cachedInputTokens,
    reasoningTokens: call.reasoningTokens,
    webSearchRequests: call.webSearchRequests,
  }

  const apiCall: ParsedApiCall = applyLocalModelSavings({
    provider: call.provider,
    model: call.model,
    usage,
    costUSD: call.costUSD,
    tools,
    mcpTools: extractMcpTools(tools),
    skills: call.skills ?? [],
    subagentTypes: call.subagentTypes ?? [],
    hasAgentSpawn: tools.includes('Agent'),
    hasPlanMode: tools.includes('EnterPlanMode'),
    speed: call.speed,
    timestamp: call.timestamp,
    bashCommands: call.bashCommands,
    deduplicationKey: call.deduplicationKey,
    isEstimated: call.costIsEstimated,
  })

  const prRefs = extractPrUrlsFromText(call.userMessage)
  return {
    userMessage: call.userMessage,
    assistantCalls: [apiCall],
    timestamp: call.timestamp,
    sessionId: call.sessionId,
    ...(prRefs.length ? { prRefs } : {}),
  }
}

// ── Cache Conversion ───────────────────────────────────────────────────

function providerCallToCachedCall(call: ParsedProviderCall): CachedCall {
  return {
    provider: call.provider,
    model: call.model,
    usage: {
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      cacheCreationInputTokens: call.cacheCreationInputTokens,
      cacheReadInputTokens: call.cacheReadInputTokens,
      cachedInputTokens: call.cachedInputTokens,
      reasoningTokens: call.reasoningTokens,
      webSearchRequests: call.webSearchRequests,
      cacheCreationOneHourTokens: 0,
    },
    costUSD: (call.provider === 'mistral-vibe' || call.provider === 'antigravity' || call.provider === 'devin' || call.provider === 'vercel-gateway' || call.provider === 'hermes' || call.provider === 'kiro' || call.provider === 'codewhale' || call.provider === 'quickdesk') ? call.costUSD : undefined,
    isEstimated: call.costIsEstimated || undefined,
    speed: call.speed,
    timestamp: call.timestamp,
    tools: call.tools,
    bashCommands: call.bashCommands,
    skills: call.skills ?? [],
    subagentTypes: call.subagentTypes ?? [],
    deduplicationKey: call.deduplicationKey,
    project: call.project,
    projectPath: call.projectPath,
    workingDirectory: call.workingDirectory,
    toolSequence: call.toolSequence,
    ...(call.locAdded ? { locAdded: call.locAdded } : {}),
    ...(call.locRemoved ? { locRemoved: call.locRemoved } : {}),
    ...(call.editFailed ? { editFailed: call.editFailed } : {}),
  }
}

async function canonicalizeProviderCallProject(call: ParsedProviderCall): Promise<ParsedProviderCall> {
  if (!call.projectPath) return call

  const canonical = await resolveCanonicalProjectPath(call.projectPath)
  if (!canonical.isWorktree) return { ...call, workingDirectory: call.workingDirectory ?? call.projectPath }

  return {
    ...call,
    workingDirectory: call.workingDirectory ?? call.projectPath,
    project: projectNameFromPath(canonical.path, call.project ?? canonical.path),
    projectPath: canonical.path,
  }
}

function apiCallToCachedCall(call: ParsedApiCall): CachedCall {
  return {
    provider: call.provider,
    model: call.model,
    usage: { ...call.usage, cacheCreationOneHourTokens: call.cacheCreationOneHourTokens ?? 0 },
    isEstimated: call.isEstimated || undefined,
    speed: call.speed,
    timestamp: call.timestamp,
    tools: call.tools,
    bashCommands: call.bashCommands,
    skills: call.skills,
    subagentTypes: call.subagentTypes,
    deduplicationKey: call.deduplicationKey,
    toolSequence: call.toolSequence,
    ...(call.locAdded ? { locAdded: call.locAdded } : {}),
    ...(call.locRemoved ? { locRemoved: call.locRemoved } : {}),
    ...(call.interrupted ? { interrupted: true } : {}),
    ...(call.userModified ? { userModified: true } : {}),
    ...(call.toolErrors ? { toolErrors: call.toolErrors } : {}),
  }
}

function parsedTurnToCachedTurn(turn: ParsedTurn): CachedTurn {
  return {
    timestamp: turn.timestamp,
    sessionId: turn.sessionId,
    userMessage: turn.userMessage.slice(0, 2000),
    calls: turn.assistantCalls.map(apiCallToCachedCall),
    // Stored per-turn directly (already sorted/deduped in groupIntoTurns), unlike
    // gitBranch's change-detection dedup, so each turn's refs are self-contained.
    ...(turn.prRefs?.length ? { prRefs: turn.prRefs } : {}),
    ...(turn.spawnToolUseIds?.length ? { spawnToolUseIds: turn.spawnToolUseIds } : {}),
  }
}

// Convert a batch of parsed turns to cached turns, storing each turn's gitBranch
// only when it differs from the previous turn's branch in this batch. A report
// reconstructs a turn's branch by carrying the last stored value forward. The
// dedup is per-batch, so the first turn of an appended region always restates
// its branch (harmless: a redundant restatement, never a wrong value).
export function parsedTurnsToCachedTurns(turns: ParsedTurn[]): CachedTurn[] {
  const out: CachedTurn[] = []
  let prevBranch: string | undefined
  for (const turn of turns) {
    const cached = parsedTurnToCachedTurn(turn)
    if (turn.gitBranch && turn.gitBranch !== prevBranch) cached.gitBranch = turn.gitBranch
    if (turn.gitBranch) prevBranch = turn.gitBranch
    out.push(cached)
  }
  return out
}

function providerCallToCachedTurn(call: ParsedProviderCall): CachedTurn {
  const prRefs = extractPrUrlsFromText(call.userMessage)
  return {
    timestamp: call.timestamp,
    sessionId: call.sessionId,
    userMessage: call.userMessage.slice(0, 2000),
    calls: [providerCallToCachedCall(call)],
    ...(prRefs.length ? { prRefs } : {}),
  }
}

function providerCallsToCachedTurns(calls: ParsedProviderCall[]): CachedTurn[] {
  const turns: CachedTurn[] = []
  const grouped = new Map<string, CachedTurn>()

  for (const call of calls) {
    if (!call.turnId) {
      turns.push(providerCallToCachedTurn(call))
      continue
    }

    const key = `${call.sessionId}\0${call.turnId}`
    let turn = grouped.get(key)
    if (!turn) {
      const prRefs = extractPrUrlsFromText(call.userMessage)
      turn = {
        timestamp: call.timestamp,
        sessionId: call.sessionId,
        userMessage: call.userMessage.slice(0, 2000),
        calls: [],
        ...(prRefs.length ? { prRefs } : {}),
      }
      grouped.set(key, turn)
      turns.push(turn)
    }
    turn.calls.push(providerCallToCachedCall(call))
    const refs = extractPrUrlsFromText(call.userMessage)
    if (refs.length) turn.prRefs = [...new Set([...(turn.prRefs ?? []), ...refs])].sort()
  }

  return turns
}

function cachedCallToApiCall(call: CachedCall): ParsedApiCall {
  const u = call.usage
  const outputForCost = call.provider === 'claude'
    ? u.outputTokens
    : u.outputTokens + u.reasoningTokens
  const costUSD = calculateCost(
    call.model, u.inputTokens, outputForCost,
    u.cacheCreationInputTokens, u.cacheReadInputTokens,
    u.webSearchRequests, call.speed, u.cacheCreationOneHourTokens,
  )
  return applyLocalModelSavings({
    provider: call.provider,
    model: call.model,
    usage: {
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheCreationInputTokens: u.cacheCreationInputTokens,
      cacheReadInputTokens: u.cacheReadInputTokens,
      cachedInputTokens: u.cachedInputTokens,
      reasoningTokens: u.reasoningTokens,
      webSearchRequests: u.webSearchRequests,
    },
    costUSD: call.costUSD ?? costUSD,
    isEstimated: call.isEstimated,
    tools: call.tools,
    mcpTools: extractMcpTools(call.tools),
    skills: call.skills,
    subagentTypes: call.subagentTypes ?? [],
    hasAgentSpawn: call.tools.includes('Agent'),
    hasPlanMode: call.tools.includes('EnterPlanMode'),
    speed: call.speed,
    timestamp: call.timestamp,
    bashCommands: call.bashCommands,
    deduplicationKey: call.deduplicationKey,
    cacheCreationOneHourTokens: u.cacheCreationOneHourTokens || undefined,
    toolSequence: call.toolSequence,
  })
}

// `resolvedBranch` restores the turn's git branch after the cache's per-turn
// dedup (branch stored only when it changes). Callers that serve a full session's
// turns in order carry the last stored value forward and pass it here, so each
// reconstructed turn regains the "branch active for this turn" the cache elided —
// and downstream date/day filtering can slice turns without losing the anchor.
function cachedTurnToClassified(turn: CachedTurn, resolvedBranch?: string): ClassifiedTurn {
  const branch = turn.gitBranch ?? resolvedBranch
  const prRefs = turn.prRefs?.length ? turn.prRefs : extractPrUrlsFromText(turn.userMessage)
  const parsed: ParsedTurn = {
    userMessage: turn.userMessage,
    assistantCalls: turn.calls.map(cachedCallToApiCall),
    timestamp: turn.timestamp,
    sessionId: turn.sessionId,
    ...(branch ? { gitBranch: branch } : {}),
    ...(prRefs.length ? { prRefs } : {}),
    ...(turn.spawnToolUseIds?.length ? { spawnToolUseIds: turn.spawnToolUseIds } : {}),
  }
  return classifyTurn(parsed)
}

// ── Cache-Aware Parsing Helpers ────────────────────────────────────────

// Merge the calls of the last cached turn with the calls parsed from the
// appended region when the appended region continues that turn (its first new
// content had no leading user message). This mirrors `dedupeStreamingMessageIds`
// at the call level: a Claude message re-emitted across the append boundary
// (same `msg.id`, or the trailing not-yet-newline-terminated line re-read from
// the resume offset) collapses to its LAST occurrence, keeping the FIRST
// occurrence's timestamp — byte-for-byte what a full re-parse of the combined
// stream produces. Synthetic `claude:<ts>` keys (id-less entries) are never
// collapsed, matching `getMessageId` returning null for them.
function mergeBoundaryCalls(cachedCalls: CachedCall[], newCalls: CachedCall[]): CachedCall[] {
  const combined = [...cachedCalls, ...newCalls]
  const firstIdx = new Map<string, number>()
  const lastIdx = new Map<string, number>()
  for (let i = 0; i < combined.length; i++) {
    const key = combined[i]!.deduplicationKey
    if (key.startsWith('claude:')) continue
    if (!firstIdx.has(key)) firstIdx.set(key, i)
    lastIdx.set(key, i)
  }
  if (lastIdx.size === 0) return combined
  const result: CachedCall[] = []
  for (let i = 0; i < combined.length; i++) {
    const call = combined[i]!
    const key = call.deduplicationKey
    if (key.startsWith('claude:')) { result.push(call); continue }
    if (lastIdx.get(key) !== i) continue
    if (firstIdx.get(key) !== i) {
      result.push({ ...call, timestamp: combined[firstIdx.get(key)!]!.timestamp })
      continue
    }
    result.push(call)
  }
  return result
}

async function parseClaudeEntries(
  filePath: string,
  tracker: { lastCompleteLineOffset: number },
  startByteOffset?: number,
  // Rich-capture collectors, populated from the RAW entry before compaction
  // strips toolUseResult / ai-title / pr-link / isSidechain.
  collectors?: { toolResultMeta?: Map<string, ToolResultMeta>; sessionMeta?: SessionMeta },
): Promise<JournalEntry[] | null> {
  const entries: JournalEntry[] = []
  let hasLines = false
  for await (const line of readSessionLines(filePath, undefined, {
    largeLineAsBuffer: true,
    byteOffsetTracker: tracker,
    ...(startByteOffset !== undefined ? { startByteOffset } : {}),
  })) {
    hasLines = true
    const entry = parseJsonlLine(line)
    if (!entry) continue
    if (collectors?.toolResultMeta) collectToolResultMeta(entry, collectors.toolResultMeta)
    if (collectors?.sessionMeta) collectSessionMeta(entry, collectors.sessionMeta)
    entries.push(compactEntry(entry))
  }
  if (!hasLines || entries.length === 0) return null
  return entries
}

function getOrCreateProviderSection(cache: SessionCache, provider: string): ProviderSection {
  const envFp = computeEnvFingerprint(provider)
  const existing = cache.providers[provider]
  if (existing && existing.envFingerprint === envFp) return existing
  const section: ProviderSection = { envFingerprint: envFp, files: {} }
  // A fingerprint change (env override or parse-version bump) must re-parse
  // every present source, but for durable providers the cache is the ONLY
  // remaining record of usage whose source rows were already pruned (OTel
  // orphans). Discarding those with the section would permanently erase
  // month-to-date history that cannot be re-derived, so carry forward exactly
  // the entries whose source no longer exists; everything present on disk is
  // dropped and re-parsed under the new fingerprint.
  if (existing && DURABLE_PROVIDER_NAMES.has(provider)) {
    for (const [path, file] of Object.entries(existing.files)) {
      if (!existsSync(path)) section.files[path] = file
    }
  }
  cache.providers[provider] = section
  return section
}

function cachedFileNeedsProviderReparse(providerName: string, sourcePath: string, cached: CachedFile): boolean {
  // Antigravity data comes from the live server, not from the conversation file.
  // A 0-turn cache entry may just mean the server was unavailable last run.
  if (providerName === 'antigravity') return shouldReparseAntigravitySource(sourcePath, cached.turns.length)

  // Devin transcript usage is enriched from sessions.db. The cache fingerprint
  // only tracks the transcript JSON, so reparse to pick up DB-side project,
  // title, model, and timestamp changes.
  if (providerName === 'devin') return true

  if (providerName !== 'gemini') return false

  return cached.turns.some(turn =>
    turn.calls.some(call => call.deduplicationKey === `gemini:${turn.sessionId}`),
  )
}

const warnedProviderReadFailures = new Set<string>()

function warnProviderReadFailureOnce(providerName: string, err: unknown): void {
  const key = `${providerName}:sqlite-busy`
  if (warnedProviderReadFailures.has(key)) return
  warnedProviderReadFailures.add(key)
  if (isSqliteBusyError(err)) {
    process.stderr.write(
      `codeburn: skipped ${providerName} data because its SQLite database is temporarily locked; will retry on the next refresh.\n`
    )
  }
}

// Warn per offending file (so a systemic break surfaces more than one path),
// but cap per provider per run to avoid a flood. Cached failure markers mean a
// given broken file is only re-encountered when it changes, so this stays quiet
// across refreshes.
const parseFailureCounts = new Map<string, number>()
const PARSE_FAILURE_WARN_CAP = 5

function warnProviderParseFailure(providerName: string, sourcePath: string, err: unknown): void {
  const n = (parseFailureCounts.get(providerName) ?? 0) + 1
  parseFailureCounts.set(providerName, n)
  if (n > PARSE_FAILURE_WARN_CAP) return
  const msg = err instanceof Error ? err.message : String(err)
  const tail = n === PARSE_FAILURE_WARN_CAP
    ? ` (further ${providerName} parse failures this run are suppressed)`
    : ''
  process.stderr.write(
    `codeburn: skipped ${providerName} session that failed to parse: ${sourcePath} (${msg})${tail}\n`
  )
}

// A permission error (EPERM/EACCES) on a provider's data — e.g. a directory or
// SQLite DB the OS won't let us read without Full Disk Access. Per-file and
// discovery errors are already isolated; this catches a provider-level throw so
// one locked provider skips-and-continues instead of aborting the whole
// hydration (which would empty the cache/daily backfill for every provider).
function isPermissionError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'EPERM' || code === 'EACCES'
}

// A cold-cache scan over a large ~/.claude/projects tree (hundreds of project
// dirs, e.g. a git-worktree-per-task workflow) can run long enough that it
// looks hung, and is CPU-heavy enough on a single thread to visibly compete
// with anything else running interactively on the same machine. Two cheap
// mitigations, neither of which reduces total CPU work: (1) a `\r`-updated
// progress line so a long cold run reads as "working" instead of "stuck",
// gated on isTTY so it never corrupts piped/captured output (export.ts, the
// --no-color path, or a subprocess capturing stderr); (2) yielding to the
// event loop every YIELD_EVERY items so the OS scheduler gets regular break
// points instead of one long uninterrupted synchronous block. This does NOT
// fix CPU contention with a separate process (that's the OS scheduler's job
// regardless), it only keeps this process itself responsive and honest about
// progress during the scan.
const YIELD_EVERY = 25

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

// Suppress the scan-progress line while an interactive Ink UI is live. The
// dashboard and compare render to stdout on the same terminal, and their scans
// run (dashboard) or re-run every 30s (dashboard auto-refresh, including the
// getPlanUsages → parseAllSessions path) AFTER render() has painted a frame, so
// a `\r` progress line on stderr prints over it and garbles the screen. isTTY
// alone can't tell them apart from a plain CLI command. The interactive
// entrypoints call setInteractiveScanUI() right before render(); a pre-render
// scan (e.g. compare's cold start) still shows progress and finish() clears the
// line before Ink paints.
let interactiveScanUI = false
export function setInteractiveScanUI(active = true): void {
  interactiveScanUI = active
}

// Machine-readable scan progress for the desktop app's first-run splash. Plain
// CLI/terminal usage is untouched: emission is gated on CODEBURN_PROGRESS=1,
// which only the app's cold-start warmup spawn sets. Each event is one
// newline-delimited JSON object behind a sentinel prefix so the reader can pick
// it out of stderr that may also carry provider warnings. This is orthogonal to
// createScanProgress's `\r` TTY line (that one never fires under a piped spawn).
export const PROGRESS_LINE_PREFIX = 'CODEBURN_PROGRESS '
export type ScanProgressEvent =
  // `cold` is true only for a genuine full hydration (the on-disk cache was
  // empty). A warm launch's incremental re-parse of a handful of changed files
  // still emits `providers`/`tick`, so consumers must gate any "indexing" UI on
  // this flag, not on the mere presence of tick work.
  | { kind: 'providers'; providers: string[]; cold?: boolean }
  | { kind: 'provider'; provider: string; state: 'start' | 'done' | 'skipped'; files?: number }
  | { kind: 'tick'; provider: string; done: number; total: number }

export function emitScanProgress(event: ScanProgressEvent): void {
  if (process.env['CODEBURN_PROGRESS'] !== '1') return
  try { process.stderr.write(`${PROGRESS_LINE_PREFIX}${JSON.stringify(event)}\n`) } catch { /* stderr closed */ }
}

// Minimum spacing between partial-progress saves during a cold parse. Low enough
// that an interrupted long run loses little work, high enough that repeated
// full-cache writes never dominate a fast warm run.
const PROGRESS_SAVE_THROTTLE_MS = 5000

export function createScanProgress(label: string, total: number) {
  const show = !interactiveScanUI && total > 20 && process.stderr.isTTY === true
  let lastWrite = 0
  return {
    async tick(done: number): Promise<void> {
      if (done % YIELD_EVERY === 0) await yieldToEventLoop()
      if (!show) return
      const now = Date.now()
      if (done !== total && now - lastWrite < 100) return
      lastWrite = now
      process.stderr.write(`\rcodeburn: ${label} ${done}/${total}…`)
    },
    finish(): void {
      if (!show) return
      process.stderr.write('\r\x1b[K')
    },
  }
}

async function parseProviderSources(
  providerName: string,
  sources: SessionSource[],
  seenKeys: Set<string>,
  diskCache: SessionCache,
  dateRange?: DateRange,
  readOnly = false,
): Promise<ProjectSummary[]> {
  const provider = await getProvider(providerName)
  if (!provider) return []

  const section = getOrCreateProviderSection(diskCache, providerName)
  const allDiscoveredFiles = new Set<string>()
  const servedSources = [...sources]

  type SourceInfo = { source: SessionSource; fp: NonNullable<Awaited<ReturnType<typeof fingerprintFile>>> }
  const unchangedSources: Array<{ source: SessionSource; cached: CachedFile }> = []
  const changedSources: SourceInfo[] = []

  for (const source of sources) {
    allDiscoveredFiles.add(source.path)

    // Network providers (e.g. Vercel AI Gateway) have no on-disk file — their data
    // comes from a live API fetch in createSessionParser. There's nothing to
    // fingerprint or incrementally cache, so re-fetch every run with a synthetic
    // fingerprint (mtime=now so the date-range filter below never excludes it).
    if (provider.network && !readOnly) {
      changedSources.push({ source, fp: { dev: 0, ino: 0, mtimeMs: Date.now(), sizeBytes: 0 } })
      continue
    }

    const fp = await fingerprintFile(source.path)
    if (!fp) continue

    const cached = section.files[source.path]
    const action = reconcileFile(fp, cached)
    // A cached parse failure at this same fingerprint stays skipped — don't
    // re-read a file that already threw and hasn't changed. It re-parses only
    // when the file changes (then `reconcileFile` reports non-'unchanged').
    if (cached && (readOnly || (action.action === 'unchanged' && (cached.failed || !cachedFileNeedsProviderReparse(providerName, source.path, cached))))) {
      unchangedSources.push({ source, cached })
    } else if (!readOnly) {
      changedSources.push({ source, fp })
    }
  }

  if (readOnly) {
    for (const [path, cached] of Object.entries(section.files)) {
      if (allDiscoveredFiles.has(path)) continue
      servedSources.push({
        provider: providerName,
        path,
        project: cached.turns[0]?.calls[0]?.project ?? providerName,
      })
      allDiscoveredFiles.add(path)
      unchangedSources.push({ source: servedSources[servedSources.length - 1]!, cached })
    }
  }

  // Parser dedup: cross-provider keys + cached file keys.
  // Separate from seenKeys so parsing doesn't suppress query-time output.
  const parserDedup = new Set(seenKeys)
  for (const { cached } of unchangedSources) {
    for (const turn of cached.turns) {
      for (const call of turn.calls) {
        parserDedup.add(call.deduplicationKey)
      }
    }
  }

  // Parse changed files, update cache
  let didParse = false
  // Track which paths have already been cleared this pass so that subsequent
  // sources sharing the same path (e.g. multiple OTel conversations from one
  // agent-traces.db) can accumulate via the merge logic below rather than
  // being wiped on every iteration.
  const clearedPaths = new Set<string>()
  try {
    for (const { source, fp } of changedSources) {
      if (dateRange) {
        if (fp.mtimeMs < dateRange.start.getTime()) continue
      }

      // Clear stale entry before parse — but only once per path so that
      // multiple sources mapping to the same file path can merge their turns.
      // Durable providers (e.g. copilot OTel) never clear existing entries so
      // that pruned-away data is preserved for monotonic monthly totals.
      if (!provider.durableSources && !clearedPaths.has(source.path)) {
        delete section.files[source.path]
        clearedPaths.add(source.path)
      }

      const parser = provider.createSessionParser(source, parserDedup, dateRange)

      try {
        const providerCalls: ParsedProviderCall[] = []
        for await (const call of parser.parse()) {
          providerCalls.push(call)
        }
        const canonicalCalls = await Promise.all(providerCalls.map(canonicalizeProviderCallProject))
        const turns = providerCallsToCachedTurns(canonicalCalls)

        // Store/merge parsed turns into the cache.
        // Durable providers use a union-by-deduplicationKey merge: existing turns
        // are NEVER deleted (preserves data for spans pruned from the DB), and
        // only turns whose dedup keys are not already cached are appended.
        // Non-durable providers keep the original overwrite-or-append behaviour.
        if (provider.durableSources) {
          const existingEntry = section.files[source.path]
          if (existingEntry) {
            const existingKeys = new Set(
              existingEntry.turns.flatMap(t => t.calls.map(c => c.deduplicationKey))
            )
            const newTurns = turns.filter(t =>
              t.calls.every(c => !existingKeys.has(c.deduplicationKey))
            )
            existingEntry.turns = [...existingEntry.turns, ...newTurns]
            existingEntry.fingerprint = fp
          } else {
            section.files[source.path] = { fingerprint: fp, mcpInventory: [], turns }
          }
        } else {
          // Non-durable: overwrite (clearedPaths already deleted stale entry above)
          // or append when multiple sources map to the same path. NOTE: the append
          // path assumes discoverSessions yields a unique path per source, which all
          // current providers do; it only fires for same-path multi-source providers.
          const existingCacheEntry = section.files[source.path]
          if (existingCacheEntry) {
            existingCacheEntry.turns = [...existingCacheEntry.turns, ...turns]
          } else {
            section.files[source.path] = { fingerprint: fp, mcpInventory: [], turns }
          }
        }
        didParse = true
        ;(diskCache as { _dirty?: boolean })._dirty = true
      } catch (err) {
        if (isSqliteBusyError(err)) {
          warnProviderReadFailureOnce(providerName, err)
          continue
        }
        // A single malformed session file must not abort the entire run — that
        // would silently empty the daily-cache backfill and wipe the trend /
        // history (issue #441). Record a negative-result marker keyed by the
        // current fingerprint so we don't re-read + re-throw this unchanged file
        // on every refresh; it re-parses only if it changes. Empty turns => no
        // usage contributed.
        section.files[source.path] = { fingerprint: fp, mcpInventory: [], turns: [], failed: true }
        ;(diskCache as { _dirty?: boolean })._dirty = true
        warnProviderParseFailure(providerName, source.path, err)
        continue
      }
    }
  } finally {
    if (didParse && providerName === 'codex') await flushCodexCache()
    if (didParse && providerName === 'antigravity') {
      const liveIds = new Set(sources.map(s => antigravityCascadeIdFromPath(s.path)))
      await flushAntigravityCache(liveIds)
    }
  }

  // Stamp the durable flag into the cache section so the orphan-bootstrap in
  // parseAllSessions can fast-check without a getProvider() round-trip.
  if (!readOnly && provider.durableSources && !section.durable) {
    section.durable = true
    ;(diskCache as { _dirty?: boolean })._dirty = true
  }

  if (!readOnly && sources.length > 0 && !provider.durableSources) {
    for (const cachedPath of Object.keys(section.files)) {
      if (!allDiscoveredFiles.has(cachedPath)) {
        delete section.files[cachedPath]
        ;(diskCache as { _dirty?: boolean })._dirty = true
      }
    }
  }

  // 90-day age-out for durable providers: remove entries whose newest call is
  // older than 90 days so the cache doesn't grow unboundedly over time.
  if (!readOnly && provider.durableSources) {
    const cutoffMs = Date.now() - 90 * 24 * 60 * 60 * 1000
    for (const [cachedPath, cachedFile] of Object.entries(section.files)) {
      const newestTs = cachedFile.turns
        .flatMap(t => t.calls)
        .map(c => new Date(c.timestamp).getTime())
        .filter(ts => !isNaN(ts))
        .reduce((max, ts) => Math.max(max, ts), 0)
      if (newestTs > 0 && newestTs < cutoffMs) {
        delete section.files[cachedPath]
        ;(diskCache as { _dirty?: boolean })._dirty = true
      }
    }
  }

  // Query-time: derive SessionSummary from all cached turns.
  // Uses seenKeys (shared across providers) for cross-provider dedup.
  const sessionMap = new Map<string, { project: string; projectPath?: string; workingDirectory?: string; turns: ClassifiedTurn[]; prLinks?: Set<string>; title?: string }>()

  for (const source of servedSources) {
    const cachedFile = section.files[source.path]
    if (!cachedFile) continue

    for (const turn of cachedFile.turns) {
      const hasDup = turn.calls.some(c => seenKeys.has(c.deduplicationKey))
      if (hasDup) continue

      for (const c of turn.calls) seenKeys.add(c.deduplicationKey)

      if (dateRange) {
        const callTs = turn.calls[0]?.timestamp
        if (!callTs) continue
        const ts = new Date(callTs)
        if (ts < dateRange.start || ts > dateRange.end) continue
      }

      const classified = cachedTurnToClassified(turn)
      const project = turn.calls[0]?.project ?? source.project
      const key = `${providerName}:${turn.sessionId}:${project}`

      const existing = sessionMap.get(key)
      if (existing) {
        existing.turns.push(classified)
        if (!existing.projectPath && turn.calls[0]?.projectPath) {
          existing.projectPath = turn.calls[0]!.projectPath
        }
        if (!existing.workingDirectory && turn.calls[0]?.workingDirectory) existing.workingDirectory = turn.calls[0].workingDirectory
        if (cachedFile.prLinks?.length) {
          const links = (existing.prLinks ??= new Set())
          for (const link of cachedFile.prLinks) links.add(link)
        }
        if (!existing.title && cachedFile.title) existing.title = cachedFile.title
      } else {
        sessionMap.set(key, {
          project,
          projectPath: turn.calls[0]?.projectPath,
          workingDirectory: turn.calls[0]?.workingDirectory,
          turns: [classified],
          ...(cachedFile.prLinks?.length ? { prLinks: new Set(cachedFile.prLinks) } : {}),
          ...(cachedFile.title ? { title: cachedFile.title } : {}),
        })
      }
    }
  }

  // Second pass: durable orphans — cache entries for paths that are no longer
  // discovered (e.g. OTel conversations pruned from the DB). Their turns are
  // counted here so the monthly total never drops.
  if (provider.durableSources) {
    for (const [cachedPath, cachedFile] of Object.entries(section.files)) {
      if (allDiscoveredFiles.has(cachedPath)) continue  // already counted above

      for (const turn of cachedFile.turns) {
        const hasDup = turn.calls.some(c => seenKeys.has(c.deduplicationKey))
        if (hasDup) continue

        for (const c of turn.calls) seenKeys.add(c.deduplicationKey)

        if (dateRange) {
          const callTs = turn.calls[0]?.timestamp
          if (!callTs) continue
          const ts = new Date(callTs)
          if (ts < dateRange.start || ts > dateRange.end) continue
        }

        const classified = cachedTurnToClassified(turn)
        const project = turn.calls[0]?.project ?? providerName
        const key = `${providerName}:${turn.sessionId}:${project}`

        const existingEntry = sessionMap.get(key)
        if (existingEntry) {
          existingEntry.turns.push(classified)
          if (!existingEntry.projectPath && turn.calls[0]?.projectPath) {
            existingEntry.projectPath = turn.calls[0]!.projectPath
          }
        } else {
          sessionMap.set(key, { project, projectPath: turn.calls[0]?.projectPath, workingDirectory: turn.calls[0]?.workingDirectory, turns: [classified] })
        }
      }
    }
  }

  const projectMap = new Map<string, { projectPath?: string; sessions: SessionSummary[] }>()
  for (const [key, { project, projectPath, workingDirectory, turns, prLinks, title }] of sessionMap) {
    const sessionId = key.split(':')[1] ?? key
    const session = buildSessionSummary(sessionId, project, turns)
    const explicitLinks = new Set(turns.flatMap(turn => turn.prRefs ?? []))
    for (const link of prLinks ?? []) explicitLinks.add(link)
    if (explicitLinks.size) {
      session.prLinks = [...explicitLinks].sort()
      session.prAttributionSource = prLinks?.size ? 'transcript' : 'explicit-reference'
    }
    if (workingDirectory) session.workingDirectory = workingDirectory
    if (title) session.title = title
    if (session.apiCalls > 0) {
      const existing = projectMap.get(project)
      if (existing) {
        existing.sessions.push(session)
        if (!existing.projectPath && projectPath) existing.projectPath = projectPath
      } else {
        projectMap.set(project, { projectPath, sessions: [session] })
      }
    }
  }

  const projects: ProjectSummary[] = []
  for (const [dirName, { projectPath, sessions }] of projectMap) {
    projects.push(summarizeProject(dirName, projectPath ?? unsanitizePath(dirName), sessions))
  }

  return projects
}

const CACHE_TTL_MS = 180_000
const MAX_CACHE_ENTRIES = 10
const sessionCache = new Map<string, { data: ProjectSummary[]; ts: number }>()

function cacheKey(dateRange?: DateRange, providerFilter?: string): string {
  const s = dateRange ? `${dateRange.start.getTime()}:${dateRange.end.getTime()}` : 'none'
  // Include the Claude config-dir env so a config change in a long-lived
  // process (menubar / GNOME extension / test workers) does not return
  // stale data keyed under a previous configuration.
  const claudeEnv = (process.env['CLAUDE_CONFIG_DIRS'] ?? '') + '|' + (process.env['CLAUDE_CONFIG_DIR'] ?? '')
  // Proxy attribution (totalProxiedCostUSD) is computed live from proxyPaths and
  // then cached, so the key must change when that config changes.
  return `${s}:${providerFilter ?? 'all'}:${claudeEnv}:${getProxyPathsConfigHash()}`
}

export function clearSessionCache(): void {
  sessionCache.clear()
}

function cachePut(key: string, data: ProjectSummary[]) {
  const now = Date.now()
  for (const [k, v] of sessionCache) {
    if (now - v.ts > CACHE_TTL_MS) sessionCache.delete(k)
  }
  if (sessionCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = [...sessionCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]
    if (oldest) sessionCache.delete(oldest[0])
  }
  sessionCache.set(key, { data, ts: now })
}

export function filterProjectsByName(
  projects: ProjectSummary[],
  include?: string[],
  exclude?: string[],
): ProjectSummary[] {
  let result = projects
  if (include && include.length > 0) {
    const patterns = include.map(s => s.toLowerCase())
    result = result.filter(p => {
      const name = p.project.toLowerCase()
      const path = p.projectPath.toLowerCase()
      return patterns.some(pat => name.includes(pat) || path.includes(pat))
    })
  }
  if (exclude && exclude.length > 0) {
    const patterns = exclude.map(s => s.toLowerCase())
    result = result.filter(p => {
      const name = p.project.toLowerCase()
      const path = p.projectPath.toLowerCase()
      return !patterns.some(pat => name.includes(pat) || path.includes(pat))
    })
  }
  return result
}

function turnIsInDateRange(turn: ClassifiedTurn, dateRange: DateRange): boolean {
  if (turn.assistantCalls.length === 0) return false
  const firstCallTs = turn.assistantCalls[0]!.timestamp
  if (!firstCallTs) return false
  const ts = new Date(firstCallTs)
  return ts >= dateRange.start && ts <= dateRange.end
}

function turnDayString(turn: ClassifiedTurn): string | null {
  if (turn.assistantCalls.length === 0) return null
  const ts = turn.assistantCalls[0]!.timestamp
  if (!ts) return null
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// A spawn parent (has spawnPrSets + prLinks) counts as a fold ANCHOR. Kept
// verbatim (not rebuilt) so its spawnPrSets / prLinks / agentSpawnLinks survive.
function isSpawnParent(session: SessionSummary): boolean {
  return !!session.spawnPrSets && !!session.prLinks?.length
}

// buildSessionSummary rolls up ONLY turn-derived fields, so a rebuilt (date/day/
// source-filtered) session loses its session-level PR + subagent-linkage metadata.
// Carry those across so by-PR attribution and subagent folding still work on a
// filtered slice (without this, a filtered CHILD loses its parentSessionId and can
// never be linked, and a filtered parent loses its prLinks).
function carryLinkageFields(rebuilt: SessionSummary, original: SessionSummary): void {
  if (original.everHadBranch) rebuilt.everHadBranch = true
  if (original.prLinks?.length) rebuilt.prLinks = original.prLinks
  if (original.prAttributionSource) rebuilt.prAttributionSource = original.prAttributionSource
  if (original.workingDirectory) rebuilt.workingDirectory = original.workingDirectory
  // prRefsAtRangeStart is NOT copied here: a narrower slice needs it recomputed at
  // the new boundary (see recomputeRangeStartPrRefs), not the wide range's value.
  if (original.parentSessionId) rebuilt.parentSessionId = original.parentSessionId
  if (original.agentId) rebuilt.agentId = original.agentId
  if (original.agentSpawnLinks) rebuilt.agentSpawnLinks = original.agentSpawnLinks
  if (original.spawnPrSets) rebuilt.spawnPrSets = original.spawnPrSets
  if (original.ambiguousSpawnAgentIds?.length) rebuilt.ambiguousSpawnAgentIds = original.ambiguousSpawnAgentIds
  if (original.title) rebuilt.title = original.title
  if (original.agentType) rebuilt.agentType = original.agentType
}

// The "PR active entering this slice", recomputed by replaying the ORIGINAL full
// turn sequence up to `sliceStartMs`, seeded from the original range-start state.
// A narrower filter must NOT reuse the wide range's range-start PR: a PR switch
// between the wide start and the slice start would otherwise be lost, mis-seeding
// both spend attribution and the subagent grace fallback. A turn exactly ON the
// boundary stays in the slice and applies its own prRefs there, so the walk stops
// strictly before it.
function recomputeRangeStartPrRefs(original: SessionSummary, sliceStartMs: number): string[] | undefined {
  // The carried PR is the refs of the LATEST turn (by timestamp) strictly before the
  // slice that referenced any PR; a turn exactly on the boundary is inside the slice
  // and applies its own refs there. Selected by timestamp, not array position, so
  // the result does not depend on turn ordering. When two PR-bearing turns share the
  // exact same millisecond (a degenerate case), break the tie deterministically by
  // the lexicographically-LAST sorted-join of their refs, so the seed is stable
  // regardless of input order (arbitrary but stable, not order-dependent). Falls back
  // to the original range-start state when nothing referenced a PR before the slice.
  let current = original.prRefsAtRangeStart
  let bestMs = -Infinity
  let bestKey = ''
  for (const turn of original.turns) {
    if (!turn.prRefs?.length) continue
    const ts = turn.assistantCalls[0]?.timestamp
    if (!ts) continue
    const tMs = new Date(ts).getTime()
    if (Number.isNaN(tMs) || tMs >= sliceStartMs) continue
    const key = [...turn.prRefs].sort().join(',')
    if (tMs > bestMs || (tMs === bestMs && key > bestKey)) { bestMs = tMs; bestKey = key; current = turn.prRefs }
  }
  return current
}

// Apply a recomputed range-start PR state to a rebuilt session (or clear it).
function applyRecomputedRangeStart(rebuilt: SessionSummary, original: SessionSummary, sliceStartMs: number): void {
  const rs = recomputeRangeStartPrRefs(original, sliceStartMs)
  if (rs?.length) rebuilt.prRefsAtRangeStart = rs
  else delete rebuilt.prRefsAtRangeStart
}

// Local-midnight epoch of the EARLIEST selected day, used to seed the very-first
// turn and the pre-first-turn grace fallback. Per-day seeding (below) handles every
// later day, so non-contiguous selections are also correct.
function earliestDayStartMs(days: Set<string>): number {
  const earliest = [...days].sort()[0]
  return earliest ? new Date(`${earliest}T00:00:00`).getTime() : NaN
}

// Per-day seeding for a (possibly non-contiguous) day selection. For the FIRST
// in-slice turn of each selected day that does not already reference a PR, inject the
// PR carried into that day, recomputed from the ORIGINAL full turn sequence up to the
// day's local-midnight start. A PR switch on an UNSELECTED day between two selected
// days is thus captured for the later day; a contiguous run is the special case and
// stays correct. Turn order is preserved.
function seedFilteredTurnsPerDay(original: SessionSummary, filteredTurns: ClassifiedTurn[]): ClassifiedTurn[] {
  const out: ClassifiedTurn[] = []
  let lastDay: string | null = null
  for (const turn of filteredTurns) {
    const day = turnDayString(turn)
    if (day !== null && day !== lastDay) {
      lastDay = day
      if (!turn.prRefs?.length) {
        const carried = recomputeRangeStartPrRefs(original, new Date(`${day}T00:00:00`).getTime())
        if (carried?.length) { out.push({ ...turn, prRefs: carried }); continue }
      }
    }
    out.push(turn)
  }
  return out
}

// An anchor is a duplicate of a surviving session ONLY when they share the full
// provider-aware, fingerprint-qualified identity (a proven-identical record). A
// different-provider session that shares a raw id, or a same-id/different-record
// collision that SHOULD stay to trigger the neither-fold guard, is not dropped.
function dedupeAnchors(anchors: SessionSummary[], survivingIdentities: Set<string>): SessionSummary[] {
  if (survivingIdentities.size === 0) return anchors
  return anchors.filter(a => !survivingIdentities.has(sessionIdentity(a)))
}

export function filterProjectsByDays(projects: ProjectSummary[], days: Set<string>): ProjectSummary[] {
  const sliceStartMs = earliestDayStartMs(days)
  const filtered: ProjectSummary[] = []
  for (const project of projects) {
    const sessions: SessionSummary[] = []
    // Existing anchors are date-EXEMPT (carried unchanged); a spawn parent whose
    // OWN in-range turns all fall outside the day subset is CONVERTED to an anchor
    // so its surviving in-range child still resolves. The anchor contributes no
    // own spend either way.
    const anchors: SessionSummary[] = [...(project.subagentAnchors ?? [])]
    const survivingIdentities = new Set<string>()
    for (const session of project.sessions) {
      const turns = session.turns.filter(turn => {
        const ds = turnDayString(turn)
        return ds !== null && days.has(ds)
      })
      if (turns.length === 0) {
        if (isSpawnParent(session)) anchors.push(session)
        continue
      }
      const seeded = seedFilteredTurnsPerDay(session, turns)
      const rebuilt = buildSessionSummary(session.sessionId, session.project, seeded, session.mcpInventory, session.source)
      carryLinkageFields(rebuilt, session)
      if (!Number.isNaN(sliceStartMs)) applyRecomputedRangeStart(rebuilt, session, sliceStartMs)
      // Identity of the ORIGINAL (pre-filter) session: a duplicate anchor matches the
      // session as it appeared in the input, not the narrowed rebuild.
      survivingIdentities.add(sessionIdentity(session))
      sessions.push(rebuilt)
    }
    const dedupedAnchors = dedupeAnchors(anchors, survivingIdentities)
    if (sessions.length === 0 && dedupedAnchors.length === 0) continue
    filtered.push(summarizeProject(project.project, project.projectPath, sessions, dedupedAnchors))
  }
  return filtered.sort((a, b) => b.totalCostUSD - a.totalCostUSD)
}

// Merge projects that resolve to the same repository across providers (the
// same repo used with Claude Code + Codex, say). An additive total summed at
// the session level but forgotten here silently under-reports for exactly the
// multi-provider users (this bit totalEstimatedCostUSD once, caught in #639
// verification). Known gaps, deliberate: totalSavingsUSD is still not summed
// (pre-existing, tracked separately) and totalProxiedCostUSD is re-derived
// after the merge rather than summed here.
export function mergeProjectsByCrossProviderKey(projects: ProjectSummary[]): Map<string, ProjectSummary> {
  const crossProviderKey = (p: ProjectSummary): string => {
    const path = p.projectPath.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
    return path.includes('/') ? path : p.project.toLowerCase()
  }
  const mergedMap = new Map<string, ProjectSummary>()
  for (const p of projects) {
    const key = crossProviderKey(p)
    const existing = mergedMap.get(key)
    if (existing) {
      existing.sessions.push(...p.sessions)
      if (p.subagentAnchors?.length) existing.subagentAnchors = [...(existing.subagentAnchors ?? []), ...p.subagentAnchors]
      existing.totalCostUSD += p.totalCostUSD
      existing.totalEstimatedCostUSD = (existing.totalEstimatedCostUSD ?? 0) + (p.totalEstimatedCostUSD ?? 0)
      existing.totalApiCalls += p.totalApiCalls
    } else {
      mergedMap.set(key, { ...p })
    }
  }
  return mergedMap
}

function summaryProvider(session: SessionSummary): string {
  return session.turns.flatMap(t => t.assistantCalls)[0]?.provider ?? 'unknown'
}

function normalizedWorkingDirectory(path: string | undefined): string | null {
  if (!path?.trim()) return null
  return path.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function normalizedPrompt(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function assignCorrelatedPrs(
  session: SessionSummary,
  urls: readonly string[],
  source: 'working-directory' | 'launcher-prompt',
): void {
  if (session.prLinks?.length || urls.length === 0) return
  const refs = [...new Set(urls)].sort()
  session.prLinks = refs
  session.prAttributionSource = source
  // Seed the first turn so the existing carry-forward state machine attributes
  // every later turn precisely. This is not the legacy whole-session split.
  if (session.turns[0] && !session.turns[0].prRefs?.length) session.turns[0].prRefs = refs
}

/**
 * Correlate saved sessions across AI providers without timestamp guessing.
 *
 * Evidence, strongest first:
 *  1. exact launch-prompt text embedded in a PR-linked session's shell command;
 *  2. exact provider-recorded cwd shared with one unambiguous PR.
 *
 * Timestamps only narrow prompt comparisons for performance; they can never
 * create attribution. Conflicting PR evidence is deliberately left unassigned.
 */
export function correlateCrossProviderPrSessions(projects: ProjectSummary[]): void {
  const sessions = projects.flatMap(p => p.sessions)
  const linked = sessions.filter(s => s.prLinks?.length)
  // Claude sidechains retain their existing fold semantics. They may provide
  // evidence for a tool they launched, but must not become standalone PR rows.
  const candidates = sessions.filter(s => !s.prLinks?.length && !s.parentSessionId)
  const evidence = new Map<SessionSummary, string[]>(linked.map(s => [s, s.prLinks!]))

  // Resolve Claude's native parent->sidechain linkage as evidence without
  // mutating the child. This lets a Codex/Gemini/etc. review launched inside a
  // Claude subagent inherit the parent turn's PR while the subagent itself still
  // folds exactly once under the existing accounting model.
  for (const resolved of resolveSubagentAttribution(projects).values()) {
    for (const child of resolved) {
      // A multi-PR spawn set is valid for folding the child's own cost, but is
      // too broad to identify which PR an independently saved nested review was
      // about. Require one PR for cross-provider propagation.
      if (child.unlinked || child.prSet?.length !== 1) continue
      const matches = sessions.filter(s => !s.prLinks?.length && s.agentId === child.fold.agentId)
      if (matches.length === 1) evidence.set(matches[0]!, child.prSet)
    }
  }

  type Launch = { atMs: number; provider: string; refs: string[]; commands: string[] }
  const launches: Launch[] = []
  for (const [session, evidenceRefs] of evidence) {
    // A native PR-linked session's session-level union is NOT the active PR at
    // its beginning; only a range-start seed or a turn ref establishes that.
    // Sidechain evidence has already been resolved to its launching parent turn,
    // so it is safe to seed the otherwise ref-less child with that exact set.
    let active = session.prLinks?.length ? (session.prRefsAtRangeStart ?? []) : evidenceRefs
    for (const turn of session.turns) {
      if (turn.prRefs?.length) active = turn.prRefs
      if (active.length === 0) continue
      for (const call of turn.assistantCalls) {
        const commands = (call.toolSequence ?? [])
          .flat()
          .map(tool => typeof tool.command === 'string' ? normalizedPrompt(tool.command) : '')
          .filter(command => command.length > 0)
        if (commands.length === 0) continue
        const atMs = Date.parse(call.timestamp || turn.timestamp)
        if (Number.isFinite(atMs)) launches.push({ atMs, provider: call.provider, refs: active, commands })
      }
    }
  }

  const PROMPT_PREFIX = 160
  const PROMPT_MIN = 80
  const LAUNCH_WINDOW_MS = 15 * 60 * 1000
  for (const session of candidates) {
    const provider = summaryProvider(session)
    const prompt = session.turns
      .map(t => normalizedPrompt(t.userMessage))
      .find(text => text.length >= PROMPT_MIN)
    if (!prompt) continue
    const prefix = prompt.slice(0, PROMPT_PREFIX)
    const startedMs = Date.parse(session.firstTimestamp)
    if (!Number.isFinite(startedMs)) continue
    const matches = launches.filter(launch =>
      launch.provider !== provider
      && Math.abs(launch.atMs - startedMs) <= LAUNCH_WINDOW_MS
      && launch.commands.some(command => command.includes(prefix))
    )
    const refSets = new Map(matches.map(m => [m.refs.slice().sort().join('\0'), m.refs]))
    if (refSets.size === 1) {
      assignCorrelatedPrs(session, [...refSets.values()][0]!, 'launcher-prompt')
      if (session.prLinks?.length) evidence.set(session, session.prLinks)
    }
  }

  // Prompt-linked sessions become valid cwd anchors too. Attribute only when an
  // exact cwd maps to one PR set; a main checkout used for multiple PRs remains
  // intentionally ambiguous.
  const refsByCwd = new Map<string, Map<string, string[]>>()
  for (const [session, evidenceRefs] of evidence) {
    const cwd = normalizedWorkingDirectory(session.workingDirectory)
    if (!cwd || evidenceRefs.length !== 1) continue
    const refs = evidenceRefs.slice().sort()
    const sets = refsByCwd.get(cwd) ?? new Map<string, string[]>()
    sets.set(refs.join('\0'), refs)
    refsByCwd.set(cwd, sets)
  }
  for (const session of sessions) {
    if (session.prLinks?.length || session.parentSessionId) continue
    const cwd = normalizedWorkingDirectory(session.workingDirectory)
    if (!cwd) continue
    const sets = refsByCwd.get(cwd)
    if (sets?.size === 1) assignCorrelatedPrs(session, [...sets.values()][0]!, 'working-directory')
  }
}

export function filterProjectsByClaudeConfigSource(projects: ProjectSummary[], sourceId: string): ProjectSummary[] {
  const filtered: ProjectSummary[] = []
  for (const project of projects) {
    // Match by source id across both claude-config and claude-desktop kinds so
    // the Claude Desktop bucket is selectable too.
    const sessions = project.sessions.filter(session =>
      session.source?.id === sourceId
    )
    // Anchors get the SAME source scoping as sessions (a config-source filter is a
    // provenance filter, not a date filter), so an anchor stays only with its own
    // config's children.
    const anchors = (project.subagentAnchors ?? []).filter(anchor => anchor.source?.id === sourceId)
    if (sessions.length === 0 && anchors.length === 0) continue
    filtered.push(summarizeProject(project.project, project.projectPath, sessions, anchors))
  }
  return filtered.sort((a, b) => b.totalCostUSD - a.totalCostUSD)
}

export function filterProjectsByDateRange(projects: ProjectSummary[], dateRange: DateRange): ProjectSummary[] {
  const sliceStartMs = dateRange.start.getTime()
  const filtered: ProjectSummary[] = []
  for (const project of projects) {
    const sessions: SessionSummary[] = []
    // Carry existing anchors and convert a spawn parent whose in-range turns are all
    // filtered out into one (see filterProjectsByDays).
    const anchors: SessionSummary[] = [...(project.subagentAnchors ?? [])]
    const survivingIdentities = new Set<string>()
    for (const session of project.sessions) {
      const turns = session.turns.filter(turn => turnIsInDateRange(turn, dateRange))
      if (turns.length === 0) {
        if (isSpawnParent(session)) anchors.push(session)
        continue
      }
      const rebuilt = buildSessionSummary(session.sessionId, session.project, turns, session.mcpInventory, session.source)
      carryLinkageFields(rebuilt, session)
      applyRecomputedRangeStart(rebuilt, session, sliceStartMs)
      survivingIdentities.add(sessionIdentity(session))
      sessions.push(rebuilt)
    }
    const dedupedAnchors = dedupeAnchors(anchors, survivingIdentities)
    if (sessions.length === 0 && dedupedAnchors.length === 0) continue
    filtered.push(summarizeProject(project.project, project.projectPath, sessions, dedupedAnchors))
  }
  return filtered.sort((a, b) => b.totalCostUSD - a.totalCostUSD)
}

// Reflects whether the most recently completed parse left the session cache
// fully hydrated. The daily backfill reads this so it never finalizes history
// built on a partial (interrupted) session cache. Set only at the end of a
// runParse that reaches completion; a killed run leaves it false.
let sessionHydrationComplete = false
export function isSessionHydrationComplete(): boolean {
  return sessionHydrationComplete
}

export async function parseAllSessions(dateRange?: DateRange, providerFilter?: string): Promise<ProjectSummary[]> {
  const key = cacheKey(dateRange, providerFilter)
  const cached = sessionCache.get(key)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data

  let diskCache = await loadCache()
  await cleanupOrphanedTempFiles()

  // Cold-hydration coordination (advisory, cross-process). Engages whenever the
  // on-disk cache is not COMPLETE — an empty cache OR a partial one an interrupted
  // cold start left behind. Keying on completeness (not mere non-emptiness) is
  // what keeps a resumed partial hydration under the lock, so a concurrent menubar
  // + desktop can't race their partial writes and freeze a partial daily history.
  // If another live process is already hydrating, wait for it, then reload the
  // now-warm cache instead of double-parsing. Never a correctness gate: on any
  // doubt it proceeds unlocked.
  if (!isCacheComplete(diskCache)) {
    const hydration = await beginColdHydration(true)
    if (hydration.waited) diskCache = await loadCache()
    const isCold = !isCacheComplete(diskCache)
    try {
      return await runParse(key, diskCache, dateRange, providerFilter, { isCold })
    } finally {
      await hydration.release()
    }
  }

  // A complete cache refresh is a strict read/reconcile/parse/save transaction.
  // Keep the snapshot loaded before acquisition: timeout/unavailable paths serve
  // exactly this complete snapshot and never mutate or invalidate the holder.
  const priorSnapshot = diskCache
  const refresh = await acquireCacheRefreshLock()
  if (refresh.outcome === 'timed-out' || refresh.outcome === 'unavailable') {
    return runParse(key, priorSnapshot, dateRange, providerFilter, { readOnly: true })
  }
  if (refresh.outcome === 'completed-by-other') {
    return runParse(key, await loadCache(), dateRange, providerFilter, { readOnly: true })
  }

  try {
    // Reload only after ownership is canonical; this closes the lost-update
    // window between the pre-gate read and the holder's completed publication.
    diskCache = await loadCache()
    return await runParse(key, diskCache, dateRange, providerFilter, { refreshLock: refresh.handle })
  } catch (err) {
    if (!(err instanceof RefreshFenceLostError) && !(err instanceof RefreshPublicationUnavailableError)) throw err
    return runParse(key, await loadCache(), dateRange, providerFilter, { readOnly: true })
  } finally {
    await refresh.handle.release()
  }
}

class RefreshFenceLostError extends Error {}
class RefreshPublicationUnavailableError extends Error {}

type RunParseOptions = {
  isCold?: boolean
  readOnly?: boolean
  refreshLock?: RefreshLockHandle
}

async function runParse(
  key: string,
  diskCache: SessionCache,
  dateRange?: DateRange,
  providerFilter?: string,
  options: RunParseOptions = {},
): Promise<ProjectSummary[]> {
  const { isCold = false, readOnly = false, refreshLock } = options
  const seenMsgIds = new Set<string>()
  const seenKeys = new Set<string>()
  const allSources = await discoverAllSessions(providerFilter)

  const claudeSources = allSources.filter(s => s.provider === 'claude')
  const nonClaudeSources = allSources.filter(s => s.provider !== 'claude')

  const providerGroups = new Map<string, SessionSource[]>()
  for (const source of nonClaudeSources) {
    const existing = providerGroups.get(source.provider) ?? []
    existing.push(source)
    providerGroups.set(source.provider, existing)
  }

  // Cold-run robustness: persist partial progress during a long parse (throttled)
  // so a run interrupted before the single end-of-parse save still leaves a warm
  // cache behind. saveCache is atomic (temp + rename) and clears `_dirty`, so this
  // never races the final save below.
  let lastSaveAt = Date.now()
  const saveProgress = async (): Promise<void> => {
    if (!isCold || readOnly) return
    if (!(diskCache as { _dirty?: boolean })._dirty) return
    if (Date.now() - lastSaveAt < PROGRESS_SAVE_THROTTLE_MS) return
    lastSaveAt = Date.now()
    try { await saveCache(diskCache) } catch { /* best-effort partial save */ }
  }

  emitScanProgress({ kind: 'providers', cold: isCold, providers: [
    ...(claudeSources.length > 0 ? ['claude'] : []),
    ...providerGroups.keys(),
  ] })

  const claudeDirs = claudeSources.map(s => ({
    path: s.path,
    name: s.project,
    source: s.sourceId && s.sourceLabel && s.sourcePath && s.sourceKind
      ? { id: s.sourceId, label: s.sourceLabel, path: s.sourcePath, kind: s.sourceKind }
      : undefined,
  }))
  if (claudeSources.length > 0) emitScanProgress({ kind: 'provider', provider: 'claude', state: 'start' })
  let claudeProjects: ProjectSummary[] = []
  try {
    claudeProjects = await scanProjectDirs(claudeDirs, seenMsgIds, diskCache, dateRange, saveProgress, readOnly)
    if (claudeSources.length > 0) emitScanProgress({ kind: 'provider', provider: 'claude', state: 'done', files: claudeSources.length })
  } catch (err) {
    if (!isPermissionError(err)) throw err
    process.stderr.write(`codeburn: skipped claude data (permission denied; grant Full Disk Access to include it)\n`)
    emitScanProgress({ kind: 'provider', provider: 'claude', state: 'skipped' })
  }

  const otherProjects: ProjectSummary[] = []
  for (const [providerName, sources] of providerGroups) {
    emitScanProgress({ kind: 'provider', provider: providerName, state: 'start' })
    try {
      const projects = await parseProviderSources(providerName, sources, seenKeys, diskCache, dateRange, readOnly)
      emitScanProgress({ kind: 'provider', provider: providerName, state: 'done', files: sources.length })
      otherProjects.push(...projects)
    } catch (err) {
      // A permission-locked provider skips-and-continues; any other error is a
      // real bug and still aborts (per-file/DB-lock cases are handled deeper).
      if (!isPermissionError(err)) throw err
      process.stderr.write(`codeburn: skipped ${providerName} data (permission denied; grant Full Disk Access to include it)\n`)
      emitScanProgress({ kind: 'provider', provider: providerName, state: 'skipped' })
    }
    await saveProgress()
  }

  // Durable providers with cached data but NO discovered sources (all files pruned
  // by VS Code / the external tool) still need their orphan pass to run so the
  // monthly total never drops. Call parseProviderSources with empty sources for
  // any such provider found in the disk cache.
  const processedProviders = new Set(providerGroups.keys())
  for (const providerName of Object.keys(diskCache.providers)) {
    if (processedProviders.has(providerName)) continue
    // Skip if filtered to a different provider
    if (providerFilter && providerFilter !== 'all' && providerFilter !== providerName) continue
    const section = diskCache.providers[providerName]
    if (!section || Object.keys(section.files).length === 0) continue
    // Use the persisted durable flag (set by parseProviderSources when it first
    // processes a durableSources provider) OR the static DURABLE_PROVIDER_NAMES
    // constant — both checks are O(1) and avoid a getProvider() dynamic-import
    // round-trip for every unprocessed provider in the disk cache.
    if (!section.durable && !DURABLE_PROVIDER_NAMES.has(providerName)) continue
    const projects = await parseProviderSources(providerName, [], seenKeys, diskCache, dateRange, readOnly)
    otherProjects.push(...projects)
  }

  // The full scan reached the end: this cache is now complete. Mark it and
  // persist even when nothing else is dirty, so a pre-marker cache (or a partial
  // that happened to already hold every current file) stops being re-read as cold
  // on every launch, and the completeness marker the daily backfill + splash rely
  // on is durable. A run killed before here never reaches this, so its throttled
  // partial saves keep `complete: false` and the next launch resumes cold.
  const wasComplete = isCacheComplete(diskCache)
  if (!readOnly && !wasComplete) diskCache.complete = true
  if (!readOnly && ((diskCache as { _dirty?: boolean })._dirty || !wasComplete)) {
    try {
      const published = await saveCache(diskCache, refreshLock?.verifyStillOwner)
      if (!published) throw new RefreshFenceLostError()
    } catch (err) {
      if (err instanceof RefreshFenceLostError) throw err
      if (refreshLock) throw new RefreshPublicationUnavailableError()
    }
  }
  sessionHydrationComplete = true

  // Merge across providers by normalised project path so the same repository
  // is not double-counted when it was worked on with more than one tool
  // (e.g. both Claude Code and Codex). Two sub-problems:
  //
  // 1. Codex's sanitizeProject strips the leading '/' from cwds, so
  //    "Users/carlo/foo" and "/Users/carlo/foo" must compare equal. We
  //    normalise by stripping leading slashes before keying.
  //
  // 2. Codex worktrees (e.g. ~/.codex/worktrees/e55f/Repo) are not resolved
  //    to their main-repo path by canonicalizeProviderCallProject because that
  //    function only operates on call.projectPath, which Codex doesn't set.
  //    Resolve at the ProjectSummary level here: prepend '/' if needed to get
  //    an absolute path, then run the same worktree-detection logic.
  const resolvedOtherProjects = await Promise.all(otherProjects.map(async p => {
    const absPath = p.projectPath.startsWith('/') || p.projectPath.startsWith('\\')
      ? p.projectPath
      : '/' + p.projectPath
    const canonical = await resolveCanonicalProjectPath(absPath)
    // Skip if path is unchanged: same location, not a worktree, not a subdir
    if (!canonical.isWorktree && canonical.path === absPath.replace(/[/\\]+$/, '')) return p
    return { ...p, project: projectNameFromPath(canonical.path, p.project), projectPath: canonical.path }
  }))

  const mergedMap = mergeProjectsByCrossProviderKey([...claudeProjects, ...resolvedOtherProjects])

  // Re-derive proxy attribution on the merged total: the merge above sums
  // totalCostUSD across providers that share a canonical path but never
  // recomputed totalProxiedCostUSD, so a merged project (e.g. the same repo
  // used with Claude Code + Codex) would otherwise carry the proxied amount of
  // only the first-seen provider. The merge key is the canonical path, so both
  // sides share the same proxied status — keying off the surviving projectPath
  // and the final cost keeps the project-level all-or-nothing rule intact.
  for (const p of mergedMap.values()) {
    p.totalProxiedCostUSD = isProxiedPath(p.projectPath) ? p.totalCostUSD : 0
  }

  const result = Array.from(mergedMap.values()).sort((a, b) => b.totalCostUSD - a.totalCostUSD)
  correlateCrossProviderPrSessions(result)
  cachePut(key, result)
  return result
}
