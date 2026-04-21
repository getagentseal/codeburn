import { readFile, writeFile, mkdir, stat } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

import type { ParsedProviderCall } from './providers/types.js'

type ResultCache = {
  dbMtimeMs: number
  dbSizeBytes: number
  calls: ParsedProviderCall[]
}

const CACHE_FILE = 'cursor-results.json'

function getCacheDir(): string {
  return join(homedir(), '.cache', 'codeburn')
}

function getCachePath(): string {
  return join(getCacheDir(), CACHE_FILE)
}

async function getDbFingerprint(dbPath: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const s = await stat(dbPath)
    return { mtimeMs: s.mtimeMs, size: s.size }
  } catch {
    return null
  }
}

export async function readCachedResults(dbPath: string): Promise<ParsedProviderCall[] | null> {
  try {
    const fp = await getDbFingerprint(dbPath)
    if (!fp) return null

    const raw = await readFile(getCachePath(), 'utf-8')
    const cache = JSON.parse(raw) as ResultCache

    if (cache.dbMtimeMs === fp.mtimeMs && cache.dbSizeBytes === fp.size) {
      return cache.calls
    }
    return null
  } catch {
    return null
  }
}

export async function writeCachedResults(dbPath: string, calls: ParsedProviderCall[]): Promise<void> {
  try {
    const fp = await getDbFingerprint(dbPath)
    if (!fp) return

    const dir = getCacheDir()
    await mkdir(dir, { recursive: true })
    const cache: ResultCache = {
      dbMtimeMs: fp.mtimeMs,
      dbSizeBytes: fp.size,
      calls,
    }
    await writeFile(getCachePath(), JSON.stringify(cache), 'utf-8')
  } catch {}
}
