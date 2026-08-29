import { existsSync } from 'fs'
import { lstat, readFile, readdir, stat } from 'fs/promises'
import { createHash } from 'crypto'
import { performance } from 'node:perf_hooks'
import { basename, dirname, join, resolve, sep } from 'path'
import { FS_SCAN_CONCURRENCY, mapWithConcurrency, readSessionLines } from './fs-utils.js'
import { billableOutputTokens, calculateCost, calculateLocalModelSavings, getShortModelName, isProxiedPath, getProxyPathsConfigHash, getModelAliasesConfigHash, getPriceOverridesConfigHash, getLocalModelSavingsConfigHash } from './models.js'
import { resolveSubagentAttribution, sessionIdentity } from './sessions-report.js'
import { normalizeContentBlocks, flatSlice, flatString } from './content-utils.js'
import { discoverAllSessions, getProvider } from './providers/index.js'
import { flushCodexCache, readCachedCodexResults, withCodexCacheDirectory, writeCachedCodexResults } from './codex-cache.js'
import { antigravityCascadeIdFromPath, flushAntigravityCache, shouldReparseAntigravitySource } from './providers/antigravity.js'
import { getClaudeConfigDirs, getDesktopSessionsDirs } from './providers/claude.js'
import { kimicodeLineageForSource } from './providers/kimicode.js'
import { isSqliteBusyError } from './sqlite.js'
import { getCodeburnCacheDir } from './cache-dir.js'
import {
  isHermesLedgerPublicationError,
  isHermesObservationKey,
  seedHermesCursorsFromProviderSection,
} from './hermes-session-ledger.js'
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
  isCacheDirty,
  loadCache,
  markCacheDirty,
  monthScopeForRange,
  reconcileFile,
  saveCache,
  sourcePathStatCandidates,
} from './session-cache.js'
import { acquireCacheRefreshLock, type RefreshLockHandle, type RefreshLockOutcome } from './cache-refresh-lock.js'
import { decideParseWorkers, parseFilesInOrder, ParseWorkerPool, type ClaudeWorkerParse, type ParseJob } from './parse-workers.js'
import type { CodexFullParse } from './providers/codex.js'
import { dateKey } from './day-aggregator.js'
import { isBehavioralCall, isBehavioralTurn } from './behavioral-weight.js'
import type { ParsedProviderCall, Provider, SessionSource } from './providers/types.js'
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
  SessionLineage,
  SessionSummary,
  SessionSourceMetadata,
  TokenUsage,
  ToolCall,
  ToolUseBlock,
} from './types.js'
import { classifyTurn, BASH_TOOLS, EDIT_TOOLS } from './classifier.js'
import { extractBashCommands } from './bash-utils.js'
import { isTrustedAbsoluteWorkingDirectory } from './path-privacy.js'

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
  const resolvedCwd = resolve(cwd)
  const resolvedFilePath = resolve(filePath)
  return getDesktopSessionsDirs().some(base => {
    const resolvedBase = resolve(base)
    const inBase = (p: string) => p.startsWith(resolvedBase + sep) || p.startsWith(resolvedBase + '/')
    return inBase(resolvedCwd) || inBase(resolvedFilePath)
  })
}

// Memoizes resolveCanonicalProjectPath: every ParsedProviderCall with a
// projectPath pays the .git-marker directory walk (one lstat per ancestor
// level), and a session's calls all share one cwd — without this cache a
// cold parse re-walks the same few directories thousands of times
// (measured ~+5% cold-parse time for a large kiro store). Filesystem facts
// can go stale in a long-lived process (a dir converted to a worktree
// mid-run), so the cache is cleared with the session cache.
// Stores the Promise, not the resolved value: callers within the same
// Promise.all batch would otherwise all miss the cache and each re-walk the
// filesystem before the first walk's result lands.
const canonicalPathCache = new Map<string, Promise<{ path: string; isWorktree: boolean }>>()

async function resolveCanonicalProjectPath(cwd: string): Promise<{ path: string; isWorktree: boolean }> {
  const cached = canonicalPathCache.get(cwd)
  if (cached) return cached
  const result = resolveCanonicalProjectPathUncached(cwd)
  canonicalPathCache.set(cwd, result)
  return result
}

