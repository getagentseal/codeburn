// Completeness is recorded for what a run actually WALKED (#912). A scan is
// scoped on two axes — `--provider X` and a date range — and a stamp that
// ignores either writes a "done" the cache cannot back up.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import type { Provider } from '../src/providers/types.js'

const injected = vi.hoisted(() => ({ throwingProvider: false, coldHydrations: 0 }))

// The throwing provider goes through the REAL discovery-isolation path (which
// swallows the throw into an empty list), so what is under test is the stamp's
// reaction to a provider that reported nothing because it failed.
vi.mock('../src/providers/index.js', async () => {
  const actual = await vi.importActual<typeof import('../src/providers/index.js')>('../src/providers/index.js')
  const boom = {
    name: 'boom-provider',
    displayName: 'Boom',
    modelDisplayName: (m: string) => m,
    toolDisplayName: (t: string) => t,
    discoverSessions: async () => { throw new Error('discovery exploded') },
  } as unknown as Provider
  return {
    ...actual,
    discoverAllSessionsWithFailures: async (filter?: string, list?: Provider[]) => actual.discoverAllSessionsWithFailures(
      filter,
      list ?? (injected.throwingProvider ? [...await actual.getAllProviders(), boom] : undefined),
    ),
  }
})

vi.mock('../src/session-cache.js', async () => {
  const actual = await vi.importActual<typeof import('../src/session-cache.js')>('../src/session-cache.js')
  return {
    ...actual,
    beginColdHydration: async (...args: Parameters<typeof actual.beginColdHydration>) => {
      injected.coldHydrations++
      return actual.beginColdHydration(...args)
    },
  }
})

import { parseAllSessions, clearSessionCache } from '../src/parser.js'
import { isCacheComplete, type SessionCache } from '../src/session-cache.js'
import { readCacheOnDisk, writeCacheOnDisk } from './fixtures/session-cache-io.js'
import { setHome } from './setup/home.js'

let tmpDir: string

beforeEach(async () => {
  clearSessionCache()
  injected.throwingProvider = false
  injected.coldHydrations = 0
  tmpDir = await mkdtemp(join(tmpdir(), 'scoped-complete-'))
  // Gemini discovers under the home directory, so the two-provider fixtures
  // below need home pointed at the temp root as well as CLAUDE_CONFIG_DIR.
  setHome(tmpDir)
  process.env['CLAUDE_CONFIG_DIR'] = join(tmpDir, 'claude')
  process.env['CODEBURN_CACHE_DIR'] = join(tmpDir, 'cache')
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(tmpDir, 'desktop-sessions')
})

afterEach(async () => {
  clearSessionCache()
  await rm(tmpDir, { recursive: true, force: true })
})

async function writeClaudeSession(): Promise<string> {
  const dir = join(tmpDir, 'claude', 'projects', 'proj')
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'sess.jsonl')
  await writeFile(path, JSON.stringify({
    type: 'assistant',
    sessionId: 'sess',
    timestamp: '2026-05-15T10:00:00Z',
    cwd: '/tmp/proj',
    message: {
      id: 'msg-1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
      content: [], usage: { input_tokens: 100, output_tokens: 50 },
    },
  }) + '\n')
  return path
}

async function writeGeminiSession(): Promise<string> {
  const dir = join(tmpDir, '.gemini', 'tmp', 'proj', 'chats')
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'session-2026-05-15.json')
  await writeFile(path, JSON.stringify({
    sessionId: 'gem-1',
    startTime: '2026-05-15T10:00:00.000Z',
    messages: [
      { id: 'u1', timestamp: '2026-05-15T10:00:00.000Z', type: 'user', content: 'work' },
      {
        id: 'g1', timestamp: '2026-05-15T10:00:05.000Z', type: 'gemini', content: 'done',
        model: 'gemini-3.1-pro-preview', tokens: { input: 10, output: 5 },
      },
    ],
  }))
  return path
}

function cachedFileCount(cache: SessionCache, provider: string): number {
  return Object.keys(cache.providers[provider]?.files ?? {}).length
}

