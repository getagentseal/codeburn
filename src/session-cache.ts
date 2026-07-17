import { readFile, stat, open, rename, unlink, readdir, mkdir } from 'fs/promises'
import { existsSync, readFileSync, unlinkSync } from 'fs'
import { createHash, randomBytes } from 'crypto'
import { join } from 'path'
import { homedir } from 'os'

import type { ToolCall } from './types.js'

// ── Types ──────────────────────────────────────────────────────────────

export type CachedUsage = {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  webSearchRequests: number
  cacheCreationOneHourTokens: number
}

export type CachedCall = {
  provider: string
  model: string
  usage: CachedUsage
  costUSD?: number
  /// True when `costUSD` (or the tokens it is priced from) is estimated rather
  /// than metered. Persisted so the estimated-cost marker survives the cache.
  isEstimated?: boolean
  speed: 'standard' | 'fast'
  timestamp: string
  tools: string[]
  bashCommands: string[]
  skills: string[]
  subagentTypes: string[]
  deduplicationKey: string
  project?: string
  projectPath?: string
  toolSequence?: ToolCall[][]
}

export type CachedTurn = {
  timestamp: string
  sessionId: string
  userMessage: string
  calls: CachedCall[]
}

export type FileFingerprint = {
  dev: number
  ino: number
  mtimeMs: number
  sizeBytes: number
}

export type CachedFile = {
  fingerprint: FileFingerprint
  lastCompleteLineOffset?: number
  canonicalCwd?: string
  canonicalProjectName?: string
  mcpInventory: string[]
  turns: CachedTurn[]
  // Claude Code only: for a subagent transcript (`subagents/.../agent-*.jsonl`),
  // the `agentType` from its sibling `.meta.json` (e.g. `workflow-subagent`,
  // `Explore`, `general-purpose`). Drives the Claude-scoped agent-type breakdown.
  agentType?: string
  // Negative-result marker: this file threw while parsing at the recorded
  // fingerprint. Cached so we don't re-read + re-throw it on every refresh; it
  // is re-parsed only when the file changes (fingerprint differs). Carries no
  // turns, so it contributes no usage. (issue #441 follow-up)
  failed?: boolean
}

export type ProviderSection = {
  envFingerprint: string
  files: Record<string, CachedFile>
  /** True when the provider's cache entries survive source-file eviction. */
  durable?: boolean
}

export type SessionCache = {
  version: number
  providers: Record<string, ProviderSection>
  /** True only once a full scan has run to completion. The throttled partial
   *  saves during a cold hydration persist `false`; the single end-of-parse save
   *  flips it `true`. A cache that is present-but-incomplete (an interrupted cold
   *  start left a partial behind) must be treated as still cold — otherwise the
   *  emptiness heuristic reads the partial as warm, the cross-process hydration
   *  lock never engages, and totals heal only gradually while a concurrent parse
   *  can freeze a partial daily history. Absent on caches written before this
   *  field existed → read as incomplete (one self-healing re-hydration). */
  complete?: boolean
}

// ── Constants ──────────────────────────────────────────────────────────

// v5: kiro joined the costUSD pass-through allowlist (credit-based pricing).
// Cached kiro entries from v4 carry costUSD: undefined and would keep being
// re-priced from estimated tokens forever, since historical session files
// never change. Bump forces a one-time re-parse so metered credit costs land.
export const CACHE_VERSION = 5

// The cache filename is version-suffixed so different binaries (e.g. an old
// launchd menubar on a prior release and a newer desktop app) each own a
// distinct file and can never clobber each other's incompatible schema. Bumping
// CACHE_VERSION automatically mints a fresh filename, superseding the migration
// dance the legacy unversioned file used to need.
const CACHE_FILE = `session-cache.v${CACHE_VERSION}.json`
// The pre-versioning filename. Never written or deleted anymore — old binaries
// still own it. On first load we adopt-copy it once (see loadCache) when the
// versioned file is absent and the legacy file's version matches ours.
const LEGACY_CACHE_FILE = 'session-cache.json'
const TEMP_FILE_MAX_AGE_MS = 5 * 60 * 1000

