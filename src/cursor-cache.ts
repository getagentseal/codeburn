import { readFile, writeFile, mkdir, rename, stat, unlink } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { randomBytes } from 'crypto'

import type { ParsedProviderCall } from './providers/types.js'

const CURSOR_CACHE_VERSION = 2

type ResultCache = {
  version?: number
  dbMtimeMs: number
  dbSizeBytes: number
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

export async function readCachedResults(dbPath: string): Promise<ParsedProviderCall[] | null> {
  try {
    const fp = await getDbFingerprint(dbPath)
    if (!fp) return null

    const raw = await readFile(getCachePath(), 'utf-8')
    const cache = JSON.parse(raw) as ResultCache

    if (cache.version === CURSOR_CACHE_VERSION && cache.dbMtimeMs === fp.mtimeMs && cache.dbSizeBytes === fp.size) {
      return cache.calls
    }
    return null
  } catch {
    return null
  }
}

export async function writeCachedResults(dbPath: string, calls: ParsedProviderCall[]): Promise<void> {
  const fp = await getDbFingerprint(dbPath)
  if (!fp) return

  const dir = getCacheDir()
  await mkdir(dir, { recursive: true }).catch(() => {})
  const cache: ResultCache = {
    version: CURSOR_CACHE_VERSION,
    dbMtimeMs: fp.mtimeMs,
    dbSizeBytes: fp.size,
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
