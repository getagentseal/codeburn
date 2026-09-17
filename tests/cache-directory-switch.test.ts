import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  clearCodexMemCaches,
  codexCacheFileName,
  fingerprintFile,
  flushCodexCache,
  readCachedCodexResults,
  writeCachedCodexResults,
} from '../src/codex-cache.js'
import {
  ANTIGRAVITY_CACHE_VERSION,
  antigravityCacheFileName,
  clearAntigravityCacheStates,
  createAntigravityProvider,
  flushAntigravityCache,
} from '../src/providers/antigravity.js'
import type { ParsedProviderCall } from '../src/providers/types.js'
import { setHome } from './setup/home.js'

const originalCacheDir = process.env['CODEBURN_CACHE_DIR']
const originalHome = process.env['HOME']
const originalCodexHome = process.env['CODEX_HOME']
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
    timestamp: '2026-08-12T00:00:00.000Z',
    speed: 'standard',
    deduplicationKey: `${provider}:${marker}`,
    userMessage: '',
    sessionId: marker,
  }
}

async function seedAntigravityCache(
  cacheDir: string,
  sourcePath: string,
  marker: string,
): Promise<void> {
  const sourceStat = await stat(sourcePath)
  await mkdir(cacheDir, { recursive: true })
  await writeFile(join(cacheDir, antigravityCacheFileName()), JSON.stringify({
    version: ANTIGRAVITY_CACHE_VERSION,
    cascades: {
      shared: {
        mtimeMs: sourceStat.mtimeMs,
        sizeBytes: sourceStat.size,
        calls: [call('antigravity', marker)],
      },
    },
  }))
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
  root = await mkdtemp(join(tmpdir(), 'codeburn-cache-switch-'))
})

afterEach(async () => {
  if (originalCacheDir === undefined) delete process.env['CODEBURN_CACHE_DIR']
  else process.env['CODEBURN_CACHE_DIR'] = originalCacheDir
  if (originalHome === undefined) setHome(undefined)
  else setHome(originalHome)
  if (originalCodexHome === undefined) delete process.env['CODEX_HOME']
  else process.env['CODEX_HOME'] = originalCodexHome
  await rm(root, { recursive: true, force: true })
})

