import { readFile, mkdir, stat, open, rename, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { randomBytes } from 'crypto'
import { join, resolve } from 'path'
import { AsyncLocalStorage } from 'node:async_hooks'

import { getCodeburnCacheDir, readExistingTextFile } from './cache-dir.js'
import type { ParsedProviderCall } from './providers/types.js'
import { isWslUncPath } from './wsl.js'

// v4: attribute MCP calls emitted as event_msg/mcp_tool_call_end (issue #478).
// Recent Codex sessions cached under v3 dropped these, so force a re-parse.
// v5: also attribute CLI-wrapped MCP calls (`mcp-cli call server tool`) that
// Codex logs as a plain exec_command (issue #478 follow-up). Force a re-parse
// so sessions cached under v4 pick up the CLI-MCP attribution.
// v6/v7: rich-session-capture — per-call locAdded/locRemoved/editFailed from
// patch_apply_end. Sessions cached under v5 lack these fields; re-parse to add.
// v8: persist native MCP timing and compact invocation attribution.
// Deliberately NOT bumped for the resume fields (dev/ino + resumeOffset/
// resumeState): they are additive and absence-safe in both directions, so a
// bump would only throw away a warm multi-hundred-MB cache to gain nothing. An
// entry without them simply re-parses in full once and gains them.
// v9: parse large session_meta records structurally so nested provenance.model
// cannot overwrite the model selected by turn_context.
// v10: same depth-1 window for the rest of session_meta's raw string fields
// (cwd/name/originator/session_id/forked_from_id/model_provider).
// v11: codex pricing fix (#1075) - reasoning is no longer added on top of
// output, and cache_write_input_tokens is carved out of the input bucket. This
// file stores each call's costUSD and token buckets verbatim, so entries
// written by v10 carry the old (overstated) cost and must be re-derived.
// v13: codex throughput fix (#1079) - activeGeneratedTokens was summing
// output + reasoning, the same double-count Fix A removed from cost. This
// file stores activeGeneratedTokens/activeDurationMs/toolWaitMs verbatim (not
// re-derived on read), so v11 entries carry the overstated numerator and must
// re-parse. Not 12: v12 is claimed by feat/core-extraction's own port of this
// throughput feature (PR #1086), so reusing it would let two incompatible
// schemas share a filename.
export const CODEX_CACHE_VERSION = 13
export const CODEX_LEGACY_CACHE_FILE = 'codex-results.json'
export function codexCacheFileName(version = CODEX_CACHE_VERSION): string {
  return `codex-results.v${version}.json`
}

export type CodexFileFingerprint = { dev: number; ino: number; mtimeMs: number; sizeBytes: number }
type FileFingerprint = CodexFileFingerprint

type FileEntry = {
  // Absent on entries written before the resume support landed.
  dev?: number
  ino?: number
  mtimeMs: number
  sizeBytes: number
  project: string
  calls: ParsedProviderCall[]
  /** Byte offset of a complete-line boundary the parser can restart from. */
  resumeOffset?: number
  /** Opaque parser state captured at `resumeOffset` (shape owned by the Codex parser). */
  resumeState?: unknown
  /** How many of `calls` were decoded before `resumeOffset`. */
  resumeCallCount?: number
}

/** An exact fingerprint match, or an append the parser can resume into. */
export type CodexCacheHit =
  | { kind: 'exact'; calls: ParsedProviderCall[] }
  | { kind: 'resume'; calls: ParsedProviderCall[]; offset: number; state: unknown; callCount: number }

type ResultCache = {
  version: number
  files: Record<string, FileEntry>
}

const cacheDirContext = new AsyncLocalStorage<string>()

function currentCacheDir(): string {
  return cacheDirContext.getStore() ?? resolve(getCodeburnCacheDir())
}

// A parse can cross many async boundaries before the Codex provider publishes
// its incremental cache. Embedded hosts are allowed to change the process env
// between calls, so pin the call-time directory for the whole transaction
// instead of re-reading CODEBURN_CACHE_DIR at each cache operation.
export function withCodexCacheDirectory<T>(cacheDir: string, operation: () => T): T {
  return cacheDirContext.run(resolve(cacheDir), operation)
}

function getCachePath(cacheDir: string): string {
  return join(cacheDir, codexCacheFileName())
}

function getLegacyCachePath(cacheDir: string): string {
  return join(cacheDir, CODEX_LEGACY_CACHE_FILE)
}

function isCurrentCache(cache: ResultCache): boolean {
  return cache.version === CODEX_CACHE_VERSION && !!cache.files && typeof cache.files === 'object'
}

// Embedded consumers can change CODEBURN_CACHE_DIR without reloading this
// module. Keep each directory's in-memory state separate so a warm cache (or an
// unflushed update) from A can never be read from or written into B.
const memCaches = new Map<string, ResultCache>()

// Dropped by the resident RSS guard. Every write is published by
// flushCodexCache() in the parse's finally, so the next load re-reads disk.
export function clearCodexMemCaches(): void {
  memCaches.clear()
}

async function loadCache(cacheDir: string): Promise<ResultCache> {
  const inMemory = memCaches.get(cacheDir)
  if (inMemory) return inMemory
  const empty = { version: CODEX_CACHE_VERSION, files: {} }
  const versioned = await readExistingTextFile(getCachePath(cacheDir))
  if (versioned.status === 'ok') {
    try {
      const cache = JSON.parse(versioned.text) as ResultCache
      if (isCurrentCache(cache)) {
        memCaches.set(cacheDir, cache)
        return cache
      }
    } catch {}
    memCaches.set(cacheDir, empty)
    return empty
  }
  if (versioned.status === 'unreadable') {
    memCaches.set(cacheDir, empty)
    return empty
  }
  // Versioned file is absent (ENOENT). Adopt the unsuffixed file only when its
  // version matches — old binaries still own that path; we never write or delete it.
  try {
    const raw = await readFile(getLegacyCachePath(cacheDir), 'utf-8')
    const cache = JSON.parse(raw) as ResultCache
    if (isCurrentCache(cache)) {
      memCaches.set(cacheDir, cache)
      return cache
    }
  } catch {}
  memCaches.set(cacheDir, empty)
  return empty
}

function getEntry(cache: ResultCache, filePath: string, fp: FileFingerprint): FileEntry | null {
  if (!Object.hasOwn(cache.files, filePath)) return null
  const entry = cache.files[filePath]
  if (entry && entry.mtimeMs === fp.mtimeMs && entry.sizeBytes === fp.sizeBytes) {
    return entry
  }
  return null
}

// A grown file is only assumed to be an APPEND if the recorded boundary still
// falls right after a newline. A same-inode rewrite (truncate + refill, or an
// in-place edit) that happens to end up larger would otherwise resume into the
// middle of an unrelated line. Reading one byte is cheaper than being wrong.
async function endsLineAt(filePath: string, offset: number): Promise<boolean> {
  if (offset === 0) return true
  try {
    const handle = await open(filePath, 'r')
    try {
      const buf = Buffer.alloc(1)
      const { bytesRead } = await handle.read(buf, 0, 1, offset - 1)
      return bytesRead === 1 && buf[0] === 0x0a
    } finally {
      await handle.close()
    }
  } catch {
    return false
  }
}

/// WSL's 9P share synthesizes dev/ino per mount, so they can differ run to run
/// for an unchanged file. Zero them for `\\wsl$\...` paths so the resume check
/// below still matches instead of re-reading every WSL rollout whole (#1059).
function fingerprintFromStat(filePath: string, s: { dev: number; ino: number; mtimeMs: number; size: number }): FileFingerprint {
  if (isWslUncPath(filePath)) return { dev: 0, ino: 0, mtimeMs: s.mtimeMs, sizeBytes: s.size }
  return { dev: s.dev, ino: s.ino, mtimeMs: s.mtimeMs, sizeBytes: s.size }
}

export async function readCachedCodexResults(
  filePath: string,
): Promise<CodexCacheHit | null> {
  try {
    const s = await stat(filePath)
    const cache = await loadCache(currentCacheDir())
    const fp = fingerprintFromStat(filePath, s)
    const entry = getEntry(cache, filePath, fp)
    if (entry) return { kind: 'exact', calls: entry.calls }
    // Rollouts are append-only: the same inode, grown past a boundary we
    // recorded, can be picked up from that boundary instead of re-read whole.
    const stale = cache.files[filePath]
    if (
      stale
      && stale.dev === fp.dev
      && stale.ino === fp.ino
      && stale.resumeOffset !== undefined
      && stale.resumeState !== undefined
      && stale.resumeCallCount !== undefined
      && fp.sizeBytes > stale.sizeBytes
      && stale.resumeOffset <= fp.sizeBytes
      && await endsLineAt(filePath, stale.resumeOffset)
    ) {
      return { kind: 'resume', calls: stale.calls, offset: stale.resumeOffset, state: stale.resumeState, callCount: stale.resumeCallCount }
    }
  } catch {}
  return null
}

export async function getCachedCodexProject(
  filePath: string,
): Promise<string | null> {
  try {
    const s = await stat(filePath)
    const cache = await loadCache(currentCacheDir())
    const entry = getEntry(cache, filePath, fingerprintFromStat(filePath, s))
    return entry?.project ?? null
  } catch {}
  return null
}

export async function fingerprintFile(
  filePath: string,
): Promise<FileFingerprint | null> {
  try {
    return fingerprintFromStat(filePath, await stat(filePath))
  } catch {
    return null
  }
}

export async function writeCachedCodexResults(
  filePath: string,
  project: string,
  calls: ParsedProviderCall[],
  fingerprint: FileFingerprint,
  resume?: { offset: number; state: unknown; callCount: number },
): Promise<void> {
  try {
    const cache = await loadCache(currentCacheDir())
    cache.files[filePath] = {
      dev: fingerprint.dev,
      ino: fingerprint.ino,
      mtimeMs: fingerprint.mtimeMs,
      sizeBytes: fingerprint.sizeBytes,
      project,
      calls,
      ...(resume ? { resumeOffset: resume.offset, resumeState: resume.state, resumeCallCount: resume.callCount } : {}),
    }
  } catch {}
}

export async function flushCodexCache(): Promise<void> {
  const cacheDir = currentCacheDir()
  const memCache = memCaches.get(cacheDir)
  if (!memCache) return
  try {
    // Evict entries for files that no longer exist on disk
    const paths = Object.keys(memCache.files)
    for (const p of paths) {
      try {
        await stat(p)
      } catch {
        delete memCache.files[p]
      }
    }

    if (!existsSync(cacheDir)) await mkdir(cacheDir, { recursive: true })
    const finalPath = getCachePath(cacheDir)
    const tempPath = `${finalPath}.${randomBytes(8).toString('hex')}.tmp`
    const payload = JSON.stringify(memCache)
    const handle = await open(tempPath, 'w', 0o600)
    try {
      await handle.writeFile(payload, { encoding: 'utf-8' })
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(tempPath, finalPath)
    } catch (err) {
      try { await unlink(tempPath) } catch {}
      throw err
    }
  } catch {}
}
