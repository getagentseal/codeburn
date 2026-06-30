import { readFile, writeFile, mkdir, rename, stat, unlink } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { randomBytes } from 'crypto'

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
const CURSOR_CACHE_VERSION = 5

type ResultCache = {
  version?: number
  dbMtimeMs: number
  dbSizeBytes: number
  lookbackFloor: string
  calls: ParsedProviderCall[]
}

const CACHE_FILE = 'cursor-results.json'

function getCacheDir(): string {
  return join(homedir(), '.cache', 'codeburn')
}

function getCachePath(): string {
  return join(getCacheDir(), CACHE_FILE)
}

async function getDbFingerprint(dbPath: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const s = await stat(dbPath)
    return { mtimeMs: s.mtimeMs, size: s.size }
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

    const raw = await readFile(getCachePath(), 'utf-8')
    const cache = JSON.parse(raw) as ResultCache

    if (
      cache.version === CURSOR_CACHE_VERSION &&
      cache.dbMtimeMs === fp.mtimeMs &&
      cache.dbSizeBytes === fp.size &&
      typeof cache.lookbackFloor === 'string' &&
      cache.lookbackFloor <= requestedFloor
    ) {
      return cache.calls
    }
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
  const fp = await getDbFingerprint(dbPath)
  if (!fp) return

  const dir = getCacheDir()
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
