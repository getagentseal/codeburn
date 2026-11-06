import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const state = vi.hoisted(() => ({ busy: false }))

vi.mock('../src/providers/index.js', async () => {
  const actual = await vi.importActual<typeof import('../src/providers/index.js')>('../src/providers/index.js')
  const fake = {
    name: 'opencode',
    displayName: 'Fake',
    modelDisplayName: (m: string) => m,
    toolDisplayName: (t: string) => t,
    discoverSessions: async () => [],
    createSessionParser: () => ({
      async *parse() {
        if (state.busy) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
        yield {
          provider: 'opencode', model: 'claude-sonnet-4-5', inputTokens: 1_000_000, outputTokens: 0,
          cacheCreationInputTokens: 0, cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0,
          webSearchRequests: 0, costUSD: 3, tools: [], bashCommands: [], timestamp: new Date().toISOString(),
          speed: 'standard', deduplicationKey: 'k1', userMessage: 'hi', sessionId: 's1', project: 'p',
        }
      },
    }),
  }
  return { ...actual, getProvider: async (n: string) => n === 'opencode' ? fake : actual.getProvider(n) }
})

describe('SQLITE_BUSY deferral', () => {
  it('keeps serving the previous rows when a changed source is busy', async () => {
    process.env['CODEBURN_CACHE_DIR'] = mkdtempSync(join(tmpdir(), 'cb-busy-'))
    const { parseProviderSources } = await import('../src/parser.js')
    const { emptyCache } = await import('../src/session-cache.js')
    const dir = mkdtempSync(join(tmpdir(), 'cb-busy-src-'))
    const db = join(dir, 'db.sqlite')
    const path = `${db}:s1`
    writeFileSync(db, 'x')
    const cache = emptyCache()
    const sources = [{ provider: 'opencode', path, project: 'p' }]

    const first = await parseProviderSources('opencode', sources, new Set(), cache)
    const cost1 = first.reduce((s, p) => s + p.totalCostUSD, 0)
    const entry1 = cache.providers['opencode']!.files[path]
    expect(cost1).toBe(3)

    appendFileSync(db, 'yy')
    state.busy = true
    const second = await parseProviderSources('opencode', sources, new Set(), cache)
    expect(second.reduce((s, p) => s + p.totalCostUSD, 0)).toBe(cost1)
    expect(cache.providers['opencode']!.files[path]).toBe(entry1)
  })
})