export const PROVIDER_ENV_VARS: Record<string, string[]> = {
  claude: ['CLAUDE_CONFIG_DIRS', 'CLAUDE_CONFIG_DIR'],
  codewhale: ['CODEWHALE_HOME'],
  codex: ['CODEX_HOME'],
  hermes: ['HERMES_HOME'],
  'lingtai-tui': ['LINGTAI_HOME', 'LINGTAI_TUI_HOME', 'LINGTAI_TUI_GLOBAL_DIR'],
  droid: ['FACTORY_DIR'],
  cursor: ['XDG_DATA_HOME'],
  'cursor-agent': ['XDG_DATA_HOME'],
  opencode: ['XDG_DATA_HOME', 'OPENCODE_DATA_DIR', 'OPENCODE_DB_PREFIX'],
  goose: ['XDG_DATA_HOME'],
  crush: ['XDG_DATA_HOME'],
  warp: ['WARP_DB_PATH'],
  antigravity: ['CODEBURN_CACHE_DIR'],
  qwen: ['QWEN_DATA_DIR'],
  'ibm-bob': ['XDG_CONFIG_HOME'],
}

// Names of providers whose cache entries are never evicted when source files
// disappear — they are preserved so month-to-date totals never drop.
export const DURABLE_PROVIDER_NAMES: ReadonlySet<string> = new Set(['copilot'])

// Estimated-cost surfacing (#639): providers that set `costIsEstimated` carry a
// `-est-cost` suffix (or a new entry) so their already-cached sessions reparse
// once and the flag lands, instead of silently reading as measured. Copilot
// needs no suffix: the cli-shutdown-cost-v1 bump below already forces its one
// re-parse, which lands the flag too, and durable orphans now survive
// fingerprint changes (the carry-forward in getOrCreateProviderSection).
export const PROVIDER_PARSE_VERSIONS: Record<string, string> = {
  claude: 'advisor-usage-v1',
  cline: 'worktree-project-grouping-v1',
  codewhale: 'aggregate-session-v1-est-cost',
  // Bump when the Codex parser changes attribution so unchanged, already-cached
  // session files re-parse (session-cache.json serves them without invoking the
  // provider parser otherwise). Covers native mcp_tool_call_end (#513) and
  // CLI-wrapped `mcp-cli call` (#478) MCP attribution.
  codex: 'mcp-attribution-v2-est-cost',
  cursor: 'composer-anchored-crediting-v1-est-cost',
  'cursor-agent': 'workspaceless-transcript-v1',
  copilot: 'cli-shutdown-cost-v1-skills',
  grok: 'estimated-cost-v1',
  hermes: 'reasoning-output-accounting-v1-est-cost',
  'lingtai-tui': 'token-ledger-registry-activity-v3',
  'ibm-bob': 'worktree-project-grouping-v1',
  kiro: 'ide-parsing-v1-est-cost',
  'kilo-code': 'worktree-project-grouping-v1',
  'roo-code': 'worktree-project-grouping-v1',
  warp: 'worktree-project-grouping-v1-est-cost',
  antigravity: 'worktree-project-grouping-v5',
}

// ── Cache Dir ──────────────────────────────────────────────────────────

function getCacheDir(): string {
  return process.env['CODEBURN_CACHE_DIR'] ?? join(homedir(), '.cache', 'codeburn')
}

function getCachePath(): string {
  return join(getCacheDir(), CACHE_FILE)
}

function getLegacyCachePath(): string {
  return join(getCacheDir(), LEGACY_CACHE_FILE)
}

/** Absolute path of the active (version-suffixed) session cache file. */
export function sessionCachePath(): string {
  return getCachePath()
}

// ── Env Fingerprint ────────────────────────────────────────────────────

export function computeEnvFingerprint(provider: string): string {
  const vars = PROVIDER_ENV_VARS[provider] ?? []
  const parts = vars.map(v => `${v}=${process.env[v] ?? ''}`)
  const parseVersion = PROVIDER_PARSE_VERSIONS[provider]
  if (parseVersion) parts.push(`parser=${parseVersion}`)
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16)
}

