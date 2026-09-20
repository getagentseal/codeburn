import { readFile, mkdir, stat, open, rename, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { randomBytes } from 'crypto'
import { join, resolve } from 'path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { ignore } from 'stream-json/filters/ignore.js'
import { pick } from 'stream-json/filters/pick.js'
import { streamObject } from 'stream-json/streamers/stream-object.js'

import { getCodeburnCacheDir } from './cache-dir.js'
import type { ParsedProviderCall } from './providers/types.js'
import { streamShardArrayField, writeChunk } from './shard-stream.js'
import { flatString, flattenJsonStrings } from './content-utils.js'

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
// v14: MCP + Skill attribution for the shapes the classic `function_call` path
// never reached (#478) - the `exec` custom tool's `input` program and the item
// model's `item_completed`/`CommandExecution` item - plus SKILL.md reads landing
// in `skills`. This file stores each call's `tools`/`toolSequence`/`skills`
// verbatim (they are passed through on read, never re-derived), so v13 entries
// keep the old, MCP- and skill-less attribution until they re-parse.
// v15: builtin alias prices `codex-auto-review` (#1047). Exact-hit cache
// entries still hold the pre-alias $0; bump so unchanged rollouts reprice.
// Must be max(main v14 #1092, this)+1 — #1092 spent v14 on MCP/skills.
// No bump for #1264: the missing-cumulative branch is a no-op on real data
// (0 occurrences of info-without-total across 137k+ events; null-info pings
// already take the estimate path), so cached numbers are identical and a
// bump would only force a cold reparse. v16 was never shipped in a release.
export const CODEX_CACHE_VERSION = 15
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
type MemState = {
  cache: ResultCache
  /// Null for a complete load; otherwise the range-start floor a filtered
  /// load retained. Loads with different identities never share entries.
  rangeStartMs: number | null
}
const memCaches = new Map<string, MemState>()

// Fresh full records written since load, keyed by directory. Deliberately
// range-independent: a fresh parse is complete under any projection, so one
// overlay serves every concurrent range. Entries live here only while
// unflushed: a successful flush publishes them and releases the map (disk is
// authoritative afterwards; later lookups re-stream once per snapshot
// identity), so CLI runs that never clear still track the dirty set instead
// of the corpus.
const codexOverlay = new Map<string, Map<string, FileEntry>>()

// Project labels for discovery, WITHOUT loading the calls map: the full
// result file would otherwise parse on every run just to name projects (see
// discoverSessionFile). Rebuilt by one streaming pass when the file changes;
// updated incrementally on write and flush.
type ProjectIndexRow = { project: string; dev?: number; ino?: number; mtimeMs?: number; sizeBytes?: number }
type ProjectIndexState = { builtForMtimeMs: number; rows: Map<string, ProjectIndexRow> }
const projectIndexes = new Map<string, ProjectIndexState>()

// Dropped by the resident RSS guard. Every write is published by
// flushCodexCache() in the parse's finally, so the next load re-reads disk.
export function clearCodexMemCaches(): void {
  memCaches.clear()
  inFlightLoads.clear()
  codexOverlay.clear()
  projectIndexes.clear()
  indexBuilds.clear()
  // A cleared in-flight load cannot be cancelled; without this it would
  // repopulate memCaches after resolving (defeating the RSS guard). The
  // load loop observes the epoch across its read and skips the memo when a
  // clear intervened (a clear changes no disk bytes, so the data stays
  // servable — only the repopulation is dropped).
  memEpoch++
}

// Concurrent discovery callers must share one index build: without this every
// in-flight caller would stream-decode the same hundreds-of-MB file. Keyed by
// directory and file mtime so a rebuild after the file changes never joins a
// stale build.
const indexBuilds = new Map<string, Promise<Map<string, ProjectIndexRow>>>()

// Concurrent callers must share one load. The memo below is only populated
// after the read resolves, so without this every in-flight caller would
// re-read and re-parse the same (hundreds-of-MB) cache file. Keyed by
// directory AND range identity (see MemState): concurrent loads for different
// ranges must never share entries.
const inFlightLoads = new Map<string, Promise<MemState>>()

/// Store generation per directory: a flush that publishes bumps it and drops
/// snapshots, so a load that started before the flush never republishes stale
/// bytes afterwards (deleting inFlightLoads alone cannot cancel the promise).
const flushGenerations = new Map<string, number>()
/// Global clear epoch: bumped by clearCodexMemCaches (see above). Captured
/// beside the per-directory generation before I/O and re-checked after.
let memEpoch = 0

/// Per-directory flush mutex: two concurrent flushes would merge against the
/// same published bytes and race the rename, losing one batch. Loads stay
/// unlocked (they never mutate); staleness is handled by the generation.
const flushChains = new Map<string, Promise<void>>()
async function withFlushMutex<T>(cacheDir: string, fn: () => Promise<T>): Promise<T> {
  const prev = flushChains.get(cacheDir) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const joined = prev.then(() => gate)
  flushChains.set(cacheDir, joined)
  await prev
  try {
    return await fn()
  } finally {
    release()
    if (flushChains.get(cacheDir) === joined) flushChains.delete(cacheDir)
  }
}

/// Snapshot key: directory AND range identity. A lookup whose identity
/// mismatches every resident snapshot reloads instead of sharing.
function snapshotKey(cacheDir: string, rangeStartMs: number | null): string {
  return `${cacheDir}\0${rangeStartMs === null ? 'full' : `from:${rangeStartMs}`}`
}

/// At most this many snapshots per directory (LRU); the resident RSS guard
/// can drop everything at any time via clearCodexMemCaches.
const MAX_SNAPSHOTS_PER_DIR = 3

function storeSnapshot(cacheDir: string, state: MemState): void {
  memCaches.set(snapshotKey(cacheDir, state.rangeStartMs), state)
  const prefix = `${cacheDir}\0`
  const owned: string[] = []
  for (const key of memCaches.keys()) {
    if (key.startsWith(prefix)) owned.push(key)
  }
  while (owned.length > MAX_SNAPSHOTS_PER_DIR) {
    const oldest = owned.shift()!
    memCaches.delete(oldest)
  }
}

function residentSnapshot(cacheDir: string, rangeStartMs: number | null): ResultCache | null {
  const key = snapshotKey(cacheDir, rangeStartMs)
  const entry = memCaches.get(key)
  if (!entry) return null
  // Refresh recency for the LRU cap.
  memCaches.delete(key)
  memCaches.set(key, entry)
  return entry.cache
}

async function loadCache(cacheDir: string, rangeStartMs?: number): Promise<ResultCache> {
  const identity = rangeStartMs ?? null
  const resident = residentSnapshot(cacheDir, identity)
  if (resident) return resident
  const pendingKey = snapshotKey(cacheDir, identity)
  const pending = inFlightLoads.get(pendingKey)
  if (pending) return (await pending).cache
  const decode = async (): Promise<ResultCache> =>
    identity === null
      ? loadCacheFullFromDisk(cacheDir)
      : loadCacheFilteredFromDisk(cacheDir, identity)
  const load = (async (): Promise<MemState> => {
    for (;;) {
      const gen = flushGenerations.get(cacheDir) ?? 0
      const epoch = memEpoch
      const cache = await decode()
      if ((flushGenerations.get(cacheDir) ?? 0) !== gen) continue
      const state: MemState = { cache, rangeStartMs: identity }
      // A clear intervened: servable bytes, but the RSS guard dropped the
      // memo — do not repopulate it.
      if (memEpoch !== epoch) return state
      storeSnapshot(cacheDir, state)
      return state
    }
  })().finally(() => {
    if (inFlightLoads.get(pendingKey) === load) inFlightLoads.delete(pendingKey)
  })
  inFlightLoads.set(pendingKey, load)
  return (await load).cache
}

/// Version stamped at the head of a result file. Both writers construct
/// `{version, files}` in that order, so a short head read verifies currency
/// without scanning; anything else (foreign layout, corruption) fails closed
/// exactly like a version mismatch does today.
async function readResultsVersion(path: string): Promise<number | null> {
  let head: string
  try {
    const handle = await open(path, 'r')
    try {
      const buf = Buffer.alloc(128)
      const { bytesRead } = await handle.read(buf, 0, 128, 0)
      head = buf.toString('utf-8', 0, bytesRead).replace(/^\uFEFF/, '')
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
  const match = /^\s*\{\s*"version"\s*:\s*(\d+)/.exec(head)
  return match ? Number(match[1]) : null
}

/// Resolve the readable result file, mirroring the historical precedence:
/// the versioned file when present, else the legacy unsuffixed file.
async function resolveResultsPath(cacheDir: string): Promise<string | null> {
  const versioned = getCachePath(cacheDir)
  try {
    await stat(versioned)
    return versioned
  } catch {}
  const legacy = getLegacyCachePath(cacheDir)
  try {
    await stat(legacy)
    return legacy
  } catch {}
  return null
}

/// Keep rule for ranged codex loads. An entry survives when its file may
/// still be looked up (mtime at/after the range start — both lookup paths
/// skip older files first) or any call falls in range. Everything else can
/// never be observed: lookups are mtime-floor-gated and fp-gated, and a miss
/// re-parses from source. Unjudgeable entries (no mtime, malformed or missing
/// timestamps, empty calls) are kept: the full load performs no per-entry
export function retainCodexEntry(value: unknown, rangeStartMs: number): boolean {
  if (!value || typeof value !== 'object') return true
  if ('mtimeMs' in value && typeof value.mtimeMs === 'number' && value.mtimeMs >= rangeStartMs) return true
  if (!('calls' in value) || !Array.isArray(value.calls)) return true
  let seenCall = false
  for (const call of value.calls) {
    seenCall = true
    if (!call || typeof call !== 'object') return true
    if (!('timestamp' in call) || typeof call.timestamp !== 'string') return true
    const ts = Date.parse(call.timestamp)
    if (Number.isNaN(ts) || ts >= rangeStartMs) return true
  }
  return !seenCall
}

/// Streaming load of one result file: version-gated, then per-entry through
/// the pick filter (the nested `files` object streams entry by entry — a
/// top-level decode would assemble all 227MB first). Any failure drops the
/// whole file, mirroring the historical whole-file behavior entry for entry.
async function loadResultsStreaming(
  path: string,
  retain: (value: unknown) => boolean,
  retainKeys?: Set<string>,
): Promise<Record<string, unknown> | null> {
  if ((await readResultsVersion(path)) !== CODEX_CACHE_VERSION) return null
  const files: Record<string, unknown> = {}
  try {
    await streamCodexEntries(path, (key, value) => {
      if (!retain(value)) return
      // Detach before storing (see assembleTokens): snapshots hold these
      // entries long-term, and accumulating unflattened records would pin
      // every tokenizer chunk. In place on the decoder-owned value — no
      // copy, no serialization transient (see flattenJsonStrings).
      files[flatString(key)] = flattenJsonStrings(value)
    }, retainKeys ? { retainKeys } : undefined)
  } catch {
    return null
  }
  return files
}

async function loadCacheFullFromDisk(cacheDir: string): Promise<ResultCache> {
  const empty = { version: CODEX_CACHE_VERSION, files: {} }
  const path = await resolveResultsPath(cacheDir)
  if (!path) return empty
  const files = await loadResultsStreaming(path, () => true)
  if (!files) return empty
  // Parity with the historical whole-file `as ResultCache` cast: entries are
  // stored unvalidated and every consumer reads them defensively.
  return { version: CODEX_CACHE_VERSION, files: files as Record<string, FileEntry> }
}

/// First pass of a range load: stream one call at a time (never an entry)
/// and decide each file's fate by the exact `retainCodexEntry` rule —
/// file-mtime first, then call timestamps. Returns the keys to assemble whole
/// in pass two. Any decode failure throws, and the caller falls back to the
/// single-pass load (same bytes-or-null contract as a torn file today).
export async function scanRetainedCodexKeys(path: string, rangeStartMs: number): Promise<Set<string>> {
  const retained = new Set<string>()
  type Scan = { mtimeMs: number | null; callsNonArray: boolean; keep: boolean; count: number }
  const scans = new Map<string, Scan>()
  await streamShardArrayField(path, 'calls', {
    onFileStart: key => {
      scans.set(key, { mtimeMs: null, callsNonArray: false, keep: false, count: 0 })
    },
    onField: (key, field, value) => {
      const scan = scans.get(key)!
      if (field === 'mtimeMs' && typeof value === 'number') scan.mtimeMs = value
      if (field === 'calls') scan.callsNonArray = true
    },
    onElement: (key, _index, value) => {
      const scan = scans.get(key)!
      scan.count++
      if (scan.keep) return
      // Mirrors retainCodexEntry call-for-call: any unjudgeable or in-range
      // call keeps the whole entry.
      if (!value || typeof value !== 'object') { scan.keep = true; return }
      const timestamp = (value as Record<string, unknown>)['timestamp']
      if (typeof timestamp !== 'string') { scan.keep = true; return }
      const ms = Date.parse(timestamp)
      if (Number.isNaN(ms) || ms >= rangeStartMs) scan.keep = true
    },
    onFileEnd: (key, _count, arraySeen) => {
      const scan = scans.get(key)!
      scans.delete(key)
      if (scan.mtimeMs !== null && scan.mtimeMs >= rangeStartMs) { retained.add(key); return }
      // Missing or non-array calls are unjudgeable: the full load carries
      // them, so the filtered load keeps them too.
      if (!arraySeen || scan.callsNonArray) { retained.add(key); return }
      if (scan.keep || scan.count === 0) { retained.add(key); return }
      // Old file, non-empty calls, every timestamp valid and pre-range: drop.
    },
  }, { rootField: 'files' })
  return retained
}
export async function loadCacheFilteredFromDisk(cacheDir: string, rangeStartMs: number): Promise<ResultCache> {
  const empty = { version: CODEX_CACHE_VERSION, files: {} }
  const path = await resolveResultsPath(cacheDir)
  if (!path) return empty
  // Two-pass: the timestamp scan assembles at most one call at a time, then
  // only retained files stream whole. Assembling-then-dropping would
  // materialize monster entries just to discard them.
  const before = await stat(path).catch(() => null)
  const beforeKey = before ? `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}` : null
  // fingerprint can vouch for afterwards (a null/null match below would pass).
  if (beforeKey === null) return empty
  let retained: Set<string>
  try {
    if ((await readResultsVersion(path)) !== CODEX_CACHE_VERSION) return empty
    retained = await scanRetainedCodexKeys(path, rangeStartMs)
  } catch {
    // Torn/unreadable: a miss, exactly as the whole-file decoder's throw.
    return empty
  }
  const fingerprintNow = async (): Promise<string | null> => {
    const st = await stat(path).catch(() => null)
    return st ? `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}` : null
  }
  // A concurrent publish between or during the passes would apply old
  // decisions to new bytes: verify the file is untouched before and after
  // the retained pass, else treat as a miss (bounded re-parse).
  if ((await fingerprintNow()) !== beforeKey) return empty
  if (retained.size === 0) return empty
  const files = await loadResultsStreaming(path, () => true, retained)
  if (!files) return empty
  if ((await fingerprintNow()) !== beforeKey) return empty
  return { version: CODEX_CACHE_VERSION, files: files as Record<string, FileEntry> }
}

/// Stream the nested `files` entries of a result file (see loadResultsStreaming).
/// `skipCalls` drops `calls` arrays at the token level, before assembly:
/// metadata consumers (project labels, fingerprints) never materialize call
/// lists, so one giant entry cannot blow discovery's heap. `retainKeys` drops
/// whole non-retained file subtrees before assembly: the second pass of a
/// range load materializes only files the timestamp scan kept. Both match
/// exact stacks below the `pick` re-root (`[filePath, 'calls']` and
/// `[filePath]`), so dotted paths can never misfire them.
async function streamCodexEntries(
  path: string,
  onEntry: (key: string, value: unknown) => void | Promise<void>,
  opts?: { skipCalls?: boolean; retainKeys?: Set<string> },
): Promise<void> {
  const sink = async function* (entries: AsyncIterable<{ key: string; value: unknown }>): AsyncGenerator<void> {
    for await (const entry of entries) {
      if (typeof entry?.key !== 'string') throw new Error(`codex results entry without key: ${path}`)
      await onEntry(entry.key, entry.value)
    }
  }
  if (opts?.skipCalls || opts?.retainKeys) {
    const retained = opts.retainKeys
    await pipeline(
      createReadStream(path),
      pick.withParserAsStream({ filter: 'files' }),
      ignore.asStream({
        filter: (stack: (string | number | null)[]) => {
          if (retained && stack.length === 1 && typeof stack[0] === 'string' && !retained.has(stack[0])) return true
          if (opts.skipCalls && stack.length === 2 && stack[1] === 'calls') return true
          return false
        },
      }),
      streamObject.asStream(),
      sink,
    )
    return
  }
  await pipeline(
    createReadStream(path),
    pick.withParserAsStream({ filter: 'files' }),
    streamObject.asStream(),
    sink,
  )
}

/// Entry metadata (project labels plus fingerprints) without `calls`, for
/// discovery: bounded heap no matter how large one entry's call list is.
export async function streamCodexEntryMetadata(
  path: string,
  onEntry: (key: string, value: unknown) => void | Promise<void>,
): Promise<void> {
  await streamCodexEntries(path, onEntry, { skipCalls: true })
}

/// Exact-or-resume lookup shared by snapshot and overlay entries: an exact
/// fingerprint match serves calls verbatim, while a grown same-inode file
/// resumes from its recorded boundary. Callers consult the overlay first
/// (fresh writes supersede snapshots under every projection).
async function hitFromEntry(
  entry: FileEntry | undefined,
  fp: FileFingerprint,
  filePath: string,
): Promise<CodexCacheHit | null> {
  if (entry && entry.mtimeMs === fp.mtimeMs && entry.sizeBytes === fp.sizeBytes) {
    return { kind: 'exact', calls: entry.calls }
  }
  if (
    entry
    && entry.dev === fp.dev
    && entry.ino === fp.ino
    && entry.resumeOffset !== undefined
    && entry.resumeState !== undefined
    && entry.resumeCallCount !== undefined
    && fp.sizeBytes > entry.sizeBytes
    && entry.resumeOffset <= fp.sizeBytes
    && await endsLineAt(filePath, entry.resumeOffset)
  ) {
    return { kind: 'resume', calls: entry.calls, offset: entry.resumeOffset, state: entry.resumeState, callCount: entry.resumeCallCount }
  }
  return null
}

function readOverlayEntry(cacheDir: string, filePath: string): FileEntry | undefined {
  return codexOverlay.get(cacheDir)?.get(filePath)
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

export async function readCachedCodexResults(
  filePath: string,
  opts?: { rangeStartMs?: number },
): Promise<CodexCacheHit | null> {
  try {
    const s = await stat(filePath)
    const cacheDir = currentCacheDir()
    const fp = { dev: s.dev, ino: s.ino, mtimeMs: s.mtimeMs, sizeBytes: s.size }
    // Fresh writes supersede snapshots under every projection: a fresh full
    // record is servable for any range (downstream slices to the query).
    const overlaid = readOverlayEntry(cacheDir, filePath)
    if (overlaid) {
      const hit = await hitFromEntry(overlaid, fp, filePath)
      if (hit) return hit
    }
    // Rollouts are append-only: the same inode, grown past a boundary we
    // recorded, can be picked up from that boundary instead of re-read whole.
    const cache = await loadCache(cacheDir, opts?.rangeStartMs)
    return hitFromEntry(cache.files[filePath], fp, filePath)
  } catch {}
  return null
}

/// Project labels for discovery without loading the calls map. The index
/// carries only names plus fingerprints (megabytes, not hundreds of them);
/// label misses fall back to parsing the file, exactly as a cache miss does.
async function loadProjectIndex(cacheDir: string): Promise<Map<string, ProjectIndexRow>> {
  const versioned = getCachePath(cacheDir)
  const legacy = getLegacyCachePath(cacheDir)
  const versionedStat = await stat(versioned).catch(() => null)
  const source = versionedStat
    ? { path: versioned, mtimeMs: versionedStat.mtimeMs }
    : await stat(legacy).then(
      s => ({ path: legacy, mtimeMs: s.mtimeMs }),
      () => null,
    )
  const cur = projectIndexes.get(cacheDir)
  if (cur && source && source.mtimeMs === cur.builtForMtimeMs) return cur.rows
  const buildKey = `${cacheDir}\0${source?.mtimeMs ?? -1}`
  const inflight = indexBuilds.get(buildKey)
  if (inflight) return inflight
  const build = buildProjectIndex(cacheDir, source).finally(() => {
    if (indexBuilds.get(buildKey) === build) indexBuilds.delete(buildKey)
  })
  indexBuilds.set(buildKey, build)
  return build
}

async function buildProjectIndex(
  cacheDir: string,
  source: { path: string; mtimeMs: number } | null,
): Promise<Map<string, ProjectIndexRow>> {
  const rows = new Map<string, ProjectIndexRow>()
  if (source && (await readResultsVersion(source.path)) === CODEX_CACHE_VERSION) {
    try {
      await streamCodexEntryMetadata(source.path, (key, value) => {
        if (!value || typeof value !== 'object') return
        // Detach both from the tokenizer's buffers (index rows outlive the
        // stream by the life of the process).
        const row: ProjectIndexRow = {
          project: 'project' in value && typeof value.project === 'string' ? flatString(value.project) : '',
        }
        if ('dev' in value && typeof value.dev === 'number') row.dev = value.dev
        if ('ino' in value && typeof value.ino === 'number') row.ino = value.ino
        if ('mtimeMs' in value && typeof value.mtimeMs === 'number') row.mtimeMs = value.mtimeMs
        if ('sizeBytes' in value && typeof value.sizeBytes === 'number') row.sizeBytes = value.sizeBytes
        rows.set(flatString(key), row)
      })
    } catch {
      // Torn/unreadable mid-build: serve the partial rows; misses fall back
      // to parsing the file, and the next file change rebuilds cleanly.
    }
  }
  projectIndexes.set(cacheDir, { builtForMtimeMs: source?.mtimeMs ?? -1, rows })
  return rows
}

export async function getCachedCodexProject(
  filePath: string,
): Promise<string | null> {
  try {
    const s = await stat(filePath)
    const rows = await loadProjectIndex(currentCacheDir())
    const row = rows.get(filePath)
    // Same freshness contract the full-map lookup enforced: only an
    // mtime/size-matching label is served, otherwise discovery re-parses.
    if (row && row.mtimeMs === s.mtimeMs && row.sizeBytes === s.size) {
      return row.project || null
    }
    return null
  } catch {}
  return null
}

export async function fingerprintFile(
  filePath: string,
): Promise<FileFingerprint | null> {
  try {
    const s = await stat(filePath)
    return { dev: s.dev, ino: s.ino, mtimeMs: s.mtimeMs, sizeBytes: s.size }
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
    const cacheDir = currentCacheDir()
    // Overlay only: snapshots stay immutable so concurrent ranges never mix.
    // A fresh full record is servable under every projection, and the flush
    // merges it over the published bytes (never a whole rewrite from memory).
    const entry: FileEntry = {
      dev: fingerprint.dev,
      ino: fingerprint.ino,
      mtimeMs: fingerprint.mtimeMs,
      sizeBytes: fingerprint.sizeBytes,
      project,
      calls,
      ...(resume ? { resumeOffset: resume.offset, resumeState: resume.state, resumeCallCount: resume.callCount } : {}),
    }
    let overlay = codexOverlay.get(cacheDir)
    if (!overlay) {
      overlay = new Map()
      codexOverlay.set(cacheDir, overlay)
    }
    overlay.set(filePath, entry)
    // Keep the project index warm so discovery labels never trigger a rescan.
    const idx = projectIndexes.get(cacheDir)
    if (idx) {
      idx.rows.set(filePath, {
        project,
        dev: fingerprint.dev,
        ino: fingerprint.ino,
        mtimeMs: fingerprint.mtimeMs,
        sizeBytes: fingerprint.sizeBytes,
      })
    }
  } catch {}
}

/// Merge dirty overlay entries over the published result file, streaming so
/// peak heap tracks one record rather than the file. Every touched path is
/// stat-checked inline: missing files drop (eviction parity with the
/// historical whole-map sweep, which also statted every known path), dirty
/// entries substitute, everything else is carried verbatim. Returns the
/// evicted paths so callers can prune indexes and snapshots.
async function mergeCodexResults(
  publishedPath: string,
  finalPath: string,
  dirty: Map<string, FileEntry>,
): Promise<Set<string>> {
  const evicted = new Set<string>()
  const tempPath = `${finalPath}.${randomBytes(8).toString('hex')}.tmp`
  const handle = await open(tempPath, 'w', 0o600)
  const fail = async (err: unknown): Promise<never> => {
    try { await handle.close() } catch {}
    await unlink(tempPath).catch(() => null)
    throw err
  }
  const pathAlive = async (path: string): Promise<boolean> => {
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  }
  try {
    await writeChunk(handle, `{"version":${CODEX_CACHE_VERSION},"files":{`)
    let first = true
    const emitPair = async (key: string, value: unknown): Promise<void> => {
      await writeChunk(handle, `${first ? '' : ','}${JSON.stringify(key)}:${JSON.stringify(value)}`)
      first = false
    }
    await streamCodexEntries(publishedPath, async (key, value) => {
      if (!(await pathAlive(key))) {
        evicted.add(key)
        return
      }
      const overwrite = dirty.get(key)
      if (overwrite !== undefined) {
        dirty.delete(key)
        await emitPair(key, overwrite)
        return
      }
      await emitPair(key, value)
    })
    for (const [key, file] of dirty) {
      if (!(await pathAlive(key))) {
        evicted.add(key)
        continue
      }
      await emitPair(key, file)
    }
    await writeChunk(handle, '}}')
    await handle.sync()
    await handle.close()
  } catch (err) {
    await fail(err)
  }
  try {
    await rename(tempPath, finalPath)
  } catch (err) {
    try { await unlink(tempPath) } catch {}
    throw err
  }
  return evicted
}

export async function flushCodexCache(): Promise<void> {
  const cacheDir = currentCacheDir()
  return withFlushMutex(cacheDir, () => flushCodexCacheInner(cacheDir))
}

// Test barrier (see the overlapping-flush test): flushes invoke this after
// detaching, before any publish I/O, so tests can stage concurrent writes
// deterministically. Never set outside tests.
let afterDetachForTests: (() => Promise<void>) | null = null
export function __setAfterDetachForTests(gate: (() => Promise<void>) | null): void {
  afterDetachForTests = gate
}

async function flushCodexCacheInner(cacheDir: string): Promise<void> {
  // Detach the overlay up front so concurrent writes during the awaits below
  // land in a fresh map instead of being dropped with the flushed one.
  const detached = codexOverlay.get(cacheDir)
  codexOverlay.delete(cacheDir)
  if (afterDetachForTests) await afterDetachForTests()
  const restoreDetached = (): void => {
    if (!detached) return
    let current = codexOverlay.get(cacheDir)
    if (!current) {
      codexOverlay.set(cacheDir, detached)
      return
    }
    for (const [p, e] of detached) if (!current.has(p)) current.set(p, e)
  }
  try {
    const dirty = new Map<string, FileEntry>()
    if (detached) for (const [p, e] of detached) dirty.set(p, e)
    // Nothing changed: keep bytes (and mtime) stable instead of rewriting
    // identically. Unlike the historical unconditional rewrite this also
    // keeps the project index valid across clean flushes.
    if (dirty.size === 0) return
    if (!existsSync(cacheDir)) await mkdir(cacheDir, { recursive: true })
    const finalPath = getCachePath(cacheDir)
    // Merge base: versioned, else legacy (adoption mirrors the load path).
    const base = await resolveResultsPath(cacheDir)
    const baseVersion = base ? await readResultsVersion(base) : null
    let evicted = new Set<string>()
    if (baseVersion !== CODEX_CACHE_VERSION) {
      // No usable authority (fresh machine or foreign version): publish the
      // overlay alone, evicting dead dirties first. This adopts forward
      // exactly like the historical whole-write did.
      for (const p of [...dirty.keys()]) {
        try {
          await stat(p)
        } catch {
          evicted.add(p)
          dirty.delete(p)
        }
      }
      if (dirty.size === 0) return
      const tempPath = `${finalPath}.${randomBytes(8).toString('hex')}.tmp`
      const handle = await open(tempPath, 'w', 0o600)
      try {
        await writeChunk(handle, `{"version":${CODEX_CACHE_VERSION},"files":{`)
        let first = true
        for (const [p, e] of dirty) {
          await writeChunk(handle, `${first ? '' : ','}${JSON.stringify(p)}:${JSON.stringify(e)}`)
          first = false
        }
        await writeChunk(handle, '}}')
        await handle.sync()
        await handle.close()
      } catch (err) {
        try { await handle.close() } catch {}
        await unlink(tempPath).catch(() => null)
        throw err
      }
      try {
        await rename(tempPath, finalPath)
      } catch (err) {
        try { await unlink(tempPath) } catch {}
        throw err
      }
    } else if (base) {
      evicted = await mergeCodexResults(base, finalPath, dirty)
    }
    // Published bytes changed: bump the store generation FIRST so concurrent
    // loads discard (never memoize) pre-flush decodes, then drop resident
    // snapshots for this directory (they carry no file-mtime validation, so
    // a kept snapshot would serve superseded entries indefinitely). Later
    // lookups re-stream once per snapshot identity. (A failed publish
    // restores the detached entries below and keeps snapshots.)
    flushGenerations.set(cacheDir, (flushGenerations.get(cacheDir) ?? 0) + 1)
    for (const key of memCaches.keys()) {
      if (key.startsWith(`${cacheDir}\0`)) memCaches.delete(key)
    }
    // Refresh the project index bookkeeping (rows already current via writes).
    const st = await stat(finalPath).catch(() => null)
    const idx = projectIndexes.get(cacheDir)
    if (idx && st) {
      idx.builtForMtimeMs = st.mtimeMs
      for (const p of evicted) idx.rows.delete(p)
    }
    // Published: the detached entries now live on disk (or were evicted as
    // dead) and stay released — disk is authoritative, and later lookups
    // re-stream once per snapshot identity. Only a failed publish restores
    // the detached entries for retry.
  } catch {
    restoreDetached()
  }
}
