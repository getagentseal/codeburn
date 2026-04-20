import { createHash, randomBytes } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, open, readFile, rename, unlink } from 'fs/promises'
import { homedir } from 'os'
import { dirname, join } from 'path'

import type { SessionSource } from './providers/types.js'

const DISCOVERY_CACHE_VERSION = 1

export type DiscoverySnapshotEntry = {
  path: string
  mtimeMs: number
}

type DiscoveryCacheEntry = {
  version: number
  provider: string
  scope: string
  snapshot: DiscoverySnapshotEntry[]
  sources: SessionSource[]
}

function cacheRoot(): string {
  const base = process.env['CODEBURN_CACHE_DIR'] ?? join(homedir(), '.cache', 'codeburn')
  return join(base, 'discovery-cache-v1')
}

function cacheFilename(provider: string, scope: string): string {
  return `${createHash('sha1').update(`${provider}:${scope}`).digest('hex')}.json`
}

function cachePath(provider: string, scope: string): string {
  return join(cacheRoot(), cacheFilename(provider, scope))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isDiscoverySnapshotEntry(value: unknown): value is DiscoverySnapshotEntry {
  return isPlainObject(value)
    && typeof value.path === 'string'
    && isFiniteNumber(value.mtimeMs)
}

function isSessionSource(value: unknown): value is SessionSource {
  return isPlainObject(value)
    && typeof value.path === 'string'
    && typeof value.project === 'string'
    && typeof value.provider === 'string'
    && (value.fingerprintPath === undefined || typeof value.fingerprintPath === 'string')
    && (value.cacheStrategy === undefined || value.cacheStrategy === 'full-reparse' || value.cacheStrategy === 'append-jsonl')
    && (value.progressLabel === undefined || typeof value.progressLabel === 'string')
    && (value.parserVersion === undefined || typeof value.parserVersion === 'string')
}

function isDiscoveryCacheEntry(value: unknown): value is DiscoveryCacheEntry {
  return isPlainObject(value)
    && value.version === DISCOVERY_CACHE_VERSION
    && typeof value.provider === 'string'
    && typeof value.scope === 'string'
    && Array.isArray(value.snapshot)
    && value.snapshot.every(isDiscoverySnapshotEntry)
    && Array.isArray(value.sources)
    && value.sources.every(isSessionSource)
}

function normalizeSnapshot(snapshot: DiscoverySnapshotEntry[]): DiscoverySnapshotEntry[] {
  return [...snapshot].sort((left, right) => left.path.localeCompare(right.path))
}

function snapshotsMatch(left: DiscoverySnapshotEntry[], right: DiscoverySnapshotEntry[]): boolean {
  if (left.length !== right.length) return false
  return left.every((entry, index) => {
    const other = right[index]
    return !!other && entry.path === other.path && entry.mtimeMs === other.mtimeMs
  })
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

export async function loadDiscoveryCache(
  provider: string,
  scope: string,
  snapshot: DiscoverySnapshotEntry[],
): Promise<SessionSource[] | null> {
  const path = cachePath(provider, scope)
  if (!existsSync(path)) return null

  try {
    const raw = await readFile(path, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (!isDiscoveryCacheEntry(parsed)) return null
    if (parsed.provider !== provider || parsed.scope !== scope) return null

    const normalizedSnapshot = normalizeSnapshot(snapshot)
    const cachedSnapshot = normalizeSnapshot(parsed.snapshot)
    if (!snapshotsMatch(normalizedSnapshot, cachedSnapshot)) return null

    return parsed.sources
  } catch {
    return null
  }
}

export async function saveDiscoveryCache(
  provider: string,
  scope: string,
  snapshot: DiscoverySnapshotEntry[],
  sources: SessionSource[],
): Promise<void> {
  await mkdir(cacheRoot(), { recursive: true })
  await atomicWriteJson(cachePath(provider, scope), {
    version: DISCOVERY_CACHE_VERSION,
    provider,
    scope,
    snapshot: normalizeSnapshot(snapshot),
    sources,
  } satisfies DiscoveryCacheEntry)
}