// ── Load / Save ────────────────────────────────────────────────────────

export function emptyCache(): SessionCache {
  return { version: CACHE_VERSION, providers: {}, complete: false }
}

/** A cache is warm only when a full scan finished against it. Empty-but-marked
 *  (a machine with no sessions) is complete; present-but-unmarked (an interrupted
 *  cold start, or a pre-marker cache) is NOT — it is still cold. */
export function isCacheComplete(cache: SessionCache): boolean {
  return cache.complete === true
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(e => typeof e === 'string')
}

function isOptionalString(v: unknown): boolean {
  return v === undefined || typeof v === 'string'
}

function isOptionalNum(v: unknown): boolean {
  return v === undefined || isNum(v)
}

function isOptionalBool(v: unknown): boolean {
  return v === undefined || typeof v === 'boolean'
}

function isToolCall(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o['tool'] === 'string'
    && isOptionalString(o['file'])
    && isOptionalString(o['command'])
}

function isToolCallArray(v: unknown): boolean {
  return Array.isArray(v) && (v as unknown[]).every(isToolCall)
}

function validateFingerprint(fp: unknown): fp is FileFingerprint {
  if (!fp || typeof fp !== 'object') return false
  const f = fp as Record<string, unknown>
  return isNum(f['dev']) && isNum(f['ino']) && isNum(f['mtimeMs']) && isNum(f['sizeBytes'])
}

function validateUsage(u: unknown): u is CachedUsage {
  if (!u || typeof u !== 'object') return false
  const o = u as Record<string, unknown>
  return isNum(o['inputTokens']) && isNum(o['outputTokens'])
    && isNum(o['cacheCreationInputTokens']) && isNum(o['cacheReadInputTokens'])
    && isNum(o['cachedInputTokens']) && isNum(o['reasoningTokens'])
    && isNum(o['webSearchRequests']) && isNum(o['cacheCreationOneHourTokens'])
}

function validateCall(c: unknown): c is CachedCall {
  if (!c || typeof c !== 'object') return false
  const o = c as Record<string, unknown>
  return typeof o['provider'] === 'string'
    && typeof o['model'] === 'string'
    && typeof o['deduplicationKey'] === 'string'
    && typeof o['timestamp'] === 'string'
    && (o['speed'] === 'standard' || o['speed'] === 'fast')
    && isOptionalNum(o['costUSD'])
    && isOptionalBool(o['isEstimated'])
    && isStringArray(o['tools'])
    && isStringArray(o['bashCommands'])
    && isStringArray(o['skills'])
    && (o['subagentTypes'] === undefined || isStringArray(o['subagentTypes']))
    && isOptionalString(o['project'])
    && isOptionalString(o['projectPath'])
    && (o['toolSequence'] === undefined || (Array.isArray(o['toolSequence']) && (o['toolSequence'] as unknown[]).every(s => isToolCallArray(s))))
    && validateUsage(o['usage'])
}

function validateTurn(t: unknown): t is CachedTurn {
  if (!t || typeof t !== 'object') return false
  const o = t as Record<string, unknown>
  return typeof o['timestamp'] === 'string'
    && typeof o['sessionId'] === 'string'
    && typeof o['userMessage'] === 'string'
    && Array.isArray(o['calls'])
    && (o['calls'] as unknown[]).every(validateCall)
}

function validateCachedFile(f: unknown): f is CachedFile {
  if (!f || typeof f !== 'object') return false
  const o = f as Record<string, unknown>
  return validateFingerprint(o['fingerprint'])
    && isOptionalNum(o['lastCompleteLineOffset'])
    && isOptionalString(o['canonicalCwd'])
    && isOptionalString(o['canonicalProjectName'])
    && isStringArray(o['mcpInventory'])
    && Array.isArray(o['turns'])
    && (o['turns'] as unknown[]).every(validateTurn)
}

