import { randomBytes } from 'crypto'
import { chmod, mkdir, open, readFile, rename, stat, unlink } from 'fs/promises'
import { basename, join } from 'path'
import { homedir } from 'os'

import type { ParsedProviderCall } from './providers/types.js'

/// Per-session cache for parsed Auggie calls. Each session file in ~/.augment/sessions/*.json
/// is pretty-printed JSON rewritten on every update, so stat (mtime + size) is a stable
/// fingerprint. Storing one cache file per session keeps re-parse work proportional to what
/// actually changed; with 700+ sessions a single aggregate cache would rewrite megabytes on
/// any change.
///
/// File mode 0600, parent dir 0700 -- matches the round-2 G4 hardening on
/// `src/cursor-cache.ts` and `src/config.ts`. Writes are atomic (temp + rename).

type SessionCacheFile = {
  version: number
  sourcePath: string
  mtimeMs: number
  sizeBytes: number
  calls: ParsedProviderCall[]
}

const CACHE_VERSION = 1
const CACHE_SUBDIR = 'auggie'
const CACHE_FILE_MODE = 0o600
const CACHE_DIR_MODE = 0o700

function getCacheDir(): string {
  const base = process.env['CODEBURN_CACHE_DIR'] ?? join(homedir(), '.cache', 'codeburn')
  return join(base, CACHE_SUBDIR)
}

function cachePathFor(sourcePath: string): string {
  // The session filename is already a UUID, so basename is unique. Don't hash -- keeps the
  // cache layout inspectable with `ls` and makes invalidation on session deletion trivial.
  return join(getCacheDir(), basename(sourcePath))
}

async function ensureCacheDir(): Promise<void> {
  const dir = getCacheDir()
  await mkdir(dir, { recursive: true, mode: CACHE_DIR_MODE })
  // mkdir only honours mode for newly-created directories; chmod brings an older 0755 dir
  // (from a pre-hardening run) down to 0700. Best-effort; ignore EPERM.
  await chmod(dir, CACHE_DIR_MODE).catch(() => {})
}

async function getFingerprint(sourcePath: string): Promise<{ mtimeMs: number; sizeBytes: number } | null> {
  try {
    const s = await stat(sourcePath)
    return { mtimeMs: s.mtimeMs, sizeBytes: s.size }
  } catch {
    return null
  }
}

export async function readCachedCalls(sourcePath: string): Promise<ParsedProviderCall[] | null> {
  try {
    const fp = await getFingerprint(sourcePath)
    if (!fp) return null

    const raw = await readFile(cachePathFor(sourcePath), 'utf-8')
    const cache = JSON.parse(raw) as SessionCacheFile
    if (cache.version !== CACHE_VERSION) return null
    if (cache.sourcePath !== sourcePath) return null
    if (cache.mtimeMs !== fp.mtimeMs) return null
    if (cache.sizeBytes !== fp.sizeBytes) return null
    return cache.calls
  } catch {
    return null
  }
}

export async function writeCachedCalls(sourcePath: string, calls: ParsedProviderCall[]): Promise<void> {
  try {
    const fp = await getFingerprint(sourcePath)
    if (!fp) return

    await ensureCacheDir()
    const payload: SessionCacheFile = {
      version: CACHE_VERSION,
      sourcePath,
      mtimeMs: fp.mtimeMs,
      sizeBytes: fp.sizeBytes,
      calls,
    }

    const finalPath = cachePathFor(sourcePath)
    const tempPath = `${finalPath}.${randomBytes(8).toString('hex')}.tmp`
    const serialised = JSON.stringify(payload)
    const handle = await open(tempPath, 'w', CACHE_FILE_MODE)
    try {
      await handle.writeFile(serialised, { encoding: 'utf-8' })
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(tempPath, finalPath)
    } catch (err) {
      try { await unlink(tempPath) } catch { /* ignore */ }
      throw err
    }
  } catch {
    // Cache failure is non-fatal -- the parser will just re-parse next run.
  }
}