async function resolveCanonicalProjectPathUncached(cwd: string): Promise<{ path: string; isWorktree: boolean }> {
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

const LARGE_ROOT_FIELDS = ['type', 'timestamp', 'sessionId', 'cwd', 'gitBranch', 'attachment', 'message', 'isSidechain', 'promptSource'] as const
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
  if (root['isSidechain']?.kind === 'scalar' && source.slice(root['isSidechain'].start, root['isSidechain'].end) === 'true') {
    entry.isSidechain = true
  }
  const timestamp = readJsonString(source, root['timestamp'])
  const sessionId = readJsonString(source, root['sessionId'])
  const cwd = readJsonString(source, root['cwd'])
  const gitBranch = readJsonString(source, root['gitBranch'])
  const promptSource = readJsonString(source, root['promptSource'])
  if (timestamp !== undefined) entry.timestamp = timestamp
  if (sessionId !== undefined) entry.sessionId = sessionId
  if (cwd !== undefined) entry.cwd = cwd
  if (gitBranch !== undefined) entry.gitBranch = gitBranch
  if (promptSource !== undefined) entry.promptSource = promptSource
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
    if (typeof t === 'string' && t.trim()) meta.title = flatString(t.trim().slice(0, 200))
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
    // A turn whose calls are all supplementary accounting (copilot rollup /
    // paired store rows) is not a behavioral exchange: its cost still lands in
    // the category so breakdowns keep summing to the totals, but it adds no
    // turn/edit/retry weight. Sessions normally never hold such turns (they
    // are folded into behavioral turns upstream); this covers the
    // accounting-only container of a session with no behavioral turns at all.
    const behavioralTurn = isBehavioralTurn(turn)

    if (!categoryBreakdown[turn.category]) {
      categoryBreakdown[turn.category] = { turns: 0, costUSD: 0, savingsUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 }
    }
    if (behavioralTurn) categoryBreakdown[turn.category].turns++
    categoryBreakdown[turn.category].costUSD += turnCost
    categoryBreakdown[turn.category].savingsUSD += turnSavings
    if (behavioralTurn && turn.hasEdits) {
      categoryBreakdown[turn.category].editTurns++
      categoryBreakdown[turn.category].retries += turn.retries
      if (turn.retries === 0) categoryBreakdown[turn.category].oneShotTurns++
    }

    if (turn.subCategory) {
      const skillKey = turn.subCategory
      if (!skillBreakdown[skillKey]) {
        skillBreakdown[skillKey] = { turns: 0, costUSD: 0, savingsUSD: 0, editTurns: 0, oneShotTurns: 0 }
      }
      if (behavioralTurn) skillBreakdown[skillKey].turns++
      skillBreakdown[skillKey].costUSD += turnCost
      skillBreakdown[skillKey].savingsUSD += turnSavings
      if (behavioralTurn && turn.hasEdits) {
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
      // Supplementary accounting calls contribute tokens/cost above but are
      // not distinct requests: no api-call or per-model call weight.
      if (isBehavioralCall(call)) apiCalls++

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
      if (isBehavioralCall(call)) modelBreakdown[modelKey].calls++
      modelBreakdown[modelKey].costUSD += call.costUSD
      modelBreakdown[modelKey].savingsUSD += callSavings
      modelBreakdown[modelKey].estimatedCostUSD = (modelBreakdown[modelKey].estimatedCostUSD ?? 0) + callEstimated
      modelBreakdown[modelKey].tokens.inputTokens += call.usage.inputTokens
      modelBreakdown[modelKey].tokens.outputTokens += call.usage.outputTokens
      modelBreakdown[modelKey].tokens.cacheReadInputTokens += call.usage.cacheReadInputTokens
      modelBreakdown[modelKey].tokens.cacheCreationInputTokens += call.usage.cacheCreationInputTokens
      modelBreakdown[modelKey].tokens.reasoningTokens += call.usage.reasoningTokens
      if (call.activeDurationMs !== undefined) {
        modelBreakdown[modelKey].activeDurationMs = (modelBreakdown[modelKey].activeDurationMs ?? 0) + call.activeDurationMs
        modelBreakdown[modelKey].activeGeneratedTokens = (modelBreakdown[modelKey].activeGeneratedTokens ?? 0) + (call.activeGeneratedTokens ?? billableOutputTokens(call.provider, call.usage.outputTokens, call.usage.reasoningTokens))
        modelBreakdown[modelKey].toolWaitMs = (modelBreakdown[modelKey].toolWaitMs ?? 0) + (call.toolWaitMs ?? 0)
      }

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
  const files = await readdir(dirPath, { withFileTypes: true }).catch(() => [])
  const jsonlFiles = new Set(files.filter(f => f.name.endsWith('.jsonl')).map(f => join(dirPath, f.name)))

  await collectJsonlInto(join(dirPath, 'subagents'), jsonlFiles)
  for (const entry of files) {
    if (entry.name.endsWith('.jsonl')) continue
    // A plain file can't hold a subagents/ dir, so don't spend a readdir
    // finding out. Anything else (real dir, symlink, unknown type) still gets
    // probed, matching what the untyped readdir used to do.
    if (entry.isFile()) continue
    await collectJsonlInto(join(dirPath, entry.name, 'subagents'), jsonlFiles)
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
    if (typeof t === 'string' && t.trim()) return flatString(t.trim().slice(0, 100))
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
  // Walk and fingerprint concurrently, then reconcile serially in discovery
  // order: the reconcile loop feeds order-sensitive state (changedFiles order
  // drives the worker-result pairing, seenMsgIds pre-seeding), so only the
  // syscalls are allowed to overlap.
  const walked = await mapWithConcurrency(dirs, FS_SCAN_CONCURRENCY, async ({ path: dirPath }) => {
    const jsonlFiles = await collectJsonlFiles(dirPath)
    dirsDone++
    await discoverProgress.tick(dirsDone)
    return jsonlFiles
  })
  const discovered: Array<{ filePath: string; dirName: string; source?: SessionSourceMetadata }> = []
  for (let i = 0; i < dirs.length; i++) {
    const { name: dirName, source } = dirs[i]!
    for (const filePath of walked[i]!) discovered.push({ filePath, dirName, source })
  }
  const fingerprints = await mapWithConcurrency(discovered, FS_SCAN_CONCURRENCY, e => fingerprintFile(e.filePath))
  for (const [i, { filePath, dirName, source }] of discovered.entries()) {
    allDiscoveredFiles.add(filePath)
    const fp = fingerprints[i]
    if (!fp) continue

    const cached = section.files[filePath]
    const action = reconcileFile(fp, cached)
    if (!readOnly && deferToBackgroundFill(filePath, fp, cached)) {
      continue
    } else if (cached && (readOnly || action.action === 'unchanged')) {
      if (readOnly && action.action !== 'unchanged') readOnlyServedStale = true
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
    } else {
      // Read-only with no cache entry at all: this file is dropped from what
      // we serve, so the snapshot under-reports whatever days it covers.
      readOnlyServedStale = true
    }
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

  // Only whole-file re-parses go off-thread. Appends are the warm path: they read
  // a few KB past the cached offset, so a thread hop would cost more than it saves.
  const fullReparsePaths = changedFiles.filter(f => !f.append).map(f => f.filePath)
  const pendingBytes = changedFiles.reduce((n, f) => f.append ? n : n + f.info.fp.sizeBytes, 0)
  const decision = decideParseWorkers({ files: fullReparsePaths.length, bytes: pendingBytes })
  if (process.env['CODEBURN_VERBOSE'] === '1') {
    process.stderr.write(`codeburn: claude parse workers=${decision.workers} (${decision.reason})\n`)
  }
  // A pool that cannot even start (worker entry missing from an odd packaging,
  // thread limit reached) must degrade to the serial parse, not fail the run.
  let pool: ParseWorkerPool | null = null
  if (decision.workers > 0) {
    try {
      pool = new ParseWorkerPool(decision.workers)
    } catch (err) {
      process.stderr.write(`codeburn: parse workers unavailable, parsing serially (${err instanceof Error ? err.message : String(err)})\n`)
    }
  }
  const offThread = pool
    ? parseFilesInOrder<ClaudeWorkerParse>(pool, fullReparsePaths.map(filePath => ({ kind: 'claude', filePath })))
    : null
  // Files whose worker result had to be thrown away because an earlier file had
  // already claimed one of its message ids. Expected to stay near zero; a large
  // count means the corpus is full of resumed sessions and the pool is doing
  // double work.
  let workerDiscards = 0

  const installClaudeFile = async (filePath: string, info: FileInfo, parsed: ClaudeFileParse): Promise<void> => {
    const cwd = parsed.workingDirectory
    const trustedCwd = cwd && !isCoworkSession(cwd, filePath) ? cwd : undefined
    const canonical = trustedCwd ? await resolveCanonicalProjectPath(trustedCwd) : undefined
    const lineage = claudeLineageForParse(parsed.parentSessionId, parsed.agentSpawnLinks)
    section.files[filePath] = {
      fingerprint: info.fp,
      lastCompleteLineOffset: parsed.lastCompleteLineOffset,
      canonicalCwd: canonical?.path,
      ...(trustedCwd ? { workingDirectory: trustedCwd } : {}),
      canonicalProjectName: canonical?.isWorktree ? projectNameFromPath(canonical.path, info.dirName) : undefined,
      mcpInventory: parsed.mcpInventory,
      turns: parsed.turns,
      agentType: parsed.agentType,
      ...(parsed.title ? { title: parsed.title } : {}),
      ...(parsed.prLinks?.length ? { prLinks: parsed.prLinks } : {}),
      ...(parsed.isSidechain ? { isSidechain: true } : {}),
      ...(parsed.parentSessionId ? { parentSessionId: parsed.parentSessionId } : {}),
      ...(Object.keys(parsed.agentSpawnLinks ?? {}).length > 0 ? { agentSpawnLinks: parsed.agentSpawnLinks } : {}),
      ...(parsed.ambiguousSpawnAgentIds?.length ? { ambiguousSpawnAgentIds: parsed.ambiguousSpawnAgentIds } : {}),
      ...(lineage ? { lineage } : {}),
    }
    markCacheDirty(diskCache, 'claude', filePath)
  }

  try {
    for (const { filePath, info, append } of changedFiles) {
      filesParsedFromSource++
      // Marked here, not after the re-parse: an unreadable file `continue`s out
      // below, and the deletion would otherwise live only in memory.
      delete section.files[filePath]
      markCacheDirty(diskCache, 'claude', filePath)

      // Off-thread results arrive in this order (parseFilesInOrder), so the Nth
      // full re-parse here is the Nth yielded result — appends never consume one,
      // in either the shortcut or the straddled-fallthrough case. A worker parses
      // against an EMPTY dedup set, so an EMPTY id intersection is the proof that a
      // serial parse would have dropped nothing either — that, and only that, makes
      // the result installable. On any overlap the WHOLE file is discarded and
      // re-parsed in-process. Never patch the overlapping turns out of a worker
      // result instead: a drop is not local to its own turn, because
      // parsedTurnsToCachedTurns delta-encodes gitBranch across turns, so removing
      // one turn changes whether a LATER turn carries a gitBranch key.
      // Deliberately OUTSIDE the per-file try below: the pairing is positional, and
      // a misalignment would install one session's turns under another's path — a
      // wrong number nobody would ever notice, so it fails the run instead of being
      // caught as a parse failure.
      let parsed: ClaudeFileParse | null | undefined
      if (offThread && !append) {
        const result = (await offThread.next()).value
        if (result?.ok && result.parsed) {
          if (result.parsed.path !== filePath) {
            throw new Error(`claude parse worker result out of order: got ${result.parsed.path}, expected ${filePath}`)
          }
          if (result.parsed.msgIds.some(id => seenMsgIds.has(id))) {
            workerDiscards++
            parsed = undefined
          } else {
            for (const id of result.parsed.msgIds) seenMsgIds.add(id)
            parsed = result.parsed
          }
        } else if (result?.ok) {
          parsed = null
        }
      }

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
            if (workingDirectory && isCoworkSession(workingDirectory, filePath)) workingDirectory = undefined
            if (canonicalCwd === undefined && newEntries) {
              const cwd = extractCanonicalCwd(newEntries)
              const trustedCwd = cwd && !isCoworkSession(cwd, filePath) ? cwd : undefined
              workingDirectory = workingDirectory ?? trustedCwd
              const canonical = trustedCwd ? await resolveCanonicalProjectPath(trustedCwd) : undefined
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
            // Lineage is sticky: a parent/child identity recorded on either side
            // stays on the merged entry, with cached-first priority (the earliest
            // region wrote it). A newly-appended region that promotes the file to
            // root (e.g. an agent spawn result lands in the tail) wins because the
            // brief forbids dropping already-valid evidence.
            const mergedTitle = sessionMeta.title ?? cached.title
            const mergedPrLinks = Array.from(new Set([...(cached.prLinks ?? []), ...sessionMeta.prLinks]))
            const mergedSidechain = cached.isSidechain === true || sessionMeta.isSidechain
            const mergedParentSessionId = cached.parentSessionId ?? sessionMeta.parentSessionId
            const mergedSpawnLinks = { ...sessionMeta.agentSpawnLinks, ...cached.agentSpawnLinks }
            const mergedAmbiguousIds = Array.from(new Set([...(cached.ambiguousSpawnAgentIds ?? []), ...sessionMeta.ambiguousSpawnAgentIds]))
            const mergedLineage = claudeLineageForParse(mergedParentSessionId, mergedSpawnLinks) ?? cached.lineage

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
              ...(mergedLineage ? { lineage: mergedLineage } : {}),
            }
            markCacheDirty(diskCache, 'claude', filePath)
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

        if (parsed === undefined) parsed = await parseClaudeFileFull(filePath, seenMsgIds)
        if (!parsed) { filesDone++; await parseProgress.tick(filesDone); continue }

        await installClaudeFile(filePath, info, parsed)
      } catch (err) {
        // A single malformed Claude session file must not abort the whole run — that
        // would empty the daily-cache backfill and wipe the trend/history (issue #441,
        // same isolation the provider path already has). Record a failure marker keyed
        // by the current fingerprint so it isn't re-read and re-thrown every run; it
        // re-parses only if the file changes.
        section.files[filePath] = { fingerprint: info.fp, mcpInventory: [], turns: [], failed: true }
        markCacheDirty(diskCache, 'claude', filePath)
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
  } finally {
    await pool?.close()
  }
  if (pool && process.env['CODEBURN_VERBOSE'] === '1') {
    process.stderr.write(`codeburn: claude parse workers done, ${workerDiscards}/${fullReparsePaths.length} results re-parsed in-process on id overlap\n`)
  }
  parseProgress.finish()

  if (!readOnly && dirs.length > 0) {
    for (const cachedPath of Object.keys(section.files)) {
      if (allDiscoveredFiles.has(cachedPath)) continue
      // Keep PR-bearing orphans: their transcript is gone and can never re-parse,
      // but they carry attributable PR spend (surfaced above as a legacy split).
      if (section.files[cachedPath]?.prLinks?.length) continue
      delete section.files[cachedPath]
      markCacheDirty(diskCache, 'claude', cachedPath)
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
    // The keep/drop decision is taken on the RAW turn, before classifying it:
    // `cachedTurnToClassified` maps `calls` 1:1 onto `assistantCalls`, so a turn
    // with no call in range is dropped whole by the slicer below and classifying
    // it is pure waste (on a week view that is nearly all of history). The
    // carries above still run over the FULL ordered turn list.
    const classifiedTurns: ClassifiedTurn[] = []
    for (const turn of cachedFile.turns) {
      if (turn.gitBranch) carriedBranch = turn.gitBranch
      if (dateRange && !frozePrRefs) {
        const firstTs = turn.calls[0]?.timestamp
        if (firstTs && new Date(firstTs) >= dateRange.start) {
          prRefsAtRangeStart = carriedPrRefs
          frozePrRefs = true
        }
      }
      if (turn.prRefs?.length) carriedPrRefs = turn.prRefs
      if (dateRange && !callsInRange(turn.calls, dateRange)) continue
      const classified = cachedTurnToClassified(turn, carriedBranch)
      // Slice rather than drop: a turn spanning local midnight would otherwise
      // lose every call that lands in the requested day (issue #852). Only
      // `assistantCalls`/`timestamp` are touched — see classifiedTurnSlicedToRange.
      const sliced = dateRange ? classifiedTurnSlicedToRange(classified, dateRange) : classified
      if (sliced) classifiedTurns.push(sliced)
    }
    // Captured from the FULL turn list, which the date slice above can strip of
    // the turn a branch was first seen on. Lets the by-branch report keep this
    // session's in-range unbranched spend as `null` instead of discarding it.
    const everHadBranch = carriedBranch !== undefined

    // Built from the FULL (pre-slice) turn list: each subagent-spawn tool_use id ->
    // the PR set active at the turn that emitted it. Lets a subagent fold into the
    // right PR even when its launching turn is later sliced out of range. Only for
    // sessions that both spawned subagents and referenced a PR.
    const spawnPrSets = cachedFile.prLinks?.length ? buildSpawnPrSets(cachedFile.turns) : {}

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
    if (cachedFile.workingDirectory && !isCoworkSession(cachedFile.workingDirectory, filePath)) {
      session.workingDirectory = cachedFile.workingDirectory
    }
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
      session.isSidechain = true
      if (cachedFile.parentSessionId) session.parentSessionId = cachedFile.parentSessionId
      session.agentId = sessionId.startsWith('agent-') ? sessionId.slice('agent-'.length) : sessionId
    }
    // Parent linkage maps (only present on sessions that spawned subagents).
    if (cachedFile.agentSpawnLinks && Object.keys(cachedFile.agentSpawnLinks).length > 0) {
      session.agentSpawnLinks = cachedFile.agentSpawnLinks
    }
    if (cachedFile.ambiguousSpawnAgentIds?.length) session.ambiguousSpawnAgentIds = cachedFile.ambiguousSpawnAgentIds
    if (Object.keys(spawnPrSets).length > 0) session.spawnPrSets = spawnPrSets
    // Provider-recorded parent/child lineage (CB-1, slice 1). Mirrors whatever
    // the install path stored on the cached file; absent when no evidence.
    if (cachedFile.lineage) session.lineage = cachedFile.lineage

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
    ...(call.nanoAiu != null ? { nanoAiu: call.nanoAiu } : {}),
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
    costUSD: (call.provider === 'mistral-vibe' || call.provider === 'antigravity' || call.provider === 'devin' || call.provider === 'vercel-gateway' || call.provider === 'hermes' || call.provider === 'kiro' || call.provider === 'codewhale' || call.provider === 'quickdesk' || call.provider === 'cline-cli' || call.provider === 'omp' || call.provider === 'bahulam') ? call.costUSD : undefined,
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
    ...(isTrustedAbsoluteWorkingDirectory(call.workingDirectory)
      ? { workingDirectory: call.workingDirectory, workingDirectoryProvenance: 'provider-field' as const }
      : {}),
    toolSequence: call.toolSequence,
    ...(call.locAdded ? { locAdded: call.locAdded } : {}),
    ...(call.locRemoved ? { locRemoved: call.locRemoved } : {}),
    ...(call.editFailed ? { editFailed: call.editFailed } : {}),
    ...(call.nanoAiu != null ? { nanoAiu: call.nanoAiu } : {}),
    ...(call.requestMultiplier != null ? { requestMultiplier: call.requestMultiplier } : {}),
    ...(call.compactedAt ? { compactedAt: call.compactedAt } : {}),
    ...(call.initiator ? { initiator: call.initiator } : {}),
    ...(call.supplementaryAccounting ? { supplementaryAccounting: true } : {}),
    activeDurationMs: call.activeDurationMs,
    activeGeneratedTokens: call.activeGeneratedTokens,
    toolWaitMs: call.toolWaitMs,
  }
}

async function canonicalizeProviderCallProject(call: ParsedProviderCall): Promise<ParsedProviderCall> {
  if (!call.projectPath) return call

  const canonical = await resolveCanonicalProjectPath(call.projectPath)
  // projectPath is also used for local grouping and can be a provider storage
  // directory or derived label. Only a dedicated provider cwd is trusted for
  // outbound project and attribution data.
  if (!canonical.isWorktree) return call

  return {
    ...call,
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
    ...(call.nanoAiu != null ? { nanoAiu: call.nanoAiu } : {}),
    activeDurationMs: call.activeDurationMs,
    activeGeneratedTokens: call.activeGeneratedTokens,
    toolWaitMs: call.toolWaitMs,
  }
}

function parsedTurnToCachedTurn(turn: ParsedTurn): CachedTurn {
  return {
    timestamp: turn.timestamp,
    sessionId: turn.sessionId,
    userMessage: flatSlice(turn.userMessage, 2000),
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
    userMessage: flatSlice(call.userMessage, 2000),
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
        userMessage: flatSlice(call.userMessage, 2000),
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
  // Cache-rehydration twin of the fresh-parse pricing in
  // src/providers/codex.ts (and every other provider's parser): both go
  // through billableOutputTokens so a cached read and a cold parse can never
  // disagree about whether reasoning is already inside output (#1075).
  const outputForCost = billableOutputTokens(call.provider, u.outputTokens, u.reasoningTokens)
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
    activeDurationMs: call.activeDurationMs,
    activeGeneratedTokens: call.activeGeneratedTokens,
    toolWaitMs: call.toolWaitMs,
    ...(call.nanoAiu != null ? { nanoAiu: call.nanoAiu } : {}),
    ...(call.supplementaryAccounting || isHermesObservationKey(call.deduplicationKey)
      ? { supplementaryAccounting: true }
      : {}),
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

// Copilot behavioral-weight assignment + turn folding, applied per session at
// serve time just before summarization. A shutdown rollup (or its synthesized
// residual) is aggregate accounting, never a request, so it is always
// supplementary. A store row is one real request, but when the request's
// per-turn call exists in the cache its row is supplementary too — only the
// unpaired rows (store-only requests: a crash or pruned session-state lost
// their per-turn calls) carry behavioral weight. Which rows are paired was
// decided upstream over the FULL serve set (timestamp-adjacency matching in
// parseProviderSources' reconciliation sweep) and arrives as a key set, so a
// date-range slice that separates a row from its per-turn call cannot
// double-count the request across adjacent day queries.
// A turn made only of supplementary calls folds into the nearest behavioral
// turn — but only within a 30-minute window (deliberately WIDER than the
// 2-minute pairing window: folding only moves turn structure, and same-half-
// hour cost stays on its own day), so a rollup stamped days after the last
// activity keeps its own (weightless) turn and its cost stays on its own
// day. A session with no behavioral turn at all keeps its supplementary
// turns as-is — separate weightless containers, each on its own day.
const FOLD_WINDOW_MS = 30 * 60 * 1000
// Local calendar day of an epoch ms value, matching day-aggregator's local
// bucketing (not UTC): the fold must not move a turn across the boundary the
// daily rollup buckets on.
function localDayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}
function foldCopilotSupplementaryTurns(
  sessionId: string,
  turns: ClassifiedTurn[],
  supplementaryStoreKeys: ReadonlySet<string> | undefined,
): ClassifiedTurn[] {
  const shutdownPrefix = `copilot:${sessionId}:shutdown`
  let hasSupplementary = false
  for (const t of turns) {
    for (const c of t.assistantCalls) {
      if (
        c.deduplicationKey.startsWith(shutdownPrefix) ||
        (c.deduplicationKey.startsWith('copilot-store:') && supplementaryStoreKeys?.has(c.deduplicationKey))
      ) {
        c.supplementaryAccounting = true
        hasSupplementary = true
      }
    }
  }
  if (!hasSupplementary) return turns
  const anchored: ClassifiedTurn[] = []
  const floating: ClassifiedTurn[] = []
  for (const t of turns) {
    ;(t.assistantCalls.some(c => !c.supplementaryAccounting) ? anchored : floating).push(t)
  }
  if (floating.length === 0) return turns
  if (anchored.length === 0) {
    // No behavioral turn to fold into (a rollup-only session, or a range
    // slice that excluded every behavioral turn). The supplementary turns
    // stay SEPARATE: merging them into one container would re-anchor later
    // legs' turn-level cost onto the first leg's day. They carry zero
    // turn/call weight either way.
    return turns
  }
  // Nearest anchored turn by timestamp via one sorted pass + binary search —
  // a long session can hold thousands of turns and this runs on every serve.
  const anchorTs = anchored
    .map(a => ({ ts: new Date(a.timestamp).getTime(), turn: a }))
    .filter(a => !Number.isNaN(a.ts))
    .sort((a, b) => a.ts - b.ts)
  const kept: ClassifiedTurn[] = [...anchored]
  for (const t of floating) {
    const ts = new Date(t.timestamp).getTime()
    let best: ClassifiedTurn | null = null
    let bestDist = Infinity
    let bestAnchorTs = NaN
    if (anchorTs.length > 0 && !Number.isNaN(ts)) {
      let lo = 0
      let hi = anchorTs.length - 1
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (anchorTs[mid]!.ts < ts) lo = mid + 1
        else hi = mid
      }
      for (const idx of [lo - 1, lo]) {
        const a = anchorTs[idx]
        if (!a) continue
        const d = Math.abs(a.ts - ts)
        if (d < bestDist) {
          bestDist = d
          best = a.turn
          bestAnchorTs = a.ts
        }
      }
    }
    // Never fold across a local-day boundary: turn-level judgments (category
    // cost, edit/one-shot counts) are anchored to the TURN's day while
    // call-level totals bucket per call, so folding a 00:05 rollup into a
    // 23:55 turn would seal its cost under the earlier day's categories while
    // the headline counted it on its own — the two would stop reconciling.
    const sameDay = best !== null && localDayKey(bestAnchorTs) === localDayKey(ts)
    if (best && bestDist <= FOLD_WINDOW_MS && sameDay) {
      best.assistantCalls = [...best.assistantCalls, ...t.assistantCalls]
    } else {
      kept.push(t)
    }
  }
  return kept
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

// Everything a cold Claude re-parse does for ONE file: read + decode + line-parse
// the JSONL, group it into turns, shape it for the cache. Depends on nothing
// process-wide except `seenMsgIds`, so a worker thread can run it against a fresh
// empty set and the parent can install the result verbatim once it has confirmed
// none of those ids were already claimed by an earlier file. Canonical-path
// resolution deliberately stays with the caller: it walks the filesystem behind a
// process-global memo.
export type ClaudeFileParse = {
  lastCompleteLineOffset: number
  workingDirectory?: string
  mcpInventory: string[]
  turns: CachedTurn[]
  agentType?: string
  title?: string
  prLinks?: string[]
  isSidechain?: boolean
  parentSessionId?: string
  agentSpawnLinks?: Record<string, string>
  ambiguousSpawnAgentIds?: string[]
}

/// Derives the SessionLineage for a Claude file from the same fields the
/// sidechain folder already consumes (`parentSessionId` on a child, the
/// presence of `agentSpawnLinks` on a parent). Provider-recorded only -
/// no inference from directory layout, agentType, or filenames. Returns
/// `undefined` when the file has no provider evidence, in which case the
/// install path must omit the field.
function claudeLineageForParse(
  parentSessionId: string | undefined,
  agentSpawnLinks: Record<string, string> | undefined,
): SessionLineage | undefined {
  if (parentSessionId) {
    return { parentSessionId, role: 'child', evidence: 'provider-recorded' }
  }
  if (agentSpawnLinks && Object.keys(agentSpawnLinks).length > 0) {
    return { role: 'root', evidence: 'provider-recorded' }
  }
  return undefined
}

export async function parseClaudeFileFull(
  filePath: string,
  seenMsgIds: Set<string>,
): Promise<ClaudeFileParse | null> {
  const tracker = { lastCompleteLineOffset: 0 }
  const toolResultMeta = new Map<string, ToolResultMeta>()
  const sessionMeta = emptySessionMeta()
  const entries = await parseClaudeEntries(filePath, tracker, undefined, { toolResultMeta, sessionMeta })
  if (!entries) return null

  const turns = groupIntoTurns(dedupeStreamingMessageIds(entries), seenMsgIds, toolResultMeta)
  const cwd = extractCanonicalCwd(entries)
  return {
    lastCompleteLineOffset: tracker.lastCompleteLineOffset,
    ...(cwd ? { workingDirectory: cwd } : {}),
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
}

function getOrCreateProviderSection(cache: SessionCache, provider: string): ProviderSection {
  const envFp = computeEnvFingerprint(provider)
  const existing = cache.providers[provider]
  if (existing && existing.envFingerprint === envFp) return existing
  const section: ProviderSection = { envFingerprint: envFp, files: {} }
  // A fingerprint change (env override or parse-version bump) must re-parse
  // every present source, but for durable providers the cache is the ONLY
  // remaining record of usage whose source rows were already pruned. Dropping
  // an entry because its FILE still exists is not the same question: a
  // still-present OTel/session-store DB routinely keeps its file while the CLI
  // prunes rows out of it, so "path exists" was being read as "the source can
  // re-derive this", and the bump silently deleted history nothing could
  // rebuild (#946 review). Present or absent, the entry is carried forward;
  // a present source additionally gets an impossible fingerprint parked on it
  // so the new parse version re-reads it in full. The durable union merge
  // appends only turns whose dedup keys are not already cached, so the re-read
  // ADDS whatever the source still holds without duplicating or deleting what
  // it has already lost.
  //
  // The contract this rests on: a parse-version bump must not RE-KEY calls the
  // source can still re-derive. Same event, same deduplicationKey, or the
  // union counts it twice. Changing a provider's key shape is therefore a
  // cache-version (CACHE_VERSION) change, not a parse-version change.
  //
  // What the re-read is FOR, beyond appending new keys: the union replaces a
  // cached call with the freshly-derived one wherever the key matches, so a
  // bump that changes a call's metadata or day attribution (this PR's
  // shutdown-timestamp fallback, capture-only fields like nanoAiu/compactedAt,
  // the compaction row's output) lands on existing caches too. Only keys the
  // re-read did NOT produce keep the old parser's fields, and those are
  // precisely the ones the source can no longer re-derive — where stale
  // accounting is the only alternative to nothing at all.
  if (existing && DURABLE_PROVIDER_NAMES.has(provider)) {
    if (existing.durable) section.durable = true
    for (const [path, file] of Object.entries(existing.files)) {
      if (!existsSync(path)) {
        section.files[path] = file
        continue
      }
      const { lastCompleteLineOffset: _resumeOffset, failed: _failed, ...rest } = file
      section.files[path] = { ...rest, fingerprint: { dev: 0, ino: 0, mtimeMs: 0, sizeBytes: -1 } }
    }
  }
  cache.providers[provider] = section
  markCacheDirty(cache, provider)
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

/// Per-source lineage resolver. Today only Kimi Code records parent/child
/// evidence on disk outside Claude's own transcript; the rest of the
/// providers return `undefined` so the install path is a no-op for them
/// (no `state.json` re-reads, no extra I/O on codex/copilot/etc.). The
/// Claude install path is handled inline by `installClaudeFile`, which
/// already owns the parent's `agentSpawnLinks` and the child's
/// `parentSessionId` from the same transcript.
async function resolveProviderLineage(
  providerName: string,
  source: SessionSource,
): Promise<SessionLineage | undefined> {
  if (providerName !== 'kimicode') return undefined
  const agentId = source.sourceId || basename(dirname(source.path))
  return kimicodeLineageForSource(source.path, agentId)
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
  // Carries no information beyond "this parse is still alive". Consumers that
  // do not know it must ignore it rather than fail (app/renderer Splash does).
  | { kind: 'keepalive' }

export function emitScanProgress(event: ScanProgressEvent): void {
  if (process.env['CODEBURN_PROGRESS'] !== '1') return
  try { process.stderr.write(`${PROGRESS_LINE_PREFIX}${JSON.stringify(event)}\n`) } catch { /* stderr closed */ }
}

// A cold parse has genuinely silent stretches: the inter-provider cache save at
// the end of each provider measured 31.6s of total silence on a large corpus,
// and the desktop app's no-output watchdog reads silence as a dead child. Beat
// unconditionally while a parse is running, so silence means stopped, not slow.
const PROGRESS_KEEPALIVE_MS = 10_000
let keepaliveTimer: ReturnType<typeof setInterval> | null = null
let keepaliveDepth = 0

export function startProgressKeepalive(): void {
  keepaliveDepth += 1
  if (keepaliveTimer || process.env['CODEBURN_PROGRESS'] !== '1') return
  keepaliveTimer = setInterval(() => emitScanProgress({ kind: 'keepalive' }), PROGRESS_KEEPALIVE_MS)
  keepaliveTimer.unref?.()
}

export function stopProgressKeepalive(): void {
  keepaliveDepth = Math.max(0, keepaliveDepth - 1)
  if (keepaliveDepth > 0 || !keepaliveTimer) return
  clearInterval(keepaliveTimer)
  keepaliveTimer = null
}

// Files parsed between partial-progress saves during a cold parse. Low enough
// that an interrupted long run loses little work, high enough that repeated
// cache writes never dominate the parse.
const PROGRESS_SAVE_FILE_INTERVAL = 2000
// Every parse phase now reports per file (claude via scanProjectDirs, the rest
// via parseProviderSources), so this wall-clock floor bounds how much work a
// mid-phase kill can lose even when the file counter moves slowly.
const PROGRESS_SAVE_MAX_INTERVAL_MS = 30_000

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

// Shared by the turn-range slicers below: which of a turn's calls actually
// fall inside dateRange. Returns null when none do (the turn should be dropped
// entirely, not kept with an empty call list).
function callsInRange<T extends { timestamp: string }>(calls: T[], dateRange: DateRange): T[] | null {
  const inRange = calls.filter(c => {
    const ts = new Date(c.timestamp)
    return !Number.isNaN(ts.getTime()) && ts >= dateRange.start && ts <= dateRange.end
  })
  return inRange.length > 0 ? inRange : null
}

// A turn can span local midnight (e.g. a long-running autonomous Codex
// session): dropping the whole turn because its FIRST call falls outside
// dateRange discards every later call that lands in the requested day (issue
// #852). Instead, keep only the calls actually inside the range. `timestamp`
// is re-anchored to the first surviving call so downstream turn-anchored
// bucketing (session day, report rollups) keys the slice under the day its
// retained calls actually fall in, not the pre-slice turn's original
// (possibly prior-day) start. Returns null when no call is in range.
function turnSlicedToRange(turn: CachedTurn, dateRange: DateRange): CachedTurn | null {
  const inRangeCalls = callsInRange(turn.calls, dateRange)
  if (!inRangeCalls) return null
  if (inRangeCalls.length === turn.calls.length) return turn
  return { ...turn, calls: inRangeCalls, timestamp: inRangeCalls[0]!.timestamp }
}

// Same slice, applied post-classification (scanProjectDirs classifies each
// surviving turn from its FULL call list, before date filtering — see the
// carriedBranch/carriedPrRefs comments in scanProjectDirs — so this only
// trims `assistantCalls` and re-anchors `timestamp`; `category`/`subCategory`/
// `retries`/`hasEdits` stay exactly as classified from the complete turn.
// Those are turn-level judgments about the whole exchange, not a per-call
// sum, so they aren't recomputed from the partial call list.
function classifiedTurnSlicedToRange(turn: ClassifiedTurn, dateRange: DateRange): ClassifiedTurn | null {
  const inRangeCalls = callsInRange(turn.assistantCalls, dateRange)
  if (!inRangeCalls) return null
  if (inRangeCalls.length === turn.assistantCalls.length) return turn
  return { ...turn, assistantCalls: inRangeCalls, timestamp: inRangeCalls[0]!.timestamp }
}

// Day-set variant of classifiedTurnSlicedToRange for the menubar/history day
// selection: keep only the calls whose own local day is selected and
// re-anchor `timestamp` to the first survivor — the same split rule.
function classifiedTurnSlicedToDays(turn: ClassifiedTurn, days: Set<string>): ClassifiedTurn | null {
  const inRangeCalls = turn.assistantCalls.filter(c => {
    const ts = new Date(c.timestamp)
    return !Number.isNaN(ts.getTime()) && days.has(dateKey(c.timestamp))
  })
  if (inRangeCalls.length === 0) return null
  if (inRangeCalls.length === turn.assistantCalls.length) return turn
  return { ...turn, assistantCalls: inRangeCalls, timestamp: inRangeCalls[0]!.timestamp }
}

export async function parseProviderSources(
  providerName: string,
  sources: SessionSource[],
  seenKeys: Set<string>,
  diskCache: SessionCache,
  dateRange?: DateRange,
  // Cold-run robustness: called after each source's cache entry lands (mirrors
  // scanProjectDirs' onFileParsed) so a throttled caller can persist partial
  // progress mid-provider. Without this a run killed during a large single-
  // provider phase (e.g. a multi-GB codex corpus) restarted that whole phase
  // from zero, even though Claude's phase already survived the same kill via
  // scanProjectDirs.
  onFileParsed?: () => Promise<void>,
  readOnly = false,
): Promise<ProjectSummary[]> {
  const provider = await getProvider(providerName)
  if (!provider) return []
  // The environment is a call-time input. Capture Antigravity's cache target
  // for this whole parse transaction so a host changing CODEBURN_CACHE_DIR
  // before the final flush cannot redirect A's dirty state into (or past) B.
  const antigravityCacheDir = providerName === 'antigravity' ? getCodeburnCacheDir() : undefined

  const section = getOrCreateProviderSection(diskCache, providerName)
  if (providerName === 'hermes' && !readOnly) {
    try {
      // Isolated migration: seed missing cursors from the already-loaded
      // hermes section before any source is deleted in this parse loop.
      await seedHermesCursorsFromProviderSection(section)
    } catch (err) {
      if (isHermesLedgerPublicationError(err)) {
        deferredRetryableSource = true
      } else {
        throw err
      }
    }
  }
  const allDiscoveredFiles = new Set<string>()
  const servedSources = [...sources]

  type SourceInfo = { source: SessionSource; fp: NonNullable<Awaited<ReturnType<typeof fingerprintFile>>> }
  const unchangedSources: Array<{ source: SessionSource; cached: CachedFile }> = []
  const changedSources: SourceInfo[] = []

  // Same shape as scanProjectDirs: overlap the stat syscalls, then reconcile in
  // discovery order. Network sources on a write run never reach fingerprintFile
  // (they take the synthetic-fingerprint branch below), so they are skipped here.
  const skipFingerprint = provider.network && !readOnly
  const sourceFingerprints = skipFingerprint
    ? []
    : await mapWithConcurrency(sources, FS_SCAN_CONCURRENCY, s => fingerprintFile(s.path))

  for (const [sourceIndex, source] of sources.entries()) {
    allDiscoveredFiles.add(source.path)

    // Network providers (e.g. Vercel AI Gateway) have no on-disk file — their data
    // comes from a live API fetch in createSessionParser. There's nothing to
    // fingerprint or incrementally cache, so re-fetch every run with a synthetic
    // fingerprint (mtime=now so the date-range filter below never excludes it).
    if (skipFingerprint) {
      changedSources.push({ source, fp: { dev: 0, ino: 0, mtimeMs: Date.now(), sizeBytes: 0 } })
      continue
    }

    const fp = sourceFingerprints[sourceIndex]
    if (!fp) {
      // A source that was discovered but cannot be fingerprinted is skipped —
      // but skipping is only safe when the file is genuinely GONE (discovery
      // raced a deletion; nothing to hydrate). An unreadable-but-present file
      // (EACCES/EIO) may hold changes no parser ever got to defer on, so the
      // pass must not report full hydration (round-6 finding: an unreadable
      // store fingerprint silently bypassed the deferral fence). Network
      // sources have no file to be unreadable — their synthetic paths always
      // stat ENOENT — and never defer here. Virtual-suffix paths (cursor
      // `#…`, opencode `:…`) must be classified against the same underlying
      // paths the fingerprint read: the compound path itself always ENOENTs.
      if (provider.network) continue
      for (const candidate of sourcePathStatCandidates(source.path)) {
        const code = await stat(candidate).then(
          () => null,
          (e: unknown) => (e as NodeJS.ErrnoException).code ?? 'UNKNOWN'
        )
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          deferredRetryableSource = true
          break
        }
      }
      continue
    }

    const cached = section.files[source.path]
    const action = reconcileFile(fp, cached)
    // A cached parse failure at this same fingerprint stays skipped — don't
    // re-read a file that already threw and hasn't changed. It re-parses only
    // when the file changes (then `reconcileFile` reports non-'unchanged').
    if (!readOnly && deferToBackgroundFill(source.path, fp, cached)) {
      continue
    } else if (cached && (readOnly || (action.action === 'unchanged' && (cached.failed || !cachedFileNeedsProviderReparse(providerName, source.path, cached))))) {
      if (readOnly && action.action !== 'unchanged') readOnlyServedStale = true
      unchangedSources.push({ source, cached })
    } else if (!readOnly) {
      changedSources.push({ source, fp })
    } else {
      // Read-only with no cache entry at all — see scanProjectDirs.
      readOnlyServedStale = true
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

  // Read the durable record LAST. Copilot reconciles a session.shutdown rollup
  // against the session-store rows written up to it, and the two live in
  // different files: a session that shuts down mid-pass appends its rollup to
  // events.jsonl AND its last row to the store, and whichever we read first is
  // the one that can be short. Rows commit strictly before their leg's
  // shutdown line, so reading the store after every journal makes our row set
  // a superset of what any rollup we read can claim — the short direction (a
  // rollup reconciled against rows that had not landed yet) becomes
  // unreachable, and only the harmless direction is left: a row with no
  // journal partner yet, which serves its own tokens and pairs on the next
  // pass. Ordering costs nothing; the parse loop already runs in array order.
  if (changedSources.some(c => c.source.retainWhilePresent)) {
    changedSources.sort((a, b) => Number(a.source.retainWhilePresent ?? false) - Number(b.source.retainWhilePresent ?? false))
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

  // Codex rollouts are the bulk of a cold parse (multi-GB against Claude's
  // hundreds of MB), so whole-file decodes go to worker threads. A file the
  // codex cache can serve exactly, or resume into from a byte offset, stays
  // in-process: it reads a few KB, and it is the codex cache's own per-directory
  // state that a thread must never own. The eligible list is built with the same
  // filters (and in the same order) the parse loop applies, so the Nth result
  // parseFilesInOrder yields is the Nth file that reaches the worker branch.
  // The decision is per provider rather than pooled across Claude+Codex because
  // the two scans run one after the other — at most one pool is ever alive — and
  // a per-provider count is what the verbose line can honestly report.
  const workerJobs: ParseJob[] = []
  const workerPaths = new Set<string>()
  let workerDiscards = 0
  let pendingBytes = 0
  if (providerName === 'codex' && !readOnly) {
    for (const { source, fp } of changedSources) {
      if (dateRange && fp.mtimeMs < dateRange.start.getTime()) continue
      if (await readCachedCodexResults(source.path)) continue
      workerJobs.push({ kind: 'codex', source })
      workerPaths.add(source.path)
      pendingBytes += fp.sizeBytes
    }
  }
  const decision = workerJobs.length > 0
    ? decideParseWorkers({ files: workerJobs.length, bytes: pendingBytes })
    : { workers: 0, reason: 'no full parses pending' }
  if (providerName === 'codex' && !readOnly && process.env['CODEBURN_VERBOSE'] === '1') {
    process.stderr.write(`codeburn: codex parse workers=${decision.workers} (${decision.reason})\n`)
  }
  let pool: ParseWorkerPool | null = null
  if (decision.workers > 0) {
    try {
      pool = new ParseWorkerPool(decision.workers)
    } catch (err) {
      process.stderr.write(`codeburn: parse workers unavailable, parsing serially (${err instanceof Error ? err.message : String(err)})\n`)
    }
  }
  const offThread = pool ? parseFilesInOrder<CodexFullParse & { keys: string[]; path: string }>(pool, workerJobs) : null

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
      filesParsedFromSource++

      // Clear stale entry before parse — but only once per path so that
      // multiple sources mapping to the same file path can merge their turns.
      // Durable providers (e.g. copilot OTel) never clear existing entries so
      // that pruned-away data is preserved for monotonic monthly totals.
      if (!provider.durableSources && !clearedPaths.has(source.path)) {
        delete section.files[source.path]
        markCacheDirty(diskCache, providerName, source.path)
        clearedPaths.add(source.path)
      }

      // Off-thread results arrive in this order, so the Nth eligible file here is
      // the Nth yielded result. A worker decodes against an EMPTY dedup set, so an
      // EMPTY key intersection is the proof that a serial parse would have dropped
      // nothing either — that, and only that, makes the result installable. On any
      // overlap (a forked rollout replaying its parent's token_count history is
      // exactly this) the WHOLE file is discarded and re-parsed in-process against
      // the real dedup set. Deliberately OUTSIDE the per-file try below: the
      // pairing is positional, and a misalignment would install one rollout's
      // calls under another's path — a wrong number nobody would ever notice, so
      // it fails the run instead of being caught as a parse failure.
      let providerCalls: ParsedProviderCall[] | undefined
      if (offThread && workerPaths.has(source.path)) {
        const result = (await offThread.next()).value
        if (result?.ok && result.parsed) {
          if (result.parsed.path !== source.path) {
            throw new Error(`codex parse worker result out of order: got ${result.parsed.path}, expected ${source.path}`)
          }
          if (result.parsed.keys.some(k => parserDedup.has(k))) {
            workerDiscards++
          } else {
            for (const k of result.parsed.keys) parserDedup.add(k)
            providerCalls = result.parsed.calls
            // The worker never touches the codex cache; publish its entry here,
            // in install order, so flushCodexCache writes what serial would.
            const write = result.parsed.write
            if (write) await writeCachedCodexResults(source.path, write.project, providerCalls, write.fingerprint, write.resume)
          }
        }
      }

      try {
        if (!providerCalls) {
          const parser = provider.createSessionParser(source, parserDedup, dateRange)
          providerCalls = []
          for await (const call of parser.parse()) {
            providerCalls.push(call)
          }
        }
        const canonicalCalls = await Promise.all(providerCalls.map(canonicalizeProviderCallProject))
        const turns = providerCallsToCachedTurns(canonicalCalls)
        const prLinks = [...new Set(canonicalCalls.flatMap(call => call.prLinks ?? []))]
        // Provider-recorded parent/child lineage (CB-1, slice 1). Kimi Code is
        // the only non-Claude provider that records evidence on disk today;
        // every other provider returns `undefined` here, so the install path
        // stays a no-op for them.
        const sourceLineage = await resolveProviderLineage(providerName, source)
        const sourceAgentMetadata = {
          ...(source.agentName ? { agentName: source.agentName } : {}),
          ...(source.agentStartedAt ? { agentStartedAt: source.agentStartedAt } : {}),
        }

        // Store/merge parsed turns into the cache.
        // Durable providers use a union-by-deduplicationKey merge: existing turns
        // are NEVER deleted (preserves data for spans pruned from the DB). Keys
        // the parse did not produce - rows the source has since pruned - are
        // exactly what the cache is the last record of, so they stay untouched.
        // A key the parse DID produce is re-derived from the live source in this
        // very pass, so the fresh call replaces the cached one in place.
        //
        // That replacement is load-bearing, not tidiness. Fields a parse-version
        // bump adds to a call whose key is stable (copilot `compactedAt` on the
        // shutdown rollup, `initiator`/output on a store row) could otherwise
        // never reach a cache written before the bump: append-only left the old
        // field-set in place forever, and the reconciliation then ran on a
        // migrated cache with an anchor the virgin cache had - dropping the
        // post-compaction residual (#946 validation round 6, see (c6)).
        // Non-durable providers keep the original overwrite-or-append behaviour.
        if (provider.durableSources) {
          const existingEntry = section.files[source.path]
          if (existingEntry) {
            const freshByKey = new Map(turns.flatMap(t => t.calls).map(c => [c.deduplicationKey, c]))
            if (freshByKey.size > 0) {
              existingEntry.turns = existingEntry.turns.map(t => {
                const calls = t.calls.map(c => freshByKey.get(c.deduplicationKey) ?? c)
                return calls.some((c, i) => c !== t.calls[i]) ? { ...t, calls } : t
              })
            }
            const existingKeys = new Set(
              existingEntry.turns.flatMap(t => t.calls.map(c => c.deduplicationKey))
            )
            // Call level, not turn level: a re-parse that returns a turn
            // holding one already-cached call beside a genuinely new one is
            // rare (durable providers emit one call per turn today) but
            // dropping the whole turn on the first match would silently lose
            // the new call, and nothing enforces the one-call assumption.
            const newTurns = turns
              .map(t => ({ ...t, calls: t.calls.filter(c => !existingKeys.has(c.deduplicationKey)) }))
              .filter(t => t.calls.length > 0)
            existingEntry.turns = [...existingEntry.turns, ...newTurns]
            existingEntry.fingerprint = fp
            if (prLinks.length) existingEntry.prLinks = [...new Set([...(existingEntry.prLinks ?? []), ...prLinks])]
            // Lineage is sticky on the merge: a recorded parent/child on
            // either side stays. A first parse that missed the `state.json`
            // agents map (e.g. a brand-new session before its first spawn)
            // later grows into a parent; re-parsing it then promotes its
            // role to `root` here, never silently drops the field.
            if (sourceLineage) existingEntry.lineage = sourceLineage
          } else {
            section.files[source.path] = { fingerprint: fp, mcpInventory: [], turns, ...sourceAgentMetadata, ...(prLinks.length ? { prLinks } : {}), ...(sourceLineage ? { lineage: sourceLineage } : {}) }
          }
        } else {
          // Non-durable: overwrite (clearedPaths already deleted stale entry above)
          // or append when multiple sources map to the same path. NOTE: the append
          // path assumes discoverSessions yields a unique path per source, which all
          // current providers do; it only fires for same-path multi-source providers.
          const existingCacheEntry = section.files[source.path]
          if (existingCacheEntry) {
            existingCacheEntry.turns = [...existingCacheEntry.turns, ...turns]
            if (prLinks.length) existingCacheEntry.prLinks = [...new Set([...(existingCacheEntry.prLinks ?? []), ...prLinks])]
            if (sourceLineage) existingCacheEntry.lineage = sourceLineage
          } else {
            section.files[source.path] = { fingerprint: fp, mcpInventory: [], turns, ...sourceAgentMetadata, ...(prLinks.length ? { prLinks } : {}), ...(sourceLineage ? { lineage: sourceLineage } : {}) }
          }
        }
        didParse = true
        markCacheDirty(diskCache, providerName, source.path)
      } catch (err) {
        if (isSqliteBusyError(err) || isHermesLedgerPublicationError(err)) {
          // Deferred, not failed: the cache keeps serving this source's
          // previous rows and the next refresh retries. But the data this
          // read would have added is MISSING from this parse, so the run is a
          // partial hydration — the daily backfill must not finalize history
          // built on it (the same fence a stale read-only serve raises).
          deferredRetryableSource = true
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
        markCacheDirty(diskCache, providerName, source.path)
        warnProviderParseFailure(providerName, source.path, err)
      }
      // Outside the try/catch (matches scanProjectDirs' onFileParsed placement)
      // so a throttled caller only ever observes this source's cache entry once
      // it is fully installed above — success or recorded failure, never mid-write.
      if (onFileParsed) await onFileParsed()
    }
  } finally {
    await pool?.close()
    if (pool && process.env['CODEBURN_VERBOSE'] === '1') {
      process.stderr.write(`codeburn: codex parse workers done, ${workerDiscards}/${workerJobs.length} results re-parsed in-process on id overlap\n`)
    }
    if (didParse && providerName === 'codex') await flushCodexCache()
    if (didParse && providerName === 'antigravity') {
      const liveIds = new Set(sources.map(s => antigravityCascadeIdFromPath(s.path)))
      await flushAntigravityCache(liveIds, antigravityCacheDir)
    }
  }

  // The other half of "read the durable record last": a store served from
  // cache is never re-read, so ordering cannot help it. If it was unchanged at
  // classification but has moved by the time the journals are parsed, the rows
  // we just reconciled a rollup against are stale by exactly the window the
  // ordering closes for a changed store. That is a partial hydration, not a
  // wrong number to seal — hold the daily watermark and let the next refresh,
  // which will see the store as changed and re-read it, finalize the day.
  // Deliberately not applied to a store we DID re-read: it was read after
  // every journal, so a row landing afterwards belongs to a session whose
  // shutdown line we cannot have seen yet.
  if (!readOnly && !deferredRetryableSource) {
    for (const { source } of unchangedSources) {
      if (!source.retainWhilePresent) continue
      const used = section.files[source.path]?.fingerprint
      if (!used) continue
      const now = await fingerprintFile(source.path)
      if (!now) {
        // Unreadable, not necessarily gone. The classification path already
        // treats present-but-unfingerprintable as a deferral rather than a
        // skip; do the same here, or a store that became unreadable mid-pass
        // would be the one shape that seals silently. A genuinely deleted
        // store has nothing left to reconcile against and stays a skip.
        for (const candidate of sourcePathStatCandidates(source.path)) {
          const code = await stat(candidate).then(
            () => null,
            (e: unknown) => (e as NodeJS.ErrnoException).code ?? 'UNKNOWN',
          )
          if (code !== 'ENOENT' && code !== 'ENOTDIR') { deferredRetryableSource = true; break }
        }
        if (deferredRetryableSource) break
        continue
      }
      if (now.mtimeMs !== used.mtimeMs || now.sizeBytes !== used.sizeBytes || now.ino !== used.ino) {
        deferredRetryableSource = true
        break
      }
    }
  }

  // Stamp the durable flag into the cache section so the orphan-bootstrap in
  // parseAllSessions can fast-check without a getProvider() round-trip.
  if (!readOnly && provider.durableSources && !section.durable) {
    section.durable = true
    markCacheDirty(diskCache, providerName)
  }

  if (!readOnly && sources.length > 0 && !provider.durableSources) {
    for (const cachedPath of Object.keys(section.files)) {
      if (!allDiscoveredFiles.has(cachedPath)) {
        delete section.files[cachedPath]
        markCacheDirty(diskCache, providerName, cachedPath)
      }
    }
  }

  // 90-day age-out for durable providers: prune only orphaned entries whose
  // newest call is older than 90 days. Still-discovered sources remain live
  // regardless of age and keep their persisted fingerprint for reuse (#992).
  // retainWhilePresent (copilot's session-store.db, the durable record itself)
  // states the same intent explicitly for a still-discovered source; under the
  // orphan-only rule it is currently redundant rather than load-bearing.
  if (!readOnly && provider.durableSources) {
    const retainPaths = new Set(sources.filter(s => s.retainWhilePresent).map(s => s.path))
    const cutoffMs = Date.now() - 90 * 24 * 60 * 60 * 1000
    for (const [cachedPath, cachedFile] of Object.entries(section.files)) {
      if (retainPaths.has(cachedPath)) continue
      const newestTs = cachedFile.turns
        .flatMap(t => t.calls)
        .map(c => new Date(c.timestamp).getTime())
        .filter(ts => !isNaN(ts))
        .reduce((max, ts) => Math.max(max, ts), 0)
      if (!allDiscoveredFiles.has(cachedPath) && newestTs > 0 && newestTs < cutoffMs) {
        delete section.files[cachedPath]
        markCacheDirty(diskCache, providerName, cachedPath)
      }
    }
  }

  // Copilot rollup-vs-store reconciliation, enforced at SERVE time — the sole
  // precedence mechanism. Parsers cache both representations of a session
  // unconditionally (per-request store rows and the shutdown rollup); the
  // serve set is the one coherent snapshot, so deciding here cannot be raced
  // by writers between a probe and a parse, and heals any path into the cache.
  // Per (session, model): when store rows exist, the rollup calls are dropped
  // and replaced by the rows PLUS per-leg residual calls for any usage a
  // rollup leg carried beyond the rows in ITS OWN interval — rows commit
  // strictly before their leg's shutdown line, so a leg at time T covers
  // exactly the rows in (previous leg's T, T], and rows outside that interval
  // (a crash tail after the last clean shutdown, a later DB reset) can never
  // cancel a different leg's missing usage. A store missing requests a leg
  // covered therefore still serves that tail exactly once, on the leg's own
  // day; a complete store serves pure per-request granularity with every
  // residual at zero. The decision reads only cached contents, never
  // discovery: an absent or deleted store changes nothing at serve, so a
  // finalized daily history can never flip when the store file comes and
  // goes. Cached rows of a deleted store stop influencing results only when
  // the 90-day age-out removes them.
  //
  // The same sweep resolves two identity questions from the full cached data
  // so that answers are invariant across date ranges and file churn:
  // - Row↔per-turn pairing (behavioral weight): a store row and the per-turn
  //   call of the same request carry no shared id, so rows pair with same-
  //   model per-turn calls by timestamp adjacency (monotone two-pointer
  //   matching, 2-minute window — the two are written moments apart). The
  //   paired rows' dedup keys become supplementary; unpaired rows are
  //   store-only requests and keep behavioral weight. Computed over the FULL
  //   serve set, never a range slice, so adjacent day queries agree with the
  //   lifetime answer.
  // - Project identity: every call of a session serves under the session's
  //   session-state-derived label when the serve set knows it, else the store
  //   rows' own label — so neither a store row cached before events.jsonl
  //   existed nor an events.jsonl orphaned after a prune can split the
  //   session across two grouping keys.
  type CopilotStamped = { ts: number; input: number; cacheRead: number; cacheWrite: number; reasoning: number; isCompaction?: boolean }
  let copilotRecon: {
    storeKeys: Set<string>
    storeCalls: Map<string, CopilotStamped[]>
    rollupLegs: Map<string, Array<CopilotStamped & { rawTs: string; compactedAtMs: number }>>
    supplementaryStoreKeys: Set<string>
    sessionProject: Map<string, string>
    storeProject: Map<string, string>
    nanRollupFallbackTs: Map<string, string>
    sessionEarliestValidTs: Map<string, string>
  } | null = null
  if (providerName === 'copilot') {
    // DEPENDS on the durable full-load exemption in session-cache.ts
    // (DURABLE_PROVIDER_NAMES / meta.durable): pairing and residual
    // retirement are range-invariant only because this sweep always sees the
    // COMPLETE cached serve set, never a month-scoped subset. If copilot ever
    // leaves the durable set or the exemption is relaxed, reconciliation
    // becomes range-dependent and breaks silently.
    const seenAggKeys = new Set<string>()
    const storeKeys = new Set<string>()
    const storeCalls = new Map<string, CopilotStamped[]>()
    const rollupLegs = new Map<string, Array<CopilotStamped & { rawTs: string; compactedAtMs: number }>>()
    const storeRowIds = new Map<string, Array<{ ts: number; dedupKey: string }>>()
    const perTurnTs = new Map<string, number[]>()
    const sessionProject = new Map<string, string>()
    const storeProject = new Map<string, string>()
    // Stable timestamp fallbacks for rollup calls whose own stamp cannot
    // parse. Stability across serves is load-bearing: the daily union seals
    // whatever day the call served under, so the fallback must never move as
    // the session grows. The preceding valid timestamp in the SAME file is
    // immutable (session files are append-only); the session's EARLIEST
    // valid timestamp is the stable backstop (appends only add later ones).
    // "Latest valid" would move on every resume and double the call across
    // sealed days.
    const nanRollupFallbackTs = new Map<string, string>()
    const sessionEarliestValidTs = new Map<string, string>()
    // Session-state per-turn calls carry no per-call project (the serve loop
    // takes it from source.project), so resolve it the same way here — every
    // call of the session must serve under the SAME label, whichever of the
    // representations parsed first or survives on disk.
    const sourceProjectByPath = new Map(sources.map(s => [s.path, s.project]))
    for (const [cachedPath, cachedFile] of Object.entries(section.files)) {
      let lastValidTsInFile = ''
      for (const turn of cachedFile.turns) {
        const shutdownPrefix = `copilot:${turn.sessionId}:shutdown:`
        for (const c of turn.calls) {
          if (seenAggKeys.has(c.deduplicationKey)) continue
          seenAggKeys.add(c.deduplicationKey)
          const ts = new Date(c.timestamp).getTime()
          const isStore = c.deduplicationKey.startsWith('copilot-store:')
          const isRollup = c.deduplicationKey.startsWith(shutdownPrefix)
          const aggKey = `${turn.sessionId}\n${c.model}`
          if (!Number.isNaN(ts)) {
            lastValidTsInFile = c.timestamp
            const prev = sessionEarliestValidTs.get(turn.sessionId)
            if (!prev || c.timestamp < prev) sessionEarliestValidTs.set(turn.sessionId, c.timestamp)
          } else if (isRollup && lastValidTsInFile) {
            nanRollupFallbackTs.set(c.deduplicationKey, lastValidTsInFile)
          }
          if (!isStore && !isRollup) {
            const project = c.project ?? sourceProjectByPath.get(cachedPath)
            if (project && !sessionProject.has(turn.sessionId)) sessionProject.set(turn.sessionId, project)
            if (!Number.isNaN(ts)) {
              const list = perTurnTs.get(aggKey) ?? []
              list.push(ts)
              perTurnTs.set(aggKey, list)
            }
            continue
          }
          if (Number.isNaN(ts)) continue
          const stamped: CopilotStamped = {
            ts,
            input: c.usage.inputTokens,
            cacheRead: c.usage.cacheReadInputTokens,
            cacheWrite: c.usage.cacheCreationInputTokens,
            reasoning: c.usage.reasoningTokens,
          }
          if (isStore) {
            storeKeys.add(aggKey)
            const list = storeCalls.get(aggKey) ?? []
            // The CLI's own context-summarization request. It has no
            // assistant.message, so it must not compete for a per-turn partner
            // in the pairing pass below, and its usage belongs to the
            // compaction that reset the rollup rather than to the interval
            // after it. Labelled only where the store carries `initiator`;
            // where it does not, this row is indistinguishable from a user
            // request and keeps the pre-label behaviour.
            const isCompaction = c.initiator === 'compaction'
            list.push(isCompaction ? { ...stamped, isCompaction: true } : stamped)
            storeCalls.set(aggKey, list)
            if (!isCompaction) {
              const ids = storeRowIds.get(aggKey) ?? []
              ids.push({ ts, dedupKey: c.deduplicationKey })
              storeRowIds.set(aggKey, ids)
            }
            if (c.project && !storeProject.has(turn.sessionId)) storeProject.set(turn.sessionId, c.project)
          } else {
            const legs = rollupLegs.get(aggKey) ?? []
            const compactedAtMs = c.compactedAt ? new Date(c.compactedAt).getTime() : NaN
            legs.push({ ...stamped, rawTs: c.timestamp, compactedAtMs: Number.isNaN(compactedAtMs) ? -Infinity : compactedAtMs })
            rollupLegs.set(aggKey, legs)
          }
        }
      }
    }
    // Row↔per-turn pairing: monotone two-pointer matching over the sorted
    // timestamp lists. Paired rows are the requests whose per-turn call is
    // already served; the unpaired excess — the crash tail, or a whole
    // store-only history — keeps its weight. The window is TIGHT (2 minutes):
    // a request's row and its assistant.message are written at the same
    // completion moment, seconds apart, while a crash-only row sits minutes
    // to hours from any unrelated call — a wide window would let it pair
    // against a neighbor whose own row is missing and hide the crash
    // request's call weight. The residual ambiguity (a crash row landing
    // within the window of an unrecorded-row request) is a double-failure
    // conjunction and affects only call counts, never tokens.
    const PAIR_WINDOW_MS = 2 * 60 * 1000
    const supplementaryStoreKeys = new Set<string>()
    for (const [aggKey, ids] of storeRowIds) {
      const callTs = perTurnTs.get(aggKey)
      if (!callTs?.length) continue
      ids.sort((a, b) => a.ts - b.ts)
      callTs.sort((a, b) => a - b)
      let i = 0
      let j = 0
      while (i < ids.length && j < callTs.length) {
        const d = ids[i]!.ts - callTs[j]!
        if (Math.abs(d) <= PAIR_WINDOW_MS) {
          supplementaryStoreKeys.add(ids[i]!.dedupKey)
          i++
          j++
        } else if (d < 0) {
          i++
        } else {
          j++
        }
      }
    }
    copilotRecon = { storeKeys, storeCalls, rollupLegs, supplementaryStoreKeys, sessionProject, storeProject, nanRollupFallbackTs, sessionEarliestValidTs }
  }
  const copilotServeProject = (sessionId: string): string | undefined =>
    copilotRecon
      ? copilotRecon.sessionProject.get(sessionId) ?? copilotRecon.storeProject.get(sessionId)
      : undefined
  const reconcileCopilotCalls = (turn: CachedTurn): CachedTurn | null => {
    if (!copilotRecon) return turn
    const shutdownPrefix = `copilot:${turn.sessionId}:shutdown:`
    let changed = false
    const kept: CachedCall[] = []
    for (const c of turn.calls) {
      if (c.deduplicationKey.startsWith(shutdownPrefix)) {
        const tsValid = !Number.isNaN(new Date(c.timestamp).getTime())
        if (tsValid && copilotRecon.storeKeys.has(`${turn.sessionId}\n${c.model}`)) {
          // Store rows exist for this (session, model): the rollup is
          // replaced by the rows plus the per-leg residuals synthesized at
          // session assembly.
          changed = true
          continue
        }
        if (!tsValid) {
          // A rollup whose timestamp cannot parse never entered the residual
          // sweep, so dropping it would silently lose its usage — it serves
          // instead (weightless supplementary). But served with the broken
          // stamp it is invisible to every date-range filter (and poisons
          // day keys), so it adopts a STABLE valid timestamp: the one
          // preceding it in its own append-only file, else the session's
          // earliest. Stability matters — a moving fallback (e.g. "latest")
          // would relocate the call after a resume, doubling it across an
          // already-sealed day and its new one. Only a session with no valid
          // timestamp anywhere keeps the raw value.
          const fallbackTs =
            copilotRecon.nanRollupFallbackTs.get(c.deduplicationKey) ??
            copilotRecon.sessionEarliestValidTs.get(turn.sessionId)
          if (fallbackTs) {
            kept.push({ ...c, timestamp: fallbackTs })
            changed = true
            continue
          }
        }
        kept.push(c)
        continue
      }
      if (c.deduplicationKey.startsWith('copilot-store:')) {
        const project = copilotRecon.sessionProject.get(turn.sessionId)
        if (project && c.project !== project) {
          kept.push({ ...c, project })
          changed = true
          continue
        }
      }
      kept.push(c)
    }
    if (!changed) return turn
    if (kept.length === 0) return null
    // Re-anchor a turn whose own stamp cannot parse to its first surviving
    // call, mirroring turnSlicedToRange — day bucketing reads the turn stamp.
    const turnTsValid = !Number.isNaN(new Date(turn.timestamp).getTime())
    return { ...turn, calls: kept, ...(turnTsValid ? {} : { timestamp: kept[0]!.timestamp }) }
  }

  // Query-time: derive SessionSummary from all cached turns.
  // Uses seenKeys (shared across providers) for cross-provider dedup.
  const sessionMap = new Map<string, { project: string; projectPath?: string; workingDirectory?: string; turns: ClassifiedTurn[]; prLinks?: Set<string>; title?: string; lineage?: SessionLineage; agentName?: string; agentStartedAt?: string }>()

  for (const source of servedSources) {
    const cachedFile = section.files[source.path]
    if (!cachedFile) continue

    for (const rawTurn of cachedFile.turns) {
      const turn = reconcileCopilotCalls(rawTurn)
      if (!turn) continue
      const hasDup = turn.calls.some(c => seenKeys.has(c.deduplicationKey))
      if (hasDup) continue

      for (const c of turn.calls) seenKeys.add(c.deduplicationKey)

      let slicedTurn = turn
      if (dateRange) {
        const sliced = turnSlicedToRange(turn, dateRange)
        if (!sliced) continue
        slicedTurn = sliced
      }

      // Classify the FULL turn, then keep only the in-range calls: category /
      // hasEdits / retries are whole-exchange judgments, not per-call sums, so a
      // midnight-straddling turn is classified identically to the Claude path
      // (scanProjectDirs) rather than being re-derived from a partial slice.
      // Cost/calls come from the retained calls, unchanged.
      const classifiedFull = cachedTurnToClassified(turn)
      const classified = dateRange
        ? (classifiedTurnSlicedToRange(classifiedFull, dateRange) ?? classifiedFull)
        : classifiedFull
      const project = copilotServeProject(turn.sessionId) ?? slicedTurn.calls[0]?.project ?? source.project
      const key = `${providerName}:${turn.sessionId}:${project}`

      // Old caches can contain workingDirectory synthesized from projectPath.
      // Marker absence fails closed while preserving historical usage totals.
      const trustedWorkingDirectory = slicedTurn.calls[0]?.workingDirectoryProvenance === 'provider-field'
        && isTrustedAbsoluteWorkingDirectory(slicedTurn.calls[0].workingDirectory)
        ? slicedTurn.calls[0].workingDirectory
        : undefined

      const existing = sessionMap.get(key)
      if (existing) {
        existing.turns.push(classified)
        if (!existing.projectPath && slicedTurn.calls[0]?.projectPath) {
          existing.projectPath = slicedTurn.calls[0]!.projectPath
        }
        if (!existing.workingDirectory && trustedWorkingDirectory) existing.workingDirectory = trustedWorkingDirectory
        if (cachedFile.prLinks?.length) {
          const links = (existing.prLinks ??= new Set())
          for (const link of cachedFile.prLinks) links.add(link)
        }
        if (!existing.title && cachedFile.title) existing.title = cachedFile.title
        // First evidence wins: lineage was installed at parse time on the
        // cached file that captured it, and the session map is the union of
        // every contributing file's evidence. A second cache entry that
        // re-states the same evidence is dropped silently.
        if (!existing.lineage && cachedFile.lineage) existing.lineage = cachedFile.lineage
        if (!existing.agentName && cachedFile.agentName) existing.agentName = cachedFile.agentName
        if (!existing.agentStartedAt && cachedFile.agentStartedAt) existing.agentStartedAt = cachedFile.agentStartedAt
      } else {
        sessionMap.set(key, {
          project,
          projectPath: slicedTurn.calls[0]?.projectPath,
          workingDirectory: trustedWorkingDirectory,
          turns: [classified],
          ...(cachedFile.prLinks?.length ? { prLinks: new Set(cachedFile.prLinks) } : {}),
          ...(cachedFile.title ? { title: cachedFile.title } : {}),
          ...(cachedFile.lineage ? { lineage: cachedFile.lineage } : {}),
          ...(cachedFile.agentName ? { agentName: cachedFile.agentName } : {}),
          ...(cachedFile.agentStartedAt ? { agentStartedAt: cachedFile.agentStartedAt } : {}),
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

      for (const rawTurn of cachedFile.turns) {
        const turn = reconcileCopilotCalls(rawTurn)
        if (!turn) continue
        const hasDup = turn.calls.some(c => seenKeys.has(c.deduplicationKey))
        if (hasDup) continue

        for (const c of turn.calls) seenKeys.add(c.deduplicationKey)

        let slicedTurn = turn
        if (dateRange) {
          const sliced = turnSlicedToRange(turn, dateRange)
          if (!sliced) continue
          slicedTurn = sliced
        }

        // Classify the FULL turn, then keep only the in-range calls (same rule
        // as the loop above and the Claude path): whole-exchange judgments stay
        // whole-turn; cost/calls come from the retained calls.
        const classifiedFull = cachedTurnToClassified(turn)
        const classified = dateRange
          ? (classifiedTurnSlicedToRange(classifiedFull, dateRange) ?? classifiedFull)
          : classifiedFull
        // Orphaned files lose their source.project; for copilot the recon
        // maps restore the session's label so an events.jsonl pruned while
        // its store rows live on cannot split the session (round-6 finding).
        const project = copilotServeProject(turn.sessionId) ?? slicedTurn.calls[0]?.project ?? providerName
        const key = `${providerName}:${turn.sessionId}:${project}`

        const trustedWorkingDirectory = slicedTurn.calls[0]?.workingDirectoryProvenance === 'provider-field'
          && isTrustedAbsoluteWorkingDirectory(slicedTurn.calls[0].workingDirectory)
          ? slicedTurn.calls[0].workingDirectory
          : undefined
        const existingEntry = sessionMap.get(key)
        if (existingEntry) {
          existingEntry.turns.push(classified)
          if (!existingEntry.projectPath && slicedTurn.calls[0]?.projectPath) {
            existingEntry.projectPath = slicedTurn.calls[0]!.projectPath
          }
        } else {
          sessionMap.set(key, { project, projectPath: slicedTurn.calls[0]?.projectPath, workingDirectory: trustedWorkingDirectory, turns: [classified] })
        }
      }
    }
  }

  // Copilot residuals: for every (session, model) where BOTH representations
  // exist, each rollup LEG subtracts only the store rows in its own interval
  // (previous leg's timestamp, its own timestamp] — rows commit strictly
  // before their leg's shutdown line, so rows outside the interval (a crash
  // tail, a later same-path reset) can never cancel a different leg's
  // missing usage — and any remainder serves once as a supplementary call
  // anchored at that leg's own timestamp, keeping the tail on the day the
  // leg actually recorded it. Subject to the same inclusive date-range rule
  // as the rollup it stands in for. Derived purely from cached contents, so
  // it is identical across refresh and read-only serves and each leg's
  // residual shrinks monotonically as later parses append the rows it stood
  // in for.
  if (copilotRecon) {
    const residualsBySession = new Map<string, ParsedApiCall[]>()
    for (const [aggKey, legs] of copilotRecon.rollupLegs) {
      const rows = copilotRecon.storeCalls.get(aggKey)
      if (!rows?.length) continue
      const nl = aggKey.indexOf('\n')
      const sessionId = aggKey.slice(0, nl)
      const model = aggKey.slice(nl + 1)
      legs.sort((a, b) => a.ts - b.ts)
      // Legs sharing one timestamp have no interval between them — the
      // strict (prev, ts] rule would hand all their rows to the first and
      // mint a full-delta residual for the second, double-counting. Coalesce
      // them into one leg so the shared instant subtracts its rows once.
      const coalesced: Array<CopilotStamped & { rawTs: string; compactedAtMs: number }> = []
      for (const leg of legs) {
        const last = coalesced[coalesced.length - 1]
        if (last && last.ts === leg.ts) {
          last.input += leg.input
          last.cacheRead += leg.cacheRead
          last.cacheWrite += leg.cacheWrite
          last.reasoning += leg.reasoning
          last.compactedAtMs = Math.max(last.compactedAtMs, leg.compactedAtMs)
        } else {
          coalesced.push({ ...leg })
        }
      }
      rows.sort((a, b) => a.ts - b.ts)
      let rowIdx = 0
      let prevLegTs = -Infinity
      for (let legIdx = 0; legIdx < coalesced.length; legIdx++) {
        const leg = coalesced[legIdx]!
        const covered = { input: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
        // An in-session compaction RESETS the CLI's rollup counters, so a leg
        // containing one describes only its post-compaction requests. Starting
        // its interval at the previous leg would subtract the whole
        // pre-compaction conversation from a rollup that never counted it, and
        // the residual would come out short by exactly that much — the
        // undercount is invisible while the store is complete (the floor hides
        // it) and permanent once a partial snapshot is sealed into a day.
        // Anchor at the compaction instead: pre-compaction rows still SERVE,
        // they just stop cancelling usage the rollup never claimed.
        const intervalStart = Math.max(prevLegTs, leg.compactedAtMs)
        while (rowIdx < rows.length && rows[rowIdx]!.ts <= leg.ts) {
          const row = rows[rowIdx]!
          // A labelled compaction row is the summarization request itself. It
          // commits just BEFORE the compaction stamp, so the anchor would push
          // it outside the interval while the post-reset rollup still counts
          // it — serving it twice. The label lets it be subtracted exactly
          // instead. Without the label (older stores, and many rows of newer
          // ones) the row is invisible here and the documented one-request
          // over-serve per compaction stands.
          if (row.ts > intervalStart || (row.isCompaction && row.ts > prevLegTs)) {
            covered.input += row.input
            covered.cacheRead += row.cacheRead
            covered.cacheWrite += row.cacheWrite
            covered.reasoning += row.reasoning
          }
          rowIdx++
        }
        prevLegTs = leg.ts
        const input = Math.max(0, leg.input - covered.input)
        const cacheRead = Math.max(0, leg.cacheRead - covered.cacheRead)
        const cacheWrite = Math.max(0, leg.cacheWrite - covered.cacheWrite)
        const reasoning = Math.max(0, leg.reasoning - covered.reasoning)
        if (input === 0 && cacheRead === 0 && cacheWrite === 0 && reasoning === 0) continue
        if (dateRange) {
          const ts = new Date(leg.rawTs)
          if (Number.isNaN(ts.getTime()) || ts < dateRange.start || ts > dateRange.end) continue
        }
        const calls = residualsBySession.get(sessionId) ?? []
        calls.push({
          provider: 'copilot',
          model,
          usage: { inputTokens: input, outputTokens: 0, cacheCreationInputTokens: cacheWrite, cacheReadInputTokens: cacheRead, cachedInputTokens: 0, reasoningTokens: reasoning, webSearchRequests: 0 },
          costUSD: calculateCost(model, input, 0, cacheWrite, cacheRead, 0),
          tools: [], mcpTools: [], skills: [], subagentTypes: [],
          hasAgentSpawn: false, hasPlanMode: false,
          speed: 'standard', timestamp: leg.rawTs, bashCommands: [],
          // Keyed by the leg's own INSTANT, never its position. A second
          // journal file discovered later can contribute a leg that sorts
          // BEFORE existing ones, which shifts every subsequent index — and an
          // index that shifts renames a key the sync ledger has already sent,
          // so the receiver takes the same residual twice under two names. The
          // instant is immutable (session files are append-only) and unique
          // per leg after the equal-timestamp coalescing above.
          deduplicationKey: `copilot:${sessionId}:shutdown-residual:${model}:${leg.ts}`,
          supplementaryAccounting: true,
        })
        residualsBySession.set(sessionId, calls)
      }
    }
    for (const [sessionId, calls] of residualsBySession) {
      const project = copilotServeProject(sessionId) ?? providerName
      const mapKey = `${providerName}:${sessionId}:${project}`
      // One turn PER LEG timestamp: a session's residuals can span days, and
      // a single container turn anchored at the first leg would let the fold
      // drag a later leg's category cost onto an earlier day's turn.
      const byTs = new Map<string, ParsedApiCall[]>()
      for (const call of calls) {
        const list = byTs.get(call.timestamp) ?? []
        list.push(call)
        byTs.set(call.timestamp, list)
      }
      const existing = sessionMap.get(mapKey)
      const target = existing ?? { project, turns: [] as ClassifiedTurn[] }
      for (const [ts, tsCalls] of byTs) {
        target.turns.push({
          userMessage: '',
          assistantCalls: tsCalls,
          timestamp: ts,
          sessionId,
          category: 'general',
          retries: 0,
          hasEdits: false,
        })
      }
      if (!existing) sessionMap.set(mapKey, target)
    }
  }

  const projectMap = new Map<string, { projectPath?: string; sessions: SessionSummary[] }>()
  for (const [key, { project, projectPath, workingDirectory, turns, prLinks, title, lineage, agentName, agentStartedAt }] of sessionMap) {
    const sessionId = key.split(':')[1] ?? key
    const assembledTurns = providerName === 'copilot'
      ? foldCopilotSupplementaryTurns(sessionId, turns, copilotRecon?.supplementaryStoreKeys)
      : turns
    const session = buildSessionSummary(sessionId, project, assembledTurns)
    const explicitLinks = new Set(assembledTurns.flatMap(turn => turn.prRefs ?? []))
    for (const link of prLinks ?? []) explicitLinks.add(link)
    if (explicitLinks.size) {
      session.prLinks = [...explicitLinks].sort()
      session.prAttributionSource = prLinks?.size ? 'transcript' : 'explicit-reference'
    }
    if (workingDirectory) session.workingDirectory = workingDirectory
    if (title) session.title = title
    if (lineage) session.lineage = lineage
    if (agentName) session.agentName = agentName
    if (agentStartedAt) session.agentStartedAt = agentStartedAt
    // Supplementary-only sessions (e.g. a rollup with no per-turn calls) have
    // apiCalls 0 by design but their tokens/cost are real and must serve.
    if (session.apiCalls > 0 || session.totalCostUSD > 0 || session.totalInputTokens + session.totalOutputTokens + session.totalCacheReadTokens + session.totalCacheWriteTokens + session.totalReasoningTokens > 0) {
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
type SessionCacheEntry = {
  data: ProjectSummary[]
  createdAt: number
  validatedFrom: number
  startMs?: number
  endMs?: number
  sig?: string
  hydrationComplete?: boolean
}
const sessionCache = new Map<string, SessionCacheEntry>()

// Burst reuse for a resident process (codeburn serve). Every payload command
// anchors its range end at its own `new Date()`, so two panel fetches issued
// milliseconds apart carry different end timestamps and the exact-key memo
// above never hits in real traffic — each fetch re-runs the full discovery +
// fingerprint sweep. Within this window, a parse whose range differs ONLY by
// a through-now end within the window is served by trimming the previous
// parse instead. Staleness is bounded by the window; 0 (the default outside
// serve) disables it, so one-shot CLI runs are byte-exact as ever.
function parseBurstWindowMs(): number {
  const raw = Number(process.env['CODEBURN_PARSE_BURST_MS'] ?? '0')
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 60_000) : 0
}

// A resident process (codeburn serve) can install a validator that answers
// "has any watched session root changed since this timestamp?" — typically
// backed by fs.watch over every provider's probeRoots(). Clean extends reuse
// to the hard cap, dirty rejects every memo, and unknown (watcher coverage is
// unavailable or began too late) falls back to the ordinary exact TTL / short
// burst rather than disabling caching. Null keeps those ordinary semantics.
export type ParseReuseValidation = 'clean' | 'dirty' | 'unknown'
type ParseReuseValidator = (sinceTs: number) => ParseReuseValidation
let parseReuseValidator: ParseReuseValidator | null = null
const VALIDATED_REUSE_CAP_MS = 5 * 60 * 1000

export function setParseReuseValidator(validator: ParseReuseValidator | null): void {
  parseReuseValidator = validator
}

function burstReuse(dateRange: DateRange, sig: string): ProjectSummary[] | null {
  const windowMs = parseBurstWindowMs()
  if (windowMs <= 0) return null
  const now = Date.now()
  const startMs = dateRange.start.getTime()
  const endMs = dateRange.end.getTime()
  for (const entry of sessionCache.values()) {
    if (entry.sig !== sig || entry.startMs !== startMs || entry.endMs === undefined) continue
    const validation = parseReuseValidator?.(entry.validatedFrom) ?? 'unknown'
    // A dirty event during the producing parse must not be hidden even by the
    // short burst. Unknown coverage, however, retains that bounded fallback.
    if (validation === 'dirty') continue
    const age = now - entry.createdAt
    const insideBurst = age <= windowMs
    // Same rule as the exact-key arm: an incomplete (deferred) parse keeps
    // only the short burst window — the validated extension must not delay
    // its promised retry to the five-minute cap.
    const validatedClean = validation === 'clean' && age <= VALIDATED_REUSE_CAP_MS && entry.hydrationComplete !== false
    if (!insideBurst && !validatedClean) continue
    if (endMs < entry.endMs || endMs - entry.endMs > Math.max(windowMs, validatedClean ? VALIDATED_REUSE_CAP_MS : 0)) continue
    if (entry.hydrationComplete !== undefined) sessionHydrationComplete = entry.hydrationComplete
    return filterProjectsByDateRange(entry.data, dateRange)
  }
  return null
}

function cacheKey(dateRange: DateRange | undefined, providerFilter: string | undefined, claudeDiscoveryRoots: readonly string[]): string {
  const s = dateRange ? `${dateRange.start.getTime()}:${dateRange.end.getTime()}` : 'none'
  // Key on the effective roots, not only their env inputs: GUI consumers can
  // change config.json claudeConfigDirs while a resident serve process stays
  // alive. Normalized roots also collapse syntactically different inputs that
  // discover the same directories.
  const claudeRoots = JSON.stringify(claudeDiscoveryRoots)
  // Proxy attribution (totalProxiedCostUSD) is computed live from proxyPaths and
  // then cached, so the key must change when that config changes.
  // Pricing-affecting config participates so a memoized parse (exact-key or
  // burst-reused in a resident serve process) can never present costs priced
  // under aliases/overrides/savings the user has since changed.
  // Flat-rate marks do not change parse-time cost (still $0 without a LiteLLM
  // row); findUnpricedModels / coverage apply them at render time, so they
  // stay out of this serve-memo key on purpose.
  // A first-paint parse sees a deliberately smaller file set, so its result may
  // not be served to (or burst-reused by) an unfloored request — including the
  // background fill that follows it moments later. Absent outside the scope, so
  // every non-cold-start key is byte-identical to what it was.
  const floor = firstPaintFloorMs === null ? '' : `:paint${firstPaintFloorMs}`
  return `${s}:${providerFilter ?? 'all'}:${claudeRoots}:${getProxyPathsConfigHash()}:${getModelAliasesConfigHash()}:${getPriceOverridesConfigHash()}:${getLocalModelSavingsConfigHash()}${floor}`
}

export function clearSessionCache(): void {
  sessionCache.clear()
  canonicalPathCache.clear()
  singlePassScope?.parses.clear()
}

let sessionMemoPublications = 0
export function sessionMemoPublicationCount(): number {
  return sessionMemoPublications
}

function cachePut(key: string, data: ProjectSummary[], parseStartedAt: number) {
  sessionMemoPublications++
  const now = Date.now()
  for (const [k, v] of sessionCache) {
    if (now - v.createdAt > CACHE_TTL_MS) sessionCache.delete(k)
  }
  if (sessionCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = [...sessionCache.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0]
    if (oldest) sessionCache.delete(oldest[0])
  }
  // The hydration verdict is a property OF this result: a memo/burst hit
  // must restore the verdict its data was parsed under, or a stale partial
  // parse could be served while a later, unrelated parse's `true` lets the
  // daily backfill seal history around the gap (round-6 finding).
  sessionCache.set(key, { data, createdAt: now, validatedFrom: parseStartedAt, hydrationComplete: sessionHydrationComplete, ...(putMeta ?? {}) })
  putMeta = null
}

// Range metadata for the entry cachePut is about to store, set by the one
// parseAllSessions call path right before it saves its result.
let putMeta: { startMs: number; endMs: number; sig: string } | null = null
export function setCachePutMeta(meta: { startMs: number; endMs: number; sig: string } | null): void {
  putMeta = meta
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
  if (original.isSidechain) rebuilt.isSidechain = true
  // prRefsAtRangeStart is NOT copied here: a narrower slice needs it recomputed at
  // the new boundary (see recomputeRangeStartPrRefs), not the wide range's value.
  if (original.parentSessionId) rebuilt.parentSessionId = original.parentSessionId
  if (original.agentId) rebuilt.agentId = original.agentId
  if (original.agentSpawnLinks) rebuilt.agentSpawnLinks = original.agentSpawnLinks
  if (original.spawnPrSets) rebuilt.spawnPrSets = original.spawnPrSets
  if (original.ambiguousSpawnAgentIds?.length) rebuilt.ambiguousSpawnAgentIds = original.ambiguousSpawnAgentIds
  if (original.title) rebuilt.title = original.title
  if (original.agentType) rebuilt.agentType = original.agentType
  if (original.lineage) rebuilt.lineage = original.lineage
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
      // Slice turns per call by the selected days (not whole-turn keep/drop):
      // a midnight-straddling turn contributes the calls that actually
      // happened on each selected day (issue #852, same split rule as the
      // range slicers — see classifiedTurnSlicedToDays).
      const turns = session.turns.flatMap(turn => {
        const sliced = classifiedTurnSlicedToDays(turn, days)
        return sliced ? [sliced] : []
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
  //
  // Indexed once rather than re-filtered per child: the loop below only writes
  // to `evidence`, so the unlinked set is fixed for its whole duration.
  const unlinkedByAgentId = new Map<string | undefined, SessionSummary[]>()
  for (const s of sessions) {
    if (s.prLinks?.length) continue
    const bucket = unlinkedByAgentId.get(s.agentId)
    if (bucket) bucket.push(s)
    else unlinkedByAgentId.set(s.agentId, [s])
  }
  for (const resolved of resolveSubagentAttribution(projects).values()) {
    for (const child of resolved) {
      // A multi-PR spawn set is valid for folding the child's own cost, but is
      // too broad to identify which PR an independently saved nested review was
      // about. Require one PR for cross-provider propagation.
      if (child.unlinked || child.prSet?.length !== 1) continue
      const matches = unlinkedByAgentId.get(child.fold.agentId)
      if (matches?.length === 1) evidence.set(matches[0]!, child.prSet)
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
  // Sorted once so each candidate scans only the launches inside its own
  // window instead of the whole array. Launch order is not observable: the
  // match set is collapsed into a Map keyed by the sorted ref list, and
  // assignCorrelatedPrs re-sorts what it is handed.
  launches.sort((a, b) => a.atMs - b.atMs)
  const firstLaunchAtOrAfter = (atMs: number): number => {
    let lo = 0
    let hi = launches.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (launches[mid]!.atMs < atMs) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  for (const session of candidates) {
    const provider = summaryProvider(session)
    const prompt = session.turns
      .map(t => normalizedPrompt(t.userMessage))
      .find(text => text.length >= PROMPT_MIN)
    if (!prompt) continue
    const prefix = prompt.slice(0, PROMPT_PREFIX)
    const startedMs = Date.parse(session.firstTimestamp)
    if (!Number.isFinite(startedMs)) continue
    const refSets = new Map<string, string[]>()
    for (let i = firstLaunchAtOrAfter(startedMs - LAUNCH_WINDOW_MS); i < launches.length; i++) {
      const launch = launches[i]!
      if (launch.atMs - startedMs > LAUNCH_WINDOW_MS) break
      if (launch.provider === provider) continue
      if (!launch.commands.some(command => command.includes(prefix))) continue
      refSets.set(launch.refs.slice().sort().join('\0'), launch.refs)
    }
    if (refSets.size === 1) {
      assignCorrelatedPrs(session, [...refSets.values()][0]!, 'launcher-prompt')
      if (session.prLinks?.length) evidence.set(session, session.prLinks)
    }
  }

  // Prompt-linked sessions become valid cwd anchors too. Attribute only when an
  // exact cwd maps to one PR set; a main checkout used for multiple PRs remains
  // intentionally ambiguous.
  //
  // Time-bounded (the eywa#160 lesson): cwd evidence also carries the evidence
  // sessions' own activity window, and only sessions OVERLAPPING that window
  // (plus a pad) inherit the PR. Without the bound, a repo whose only captured
  // PR link was pasted once became a black hole — every session ever run in
  // that checkout, a month of unrelated work included, was attributed to it
  // (129 of 131 sessions, ~$7.4K direct, observed on real data). The rule's
  // charter is "a tool session launched around PR work in this checkout",
  // which is inherently a same-working-stretch claim.
  const CWD_WINDOW_PAD_MS = 6 * 60 * 60 * 1000
  type CwdAnchor = { refs: string[]; startMs: number; endMs: number }
  const refsByCwd = new Map<string, Map<string, CwdAnchor>>()
  for (const [session, evidenceRefs] of evidence) {
    const cwd = normalizedWorkingDirectory(session.workingDirectory)
    if (!cwd || evidenceRefs.length !== 1) continue
    const startMs = Date.parse(session.firstTimestamp)
    const endMs = Date.parse(session.lastTimestamp)
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue
    const refs = evidenceRefs.slice().sort()
    const key = refs.join('\0')
    const sets = refsByCwd.get(cwd) ?? new Map<string, CwdAnchor>()
    const existing = sets.get(key)
    sets.set(key, existing
      ? { refs, startMs: Math.min(existing.startMs, startMs), endMs: Math.max(existing.endMs, endMs) }
      : { refs, startMs, endMs })
    refsByCwd.set(cwd, sets)
  }
  for (const session of sessions) {
    if (session.prLinks?.length || session.parentSessionId) continue
    const cwd = normalizedWorkingDirectory(session.workingDirectory)
    if (!cwd) continue
    const sets = refsByCwd.get(cwd)
    if (sets?.size !== 1) continue
    const anchor = [...sets.values()][0]!
    const sessionStart = Date.parse(session.firstTimestamp)
    const sessionEnd = Date.parse(session.lastTimestamp)
    if (!Number.isFinite(sessionStart) || !Number.isFinite(sessionEnd)) continue
    if (sessionEnd < anchor.startMs - CWD_WINDOW_PAD_MS || sessionStart > anchor.endMs + CWD_WINDOW_PAD_MS) continue
    assignCorrelatedPrs(session, anchor.refs, 'working-directory')
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
      // Slice turns per call (not whole-turn keep/drop) so a midnight-
      // straddling turn keeps the calls that landed inside the range — the
      // same split rule as the parse-time slicers (issue #852).
      const turns = session.turns.flatMap(turn => {
        const sliced = classifiedTurnSlicedToRange(turn, dateRange)
        return sliced ? [sliced] : []
      })
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

// Why the most recent parse was incomplete, when it was: true only when the
// first-paint floor deferred files. Read by `sessionHydrationSnapshot` so the
// serve payload can label a converging first paint without also claiming the
// unrelated `stale` (read-only snapshot) condition.
let sessionFirstPaintDeferred = false

// Set by the read-only serving paths when the snapshot they served did NOT
// match what is on disk: in read-only mode a changed file is served at its
// stale fingerprint and a file with no cache entry is skipped entirely. A
// read-only run under which nothing changed is equivalent to a full parse and
// stays trustworthy; one that skipped real data is a PARTIAL hydration, and
// finalizing daily history off it freezes the days it never saw out of the
// chart (gapStart = lastComputedDate + 1 never looks back at them).
let readOnlyServedStale = false

export type CorpusFingerprint = {
  /** High-resolution epoch time captured before discovery begins. Competing
   *  snapshot writers use it as an observation-order fence. */
  observedAtMs: number
  /** Content-free signature of every discovered source's dev/ino/mtime/size. */
  hash: string
  /** Newest mtime observed across all discovered sources, 0 when there are
   *  none. Lets a caller tell "definitely changed" apart from "may still be
   *  mid-write" without re-stat'ing anything itself. */
  newestMtimeMs: number
}

// Generic counterpart to `collectJsonlInto`: every regular file under a
// directory, any extension, recursively. Used to expand a directory-shaped
// SessionSource for fingerprinting purposes only — not for parsing, which
// stays with each provider's own (narrower, extension-aware) file layout
// knowledge. Being over-inclusive here is safe: an extra file in the hash
// can only cause an extra cache miss, never a missed update.
async function collectFilesRecursive(dirPath: string, visitedDirs: Set<string> = new Set()): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    const p = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectFilesRecursive(p, visitedDirs))
      continue
    }
    if (entry.isSymbolicLink()) {
      // `Dirent.isDirectory()` is false for a symlink even when its target
      // IS a directory — without this check a symlinked subdirectory falls
      // into the `else` below and gets pushed as a leaf "file"; a later
      // `stat()` (which follows symlinks) then returns the DIRECTORY
      // inode's own mtime/size as a bogus stand-in for its contents, with no
      // recursion into it at all (review finding C-G2). Resolve it and
      // recurse for real. A visited-inode guard bounds the walk against a
      // symlink cycle (impossible for real directories, which is why the
      // `isDirectory()` branch above needs no such guard).
      const target = await stat(p).catch(() => null)
      if (target?.isDirectory()) {
        const key = `${target.dev}:${target.ino}`
        if (visitedDirs.has(key)) continue
        visitedDirs.add(key)
        files.push(...await collectFilesRecursive(p, visitedDirs))
        continue
      }
    }
    files.push(p)
  }
  return files
}

// Cheap, content-free signature of "has anything in the discoverable session
// corpus changed since the last check" — a stat-only pass (readdir + stat per
// discovered source; no session-cache.json read/parse, no transcript content
// read) hashed into one string, plus the newest mtime seen along the way.
// Order-independent (sorted before hashing) so discovery order never causes a
// spurious miss. Lets a fresh, short-lived CLI invocation (e.g. a menubar
// poll) cheaply decide whether it can skip the full parse+aggregation
// pipeline and serve a persisted result instead, without ever needing to
// `JSON.parse` the (potentially hundreds-of-MB) session cache file just to
// answer that question.
//
// Claude `SessionSource.path` is a project DIRECTORY, not a leaf transcript
// (see `scanProjectDirs`/`collectJsonlFiles` above) — every other provider's
// path IS the leaf file/DB it parses, with two exceptions. Fingerprinting a
// directory itself would miss an in-place rewrite of an existing file inside
// it: a directory's own mtime only moves when entries are added or removed,
// not when one of its files' content changes. So:
// - Claude sources are expanded to their actual `.jsonl` files first, exactly
//   the way scanProjectDirs discovers them, and each is fingerprinted
//   individually.
// - Any OTHER directory-shaped source (e.g. mistral-vibe, whose parser reads
//   `join(source.path, 'messages.jsonl')`) gets the same treatment via a
//   generic recursive file walk — this is deliberately NOT gated on provider
//   name, so it also covers whatever directory-shaped provider shows up
//   next instead of repeating the same blind spot one provider at a time.
// - Network providers (e.g. Vercel AI Gateway) have no on-disk file at all —
//   see the `provider.network` branch below, mirroring parseAllSessions'
//   own treatment of the same sources in `parseProviderSources`.
export async function computeCorpusFingerprint(providerFilter?: string): Promise<CorpusFingerprint> {
  const observedAtMs = performance.timeOrigin + performance.now()
  const sources = await discoverAllSessions(providerFilter)
  const entries: string[] = []
  let newestMtimeMs = 0
  const record = async (path: string): Promise<void> => {
    const fp = await fingerprintFile(path)
    if (!fp) return
    entries.push(`${path}|${fp.dev}|${fp.ino}|${fp.mtimeMs}|${fp.sizeBytes}`)
    if (fp.mtimeMs > newestMtimeMs) newestMtimeMs = fp.mtimeMs
  }
  // Cache the provider lookup per name — sources routinely repeat a provider
  // many times over (one per Claude project dir, one per mistral-vibe
  // session dir, ...) and getProvider() can be a dynamic-import round-trip.
  const providerByName = new Map<string, Provider | undefined>()
  const resolveProvider = async (name: string): Promise<Provider | undefined> => {
    if (!providerByName.has(name)) providerByName.set(name, await getProvider(name))
    return providerByName.get(name)
  }
  // Non-discovery provider env vars (e.g. CODEBURN_CURSOR_MAX_BUBBLES,
  // KIMI_MODEL_NAME — src/doctor.ts's NON_DISCOVERY_ENV_VARS) and a
  // provider's parse-version change PARSED OUTPUT without touching any
  // source's path/mtime/size, so the stat-only loop below would otherwise
  // never see them move. `computeEnvFingerprint` (session-cache.ts) already
  // hashes exactly this per provider for the parse-level cache; fold it in
  // here too, once per distinct provider actually discovered, so this
  // higher-layer snapshot fingerprint can't bypass that same guard (review
  // finding A-G1).
  const envFingerprinted = new Set<string>()
  for (const source of sources) {
    // Discovery metadata is itself rendered state. Claude's config selector,
    // for example, assigns duplicate-basename labels by configured root order
    // and exposes a config as soon as it has even an empty project directory.
    // Hashing only transcript files (then sorting them) made those topology
    // changes invisible when no file path/mtime/size moved, so a status
    // snapshot could retain stale source labels/options indefinitely.
    entries.push(`source:${JSON.stringify([
      source.provider,
      source.path,
      source.project,
      source.sourceKind ?? null,
      source.sourceId ?? null,
      source.sourceLabel ?? null,
      source.sourcePath ?? null,
      source.retainWhilePresent ?? false,
    ])}`)
    if (!envFingerprinted.has(source.provider)) {
      envFingerprinted.add(source.provider)
      entries.push(`env:${source.provider}|${computeEnvFingerprint(source.provider)}`)
    }
    if (source.provider === 'claude') {
      for (const filePath of await collectJsonlFiles(source.path)) await record(filePath)
      continue
    }
    const provider = await resolveProvider(source.provider)
    if (provider?.network) {
      // No file to fingerprint. Force a miss (and advance newestMtimeMs)
      // every call instead of silently contributing nothing to the hash —
      // the parser re-fetches network sources unconditionally on every real
      // parse, and a snapshot layer sitting in front of that must not be
      // able to hide the run that would have done the fetching.
      const now = Date.now()
      entries.push(`${source.path}|network|${now}`)
      if (now > newestMtimeMs) newestMtimeMs = now
      continue
    }
    const info = await stat(source.path).catch(() => null)
    if (info?.isDirectory()) {
      for (const filePath of await collectFilesRecursive(source.path)) await record(filePath)
      continue
    }
    await record(source.path)
  }
  entries.sort()
  const hash = createHash('sha256').update(entries.join('\n')).digest('hex')
  return { hash, newestMtimeMs, observedAtMs }
}

// Set when a changed source's read was deferred on a retryable failure (e.g.
// a SQLITE_BUSY store): the parse completed but did not hydrate that source's
// new data, so the run must not report hydration complete even in write mode.
let deferredRetryableSource = false

// One command invocation that renders a dashboard asks for several ranges that
// differ only in where they END — the scan range runs to end-of-day, the
// durable headline re-anchors on its own `new Date()`. The exact-key memo needs
// both endpoints equal, so it never hits and each ran the whole pipeline again.
// Inside this scope the declared range is parsed ONCE per provider filter and a
// request that is a pure NARROWING of it is served by slicing that result.
// Anything else parses normally.
//
// Pure narrowing means: same start, an end that is inside, and the same month
// shard scope. All three are load-bearing, because a parse's file set is a
// function of its range, not just its output:
//  - a CHANGED file with `mtimeMs < range.start` is skipped without being
//    parsed, so an earlier start pulls in files a later start never reads;
//  - `loadCache` reads only the shards `monthScopeForRange` selects, so a wider
//    month span hands the query loop cached files a narrower span never sees;
//  - either way those extra files seed `seenKeys` / `seenMsgIds` BEFORE the
//    range slice runs, and a seeded key SUPPRESSES the matching in-range turn
//    in a provider parsed later — usage the narrower parse would have counted.
// Holding start and month scope equal makes both parses see an identical file
// set in an identical order, which leaves the range slice as the only
// difference — applied after the parse instead of during it, as burstReuse
// already does for the mirror-image case (same start, LATER end).
type SinglePassScope = { range: DateRange; parses: Map<string, Promise<ProjectSummary[]>> }
let singlePassScope: SinglePassScope | null = null

export async function withSinglePassParse<T>(range: DateRange, fn: () => Promise<T>): Promise<T> {
  const outer = singlePassScope
  singlePassScope = { range, parses: new Map() }
  try {
    return await fn()
  } finally {
    singlePassScope = outer
  }
}

function singlePassParse(dateRange: DateRange | undefined, providerFilter: string | undefined): Promise<ProjectSummary[]> | null {
  const scope = singlePassScope
  if (!scope || !dateRange) return null
  if (dateRange.start.getTime() !== scope.range.start.getTime()) return null
  if (dateRange.end.getTime() > scope.range.end.getTime()) return null
  const wide = monthScopeForRange(scope.range.start, scope.range.end)
  const narrow = monthScopeForRange(dateRange.start, dateRange.end)
  if (wide.fromMonth !== narrow.fromMonth || wide.toMonth !== narrow.toMonth) return null
  const key = providerFilter ?? 'all'
  let parsed = scope.parses.get(key)
  if (!parsed) {
    const codexCacheDir = getCodeburnCacheDir()
    parsed = withCodexCacheDirectory(codexCacheDir, () => parseAllSessionsInCacheScope(scope.range, providerFilter))
    scope.parses.set(key, parsed)
  }
  // The declared range itself is served verbatim, exactly as an unscoped run
  // would have produced it; only a strictly narrower end pays for a slice.
  if (dateRange.end.getTime() === scope.range.end.getTime()) return parsed
  return parsed.then(projects => filterProjectsByDateRange(projects, dateRange))
}

// Progressive cold start (#1107). A session log is append-only, so its last
// event timestamp is <= its mtime: a file whose mtime predates the start of the
// range being displayed provably holds nothing that range can show. On a COLD
// start that is what makes a fast first paint honest — the deferred files are
// not dropped, only sequenced behind the paint, and the background fill parses
// them into the same per-file cache a full cold parse would have written.
//
// The margin is pure paranoia about mtimes that lie: a restored backup, a
// machine whose clock jumped, an rsync that preserved a wrong stamp. It only
// widens the set that gets parsed BEFORE the paint, so it can never lose data.
export const FIRST_PAINT_MTIME_MARGIN_MS = 48 * 60 * 60 * 1000

let firstPaintFloorMs: number | null = null
// The TUI's Today-first paint also defers older entries already normalized in
// a complete cache. Reading/aggregating those cached turns before Ink renders
// is precisely the warm-start latency this mode removes. Other progressive
// consumers keep the historical cold-only rule unless they opt in.
let firstPaintIncludesCachedFiles = false
// A complete, environment-compatible normalized cache can paint an honestly
// labelled cached Today without waiting for source discovery/reconciliation.
// The mounted dashboard immediately refreshes sources in the background.
let firstPaintPrefersCompleteSnapshot = false
// Files this scope deferred, as a SET of paths: one first paint runs several
// parses (the scan, the plan window, the durable backfill) and each defers the
// same old files, so a running count would report a multiple of the real work.
let firstPaintDeferredPaths: Set<string> | null = null
// Same count, but reset per runParse: a run that deferred NOTHING did exactly
// what an unfloored run would have done, so it is allowed to mark the cache
// complete and report full hydration.
let firstPaintDeferredThisRun = 0

/** Files parsed from source (not served from cache) since the process started.
 *  The background-fill indicator reads it to show live N/M progress. */
let filesParsedFromSource = 0
export function filesParsedFromSourceCount(): number {
  return filesParsedFromSource
}

/** What the most recent parse left behind, for consumers that must present
 *  partiality honestly (#1110). `deferredForFirstPaint` is what separates a
 *  progressive cold start from the read-only stale case: both leave
 *  `complete` false, but only the latter is `stale` — a first paint is fresh
 *  data over a smaller file set, and it converges on its own.
 *  `indexedFiles` counts files parsed from source since this process started
 *  and `pendingFiles` the files the active first-paint scope deferred; both are
 *  progress numbers and only meaningful while `complete` is false. */
export function sessionHydrationSnapshot(): {
  complete: boolean
  deferredForFirstPaint: boolean
  indexedFiles: number
  pendingFiles: number
} {
  return {
    complete: sessionHydrationComplete,
    deferredForFirstPaint: sessionFirstPaintDeferred,
    indexedFiles: filesParsedFromSource,
    pendingFiles: firstPaintDeferredPaths?.size ?? 0,
  }
}

/** Restrict every parse inside `fn` to files that can hold in-range data for a
 *  view starting at `rangeStart`, and report how many files were deferred.
 *  Cold-start first paint only: the caller MUST follow up with an unscoped
 *  parse (the background fill) before the run can be treated as hydrated. */
export async function withColdFirstPaintFloor<T>(
  rangeStart: Date,
  fn: () => Promise<T>,
  includeCachedFiles = false,
  preferCompleteSnapshot = false,
): Promise<{ result: T; deferredFiles: number }> {
  const outer = firstPaintFloorMs
  const outerPaths = firstPaintDeferredPaths
  const outerIncludeCached = firstPaintIncludesCachedFiles
  const outerPreferSnapshot = firstPaintPrefersCompleteSnapshot
  firstPaintFloorMs = rangeStart.getTime() - FIRST_PAINT_MTIME_MARGIN_MS
  firstPaintDeferredPaths = new Set()
  firstPaintIncludesCachedFiles = includeCachedFiles
  firstPaintPrefersCompleteSnapshot = preferCompleteSnapshot
  try {
    const result = await fn()
    return { result, deferredFiles: firstPaintDeferredPaths.size }
  } finally {
    firstPaintFloorMs = outer
    firstPaintDeferredPaths = outerPaths
    firstPaintIncludesCachedFiles = outerIncludeCached
    firstPaintPrefersCompleteSnapshot = outerPreferSnapshot
  }
}

/** True when this file's whole-file parse can be deferred to the background
 *  fill. A file with a cache entry is never deferred: it has something to serve
 *  and re-reading it is incremental, so deferring would only make the served
 *  snapshot staler for no saving. */
export function shouldDeferToBackgroundFill(
  fp: { mtimeMs: number },
  cached: unknown,
  floorMs: number | null,
  includeCachedFiles = false,
): boolean {
  return floorMs !== null && (includeCachedFiles || cached === undefined) && fp.mtimeMs < floorMs
}

function deferToBackgroundFill(path: string, fp: { mtimeMs: number }, cached: unknown): boolean {
  if (!shouldDeferToBackgroundFill(fp, cached, firstPaintFloorMs, firstPaintIncludesCachedFiles)) return false
  firstPaintDeferredPaths?.add(path)
  firstPaintDeferredThisRun++
  return true
}

export function parseAllSessions(dateRange?: DateRange, providerFilter?: string): Promise<ProjectSummary[]> {
  const scoped = singlePassParse(dateRange, providerFilter)
  if (scoped) return scoped
  // Capture synchronously, before the first await. AsyncLocalStorage keeps all
  // Codex cache reads, dirty writes, and the final flush on this call-time
  // directory even if an embedding host changes the process env mid-parse.
  const codexCacheDir = getCodeburnCacheDir()
  return withCodexCacheDirectory(codexCacheDir, () => parseAllSessionsInCacheScope(dateRange, providerFilter))
}

function canServeCompleteSnapshot(cache: SessionCache, providerFilter?: string): boolean {
  if (!isCacheComplete(cache)) return false
  const sections = providerFilter && providerFilter !== 'all'
    ? ([[providerFilter, cache.providers[providerFilter]]] as const).filter((entry): entry is readonly [string, ProviderSection] => entry[1] != null)
    : Object.entries(cache.providers)
  return sections.some(([, section]) => Object.keys(section.files).length > 0)
    && sections.every(([name, section]) => section.envFingerprint === computeEnvFingerprint(name))
}

export async function isCompleteSessionSnapshotAvailable(dateRange: DateRange, providerFilter?: string): Promise<boolean> {
  const diskCache = await loadCache(monthScopeForRange(dateRange.start, dateRange.end))
  return canServeCompleteSnapshot(diskCache, providerFilter)
}

async function parseAllSessionsInCacheScope(dateRange?: DateRange, providerFilter?: string): Promise<ProjectSummary[]> {
  // Anchor freshness before any config, cache, or session input is read. A
  // watched-root event that lands while this parse is in flight must remain
  // newer than the resulting memo instead of being blessed retroactively.
  const parseStartedAt = Date.now()
  const claudeDiscoveryRoots = await getClaudeConfigDirs()
  const key = cacheKey(dateRange, providerFilter, claudeDiscoveryRoots)
  const cached = sessionCache.get(key)
  if (cached) {
    const age = Date.now() - cached.createdAt
    const validation = parseReuseValidator?.(cached.validatedFrom) ?? 'unknown'
    if (
      validation !== 'dirty'
      // The validated-clean extension serves entries the watcher can vouch
      // for — but an INCOMPLETE parse (a deferred source) promised a retry on
      // the next refresh, so it rides only the short TTL before re-parsing.
      && (age < CACHE_TTL_MS
        || (validation === 'clean' && age <= VALIDATED_REUSE_CAP_MS && cached.hydrationComplete !== false))
    ) {
      // The hydration verdict travels with the entry (round-6 finding); both
      // reuse regimes — the 180s TTL and the validated-clean extension — must
      // restore the verdict this data was parsed under before serving it.
      if (cached.hydrationComplete !== undefined) sessionHydrationComplete = cached.hydrationComplete
      return cached.data
    }
  }
  // The signature is the key minus the range: what must match for a burst
  // reuse (provider, config env, proxy hash) regardless of the now-anchor.
  const burstSig = cacheKey(undefined, providerFilter, claudeDiscoveryRoots)
  if (dateRange) {
    const reused = burstReuse(dateRange, burstSig)
    if (reused) return reused
  }

  // Load only the month shards a query over `dateRange` can possibly report
  // on. Sessions whose every turn falls outside the range are dropped from the
  // report anyway, so skipping their shards changes nothing except the bytes
  // read — and a save writes only dirty months, leaving the skipped ones on
  // disk untouched (see saveCache). Cross-file dedup is weakened, not broken:
  // the pre-seed of `seenMsgIds` / `seenKeys` only covers loaded files, so a key
  // that a skipped file also holds is no longer suppressed. Totals are
  // unaffected (a suppressed duplicate contributes nothing either way), but for
  // a proxied key emitted under two providers the attribution can land on a
  // different provider than a full load would pick.
  const loadScope = dateRange ? monthScopeForRange(dateRange.start, dateRange.end) : undefined
  const cacheLoadStarted = performance.now()
  let diskCache = await loadCache(loadScope)
  await cleanupOrphanedTempFiles()
  if (process.env['CODEBURN_VERBOSE'] === '1') {
    process.stderr.write(`codeburn: startup timing cache-load=${(performance.now() - cacheLoadStarted).toFixed(1)}ms complete=${isCacheComplete(diskCache)}\n`)
  }

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
    if (hydration.waited) diskCache = await loadCache(loadScope)
    const isCold = !isCacheComplete(diskCache)
    try {
      return await runParse(key, diskCache, dateRange, providerFilter, { isCold, burstSig, parseStartedAt })
    } finally {
      await hydration.release()
    }
  }

  if (firstPaintPrefersCompleteSnapshot && canServeCompleteSnapshot(diskCache, providerFilter)) {
    return runParse(key, diskCache, dateRange, providerFilter, {
      readOnly: true,
      snapshotOnly: true,
      burstSig,
      parseStartedAt,
    })
  }

  // A complete cache refresh is a strict read/reconcile/parse/save transaction.
  // Keep the snapshot loaded before acquisition: timeout/unavailable paths serve
  // exactly this complete snapshot and never mutate or invalidate the holder.
  const priorSnapshot = diskCache
  // Heartbeat the WAIT too, not just the parse behind it. This is the one place
  // a healthy process is deliberately idle for a long stretch, and the desktop
  // and menubar watchdogs read silence as a dead child - which is how a waiter
  // blocked on an abandoned lock got killed at 45s and minted the next stale
  // lock (#1117). runParse arms its own keepalive; this covers the gap before it.
  startProgressKeepalive()
  let refresh: RefreshLockOutcome
  const refreshWaitStarted = performance.now()
  try {
    refresh = await acquireCacheRefreshLock()
  } finally {
    stopProgressKeepalive()
  }
  if (process.env['CODEBURN_VERBOSE'] === '1') {
    process.stderr.write(`codeburn: startup timing refresh-lock=${(performance.now() - refreshWaitStarted).toFixed(1)}ms outcome=${refresh.outcome}\n`)
  }
  if (refresh.outcome === 'timed-out' || refresh.outcome === 'unavailable') {
    return runParse(key, priorSnapshot, dateRange, providerFilter, { readOnly: true, burstSig, parseStartedAt })
  }
  if (refresh.outcome === 'completed-by-other') {
    return runParse(key, await loadCache(loadScope), dateRange, providerFilter, { readOnly: true, burstSig, parseStartedAt })
  }

  try {
    // Reload only after ownership is canonical; this closes the lost-update
    // window between the pre-gate read and the holder's completed publication.
    diskCache = await loadCache(loadScope)
    return await runParse(key, diskCache, dateRange, providerFilter, { refreshLock: refresh.handle, burstSig, parseStartedAt })
  } catch (err) {
    if (!(err instanceof RefreshFenceLostError) && !(err instanceof RefreshPublicationUnavailableError)) throw err
    return runParse(key, await loadCache(loadScope), dateRange, providerFilter, { readOnly: true, burstSig, parseStartedAt })
  } finally {
    await refresh.handle.release()
  }
}

class RefreshFenceLostError extends Error {}
class RefreshPublicationUnavailableError extends Error {}

type RunParseOptions = {
  isCold?: boolean
  readOnly?: boolean
  snapshotOnly?: boolean
  refreshLock?: RefreshLockHandle
  burstSig: string
  parseStartedAt: number
}

/** Thin wrapper so every runParse call site heartbeats for its whole duration,
 *  including the paths that throw. See {@link startProgressKeepalive}. */
async function runParse(
  key: string,
  diskCache: SessionCache,
  dateRange: DateRange | undefined,
  providerFilter: string | undefined,
  options: RunParseOptions,
): Promise<ProjectSummary[]> {
  startProgressKeepalive()
  try {
    return await runParseInner(key, diskCache, dateRange, providerFilter, options)
  } finally {
    stopProgressKeepalive()
  }
}

async function runParseInner(
  key: string,
  diskCache: SessionCache,
  dateRange: DateRange | undefined,
  providerFilter: string | undefined,
  options: RunParseOptions,
): Promise<ProjectSummary[]> {
  const { isCold = false, readOnly = false, snapshotOnly = false, refreshLock } = options
  const timingStarted = performance.now()
  let timingPrevious = timingStarted
  const traceTiming = (stage: string, extra = ''): void => {
    if (process.env['CODEBURN_VERBOSE'] !== '1') return
    const now = performance.now()
    process.stderr.write(`codeburn: startup timing ${stage}=${(now - timingPrevious).toFixed(1)}ms total=${(now - timingStarted).toFixed(1)}ms${extra}\n`)
    timingPrevious = now
  }
  readOnlyServedStale = false
  deferredRetryableSource = false
  firstPaintDeferredThisRun = 0
  const seenMsgIds = new Set<string>()
  const seenKeys = new Set<string>()
  const allSources = snapshotOnly ? [] : await discoverAllSessions(providerFilter)
  traceTiming('discovery', ` sources=${allSources.length}`)

  const claudeSources = allSources.filter(s => s.provider === 'claude')
  const nonClaudeSources = allSources.filter(s => s.provider !== 'claude')

  const providerGroups = new Map<string, SessionSource[]>()
  for (const source of nonClaudeSources) {
    const existing = providerGroups.get(source.provider) ?? []
    existing.push(source)
    providerGroups.set(source.provider, existing)
  }

  // Cold-run robustness: persist partial progress during a long parse so a run
  // interrupted before the single end-of-parse save still leaves a warm cache
  // behind. Triggered by files parsed rather than elapsed time: the cost of a
  // save scales with the corpus, not the clock, so a wall-clock throttle made a
  // slow cold parse rewrite the whole (growing) cache every few seconds. At this
  // interval a ~18k-file cold parse saves under a dozen times. saveCache is
  // atomic (temp + rename) and writes only the dirty provider shards, so this
  // never races the final save below.
  let filesSinceSave = 0
  let lastSaveAt = Date.now()
  const saveProgress = async (): Promise<void> => {
    if (!isCold || readOnly) return
    if (!isCacheDirty(diskCache)) return
    filesSinceSave++
    if (filesSinceSave < PROGRESS_SAVE_FILE_INTERVAL && Date.now() - lastSaveAt < PROGRESS_SAVE_MAX_INTERVAL_MS) return
    filesSinceSave = 0
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
  // Claude is scanned through scanProjectDirs rather than parseProviderSources, so
  // it needs the same provider-filter guard the durable-orphan loop below applies at
  // its own level. Without it a --provider <other> run still enters scanProjectDirs
  // with an empty dirs list, and the orphan pass there (which reads the whole cached
  // claude section) treats every cached file as "no longer discovered" and re-injects
  // it into the result. Note this is deliberately NOT a `claudeDirs.length > 0` check:
  // when claude IS in scope but every transcript has been pruned from disk, that
  // orphan pass is exactly what keeps PR-attributed spend from vanishing.
  const claudeInScope = !providerFilter || providerFilter === 'all' || providerFilter === 'claude'
  if (claudeSources.length > 0) emitScanProgress({ kind: 'provider', provider: 'claude', state: 'start' })
  let claudeProjects: ProjectSummary[] = []
  if (claudeInScope) {
    try {
      claudeProjects = await scanProjectDirs(claudeDirs, seenMsgIds, diskCache, dateRange, saveProgress, readOnly)
      if (claudeSources.length > 0) emitScanProgress({ kind: 'provider', provider: 'claude', state: 'done', files: claudeSources.length })
    } catch (err) {
      if (!isPermissionError(err)) throw err
      process.stderr.write(`codeburn: skipped claude data (permission denied; grant Full Disk Access to include it)\n`)
      emitScanProgress({ kind: 'provider', provider: 'claude', state: 'skipped' })
    }
  }
  traceTiming('claude')

  const otherProjects: ProjectSummary[] = []
  for (const [providerName, sources] of providerGroups) {
    emitScanProgress({ kind: 'provider', provider: providerName, state: 'start' })
    try {
      const projects = await parseProviderSources(providerName, sources, seenKeys, diskCache, dateRange, saveProgress, readOnly)
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
  traceTiming('other-providers', ` providers=${providerGroups.size}`)

  // Durable providers with cached data but NO discovered sources (all files pruned
  // by VS Code / the external tool) still need their orphan pass to run so the
  // monthly total never drops. Call parseProviderSources with empty sources for
  // any such provider found in the disk cache.
  const processedProviders = new Set(providerGroups.keys())
  if (claudeInScope) processedProviders.add('claude')
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
    if (!snapshotOnly && !section.durable && !DURABLE_PROVIDER_NAMES.has(providerName)) continue
    const projects = await parseProviderSources(providerName, [], seenKeys, diskCache, dateRange, saveProgress, readOnly)
    otherProjects.push(...projects)
  }

  // The full scan reached the end: this cache is now complete. Mark it and
  // persist even when nothing else is dirty, so a pre-marker cache (or a partial
  // that happened to already hold every current file) stops being re-read as cold
  // on every launch, and the completeness marker the daily backfill + splash rely
  // on is durable. A run killed before here never reaches this, so its throttled
  // partial saves keep `complete: false` and the next launch resumes cold.
  // A first-paint run that deferred files never saw the whole corpus, so it may
  // not stamp the cache complete — the next launch (or this run's own
  // background fill) has to come back cold and finish the job. A floored run
  // that deferred NOTHING parsed exactly what an unfloored run would have, so
  // it keeps the normal stamp.
  const deferredForFirstPaint = firstPaintDeferredThisRun > 0
  const wasComplete = isCacheComplete(diskCache)
  if (!readOnly && !wasComplete && !deferredForFirstPaint) diskCache.complete = true
  if (!readOnly && (isCacheDirty(diskCache) || (!wasComplete && !deferredForFirstPaint))) {
    try {
      const published = await saveCache(diskCache, refreshLock?.verifyStillOwner)
      if (!published) throw new RefreshFenceLostError()
    } catch (err) {
      if (err instanceof RefreshFenceLostError) throw err
      if (refreshLock) throw new RefreshPublicationUnavailableError()
    }
  }
  // Assigned, not forced true: a read-only run that had to skip or stale real
  // files, or a write run that deferred a changed source on a retryable
  // failure, reached the end of the scan without hydrating everything, and
  // the daily backfill must not finalize history off it.
  sessionHydrationComplete = (!readOnly || !readOnlyServedStale) && !deferredRetryableSource && !deferredForFirstPaint
  sessionFirstPaintDeferred = deferredForFirstPaint

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
  // A snapshot is an explicitly stale, source-unvalidated view. Publishing it
  // into either exact-key or burst reuse can suppress the reconciliation that
  // the mounted dashboard starts immediately afterward for the full TTL.
  if (!snapshotOnly) {
    if (dateRange) setCachePutMeta({ startMs: dateRange.start.getTime(), endMs: dateRange.end.getTime(), sig: options.burstSig })
    cachePut(key, result, options.parseStartedAt)
  }
  traceTiming('aggregate', ` projects=${result.length}`)
  return result
}