describe('provider-scoped runs and the completeness marker', () => {
  it('marks only the provider it walked, leaving the rest of the cache cold', async () => {
    await writeClaudeSession()
    await writeGeminiSession()

    await parseAllSessions(undefined, 'gemini')
    const raw = await readCacheOnDisk()

    // Premise: claude really was left unscanned. If this fails the scoped run
    // read it anyway and the rest proves nothing.
    expect(cachedFileCount(raw, 'claude')).toBe(0)
    expect(cachedFileCount(raw, 'gemini')).toBeGreaterThan(0)

    // The provider it walked is warm; the one it never looked at is not, and
    // neither is the whole-cache answer an unscoped request asks for.
    expect(isCacheComplete(raw, 'gemini')).toBe(true)
    expect(isCacheComplete(raw, 'claude')).toBe(false)
    expect(isCacheComplete(raw)).toBe(false)
  })

  it('converges over repeated scoped runs instead of staying permanently cold', async () => {
    await writeClaudeSession()
    await writeGeminiSession()

    for (let i = 0; i < 3; i++) {
      clearSessionCache()
      await parseAllSessions(undefined, 'gemini')
    }

    // Only the first run found the gemini section cold. A scoped run that can
    // never stamp anything re-enters cold hydration every time — which is what
    // an extra unfiltered discovery in the stamp path cost scoped users.
    expect(injected.coldHydrations).toBe(1)
    expect(isCacheComplete(await readCacheOnDisk(), 'gemini')).toBe(true)
  })

  it('repairs the whole-cache answer on the next unscoped run', async () => {
    await writeClaudeSession()
    await writeGeminiSession()

    await parseAllSessions(undefined, 'gemini')
    clearSessionCache()
    await parseAllSessions()

    const raw = await readCacheOnDisk()
    expect(cachedFileCount(raw, 'claude')).toBeGreaterThan(0)
    expect(isCacheComplete(raw)).toBe(true)
  })

  it('does not claim all of history when the date range filtered older sources out', async () => {
    const path = await writeGeminiSession()
    const old = new Date('2024-01-01T00:00:00Z')
    await utimes(path, old, old)

    const start = new Date('2026-05-01T00:00:00Z')
    await parseAllSessions({ start, end: new Date('2026-05-31T23:59:59Z') }, 'gemini')

    const raw = await readCacheOnDisk()
    // The file's mtime predates the range, so the run never parsed it.
    expect(cachedFileCount(raw, 'gemini')).toBe(0)
    // Complete for a query inside the scanned window, cold for anything wider.
    expect(isCacheComplete(raw, 'gemini', start.getTime())).toBe(true)
    expect(isCacheComplete(raw, 'gemini', new Date('2023-01-01T00:00:00Z').getTime())).toBe(false)
    expect(isCacheComplete(raw, 'gemini')).toBe(false)
    expect(isCacheComplete(raw)).toBe(false)
  })

  it('does not mark a provider whose discovery threw', async () => {
    await writeClaudeSession()
    injected.throwingProvider = true
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      await parseAllSessions()
    } finally {
      warn.mockRestore()
    }

    const raw = await readCacheOnDisk()
    expect(isCacheComplete(raw, 'claude')).toBe(true)
    // An empty source list from a provider that threw means "unknown", not
    // "nothing to scan", so neither it nor the whole cache is complete.
    expect(isCacheComplete(raw, 'boom-provider')).toBe(false)
    expect(isCacheComplete(raw)).toBe(false)
  })
})

describe('caches written before per-provider completeness', () => {
  // The whole-cache flag was the only marker. It still answers for every
  // provider, in both states, so an existing cache neither re-hydrates for no
  // reason nor reads as warm when it is not.
  async function writeLegacyCache(complete: boolean): Promise<SessionCache> {
    await parseAllSessions(undefined, 'claude')
    const cache = await readCacheOnDisk()
    for (const section of Object.values(cache.providers)) {
      delete section.complete
      delete section.completeFrom
    }
    cache.complete = complete
    await writeCacheOnDisk(cache)
    clearSessionCache()
    return readCacheOnDisk()
  }

  it('reads a stamped legacy cache as complete for every provider', async () => {
    await writeClaudeSession()
    const cache = await writeLegacyCache(true)

    expect(cache.providers['claude']?.complete).toBeUndefined()
    expect(isCacheComplete(cache)).toBe(true)
    expect(isCacheComplete(cache, 'claude')).toBe(true)
    expect(isCacheComplete(cache, 'gemini')).toBe(true)

    injected.coldHydrations = 0
    await parseAllSessions(undefined, 'claude')
    expect(injected.coldHydrations).toBe(0)
  })

  it('reads an unstamped legacy cache as complete for none of them', async () => {
    await writeClaudeSession()
    const cache = await writeLegacyCache(false)

    expect(isCacheComplete(cache)).toBe(false)
    expect(isCacheComplete(cache, 'claude')).toBe(false)

    injected.coldHydrations = 0
    await parseAllSessions(undefined, 'claude')
    expect(injected.coldHydrations).toBe(1)
  })
})