function validateProviderSection(s: unknown): s is ProviderSection {
  if (!s || typeof s !== 'object') return false
  const o = s as Record<string, unknown>
  if (typeof o['envFingerprint'] !== 'string') return false
  if (!o['files'] || typeof o['files'] !== 'object' || Array.isArray(o['files'])) return false
  return Object.values(o['files'] as Record<string, unknown>).every(validateCachedFile)
}

function validateCache(raw: unknown): raw is SessionCache {
  if (!raw || typeof raw !== 'object') return false
  const o = raw as Record<string, unknown>
  if (o['version'] !== CACHE_VERSION) return false
  if (!o['providers'] || typeof o['providers'] !== 'object' || Array.isArray(o['providers'])) return false
  return Object.values(o['providers'] as Record<string, unknown>).every(validateProviderSection)
}

export async function loadCache(): Promise<SessionCache> {
  try {
    const raw = await readFile(getCachePath(), 'utf-8')
    const parsed = JSON.parse(raw)
    if (!validateCache(parsed)) return emptyCache()
    return parsed
  } catch {
    // Versioned file absent/unreadable: try a one-time adoption of the legacy
    // unversioned file. validateCache requires version === CACHE_VERSION, so a
    // different-version legacy file is ignored (left intact). We copy it into the
    // versioned file once via saveCache; the legacy file is never modified.
    return adoptLegacyCache()
  }
}

async function adoptLegacyCache(): Promise<SessionCache> {
  try {
    const raw = await readFile(getLegacyCachePath(), 'utf-8')
    const parsed = JSON.parse(raw)
    if (!validateCache(parsed)) return emptyCache()
    await saveCache(parsed).catch(() => {})
    return parsed
  } catch {
    return emptyCache()
  }
}

export async function saveCache(cache: SessionCache): Promise<void> {
  const dir = getCacheDir()
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })

  const finalPath = getCachePath()
  const tempPath = `${finalPath}.${randomBytes(8).toString('hex')}.tmp`
  delete (cache as { _dirty?: boolean })._dirty
  const payload = JSON.stringify(cache)

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
}

// ── File Fingerprinting ────────────────────────────────────────────────
//
// Fingerprints cover the source's transcript file only. Providers that keep
// metadata in a companion file (kiro CLI: credits in `<id>.json` next to the
// `.jsonl`; kiro v2: modelId in `session.json` next to `messages.jsonl`) have
// a blind spot: a parse that races the companion write caches the turn with
// fallback values, and if the transcript never changes again (a session's
// final turn) the entry never invalidates. Mid-session turns self-heal since
// append-only transcripts keep changing. Fixing this properly means
// multi-file fingerprints per source.

export async function fingerprintFile(filePath: string): Promise<FileFingerprint | null> {
  try {
    const s = await stat(filePath)
    return { dev: s.dev, ino: s.ino, mtimeMs: s.mtimeMs, sizeBytes: s.size }
  } catch {
    // Providers encode extra context into source paths using virtual suffixes:
    // - Cursor: `<dbPath>#cursor-ws=<workspace>` (workspace-aware routing)
    // - OpenCode: `<dbPath>:<sessionId>` (session scoping)
    // These compound paths don't exist on disk; strip the suffix to stat the
    // underlying file. Try `#` first (rare in real paths), then `:` (must use
    // lastIndexOf to tolerate Windows drive letters like C:\...).
    const hashIdx = filePath.indexOf('#')
    if (hashIdx > 0) {
      try {
        const s = await stat(filePath.slice(0, hashIdx))
        return { dev: s.dev, ino: s.ino, mtimeMs: s.mtimeMs, sizeBytes: s.size }
      } catch {
        // fall through to colon check
      }
    }
    const colonIdx = filePath.lastIndexOf(':')
    if (colonIdx > 0) {
      try {
        const s = await stat(filePath.slice(0, colonIdx))
        return { dev: s.dev, ino: s.ino, mtimeMs: s.mtimeMs, sizeBytes: s.size }
      } catch {
        return null
      }
    }
    return null
  }
}

// ── Reconciliation ─────────────────────────────────────────────────────