describe('call-time CODEBURN_CACHE_DIR isolation', () => {
  it('keeps Codex reads and writes keyed by the active cache directory', async () => {
    const sourcePath = join(root, 'rollout.jsonl')
    const cacheA = join(root, 'cache-a')
    const cacheB = join(root, 'cache-b')
    await writeFile(sourcePath, '{}\n')
    const fingerprint = await fingerprintFile(sourcePath)
    expect(fingerprint).not.toBeNull()

    process.env['CODEBURN_CACHE_DIR'] = cacheA
    await writeCachedCodexResults(sourcePath, 'project-a', [call('codex', 'from-a')], fingerprint!)
    await flushCodexCache()

    process.env['CODEBURN_CACHE_DIR'] = cacheB
    expect(await readCachedCodexResults(sourcePath)).toBeNull()
    await writeCachedCodexResults(sourcePath, 'project-b', [call('codex', 'from-b')], fingerprint!)
    await flushCodexCache()

    const diskB = JSON.parse(await readFile(join(cacheB, codexCacheFileName()), 'utf8'))
    expect(diskB.files[sourcePath].calls.map((entry: ParsedProviderCall) => entry.model)).toEqual(['from-b'])

    process.env['CODEBURN_CACHE_DIR'] = cacheA
    expect((await readCachedCodexResults(sourcePath))?.calls.map(entry => entry.model)).toEqual(['from-a'])
  })

  it('does not flush dirty Codex state from A into B', async () => {
    const sourceA = join(root, 'a.jsonl')
    const sourceB = join(root, 'b.jsonl')
    const cacheA = join(root, 'cache-a-dirty')
    const cacheB = join(root, 'cache-b-dirty')
    await writeFile(sourceA, 'a\n')
    await writeFile(sourceB, 'b\n')

    process.env['CODEBURN_CACHE_DIR'] = cacheA
    await writeCachedCodexResults(sourceA, 'project-a', [call('codex', 'dirty-a')], (await fingerprintFile(sourceA))!)

    process.env['CODEBURN_CACHE_DIR'] = cacheB
    await writeCachedCodexResults(sourceB, 'project-b', [call('codex', 'dirty-b')], (await fingerprintFile(sourceB))!)
    await flushCodexCache()

    const diskB = JSON.parse(await readFile(join(cacheB, codexCacheFileName()), 'utf8'))
    expect(Object.keys(diskB.files)).toEqual([sourceB])

    process.env['CODEBURN_CACHE_DIR'] = cacheA
    await flushCodexCache()
    const diskA = JSON.parse(await readFile(join(cacheA, codexCacheFileName()), 'utf8'))
    expect(Object.keys(diskA.files)).toEqual([sourceA])
  })

  it('pins Codex reads, dirty writes, and flushes to the parse call-time directory', async () => {
    const home = join(root, 'parse-home')
    const codexHome = join(root, 'parse-codex-home')
    const sessionDir = join(codexHome, 'sessions', '2026', '08', '12')
    const cacheA = join(root, 'parse-cache-a')
    const cacheB = join(root, 'parse-cache-b')
    await mkdir(sessionDir, { recursive: true })
    await mkdir(home, { recursive: true })
    const sourcePath = join(sessionDir, 'rollout-cache-dir-switch.jsonl')
    await writeFile(sourcePath, [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-08-12T10:00:00.000Z',
        payload: {
          cwd: '/Users/test/cache-dir-transaction',
          originator: 'codex-cli',
          session_id: 'cache-dir-transaction',
          model: 'gpt-5.3-codex',
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-08-12T10:01:00.000Z',
        payload: {
          type: 'token_count',
          info: {
            model: 'gpt-5.3-codex',
            last_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 0,
              output_tokens: 5,
              reasoning_output_tokens: 0,
              total_tokens: 15,
            },
            total_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 0,
              output_tokens: 5,
              reasoning_output_tokens: 0,
              total_tokens: 15,
            },
          },
        },
      }),
    ].join('\n') + '\n')

    setHome(home)
    process.env['CODEX_HOME'] = codexHome
    process.env['CODEBURN_CACHE_DIR'] = cacheA
    const { clearSessionCache, parseAllSessions } = await import('../src/parser.js')
    clearSessionCache()

    // parseAllSessions reaches its first await before any Codex cache access.
    // Switching the host env immediately after invocation deterministically
    // exercises every later read/write/flush under the captured A transaction.
    const parsing = parseAllSessions(undefined, 'codex')
    process.env['CODEBURN_CACHE_DIR'] = cacheB
    const projects = await parsing

    expect(projects.some(project => project.sessions.some(session =>
      session.turns.some(turn => turn.assistantCalls.some(entry => entry.provider === 'codex'))
    ))).toBe(true)
    expect(existsSync(join(cacheA, codexCacheFileName()))).toBe(true)
    expect(existsSync(join(cacheB, codexCacheFileName()))).toBe(false)
    const diskA = JSON.parse(await readFile(join(cacheA, codexCacheFileName()), 'utf8'))
    expect(diskA.files[sourcePath].calls).toHaveLength(1)
    clearSessionCache()
  })

  it('loads Antigravity cache entries from the active directory after A to B', async () => {
    const sourcePath = join(root, 'shared.pb')
    const cacheA = join(root, 'agy-cache-a')
    const cacheB = join(root, 'agy-cache-b')
    await writeFile(sourcePath, 'fixture')
    await seedAntigravityCache(cacheA, sourcePath, 'from-a')
    await seedAntigravityCache(cacheB, sourcePath, 'from-b')

    process.env['CODEBURN_CACHE_DIR'] = cacheA
    expect(await readAntigravityModel(sourcePath)).toBe('from-a')

    process.env['CODEBURN_CACHE_DIR'] = cacheB
    expect(await readAntigravityModel(sourcePath)).toBe('from-b')
  })

  it('does not flush dirty Antigravity state from A into B', async () => {
    const sourcePath = join(root, 'shared.pb')
    const cacheA = join(root, 'agy-cache-a-dirty')
    const cacheB = join(root, 'agy-cache-b-dirty')
    await writeFile(sourcePath, 'fixture')
    await seedAntigravityCache(cacheA, sourcePath, 'from-a')
    await seedAntigravityCache(cacheB, sourcePath, 'from-b')

    process.env['CODEBURN_CACHE_DIR'] = cacheA
    expect(await readAntigravityModel(sourcePath)).toBe('from-a')

    // The provider parse transaction captures A. Even if the host changes its
    // call-time env before the deferred flush, eviction/publication stays on A.
    process.env['CODEBURN_CACHE_DIR'] = cacheB
    await flushAntigravityCache(new Set(), cacheA)

    expect(existsSync(join(cacheB, antigravityCacheFileName()))).toBe(true)
    const diskB = JSON.parse(await readFile(join(cacheB, antigravityCacheFileName()), 'utf8'))
    expect(diskB.cascades.shared.calls[0].model).toBe('from-b')
    const diskA = JSON.parse(await readFile(join(cacheA, antigravityCacheFileName()), 'utf8'))
    expect(diskA.cascades).toEqual({})
  })

  it('drops clean per-directory memos when the resident RSS guard clears them', async () => {
    const codexSource = join(root, 'guard.jsonl')
    const antigravitySource = join(root, 'shared.pb')
    const cacheDir = join(root, 'guard-cache')
    await writeFile(codexSource, '{}\n')
    await writeFile(antigravitySource, 'fixture')
    await seedAntigravityCache(cacheDir, antigravitySource, 'before')

    process.env['CODEBURN_CACHE_DIR'] = cacheDir
    await writeCachedCodexResults(codexSource, 'project', [call('codex', 'before')], (await fingerprintFile(codexSource))!)
    await flushCodexCache()
    expect(await readAntigravityModel(antigravitySource)).toBe('before')

    // Another process republishes both cache files. Without the clear, the
    // resident keeps serving its warm copies.
    await seedAntigravityCache(cacheDir, antigravitySource, 'after')
    const codexDisk = JSON.parse(await readFile(join(cacheDir, codexCacheFileName()), 'utf8'))
    codexDisk.files[codexSource].calls[0].model = 'after'
    await writeFile(join(cacheDir, codexCacheFileName()), JSON.stringify(codexDisk))

    expect((await readCachedCodexResults(codexSource))?.calls.map(entry => entry.model)).toEqual(['before'])
    expect(await readAntigravityModel(antigravitySource)).toBe('before')

    clearCodexMemCaches()
    clearAntigravityCacheStates()

    expect((await readCachedCodexResults(codexSource))?.calls.map(entry => entry.model)).toEqual(['after'])
    expect(await readAntigravityModel(antigravitySource)).toBe('after')
  })
})
