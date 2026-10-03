import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  CODEX_CACHE_VERSION,
  CODEX_LEGACY_CACHE_FILE,
  clearCodexMemCaches,
  codexCacheFileName,
  fingerprintFile,
  flushCodexCache,
  readCachedCodexResults,
  writeCachedCodexResults,
} from '../src/codex-cache.js'
import {
  CURSOR_CACHE_VERSION,
  CURSOR_LEGACY_CACHE_FILE,
  cursorCacheFileName,
  readCachedResults,
  writeCachedResults,
} from '../src/cursor-cache.js'
import {
  ANTIGRAVITY_CACHE_VERSION,
  ANTIGRAVITY_LEGACY_CACHE_FILE,
  antigravityCacheFileName,
  clearAntigravityCacheStates,
  createAntigravityProvider,
} from '../src/providers/antigravity.js'
import type { ParsedProviderCall } from '../src/providers/types.js'

const originalCacheDir = process.env['CODEBURN_CACHE_DIR']
let root: string

function call(provider: string, marker: string): ParsedProviderCall {
  return {
    provider,
    model: marker,
    inputTokens: 1,
    outputTokens: 1,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    tools: [],
    bashCommands: [],
    timestamp: '2026-08-22T00:00:00.000Z',
    speed: 'standard',
    deduplicationKey: `${provider}:${marker}`,
    userMessage: '',
    sessionId: marker,
  }
}

async function readAntigravityModel(sourcePath: string): Promise<string | undefined> {
  const parser = createAntigravityProvider().createSessionParser({
    path: sourcePath,
    project: 'fixture',
    provider: 'antigravity',
  }, new Set())
  for await (const parsed of parser.parse()) return parsed.model
  return undefined
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codeburn-result-suffix-'))
  process.env['CODEBURN_CACHE_DIR'] = root
  clearCodexMemCaches()
  clearAntigravityCacheStates()
})

afterEach(async () => {
  if (originalCacheDir === undefined) delete process.env['CODEBURN_CACHE_DIR']
  else process.env['CODEBURN_CACHE_DIR'] = originalCacheDir
  clearCodexMemCaches()
  clearAntigravityCacheStates()
  await rm(root, { recursive: true, force: true })
})

