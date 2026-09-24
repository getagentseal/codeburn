// Test-side IO for the sharded session cache: the on-disk form is a directory
// (envelope + one shard per provider), so tests read and write it through the
// real load/save path instead of touching a single JSON file.
import { readFile, readdir } from 'fs/promises'
import { join } from 'path'

import {
  clearLoadCacheMemo,
  loadCache,
  markCacheDirty,
  saveCache,
  sessionCacheDir,
  type CachedFile,
  type SessionCache,
} from '../../src/session-cache.js'

/** The cache exactly as it is on disk, bypassing the in-process memo. */
export async function readCacheOnDisk(): Promise<SessionCache> {
  clearLoadCacheMemo()
  return loadCache()
}

/** Publish `cache`, rewriting every provider's shard. */
export async function writeCacheOnDisk(cache: SessionCache): Promise<void> {
  for (const provider of Object.keys(cache.providers)) markCacheDirty(cache, provider)
  await saveCache(cache)
  clearLoadCacheMemo()
}

/** Byte-level snapshot of the whole cache directory (names + contents). */
export async function cacheDirSnapshot(): Promise<string> {
  const dir = sessionCacheDir()
  const names = (await readdir(dir)).sort()
  const parts = await Promise.all(names.map(async name => `${name}:${await readFile(join(dir, name), 'utf-8')}`))
  return parts.join('\n')
}

/** The published pieces of `provider` (UTC day -> file name), straight off disk. */
export async function publishedPieces(provider: string): Promise<Record<string, string>> {
  const dir = sessionCacheDir()
  const envelope = JSON.parse(await readFile(join(dir, 'envelope.json'), 'utf-8')) as { providers: Record<string, { index: string }> }
  const index = envelope.providers[provider]?.index
  if (!index) return {}
  return (JSON.parse(await readFile(join(dir, index), 'utf-8')) as { pieces: Record<string, string> }).pieces
}

/** Every member the published pieces of `provider` hold, straight off disk. */
export async function publishedMembers(provider: string): Promise<Record<string, CachedFile>> {
  const dir = sessionCacheDir()
  const files: Record<string, CachedFile> = {}
  for (const name of Object.values(await publishedPieces(provider))) Object.assign(files, JSON.parse(await readFile(join(dir, name), 'utf-8')))
  return files
}
