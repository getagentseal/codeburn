import { readFile, writeFile, mkdir, rename, stat, unlink } from 'fs/promises'
import { join } from 'path'
import { randomBytes } from 'crypto'

import { getCodeburnCacheDir, readExistingTextFile } from './cache-dir.js'
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
export const CURSOR_CACHE_VERSION = 6
export const CURSOR_LEGACY_CACHE_FILE = 'cursor-results.json'
export function cursorCacheFileName(version = CURSOR_CACHE_VERSION): string {
  return `cursor-results.v${version}.json`
}

type ResultCache = {
  version?: number
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

function isCurrentHit(cache: ResultCache, fp: { mtimeMs: number; size: number }, requestedFloor: string): boolean {
  return (
    cache.version === CURSOR_CACHE_VERSION
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
        if (cache && typeof cache === 'object' && isCurrentHit(cache, fp, requestedFloor)) return cache.calls
      } catch {}
      return null
    }
    if (versioned.status === 'unreadable') return null

    // Versioned file is absent (ENOENT). Adopt the unsuffixed file only when its
    // version and fingerprint match — old binaries still own that path.
    const legacy = await readCacheFile(getLegacyCachePath())
    if (legacy && isCurrentHit(legacy, fp, requestedFloor)) return legacy.calls
    return null
  } catch {
    return null
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
    dbMtimeMs: fp.mtimeMs,
    dbSizeBytes: fp.size,
    lookbackFloor,
    calls,
  }

  // Atomic write: stage to a randomized temp file in the same directory,
  // then rename onto the final path. rename() is atomic on POSIX, so a
  // crash mid-write never leaves a half-written cache, and concurrent
  // CLI invocations using their own random temp names cannot interleave
  // bytes in the destination file (they only race on the final rename,
  // last-writer-wins, both with valid content).
  const target = getCachePath()
  const tempPath = `${target}.${randomBytes(8).toString('hex')}.tmp`
  try {
    await writeFile(tempPath, JSON.stringify(cache), 'utf-8')
    await rename(tempPath, target)
  } catch {
    await unlink(tempPath).catch(() => {})
  }
}
