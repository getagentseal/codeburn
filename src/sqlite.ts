import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { getCodeburnCacheDir } from './cache-dir.js'

/// Thin SQLite read-only wrapper over Node's built-in `node:sqlite` module (stable in
/// Node 24, experimental in Node 22 / 23). Replaces the earlier `better-sqlite3` binding
/// so the dependency graph no longer pulls in the deprecated `prebuild-install` package
/// (issue #75). Works across Cursor and OpenCode session DBs, both of which we only read.

const requireForSqlite = createRequire(import.meta.url)

type Row = Record<string, unknown>

export type SqliteDatabase = {
  query<T extends Row = Row>(sql: string, params?: unknown[]): T[]
  close(): void
}

type DatabaseSyncInstance = {
  prepare(sql: string): { all(...params: unknown[]): Row[] }
  exec?(sql: string): void
  close(): void
}

type DatabaseSyncCtor = new (path: string, options?: { readOnly?: boolean }) => DatabaseSyncInstance

let DatabaseSync: DatabaseSyncCtor | null = null
let loadAttempted = false
let loadError: string | null = null

const textDecoder = new TextDecoder('utf-8', { fatal: false })

/// Safely decode a BLOB column (Uint8Array) to a UTF-8 string. Node's
/// node:sqlite crashes with a V8 CHECK abort when a TEXT column contains
/// invalid UTF-8 (common in Cursor chat blobs with truncated multi-byte
/// chars). By selecting those columns as `CAST(... AS BLOB)` in SQL, we
/// get a Uint8Array here and decode it in JS where bad bytes become the
/// U+FFFD replacement character instead of aborting the process.
export function blobToText(value: Uint8Array | string | null | undefined): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  return textDecoder.decode(value)
}

/// Lazily imports `node:sqlite`. On Node 22/23 it emits an ExperimentalWarning the first
/// time the module is loaded; we silence that specific warning once so dashboards aren't
/// preceded by a scary stderr line every run. Any other warnings (including future
/// non-SQLite ones) are left untouched.
function loadDriver(): boolean {
  if (loadAttempted) return DatabaseSync !== null
  loadAttempted = true

  const origEmit = process.emit.bind(process)
  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    process.emit = origEmit
  }

  // Node's `process.emit` signature is overloaded; we intercept the 'warning' channel
  // only and proxy everything else through unchanged. The `any` cast avoids chasing the
  // overload union which isn't worth its verbosity for a single-purpose shim.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.emit = function patchedEmit(this: NodeJS.Process, event: string, ...args: any[]): boolean {
    if (event === 'warning') {
      const warning = args[0] as { name?: string; message?: string } | undefined
      if (
        warning?.name === 'ExperimentalWarning' &&
        typeof warning.message === 'string' &&
        /SQLite/i.test(warning.message)
      ) {
        return false
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (origEmit as any).call(this, event, ...args)
  } as typeof process.emit

  try {
    const mod = requireForSqlite('node:sqlite') as { DatabaseSync: DatabaseSyncCtor }
    DatabaseSync = mod.DatabaseSync
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    loadError =
      'SQLite-based providers (Cursor, OpenCode) need Node 22+ with the node:sqlite module.\n' +
      `Current Node: ${process.version}.\n` +
      'Upgrade Node (https://nodejs.org) and run codeburn again.\n' +
      `(underlying error: ${message})`
    return false
  } finally {
    process.nextTick(restore)
  }
}

export function isSqliteAvailable(): boolean {
  return loadDriver()
}

export function getSqliteLoadError(): string {
  return loadError ?? 'SQLite driver not available'
}

