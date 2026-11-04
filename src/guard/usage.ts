import { createHash } from 'crypto'
import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { readSessionLines } from '../fs-utils.js'
import { collectToolResultMeta, parseApiCall, parseAdvisorCalls, parseJsonlLine, type ToolResultMeta } from '../parser.js'
import { BASH_TOOLS, EDIT_TOOLS } from '../classifier.js'
import type { JournalEntry } from '../types.js'
import { allowPath, sessionCachePath, sessionsDir } from './store.js'

// Per-session running totals. The transcript is append-only, so each invocation
// streams only the bytes after `byteOffset` (the offset of the last complete
// line parsed) and folds them into the totals; a cold parse of a multi-hundred-
// MB transcript on every tool call is what this avoids.
//
// Claude Code rewrites each assistant message several times as it streams, and
// every copy carries the full final usage. The shipped parser dedupes those
// copies last-wins (dedupeStreamingMessageIds); a plain sum here measured real
// sessions at ~3x their true cost. `perMessage` maps message id -> that id's
// current cost contribution, and each id-carrying line REPLACES its previous
// contribution instead of adding. This also self-heals the trailing-line case:
// a complete final line without its newline is folded but byteOffset stops
// before it, so the next invocation re-reads it as a replace, not a double add.
//
// The loop and retry signals fold from the same tail: `recentCalls` is a
// rolling window of the last tool calls (keyed by tool_use id so a call the
// PreToolUse hook recorded itself is not counted again when the lagging
// transcript catches up), `shellPending` maps a shell tool_use id to its command
// hash until its tool_result arrives, and `failedCommands` counts is_error
// results per command hash.
export type ToolCallKey = { id: string; name: string; hash: string }

export type GuardCache = {
  version: number
  sessionId: string
  byteOffset: number
  costUSD: number
  perMessage: Record<string, number>
  sawEdit: boolean
  sawGitCommit: boolean
  lastTurnAt: string | null
  updatedAt: string
  softWarned: boolean
  stopNotified: boolean
  recentCalls: ToolCallKey[]
  shellPending: Record<string, string>
  failedCommands: Record<string, number>
  loopWarned: boolean
  retryWarned: boolean
  loopRun: number
  signalWarnCostUSD: number | null
  signalStopNotified: boolean
}

// v2: per-message-id replace fold (perMessage map, sawEdit boolean) and the
// guard/sessions/ cache location. v1 caches are ignored and cold-reparse once.
// v3: fold advisor (/advisor) cost into each message; v2 caches computed the
// per-message cost without it, so they must cold-reparse.
// v4: loop and retry state (recentCalls, shellPending, failedCommands); v3
// caches never folded tool calls, so they must cold-reparse.
export const GUARD_CACHE_VERSION = 4

export const RECENT_CALLS = 16

// `commit` must be the git subcommand: `git`, optionally flag tokens (long
// flags, or a short flag with an optional separate value like `-c k=v`), then
// `commit` as the next word, anchored at a command boundary: string/line start
// (multi-line Bash calls separate commands with newlines) or ; & |. The gaps
// inside the command never cross a newline, so "git diff\ncommit msg" is two
// commands, not a commit. "git log --grep commit" and "git diff && echo
// commit" don't match either.
const GIT_COMMIT = /(?:^|[;&|])[^\S\n]*git(?:[^\S\n]+(?:--\S+|-\w+(?:[^\S\n]+\S+)?))*[^\S\n]+commit(?![-\w])/m

export function emptyCache(sessionId: string): GuardCache {
  return {
    version: GUARD_CACHE_VERSION,
    sessionId,
    byteOffset: 0,
    costUSD: 0,
    perMessage: {},
    sawEdit: false,
    sawGitCommit: false,
    lastTurnAt: null,
    updatedAt: '',
    softWarned: false,
    stopNotified: false,
    recentCalls: [],
    shellPending: {},
    failedCommands: {},
    loopWarned: false,
    retryWarned: false,
    loopRun: 0,
    signalWarnCostUSD: null,
    signalStopNotified: false,
  }
}

// Stable across key order, so the same call written twice hashes the same.
export function inputHash(value: unknown): string {
  const json = JSON.stringify(value ?? null, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v)
  return createHash('sha256').update(json ?? 'null').digest('hex').slice(0, 16)
}

export function recordToolCall(cache: GuardCache, call: ToolCallKey): void {
  if (call.id && cache.recentCalls.some(c => c.id === call.id)) return
  cache.recentCalls.push(call)
  if (cache.recentCalls.length > RECENT_CALLS) cache.recentCalls.shift()
}

// How many calls in a row, the incoming one included, share its name and input.
export function identicalRun(cache: GuardCache, call: ToolCallKey): number {
  let run = 1
  for (let i = cache.recentCalls.length - 1; i >= 0; i--) {
    const c = cache.recentCalls[i]!
    if (call.id && c.id === call.id) continue
    if (c.name !== call.name || c.hash !== call.hash) break
    run++
  }
  return run
}

function foldToolResults(cache: GuardCache, entry: JournalEntry): void {
  const results = new Map<string, ToolResultMeta>()
  collectToolResultMeta(entry, results)
  for (const [id, meta] of results) {
    const cmd = cache.shellPending[id]
    if (cmd === undefined) continue
    delete cache.shellPending[id]
    if (meta.isError) cache.failedCommands[cmd] = (cache.failedCommands[cmd] ?? 0) + 1
  }
}