export type ReconcileAction =
  | { action: 'unchanged' }
  | { action: 'appended'; readFromOffset: number }
  | { action: 'modified' }
  | { action: 'new' }

export function reconcileFile(
  current: FileFingerprint,
  cached: CachedFile | undefined,
): ReconcileAction {
  if (!cached) return { action: 'new' }

  const fp = cached.fingerprint

  if (
    fp.dev === current.dev &&
    fp.ino === current.ino &&
    fp.mtimeMs === current.mtimeMs &&
    fp.sizeBytes === current.sizeBytes
  ) {
    return { action: 'unchanged' }
  }

  if (
    cached.lastCompleteLineOffset !== undefined &&
    fp.dev === current.dev &&
    fp.ino === current.ino &&
    current.sizeBytes > fp.sizeBytes
  ) {
    return { action: 'appended', readFromOffset: cached.lastCompleteLineOffset }
  }

  return { action: 'modified' }
}

// ── Dedup Merge ────────────────────────────────────────────────────────
// When appending incremental data, streaming Claude messages can re-emit
// the same dedup key with updated usage. Merge by key: keep the earliest
// timestamp, take incoming usage/tools/bashCommands/skills (latest wins).

export function mergeCallByDedupKey(
  existing: CachedCall,
  incoming: CachedCall,
): CachedCall {
  return {
    ...incoming,
    timestamp: existing.timestamp < incoming.timestamp
      ? existing.timestamp
      : incoming.timestamp,
  }
}

// ── Temp Cleanup ───────────────────────────────────────────────────────

export async function cleanupOrphanedTempFiles(): Promise<void> {
  const dir = getCacheDir()
  if (!existsSync(dir)) return

  try {
    const entries = await readdir(dir)
    const now = Date.now()

    // Only our own (versioned) temp files. Legacy `session-cache.json.*.tmp`
    // temps belong to old binaries mid-write and must not be touched.
    const prefix = `${CACHE_FILE}.`
    for (const entry of entries) {
      if (!entry.startsWith(prefix) || !entry.endsWith('.tmp')) continue
      try {
        const fullPath = join(dir, entry)
        const s = await stat(fullPath)
        if (now - s.mtimeMs > TEMP_FILE_MAX_AGE_MS) {
          await unlink(fullPath)
        }
      } catch {}
    }
  } catch {}
}

// ── Hydration Lock ─────────────────────────────────────────────────────
//
// Advisory, cross-process coordination for the expensive cold hydration. When
// two live processes (e.g. an old launchd menubar and the desktop app) both
// cold-start against the same cache dir, without this they each parse full
// history and race their writes. The first to arrive creates the lock and
// hydrates; a second live process waits for release, then reads the now-warm
// cache instead of re-parsing. It is strictly an optimization: on any
// uncertainty we proceed with the parse, so it can never wedge a cold start.

const HYDRATION_LOCK_FILE = 'hydrating.lock'
const LOCK_FRESH_MS = 15 * 60_000
const LOCK_WAIT_MAX_MS = 10 * 60_000
const LOCK_POLL_MS = 250

type LockRecord = { pid: number; at: number }
export type HydrationHandle = { waited: boolean; release: () => Promise<void> }

const NOOP_HANDLE: HydrationHandle = { waited: false, release: async () => {} }

function lockPath(): string {
  return join(getCacheDir(), HYDRATION_LOCK_FILE)
}

// Our own pid never counts as a foreign holder: a same-process lock is either
// re-entrant or leaked, and waiting on ourselves risks a self-hang. Cross-process
// coordination is the only thing this lock is for. EPERM means the pid exists but
// belongs to another user — still alive.
function pidLooksAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false
  try { process.kill(pid, 0); return true }
  catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
}

async function readLockRecord(): Promise<LockRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(lockPath(), 'utf-8')) as Partial<LockRecord>
    if (typeof parsed?.pid === 'number' && typeof parsed?.at === 'number') return { pid: parsed.pid, at: parsed.at }
    return null
  } catch { return null }
}