export function isSqliteBusyError(err: unknown): boolean {
  const e = err as { code?: unknown; errcode?: unknown; errstr?: unknown; message?: unknown } | null
  const code = typeof e?.code === 'string' ? e.code : ''
  const errcode = typeof e?.errcode === 'number' ? e.errcode : null
  const message = [
    typeof e?.message === 'string' ? e.message : '',
    typeof e?.errstr === 'string' ? e.errstr : '',
  ].join(' ')

  return (
    errcode === 5 ||
    errcode === 6 ||
    code === 'SQLITE_BUSY' ||
    code === 'SQLITE_LOCKED' ||
    /\bSQLITE_(BUSY|LOCKED)\b|database (?:is |table is )?locked/i.test(message)
  )
}

/// SQLite reports SQLITE_READONLY_DIRECTORY as ERR_SQLITE_ERROR with an extended
/// result code on the Node 22 builds CodeBurn supports. Keep the base-code check
/// so this also covers SQLITE_READONLY and its other extended variants, while
/// leaving ENOENT/SQLITE_CANTOPEN distinguishable to callers.
export function isSqliteReadonlyError(err: unknown): boolean {
  const e = err as { code?: unknown; errcode?: unknown; errstr?: unknown; message?: unknown } | null
  const code = typeof e?.code === 'string' ? e.code : ''
  const errcode = typeof e?.errcode === 'number' ? e.errcode : null
  const message = [
    typeof e?.message === 'string' ? e.message : '',
    typeof e?.errstr === 'string' ? e.errstr : '',
  ].join(' ')

  return (
    (errcode !== null && (errcode & 0xff) === 8) ||
    /SQLITE_READONLY|attempt to write a readonly database|readonly database|read-only database/i.test(`${code} ${message}`)
  )
}

/// A read-only parent reports SQLITE_READONLY_DIRECTORY when it must create the
/// sidecars from scratch, but SQLITE_CANTOPEN when a `-wal` is present and the
/// `-shm` it needs to index it is not. openReadonlyCache re-throws the original
/// error when the database itself is missing, which is the other CANTOPEN.
function isSqliteSidecarError(err: unknown): boolean {
  if (isSqliteReadonlyError(err)) return true
  const errcode = (err as { errcode?: unknown } | null)?.errcode
  return typeof errcode === 'number' && (errcode & 0xff) === 14
}

let uriFilenamesSupported: boolean | null = null

/// node:sqlite only enables SQLITE_OPEN_URI from Node 22.15 on (measured: 22.13
/// and 22.14 fail, 22.15 and later work). Below that a `file:...` location is
/// taken literally and fails as CANTOPEN, so the immutable open is not attempted
/// there. The probe is an in-memory URI rather than a version comparison: it
/// answers the question directly and touches no filesystem either way.
export function sqliteSupportsUriFilenames(): boolean {
  if (uriFilenamesSupported !== null) return uriFilenamesSupported
  uriFilenamesSupported = false
  const Driver = loadDriver() ? DatabaseSync : null
  if (Driver !== null) {
    try {
      new Driver('file:codeburn-uri-probe?mode=memory', { readOnly: true }).close()
      uriFilenamesSupported = true
    } catch {
      // An older build: locations are plain paths, and the copy fallback covers
      // exactly the case the immutable open would have.
    }
  }
  return uriFilenamesSupported
}

type DatabaseFingerprint = {
  dev: number
  ino: number
  mtimeMs: number
  sizeBytes: number
  walBytes: number
}

/// A superseded copy is dropped once it has gone this long without being used.
/// The delay is what keeps a concurrent reader of the previous copy from having
/// its file yanked out from under it.
const CACHE_ENTRY_MAX_AGE_MS = 24 * 60 * 60 * 1000
const warnedDatabases = new Set<string>()

/// One notice per source path per run: a provider may discover many sessions
/// from the same database, and the first notice already says what happened.
function warnSqliteOnce(path: string, message: string): void {
  if (warnedDatabases.has(path)) return
  warnedDatabases.add(path)
  process.stderr.write(message)
}

