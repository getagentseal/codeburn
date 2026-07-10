import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { readSessionLines } from '../fs-utils.js'
import { parseApiCall, parseAdvisorCalls, parseJsonlLine } from '../parser.js'
import { EDIT_TOOLS } from '../classifier.js'
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
}

// v2: per-message-id replace fold (perMessage map, sawEdit boolean) and the
// guard/sessions/ cache location. v1 caches are ignored and cold-reparse once.
// v3: fold advisor (/advisor) cost into each message; v2 caches computed the
// per-message cost without it, so they must cold-reparse.
export const GUARD_CACHE_VERSION = 3

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
  const cache = size < prev.byteOffset
    ? { ...emptyCache(prev.sessionId), softWarned: prev.softWarned, stopNotified: prev.stopNotified }
    : { ...prev, perMessage: { ...prev.perMessage } }
  const resumedFrom = cache.byteOffset

  const tracker = { lastCompleteLineOffset: resumedFrom }
  for await (const line of readSessionLines(transcriptPath, undefined, {
    startByteOffset: resumedFrom,
    byteOffsetTracker: tracker,
    largeLineAsBuffer: true,
  })) {
    const entry = parseJsonlLine(line)
    if (!entry) continue
    const call = parseApiCall(entry)
    if (!call) continue
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
