import { createHash, randomBytes } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, open, readFile, rename, stat, unlink } from 'fs/promises'
import { homedir } from 'os'
import { dirname, join } from 'path'

import type { SessionSummary } from './types.js'

export const SOURCE_CACHE_VERSION = 1

export type SourceCacheStrategy = 'full-reparse' | 'append-jsonl'

export type SourceFingerprint = {
  mtimeMs: number
  sizeBytes: number
}

export type AppendState = {
  endOffset: number
  tailHash: string
}

export type SourceCacheEntry = {
  version: number
  provider: string
  logicalPath: string
  fingerprintPath: string
  cacheStrategy: SourceCacheStrategy
  parserVersion: string
  fingerprint: SourceFingerprint
  sessions: SessionSummary[]
  appendState?: AppendState
}

export type SourceCacheManifest = {
  version: number
  entries: Record<string, { file: string; provider: string; logicalPath: string }>
}

export type ReadSourceCacheEntryOptions = {
  allowStaleFingerprint?: boolean
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isManifestEntry(value: unknown): value is { file: string; provider: string; logicalPath: string } {
  return isPlainObject(value)
    && typeof value.file === 'string'
    && /^[a-f0-9]{40}\.json$/.test(value.file)
    && typeof value.provider === 'string'
    && typeof value.logicalPath === 'string'
}

function isSessionSummary(value: unknown): value is SessionSummary {
  return isPlainObject(value)
    && typeof value.sessionId === 'string'
    && typeof value.project === 'string'
    && typeof value.firstTimestamp === 'string'
    && typeof value.lastTimestamp === 'string'
    && isFiniteNumber(value.totalCostUSD)
    && isFiniteNumber(value.totalInputTokens)
    && isFiniteNumber(value.totalOutputTokens)
    && isFiniteNumber(value.totalCacheReadTokens)
    && isFiniteNumber(value.totalCacheWriteTokens)
    && isFiniteNumber(value.apiCalls)
    && Array.isArray(value.turns)
    && value.turns.every(isParsedTurn)
    && isBreakdownMap(value.modelBreakdown, isModelBreakdownEntry)
    && isBreakdownMap(value.toolBreakdown, isCallsBreakdownEntry)
    && isBreakdownMap(value.mcpBreakdown, isCallsBreakdownEntry)
    && isBreakdownMap(value.bashBreakdown, isCallsBreakdownEntry)
    && isBreakdownMap(value.categoryBreakdown, isCategoryBreakdownEntry)
}

function isTokenUsage(value: unknown): value is { inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number; cachedInputTokens: number; reasoningTokens: number; webSearchRequests: number } {
  return isPlainObject(value)
    && isFiniteNumber(value.inputTokens)
    && isFiniteNumber(value.outputTokens)
    && isFiniteNumber(value.cacheCreationInputTokens)
    && isFiniteNumber(value.cacheReadInputTokens)
    && isFiniteNumber(value.cachedInputTokens)
    && isFiniteNumber(value.reasoningTokens)
    && isFiniteNumber(value.webSearchRequests)
}

function isParsedApiCall(value: unknown): boolean {
  return isPlainObject(value)
    && typeof value.provider === 'string'
    && typeof value.model === 'string'
    && isTokenUsage(value.usage)
    && isFiniteNumber(value.costUSD)
    && Array.isArray(value.tools)
    && value.tools.every(tool => typeof tool === 'string')
    && Array.isArray(value.mcpTools)
    && value.mcpTools.every(tool => typeof tool === 'string')
    && typeof value.hasAgentSpawn === 'boolean'
    && typeof value.hasPlanMode === 'boolean'
    && (value.speed === 'standard' || value.speed === 'fast')
    && typeof value.timestamp === 'string'
    && Array.isArray(value.bashCommands)
    && value.bashCommands.every(command => typeof command === 'string')
    && typeof value.deduplicationKey === 'string'
}

function isParsedTurn(value: unknown): boolean {
  return isPlainObject(value)
    && typeof value.userMessage === 'string'
    && Array.isArray(value.assistantCalls)
    && value.assistantCalls.every(isParsedApiCall)
    && typeof value.timestamp === 'string'
    && typeof value.sessionId === 'string'
}

function isModelBreakdownEntry(value: unknown): boolean {
  return isPlainObject(value)
    && isFiniteNumber(value.calls)
    && isFiniteNumber(value.costUSD)
    && isTokenUsage(value.tokens)
}

function isCallsBreakdownEntry(value: unknown): boolean {
  return isPlainObject(value) && isFiniteNumber(value.calls)
}

function isCategoryBreakdownEntry(value: unknown): boolean {
  return isPlainObject(value)
    && isFiniteNumber(value.turns)
    && isFiniteNumber(value.costUSD)
    && isFiniteNumber(value.retries)
    && isFiniteNumber(value.editTurns)
    && isFiniteNumber(value.oneShotTurns)
}

function isBreakdownMap<T>(value: unknown, predicate: (entry: unknown) => entry is T): value is Record<string, T> {
  return isPlainObject(value) && Object.values(value).every(predicate)
}

function isAppendState(value: unknown): value is AppendState {
  return isPlainObject(value)
    && typeof value.endOffset === 'number'
    && Number.isFinite(value.endOffset)
    && typeof value.tailHash === 'string'
}

function isSourceCacheEntry(value: unknown): value is SourceCacheEntry {
  return isPlainObject(value)
    && typeof value.version === 'number'
    && typeof value.provider === 'string'
    && typeof value.logicalPath === 'string'
    && typeof value.fingerprintPath === 'string'
    && (value.cacheStrategy === 'full-reparse' || value.cacheStrategy === 'append-jsonl')
    && typeof value.parserVersion === 'string'
    && isPlainObject(value.fingerprint)
    && Number.isFinite(value.fingerprint.mtimeMs)
    && typeof value.fingerprint.mtimeMs === 'number'
    && Number.isFinite(value.fingerprint.sizeBytes)
    && typeof value.fingerprint.sizeBytes === 'number'
    && Array.isArray(value.sessions)
    && value.sessions.every(isSessionSummary)
    && (value.appendState === undefined || isAppendState(value.appendState))
}

function cacheRoot(): string {
  const base = process.env['CODEBURN_CACHE_DIR'] ?? join(homedir(), '.cache', 'codeburn')
  return join(base, 'source-cache-v1')
}

function manifestPath(): string {
  return join(cacheRoot(), 'manifest.json')
}

function entryDir(): string {
  return join(cacheRoot(), 'entries')
}

function sourceKey(provider: string, logicalPath: string): string {
  return `${provider}:${logicalPath}`
}

function entryFilename(provider: string, logicalPath: string): string {
  return `${createHash('sha1').update(sourceKey(provider, logicalPath)).digest('hex')}.json`
}

export function emptySourceCacheManifest(): SourceCacheManifest {
  return { version: SOURCE_CACHE_VERSION, entries: {} }
}

export async function computeFileFingerprint(filePath: string): Promise<SourceFingerprint> {
  const meta = await stat(filePath)
  return { mtimeMs: meta.mtimeMs, sizeBytes: meta.size }
}

export async function loadSourceCacheManifest(): Promise<SourceCacheManifest> {
  if (!existsSync(manifestPath())) return emptySourceCacheManifest()

  try {
    const raw = await readFile(manifestPath(), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (!isPlainObject(parsed) || parsed.version !== SOURCE_CACHE_VERSION || !isPlainObject(parsed.entries)) {
      return emptySourceCacheManifest()
    }

    const entries: SourceCacheManifest['entries'] = {}
    for (const [key, value] of Object.entries(parsed.entries)) {
      if (!isManifestEntry(value)) return emptySourceCacheManifest()
      entries[key] = value
    }

    return { version: SOURCE_CACHE_VERSION, entries }
  } catch {
    return emptySourceCacheManifest()
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`
  const handle = await open(temp, 'w', 0o600)
  try {
    await handle.writeFile(JSON.stringify(value), { encoding: 'utf-8' })
    await handle.sync()
  } finally {
    await handle.close()
  }

  try {
    await rename(temp, path)
  } catch (err) {
    try {
      await unlink(temp)
    } catch {
      // ignore cleanup failures
    }
    throw err
  }
}

export async function saveSourceCacheManifest(manifest: SourceCacheManifest): Promise<void> {
  await mkdir(cacheRoot(), { recursive: true })
  await atomicWriteJson(manifestPath(), manifest)
}

export async function readSourceCacheEntry(
  manifest: SourceCacheManifest,
  provider: string,
  logicalPath: string,
  options: ReadSourceCacheEntryOptions = {},
): Promise<SourceCacheEntry | null> {
  const meta = manifest.entries[sourceKey(provider, logicalPath)]
  if (!meta) return null
  if (meta.provider !== provider || meta.logicalPath !== logicalPath) return null

  const expectedFile = entryFilename(provider, logicalPath)
  if (meta.file !== expectedFile) return null

  try {
    const raw = await readFile(join(entryDir(), meta.file), 'utf-8')
    const entry: unknown = JSON.parse(raw)
    if (!isSourceCacheEntry(entry) || entry.version !== SOURCE_CACHE_VERSION) return null
    if (entry.provider !== provider || entry.logicalPath !== logicalPath) return null

    if (!options.allowStaleFingerprint) {
      const currentFingerprint = await computeFileFingerprint(entry.fingerprintPath)
      if (
        currentFingerprint.mtimeMs !== entry.fingerprint.mtimeMs
        || currentFingerprint.sizeBytes !== entry.fingerprint.sizeBytes
      ) {
        return null
      }
    }

    return entry
  } catch {
    return null
  }
}

export async function writeSourceCacheEntry(manifest: SourceCacheManifest, entry: SourceCacheEntry): Promise<void> {
  await mkdir(entryDir(), { recursive: true })
  const file = entryFilename(entry.provider, entry.logicalPath)
  await atomicWriteJson(join(entryDir(), file), entry)
  manifest.entries[sourceKey(entry.provider, entry.logicalPath)] = {
    file,
    provider: entry.provider,
    logicalPath: entry.logicalPath,
  }
}