/// A read-only SQLite connection can still need sidecar files.
export function warnSqliteReadonlyOnce(path: string): void {
  warnSqliteOnce(
    path,
    `codeburn: SQLite database ${path} is in a read-only directory and needs sidecar files; using a cache copy when necessary. ` +
    'The original database is not modified.\n',
  )
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined
  const code = err.code
  return typeof code === 'string' ? code : undefined
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/// This deliberately mirrors fingerprintSqliteFile/fingerprintFile in
/// session-cache.ts. openDatabase is synchronous, so the fallback uses the
/// synchronous fs APIs only after the direct open has already failed; the
/// ordinary successful open remains probe-free.
function fingerprintDatabase(path: string): DatabaseFingerprint {
  const main = statSync(path)
  let wal: ReturnType<typeof statSync> | null = null
  try {
    wal = statSync(path + '-wal')
  } catch (err) {
    if (errorCode(err) !== 'ENOENT') throw err
  }
  return {
    dev: main.dev,
    ino: main.ino,
    mtimeMs: wal ? Math.max(main.mtimeMs, wal.mtimeMs) : main.mtimeMs,
    sizeBytes: main.size + (wal?.size ?? 0),
    walBytes: wal?.size ?? 0,
  }
}

function sameFingerprint(a: DatabaseFingerprint, b: DatabaseFingerprint): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mtimeMs === b.mtimeMs &&
    a.sizeBytes === b.sizeBytes &&
    a.walBytes === b.walBytes
  )
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Already gone, or still held open by another CodeBurn on Windows. Either
    // way the next run's eviction pass gets another chance at it.
  }
}

function copyOptionalFile(sourcePath: string, destinationPath: string): boolean {
  try {
    copyFileSync(sourcePath, destinationPath)
    return true
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return false
    throw err
  }
}

function sourceKeyOf(sourcePath: string): string {
  return createHash('sha256').update(sourcePath, 'utf8').digest('hex').slice(0, 32)
}

/// The copy is named after the source it came from AND the fingerprint it was
/// taken at, so a refresh publishes a new file rather than overwriting one that
/// another process may still have open.
function cacheEntryName(sourceKey: string, fingerprint: DatabaseFingerprint): string {
  const parts = `${fingerprint.dev}:${fingerprint.ino}:${fingerprint.mtimeMs}:${fingerprint.sizeBytes}:${fingerprint.walBytes}`
  return `${sourceKey}.${createHash('sha256').update(parts).digest('hex').slice(0, 16)}.db`
}

function dropCopy(cacheDir: string, name: string): void {
  unlinkQuietly(join(cacheDir, name))
  unlinkQuietly(join(cacheDir, name + '-wal'))
  unlinkQuietly(join(cacheDir, name + '-shm'))
}

/// Superseded copies are cleaned up here rather than by overwriting them: keep
/// the one in use plus at most one predecessor, and drop anything untouched for
/// a day, which is also what a source path that no longer exists looks like.
/// Reuse touches the copy, so its mtime is last-use rather than copy time.
function evictSupersededCopies(cacheDir: string, sourceKey: string, keepName: string): void {
  let names: string[]
  try {
    names = readdirSync(cacheDir)
  } catch {
    return
  }
  const now = Date.now()
  const superseded: { name: string, mtimeMs: number }[] = []
  for (const name of names) {
    if (!name.endsWith('.db') || name === keepName) continue
    let mtimeMs: number
    try {
      mtimeMs = statSync(join(cacheDir, name)).mtimeMs
    } catch {
      continue
    }
    if (name.startsWith(`${sourceKey}.`)) superseded.push({ name, mtimeMs })
    else if (now - mtimeMs > CACHE_ENTRY_MAX_AGE_MS) dropCopy(cacheDir, name)
  }
  superseded.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const [index, entry] of superseded.entries()) {
    if (index > 0 || now - entry.mtimeMs > CACHE_ENTRY_MAX_AGE_MS) dropCopy(cacheDir, entry.name)
  }
}