function foldToolUses(cache: GuardCache, entry: JournalEntry): void {
  const content = (entry.message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return
  for (const b of content as { type?: unknown; id?: unknown; name?: unknown; input?: unknown }[]) {
    if (b?.type !== 'tool_use' || typeof b.id !== 'string' || typeof b.name !== 'string') continue
    const command = (b.input as { command?: unknown } | undefined)?.command
    if (BASH_TOOLS.has(b.name) && typeof command === 'string') cache.shellPending[b.id] = inputHash(command)
    recordToolCall(cache, { id: b.id, name: b.name, hash: inputHash(b.input ?? {}) })
  }
}

export async function readCache(sessionId: string, base?: string): Promise<GuardCache> {
  let raw: string
  try {
    raw = await readFile(sessionCachePath(sessionId, base), 'utf-8')
  } catch {
    return emptyCache(sessionId)
  }
  try {
    const parsed = JSON.parse(raw) as Partial<GuardCache>
    if (
      parsed.version !== GUARD_CACHE_VERSION
      || typeof parsed.byteOffset !== 'number'
      || !parsed.perMessage || typeof parsed.perMessage !== 'object'
    ) {
      return emptyCache(sessionId)
    }
    return { ...emptyCache(sessionId), ...parsed, sessionId }
  } catch {
    return emptyCache(sessionId)
  }
}

export async function writeCache(cache: GuardCache, base?: string): Promise<void> {
  await mkdir(sessionsDir(base), { recursive: true })
  await writeFile(sessionCachePath(cache.sessionId, base), JSON.stringify(cache), 'utf-8')
}

// Fold the transcript tail into the totals. Reuses the streaming line reader
// (startByteOffset + a lastCompleteLineOffset tracker) and the shared per-call
// cost/pricing path (parseApiCall -> calculateCost), so the guard never
// reimplements cost math. `resumedFrom` is the offset the parse restarted at,
// which the test asserts to prove only the tail was read.
export async function computeSessionUsage(
  prev: GuardCache,
  transcriptPath: string,
): Promise<{ cache: GuardCache; resumedFrom: number }> {
  let size: number
  try {
    size = (await stat(transcriptPath)).size
  } catch {
    return { cache: prev, resumedFrom: prev.byteOffset }
  }

  // A shorter file than we last read means the transcript was rotated or
  // truncated; start over from a clean total rather than trusting a stale
  // offset into different bytes.
  const cache: GuardCache = size < prev.byteOffset
    ? {
        ...emptyCache(prev.sessionId),
        softWarned: prev.softWarned,
        stopNotified: prev.stopNotified,
        loopWarned: prev.loopWarned,
        retryWarned: prev.retryWarned,
        loopRun: prev.loopRun,
        signalStopNotified: prev.signalStopNotified,
      }
    : {
        ...prev,
        perMessage: { ...prev.perMessage },
        recentCalls: [...prev.recentCalls],
        shellPending: { ...prev.shellPending },
        failedCommands: { ...prev.failedCommands },
      }
  const resumedFrom = cache.byteOffset

  const tracker = { lastCompleteLineOffset: resumedFrom }
  for await (const line of readSessionLines(transcriptPath, undefined, {
    startByteOffset: resumedFrom,
    byteOffsetTracker: tracker,
    largeLineAsBuffer: true,
  })) {
    const entry = parseJsonlLine(line)
    if (!entry) continue
    foldToolResults(cache, entry)
    const call = parseApiCall(entry)
    if (!call) continue
    foldToolUses(cache, entry)
    // Advisor (/advisor) escalations are billed under a separate model and live
    // outside the top-level usage, so add their cost to the message total.
    const advisorCost = parseAdvisorCalls(entry).reduce((sum, a) => sum + a.costUSD, 0)
    const lineCost = call.costUSD + advisorCost
    // Last-wins per message id, matching the shipped dedupeStreamingMessageIds.
    // Lines without an id (rare, and never streamed in copies) just add.
    const msgId = (entry.message as { id?: string } | undefined)?.id
    if (msgId) {
      cache.costUSD += lineCost - (cache.perMessage[msgId] ?? 0)
      cache.perMessage[msgId] = lineCost
    } else {
      cache.costUSD += lineCost
    }
    for (const tc of call.toolSequence?.flat() ?? []) {
      if (!cache.sawEdit && EDIT_TOOLS.has(tc.tool)) cache.sawEdit = true
      if (!cache.sawGitCommit && tc.command && GIT_COMMIT.test(tc.command)) cache.sawGitCommit = true
    }
    if (call.timestamp) cache.lastTurnAt = call.timestamp
  }

  cache.byteOffset = tracker.lastCompleteLineOffset
  cache.updatedAt = new Date().toISOString()
  return { cache, resumedFrom }
}

export async function isAllowed(sessionId: string, base?: string): Promise<boolean> {
  try {
    await stat(allowPath(sessionId, base))
    return true
  } catch {
    return false
  }
}

export async function writeAllow(sessionId: string, base?: string): Promise<void> {
  await mkdir(sessionsDir(base), { recursive: true })
  await writeFile(allowPath(sessionId, base), '', 'utf-8')
}
