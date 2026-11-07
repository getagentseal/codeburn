import { readFile, readdir, writeFile, mkdir, rename, stat, unlink } from 'fs/promises'
import { join, resolve } from 'path'
import { randomBytes } from 'crypto'

import { getCodeburnCacheDir, readExistingTextFile } from './cache-dir.js'
import { acquireCacheRefreshLock, type RefreshLockOutcome } from './cache-refresh-lock.js'
import type { ParsedProviderCall } from './providers/types.js'

// Bumped to 3 for the workspace-aware breakdown change: the cursor parser
// now derives `sessionId` from the bubble row key (the real composer id)
// rather than the empty `conversationId` JSON field, and the workspace
// router relies on those composer ids to bucket calls per project.
// Version 2 caches contain `sessionId: 'unknown'` for every call and would
// route everything to the orphan project, so we invalidate them.
// Version 5: parseAgentKv was removed (it double-counted against bubbles);
// real context tokens from composerData.promptTokenBreakdown now drive
// input, and agentKv is used only for the tools/bash breakdown. Cached v4
// results contain stale agentKv calls and lack the real token figures.
// Version 6: conversation input moved to composer-anchored records
// (cursor:composer-input:<id>) with per-conversation source selection, the
// agent stream regained tool/system context and stream-only sessions, and
// tool names are canonicalized. v5 results mix crediting regimes.
// Version 7: a redirected data root can select a different database whose
// size and timestamps happen to match. Cache identity includes its path.
// Version 8: v7 results held old agent streams billed at the DB mtime; a
// dormant DB never changes, so only a version bump re-parses them.
// Version 9: one agentKv value that was not valid JSON emptied the whole agent
// stream, so v8 results lack its tools, estimates and agent-only sessions.
// Also v9: v8 results were stored while agent-stream ids were still left
// past the lookup cap, so an unchanged DB never resolved them.
export const CURSOR_CACHE_VERSION = 9
export const CURSOR_LEGACY_CACHE_FILE = 'cursor-results.json'
export function cursorCacheFileName(version = CURSOR_CACHE_VERSION): string {
  return `cursor-results.v${version}.json`
}

type ResultCache = {
  version?: number
  dbPath: string
  dbMtimeMs: number
  dbSizeBytes: number
  lookbackFloor: string
  calls: ParsedProviderCall[]
}

function getCachePath(): string {
  return join(getCodeburnCacheDir(), cursorCacheFileName())
}

function getLegacyCachePath(): string {
  return join(getCodeburnCacheDir(), CURSOR_LEGACY_CACHE_FILE)
}

function isCurrentHit(cache: ResultCache, dbPath: string, fp: { mtimeMs: number; size: number }, requestedFloor: string): boolean {
  return (
    cache.version === CURSOR_CACHE_VERSION
    && cache.dbPath === resolve(dbPath)
    && cache.dbMtimeMs === fp.mtimeMs
    && cache.dbSizeBytes === fp.size
    && typeof cache.lookbackFloor === 'string'
    && cache.lookbackFloor <= requestedFloor
  )
}

async function readCacheFile(path: string): Promise<ResultCache | null> {
  try {
    const cache = JSON.parse(await readFile(path, 'utf-8')) as ResultCache
    if (cache && typeof cache === 'object') return cache
  } catch {}
  return null
}

async function getDbFingerprint(dbPath: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const s = await stat(dbPath)
    // Cursor writes chat usage through the WAL, so new activity lands in
    // state.vscdb-wal while the main file's mtime/size stay put. Fold the WAL
    // into the fingerprint (mirrors fingerprintDatabase in sqlite.ts).
    let wal: Awaited<ReturnType<typeof stat>> | null = null
    try {
      wal = await stat(dbPath + '-wal')
    } catch (err) {
      // -wal absent (checkpointed) is expected; anything else fails the read.
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
    }
    return {
      mtimeMs: wal ? Math.max(s.mtimeMs, wal.mtimeMs) : s.mtimeMs,
      size: s.size + (wal?.size ?? 0),
    }
  } catch {
    return null
  }
}

export async function readCachedResults(
  dbPath: string,
  requestedFloor: string,
): Promise<ParsedProviderCall[] | null> {
  try {
    const fp = await getDbFingerprint(dbPath)
    if (!fp) return null

    const versioned = await readExistingTextFile(getCachePath())
    if (versioned.status === 'ok') {
      try {
        const cache = JSON.parse(versioned.text) as ResultCache
        if (cache && typeof cache === 'object' && isCurrentHit(cache, dbPath, fp, requestedFloor)) return cache.calls
      } catch {}
      return null
    }
    if (versioned.status === 'unreadable') return null

    // Versioned file is absent (ENOENT). Adopt the unsuffixed file only when its
    // version and fingerprint match — old binaries still own that path.
    const legacy = await readCacheFile(getLegacyCachePath())
    if (legacy && isCurrentHit(legacy, dbPath, fp, requestedFloor)) return legacy.calls
    return null
  } catch {
    return null
  }
}

// Agent-only Cursor sessions carry no timestamp of their own. The time a
// request was first seen is the only stable one, so it is kept outside the
// versioned result cache and survives its version bumps and clears. Wiping the
// whole cache dir loses it by design: those sessions take the DB mtime again.
const FIRST_SEEN_FILE = 'cursor-first-seen.json'
const FIRST_SEEN_LOCK = 'cursor-first-seen.lock'
// Written when the lock cannot be taken, so no writer ever replaces the shared
// file from an unlocked view; the next lock holder folds them in.
const FIRST_SEEN_FRAGMENT = /^cursor-first-seen\.\d+\.json$/

