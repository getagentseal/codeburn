import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  CACHE_VERSION,
  clearLoadCacheMemo,
  computeCacheSemanticsToken,
  computeEnvFingerprint,
  loadCache,
  markCacheDirty,
  saveCache,
  sessionCacheDir,
  type CachedFile,
  type SessionCache,
} from '../src/session-cache.js'

let TMP_DIR: string
let SRC_DIR: string

beforeEach(async () => {
  TMP_DIR = join(tmpdir(), `codeburn-semantics-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  SRC_DIR = join(tmpdir(), `codeburn-semantics-src-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  process.env['CODEBURN_CACHE_DIR'] = TMP_DIR
  await mkdir(TMP_DIR, { recursive: true })
  await mkdir(SRC_DIR, { recursive: true })
  clearLoadCacheMemo()
})

afterEach(async () => {
  if (TMP_DIR && existsSync(TMP_DIR)) await rm(TMP_DIR, { recursive: true })
  if (SRC_DIR && existsSync(SRC_DIR)) await rm(SRC_DIR, { recursive: true })
})

function cachedFile(overrides: Partial<CachedFile> = {}): CachedFile {
  const timestamp = new Date().toISOString()
  return {
    fingerprint: { dev: 1, ino: 2, mtimeMs: 3, sizeBytes: 4 },
    lastCompleteLineOffset: 128,
    mcpInventory: ['mcp__github__list'],
    turns: [{
      timestamp,
      sessionId: 'sess-1',
      userMessage: 'do the thing',
      calls: [{
        provider: 'claude',
        model: 'claude-sonnet-4-20250514',
        usage: {
          inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0,
          webSearchRequests: 0, cacheCreationOneHourTokens: 0,
        },
        costUSD: 0.01,
        speed: 'standard',
        timestamp,
        tools: ['Read'], bashCommands: [], skills: [], subagentTypes: [],
        deduplicationKey: 'msg-1',
      }],
    }],
    ...overrides,
  }
}

async function envelope(): Promise<any> {
  return JSON.parse(await readFile(join(sessionCacheDir(), 'envelope.json'), 'utf-8'))
}

async function sourceFile(name: string): Promise<string> {
  const path = join(SRC_DIR, name)
  await writeFile(path, 'a\n'.repeat(128), 'utf-8')
  return path
}

async function seedCache(provider: string, filePath: string): Promise<CachedFile> {
  const st = await stat(filePath)
  const file = cachedFile({
    fingerprint: { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, sizeBytes: st.size },
  })

  const cache: any = await loadCache()
  cache.providers ??= {}
  cache.providers[provider] ??= {}
  cache.providers[provider].envFingerprint = computeEnvFingerprint(provider)
  cache.providers[provider].files = { [filePath]: file }

  markCacheDirty(cache, provider)
  await saveCache(cache)

  return file
}

describe('same-token adoption', () => {
  it('keeps cached entries when the stamped token matches', async () => {
    const filePath = await sourceFile('same-token.log')
    const file = await seedCache('claude', filePath)

    clearLoadCacheMemo()
    const loaded: any = await loadCache()

    expect(loaded.providers.claude.files[filePath]).toEqual(file)
    expect((await envelope()).semanticsToken).toBe(computeCacheSemanticsToken())
  })
})

describe('missing-token adoption', () => {
  it('loads old envelopes unchanged and stamps the token on next save', async () => {
    const filePath = await sourceFile('missing-token.log')
    const file = await seedCache('claude', filePath)

    const envelopePath = join(sessionCacheDir(), 'envelope.json')
    const raw = JSON.parse(await readFile(envelopePath, 'utf-8'))
    expect(raw.semanticsToken).toBe(computeCacheSemanticsToken())

    delete raw.semanticsToken
    await writeFile(envelopePath, JSON.stringify(raw), 'utf-8')

    clearLoadCacheMemo()
    const loaded: any = await loadCache()

    expect(loaded.providers.claude.files[filePath]).toEqual(file)

    markCacheDirty(loaded, 'claude')
    await saveCache(loaded)

    expect((await envelope()).semanticsToken).toBe(computeCacheSemanticsToken())
  })
})

describe('Mismatched-token re-parse (revert-proof)', () => {
  it('drops non-durable entries, forces durable re-read for existing sources, and preserves missing sources', async () => {
    const existingPath = join(TMP_DIR, 'existing.jsonl')
    const missingPath = join(TMP_DIR, 'missing', 'gone.jsonl')
    const nondurablePath = join(TMP_DIR, 'non-durable.jsonl')
    await writeFile(existingPath, '{"line":1}\n')
    await writeFile(nondurablePath, '{"line":1}\n')

    const nondurable = 'claude'
    const durable = 'copilot'
    const existingOriginal = cachedFile({ lastCompleteLineOffset: 64 })
    const missingOriginal = cachedFile({ prLinks: ['https://github.com/o/r/pull/9'] })

    const cache: SessionCache = {
      version: CACHE_VERSION,
      providers: {
        [nondurable]: {
          durable: false,
          envFingerprint: computeEnvFingerprint(nondurable),
          files: { [nondurablePath]: cachedFile() },
        },
        [durable]: {
          durable: true,
          envFingerprint: computeEnvFingerprint(durable),
          files: {
            [existingPath]: existingOriginal,
            [missingPath]: missingOriginal,
          },
        },
      },
    }

    markCacheDirty(cache, nondurable)
    markCacheDirty(cache, durable)
    await saveCache(cache)

    const doctored = await envelope()
    doctored.semanticsToken = 'foreign-build-xyz'
    await writeFile(join(sessionCacheDir(), 'envelope.json'), JSON.stringify(doctored), 'utf-8')

    clearLoadCacheMemo()
    const reloaded = await loadCache()

    expect(Object.keys(reloaded.providers[nondurable]?.files ?? {})).toHaveLength(0)

    expect(reloaded.providers[durable]?.files[existingPath]).toBeDefined()
    expect(reloaded.providers[durable]?.files[existingPath]?.fingerprint).toEqual({
      dev: 0,
      ino: 0,
      mtimeMs: 0,
      sizeBytes: -1,
    })
    expect(reloaded.providers[durable]?.files[existingPath]).not.toHaveProperty('lastCompleteLineOffset')
    expect(reloaded.providers[durable]?.files[existingPath]).not.toHaveProperty('failed')

    expect(reloaded.providers[durable]?.files[missingPath]).toEqual(missingOriginal)

    markCacheDirty(reloaded, nondurable)
    markCacheDirty(reloaded, durable)
    await saveCache(reloaded)
    expect((await envelope()).semanticsToken).toBe(computeCacheSemanticsToken())

    clearLoadCacheMemo()
    const final = await loadCache()
    expect(final.providers[durable]?.files[existingPath]).toBeDefined()
    expect(final.providers[durable]?.files[missingPath]).toBeDefined()
    expect(Object.keys(final.providers[nondurable]?.files ?? {})).toHaveLength(0)
  })
})

describe('Two-writer alternation, no silent mixing', () => {
  it('discards mismatched non-durable shard data and re-stamps the local semantics token', async () => {
    const provider = 'claude'
    const filePath = join(TMP_DIR, 'writer-a.jsonl')
    await writeFile(filePath, '{"line":1}\n')

    const cache: SessionCache = {
      version: CACHE_VERSION,
      providers: {
        [provider]: {
          durable: false,
          envFingerprint: computeEnvFingerprint(provider),
          files: { [filePath]: cachedFile() },
        },
      },
    }

    markCacheDirty(cache, provider)
    await saveCache(cache)

    const env = await envelope()
    const shardName = Object.values((env.providers[provider].shards ?? {}) as Record<string, { name: string; until: string }>)[0]?.name
    expect(shardName).toBeTruthy()
    const shardPath = join(sessionCacheDir(), shardName as string)
    const shard = JSON.parse(await readFile(shardPath, 'utf-8'))

    const doctorCosts = (value: any): void => {
      if (Array.isArray(value)) {
        for (const item of value) doctorCosts(item)
        return
      }
      if (value && typeof value === 'object') {
        if (typeof value.costUSD === 'number') value.costUSD = 999
        for (const key of Object.keys(value)) doctorCosts(value[key])
      }
    }

    doctorCosts(shard)
    expect(JSON.stringify(shard)).toContain('"costUSD":999')
    await writeFile(shardPath, JSON.stringify(shard), 'utf-8')

    env.semanticsToken = 'build-b-token-y'
    await writeFile(join(sessionCacheDir(), 'envelope.json'), JSON.stringify(env), 'utf-8')

    clearLoadCacheMemo()
    const loaded = await loadCache()

    expect(Object.keys(loaded.providers[provider]?.files ?? {})).toHaveLength(0)
    expect(JSON.stringify(loaded)).not.toContain('"costUSD":999')

    markCacheDirty(loaded, provider)
    await saveCache(loaded)

    clearLoadCacheMemo()
    const final = await loadCache()
    expect(Object.keys(final.providers[provider]?.files ?? {})).toHaveLength(0)
    expect(JSON.stringify(final)).not.toContain('"costUSD":999')
    expect((await envelope()).semanticsToken).toBe(computeCacheSemanticsToken())
  })
})
