import { readFile, stat, open, rename, unlink, readdir, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
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
  walMtimeMs?: number
  walSizeBytes?: number
  shmMtimeMs?: number
  shmSizeBytes?: number
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
}

// ── Constants ──────────────────────────────────────────────────────────

export const CACHE_VERSION = 4

const CACHE_FILE = 'session-cache.json'
const TEMP_FILE_MAX_AGE_MS = 5 * 60 * 1000

const PROVIDER_ENV_VARS: Record<string, string[]> = {
  claude: ['CLAUDE_CONFIG_DIRS', 'CLAUDE_CONFIG_DIR'],
  codex: ['CODEX_HOME'],
  hermes: ['HERMES_HOME'],
  droid: ['FACTORY_DIR'],
  cursor: ['XDG_DATA_HOME'],
  'cursor-agent': ['XDG_DATA_HOME'],
  opencode: ['XDG_DATA_HOME'],
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

const PROVIDER_PARSE_VERSIONS: Record<string, string> = {
  claude: 'cowork-space-grouping-v1',
  cline: 'worktree-project-grouping-v1',
  cursor: 'composer-anchored-crediting-v1',
  'cursor-agent': 'workspaceless-transcript-v1',
  copilot: 'otel-durable-v1',
  hermes: 'reasoning-output-accounting-v1',
  'ibm-bob': 'worktree-project-grouping-v1',
  kiro: 'ide-parsing-v1',
  'kilo-code': 'worktree-project-grouping-v1',
  'roo-code': 'worktree-project-grouping-v1',
  warp: 'worktree-project-grouping-v1',
  antigravity: 'safe-token-counts-v1',
}

// ── Cache Dir ──────────────────────────────────────────────────────────

function getCacheDir(): string {
  return process.env['CODEBURN_CACHE_DIR'] ?? join(homedir(), '.cache', 'codeburn')
}

function getCachePath(): string {
  return join(getCacheDir(), CACHE_FILE)
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
  return { version: CACHE_VERSION, providers: {} }
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isSafeTokenCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
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
  return isSafeTokenCount(o['inputTokens']) && isSafeTokenCount(o['outputTokens'])
    && isSafeTokenCount(o['cacheCreationInputTokens']) && isSafeTokenCount(o['cacheReadInputTokens'])
    && isSafeTokenCount(o['cachedInputTokens']) && isSafeTokenCount(o['reasoningTokens'])
    && isNum(o['webSearchRequests']) && isSafeTokenCount(o['cacheCreationOneHourTokens'])
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

function sanitizeProviderSection(s: unknown): ProviderSection | null {
  if (!s || typeof s !== 'object') return null
  const o = s as Record<string, unknown>
  if (typeof o['envFingerprint'] !== 'string') return null
  if (!o['files'] || typeof o['files'] !== 'object' || Array.isArray(o['files'])) return null

  const files: Record<string, CachedFile> = {}
  for (const [path, file] of Object.entries(o['files'] as Record<string, unknown>)) {
    if (validateCachedFile(file)) files[path] = file
  }
  if (Object.keys(files).length === 0) return null

  return {
    envFingerprint: o['envFingerprint'],
    files,
    ...(o['durable'] === true ? { durable: true } : {}),
  }
}

function validateCache(raw: unknown): raw is SessionCache {
  if (!raw || typeof raw !== 'object') return false
  const o = raw as Record<string, unknown>
  if (o['version'] !== CACHE_VERSION) return false
  if (!o['providers'] || typeof o['providers'] !== 'object' || Array.isArray(o['providers'])) return false
  return Object.values(o['providers'] as Record<string, unknown>).every(validateProviderSection)
}

function sanitizeCache(raw: unknown): SessionCache | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o['version'] !== CACHE_VERSION) return null
  if (!o['providers'] || typeof o['providers'] !== 'object' || Array.isArray(o['providers'])) return null

  const providers: Record<string, ProviderSection> = {}
  for (const [provider, section] of Object.entries(o['providers'] as Record<string, unknown>)) {
    const sanitized = sanitizeProviderSection(section)
    if (sanitized) providers[provider] = sanitized
  }
  return { version: CACHE_VERSION, providers }
}

export async function loadCache(): Promise<SessionCache> {
  try {
    const raw = await readFile(getCachePath(), 'utf-8')
    const parsed = JSON.parse(raw)
    if (!validateCache(parsed)) return sanitizeCache(parsed) ?? emptyCache()
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

export async function fingerprintFile(filePath: string): Promise<FileFingerprint | null> {
  async function fingerprintBasePath(basePath: string): Promise<FileFingerprint> {
    const s = await stat(basePath)
    const fp: FileFingerprint = { dev: s.dev, ino: s.ino, mtimeMs: s.mtimeMs, sizeBytes: s.size }

    const wal = await stat(`${basePath}-wal`).catch(() => null)
    if (wal) {
      fp.walMtimeMs = wal.mtimeMs
      fp.walSizeBytes = wal.size
    }

    const shm = await stat(`${basePath}-shm`).catch(() => null)
    if (shm) {
      fp.shmMtimeMs = shm.mtimeMs
      fp.shmSizeBytes = shm.size
    }

    return fp
  }

  try {
    return await fingerprintBasePath(filePath)
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
        return await fingerprintBasePath(filePath.slice(0, hashIdx))
      } catch {
        // fall through to colon check
      }
    }
    const colonIdx = filePath.lastIndexOf(':')
    if (colonIdx > 0) {
      try {
        return await fingerprintBasePath(filePath.slice(0, colonIdx))
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
    fp.walMtimeMs !== current.walMtimeMs ||
    fp.walSizeBytes !== current.walSizeBytes ||
    fp.shmMtimeMs !== current.shmMtimeMs ||
    fp.shmSizeBytes !== current.shmSizeBytes
  ) {
    return { action: 'modified' }
  }

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

    const prefix = 'session-cache.json.'
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