/// A concurrent CodeBurn may have published the same copy first. The name is
/// the fingerprint, so the content is identical by construction and losing that
/// race is not an error.
function publish(tempPath: string, finalPath: string): void {
  try {
    renameSync(tempPath, finalPath)
  } catch (err) {
    if (!existsSync(finalPath)) throw err
  }
}

function readOnlyCachePath(sourcePath: string, fingerprint: DatabaseFingerprint): string {
  const cacheDir = join(getCodeburnCacheDir(), 'sqlite-ro')
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 })

  const sourceKey = sourceKeyOf(sourcePath)
  const name = cacheEntryName(sourceKey, fingerprint)
  const cachePath = join(cacheDir, name)
  if (existsSync(cachePath)) {
    const now = new Date()
    try {
      utimesSync(cachePath, now, now)
    } catch {
      // mtime is only the eviction clock; a copy we cannot touch still reads.
    }
    evictSupersededCopies(cacheDir, sourceKey, name)
    return cachePath
  }

  const tempBase = `${cachePath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
  const tempWal = tempBase + '-wal'
  try {
    copyFileSync(sourcePath, tempBase)
    const copiedWal = copyOptionalFile(sourcePath + '-wal', tempWal)

    // Do not publish a cache made from a moving database. A live WAL writer will
    // normally make the direct open succeed once its sidecars exist; this check
    // covers the narrow race where the source changes during the copy fallback.
    if (!sameFingerprint(fingerprintDatabase(sourcePath), fingerprint)) {
      throw new Error('SQLite database changed while preparing its read-only cache copy')
    }

    // The -wal goes first: a reader that can see the database must never find it
    // without the sidecar holding its most recent rows.
    if (copiedWal) publish(tempWal, cachePath + '-wal')
    publish(tempBase, cachePath)
    evictSupersededCopies(cacheDir, sourceKey, name)
    return cachePath
  } finally {
    unlinkQuietly(tempBase)
    unlinkQuietly(tempWal)
  }
}

function openReadonlyCache(path: string, originalError: unknown): DatabaseSyncInstance {
  const Driver = DatabaseSync
  if (Driver === null) throw new Error(getSqliteLoadError())

  let fingerprint: DatabaseFingerprint
  try {
    fingerprint = fingerprintDatabase(path)
  } catch {
    // Preserve the original SQLite error when the source disappeared or became
    // inaccessible between the failed query and the fallback probe.
    throw originalError
  }

  // An absent or empty -wal holds no frames, so there is nothing to go stale and
  // nothing worth copying: immutable lets SQLite skip the -shm it cannot create
  // and read the source in place.
  if (fingerprint.walBytes === 0 && sqliteSupportsUriFilenames()) {
    try {
      return new Driver(`${pathToFileURL(path).href}?immutable=1`, { readOnly: true })
    } catch {
      // Understood but refused: the copy covers it.
    }
  }

  let cachedPath: string
  try {
    cachedPath = readOnlyCachePath(path, fingerprint)
  } catch (err) {
    warnSqliteOnce(
      path,
      `codeburn: SQLite database ${path} is in a read-only directory and its cache copy could not be written ` +
      `(${describeError(err)}); skipping this database.\n`,
    )
    throw originalError
  }
  return new Driver(cachedPath, { readOnly: true })
}

/// macOS keeps `~/Library/Group Containers` behind Full Disk Access. When the
/// process running codeburn has no consent and cannot show the prompt, open()
/// on a database in there never returns: the whole run wedges before printing
/// anything, and so does the resident `serve` child. fs.accessSync/openSync
/// block the same way, so the only safe probe is a child we can kill.
const GROUP_CONTAINERS_PREFIX = join(homedir(), 'Library', 'Group Containers') + sep
const TCC_PROBE = "try{require('node:fs').closeSync(require('node:fs').openSync(process.argv[1],'r'))}catch(e){process.exit(e.code==='ENOENT'?2:1)}"
const TCC_PROBE_TIMEOUT_MS = 3000
/// Short enough that granting access recovers on the next `serve` refresh,
/// long enough that a resident process does not fork per request.
const TCC_PROBE_CACHE_MS = 60_000

const tccProbeCache = new Map<string, { blocked: boolean; at: number }>()
let warnedTccBlocked = false

export function isBlockedDatabaseError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'codeburnBlocked' in err
}

/// `script` and `execPath` are only ever overridden by tests, which cannot make
/// a real open() hang on demand nor break the spawn itself.
export function probeDatabaseBlocked(path: string, script = TCC_PROBE, execPath = process.execPath): boolean {
  const now = Date.now()
  const key = `${script}\u0000${path}`
  const cached = tccProbeCache.get(key)
  if (cached && now - cached.at < TCC_PROBE_CACHE_MS) return cached.blocked

  const probe = spawnSync(execPath, ['-e', script, path], {
    timeout: TCC_PROBE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    stdio: 'ignore',
    // process.execPath is Electron's binary in the desktop app; without this it
    // would launch a second app window instead of running the script.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  // 0 readable, 2 missing (let the real open report that); the timeout kill and
  // any other exit mean we must not touch this file. A probe we could not run
  // at all says nothing about the file, so it must not block it.
  const blocked = probe.signal === 'SIGKILL' || (!probe.error && probe.status !== 0 && probe.status !== 2)
  tccProbeCache.set(key, { blocked, at: now })
  return blocked
}

/// True for a Group Container path this process must not open: kqueue-backed
/// fs.watch hangs on it exactly like DatabaseSync does.
export function isPathBlocked(path: string, script = TCC_PROBE): boolean {
  return path.startsWith(GROUP_CONTAINERS_PREFIX) && probeDatabaseBlocked(path, script)
}

export function assertDatabaseReadable(path: string, script = TCC_PROBE): void {
  if (!isPathBlocked(path, script)) return

  if (!warnedTccBlocked) {
    warnedTccBlocked = true
    process.stderr.write(
      "codeburn: skipped warp: macOS blocked access to Warp's database; grant Full Disk Access to the app " +
      'running codeburn (System Settings > Privacy & Security) and retry\n',
    )
  }
  throw Object.assign(new Error(`macOS blocked access to ${path}`), { codeburnBlocked: true })
}

export function openDatabase(path: string): SqliteDatabase {
  if (!loadDriver() || DatabaseSync === null) {
    throw new Error(getSqliteLoadError())
  }
  assertDatabaseReadable(path)

  let db: DatabaseSyncInstance
  let fallbackUsed = false
  try {
    db = new DatabaseSync(path, { readOnly: true })
  } catch (err) {
    if (!isSqliteSidecarError(err)) throw err
    fallbackUsed = true
    db = openReadonlyCache(path, err)
    warnSqliteReadonlyOnce(path)
  }
  try {
    db.exec?.('PRAGMA busy_timeout = 1000')
  } catch {
    // Best effort. Some Node sqlite builds may not expose exec on DatabaseSync.
  }

  return {
    query<T extends Row = Row>(sql: string, params: unknown[] = []): T[] {
      try {
        return db.prepare(sql).all(...params) as T[]
      } catch (err) {
        if (!isSqliteSidecarError(err)) throw err
        if (fallbackUsed) throw err
        fallbackUsed = true
        try {
          db.close()
        } catch {
          // The failed connection may already have been closed by node:sqlite.
        }
        db = openReadonlyCache(path, err)
        warnSqliteReadonlyOnce(path)
        try {
          db.exec?.('PRAGMA busy_timeout = 1000')
        } catch {
          // Best effort, matching the direct-open path above.
        }
        return db.prepare(sql).all(...params) as T[]
      }
    },
    close() {
      db.close()
    },
  }
}