async function writeOurLock(): Promise<boolean> {
  try {
    const dir = getCacheDir()
    if (!existsSync(dir)) await mkdir(dir, { recursive: true })
    const handle = await open(lockPath(), 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }), { encoding: 'utf-8' }) }
    finally { await handle.close() }
    return true
  } catch { return false }
}

async function removeOurLock(): Promise<void> {
  try {
    const cur = await readLockRecord()
    if (cur && cur.pid === process.pid) await unlink(lockPath())
  } catch { /* best-effort; a leaked lock is reclaimed as stale next cold start */ }
}

// Synchronous variant for the signal path: a handler can't await, so read + unlink
// synchronously. Only unlinks a lock we actually own.
function removeOurLockSync(): void {
  try {
    const parsed = JSON.parse(readFileSync(lockPath(), 'utf-8')) as Partial<LockRecord>
    if (parsed?.pid === process.pid) unlinkSync(lockPath())
  } catch { /* best-effort; nothing to clean or already gone */ }
}

// Arm once, only while we hold the lock: on a catchable termination (Ctrl-C, or a
// SIGTERM from a parent) clean our lock before dying so a killed cold parse leaves
// no leftover. SIGKILL can't be caught, so that path still relies on the next cold
// start's stale-lock takeover. process.once + re-raise preserves the default exit.
let signalCleanupArmed = false
function armSignalCleanup(): void {
  if (signalCleanupArmed) return
  signalCleanupArmed = true
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      removeOurLockSync()
      process.kill(process.pid, sig)
    })
  }
}

const releaseHandle: HydrationHandle = { waited: false, release: removeOurLock }

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * Coordinate a cold hydration. Pass `isCold = true` only when the on-disk cache
 * is empty (a genuine full parse is imminent). Returns a handle:
 *  - `waited: true`  → another live process was hydrating; we waited for it to
 *    finish (or timed out). The caller should RELOAD the cache and let its normal
 *    reconcile serve the now-warm entries instead of re-parsing. `release` is a
 *    no-op (we never held the lock).
 *  - `waited: false` with a real `release` → we hold the lock; hydrate, then call
 *    `release()` in a finally.
 *  - `waited: false` with a no-op `release` → proceed with the parse unlocked
 *    (not cold, or the lock state was uncertain).
 */
export async function beginColdHydration(isCold: boolean): Promise<HydrationHandle> {
  if (!isCold) return NOOP_HANDLE
  try {
    if (await writeOurLock()) { armSignalCleanup(); return releaseHandle }
    const existing = await readLockRecord()
    const fresh = existing !== null && Date.now() - existing.at < LOCK_FRESH_MS
    if (existing && fresh && pidLooksAlive(existing.pid)) {
      // Another live process owns a fresh lock: wait for it to release, go stale,
      // or die. A CLEAN release means the cache is warm — reload it. Going stale or
      // dying (e.g. a SIGKILLed cold scan) means the holder left partial data AND a
      // leftover lock file: take over — clean the stale lock and re-acquire — so we
      // re-parse under our own lock and remove the leftover on release, instead of
      // leaving it for the next cold start to reclaim.
      const deadline = Date.now() + LOCK_WAIT_MAX_MS
      let takeover = false
      while (Date.now() < deadline) {
        await sleep(LOCK_POLL_MS)
        const cur = await readLockRecord()
        if (!cur) break
        if (Date.now() - cur.at >= LOCK_FRESH_MS) { takeover = true; break }
        if (!pidLooksAlive(cur.pid)) { takeover = true; break }
      }
      if (takeover) {
        try { await unlink(lockPath()) } catch { /* another process may have; fine */ }
        if (await writeOurLock()) { armSignalCleanup(); return releaseHandle }
      }
      return { waited: true, release: async () => {} }
    }
    // Stale, dead-pid, or unreadable lock: replace it and take over.
    try { await unlink(lockPath()) } catch { /* another process may have; fine */ }
    if (await writeOurLock()) return releaseHandle
    return NOOP_HANDLE
  } catch {
    return NOOP_HANDLE
  }
}