// Anything but the ISO string a parse wrote falls back to the mtime rule.
function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const ms = Date.parse(value)
  return Number.isFinite(ms) && new Date(ms).toISOString() === value
}

function parseFirstSeen(text: string | null): Map<string, string> {
  try {
    const parsed = JSON.parse(text ?? '') as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return new Map(Object.entries(parsed).filter((e): e is [string, string] => isIsoTimestamp(e[1])))
    }
  } catch {}
  return new Map()
}

// The earliest recorded time wins.
function mergeFirstSeen(into: Map<string, string>, from: Map<string, string>): void {
  for (const [key, at] of from) {
    const current = into.get(key)
    if (!current || at < current) into.set(key, at)
  }
}

const readText = (path: string): Promise<string | null> => readFile(path, 'utf-8').catch(() => null)

async function readFirstSeenFiles(dir: string): Promise<{ merged: Map<string, string>; fragments: Array<{ path: string; text: string }> }> {
  const merged = parseFirstSeen(await readText(join(dir, FIRST_SEEN_FILE)))
  const fragments: Array<{ path: string; text: string }> = []
  const names = await readdir(dir).catch(() => [] as string[])
  for (const name of names.filter(n => FIRST_SEEN_FRAGMENT.test(n))) {
    const text = await readText(join(dir, name))
    if (text === null) continue
    fragments.push({ path: join(dir, name), text })
    mergeFirstSeen(merged, parseFirstSeen(text))
  }
  return { merged, fragments }
}

export async function readFirstSeen(): Promise<Map<string, string>> {
  return (await readFirstSeenFiles(getCodeburnCacheDir())).merged
}

// Writes in one process share its fragment, so they run one at a time.
let firstSeenWrites: Promise<void> = Promise.resolve()

export function writeFirstSeen(firstSeen: Map<string, string>): Promise<void> {
  const next = firstSeenWrites.then(() => writeFirstSeenNow(firstSeen))
  firstSeenWrites = next.catch(() => {})
  return next
}

async function writeFirstSeenNow(firstSeen: Map<string, string>): Promise<void> {
  if (process.env['CODEBURN_SUPPRESS_CACHE_WRITES']) return
  const dir = getCodeburnCacheDir()
  await mkdir(dir, { recursive: true }).catch(() => {})
  let lock: RefreshLockOutcome = { outcome: 'unavailable' }
  for (let attempt = 0; attempt < 3; attempt++) {
    lock = await acquireCacheRefreshLock({ cacheDir: dir, lockFile: FIRST_SEEN_LOCK, waitMs: 2_000, pollMs: 10 })
    if (lock.outcome !== 'completed-by-other') break
  }
  if (lock.outcome !== 'acquired') {
    const own = join(dir, `cursor-first-seen.${process.pid}.json`)
    const merged = new Map(firstSeen)
    mergeFirstSeen(merged, parseFirstSeen(await readText(own)))
    await writeAtomic(own, JSON.stringify(Object.fromEntries(merged)))
    return
  }
  try {
    const { merged, fragments } = await readFirstSeenFiles(dir)
    mergeFirstSeen(merged, firstSeen)
    if (!await writeAtomic(join(dir, FIRST_SEEN_FILE), JSON.stringify(Object.fromEntries(merged)))) return
    // A fragment rewritten since it was read keeps its newer entries.
    for (const fragment of fragments) {
      if (await readText(fragment.path) === fragment.text) await unlink(fragment.path).catch(() => {})
    }
  } finally {
    await lock.handle.release().catch(() => {})
  }
}

export async function writeCachedResults(
  dbPath: string,
  calls: ParsedProviderCall[],
  lookbackFloor: string,
): Promise<void> {
  // Diagnostic contexts (codeburn doctor) sample-parse providers under a
  // strictly read-only promise; this is the one parse path that writes to
  // disk before its first yield, so it honors the suppression flag.
  if (process.env['CODEBURN_SUPPRESS_CACHE_WRITES']) return
  const fp = await getDbFingerprint(dbPath)
  if (!fp) return

  const dir = getCodeburnCacheDir()
  await mkdir(dir, { recursive: true }).catch(() => {})
  const cache: ResultCache = {
    version: CURSOR_CACHE_VERSION,
    dbPath: resolve(dbPath),
    dbMtimeMs: fp.mtimeMs,
    dbSizeBytes: fp.size,
    lookbackFloor,
    calls,
  }

  await writeAtomic(getCachePath(), JSON.stringify(cache))
}

// Atomic write: stage to a randomized temp file in the same directory,
// then rename onto the final path. rename() is atomic on POSIX, so a
// crash mid-write never leaves a half-written cache, and concurrent
// CLI invocations using their own random temp names cannot interleave
// bytes in the destination file (they only race on the final rename,
// last-writer-wins, both with valid content).
async function writeAtomic(target: string, text: string): Promise<boolean> {
  const tempPath = `${target}.${randomBytes(8).toString('hex')}.tmp`
  try {
    await writeFile(tempPath, text, 'utf-8')
    await rename(tempPath, target)
    return true
  } catch {
    await unlink(tempPath).catch(() => {})
    return false
  }
}
