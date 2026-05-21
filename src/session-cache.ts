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
}

export type CachedFile = {
  fingerprint: FileFingerprint
  lastCompleteLineOffset?: number
  canonicalCwd?: string
  mcpInventory: string[]
  turns: CachedTurn[]
}

export type ProviderSection = {
  envFingerprint: string
  files: Record<string, CachedFile>
}

export type SessionCache = {
  version: number
  providers: Record<string, ProviderSection>
}

// ── Constants ──────────────────────────────────────────────────────────

export const CACHE_VERSION = 3

const CACHE_FILE = 'session-cache.json'
const TEMP_FILE_MAX_AGE_MS = 5 * 60 * 1000

const PROVIDER_ENV_VARS: Record<string, string[]> = {
  claude: ['CLAUDE_CONFIG_DIRS', 'CLAUDE_CONFIG_DIR'],
  codex: ['CODEX_HOME'],
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
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16)
}

// ── Load / Save ────────────────────────────────────────────────────────

export function emptyCache(): SessionCache {
  return { version: CACHE_VERSION, providers: {} }
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
    && isStringArray(o['tools'])
    && isStringArray(o['bashCommands'])
    && isStringArray(o['skills'])
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