describe('unsuffixed result caches coexist with mixed-version binaries', () => {
  it('publishes Codex to the versioned file and leaves an older unsuffixed file intact', async () => {
    const sourcePath = join(root, 'rollout.jsonl')
    await writeFile(sourcePath, '{}\n')
    const fingerprint = await fingerprintFile(sourcePath)
    expect(fingerprint).not.toBeNull()

    const legacyPath = join(root, CODEX_LEGACY_CACHE_FILE)
    await writeFile(legacyPath, JSON.stringify({
      version: CODEX_CACHE_VERSION - 1,
      files: { [sourcePath]: { mtimeMs: 1, sizeBytes: 1, project: 'old', calls: [call('codex', 'old-binary')] } },
    }))

    await writeCachedCodexResults(sourcePath, 'project', [call('codex', 'new-binary')], fingerprint!)
    await flushCodexCache()

    expect(existsSync(join(root, codexCacheFileName()))).toBe(true)
    expect(existsSync(legacyPath)).toBe(true)
    const versioned = JSON.parse(await readFile(join(root, codexCacheFileName()), 'utf8'))
    const legacy = JSON.parse(await readFile(legacyPath, 'utf8'))
    expect(versioned.version).toBe(CODEX_CACHE_VERSION)
    expect(versioned.files[sourcePath].calls[0].model).toBe('new-binary')
    expect(legacy.version).toBe(CODEX_CACHE_VERSION - 1)
    expect(legacy.files[sourcePath].calls[0].model).toBe('old-binary')
  })

  it('adopts a matching-version unsuffixed Codex cache and ignores a mismatched one', async () => {
    const sourcePath = join(root, 'rollout.jsonl')
    await writeFile(sourcePath, '{}\n')
    const fingerprint = await fingerprintFile(sourcePath)
    expect(fingerprint).not.toBeNull()

    await writeFile(join(root, CODEX_LEGACY_CACHE_FILE), JSON.stringify({
      version: CODEX_CACHE_VERSION,
      files: {
        [sourcePath]: {
          dev: fingerprint!.dev,
          ino: fingerprint!.ino,
          mtimeMs: fingerprint!.mtimeMs,
          sizeBytes: fingerprint!.sizeBytes,
          project: 'adopted',
          calls: [call('codex', 'adopt-me')],
        },
      },
    }))

    expect((await readCachedCodexResults(sourcePath))?.calls.map(entry => entry.model)).toEqual(['adopt-me'])
    expect(existsSync(join(root, CODEX_LEGACY_CACHE_FILE))).toBe(true)
    expect(existsSync(join(root, codexCacheFileName()))).toBe(false)

    clearCodexMemCaches()
    await writeFile(join(root, CODEX_LEGACY_CACHE_FILE), JSON.stringify({
      version: CODEX_CACHE_VERSION - 1,
      files: {
        [sourcePath]: {
          dev: fingerprint!.dev,
          ino: fingerprint!.ino,
          mtimeMs: fingerprint!.mtimeMs,
          sizeBytes: fingerprint!.sizeBytes,
          project: 'stale',
          calls: [call('codex', 'do-not-adopt')],
        },
      },
    }))
    expect(await readCachedCodexResults(sourcePath)).toBeNull()
  })

  it('publishes Cursor to the versioned file and leaves an older unsuffixed file intact', async () => {
    const dbPath = join(root, 'state.vscdb')
    await writeFile(dbPath, 'cursor-db')
    const floor = '2026-01-01T00:00:00.000Z'
    const legacyPath = join(root, CURSOR_LEGACY_CACHE_FILE)
    await writeFile(legacyPath, JSON.stringify({
      version: CURSOR_CACHE_VERSION - 1,
      dbMtimeMs: 1,
      dbSizeBytes: 1,
      lookbackFloor: floor,
      calls: [call('cursor', 'old-binary')],
    }))

    await writeCachedResults(dbPath, [call('cursor', 'new-binary')], floor)

    expect(existsSync(join(root, cursorCacheFileName()))).toBe(true)
    expect(existsSync(legacyPath)).toBe(true)
    const versioned = JSON.parse(await readFile(join(root, cursorCacheFileName()), 'utf8'))
    const legacy = JSON.parse(await readFile(legacyPath, 'utf8'))
    expect(versioned.version).toBe(CURSOR_CACHE_VERSION)
    expect(versioned.calls[0].model).toBe('new-binary')
    expect(legacy.version).toBe(CURSOR_CACHE_VERSION - 1)
    expect(legacy.calls[0].model).toBe('old-binary')
  })

  it('does not reuse Cursor results for another database with identical size and timestamps', async () => {
    const first = join(root, 'first.vscdb')
    const second = join(root, 'second.vscdb')
    await writeFile(first, 'first-db')
    await writeFile(second, 'other-db')
    const time = new Date('2026-05-01T00:00:00Z')
    await utimes(first, time, time)
    await utimes(second, time, time)
    expect((await stat(first)).mtimeMs).toBe((await stat(second)).mtimeMs)
    expect((await stat(first)).size).toBe((await stat(second)).size)
    const floor = '2026-01-01T00:00:00.000Z'
    await writeCachedResults(first, [call('cursor', 'first-database')], floor)
    expect((await readCachedResults(first, floor))?.map(entry => entry.model)).toEqual(['first-database'])
    expect(await readCachedResults(second, floor)).toBeNull()
  })

  it('adopts a matching-version unsuffixed Cursor cache and ignores a mismatched one', async () => {
    const dbPath = join(root, 'state.vscdb')
    await writeFile(dbPath, 'cursor-db')
    const { stat } = await import('fs/promises')
    const fp = await stat(dbPath)
    const floor = '2026-01-01T00:00:00.000Z'

    await writeFile(join(root, CURSOR_LEGACY_CACHE_FILE), JSON.stringify({
      version: CURSOR_CACHE_VERSION,
      dbPath,
      dbMtimeMs: fp.mtimeMs,
      dbSizeBytes: fp.size,
      lookbackFloor: floor,
      calls: [call('cursor', 'adopt-me')],
    }))
    expect((await readCachedResults(dbPath, floor))?.map(entry => entry.model)).toEqual(['adopt-me'])
    expect(existsSync(join(root, cursorCacheFileName()))).toBe(false)

    await writeFile(join(root, CURSOR_LEGACY_CACHE_FILE), JSON.stringify({
      version: CURSOR_CACHE_VERSION - 1,
      dbMtimeMs: fp.mtimeMs,
      dbSizeBytes: fp.size,
      lookbackFloor: floor,
      calls: [call('cursor', 'do-not-adopt')],
    }))
    expect(await readCachedResults(dbPath, floor)).toBeNull()
  })

  it('publishes Antigravity to the versioned file and leaves an older unsuffixed file intact', async () => {
    const sourcePath = join(root, 'shared.pb')
    await writeFile(sourcePath, 'fixture')
    const { stat } = await import('fs/promises')
    const sourceStat = await stat(sourcePath)
    const legacyPath = join(root, ANTIGRAVITY_LEGACY_CACHE_FILE)
    await mkdir(root, { recursive: true })
    await writeFile(legacyPath, JSON.stringify({
      version: ANTIGRAVITY_CACHE_VERSION - 1,
      cascades: {
        shared: { mtimeMs: sourceStat.mtimeMs, sizeBytes: sourceStat.size, calls: [call('antigravity', 'old-binary')] },
      },
    }))

    await writeFile(join(root, antigravityCacheFileName()), JSON.stringify({
      version: ANTIGRAVITY_CACHE_VERSION,
      cascades: {
        shared: { mtimeMs: sourceStat.mtimeMs, sizeBytes: sourceStat.size, calls: [call('antigravity', 'new-binary')] },
      },
    }))

    expect(await readAntigravityModel(sourcePath)).toBe('new-binary')
    const legacy = JSON.parse(await readFile(legacyPath, 'utf8'))
    expect(legacy.cascades.shared.calls[0].model).toBe('old-binary')
  })

  it('adopts a matching-version unsuffixed Antigravity cache and ignores a mismatched one', async () => {
    const sourcePath = join(root, 'shared.pb')
    await writeFile(sourcePath, 'fixture')
    const { stat } = await import('fs/promises')
    const sourceStat = await stat(sourcePath)

    await writeFile(join(root, ANTIGRAVITY_LEGACY_CACHE_FILE), JSON.stringify({
      version: ANTIGRAVITY_CACHE_VERSION,
      cascades: {
        shared: { mtimeMs: sourceStat.mtimeMs, sizeBytes: sourceStat.size, calls: [call('antigravity', 'adopt-me')] },
      },
    }))
    expect(await readAntigravityModel(sourcePath)).toBe('adopt-me')
    expect(existsSync(join(root, antigravityCacheFileName()))).toBe(false)

    clearAntigravityCacheStates()
    await writeFile(join(root, ANTIGRAVITY_LEGACY_CACHE_FILE), JSON.stringify({
      version: ANTIGRAVITY_CACHE_VERSION - 1,
      cascades: {
        shared: { mtimeMs: sourceStat.mtimeMs, sizeBytes: sourceStat.size, calls: [call('antigravity', 'do-not-adopt')] },
      },
    }))
    expect(await readAntigravityModel(sourcePath)).toBeUndefined()
  })

  it('never serves matching legacy when a versioned file is present but invalid', async () => {
    const sourcePath = join(root, 'rollout.jsonl')
    const dbPath = join(root, 'state.vscdb')
    const pbPath = join(root, 'shared.pb')
    await writeFile(sourcePath, '{}\n')
    await writeFile(dbPath, 'cursor-db')
    await writeFile(pbPath, 'fixture')
    const fingerprint = await fingerprintFile(sourcePath)
    const { stat } = await import('fs/promises')
    const dbStat = await stat(dbPath)
    const pbStat = await stat(pbPath)
    const floor = '2026-01-01T00:00:00.000Z'
    expect(fingerprint).not.toBeNull()

    await writeFile(join(root, CODEX_LEGACY_CACHE_FILE), JSON.stringify({
      version: CODEX_CACHE_VERSION,
      files: {
        [sourcePath]: {
          dev: fingerprint!.dev,
          ino: fingerprint!.ino,
          mtimeMs: fingerprint!.mtimeMs,
          sizeBytes: fingerprint!.sizeBytes,
          project: 'legacy',
          calls: [call('codex', 'legacy-served')],
        },
      },
    }))
    await writeFile(join(root, CURSOR_LEGACY_CACHE_FILE), JSON.stringify({
      version: CURSOR_CACHE_VERSION,
      dbMtimeMs: dbStat.mtimeMs,
      dbSizeBytes: dbStat.size,
      lookbackFloor: floor,
      calls: [call('cursor', 'legacy-served')],
    }))
    await writeFile(join(root, ANTIGRAVITY_LEGACY_CACHE_FILE), JSON.stringify({
      version: ANTIGRAVITY_CACHE_VERSION,
      cascades: {
        shared: { mtimeMs: pbStat.mtimeMs, sizeBytes: pbStat.size, calls: [call('antigravity', 'legacy-served')] },
      },
    }))

    await writeFile(join(root, codexCacheFileName()), '{not-json')
    await writeFile(join(root, cursorCacheFileName()), '{not-json')
    await writeFile(join(root, antigravityCacheFileName()), '{not-json')
    expect(await readCachedCodexResults(sourcePath)).toBeNull()
    expect(await readCachedResults(dbPath, floor)).toBeNull()
    expect(await readAntigravityModel(pbPath)).toBeUndefined()

    clearCodexMemCaches()
    clearAntigravityCacheStates()
    await writeFile(join(root, codexCacheFileName()), JSON.stringify({ version: CODEX_CACHE_VERSION - 1, files: {} }))
    await writeFile(join(root, cursorCacheFileName()), JSON.stringify({
      version: CURSOR_CACHE_VERSION - 1,
      dbMtimeMs: dbStat.mtimeMs,
      dbSizeBytes: dbStat.size,
      lookbackFloor: floor,
      calls: [call('cursor', 'wrong-version')],
    }))
    await writeFile(join(root, antigravityCacheFileName()), JSON.stringify({ version: ANTIGRAVITY_CACHE_VERSION - 1, cascades: {} }))
    expect(await readCachedCodexResults(sourcePath)).toBeNull()
    expect(await readCachedResults(dbPath, floor)).toBeNull()
    expect(await readAntigravityModel(pbPath)).toBeUndefined()
  })
})
